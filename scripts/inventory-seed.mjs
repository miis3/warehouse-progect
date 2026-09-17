import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export function inventorySql(m) {
  const quote = value => `'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
  return `-- Additive, repeatable import. Never overwrite reviewed operational data.\nbegin;\n
insert into warehouse.locations(id,row_number,row_name,side,bay,level)
select id,"row",row_name,side,bay,level from jsonb_to_recordset(${quote(m.locations)})
as x(id uuid,"row" integer,row_name text,side text,bay integer,level integer) on conflict(id) do nothing;
insert into warehouse.boxes(id,legacy_id,label,location_id,position,contents_missing,source_sheet)
select id,legacy_id,label,location_id,position,contents_missing,source_sheet from jsonb_to_recordset(${quote(m.boxes)})
as x(id uuid,legacy_id text,label text,location_id uuid,position integer,contents_missing boolean,source_sheet text) on conflict(id) do nothing;
insert into warehouse.items(id,box_id,parent_id,sort_order,source_path,name,source_code,source_quantity,notes,is_group,source_record)
select id,box_id,parent_id,sort_order,source_path,name,source_code,source_quantity,notes,is_group,source_record from jsonb_to_recordset(${quote(m.items)})
as x(id uuid,box_id uuid,parent_id uuid,sort_order integer,source_path text,name text,source_code text,source_quantity text,notes text,is_group boolean,source_record jsonb)
on conflict(id) do nothing;\ncommit;\n`;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const m=JSON.parse(readFileSync(new URL('../warehouse-project/data/inventory-manifest.json',import.meta.url)));
 writeFileSync(new URL('../supabase/migrations/20260917163408_warehouse_inventory.sql',import.meta.url),inventorySql(m));
 console.log('Additive seed generated:',m.boxes.length,'boxes;',m.items.length,'source records; no operational units.');
}
