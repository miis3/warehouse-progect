begin;

-- Additive workflow upgrade: no inventory, identities or historical loans are fabricated.
create table warehouse.settings (
 id boolean primary key default true check(id), overdue_days integer check(overdue_days between 1 and 3650),
 updated_at timestamptz, updated_by uuid references warehouse.staff_accounts(user_id)
);
insert into warehouse.settings(id) values(true);
create index settings_updated_by_idx on warehouse.settings(updated_by);
alter table warehouse.requests add column return_checkout_request_id uuid references warehouse.requests(id);
create index requests_return_checkout_idx on warehouse.requests(return_checkout_request_id);
alter table warehouse.units add column retired_at timestamptz;
alter table warehouse.units add column retired_by uuid references warehouse.staff_accounts(user_id);
alter table warehouse.units add column retirement_note text;
create index units_retired_by_idx on warehouse.units(retired_by);
create index active_loans_due_idx on warehouse.loans(checked_out_at,worker_id) where returned_at is null;
create index audit_operation_time_idx on warehouse.audit_events(operation,occurred_at);
create index audit_box_idx on warehouse.audit_events(box_id,id desc);

create table warehouse.maintenance_tickets (
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references warehouse.units(id),
 loan_id uuid references warehouse.loans(id), worker_id uuid references warehouse.workers(id),
 request_id uuid references warehouse.requests(id), opened_by uuid not null references warehouse.staff_accounts(user_id),
 opened_at timestamptz not null default now(), opening_condition text not null,
 notes text not null default '', closed_at timestamptz, closed_by uuid references warehouse.staff_accounts(user_id),
 resolution text, check((closed_at is null)=(closed_by is null))
);
create unique index one_open_maintenance on warehouse.maintenance_tickets(unit_id) where closed_at is null;
create index maintenance_unit_idx on warehouse.maintenance_tickets(unit_id);
create index maintenance_loan_idx on warehouse.maintenance_tickets(loan_id);
create index maintenance_worker_idx on warehouse.maintenance_tickets(worker_id);
create index maintenance_request_idx on warehouse.maintenance_tickets(request_id);
create index maintenance_opened_by_idx on warehouse.maintenance_tickets(opened_by);
create index maintenance_closed_by_idx on warehouse.maintenance_tickets(closed_by);

alter function public.warehouse_api(text,text,jsonb) rename to warehouse_api_core;
alter function public.warehouse_api_core(text,text,jsonb) set schema warehouse;
revoke all on function warehouse.warehouse_api_core(text,text,jsonb) from public,anon,authenticated,service_role;

create or replace function warehouse.unit_snapshot(p_id uuid) returns jsonb language sql stable security definer set search_path=warehouse,pg_temp as $$
 select jsonb_build_object('unit_id',u.id,'ordinal',u.ordinal,'item_id',i.id,'name',i.name,'box_id',b.id,'box_label',b.label,
 'position',b.position,'row',l.row_number,'row_name',l.row_name,'side',l.side,'bay',l.bay,'level',l.level,
 'condition',u.condition,'condition_note',u.condition_note,'retired_at',u.retired_at,
 'status',case when u.retired_at is not null then 'retired'
 when exists(select 1 from loans ln where ln.unit_id=u.id and ln.returned_at is null) then 'in_custody'
 when u.condition in ('needs_maintenance','maintenance') then 'maintenance' when u.condition='broken' then 'broken' else 'available' end)
 from units u join items i on i.id=u.item_id join boxes b on b.id=i.box_id join locations l on l.id=b.location_id where u.id=p_id
$$;

create function warehouse.overdue(p_worker uuid default null) returns jsonb language sql stable security definer set search_path=warehouse,pg_temp as $$
 select coalesce(jsonb_agg(x order by x->>'checked_out_at'),'[]'::jsonb) from (
 select to_jsonb(l)||jsonb_build_object('checkout_box_id',r.box_id,'worker_name',w.name,'employee_id',w.employee_id,
 'due_at',l.checked_out_at+make_interval(days=>s.overdue_days),
 'overdue_seconds',floor(extract(epoch from now()-l.checked_out_at-make_interval(days=>s.overdue_days)))) x
 from loans l join requests r on r.id=l.checkout_request_id join workers w on w.id=l.worker_id cross join settings s
 where l.returned_at is null and s.overdue_days is not null and l.checked_out_at+make_interval(days=>s.overdue_days)<now()
 and (p_worker is null or l.worker_id=p_worker)
 ) q
