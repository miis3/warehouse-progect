begin;
create schema if not exists warehouse;
revoke all on schema warehouse from public, anon, authenticated, service_role;

create table warehouse.locations (
  id uuid primary key, row_number integer not null check(row_number between 1 and 5),
  row_name text not null, side text not null check(side in ('A','B')),
  bay integer not null check(bay between 1 and 6), level integer not null check(level between 1 and 4),
  unique(row_number,side,bay,level), check(row_number not in (1,5) or side='A')
);
create table warehouse.boxes (
  id uuid primary key default gen_random_uuid(), legacy_id text unique, label text not null check(length(trim(label)) between 1 and 120),
  location_id uuid not null references warehouse.locations(id), position integer not null check(position>0),
  contents_missing boolean not null default true, source_sheet text, created_at timestamptz not null default now()
);
create table warehouse.items (
  id uuid primary key default gen_random_uuid(), box_id uuid not null references warehouse.boxes(id),
  parent_id uuid references warehouse.items(id), sort_order integer not null default 0,
  source_path text, name text not null, source_code text not null default '', source_quantity text,
  notes text not null default '', is_group boolean not null default false,
  source_record jsonb, inventory_reviewed boolean not null default false,
  photo_key text, created_at timestamptz not null default now(), check(length(name)<=500)
);
create table warehouse.units (
  id uuid primary key default gen_random_uuid(), item_id uuid not null references warehouse.items(id),
  ordinal integer not null check(ordinal>0),
  condition text not null check(condition in ('sound','usable_note','needs_maintenance','maintenance','broken')),
  condition_note text not null default '', unique(item_id,ordinal)
);
create table warehouse.workers (
  id uuid primary key default gen_random_uuid(), name text not null, name_normalized text not null,
  employee_id text not null unique, active boolean not null default true, created_at timestamptz not null default now()
);
create table warehouse.staff_accounts (
  user_id uuid primary key, username text not null unique check(username=lower(username)),
  full_name text not null, role text not null check(role in ('keeper','manager')), active boolean not null default true
);
create table warehouse.sessions (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  actor_id uuid not null, actor_type text not null check(actor_type in ('worker','staff')),
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null, revoked_at timestamptz
);
create table warehouse.rate_limits (
  key_hash text primary key, window_start timestamptz not null default now(), hits integer not null default 1
);
create table warehouse.requests (
  id uuid primary key default gen_random_uuid(), worker_id uuid not null references warehouse.workers(id),
  kind text not null check(kind in ('checkout','return')),
  box_id uuid references warehouse.boxes(id), unit_ids uuid[] not null check(cardinality(unit_ids)>0),
  status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
  notes text not null default '', requested_at timestamptz not null default now(),
  reviewed_at timestamptz, reviewer_id uuid references warehouse.staff_accounts(user_id), decision_note text not null default '',
  snapshot jsonb not null, client_key uuid not null, unique(worker_id,client_key)
);
create table warehouse.loans (
  id uuid primary key default gen_random_uuid(), unit_id uuid not null references warehouse.units(id),
  worker_id uuid not null references warehouse.workers(id), checkout_request_id uuid not null references warehouse.requests(id),
  checkout_keeper_id uuid not null references warehouse.staff_accounts(user_id), checkout_keeper_name text not null,
  checked_out_at timestamptz not null default now(), outbound_condition text not null, outbound_notes text not null default '',
  location_snapshot jsonb not null, worker_name text not null, employee_id text not null,
  returned_at timestamptz, return_condition text, return_notes text, return_keeper_id uuid references warehouse.staff_accounts(user_id),
  return_keeper_name text, return_request_id uuid references warehouse.requests(id)
);
create unique index one_active_custody_per_unit on warehouse.loans(unit_id) where returned_at is null;
create index loans_by_worker on warehouse.loans(worker_id,checked_out_at desc);
create index requests_by_worker on warehouse.requests(worker_id,requested_at desc);
create index pending_requests on warehouse.requests(requested_at) where status='pending';
create table warehouse.audit_events (
  id bigint generated always as identity primary key, occurred_at timestamptz not null default now(),
  operation text not null, actor_id uuid, actor_type text not null, actor_name text not null,
  worker_id uuid, worker_name text, employee_id text, item_id uuid, unit_id uuid, box_id uuid, request_id uuid,
  previous_value jsonb, new_value jsonb, notes text not null default ''
);
create index audit_by_worker on warehouse.audit_events(worker_id,id desc);
create index audit_by_item on warehouse.audit_events(item_id,id desc);

