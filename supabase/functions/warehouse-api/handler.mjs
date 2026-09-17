// Portable Fetch handler shared by the Supabase Edge Function and integration tests.
// No browser-held service key and no local-storage authentication.
export const PRIVATE_ACTIONS = new Set(['session','logout','catalog','loans','requests','audit','request','cancel_request',
  'review_request','review_item','add_units','set_condition','save_box','save_item','workers','set_worker_active',
  'staff_list','staff_update','create_staff','change_password']);
const encoder = new TextEncoder();
export async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('');
}
function newToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
}
function normalizeEmployee(value) {
  return String(value??'').trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).toUpperCase();
}
export function createWarehouseHandler({env,fetchImpl=fetch,rpc:providedRpc,authenticateAdmin:providedAdmin,createAuthUser:providedCreate,updateAuthPassword:providedUpdate}={}) {
  const url=(env('SUPABASE_URL')||'').replace(/\/$/,'');
  const secret=env('SUPABASE_SERVICE_ROLE_KEY');
  const allowed=(env('ALLOWED_ORIGINS')||'https://miis3.github.io,http://localhost:8000,http://127.0.0.1:8000').split(',').map(x=>x.trim());
  const rpc = providedRpc || (async (name,args) => {
    const response=await fetchImpl(`${url}/rest/v1/rpc/${name}`,{method:'POST',
      headers:{apikey:secret,Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
    const body=await response.json();
    if(!response.ok){const err=new Error(body.message||'Database operation failed');err.code=body.code;throw err;}
    return body;
  });
  const authenticateAdmin=providedAdmin || (async (username,password)=>{
    const id=await rpc('warehouse_admin_identity',{p_username:username});
    if(!id)return null;
    const response=await fetchImpl(`${url}/auth/v1/admin/users/${id}`,{headers:{apikey:secret,Authorization:`Bearer ${secret}`}});
    if(!response.ok)return null;
    const user=await response.json();
    const auth=await fetchImpl(`${url}/auth/v1/token?grant_type=password`,{method:'POST',
      headers:{apikey:secret,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password})});
    if(!auth.ok)return null;
    const session=await auth.json();
    return session.user?.id===id?id:null;
  });
  const createAuthUser=providedCreate || (async password=>{
    const r=await fetchImpl(`${url}/auth/v1/admin/users`,{method:'POST',headers:{apikey:secret,Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},
      body:JSON.stringify({email:`warehouse-${crypto.randomUUID()}@example.invalid`,password,email_confirm:true})});
    if(!r.ok)throw new Error('Auth account creation failed');
    return (await r.json()).id;
  });
  const updateAuthPassword=providedUpdate || (async(id,password)=>{
    const r=await fetchImpl(`${url}/auth/v1/admin/users/${id}`,{method:'PUT',headers:{apikey:secret,Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({password})});
    if(!r.ok)throw new Error('Auth password update failed');
  });
  const createStaff=async(payload,hash,bootstrap=false)=>{
    const username=String(payload.username??'').trim().toLowerCase(),name=String(payload.name??'').trim();
    if(!/^[a-z0-9_.-]{3,40}$/.test(username)||name.length<3||name.length>120||typeof payload.password!=='string'||payload.password.length<12||payload.password.length>128){
      const e=new Error('أدخل اسمًا واسم مستخدم صحيحين وكلمة مرور من 12 حرفًا على الأقل');e.code='22023';throw e;
    }
    const values={username,name,role:bootstrap?'manager':payload.role};
    await rpc('warehouse_staff_control',{p_action:bootstrap?'bootstrap_check':'create_check',p_token_hash:hash,p_payload:values});
    const id=await createAuthUser(payload.password);
    try{return await rpc('warehouse_staff_control',{p_action:bootstrap?'bootstrap_finish':'register',p_token_hash:hash,p_payload:{...values,user_id:id}});}
    catch(error){
      // Roll back ONLY the newly created Auth identity if its profile was not saved.
      // First re-check the username to avoid deleting a successfully committed
      // identity when the response was lost in transit.
      const saved=await rpc('warehouse_admin_identity',{p_username:username}).catch(()=>undefined);
      if(saved===null&&!providedCreate)await fetchImpl(`${url}/auth/v1/admin/users/${id}`,{method:'DELETE',headers:{apikey:secret,Authorization:`Bearer ${secret}`}});
      if(saved===id)return {ok:true};throw error;
    }
  };
  return async function handle(request) {
    const origin=request.headers.get('Origin');
    const originAllowed=!origin||allowed.includes(origin);
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Warehouse-Session, apikey, Authorization',
      ...(origin&&originAllowed?{'Access-Control-Allow-Origin':origin}:{})};
    const answer=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(!originAllowed)return answer(403,{error:'هذا العنوان غير مسموح له بالاتصال'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return answer(405,{error:'طريقة طلب غير مدعومة'});
    if(!providedRpc&&(!url||!secret))return answer(503,{error:'اتصال المستودع غير مهيأ بعد'});
    try {
      const text=await request.text();
      if(encoder.encode(text).length>100000)return answer(413,{error:'الطلب أكبر من الحد المسموح'});
      let body;try{body=JSON.parse(text);}catch{return answer(400,{error:'طلب غير صحيح'});}
      if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.action!=='string')return answer(400,{error:'طلب غير صحيح'});
      const {action}=body,payload=body.payload??{};
      if(typeof payload!=='object'||!payload||Array.isArray(payload))return answer(400,{error:'طلب غير صحيح'});
      // The gateway provides forwarded IP. A second limit uses the account/session
      // itself so changing an IP cannot remove that account's rate limit.
      const ip=(request.headers.get('x-forwarded-for')||'unknown').split(',').at(-1).trim();
      const limit=async(key,count,seconds)=>rpc('warehouse_rate_limit',{p_key:await digest(key),p_limit:count,p_seconds:seconds});
      if(action==='bootstrap_admin'){
        if(!await limit('setup-ip:'+ip,5,300))return answer(429,{error:'محاولات كثيرة؛ انتظر خمس دقائق'});
        if(!/^[a-f0-9]{64}$/.test(payload.setup_token||''))return answer(403,{error:'رابط التهيئة غير صالح'});
        return answer(200,{data:await createStaff(payload,await digest(payload.setup_token),true)});
      }
      if(action==='worker_login'||action==='admin_login'){
        if(!await limit('login-ip:'+ip,40,300))return answer(429,{error:'محاولات كثيرة؛ انتظر خمس دقائق ثم حاول مجدداً'});
        const account=action==='worker_login'?normalizeEmployee(payload.employee_id):String(payload.username??'').trim().toLowerCase();
        if(account.length<2||account.length>80)return answer(400,{error:'أدخل بيانات الدخول بشكل صحيح'});
        if(!await limit(action+':'+account,10,300))return answer(429,{error:'محاولات كثيرة لهذا الحساب؛ انتظر خمس دقائق'});
        const token=newToken(),tokenHash=await digest(token);
        let user;
        if(action==='worker_login'){
          user=await rpc('warehouse_worker_login',{p_name:String(payload.name??''),p_employee_id:account,p_token_hash:tokenHash});
        }else{
          if(typeof payload.password!=='string'||payload.password.length<1||payload.password.length>1024)
            return answer(401,{error:'بيانات الدخول غير صحيحة'});
          const id=await authenticateAdmin(account,payload.password);
          if(!id)return answer(401,{error:'بيانات الدخول غير صحيحة'});
          user=await rpc('warehouse_admin_login',{p_user_id:id,p_token_hash:tokenHash});
        }
        return answer(200,{data:{token,user,idle_minutes:15}});
      }
      if(action==='public_catalog'){
        if(!await limit('catalog-ip:'+ip,90,60))return answer(429,{error:'طلبات كثيرة؛ انتظر قليلاً'});
        return answer(200,{data:await rpc('warehouse_public_catalog',{})});
      }
      if(!PRIVATE_ACTIONS.has(action))return answer(400,{error:'عملية غير معروفة'});
      const token=request.headers.get('X-Warehouse-Session')||'';
      if(!/^[a-f0-9]{64}$/.test(token))return answer(401,{error:'سجل الدخول أولاً'});
      const tokenHash=await digest(token);
      if(!await limit('session:'+tokenHash,150,60))return answer(429,{error:'طلبات كثيرة؛ انتظر قليلاً'});
      if(action==='create_staff')return answer(200,{data:await createStaff(payload,tokenHash)});
      if(action==='staff_list'||action==='staff_update')return answer(200,{data:await rpc('warehouse_staff_control',{
        p_action:action==='staff_list'?'list':'update',p_token_hash:tokenHash,p_payload:payload})});
      if(action==='change_password'){
        const user=await rpc('warehouse_api',{p_action:'session',p_token_hash:tokenHash,p_payload:{}});
        if(user.role==='worker')return answer(403,{error:'للإدارة فقط'});
        if(typeof payload.new_password!=='string'||payload.new_password.length<12||payload.new_password.length>128)return answer(400,{error:'كلمة المرور الجديدة يجب أن تكون من 12 حرفًا على الأقل'});
        if(typeof payload.current_password!=='string'||!await authenticateAdmin(user.username,payload.current_password))return answer(400,{error:'كلمة المرور الحالية غير صحيحة'});
        await updateAuthPassword(user.id,payload.new_password);
        return answer(200,{data:await rpc('warehouse_staff_control',{p_action:'password_changed',p_token_hash:tokenHash,p_payload:{}})});
      }
      const data=await rpc('warehouse_api',{p_action:action,p_token_hash:tokenHash,p_payload:payload});
      return answer(200,{data});
    }catch(error){
      const status=({'28000':401,'42501':403,'22023':400,'22P02':400,'23505':409,'23503':400,'23514':400,'23502':400})[error.code]||500;
      const message=status===500?'تعذر إتمام العملية؛ حاول مجدداً':/^[\s\S]*[\u0600-\u06ff]/.test(error.message)?error.message:'بيانات الطلب غير صحيحة';
      return answer(status,{error:message});
    }
  };
}
