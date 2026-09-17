-- Isolated staging verification: every test change is rolled back.
begin;
do $$
declare v_manager uuid; v_item uuid; v_unit uuid; a jsonb; w jsonb; r jsonb; loan jsonb;
 admin_hash text:=encode(sha256(gen_random_uuid()::text::bytea),'hex');
 worker_hash text:=encode(sha256(gen_random_uuid()::text::bytea),'hex');
begin
 select user_id into v_manager from warehouse.staff_accounts where active and role='manager' limit 1;
 if v_manager is null then raise exception 'No initialized manager'; end if;
 a:=public.warehouse_admin_login(v_manager,admin_hash);
 w:=public.warehouse_worker_login('عامل فحص معاملة مؤقتة','ROLLBACK-'||substr(gen_random_uuid()::text,1,8),worker_hash);
 select id into v_item from warehouse.items where not is_group and length(trim(name))>0 and not inventory_reviewed limit 1;
 perform public.warehouse_api('review_item',admin_hash,jsonb_build_object('item_id',v_item,'quantity',1,'condition','sound'));
 select id into v_unit from warehouse.units where item_id=v_item limit 1;
 r:=public.warehouse_api('request',worker_hash,jsonb_build_object('kind','checkout','unit_ids',jsonb_build_array(v_unit),'client_key',gen_random_uuid()));
 if r->>'status'<>'pending' then raise exception 'Expected pending request'; end if;
 perform public.warehouse_api('review_request',admin_hash,jsonb_build_object('id',r->>'id','decision','approve','inspections',jsonb_build_array(jsonb_build_object('unit_id',v_unit,'condition','sound','notes',''))));
 if jsonb_array_length(public.warehouse_api('loans',worker_hash))<>1 then raise exception 'Custody missing'; end if;
 r:=public.warehouse_api('request',worker_hash,jsonb_build_object('kind','return','unit_ids',jsonb_build_array(v_unit),'client_key',gen_random_uuid()));
 perform public.warehouse_api('review_request',admin_hash,jsonb_build_object('id',r->>'id','decision','approve','inspections',jsonb_build_array(jsonb_build_object('unit_id',v_unit,'condition','needs_maintenance','notes','اختبار يتم التراجع عنه'))));
 if jsonb_array_length(public.warehouse_api('loans',worker_hash))<>0 then raise exception 'Return did not close custody'; end if;
 loan:=public.warehouse_api('loans',worker_hash,'{"history":true}')->0;
 if loan->>'outbound_condition'<>'sound' or loan->>'return_condition'<>'needs_maintenance' then raise exception 'Inspection history lost'; end if;
 begin
  perform public.warehouse_api('request',worker_hash,jsonb_build_object('kind','checkout','unit_ids',jsonb_build_array(v_unit),'client_key',gen_random_uuid()));
  raise exception 'Maintenance unit was allowed out';
 exception when sqlstate '23505' then null; end;
 begin
  update warehouse.audit_events set notes='overwrite';
  raise exception 'Audit protection failed';
 exception when sqlstate '42501' then null; end;
end $$;
select 'PASS: issue, approval, return, history, maintenance, immutable audit; transaction will roll back' as result;
rollback;