create function warehouse.immutable_audit() returns trigger language plpgsql set search_path=warehouse,pg_temp as $$
begin raise exception 'السجل ثابت؛ التصحيح يكون بعملية جديدة' using errcode='42501'; end $$;
create trigger audit_no_rewrite before update or delete on warehouse.audit_events for each row execute function warehouse.immutable_audit();
create trigger audit_no_truncate before truncate on warehouse.audit_events for each statement execute function warehouse.immutable_audit();
create function warehouse.protect_loan_history() returns trigger language plpgsql set search_path=warehouse,pg_temp as $$
begin
  if tg_op='DELETE' or old.returned_at is not null then raise exception 'لا يمكن تغيير تاريخ العهدة' using errcode='42501'; end if;
  if (to_jsonb(old)-array['returned_at','return_condition','return_notes','return_keeper_id','return_keeper_name','return_request_id'])
     is distinct from (to_jsonb(new)-array['returned_at','return_condition','return_notes','return_keeper_id','return_keeper_name','return_request_id'])
     or new.returned_at is null then raise exception 'بيانات خروج المعدة ثابتة' using errcode='42501'; end if;
  return new;
end $$;
create trigger loan_history before update or delete on warehouse.loans for each row execute function warehouse.protect_loan_history();

create function warehouse.actor(p_hash text) returns jsonb language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare s sessions; a jsonb;
begin
  select * into s from sessions where token_hash=p_hash and revoked_at is null and expires_at>now()
    and last_seen_at>now()-interval '15 minutes' for update;
  if not found then raise exception 'انتهت الجلسة؛ سجل الدخول مرة أخرى' using errcode='28000'; end if;
  if s.actor_type='worker' then
    select jsonb_build_object('id',id,'name',name,'employee_id',employee_id,'role','worker') into a from workers where id=s.actor_id and active;
  else
    select jsonb_build_object('id',user_id,'name',full_name,'username',username,'role',role) into a from staff_accounts where user_id=s.actor_id and active;
  end if;
  if a is null then raise exception 'الحساب غير نشط' using errcode='28000'; end if;
  update sessions set last_seen_at=now() where token_hash=p_hash;
  return a;
end $$;
create function warehouse.log_event(p_actor jsonb,p_op text,p_worker uuid default null,p_item uuid default null,p_unit uuid default null,
  p_box uuid default null,p_request uuid default null,p_old jsonb default null,p_new jsonb default null,p_notes text default '')
returns void language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare w workers;
begin
  if p_worker is not null then select * into w from workers where id=p_worker; end if;
  insert into audit_events(operation,actor_id,actor_type,actor_name,worker_id,worker_name,employee_id,item_id,unit_id,box_id,request_id,previous_value,new_value,notes)
  values(p_op,(p_actor->>'id')::uuid,p_actor->>'role',coalesce(p_actor->>'name','النظام'),p_worker,w.name,w.employee_id,p_item,p_unit,p_box,p_request,p_old,p_new,p_notes);
end $$;
create function warehouse.unit_snapshot(p_id uuid) returns jsonb language sql stable security definer set search_path=warehouse,pg_temp as $$
 select jsonb_build_object('unit_id',u.id,'ordinal',u.ordinal,'item_id',i.id,'name',i.name,'box_id',b.id,'box_label',b.label,
   'position',b.position,'row',l.row_number,'row_name',l.row_name,'side',l.side,'bay',l.bay,'level',l.level,
   'condition',u.condition,'condition_note',u.condition_note,
   'status',case when exists(select 1 from loans ln where ln.unit_id=u.id and ln.returned_at is null) then 'in_custody'
     when u.condition in ('needs_maintenance','maintenance') then 'maintenance' when u.condition='broken' then 'broken' else 'available' end)
 from units u join items i on i.id=u.item_id join boxes b on b.id=i.box_id join locations l on l.id=b.location_id where u.id=p_id
