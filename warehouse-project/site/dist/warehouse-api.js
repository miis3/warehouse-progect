(() => {
  'use strict';
  let token = '', user = null, generation = 0;
  const config = window.WAREHOUSE_CONFIG || {};
  function clear() {
    token = ''; user = null; generation++;
    window.dispatchEvent(new Event('warehouse-session-ended'));
  }
  async function send(action, payload = {}, { publicCall = false } = {}) {
    if (!config.apiUrl) throw new Error('لم يكتمل ربط قاعدة المستودع بعد. راجع مسؤول النظام.');
    const epoch = generation;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 25000);
    let response;
    try {
      response = await fetch(config.apiUrl, { method: 'POST', cache: 'no-store', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', ...(config.gatewayKey ? { apikey: config.gatewayKey, Authorization: 'Bearer '+config.gatewayKey } : {}), ...(!publicCall && token ? { 'X-Warehouse-Session': token } : {}) },
        body: JSON.stringify({ action, payload }) });
    } catch {
      throw new Error('تعذر الاتصال. لم يتأكد حفظ العملية؛ تحقق من الاتصال ثم أعد المحاولة.');
    } finally { clearTimeout(timeout); }
    let body;
    try { body = await response.json(); } catch { throw new Error('استجابة غير صحيحة من المستودع.'); }
    if (epoch !== generation) throw new Error('تغيرت جلسة الدخول؛ أعد المحاولة.');
    if (!response.ok) {
      if (response.status === 401 && !publicCall) clear();
      throw new Error(body.error || 'تعذر إتمام العملية.');
    }
    return body.data;
  }
  async function login(action, payload) {
    const data = await send(action, payload, { publicCall: true });
    token = data.token; user = Object.freeze(data.user); generation++;
    return user;
  }
  window.WarehouseService = Object.freeze({
    get user() { return user; }, get configured() { return !!config.apiUrl; },
    loginWorker: (name, employee_id) => login('worker_login', { name, employee_id }),
    loginAdmin: (username, password) => login('admin_login', { username, password }),
    call: (action, payload) => send(action, payload),
    publicCatalog: () => send('public_catalog', {}, { publicCall: true }),
    async logout() { try { if (token) await send('logout'); } finally { clear(); } }
  });
})();
