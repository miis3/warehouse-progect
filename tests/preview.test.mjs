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
});
