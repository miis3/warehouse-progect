import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {database,api,worker,staff,manifest,hash} from './database-helpers.mjs';
import {inventorySql} from '../scripts/inventory-seed.mjs';

test('PostgreSQL: real inventory, authorization, issue/return, immutable history and atomic conflicts', async t=>{
 const db=await database();t.after(()=>db.close());
 const k=await staff(db), k2=await staff(db), manager=await staff(db,'manager');
 const a=await worker(db,'عامل أول','TEST-01'),b=await worker(db,'عامل ثان','TEST-02');
 const call=(who,act,data)=>api(db,who.token,act,data);
 let unit,item,request,returnedLoan;
 await t.test('additive source import is complete, idempotent and creates no guessed stock',async()=>{
   await db.exec(inventorySql(manifest));
   const catalog=await call(a,'catalog');
   assert.equal(catalog.locations.length,192);assert.equal(catalog.boxes.length,32);assert.equal(catalog.items.length,258);
   assert.equal(catalog.items.flatMap(i=>i.units).length,0);
   assert.equal(catalog.items.filter(i=>i.name.trim()).length,257);
   assert.ok(!JSON.stringify(catalog).includes('TEST-01'));
 });
 await t.test('public and authenticated database roles cannot bypass the API',async()=>{
   for(const role of ['anon','authenticated','service_role']){
     await db.exec(`set role ${role}`);
     await assert.rejects(db.query('select * from warehouse.workers'),/permission denied/);
     if(role!=='service_role') await assert.rejects(db.query('select public.warehouse_public_catalog()'),/permission denied/);
     await db.exec('reset role');
   }
   const tables=await db.query("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='warehouse' and relkind='r'");
   assert.ok(tables.rows.every(t=>t.relrowsecurity));
 });
 await t.test('identity match, role checks, session validation and rate limiting',async()=>{
   await assert.rejects(worker(db,'اسم آخر','TEST-01'),/بيانات الدخول/);
   await assert.rejects(api(db,'forged','catalog'),/انتهت الجلسة/);
   await assert.rejects(call(a,'save_box',{label:'محاولة'}),/للإدارة/);
   await assert.rejects(call(k,'workers'),/للمدير/);
   assert.equal((await call(manager,'workers')).length,2);
   for(let i=0;i<4;i++) assert.equal((await db.query('select public.warehouse_rate_limit($1,3,60) as ok',['test-rate'])).rows[0].ok,i<3);
 });
 await t.test('review is mandatory; groups cannot be double counted; source quantity is preserved',async()=>{
   const group=manifest.items.find(i=>i.is_group);
   await assert.rejects(call(k,'review_item',{item_id:group.id,quantity:1,condition:'sound'}),/مستقلاً/);
   item=manifest.items.find(i=>!i.is_group&&i.name.includes('ICS water pump'));
   await call(k,'review_item',{item_id:item.id,quantity:2,condition:'sound',notes:'اختبار على قاعدة مؤقتة'});
   await assert.rejects(call(k,'review_item',{item_id:item.id,quantity:3,condition:'sound'}),/تم اعتماد/);
   const current=(await call(a,'catalog')).items.find(i=>i.id===item.id);
   assert.equal(current.source_quantity,'3');assert.equal(current.units.length,2);unit=current.units[0];
 });
 await t.test('pending request does not issue equipment, retry is idempotent and duplicates blocked',async()=>{
   const payload={kind:'checkout',unit_ids:[unit.unit_id],client_key:randomUUID()};
   request=await call(a,'request',payload);
   assert.equal(request.status,'pending');assert.equal((await call(a,'loans')).length,0);
   assert.equal((await call(a,'request',payload)).id,request.id);
   await assert.rejects(call(a,'request',{...payload,client_key:randomUUID()}),/طلب معلق/);
   assert.equal((await call(b,'requests',{worker_id:a.user.id})).length,0);
   await assert.rejects(call(b,'cancel_request',{id:request.id}),/غير مسموح/);
 });
 await t.test('approval validates every condition and simultaneous approvals cannot duplicate custody',async()=>{
   const approve={id:request.id,decision:'approve',inspections:[{unit_id:unit.unit_id,condition:'usable_note',notes:'خدش خارجي عند الخروج'}]};
   await assert.rejects(call(a,'review_request',approve),/للإدارة/);
   await assert.rejects(call(k,'review_request',{...approve,inspections:[]}),/كل معدة/);
   const outcomes=await Promise.allSettled([call(k,'review_request',approve),call(k2,'review_request',approve)]);
   assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
   assert.equal((await call(a,'loans')).length,1);assert.equal((await call(b,'loans')).length,0);
   const loans=(await db.query('select count(*)::int as n from warehouse.loans where returned_at is null')).rows[0].n;
   assert.equal(loans,1);
 });
 await t.test('only owner can request return; custody remains until keeper confirms',async()=>{
   await assert.rejects(call(b,'request',{kind:'return',unit_ids:[unit.unit_id],client_key:randomUUID()}),/بعهدتك فقط/);
   await assert.rejects(call(b,'request',{kind:'checkout',unit_ids:[unit.unit_id],client_key:randomUUID()}),/غير متاحة/);
   request=await call(a,'request',{kind:'return',unit_ids:[unit.unit_id],client_key:randomUUID()});
   assert.equal((await call(a,'loans')).length,1);
   await call(k,'review_request',{id:request.id,decision:'approve',inspections:[{unit_id:unit.unit_id,condition:'needs_maintenance',notes:'عطل بعد الاستخدام'}]});
   assert.equal((await call(a,'loans')).length,0);
   returnedLoan=(await call(a,'loans',{history:true}))[0];
   assert.equal(returnedLoan.outbound_condition,'usable_note');assert.equal(returnedLoan.return_condition,'needs_maintenance');
   assert.equal(returnedLoan.outbound_notes,'خدش خارجي عند الخروج');assert.equal(returnedLoan.return_notes,'عطل بعد الاستخدام');
   assert.equal((await call(b,'loans',{history:true,worker_id:a.user.id})).length,0);
 });
 await t.test('maintenance visible but unissuable; departure, repair and return are logged',async()=>{
   const catalog=await call(b,'catalog');const bad=catalog.items.find(i=>i.id===item.id).units.find(u=>u.unit_id===unit.unit_id);
   assert.equal(bad.status,'maintenance');assert.ok(!JSON.stringify(catalog).includes('TEST-01'));
   await assert.rejects(call(b,'request',{kind:'checkout',unit_ids:[unit.unit_id],client_key:randomUUID()}),/غير متاحة/);
   await call(k,'set_condition',{unit_id:unit.unit_id,condition:'maintenance',notes:'إرسال للورشة'});
   await call(k,'set_condition',{unit_id:unit.unit_id,condition:'sound',notes:'اختبار بعد الإصلاح'});
   const audit=await call(k,'audit',{item_id:item.id});
   assert.ok(audit.some(e=>e.operation==='maintenance_started'));assert.ok(audit.some(e=>e.operation==='maintenance_finished'));
   assert.ok((await call(a,'audit')).every(e=>e.worker_id===a.user.id));
 });
 await t.test('history and audit reject rewrite or deletion, including direct SQL',async()=>{
   await assert.rejects(db.query("update warehouse.loans set outbound_notes='changed' where id=$1",[returnedLoan.id]),/تاريخ العهدة/);
   await assert.rejects(db.exec("update warehouse.audit_events set notes='changed'"),/السجل ثابت/);
   await assert.rejects(db.exec('delete from warehouse.audit_events'),/السجل ثابت/);
   await assert.rejects(db.exec('truncate warehouse.audit_events'),/السجل ثابت/);
   assert.equal((await call(a,'loans',{history:true}))[0].outbound_notes,'خدش خارجي عند الخروج');
 });
 await t.test('whole-box requests preserve distinct boxes and reject any unavailable member atomically',async()=>{
   const cat=await call(a,'catalog'),units=cat.items.find(i=>i.id===item.id).units;
   const req=await call(a,'request',{kind:'checkout',box_id:item.box_id,client_key:randomUUID()});
   assert.equal(req.unit_ids.length,2);
   await call(k,'set_condition',{unit_id:units[1].unit_id,condition:'broken',notes:'خلل ظهر قبل الاعتماد'});
   await assert.rejects(call(k,'review_request',{id:req.id,decision:'approve',inspections:units.map(u=>({unit_id:u.unit_id,condition:'sound',notes:''}))}),/لم تعد متاحة/);
   assert.equal((await call(a,'loans')).length,0);assert.equal((await call(a,'requests',{status:'pending'}))[0].status,'pending');
   await call(k,'review_request',{id:req.id,decision:'reject',notes:'عطل في أحد المحتويات'});
   await assert.rejects(call(a,'request',{kind:'checkout',box_id:manifest.boxes.find(b=>b.contents_missing).id,client_key:randomUUID()}),/مراجعة جميع/);
 });
 await t.test('inventory updates retain IDs, persist after new sessions and write audit events',async()=>{
   const loc=manifest.locations.find(l=>l.row===5);
   const box=await call(k,'save_box',{label:'صندوق اختبار',location_id:loc.id,position:1});
   const added=await call(k,'save_item',{box_id:box.id,name:'معدة اختبار مؤقتة',notes:'بيئة الاختبار فقط'});
   await call(k,'save_item',{id:added.id,box_id:box.id,name:'اسم معدل',notes:'تعديل'});
   await call(k,'save_box',{id:box.id,label:'صندوق اختبار معدل',location_id:manifest.locations[0].id,position:1});
   assert.ok((await call(k,'audit',{item_id:added.id})).some(e=>e.operation==='equipment_updated'));
   const fresh=await worker(db,'عامل أول','TEST-01');
   assert.equal((await call(fresh,'loans',{history:true})).length,1);
   await call(a,'logout');await assert.rejects(call(a,'catalog'),/انتهت الجلسة/);
   await db.query("update warehouse.sessions set last_seen_at=now()-interval '16 minutes' where token_hash=$1",[hash(fresh.token)]);
   await assert.rejects(call(fresh,'catalog'),/انتهت الجلسة/);
 });
});
