import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {inventorySql} from '../scripts/inventory-seed.mjs';
export const manifest=JSON.parse(readFileSync(new URL('../warehouse-project/data/inventory-manifest.json',import.meta.url)));
export const hash=value=>createHash('sha256').update(value).digest('hex');
export async function database() {
 const db=new PGlite();
 await db.exec('create role anon; create role authenticated; create role service_role;');
 for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())
  await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 return db;
}
export async function api(db,token,action,payload={}){
 return (await db.query('select public.warehouse_api($1,$2,$3::jsonb) as result',[action,hash(token),JSON.stringify(payload)])).rows[0].result;
}
export async function worker(db,name,employee,token=randomUUID()){
 const user=(await db.query('select public.warehouse_worker_login($1,$2,$3) as result',[name,employee,hash(token)])).rows[0].result;
 return {token,user};
}
export async function staff(db,role='keeper'){
 const id=randomUUID(), token=randomUUID();
 await db.query('insert into warehouse.staff_accounts(user_id,username,full_name,role) values($1,$2,$3,$4)',[id,'test-'+id,'أمين الاختبار',role]);
 const user=(await db.query('select public.warehouse_admin_login($1,$2) as result',[id,hash(token)])).rows[0].result;
 return {token,user};
}
