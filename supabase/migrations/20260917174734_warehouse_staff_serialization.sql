begin;
create or replace function public.warehouse_staff_control(p_action text,p_token_hash text,p_payload jsonb default '{}') returns jsonb
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
 -- Serialize staff mutations before locking the actor session, preventing
 -- two managers from disabling each other using stale permissions.
 if p_action in ('update','register','password_changed') then
  perform pg_advisory_xact_lock(hashtextextended('warehouse-staff-mutations',0));
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