$$;

create function warehouse.sync_maintenance(p_actor jsonb,p_unit uuid,p_worker uuid default null,p_loan uuid default null,p_request uuid default null)
returns void language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare u units; m maintenance_tickets; snapshot jsonb;
begin
 select * into u from units where id=p_unit;
 select * into m from maintenance_tickets where unit_id=p_unit and closed_at is null for update;
 snapshot=warehouse.unit_snapshot(p_unit);
 if u.condition in ('broken','needs_maintenance','maintenance') and u.retired_at is null and m.id is null then
  insert into maintenance_tickets(unit_id,worker_id,loan_id,request_id,opened_by,opening_condition,notes)
  values(p_unit,p_worker,p_loan,p_request,(p_actor->>'id')::uuid,u.condition,u.condition_note) returning * into m;
  perform warehouse.log_event(p_actor,'maintenance_ticket_opened',p_worker,u.item_id,p_unit,(snapshot->>'box_id')::uuid,p_request,null,to_jsonb(m),u.condition_note);
 elsif u.condition in ('sound','usable_note') and m.id is not null then
  update maintenance_tickets set closed_at=now(),closed_by=(p_actor->>'id')::uuid,resolution=u.condition_note where id=m.id;
  perform warehouse.log_event(p_actor,'maintenance_ticket_closed',m.worker_id,u.item_id,p_unit,(snapshot->>'box_id')::uuid,p_request,to_jsonb(m),
   (select to_jsonb(t) from maintenance_tickets t where t.id=m.id),u.condition_note);
 end if;
end $$;

create function warehouse.protect_maintenance_history() returns trigger language plpgsql set search_path=warehouse,pg_temp as $$
begin
 if tg_op='DELETE' then raise exception 'لا يمكن حذف تاريخ الصيانة' using errcode='42501'; end if;
 if old.closed_at is not null or new.closed_at is null or
 (to_jsonb(old)-array['closed_at','closed_by','resolution']) is distinct from (to_jsonb(new)-array['closed_at','closed_by','resolution']) then
 raise exception 'بيانات بلاغ الصيانة ثابتة' using errcode='42501'; end if;
 return new;
end $$;
create trigger maintenance_history before update or delete on warehouse.maintenance_tickets for each row execute function warehouse.protect_maintenance_history();
create trigger maintenance_no_truncate before truncate on warehouse.maintenance_tickets for each statement execute function warehouse.immutable_audit();

