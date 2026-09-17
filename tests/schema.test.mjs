import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './database-helpers.mjs';

test('warehouse schema keeps RLS enabled and indexes every foreign key',async t=>{
  const db=await database();
  t.after(()=>db.close());

  const rls=await db.query(`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='warehouse' and c.relkind='r' and not c.relrowsecurity
    order by c.relname
  `);
  assert.deepEqual(rls.rows,[]);

  const missing=await db.query(`
    select c.conrelid::regclass::text as table_name, a.attname as column_name
    from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.contype='f'
      and c.connamespace='warehouse'::regnamespace
      and not exists (
        select 1 from pg_index i
        where i.indrelid=c.conrelid and a.attnum=any(i.indkey)
      )
    order by table_name,column_name
  `);
  assert.deepEqual(missing.rows,[]);
});
