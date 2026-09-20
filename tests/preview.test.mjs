import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestPreview} from '../scripts/test-preview.mjs';

test('isolated browser preview serves assets and completes checkout and return over HTTP',async t=>{
  const preview=await createTestPreview({port:0});
  t.after(()=>preview.close());

  const page=await fetch(preview.url+'/');
  assert.equal(page.status,200);
  assert.match(await page.text(),/المستودع التفاعلي/);
  const config=await (await fetch(preview.url+'/warehouse-config.js')).text();
  assert.match(config,/apiUrl: '\/api\/warehouse'/);
  assert.doesNotMatch(config,/service_role|sb_secret_|eyJ/i);

  const post=async(action,payload={},token='')=>{
    const response=await fetch(preview.url+'/api/warehouse',{
      method:'POST',headers:{'Content-Type':'application/json',Origin:preview.url,...(token?{'X-Warehouse-Session':token}:{})},
      body:JSON.stringify({action,payload})
    });
    return {status:response.status,body:await response.json()};
  };
  const admin=await post('admin_login',preview.credentials);
  assert.equal(admin.status,200);
  const worker=await post('worker_login',{name:'عامل تجربة محلية',employee_id:'70001'});
  assert.equal(worker.status,200);
  const adminToken=admin.body.data.token,workerToken=worker.body.data.token;

  const keeperPassword='Preview-keeper-test-123!';
  assert.equal((await post('create_staff',{
    name:'أمين تجربة محلية',username:'preview-keeper',password:keeperPassword,role:'keeper'
  },adminToken)).status,200);
  const keeper=await post('admin_login',{username:'preview-keeper',password:keeperPassword});
  assert.equal(keeper.status,200);
  assert.equal(keeper.body.data.user.role,'keeper');
  assert.equal((await post('staff_list',{},keeper.body.data.token)).status,403);
  assert.equal((await post('create_staff',{
    name:'مدير غير مصرح',username:'illegal-manager',password:keeperPassword,role:'manager'
  },keeper.body.data.token)).status,403);

  const catalog=await post('catalog',{},workerToken);
  const item=catalog.body.data.items.find(entry=>entry.id===preview.sample.id);
  assert.equal(item.units.length,1);
  const unit=item.units[0];

  const checkout=await post('request',{kind:'checkout',unit_ids:[unit.unit_id],client_key:randomUUID()},workerToken);
  assert.equal(checkout.status,200);
  let pending=await post('requests',{status:'pending'},adminToken);
  const checkoutRequest=pending.body.data.find(request=>request.kind==='checkout');
  assert.ok(checkoutRequest);
  assert.equal((await post('review_request',{id:checkoutRequest.id,decision:'approve',inspections:[{unit_id:unit.unit_id,condition:'sound',notes:''}]},adminToken)).status,200);

  const custody=await post('loans',{},workerToken);
  assert.equal(custody.body.data.length,1);
  assert.equal(custody.body.data[0].unit_id,unit.unit_id);
  const otherWorker=await post('worker_login',{name:'عامل تجربة ثان',employee_id:'70002'});
  assert.equal(otherWorker.status,200);
  const duplicate=await post('request',{
    kind:'checkout',unit_ids:[unit.unit_id],client_key:randomUUID()
  },otherWorker.body.data.token);
  assert.equal(duplicate.status,409);
  assert.equal((await preview.db.query(
    'select count(*)::int as total from warehouse.loans where unit_id=$1 and returned_at is null',
    [unit.unit_id]
  )).rows[0].total,1);

  assert.equal((await post('request',{kind:'return',unit_ids:[unit.unit_id],client_key:randomUUID()},workerToken)).status,200);
  pending=await post('requests',{status:'pending'},adminToken);
  const returnRequest=pending.body.data.find(request=>request.kind==='return');
  assert.ok(returnRequest);
  assert.equal((await post('review_request',{id:returnRequest.id,decision:'approve',inspections:[{unit_id:unit.unit_id,condition:'sound',notes:''}]},adminToken)).status,200);

  const active=await post('loans',{},workerToken);
  const history=await post('loans',{history:true},workerToken);
  assert.deepEqual(active.body.data,[]);
  assert.equal(history.body.data.length,1);
  assert.ok(history.body.data[0].returned_at);
  assert.equal((await preview.db.query(
    'select count(*)::int as total from warehouse.loans where unit_id=$1 and returned_at is null',
    [unit.unit_id]
  )).rows[0].total,0);
  assert.equal((await preview.db.query(
    'select count(*)::int as total from warehouse.audit_events where operation in ($1,$2)',
    ['equipment_checked_out','equipment_returned']
  )).rows[0].total,2);

  assert.equal((await post('change_password',{
    current_password:keeperPassword,new_password:'Preview-keeper-rotated-456!'
  },keeper.body.data.token)).status,200);
  assert.equal((await post('admin_login',{username:'preview-keeper',password:keeperPassword})).status,401);
  assert.equal((await post('admin_login',{
    username:'preview-keeper',password:'Preview-keeper-rotated-456!'
  })).status,200);
});
