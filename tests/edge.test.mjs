import test from 'node:test';
import assert from 'node:assert/strict';
import {createWarehouseHandler} from '../supabase/functions/warehouse-api/handler.mjs';
import {database,staff} from './database-helpers.mjs';
test('Edge boundary uses server sessions, validates requests, CORS, and separate staff authentication',async t=>{
 const db=await database();t.after(()=>db.close());
 const keeper=await staff(db);
 const rpc=async(name,args)=>{
   const entries=Object.entries(args);
   return (await db.query(`select public.${name}(${entries.map(([key],i)=>`${key} => $${i+1}`).join(',')}) as data`,entries.map(([,v])=>typeof v==='object'?JSON.stringify(v):v))).rows[0].data;
 };
 const handle=createWarehouseHandler({env:()=>undefined,rpc,authenticateAdmin:async(u,p)=>u==='keeper'&&p==='temporary-test-secret'?keeper.user.id:null});
 const post=async(action,payload={},token='',origin='https://miis3.github.io')=>{
   const r=await handle(new Request('https://test.invalid/functions/v1/warehouse-api',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Warehouse-Session':token},body:JSON.stringify({action,payload})}));
   return {status:r.status,body:await r.json()};
 };
 assert.equal((await post('catalog')).status,401);
 assert.equal((await post('worker_login',{name:'عامل التجربة',employee_id:'١٢٣٤٥'})).status,200);
 const login=await post('worker_login',{name:'عامل التجربة',employee_id:'12345'});const token=login.body.data.token;
 assert.match(token,/^[0-9a-f]{64}$/);assert.equal(login.body.data.user.employee_id,'12345');
 assert.equal((await post('catalog',{},token)).body.data.boxes.length,32);
 assert.equal((await post('review_item',{},token)).status,403);
 assert.equal((await post('admin_login',{username:'keeper',password:'wrong'})).status,401);
 const admin=await post('admin_login',{username:'keeper',password:'temporary-test-secret'});
 assert.equal(admin.status,200);assert.equal(admin.body.data.user.role,'keeper');
 assert.equal((await post('public_catalog',{},'', 'https://untrusted.invalid')).status,403);
 assert.equal((await post('unknown',{},token)).status,400);
 assert.equal((await post('logout',{},token)).status,200);assert.equal((await post('catalog',{},token)).status,401);
 const publicData=(await post('public_catalog')).body.data;
 assert.ok(!JSON.stringify(publicData).includes('12345'));
 for(let i=0;i<11;i++){
   const r=await post('worker_login',{name:'عامل آخر',employee_id:'98765'});
   if(i===10)assert.equal(r.status,429);
 }
});