$$;
create function warehouse.lock_units(p_ids uuid[]) returns void language plpgsql security definer set search_path=warehouse,pg_temp as $$
begin
  perform 1 from boxes b where b.id in (select i.box_id from items i join units u on u.item_id=i.id where u.id=any(p_ids)) order by b.id for update;
  perform 1 from units where id=any(p_ids) order by id for update;
end $$;
create function warehouse.catalog() returns jsonb language sql stable security definer set search_path=warehouse,pg_temp as $$
select jsonb_build_object(
 'locations',coalesce((select jsonb_agg(to_jsonb(l) order by row_number,side,bay,level) from locations l),'[]'::jsonb),
 'boxes',coalesce((select jsonb_agg(to_jsonb(b) order by location_id,position,id) from boxes b),'[]'::jsonb),
 'items',coalesce((select jsonb_agg((to_jsonb(i)-'source_record')||jsonb_build_object('units',coalesce((
   select jsonb_agg(warehouse.unit_snapshot(u.id) order by ordinal) from units u where u.item_id=i.id),'[]'::jsonb)) order by box_id,sort_order,id) from items i),'[]'::jsonb))
$$;

create function public.warehouse_rate_limit(p_key text,p_limit integer,p_seconds integer) returns boolean
language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare n integer;
begin
  if p_limit not between 1 and 1000 or p_seconds not between 1 and 3600 then raise exception 'invalid rate limit'; end if;
  insert into rate_limits(key_hash) values(p_key) on conflict(key_hash) do update
    set hits=case when rate_limits.window_start<now()-make_interval(secs=>p_seconds) then 1 else rate_limits.hits+1 end,
      window_start=case when rate_limits.window_start<now()-make_interval(secs=>p_seconds) then now() else rate_limits.window_start end
    returning hits into n;
  delete from rate_limits where window_start<now()-interval '1 day';
  return n<=p_limit;
end $$;
create function public.warehouse_worker_login(p_name text,p_employee_id text,p_token_hash text) returns jsonb
language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare w workers; normalized text;
begin
  p_name=trim(regexp_replace(p_name,'\s+',' ','g')); normalized=lower(p_name);
  if p_name is null or length(p_name) not between 3 and 120 or p_employee_id is null or p_employee_id !~ '^[A-Za-z0-9-]{2,32}$' then
    raise exception 'أدخل الاسم والرقم الوظيفي بشكل صحيح' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('worker:'||p_employee_id,0));
  select * into w from workers where employee_id=p_employee_id;
  if not found then
    insert into workers(name,name_normalized,employee_id) values(p_name,normalized,p_employee_id) returning * into w;
    perform warehouse.log_event(jsonb_build_object('id',w.id,'name',w.name,'role','worker'),'worker_registered',w.id);
  elsif not w.active or w.name_normalized<>normalized then
    raise exception 'بيانات الدخول غير صحيحة أو الحساب غير نشط' using errcode='28000';
  end if;
  insert into sessions(token_hash,actor_id,actor_type,expires_at) values(p_token_hash,w.id,'worker',now()+interval '8 hours');
  return jsonb_build_object('id',w.id,'name',w.name,'employee_id',w.employee_id,'role','worker');
end $$;
create function public.warehouse_admin_identity(p_username text) returns uuid
language sql stable security definer set search_path=warehouse,pg_temp as $$
 select user_id from staff_accounts where username=lower(trim(p_username)) and active
$$;
create function public.warehouse_admin_login(p_user_id uuid,p_token_hash text) returns jsonb
language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare a staff_accounts;
begin
  select * into a from staff_accounts where user_id=p_user_id and active;
  if not found then raise exception 'بيانات الدخول غير صحيحة أو الحساب غير نشط' using errcode='28000'; end if;
  insert into sessions(token_hash,actor_id,actor_type,expires_at) values(p_token_hash,a.user_id,'staff',now()+interval '8 hours');
  return jsonb_build_object('id',a.user_id,'name',a.full_name,'username',a.username,'role',a.role);
