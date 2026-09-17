import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {database,hash} from './database-helpers.mjs';
import {createWarehouseHandler} from '../supabase/functions/warehouse-api/handler.mjs';
test('bootstrap, manager-only staff creation, password rotation and revoked privileges',async t=>{
 const db=await database();t.after(()=>db.close());const identities=new Map();let creations=0;
 const rpc=async(name,args)=>{const entries=Object.entries(args);return(await db.query(`select public.${name}(${entries.map(([k],i)=>`${k} => $${i+1}`).join(',')}) as data`,entries.map(([,v])=>typeof v==='object'?JSON.stringify(v):v))).rows[0].data;};
 const handle=createWarehouseHandler({env:()=>undefined,rpc,
 createAuthUser:async password=>{const id=randomUUID();identities.set(id,password);creations++;return id;},
 authenticateAdmin:async(username,password)=>{const id=await rpc('warehouse_admin_identity',{p_username:username});return identities.get(id)===password?id:null;},
 updateAuthPassword:async(id,password)=>identities.set(id,password)});
 const post=async(action,payload={},token='')=>{const r=await handle(new Request('https://test.invalid/api',{method:'POST',headers:{'Content-Type':'application/json','X-Warehouse-Session':token},body:JSON.stringify({action,payload})}));return{status:r.status,body:await r.json()};};
 const setup=randomBytes(32).toString('hex'),password='test-only-password-123';
 await db.query("insert into warehouse.setup_tokens values($1,now()+interval '10 minutes',null)",[hash(setup)]);
 assert.equal((await post('bootstrap_admin',{setup_token:'a'.repeat(64),username:'manager',name:'مدير الاختبار',password})).status,403);
 assert.equal(creations,0);
 assert.equal((await post('bootstrap_admin',{setup_token:setup,username:'manager',name:'مدير الاختبار',password})).status,200);
 assert.equal((await post('bootstrap_admin',{setup_token:setup,username:'manager',name:'مدير الاختبار',password})).status,403);
 assert.equal(creations,1);
 const login=async(username,pw=password)=>{const r=await post('admin_login',{username,password:pw});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data.token;};
 const manager=await login('manager'),second=await login('manager');
 assert.equal((await post('create_staff',{username:'keeper',name:'أمين الاختبار',role:'keeper',password},manager)).status,200);
 const keeper=await login('keeper');
 assert.equal((await post('create_staff',{username:'illegal',name:'غير مسموح',role:'manager',password},keeper)).status,403);
 assert.equal((await post('staff_list',{},keeper)).status,403);assert.equal(creations,2);
 const list=(await post('staff_list',{},manager)).body.data;
 const keeperId=list.find(x=>x.username==='keeper').user_id;
 assert.equal((await post('change_password',{current_password:'wrong',new_password:'new-test-password-456'},manager)).status,400);
 assert.equal((await post('change_password',{current_password:password,new_password:'new-test-password-456'},manager)).status,200);
 assert.equal((await post('catalog',{},second)).status,401);
 assert.equal((await post('catalog',{},manager)).status,200);
 assert.equal((await post('staff_update',{user_id:keeperId,role:'keeper',active:false},manager)).status,200);
 assert.equal((await post('catalog',{},keeper)).status,401);
 assert.equal((await post('staff_update',{user_id:list.find(x=>x.username==='manager').user_id,role:'keeper',active:false},manager)).status,403);
 assert.equal((await post('admin_login',{username:'manager',password})).status,401);
 await login('manager','new-test-password-456');
 assert.ok((await db.query("select 1 from warehouse.audit_events where operation='staff_password_changed'")).rows.length);
});
