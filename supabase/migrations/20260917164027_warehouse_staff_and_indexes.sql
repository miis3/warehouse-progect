begin;
create index boxes_by_location on warehouse.boxes(location_id);
create index items_by_box on warehouse.items(box_id);
create index items_by_parent on warehouse.items(parent_id);
create index loans_by_checkout_request on warehouse.loans(checkout_request_id);
create index loans_by_return_request on warehouse.loans(return_request_id);
create index loans_by_checkout_keeper on warehouse.loans(checkout_keeper_id);
create index loans_by_return_keeper on warehouse.loans(return_keeper_id);
create index requests_by_box on warehouse.requests(box_id);
create index requests_by_reviewer on warehouse.requests(reviewer_id);
create index pending_unit_requests on warehouse.requests using gin(unit_ids) where status='pending';
create table warehouse.setup_tokens (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'), expires_at timestamptz not null, used_at timestamptz
);
alter table warehouse.setup_tokens enable row level security;
revoke all on warehouse.setup_tokens from public,anon,authenticated,service_role;
-- This schema is private: browser roles have no table privileges, and explicitly
-- deny-all policies document that only the checked, service-only RPCs can operate.
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='warehouse' loop
  execute format('create policy no_direct_access on warehouse.%I for all to anon, authenticated using(false) with check(false)',t.tablename);
 end loop;
end $$;

create function public.warehouse_staff_control(p_action text,p_token_hash text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=warehouse,pg_temp as $$
declare a jsonb; s staff_accounts; setup setup_tokens; result jsonb; v_id uuid;
begin
 if p_action in ('bootstrap_check','bootstrap_finish') then
  perform pg_advisory_xact_lock(hashtextextended('warehouse-first-manager',0));
  select * into setup from setup_tokens where token_hash=p_token_hash and used_at is null and expires_at>now() for update;
  if not found or exists(select 1 from staff_accounts) then raise exception 'رابط التهيئة غير صالح أو تم استخدامه' using errcode='42501'; end if;
  if p_action='bootstrap_check' then return jsonb_build_object('ok',true); end if;
  insert into staff_accounts(user_id,username,full_name,role) values((p_payload->>'user_id')::uuid,lower(p_payload->>'username'),p_payload->>'name','manager') returning * into s;
  update setup_tokens set used_at=now() where token_hash=p_token_hash;
  perform warehouse.log_event(jsonb_build_object('id',s.user_id,'name',s.full_name,'role','manager'),'staff_added',null,null,null,null,null,null,to_jsonb(s));
  return jsonb_build_object('ok',true);
 end if;
 a=warehouse.actor(p_token_hash);
 if a->>'role' not in ('keeper','manager') then raise exception 'للإدارة فقط' using errcode='42501'; end if;
 if p_action='password_changed' then
  update sessions set revoked_at=now() where actor_id=(a->>'id')::uuid and actor_type='staff' and token_hash<>p_token_hash;
  perform warehouse.log_event(a,'staff_password_changed');
  return jsonb_build_object('ok',true);
 end if;
 if a->>'role'<>'manager' then raise exception 'للمدير فقط' using errcode='42501'; end if;
 if p_action='list' then
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into result from (select user_id,username,full_name,role,active from staff_accounts order by full_name) x;
  return result;
 end if;
 if p_action in ('create_check','register') then
  if p_payload->>'username' is null or p_payload->>'username' !~ '^[a-z0-9_.-]{3,40}$' or
     coalesce(length(trim(p_payload->>'name')),0) not between 3 and 120 or
     coalesce(p_payload->>'role','') not in ('keeper','manager') then raise exception 'راجع الاسم واسم المستخدم والصلاحية' using errcode='22023'; end if;
  if exists(select 1 from staff_accounts where username=p_payload->>'username') then raise exception 'اسم المستخدم مستخدم بالفعل' using errcode='23505'; end if;
  if p_action='create_check' then return jsonb_build_object('ok',true); end if;
  insert into staff_accounts(user_id,username,full_name,role) values((p_payload->>'user_id')::uuid,p_payload->>'username',trim(p_payload->>'name'),p_payload->>'role') returning * into s;
  perform warehouse.log_event(a,'staff_added',null,null,null,null,null,null,to_jsonb(s));return to_jsonb(s);
 end if;
 if p_action='update' then
  v_id=(p_payload->>'user_id')::uuid;
  if v_id=(a->>'id')::uuid then raise exception 'لا يمكنك تعطيل حسابك أو تغيير صلاحيتك بنفسك' using errcode='42501'; end if;
  select * into s from staff_accounts where user_id=v_id for update;
  if not found or coalesce(p_payload->>'role','') not in ('keeper','manager') or jsonb_typeof(p_payload->'active') is distinct from 'boolean' then
    raise exception 'بيانات غير صحيحة' using errcode='22023'; end if;
  update staff_accounts set role=p_payload->>'role',active=(p_payload->>'active')::boolean where user_id=v_id;
  if not (p_payload->>'active')::boolean then update sessions set revoked_at=now() where actor_id=v_id and actor_type='staff'; end if;
  perform warehouse.log_event(a,'staff_access_changed',null,null,null,null,null,to_jsonb(s),p_payload);
  return jsonb_build_object('ok',true);
 end if;
 raise exception 'عملية غير معروفة' using errcode='22023';
end $$;
revoke all on function public.warehouse_staff_control(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warehouse_staff_control(text,text,jsonb) to service_role;
commit;