end $$;
create function public.warehouse_public_catalog() returns jsonb language sql stable security definer set search_path=warehouse,pg_temp as $$
 select warehouse.catalog()
$$;

create function public.warehouse_api(p_action text,p_token_hash text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare
 a jsonb; v_role text; v_actor uuid; v_worker uuid; v_ids uuid[]; v_id uuid; v_box uuid; v_item uuid;
 r requests; ln loans; it items; bx boxes; u units; w workers;
 old_value jsonb; new_value jsonb; ins jsonb; inspections jsonb; result jsonb; v_condition text; v_note text;
 v_kind text; v_count integer; v_limit integer; v_offset integer; v_quantity integer; v_key uuid;
begin
 a=warehouse.actor(p_token_hash); v_role=a->>'role'; v_actor=(a->>'id')::uuid;
 if jsonb_typeof(p_payload)<>'object' then raise exception 'طلب غير صحيح' using errcode='22023'; end if;
 v_limit=greatest(1,least(100,coalesce((p_payload->>'limit')::integer,50)));
 v_offset=greatest(0,least(100000,coalesce((p_payload->>'offset')::integer,0)));
 if p_action='session' then return a; end if;
 if p_action='logout' then update sessions set revoked_at=now() where token_hash=p_token_hash; return jsonb_build_object('ok',true); end if;
 if p_action='catalog' then return warehouse.catalog(); end if;

 if p_action='loans' then
   select coalesce(jsonb_agg(x),'[]'::jsonb) into result from (
    select to_jsonb(l)||jsonb_build_object('current',warehouse.unit_snapshot(l.unit_id)) x from loans l
    where (v_role<>'worker' or l.worker_id=v_actor)
      and (case when coalesce((p_payload->>'history')::boolean,false) then l.returned_at is not null else l.returned_at is null end)
    order by l.checked_out_at desc,l.id limit v_limit offset v_offset) q;
   return result;
 end if;
 if p_action='requests' then
   select coalesce(jsonb_agg(x),'[]'::jsonb) into result from (
    select to_jsonb(q)||jsonb_build_object('worker_name',rw.name,'employee_id',rw.employee_id,'reviewer_name',s.full_name) x
    from requests q join workers rw on rw.id=q.worker_id left join staff_accounts s on s.user_id=q.reviewer_id
    where (v_role<>'worker' or q.worker_id=v_actor) and (coalesce(p_payload->>'status','')='' or q.status=p_payload->>'status')
    order by q.requested_at desc,q.id limit v_limit offset v_offset) q;
   return result;
 end if;
 if p_action='audit' then
   select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb) into result from (
    select * from audit_events where (v_role<>'worker' or worker_id=v_actor)
      and (nullif(p_payload->>'item_id','') is null or item_id=(p_payload->>'item_id')::uuid)
      and (nullif(p_payload->>'before','') is null or id<(p_payload->>'before')::bigint)
    order by id desc limit v_limit) e;
   return result;
 end if;

 if p_action='request' then
   if v_role<>'worker' then raise exception 'طلبات العامل من دخول العامل فقط' using errcode='42501'; end if;
   v_kind=p_payload->>'kind'; v_key=(p_payload->>'client_key')::uuid;
   if v_kind is null or v_kind not in ('checkout','return') or v_key is null then raise exception 'طلب غير صحيح' using errcode='22023'; end if;
   perform pg_advisory_xact_lock(hashtextextended('request:'||v_actor::text,0));
   select * into r from requests where worker_id=v_actor and client_key=v_key;
   if found then return to_jsonb(r); end if;
   v_box=nullif(p_payload->>'box_id','')::uuid;
   if v_box is not null then
     if v_kind<>'checkout' then raise exception 'اختر المعدات من عهدتك للإرجاع' using errcode='22023'; end if;
     select * into bx from boxes where id=v_box for update;
     if not found or bx.contents_missing or not exists(select 1 from items where box_id=v_box) or
       exists(select 1 from items where box_id=v_box and not is_group and (not inventory_reviewed or trim(name)='')) then
       raise exception 'يجب مراجعة جميع محتويات الصندوق قبل استلامه كاملاً' using errcode='22023'; end if;
     select array_agg(stock.id order by stock.id) into v_ids from units stock join items i on i.id=stock.item_id where i.box_id=v_box;
   else
     select array_agg(distinct x::uuid order by x::uuid) into v_ids from jsonb_array_elements_text(p_payload->'unit_ids') x;
   end if;
   if coalesce(cardinality(v_ids),0) not between 1 and 500 then raise exception 'اختر المعدة المطلوبة' using errcode='22023'; end if;
   perform warehouse.lock_units(v_ids);
   if (select count(*) from units where id=any(v_ids))<>cardinality(v_ids) then raise exception 'معدة غير موجودة' using errcode='22023'; end if;
   if exists(select 1 from requests where worker_id=v_actor and status='pending' and unit_ids && v_ids) then
     raise exception 'يوجد طلب معلق لهذه المعدة؛ انتظر اعتماد الأمين' using errcode='23505'; end if;
   if v_kind='checkout' then
     if exists(select 1 from units stock where stock.id=any(v_ids) and (stock.condition not in ('sound','usable_note') or
       exists(select 1 from loans l where l.unit_id=stock.id and l.returned_at is null))) then
       raise exception 'إحدى المعدات غير متاحة؛ حدّث القائمة' using errcode='23505'; end if;
   else
     if (select count(*) from loans where unit_id=any(v_ids) and worker_id=v_actor and returned_at is null)<>cardinality(v_ids) then
       raise exception 'يمكنك إرجاع المعدات الموجودة بعهدتك فقط' using errcode='42501'; end if;
   end if;
   select jsonb_agg(warehouse.unit_snapshot(x)) into result from unnest(v_ids) x;
   insert into requests(worker_id,kind,box_id,unit_ids,notes,snapshot,client_key)
     values(v_actor,v_kind,v_box,v_ids,left(coalesce(p_payload->>'notes',''),2000),result,v_key) returning * into r;
   perform warehouse.log_event(a,'request_created',v_actor,null,null,v_box,r.id,null,to_jsonb(r));
   return to_jsonb(r);
 end if;
 if p_action='cancel_request' then
   select * into r from requests where id=(p_payload->>'id')::uuid for update;
   if not found or v_role<>'worker' or r.worker_id<>v_actor then raise exception 'غير مسموح' using errcode='42501'; end if;
   if r.status<>'pending' then raise exception 'تمت معالجة الطلب مسبقاً' using errcode='23505'; end if;
   update requests set status='cancelled',reviewed_at=now() where id=r.id;
   perform warehouse.log_event(a,'request_cancelled',v_actor,null,null,r.box_id,r.id,to_jsonb(r),jsonb_build_object('status','cancelled'));
   return jsonb_build_object('ok',true);
 end if;

 if v_role not in ('keeper','manager') then raise exception 'هذه العملية للإدارة فقط' using errcode='42501'; end if;
 if p_action='review_request' then
   select * into r from requests where id=(p_payload->>'id')::uuid for update;
   if not found then raise exception 'الطلب غير موجود' using errcode='22023'; end if;
   if r.status<>'pending' then raise exception 'تمت معالجة الطلب مسبقاً' using errcode='23505'; end if;
   v_note=left(coalesce(p_payload->>'notes',''),2000);
   if p_payload->>'decision'='reject' then
     if trim(v_note)='' then raise exception 'اكتب سبب رفض الطلب' using errcode='22023'; end if;
     update requests set status='rejected',reviewed_at=now(),reviewer_id=v_actor,decision_note=v_note where id=r.id;
     perform warehouse.log_event(a,'request_rejected',r.worker_id,null,null,r.box_id,r.id,to_jsonb(r),jsonb_build_object('status','rejected'),v_note);
     return jsonb_build_object('ok',true);
   elsif p_payload->>'decision' is distinct from 'approve' then raise exception 'قرار غير صحيح' using errcode='22023'; end if;
   select * into w from workers where id=r.worker_id;
   -- Disabled workers may still return their outstanding custody through an existing request.
   if r.kind='checkout' and not w.active then raise exception 'حساب العامل غير نشط' using errcode='42501'; end if;
   perform warehouse.lock_units(r.unit_ids);
   if r.box_id is not null and (
     exists(select 1 from items where box_id=r.box_id and not is_group and not inventory_reviewed)
     or (select array_agg(stock.id order by stock.id) from units stock join items i on i.id=stock.item_id where i.box_id=r.box_id) is distinct from r.unit_ids
   ) then raise exception 'تغيرت محتويات الصندوق؛ أعد إنشاء الطلب' using errcode='23505'; end if;
   inspections=p_payload->'inspections';
   if jsonb_typeof(inspections) is distinct from 'array' or jsonb_array_length(inspections)<>cardinality(r.unit_ids) then
     raise exception 'سجل فحص كل معدة في الطلب' using errcode='22023'; end if;
   if (select count(distinct x->>'unit_id') from jsonb_array_elements(inspections) x)<>cardinality(r.unit_ids) or
      exists(select 1 from jsonb_array_elements(inspections) x where not ((x->>'unit_id')::uuid=any(r.unit_ids)) or x->>'unit_id' is null) then
     raise exception 'فحوص غير مطابقة للطلب' using errcode='22023'; end if;
   foreach v_id in array r.unit_ids loop
     select * into u from units where id=v_id;
     select * into it from items where id=u.item_id;
     select x into ins from jsonb_array_elements(inspections) x where (x->>'unit_id')::uuid=v_id;
     v_condition=ins->>'condition'; v_note=left(coalesce(ins->>'notes',''),2000);
     if v_condition is null or v_condition not in ('sound','usable_note','needs_maintenance','broken') or
        (v_condition<>'sound' and trim(v_note)='') then raise exception 'حدد حالة الفحص وأضف الملاحظة المطلوبة' using errcode='22023'; end if;
     old_value=warehouse.unit_snapshot(v_id);
     if r.kind='checkout' then
       if u.condition not in ('sound','usable_note') or v_condition not in ('sound','usable_note') or
          exists(select 1 from loans where unit_id=v_id and returned_at is null) then
         raise exception 'المعدة لم تعد متاحة؛ لم يتم اعتماد أي جزء من الطلب' using errcode='23505'; end if;
       update units set condition=v_condition,condition_note=v_note where id=v_id;
       insert into loans(unit_id,worker_id,checkout_request_id,checkout_keeper_id,checkout_keeper_name,
          outbound_condition,outbound_notes,location_snapshot,worker_name,employee_id)
       values(v_id,r.worker_id,r.id,v_actor,a->>'name',v_condition,v_note,warehouse.unit_snapshot(v_id),w.name,w.employee_id);
     else
       select * into ln from loans where unit_id=v_id and worker_id=r.worker_id and returned_at is null for update;
       if not found then raise exception 'المعدة ليست بعهدة هذا العامل' using errcode='23505'; end if;
       update loans set returned_at=now(),return_condition=v_condition,return_notes=v_note,
         return_keeper_id=v_actor,return_keeper_name=a->>'name',return_request_id=r.id where id=ln.id;
       update units set condition=v_condition,condition_note=v_note where id=v_id;
     end if;
     perform warehouse.log_event(a,case when r.kind='checkout' then 'equipment_checked_out' else 'equipment_returned' end,
       r.worker_id,it.id,v_id,it.box_id,r.id,old_value,warehouse.unit_snapshot(v_id),v_note);
   end loop;
   update requests set status='approved',reviewed_at=now(),reviewer_id=v_actor,decision_note=left(coalesce(p_payload->>'notes',''),2000) where id=r.id;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='review_item' then
   v_item=(p_payload->>'item_id')::uuid;
   select box_id into v_box from items where id=v_item;
   perform 1 from boxes where id=v_box for update;
   select * into it from items where id=v_item for update;
   if not found or it.is_group or trim(it.name)='' then raise exception 'راجع بند معدة مسمى ومستقلاً' using errcode='22023'; end if;
   if it.inventory_reviewed then raise exception 'تم اعتماد العدد؛ استخدم إضافة قطع عند الحاجة' using errcode='23505'; end if;
   v_quantity=(p_payload->>'quantity')::integer; v_condition=p_payload->>'condition'; v_note=left(coalesce(p_payload->>'notes',''),2000);
   if v_quantity is null or v_quantity not between 0 and 500 or v_condition is null or v_condition not in ('sound','usable_note','needs_maintenance','broken')
     or (v_condition<>'sound' and trim(v_note)='') then raise exception 'راجع العدد والحالة والملاحظات' using errcode='22023'; end if;
   insert into units(item_id,ordinal,condition,condition_note) select it.id,n,v_condition,v_note from generate_series(1,v_quantity) n;
   update items set inventory_reviewed=true where id=it.id;
   perform warehouse.log_event(a,'inventory_reviewed',null,it.id,null,it.box_id,null,to_jsonb(it),
     jsonb_build_object('quantity',v_quantity,'condition',v_condition,'source_quantity',it.source_quantity),v_note);
   return jsonb_build_object('ok',true);
 end if;
 if p_action='add_units' then
   v_item=(p_payload->>'item_id')::uuid;
   select box_id into v_box from items where id=v_item;
   perform 1 from boxes where id=v_box for update;
   select * into it from items where id=v_item for update;
   if not found or not it.inventory_reviewed or it.is_group or trim(it.name)='' then raise exception 'راجع البند أولاً' using errcode='22023'; end if;
   v_quantity=(p_payload->>'quantity')::integer; v_condition=p_payload->>'condition'; v_note=left(coalesce(p_payload->>'notes',''),2000);
   if v_quantity is null or v_quantity not between 1 and 100 or v_condition is null or v_condition not in ('sound','usable_note','needs_maintenance','broken')
      or trim(v_note)='' then raise exception 'أدخل العدد والحالة وسبب إضافة القطع' using errcode='22023'; end if;
   select coalesce(max(ordinal),0) into v_count from units where item_id=it.id;
   insert into units(item_id,ordinal,condition,condition_note) select it.id,v_count+n,v_condition,v_note from generate_series(1,v_quantity) n;
   perform warehouse.log_event(a,'equipment_units_added',null,it.id,null,it.box_id,null,jsonb_build_object('quantity',v_count),
     jsonb_build_object('quantity',v_count+v_quantity,'condition',v_condition),v_note);
   return jsonb_build_object('ok',true);
 end if;
 if p_action='set_condition' then
   v_id=(p_payload->>'unit_id')::uuid; perform warehouse.lock_units(array[v_id]);
   select * into u from units where id=v_id;
   if not found then raise exception 'المعدة غير موجودة' using errcode='22023'; end if;
   if exists(select 1 from loans where unit_id=v_id and returned_at is null) then raise exception 'افحص المعدة عند اعتماد إرجاعها' using errcode='23505'; end if;
   select * into it from items where id=u.item_id;
   v_condition=p_payload->>'condition'; v_note=left(coalesce(p_payload->>'notes',''),2000);
   if v_condition is null or v_condition not in ('sound','usable_note','needs_maintenance','maintenance','broken') or trim(v_note)='' then
     raise exception 'حدد الحالة واكتب سبب التغيير' using errcode='22023'; end if;
   old_value=warehouse.unit_snapshot(v_id);
   update units set condition=v_condition,condition_note=v_note where id=v_id;
   perform warehouse.log_event(a,case when v_condition='maintenance' and u.condition<>'maintenance' then 'maintenance_started'
     when u.condition='maintenance' and v_condition<>'maintenance' then 'maintenance_finished' else 'condition_changed' end,
     null,it.id,v_id,it.box_id,null,old_value,warehouse.unit_snapshot(v_id),v_note);
   return jsonb_build_object('ok',true);
 end if;
 if p_action='save_box' then
   v_id=nullif(p_payload->>'id','')::uuid;
   if length(trim(coalesce(p_payload->>'label',''))) not between 1 and 120 then raise exception 'أدخل اسم الصندوق' using errcode='22023'; end if;
   if v_id is not null then
     select * into bx from boxes where id=v_id for update;
     if not found then raise exception 'الصندوق غير موجود' using errcode='22023'; end if;
     old_value=to_jsonb(bx);
     update boxes set label=trim(p_payload->>'label'),location_id=(p_payload->>'location_id')::uuid,
       position=(p_payload->>'position')::integer where id=v_id returning * into bx;
   else
     insert into boxes(label,location_id,position) values(trim(p_payload->>'label'),(p_payload->>'location_id')::uuid,(p_payload->>'position')::integer) returning * into bx;
   end if;
   perform warehouse.log_event(a,case when v_id is null then 'box_added' else 'box_updated' end,null,null,null,bx.id,null,old_value,to_jsonb(bx));
   return to_jsonb(bx);
 end if;
 if p_action='save_item' then
   v_id=nullif(p_payload->>'id','')::uuid; v_box=(p_payload->>'box_id')::uuid;
   if length(trim(coalesce(p_payload->>'name',''))) not between 1 and 500 then raise exception 'أدخل اسم المعدة' using errcode='22023'; end if;
   if v_id is not null then
     select * into it from items where id=v_id;
     if not found or it.box_id<>v_box then raise exception 'نقل المعدة بين الصناديق غير مدعوم من تعديل الاسم' using errcode='22023'; end if;
   end if;
   perform 1 from boxes where id=v_box for update;
   if not found then raise exception 'الصندوق غير موجود' using errcode='22023'; end if;
   if v_id is not null then
     select * into it from items where id=v_id for update; old_value=to_jsonb(it);
     update items set name=trim(p_payload->>'name'),notes=left(coalesce(p_payload->>'notes',''),2000) where id=v_id returning * into it;
   else
     insert into items(box_id,name,notes,sort_order) values(v_box,trim(p_payload->>'name'),left(coalesce(p_payload->>'notes',''),2000),
       (select coalesce(max(sort_order),-1)+1 from items where box_id=v_box and parent_id is null)) returning * into it;
     update boxes set contents_missing=false where id=v_box;
   end if;
   perform warehouse.log_event(a,case when v_id is null then 'equipment_added' else 'equipment_updated' end,null,it.id,null,v_box,null,old_value,to_jsonb(it));
   return to_jsonb(it);
 end if;
 if v_role<>'manager' then raise exception 'هذه العملية للمدير فقط' using errcode='42501'; end if;
 if p_action='workers' then
   select coalesce(jsonb_agg(to_jsonb(worker_row)),'[]'::jsonb) into result from (select id,name,employee_id,active from workers order by name,id limit v_limit offset v_offset) worker_row;
   return result;
 end if;
 if p_action='set_worker_active' then
   select * into w from workers where id=(p_payload->>'id')::uuid for update;
   if not found or jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'طلب غير صحيح' using errcode='22023'; end if;
   update workers set active=(p_payload->>'active')::boolean where id=w.id;
   perform warehouse.log_event(a,'worker_access_changed',w.id,null,null,null,null,jsonb_build_object('active',w.active),jsonb_build_object('active',(p_payload->>'active')::boolean));
   return jsonb_build_object('ok',true);
 end if;
 raise exception 'عملية غير معروفة' using errcode='22023';
end $$;

do $$ declare t record; f record; begin
 for t in select tablename from pg_tables where schemaname='warehouse' loop
   execute format('alter table warehouse.%I enable row level security',t.tablename);
   execute format('revoke all on warehouse.%I from public, anon, authenticated, service_role',t.tablename);
 end loop;
 for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='warehouse' or (n.nspname='public' and p.proname like 'warehouse_%') loop
   execute format('revoke all on function %s from public, anon, authenticated, service_role',f.name);
 end loop;
end $$;
grant execute on function public.warehouse_rate_limit(text,integer,integer),public.warehouse_worker_login(text,text,text),
 public.warehouse_admin_identity(text),public.warehouse_admin_login(uuid,text),public.warehouse_public_catalog(),public.warehouse_api(text,text,jsonb) to service_role;
commit;