create function public.warehouse_api(p_action text,p_token_hash text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=warehouse,pg_temp as $$
#variable_conflict use_column
declare
 a jsonb; role_name text; v_actor uuid; result jsonb; data jsonb; prior jsonb; inspection jsonb; inspections jsonb;
 r requests; original requests; l loans; u units; it items; v_id uuid; ids uuid[]; v_box uuid;
 condition_name text; note text; count_limit integer; page_offset integer; setting_days integer; outstanding jsonb;
begin
 a=warehouse.actor(p_token_hash); role_name=a->>'role'; v_actor=(a->>'id')::uuid;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'طلب غير صحيح' using errcode='22023'; end if;
 count_limit=greatest(1,least(100,coalesce((p_payload->>'limit')::integer,50)));
 page_offset=greatest(0,least(100000,coalesce((p_payload->>'offset')::integer,0)));
 select overdue_days into setting_days from settings where id;

 if p_action in ('settings','save_settings','dashboard','overdue','maintenance','close_maintenance','retire_unit') and role_name not in ('manager','keeper') then
  raise exception 'هذه العملية للإدارة فقط' using errcode='42501'; end if;
 if p_action='settings' then return (select to_jsonb(s) from settings s where id); end if;
 if p_action='save_settings' then
  if role_name<>'manager' then raise exception 'هذه العملية للمدير فقط' using errcode='42501'; end if;
  if jsonb_typeof(p_payload->'overdue_days') is distinct from 'number' or (p_payload->>'overdue_days') !~ '^[0-9]+$' then raise exception 'حدد عدد أيام التأخير' using errcode='22023'; end if;
  prior=(select to_jsonb(s) from settings s where id for update);
  update settings set overdue_days=(p_payload->>'overdue_days')::integer,updated_at=now(),updated_by=v_actor where id;
  result=(select to_jsonb(s) from settings s where id);
  perform warehouse.log_event(a,'settings_changed',p_old=>prior,p_new=>result);
  return result;
 end if;
 if p_action='overdue' then return warehouse.overdue(nullif(p_payload->>'worker_id','')::uuid); end if;
 if p_action='dashboard' then
  outstanding=warehouse.overdue();
  return jsonb_build_object('pending_count',(select count(*) from requests where status='pending'),
   'overdue_count',(select count(distinct coalesce(x->>'checkout_box_id',x->>'id')||':'||(x->>'checkout_request_id')) from jsonb_array_elements(outstanding) x),
   'overdue_days',setting_days,'maintenance_count',(select count(*) from maintenance_tickets where closed_at is null));
 end if;
 if p_action='custody' then
  -- Select groups before pagination; a whole box is never split across pages.
  select coalesce(jsonb_agg(x order by x->>'checked_out_at' desc,x->>'id'),'[]'::jsonb) into result from (
   select jsonb_build_object('id',g.group_id,'checkout_request_id',g.checkout_request_id,'box_id',g.box_id,
    'checked_out_at',g.checked_out_at,'worker_id',g.worker_id,'worker_name',w.name,'employee_id',w.employee_id,
    'original_contents',r.snapshot,'due_at',case when setting_days is not null then g.checked_out_at+make_interval(days=>setting_days) end,
    'overdue',not coalesce((p_payload->>'history')::boolean,false) and setting_days is not null and g.checked_out_at+make_interval(days=>setting_days)<now(),
    'overdue_seconds',case when setting_days is not null then greatest(0,floor(extract(epoch from now()-g.checked_out_at-make_interval(days=>setting_days)))) else 0 end,
    'loans',(select jsonb_agg(to_jsonb(ln)||jsonb_build_object('current',warehouse.unit_snapshot(ln.unit_id)) order by ln.location_snapshot->>'ordinal')
      from loans ln where ln.worker_id=g.worker_id and (case when g.box_id is not null then ln.checkout_request_id=g.checkout_request_id else ln.id=g.group_id end)
      and (case when coalesce((p_payload->>'history')::boolean,false) then ln.returned_at is not null else ln.returned_at is null end))) x
   from (select case when rq.box_id is not null then ln.checkout_request_id else ln.id end group_id,ln.checkout_request_id,rq.box_id,ln.worker_id,min(ln.checked_out_at) checked_out_at
    from loans ln join requests rq on rq.id=ln.checkout_request_id where (role_name<>'worker' or ln.worker_id=v_actor)
    and (case when coalesce((p_payload->>'history')::boolean,false) then ln.returned_at is not null else ln.returned_at is null end)
    group by group_id,ln.checkout_request_id,rq.box_id,ln.worker_id order by checked_out_at desc,group_id limit count_limit offset page_offset) g
   join requests r on r.id=g.checkout_request_id join workers w on w.id=g.worker_id
  ) q;
  return result;
 end if;
 if p_action='requests' then
  result=warehouse.warehouse_api_core(p_action,p_token_hash,p_payload);
  select coalesce(jsonb_agg(x||jsonb_build_object('box_id',coalesce(x->'box_id', 'null'::jsonb),'return_box_id',
    (select to_jsonb(box_id) from requests where id=nullif(x->>'return_checkout_request_id','')::uuid),
    'overdue_loans',case when role_name<>'worker' then warehouse.overdue((x->>'worker_id')::uuid) else '[]'::jsonb end)),'[]'::jsonb)
   into result from jsonb_array_elements(result) x;
  return result;
 end if;
 if p_action='audit' then
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc),'[]'::jsonb) into result from (
   select * from audit_events where (role_name<>'worker' or worker_id=v_actor)
   and (nullif(p_payload->>'item_id','') is null or item_id=(p_payload->>'item_id')::uuid)
   and (nullif(p_payload->>'box_id','') is null or box_id=(p_payload->>'box_id')::uuid)
   and (nullif(p_payload->>'before','') is null or id<(p_payload->>'before')::bigint)
   and (nullif(p_payload->>'operation','') is null or operation=p_payload->>'operation')
   and (nullif(p_payload->>'from','') is null or occurred_at >= (p_payload->>'from')::timestamptz)
   and (nullif(p_payload->>'to','') is null or occurred_at < (p_payload->>'to')::timestamptz+interval '1 day')
   and (nullif(p_payload->>'query','') is null or concat_ws(' ',actor_name,worker_name,employee_id,notes,previous_value::text,new_value::text) ilike '%'||left(p_payload->>'query',200)||'%')
   order by id desc limit count_limit) e;
  return result;
 end if;
 if p_action='request' then
  if role_name<>'worker' then raise exception 'طلبات العامل من دخول العامل فقط' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('request:'||v_actor::text,0));
  select * into r from requests where worker_id=v_actor and client_key=(p_payload->>'client_key')::uuid;
  if found then return to_jsonb(r); end if;
  data=p_payload; v_box=nullif(p_payload->>'box_id','')::uuid;
  if p_payload->>'kind'='return' and nullif(p_payload->>'checkout_request_id','') is not null then
   select * into original from requests where id=(p_payload->>'checkout_request_id')::uuid and worker_id=v_actor and kind='checkout' and box_id is not null;
   if not found then raise exception 'الصندوق ليس بعهدتك' using errcode='42501'; end if;
   select array_agg(unit_id order by unit_id) into ids from loans where checkout_request_id=original.id and worker_id=v_actor and returned_at is null;
   data=(data-'box_id')||jsonb_build_object('unit_ids',ids);
  elsif v_box is not null and p_payload->>'kind'='checkout' then
   perform 1 from boxes where id=v_box for update;
   if not found or (select contents_missing from boxes where id=v_box) or
    exists(select 1 from items where box_id=v_box and not is_group and (not inventory_reviewed or trim(name)='')) then
    raise exception 'بيانات مخزون الصندوق غير مكتملة؛ أكملها من تعديل المعدة' using errcode='22023'; end if;
   select array_agg(stock.id order by stock.id) into ids from units stock join items i on i.id=stock.item_id where i.box_id=v_box and stock.retired_at is null;
   data=(data-'box_id')||jsonb_build_object('unit_ids',ids);
  end if;
  if (original.id is not null or v_box is not null) and coalesce(cardinality(ids),0)=0 then raise exception 'لا توجد قطع قابلة للطلب' using errcode='22023'; end if;
  if exists(select 1 from units where retired_at is not null and id in (select value::uuid from jsonb_array_elements_text(data->'unit_ids'))) then
   raise exception 'القطعة مستبعدة من المخزون' using errcode='23505'; end if;
  result=warehouse.warehouse_api_core(p_action,p_token_hash,data);
  if original.id is not null then
   update requests set return_checkout_request_id=original.id where id=(result->>'id')::uuid returning * into r;
   perform warehouse.log_event(a,'box_return_requested',v_actor,p_box=>original.box_id,p_request=>r.id,p_new=>to_jsonb(r));
   return to_jsonb(r);
  elsif v_box is not null then
   update requests set box_id=v_box where id=(result->>'id')::uuid returning * into r;
   perform warehouse.log_event(a,'box_checkout_requested',v_actor,p_box=>v_box,p_request=>r.id,p_new=>to_jsonb(r));
   return to_jsonb(r);
  end if;
  return result;
 end if;
 if p_action='review_request' then
  if role_name not in ('manager','keeper') then raise exception 'هذه العملية للإدارة فقط' using errcode='42501'; end if;
  select * into r from requests where id=(p_payload->>'id')::uuid for update;
  if not found then raise exception 'الطلب غير موجود' using errcode='22023'; end if;
  if r.status<>'pending' then raise exception 'تمت معالجة الطلب مسبقاً' using errcode='23505'; end if;
  if p_payload->>'decision'='reject' then return warehouse.warehouse_api_core(p_action,p_token_hash,p_payload); end if;
  if p_payload->>'decision' is distinct from 'approve' then raise exception 'قرار غير صحيح' using errcode='22023'; end if;
  if r.kind='checkout' then
   perform 1 from workers where id=r.worker_id and active for share;
   if not found then raise exception 'حساب العامل غير نشط' using errcode='42501'; end if;
   if jsonb_array_length(warehouse.overdue(r.worker_id))>0 and p_payload->'acknowledge_overdue' is distinct from 'true'::jsonb then
    raise exception 'يوجد على هذا العامل عهدة متأخرة. راجعها وأكد قرار الاعتماد.' using errcode='22023'; end if;
  end if;
  perform warehouse.lock_units(r.unit_ids);
  if r.kind='checkout' and r.box_id is not null and (
   exists(select 1 from items where box_id=r.box_id and not is_group and not inventory_reviewed) or
   (select array_agg(stock.id order by stock.id) from units stock join items i on i.id=stock.item_id where i.box_id=r.box_id and stock.retired_at is null) is distinct from r.unit_ids) then
   raise exception 'تغيرت محتويات الصندوق؛ أعد إنشاء الطلب' using errcode='23505'; end if;
  inspections=p_payload->'inspections';
  if inspections is null then
   if r.kind='return' and p_payload->>'return_condition' is null then raise exception 'حدد الحالة عند الإرجاع' using errcode='22023'; end if;
   select jsonb_agg(jsonb_build_object('unit_id',id,'condition',case when r.kind='checkout' then condition else p_payload->>'return_condition' end,
    'notes',case when r.kind='checkout' then condition_note else coalesce(p_payload->>'notes','') end)) into inspections from units where id=any(r.unit_ids);
  end if;
  if jsonb_typeof(inspections) is distinct from 'array' or jsonb_array_length(inspections)<>cardinality(r.unit_ids) or
   (select count(distinct x->>'unit_id') from jsonb_array_elements(inspections) x)<>cardinality(r.unit_ids) or
   exists(select 1 from jsonb_array_elements(inspections) x where x->>'unit_id' is null or not ((x->>'unit_id')::uuid=any(r.unit_ids))) then
   raise exception 'سجل فحص كل معدة في الطلب' using errcode='22023'; end if;
  foreach v_id in array r.unit_ids loop
   select * into u from units where id=v_id; select * into it from items where id=u.item_id;
   select x into inspection from jsonb_array_elements(inspections) x where (x->>'unit_id')::uuid=v_id;
   condition_name=inspection->>'condition'; note=left(coalesce(inspection->>'notes',''),2000);
   if condition_name is null or condition_name not in ('sound','usable_note','needs_maintenance','maintenance','broken') then
    raise exception 'حدد حالة صحيحة' using errcode='22023'; end if;
   prior=warehouse.unit_snapshot(v_id);
   if r.kind='checkout' then
    if u.retired_at is not null or u.condition not in ('sound','usable_note') or condition_name not in ('sound','usable_note') or
     exists(select 1 from loans where unit_id=v_id and returned_at is null) then
     raise exception 'المعدة لم تعد متاحة؛ لم يتم اعتماد أي جزء من الطلب' using errcode='23505'; end if;
    insert into loans(unit_id,worker_id,checkout_request_id,checkout_keeper_id,checkout_keeper_name,outbound_condition,outbound_notes,location_snapshot,worker_name,employee_id)
    select v_id,r.worker_id,r.id,v_actor,a->>'name',condition_name,note,prior,w.name,w.employee_id from workers w where w.id=r.worker_id returning * into l;
   else
    select * into l from loans where unit_id=v_id and worker_id=r.worker_id and returned_at is null for update;
    if not found then raise exception 'المعدة ليست بعهدة هذا العامل' using errcode='23505'; end if;
    update loans set returned_at=now(),return_condition=condition_name,return_notes=note,return_keeper_id=v_actor,return_keeper_name=a->>'name',return_request_id=r.id where id=l.id;
   end if;
   update units set condition=condition_name,condition_note=note where id=v_id;
   perform warehouse.log_event(a,case when r.kind='checkout' then 'equipment_checked_out' else 'equipment_returned' end,r.worker_id,it.id,v_id,it.box_id,r.id,prior,warehouse.unit_snapshot(v_id),note);
   if r.kind='return' then perform warehouse.sync_maintenance(a,v_id,r.worker_id,l.id,r.id); end if;
  end loop;
  update requests set status='approved',reviewed_at=now(),reviewer_id=v_actor,decision_note=left(coalesce(p_payload->>'notes',''),2000) where id=r.id;
  perform warehouse.log_event(a,'request_approved',r.worker_id,p_box=>r.box_id,p_request=>r.id,p_old=>to_jsonb(r),p_new=>jsonb_build_object('status','approved','acknowledged_overdue',p_payload->'acknowledge_overdue'));
  if r.box_id is not null or r.return_checkout_request_id is not null then
   perform warehouse.log_event(a,case when r.kind='checkout' then 'box_checked_out' else 'box_returned' end,r.worker_id,
    p_box=>coalesce(r.box_id,(select box_id from requests where id=r.return_checkout_request_id)),p_request=>r.id,p_new=>r.snapshot);
  end if;
  return jsonb_build_object('ok',true);
 end if;
 if p_action='maintenance' then
  select coalesce(jsonb_agg(x order by x->>'opened_at' desc),'[]'::jsonb) into result from (
   select to_jsonb(m)||jsonb_build_object('unit',warehouse.unit_snapshot(m.unit_id),'worker_name',w.name,'employee_id',w.employee_id,'keeper_name',s.full_name) x
   from maintenance_tickets m left join workers w on w.id=m.worker_id join staff_accounts s on s.user_id=m.opened_by
   where (case when coalesce((p_payload->>'history')::boolean,false) then m.closed_at is not null else m.closed_at is null end)
   order by m.opened_at desc,m.id limit count_limit offset page_offset) q;
  return result;
 end if;
 if p_action='close_maintenance' then
  select unit_id into v_id from maintenance_tickets where id=(p_payload->>'id')::uuid and closed_at is null;
  if not found then raise exception 'البلاغ مغلق أو غير موجود' using errcode='23505'; end if;
  perform warehouse.lock_units(array[v_id]);
  perform 1 from maintenance_tickets where id=(p_payload->>'id')::uuid and closed_at is null for update;
  if not found then raise exception 'البلاغ مغلق أو غير موجود' using errcode='23505'; end if;
  data=jsonb_build_object('unit_id',v_id,'condition','sound','notes',p_payload->>'notes');
  result=warehouse.warehouse_api_core('set_condition',p_token_hash,data); perform warehouse.sync_maintenance(a,v_id); return result;
 end if;
 if p_action='retire_unit' then
  v_id=(p_payload->>'unit_id')::uuid; perform warehouse.lock_units(array[v_id]);
  select * into u from units where id=v_id;
  if not found or u.retired_at is not null then raise exception 'القطعة غير موجودة أو مستبعدة' using errcode='22023'; end if;
  if exists(select 1 from loans where unit_id=v_id and returned_at is null) or exists(select 1 from requests where status='pending' and v_id=any(unit_ids)) or
   exists(select 1 from maintenance_tickets where unit_id=v_id and closed_at is null) then raise exception 'أكمل العهدة والطلبات والصيانة قبل الاستبعاد' using errcode='23505'; end if;
  if nullif(trim(p_payload->>'notes'),'') is null then raise exception 'أدخل سبب استبعاد القطعة' using errcode='22023'; end if;
  prior=warehouse.unit_snapshot(v_id);
  update units set retired_at=now(),retired_by=v_actor,retirement_note=left(p_payload->>'notes',2000) where id=v_id;
  perform warehouse.log_event(a,'equipment_retired',p_item=>u.item_id,p_unit=>v_id,p_box=>(prior->>'box_id')::uuid,p_old=>prior,p_new=>warehouse.unit_snapshot(v_id),p_notes=>p_payload->>'notes');
  return jsonb_build_object('ok',true);
 end if;
 if p_action in ('initialize_stock','save_item') then
  if role_name not in ('manager','keeper') then raise exception 'هذه العملية للإدارة فقط' using errcode='42501'; end if;
  if p_action='initialize_stock' then return warehouse.warehouse_api_core('review_item',p_token_hash,p_payload); end if;
  result=warehouse.warehouse_api_core('save_item',p_token_hash,p_payload);
  if nullif(p_payload->>'id','') is null or (p_payload->'initialize_stock'='true'::jsonb and not (result->>'inventory_reviewed')::boolean and not (result->>'is_group')::boolean) then
   perform warehouse.warehouse_api_core('review_item',p_token_hash,jsonb_build_object('item_id',result->>'id','quantity',p_payload->'quantity','condition',p_payload->>'condition','notes',p_payload->>'notes'));
   result=(select to_jsonb(i) from items i where id=(result->>'id')::uuid);
  end if;
  return result;
 end if;
 if p_action='set_condition' and exists(select 1 from units where id=(p_payload->>'unit_id')::uuid and retired_at is not null) then
  raise exception 'القطعة مستبعدة من المخزون' using errcode='23505'; end if;
 result=warehouse.warehouse_api_core(p_action,p_token_hash,p_payload);
 if p_action='set_condition' then perform warehouse.sync_maintenance(a,(p_payload->>'unit_id')::uuid); end if;
 return result;
end $$;

alter table warehouse.settings enable row level security;
alter table warehouse.maintenance_tickets enable row level security;
create policy no_direct_access on warehouse.settings for all to anon,authenticated using(false) with check(false);
create policy no_direct_access on warehouse.maintenance_tickets for all to anon,authenticated using(false) with check(false);
revoke all on warehouse.settings,warehouse.maintenance_tickets from public,anon,authenticated,service_role;
revoke all on all functions in schema warehouse from public,anon,authenticated,service_role;
revoke all on function public.warehouse_api(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.warehouse_api(text,text,jsonb) to service_role;
commit;
