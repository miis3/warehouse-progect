import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {database,api,staff,worker,manifest} from './database-helpers.mjs';

// Disposable PostgreSQL only. Never runs against Supabase or the user's preview.
test('workflow upgrade: automatic custody, box snapshots, overdue decisions, maintenance and backend authorization',async t=>{
 const db=await database();t.after(()=>db.close());
 const manager=await staff(db,'manager'),keeper=await staff(db),w=await worker(db,'عامل تحقق معزول','ISOLATED-1'),other=await worker(db,'عامل تحقق آخر','ISOLATED-2');
 const call=(actor,action,payload={})=>api(db,actor.token,action,payload);
 const box=await call(keeper,'save_box',{label:'صندوق تحقق معزول',location_id:manifest.locations[0].id,position:99});
 const item=await call(keeper,'save_item',{box_id:box.id,name:'قطعتان للتحقق المعزول',quantity:2,condition:'sound',notes:'قاعدة اختبار مؤقتة فقط'});
 const stock=async()=> (await call(keeper,'catalog')).items.find(i=>i.id===item.id).units;
 const request=(actor,payload)=>call(actor,'request',{...payload,client_key:randomUUID()});
 const approve=(r,payload={})=>call(keeper,'review_request',{id:r.id,decision:'approve',...payload});
 let checkout;
 await t.test('new item starts ready; no periodic review and no default overdue threshold',async()=>{
  assert.equal(item.inventory_reviewed,true);assert.equal((await stock()).filter(u=>u.status==='available').length,2);
  assert.equal((await call(manager,'settings')).overdue_days,null);
  await assert.rejects(call(keeper,'save_item',{box_id:box.id,name:'Missing quantity'}));
  assert.equal((await call(keeper,'catalog')).items.filter(i=>i.box_id===box.id).length,1,'failed creation rolls back atomically');
  for(const action of ['save_item','set_condition','save_settings','dashboard','maintenance','retire_unit'])await assert.rejects(call(w,action,{}));
  await assert.rejects(call(keeper,'save_settings',{overdue_days:1}));
  await call(manager,'save_settings',{overdue_days:1});
 });
 await t.test('one approval issues every box member and prevents double issue',async()=>{
  checkout=await request(w,{kind:'checkout',box_id:box.id});
  assert.equal((await call(w,'custody')).length,0);assert.equal((await call(manager,'dashboard')).pending_count,1);
  await approve(checkout);await assert.rejects(approve(checkout),/معالجة/);
  const groups=await call(w,'custody');assert.equal(groups.length,1);assert.equal(groups[0].loans.length,2);assert.equal(groups[0].original_contents.length,2);
  assert.equal((await stock()).filter(u=>u.status==='available').length,0);
  await assert.rejects(request(other,{kind:'checkout',box_id:box.id}));
  assert.equal((await call(other,'custody')).length,0);
 });
 await t.test('box return follows original loan contents, not subsequently added stock; bad returns open linked tickets',async()=>{
  await call(keeper,'add_units',{item_id:item.id,quantity:1,condition:'sound',notes:'إضافة لاحقة في الاختبار'});
  await assert.rejects(request(other,{kind:'return',checkout_request_id:checkout.id}),/بعهدتك/);
  const ret=await request(w,{kind:'return',checkout_request_id:checkout.id});assert.equal(ret.unit_ids.length,2);
  assert.equal((await call(w,'custody'))[0].loans.length,2);
  await approve(ret,{return_condition:'broken',notes:'عطل عند الإرجاع في الاختبار'});
  assert.equal((await call(w,'custody')).length,0);
  const history=await call(w,'custody',{history:true});assert.equal(history[0].original_contents.length,2);assert.equal(history[0].loans.length,2);
  const tickets=await call(keeper,'maintenance');assert.equal(tickets.length,2);
  for(const m of tickets){assert.equal(m.worker_id,w.user.id);assert.equal(m.opened_by,keeper.user.id);assert.ok(m.loan_id);assert.equal(m.request_id,ret.id);assert.equal(m.unit.status,'broken');}
  assert.equal((await stock()).filter(u=>u.status==='available').length,1);
  await assert.rejects(approve(ret,{return_condition:'sound'}));
  await assert.rejects(db.query('delete from warehouse.maintenance_tickets where id=$1',[tickets[0].id]));
  await call(keeper,'close_maintenance',{id:tickets[0].id,notes:'إصلاح معزول'});
  assert.equal((await call(keeper,'maintenance')).length,1);
  await assert.rejects(call(keeper,'close_maintenance',{id:tickets[0].id,notes:'مكرر'}));
  await call(keeper,'set_condition',{unit_id:tickets[1].unit_id,condition:'sound',notes:'اكتمل الإصلاح'});
  assert.equal((await call(keeper,'maintenance')).length,0);assert.equal((await stock()).filter(u=>u.status==='available').length,3);
 });
 await t.test('maintenance blocks an already pending approval; restoring sound condition restores availability',async()=>{
  const u=(await stock())[0],r=await request(w,{kind:'checkout',unit_ids:[u.unit_id]});
  await call(keeper,'set_condition',{unit_id:u.unit_id,condition:'maintenance',notes:'صيانة وقائية فعلية'});
  await assert.rejects(approve(r),/لم تعد متاحة/);
  await call(keeper,'set_condition',{unit_id:u.unit_id,condition:'sound',notes:'انتهت الصيانة'});await approve(r);
  const ret=await request(w,{kind:'return',unit_ids:[u.unit_id]});await approve(ret,{return_condition:'sound'});
  assert.equal((await call(w,'custody')).length,0);assert.equal((await stock()).find(x=>x.unit_id===u.unit_id).status,'available');
 });
 await t.test('overdue remains open, allows new request and requires informed staff acknowledgement',async()=>{
  const [u1,u2]=await stock();
  // Build a historical fixture at INSERT time; never bypass immutable-loan triggers.
  const r=await request(w,{kind:'checkout',unit_ids:[u1.unit_id]});
  await db.query("insert into warehouse.loans(unit_id,worker_id,checkout_request_id,checkout_keeper_id,checkout_keeper_name,outbound_condition,location_snapshot,worker_name,employee_id,checked_out_at) values($1,$2,$3,$4,'اختبار','sound',warehouse.unit_snapshot($1),'عامل تحقق معزول','ISOLATED-1',now()-interval '3 days')",[u1.unit_id,w.user.id,r.id,keeper.user.id]);
  await call(keeper,'review_request',{id:r.id,decision:'reject',notes:'طلب حامل للبيانات التاريخية المعزولة فقط'});
  assert.equal((await call(manager,'overdue'))[0].worker_id,w.user.id);
  assert.equal((await call(manager,'dashboard')).overdue_count,1);
  assert.equal((await call(w,'custody'))[0].overdue,true);
  const next=await request(w,{kind:'checkout',unit_ids:[u2.unit_id]});
  assert.equal(next.status,'pending');assert.ok((await call(keeper,'requests',{status:'pending'})).find(x=>x.id===next.id).overdue_loans.length);
  await assert.rejects(approve(next),/عهدة متأخرة/);await approve(next,{acknowledge_overdue:true});
  assert.equal((await call(w,'custody')).length,2);
  await call(manager,'save_settings',{overdue_days:10});assert.equal((await call(manager,'overdue')).length,0);
  assert.equal((await call(w,'custody')).length,2,'settings must not close loans');
 });
 await t.test('audit search and immutable linked events; retired stock cannot be issued',async()=>{
  const events=await call(manager,'audit',{limit:100});
  for(const operation of ['equipment_added','request_created','request_approved','request_rejected','equipment_checked_out','equipment_returned','box_checked_out','box_returned','maintenance_ticket_opened','maintenance_ticket_closed','settings_changed'])assert.ok(events.some(e=>e.operation===operation),operation);
  assert.ok((await call(manager,'audit',{operation:'maintenance_ticket_opened',query:'عطل'})).length);
  assert.ok((await call(other,'audit')).every(e=>e.worker_id===other.user.id));
  const free=(await stock()).find(u=>u.status==='available');await call(keeper,'retire_unit',{unit_id:free.unit_id,notes:'استبعاد مصرح في الاختبار'});
  await assert.rejects(request(w,{kind:'checkout',unit_ids:[free.unit_id]}),/مستبعدة/);
  assert.equal((await stock()).find(u=>u.unit_id===free.unit_id).status,'retired');
  await assert.rejects(db.exec('truncate warehouse.audit_events'));
 });
});
