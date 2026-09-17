(() => {
  'use strict';
  const service=window.WarehouseService, esc=escapeHtml;
  const access=document.getElementById('warehouse-access'), toolbar=document.getElementById('warehouse-tools');
  const panel=document.getElementById('warehouse-panel'), notice=document.getElementById('warehouse-notice');
  const search=document.getElementById('equipment-search');
  const conditionNames={sound:'سليمة',usable_note:'صالحة مع ملاحظة',needs_maintenance:'بها عطل وتحتاج صيانة',maintenance:'في الصيانة',broken:'غير صالحة للعمل'};
  const statusNames={available:'متاحة',in_custody:'بعهدة عامل',maintenance:'في الصيانة / تحتاج صيانة',broken:'متعطلة',unreviewed:'بانتظار مراجعة الكمية والحالة'};
  const requestNames={pending:'بانتظار اعتماد أمين المستودع',approved:'معتمد',rejected:'مرفوض',cancelled:'ملغى'};
  const operations={worker_registered:'تسجيل عامل',request_created:'إنشاء طلب',request_cancelled:'إلغاء طلب',request_rejected:'رفض طلب',
    equipment_checked_out:'استلام العامل للمعدة',equipment_returned:'إرجاع المعدة للمستودع',inventory_reviewed:'مراجعة الكمية والحالة',
    equipment_units_added:'إضافة قطع',condition_changed:'تغيير الحالة',maintenance_started:'نقل للصيانة',maintenance_finished:'رجوع من الصيانة',
    box_added:'إضافة صندوق',box_updated:'تعديل صندوق',equipment_added:'إضافة معدة',equipment_updated:'تعديل معدة',worker_access_changed:'تغيير صلاحية عامل',
    staff_added:'إضافة حساب إدارة',staff_access_changed:'تغيير صلاحية حساب إدارة',staff_password_changed:'تغيير كلمة مرور الإدارة'};
  let catalog=null, boxes=[], items=new Map(), contents=new Map(), view='map', guest=false, currentDialog=null;
  let lastActivity=Date.now(), pageGeneration=0, pageOffset=0, historyMode=false, auditItem=null, auditBefore=null;
  let requestsCache=[], loansCache=[], staffCache=[], selectedInventoryBox=null, loginMode='worker';
  const isStaff=()=>!!service.user&&service.user.role!=='worker';
  const date=value=>value?new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{timeZone:'Asia/Riyadh',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'—';
  const locationText=x=>`${x.row_name||rowNames[x.row]} · الجهة ${x.side} · القسم ${pad(x.bay)} · لفل ${x.level} · ${x.box_label||x.label||''}${x.position?' · الصندوق '+x.position+' في الموقع':''}`;
  const button=(label,attribute='',kind='')=>`<button type="button" ${attribute} class="${kind}">${esc(label)}</button>`;
  const empty=text=>`<p class="wh-empty">${esc(text)}</p>`;
  const status=u=>`<span class="wh-status" data-status="${esc(u.status)}">${esc(statusNames[u.status]||u.status)}</span>${u.condition_note?`<small class="note">${esc(u.condition_note)}</small>`:''}`;
  function toast(text,error=false){notice.textContent=text;notice.classList.toggle('wh-danger',error);}
  function applyCatalog(data){
    catalog=data;items=new Map();contents=new Map();
    const locations=new Map(data.locations.map(l=>[l.id,l]));
    boxes=data.boxes.map(b=>{const l=locations.get(b.location_id);return {...b,row:l.row_number,row_name:l.row_name,side:l.side,bay:l.bay,level:l.level};});
    data.items.forEach(i=>items.set(i.id,{...i,_inventoryId:i.id,sourceCode:i.source_code,quantity:i.source_quantity,children:[]}));
    for(const i of items.values())if(i.parent_id&&items.has(i.parent_id))items.get(i.parent_id).children.push(i);
    const sort=list=>{list.sort((a,b)=>a.sort_order-b.sort_order||a.id.localeCompare(b.id));list.forEach(i=>sort(i.children));};
    boxes.forEach(b=>{const list=[...items.values()].filter(i=>i.box_id===b.id&&!i.parent_id);sort(list);contents.set(b.id,{sourceSheet:b.source_sheet,items:list});});
    window.warehouseAllBoxes=()=>boxes;
    window.warehouseContentsFor=box=>contents.get(box.id)||contents.get(boxes.find(b=>b.legacy_id===box.id)?.id);
    if(state.box){const box=boxes.find(b=>b.id===state.box||b.legacy_id===state.box);if(box)state.box=box.id;}
    window.dispatchEvent(new Event('warehouse-catalog'));
  }
  async function refreshCatalog(){applyCatalog(await (service.user?service.call('catalog'):service.publicCatalog()));}
  function itemStatus(item){
    if(item.is_group)return '<span class="note">مجموعة؛ اختر المعدة من محتوياتها</span>';
    if(!item.inventory_reviewed)return status({status:'unreviewed'});
    if(!item.units.length)return '<span class="wh-status">العدد المعتمد صفر</span>';
    const counts={};item.units.forEach(u=>counts[u.status]=(counts[u.status]||0)+1);
    return Object.entries(counts).map(([s,n])=>`<span class="wh-status" data-status="${s}">${esc(statusNames[s])}: ${n}</span>`).join(' ');
  }
  function actionsForItem(item){
    if(!item?._inventoryId)return '';
    let action='';
    if(isStaff())action=button('سجل المعدة',`data-wh-audit="${item.id}"`);
    else if(!item.is_group){const available=item.units.some(u=>u.status==='available');
      action=button(service.user?'طلب استلام':'الدخول للاستلام',`data-wh-borrow="${item.id}" ${available?'':'disabled'}`);}
    return `<div class="wh-item-actions">${itemStatus(item)}${action}</div>`;
  }
  window.warehouseSearchActions=entry=>actionsForItem(entry.item);
  window.warehouseEnhance=box=>{
    const stage=app.querySelector('.rb-inspect');if(!stage||!catalog)return;
    let actions=app.querySelector('.wh-box-actions');if(!actions){actions=document.createElement('div');actions.className='wh-box-actions';stage.before(actions);}
    actions.innerHTML=button('باركود الصندوق',`data-wh-qr="${box.id}"`)+
      (!isStaff()?button(service.user?'طلب استلام الصندوق كاملاً':'الدخول لاستلام الصندوق',`data-wh-box-borrow="${box.id}"`,'primary'):'');
    const mainItems=contents.get(box.id)?.items||[];
    [...app.querySelectorAll('.rb-inventory > li')].forEach((li,index)=>{
      const item=mainItems[index];if(!item)return;
      li.querySelector(':scope > .wh-item-actions')?.remove();li.insertAdjacentHTML('beforeend',actionsForItem(item));
      [...li.querySelectorAll('.rb-accessories > li')].forEach((child,n)=>{
        child.querySelector('.wh-item-actions')?.remove();child.insertAdjacentHTML('beforeend',actionsForItem(item.children[n]));
      });
    });
  };
  function closeDialog(){if(currentDialog){currentDialog.close();currentDialog.remove();currentDialog=null;}}
  function modal(title,html,onSubmit){
    closeDialog();const dialog=document.createElement('dialog');dialog.className='wh-dialog';
    dialog.setAttribute('aria-label',title);dialog.innerHTML=`${button('إغلاق','data-wh-close','wh-close')}<h2>${esc(title)}</h2>${html}`;
    document.body.append(dialog);currentDialog=dialog;dialog.showModal();
    dialog.querySelector('[data-wh-close]').onclick=closeDialog;
    dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
    const form=dialog.querySelector('form');
    if(form&&onSubmit){form.addEventListener('submit',async e=>{
      e.preventDefault();if(form.dataset.busy)return;if(!form.reportValidity())return;
      const error=form.querySelector('.wh-error');error.textContent='';form.dataset.busy='1';
      const controls=[...form.querySelectorAll('button')];controls.forEach(b=>b.disabled=true);
      try{await onSubmit(new FormData(form),form);}catch(err){if(error.isConnected)error.textContent=err.message;else toast(err.message,true);}
      finally{delete form.dataset.busy;controls.forEach(b=>b.disabled=false);}
    });}
    return dialog;
  }
  const formEnd=label=>`<p class="wh-error" role="alert"></p><button type="submit" class="primary">${esc(label)}</button></form>`;
  function conditionOptions({maintenance=false,required=true,selected=''}={}){
    return `${required?'<option value="">اختر الحالة بعد الفحص</option>':''}${Object.entries(conditionNames).filter(([key])=>maintenance||key!=='maintenance').map(([key,label])=>`<option value="${key}" ${key===selected?'selected':''}>${esc(label)}</option>`).join('')}`;
  }
  function showLogin(mode='worker'){
    loginMode=mode;access.hidden=false;document.body.classList.add('wh-locked');toolbar.hidden=true;panel.hidden=true;guest=false;
    const admin=mode==='admin';
    access.innerHTML=`<div class="wh-login"><h1>${admin?'دخول الإدارة':'دخول المستودع'}</h1><p class="note">${admin?'للمدير وأمناء المستودع':'أدخل اسمك ورقمك الوظيفي للاستلام ومتابعة عهدتك.'}</p>
      <form id="wh-login-form" class="wh-form">${admin?'<label>اسم المستخدم<input name="username" autocomplete="username" required maxlength="80"></label><label>كلمة المرور<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>':'<label>الاسم<input name="name" autocomplete="off" required minlength="3" maxlength="120"></label><label>الرقم الوظيفي<input name="employee_id" autocomplete="off" required minlength="2" maxlength="32" dir="ltr"></label>'}
      <p class="wh-error" role="alert">${service.configured?'':'اتصال قاعدة المستودع لم يُجهّز بعد؛ لن تُحفظ أي عملية حتى يكتمل الربط.'}</p><button class="primary" type="submit">${admin?'دخول الإدارة':'دخول المستودع'}</button></form>
      ${button(admin?'رجوع لدخول العامل':'دخول الإدارة',`data-wh-login-mode="${admin?'worker':'admin'}"`,'wh-login-switch')}</div>`;
    access.querySelector('form').addEventListener('submit',async e=>{
      e.preventDefault();const form=e.currentTarget;if(form.dataset.busy||!form.reportValidity())return;
      const data=new FormData(form),submit=form.querySelector('button[type=submit]'),error=form.querySelector('.wh-error');
      form.dataset.busy='1';submit.disabled=true;error.textContent='';
      try{
        if(admin)await service.loginAdmin(data.get('username'),data.get('password'));
        else await service.loginWorker(data.get('name'),data.get('employee_id'));
        lastActivity=Date.now();await refreshCatalog();form.reset();access.hidden=true;document.body.classList.remove('wh-locked');
        renderToolbar();await openInitialLocation();toast('تم الدخول. سجّل الخروج عند الانتهاء من استخدام الشاشة.');
      }catch(err){error.textContent=err.message;}
      finally{delete form.dataset.busy;submit.disabled=false;}
    });
  }
  function renderToolbar(){
    toolbar.hidden=false;
    if(!service.user){toolbar.innerHTML=`<div class="wh-toolbar"><span class="wh-user">عرض عام لمحتويات الصندوق</span>${button('دخول العامل','data-wh-login-mode="worker"')}${button('دخول الإدارة','data-wh-login-mode="admin"')}</div>`;return;}
    const user=service.user;const nav=isStaff()?[['map','المستودع'],['requests','طلبات العاملين'],['custody','العهد الحالية'],['conditions','حالات المعدات'],['inventory','المعدات والصناديق'],['audit','السجل']]:
      [['map','المستودع'],['custody','عهدتي وسجلي'],['returns','تسليم معدة'],['requests','طلباتي']];
    if(user.role==='manager')nav.push(['users','المستخدمون']);
    toolbar.innerHTML=`<div class="wh-toolbar"><span class="wh-user">${esc(user.name)}<small>${esc(user.role==='worker'?'الرقم الوظيفي: '+user.employee_id:user.role==='manager'?'مدير المستودع':'أمين المستودع')}</small></span>
      ${nav.map(([key,label])=>button(label,`data-wh-view="${key}" aria-pressed="${view===key}"`)).join('')}${isStaff()?button('كلمة المرور','data-wh-password'):''}${button('تسجيل الخروج','data-wh-logout')}</div>`;
  }
  async function openInitialLocation(){
    const match=location.hash.match(/^#box=([0-9a-f-]{36})$/i);
    const target=match?boxes.find(b=>b.id===match[1]):location.hash==='#rb001'?boxes.find(b=>b.legacy_id==='bravo-s5-l1-box2'):null;
    if(target)await openBox(target.id);else await showView('map');
  }
  async function openBox(id){
    const box=boxes.find(b=>b.id===id);if(!box){toast('الصندوق غير موجود.',true);return;}
    if(state.busy){toast('انتظر اكتمال حركة الصندوق.');return;}
    if(app.querySelector('.rb-stage')&&rbScene.open)await rbSetOpen(false);
    view='map';panel.hidden=true;app.hidden=false;search.hidden=false;
    Object.assign(state,{row:box.row,side:box.side,bay:box.bay,level:box.level,box:box.id,view:'case',open:false});
    renderBravo();renderToolbar();history.replaceState(null,'',`#box=${box.id}`);
  }
  function panelShell(title,body){panel.hidden=false;app.hidden=true;search.hidden=true;panel.innerHTML=`<div class="wh-panel"><div class="topline"><h1>${esc(title)}</h1>${button('تحديث','data-wh-refresh')}</div>${body}</div>`;}
  function pager(count){return `<div class="wh-subnav">${pageOffset?button('السابق','data-wh-page="prev"'):''}${count===50?button('التالي','data-wh-page="next"'):''}</div>`;}
  function snapshotHTML(x){if(!x)return '';return `${x.name?`<strong>${esc(x.name)}</strong>`:''}${x.box_label||x.row_name?`<p class="note">${esc(locationText(x))}</p>`:''}${x.condition?`<p>الحالة: ${esc(conditionNames[x.condition]||x.condition)}</p>`:''}${x.condition_note?`<p>${esc(x.condition_note)}</p>`:''}${x.quantity!=null?`<p>العدد: ${esc(x.quantity)}</p>`:''}${x.label?`<p>اسم الصندوق: ${esc(x.label)}</p>`:''}${x.notes?`<p>${esc(x.notes)}</p>`:''}`;}
  async function showView(next,{keepPage=false}={}){
    if(state.busy){toast('انتظر اكتمال حركة الصندوق.');return;}
    if(!service.user&&!guest){showLogin();return;}
    if(!keepPage){pageOffset=0;auditBefore=null;}view=next;const generation=++pageGeneration;renderToolbar();
    if(next==='map'){panel.hidden=true;app.hidden=false;search.hidden=false;state.view='map';state.box=null;render();history.replaceState(null,'','#map');return;}
    if(!service.user){showLogin();return;}
    panelShell('المستودع',empty('جارٍ التحميل…'));
    try{
      if(next==='custody'||next==='returns'){
        const past=next==='custody'&&historyMode;
        const [loans,pending]=await Promise.all([service.call('loans',{history:past,limit:50,offset:pageOffset}),service.call('requests',{status:'pending',limit:100})]);
        if(generation!==pageGeneration)return;loansCache=loans;
        const pendingReturn=new Set(pending.filter(r=>r.kind==='return').flatMap(r=>r.unit_ids));
        const controls=next==='custody'?`<div class="wh-subnav">${button(isStaff()?'العهد الحالية':'عهدتي الآن',`data-wh-history="false" aria-pressed="${!past}"`)}${button('السجل السابق',`data-wh-history="true" aria-pressed="${past}"`)}${!isStaff()?button('سجل عملياتي','data-wh-view="audit"'):''}</div>`:'';
        panelShell(next==='returns'?'تسليم معدة':isStaff()?'العهد والسجل السابق':'عهدتي وسجلي',controls+`<div class="wh-cards">${loans.length?loans.map(l=>`<article class="wh-card"><h3>${esc(l.location_snapshot.name)} · القطعة ${l.location_snapshot.ordinal}</h3>
          <p class="note">${esc(locationText(l.location_snapshot))}</p>${isStaff()?`<p>العامل: ${esc(l.worker_name)} · الرقم الوظيفي: ${esc(l.employee_id)}</p>`:''}
          <p>الاستلام: ${esc(date(l.checked_out_at))}</p><p>حالة الخروج: ${esc(conditionNames[l.outbound_condition])}${l.outbound_notes?' — '+esc(l.outbound_notes):''}</p><p class="note">اعتماد: ${esc(l.checkout_keeper_name)}</p>
          ${past?`<p>الإرجاع: ${esc(date(l.returned_at))}</p><p>حالة الإرجاع: ${esc(conditionNames[l.return_condition])}${l.return_notes?' — '+esc(l.return_notes):''}</p><p class="note">اعتماد الإرجاع: ${esc(l.return_keeper_name)}</p>`:
          !isStaff()?`<div class="wh-actions">${button(pendingReturn.has(l.unit_id)?'طلب التسليم بانتظار الاعتماد':'تسليم المعدة',`data-wh-return="${l.unit_id}" ${pendingReturn.has(l.unit_id)?'disabled':''}`,'primary')}</div>`:''}</article>`).join(''):empty(past?'لا توجد معدات مُرجعة في سجلك.':'لا توجد معدات بعهدتك الآن.')}</div>`+pager(loans.length));
      }else if(next==='requests'){
        const requests=await service.call('requests',{status:isStaff()?'pending':'',limit:50,offset:pageOffset});if(generation!==pageGeneration)return;requestsCache=requests;
        panelShell(isStaff()?'طلبات بانتظار الاعتماد':'طلباتي',`<div class="wh-cards">${requests.length?requests.map(r=>`<article class="wh-card"><h3>${r.kind==='checkout'?'طلب استلام':'طلب تسليم'}${r.box_id?' صندوق كامل':''}</h3><p>${esc(requestNames[r.status])}</p>
          ${isStaff()?`<p>${esc(r.worker_name)} · الرقم الوظيفي: ${esc(r.employee_id)}</p>`:''}<p class="note">${esc(date(r.requested_at))}</p>
          <ul>${r.snapshot.map(u=>`<li>${esc(u.name)} · القطعة ${u.ordinal}<small class="note"> — ${esc(locationText(u))}</small></li>`).join('')}</ul>
          ${r.notes?`<p>الملاحظات: ${esc(r.notes)}</p>`:''}${r.decision_note?`<p>رد الأمين: ${esc(r.decision_note)}</p>`:''}${r.reviewed_at?`<p class="note">${esc(r.reviewer_name||'')} · ${esc(date(r.reviewed_at))}</p>`:''}
          ${r.status==='pending'?`<div class="wh-actions">${isStaff()?button('فحص واعتماد',`data-wh-approve="${r.id}"`,'primary')+button('رفض الطلب',`data-wh-reject="${r.id}"`):button('إلغاء الطلب',`data-wh-cancel="${r.id}"`)}</div>`:''}</article>`).join(''):empty('لا توجد طلبات في هذه القائمة.')}</div>`+pager(requests.length));
      }else if(next==='audit'){
        const events=await service.call('audit',{item_id:auditItem,before:auditBefore,limit:50});if(generation!==pageGeneration)return;
        panelShell(auditItem?'سجل المعدة':'سجل العمليات',`${auditItem?button('عرض السجل الكامل','data-wh-all-audit'):''}<p class="note">سجل ثابت. تُسجّل التصحيحات كعمليات جديدة. التوقيت بتوقيت الرياض.</p><div class="wh-cards">${events.length?events.map(e=>`<article class="wh-card"><h3>${esc(operations[e.operation]||e.operation)}</h3><p>${esc(date(e.occurred_at))}</p><p>نفّذها: ${esc(e.actor_name)}</p>${e.worker_name?`<p>العامل: ${esc(e.worker_name)} · ${esc(e.employee_id)}</p>`:''}${e.notes?`<p>${esc(e.notes)}</p>`:''}<details><summary>الحالة السابقة والجديدة</summary><p>قبل العملية</p>${snapshotHTML(e.previous_value)||'—'}<p>بعد العملية</p>${snapshotHTML(e.new_value)||'—'}</details></article>`).join(''):empty('لا توجد عمليات مسجلة.')}</div>${events.length===50?button('عمليات أقدم',`data-wh-audit-before="${events.at(-1).id}"`):''}`);
      }else if(next==='conditions'){
        await refreshCatalog();if(generation!==pageGeneration)return;
        const units=[...items.values()].flatMap(i=>i.units).filter(u=>u.condition!=='sound'||u.condition_note);
        panelShell('حالات المعدات',`<div class="wh-cards">${units.length?units.map(u=>`<article class="wh-card"><h3>${esc(u.name)} · القطعة ${u.ordinal}</h3><p class="note">${esc(locationText(u))}</p>${status(u)}<p>${esc(conditionNames[u.condition])}</p><div class="wh-actions">${button('تحديث الحالة',`data-wh-condition="${u.unit_id}" ${u.status==='in_custody'?'disabled':''}`)}${button('سجل المعدة',`data-wh-audit="${u.item_id}"`)}</div></article>`).join(''):empty('لا توجد معدات تحمل حالة أو ملاحظة إضافية.')}</div>`);
      }else if(next==='inventory'){
        await refreshCatalog();if(generation!==pageGeneration)return;renderInventory();
      }else if(next==='users'){
        const [workers,staff]=await Promise.all([service.call('workers',{limit:50,offset:pageOffset}),service.call('staff_list')]);if(generation!==pageGeneration)return;staffCache=staff;
        panelShell('المستخدمون',`<h2>الإدارة وأمناء المستودع</h2>${button('إضافة حساب إدارة','data-wh-new-staff','primary')}<div class="wh-cards">${staff.map(s=>`<article class="wh-card"><h3>${esc(s.full_name)}</h3><p>${esc(s.username)} · ${s.role==='manager'?'مدير':'أمين مستودع'} · ${s.active?'نشط':'معطّل'}</p>${s.user_id!==service.user.id?button('تعديل الصلاحية',`data-wh-staff="${s.user_id}"`):''}</article>`).join('')}</div><h2>العمال</h2><div class="wh-cards">${workers.map(w=>`<article class="wh-card"><h3>${esc(w.name)}</h3><p>الرقم الوظيفي: ${esc(w.employee_id)}</p><p>${w.active?'نشط':'معطّل'}</p>${button(w.active?'تعطيل دخول العامل':'تفعيل دخول العامل',`data-wh-worker="${w.id}" data-active="${!w.active}"`)}</article>`).join('')||empty('لم يسجل عمال بعد.')}</div>`+pager(workers.length));
      }
    }catch(err){if(generation===pageGeneration&&service.user)panelShell('تعذر تحميل البيانات',`<p class="wh-error" role="alert">${esc(err.message)}</p>`);}
  }
  function renderInventory(){
    if(!boxes.some(b=>b.id===selectedInventoryBox))selectedInventoryBox=boxes.find(b=>b.id===state.box)?.id||boxes[0]?.id;
    const box=boxes.find(b=>b.id===selectedInventoryBox), list=[...items.values()].filter(i=>i.box_id===box?.id);
    panelShell('المعدات والصناديق',`<div class="wh-subnav">${button('إضافة صندوق','data-wh-edit-box="new"','primary')}${box?button('تعديل الصندوق وموقعه',`data-wh-edit-box="${box.id}"`)+button('إضافة معدة',`data-wh-edit-item="new"`):''}</div>
      <label>الصندوق<select id="wh-inventory-box" class="wh-filter">${boxes.map(b=>`<option value="${b.id}" ${b.id===box?.id?'selected':''}>${esc(locationText(b))}</option>`).join('')}</select></label>
      <p class="note">اعتمد الكمية والحالة بعد الفحص الفعلي. أرقام القطع تُستخدم لتمييز القطع المتشابهة، وليست أرقامًا تسلسلية من الشركة.</p><div class="wh-cards">${list.map(i=>`<article class="wh-card"><h3>${esc(i.name||'بند غير مسمى — بانتظار المراجعة')}</h3><p class="note">الكمية في الكشف: ${esc(i.source_quantity??'غير مذكورة')} · ${esc(i.source_code)}</p>${itemStatus(i)}
      <div class="wh-actions">${button('تعديل الاسم والملاحظات',`data-wh-edit-item="${i.id}"`)}${button('السجل',`data-wh-audit="${i.id}"`)}${!i.is_group&&i.name.trim()?button(i.inventory_reviewed?'إضافة قطع':'مراجعة الكمية والحالة',`data-wh-review-item="${i.id}"`,'primary'):''}</div>
      ${i.units.length?`<details><summary>القطع والحالات (${i.units.length})</summary>${i.units.map(u=>`<div class="wh-unit-detail"><b>القطعة ${u.ordinal}</b> ${status(u)} ${button('تحديث الحالة',`data-wh-condition="${u.unit_id}" ${u.status==='in_custody'?'disabled':''}`)}</div>`).join('')}</details>`:''}</article>`).join('')||empty('محتويات هذا الصندوق بانتظار الإضافة والمراجعة.')}</div>`);
  }
  async function afterMutation(message){closeDialog();toast(message);try{await refreshCatalog();if(view==='map'){if(state.box)renderBravo();else render();}else await showView(view,{keepPage:true});}catch{toast(message+' تعذر تحديث العرض؛ اضغط تحديث.',true);}}
  function requireWorker(){if(service.user?.role==='worker')return true;showLogin('worker');return false;}
  function requestModal({item=null,box=null,returnUnit=null}){
    if(!requireWorker())return;
    let units=item?.units||[];
    if(returnUnit){const loan=loansCache.find(l=>l.unit_id===returnUnit);if(!loan)return;units=[loan.current];}
    const returning=!!returnUnit;let key=crypto.randomUUID();
    const dialog=modal(returning?'تسليم المعدة':box?'استلام الصندوق كاملاً':'طلب استلام معدة',`<p>${esc(box?locationText(box):item?.name||units[0]?.name||'')}</p><p class="note">سيُرسل الطلب باسم ${esc(service.user.name)}، رقم ${esc(service.user.employee_id)}، ويظل بانتظار اعتماد الأمين.</p>
      <form class="wh-form">${box?'':`<div class="wh-options">${units.map(u=>`<label><input type="checkbox" name="unit_ids" value="${u.unit_id}" ${returning?'checked':''} ${!returning&&u.status!=='available'?'disabled':''}><span>القطعة ${u.ordinal} — ${esc(conditionNames[u.condition])}<br>${status(u)}</span></label>`).join('')}</div>`}
      <label>ملاحظات (اختياري)<textarea name="notes" maxlength="2000"></textarea></label>${formEnd('إرسال الطلب للأمين')}`,
      async data=>{
        const ids=data.getAll('unit_ids');if(!box&&!ids.length)throw new Error('اختر قطعة واحدة على الأقل.');
        await service.call('request',{kind:returning?'return':'checkout',...(box?{box_id:box.id}:{unit_ids:ids}),notes:data.get('notes'),client_key:key});
        await afterMutation('تم إرسال الطلب؛ بانتظار اعتماد أمين المستودع.');
      });
    dialog.querySelector('form').addEventListener('input',()=>{key=crypto.randomUUID();});
  }
  function approveModal(id){
    const request=requestsCache.find(r=>r.id===id);if(!request)return;
    modal(request.kind==='checkout'?'فحص المعدة قبل الخروج':'فحص المعدة عند الإرجاع',`<p>${esc(request.worker_name)} · ${esc(request.employee_id)}</p><form class="wh-form">${request.snapshot.map((u,i)=>`<fieldset class="wh-inspection"><legend>${esc(u.name)} · القطعة ${u.ordinal}</legend><p class="note">${esc(locationText(u))}</p><label>الحالة ${request.kind==='checkout'?'قبل الخروج':'عند الإرجاع'}<select name="condition-${i}" required>${request.kind==='checkout'?'<option value="">اختر الحالة بعد الفحص</option><option value="sound">سليمة</option><option value="usable_note">صالحة مع ملاحظة</option>':conditionOptions()}</select></label><label>ملاحظات الفحص<textarea name="notes-${i}" maxlength="2000"></textarea></label></fieldset>`).join('')}<label>ملاحظة عامة (اختياري)<textarea name="notes" maxlength="2000"></textarea></label>${formEnd('اعتماد '+(request.kind==='checkout'?'الاستلام':'الإرجاع'))}`,
      async data=>{const inspections=request.snapshot.map((u,i)=>({unit_id:u.unit_id,condition:data.get(`condition-${i}`),notes:data.get(`notes-${i}`)}));
        if(inspections.some(i=>i.condition!=='sound'&&!i.notes.trim()))throw new Error('اكتب ملاحظة لكل حالة غير سليمة.');
        await service.call('review_request',{id,decision:'approve',inspections,notes:data.get('notes')});await afterMutation('تم الاعتماد وتحديث العهدة والسجل.');});
  }
  function rejectModal(id){modal('رفض الطلب',`<form class="wh-form"><label>سبب الرفض<textarea name="notes" required maxlength="2000"></textarea></label>${formEnd('تأكيد الرفض')}`,async data=>{
    await service.call('review_request',{id,decision:'reject',notes:data.get('notes')});await afterMutation('تم رفض الطلب وحفظ السبب في السجل.');});}
  function reviewItem(id){const item=items.get(id);if(!item)return;
    modal(item.inventory_reviewed?'إضافة قطع للمعدة':'مراجعة كمية وحالة المعدة',`<p>${esc(item.name)}</p><p class="note">الكمية في الكشف: ${esc(item.source_quantity??'غير مذكورة')}. أدخل العدد الذي تحققت منه فعليًا.</p><form class="wh-form"><label>${item.inventory_reviewed?'عدد القطع المضافة':'العدد الفعلي'}<input name="quantity" type="number" min="${item.inventory_reviewed?1:0}" max="${item.inventory_reviewed?100:500}" step="1" required></label><label>حالة القطع<select name="condition" required>${conditionOptions()}</select></label><label>ملاحظات المراجعة<textarea name="notes" maxlength="2000" ${item.inventory_reviewed?'required':''}></textarea></label>${formEnd('حفظ المراجعة')}`,async data=>{
      await service.call(item.inventory_reviewed?'add_units':'review_item',{item_id:id,quantity:Number(data.get('quantity')),condition:data.get('condition'),notes:data.get('notes')});await afterMutation('تم حفظ العدد والحالة مع الاحتفاظ ببيانات الكشف الأصلية.');});
  }
  function updateCondition(id){const unit=[...items.values()].flatMap(i=>i.units).find(u=>u.unit_id===id);if(!unit)return;
    modal('تحديث حالة المعدة',`<p>${esc(unit.name)} · القطعة ${unit.ordinal}</p><p class="note">${esc(locationText(unit))}</p><form class="wh-form"><label>الحالة الجديدة<select name="condition" required>${conditionOptions({maintenance:true})}</select></label><label>سبب التغيير / ملاحظات الفحص<textarea name="notes" required maxlength="2000"></textarea></label>${formEnd('حفظ الحالة')}`,async data=>{
      await service.call('set_condition',{unit_id:id,condition:data.get('condition'),notes:data.get('notes')});await afterMutation('تم تحديث الحالة وإضافة العملية إلى السجل.');});
  }
  function editBox(id){const box=boxes.find(b=>b.id===id);
    modal(box?'تعديل الصندوق وموقعه':'إضافة صندوق',`<form class="wh-form"><label>اسم / رقم الصندوق<input name="label" value="${esc(box?.label||'')}" required maxlength="120"></label><label>الموقع<select name="location_id" required>${catalog.locations.map(l=>`<option value="${l.id}" ${l.id===box?.location_id?'selected':''}>${esc(l.row_name)} · ${l.side} · القسم ${l.bay} · لفل ${l.level}</option>`).join('')}</select></label><label>ترتيب الصندوق في الموقع<input name="position" type="number" min="1" step="1" value="${box?.position||1}" required></label>${formEnd('حفظ الصندوق')}`,async data=>{
      const result=await service.call('save_box',{id:box?.id,label:data.get('label'),location_id:data.get('location_id'),position:Number(data.get('position'))});selectedInventoryBox=result.id;await afterMutation('تم حفظ الصندوق. رابط الباركود مرتبط بمعرّفه الثابت.');});
  }
  function editItem(id){const item=items.get(id),boxId=item?.box_id||selectedInventoryBox;
    modal(item?'تعديل بيانات المعدة':'إضافة معدة',`<form class="wh-form"><label>اسم المعدة<textarea name="name" maxlength="500" required>${esc(item?.name||'')}</textarea></label><label>ملاحظات<textarea name="notes" maxlength="2000">${esc(item?.notes||'')}</textarea></label>${formEnd('حفظ المعدة')}`,async data=>{
      await service.call('save_item',{id:item?.id,box_id:boxId,name:data.get('name'),notes:data.get('notes')});await afterMutation('تم حفظ بيانات المعدة. الكمية والحالة تُعتمدان من المراجعة.');});
  }
  function showQr(id){const box=boxes.find(b=>b.id===id);if(!box)return;const link=new URL(location.href);link.hash=`box=${id}`;
    const qr=qrcode(0,'M');qr.addData(link.href);qr.make();
    modal('باركود الصندوق '+box.label,`<div class="wh-qr"><p>${esc(locationText(box))}</p><img src="${qr.createDataURL(6,4)}" alt="باركود الصندوق ${esc(box.label)}"><a href="${esc(link.href)}">فتح رابط الصندوق</a><p class="note">العرض عام. الاستلام والعهد والسجلات تتطلب الدخول.</p></div>`);
  }
  function staffModal(id){const member=staffCache.find(s=>s.user_id===id);
    modal(member?'تعديل صلاحية الإدارة':'إضافة حساب إدارة',`<form class="wh-form">${member?`<p>${esc(member.full_name)} · ${esc(member.username)}</p><label>حالة الدخول<select name="active"><option value="true" ${member.active?'selected':''}>نشط</option><option value="false" ${!member.active?'selected':''}>معطّل</option></select></label>`:'<label>الاسم<input name="name" required minlength="3" maxlength="120"></label><label>اسم المستخدم (حروف إنجليزية وأرقام)<input name="username" dir="ltr" required pattern="[a-z0-9_.-]{3,40}" autocomplete="off"></label><label>كلمة المرور<input name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></label>'}<label>الصلاحية<select name="role"><option value="keeper" ${member?.role==='keeper'?'selected':''}>أمين مستودع</option><option value="manager" ${member?.role==='manager'?'selected':''}>مدير</option></select></label>${formEnd('حفظ الحساب')}`,async data=>{
      if(member)await service.call('staff_update',{user_id:member.user_id,role:data.get('role'),active:data.get('active')==='true'});
      else await service.call('create_staff',{name:data.get('name'),username:data.get('username'),password:data.get('password'),role:data.get('role')});
      await afterMutation('تم حفظ حساب الإدارة.');});
  }
  function passwordModal(){modal('تغيير كلمة المرور',`<form class="wh-form"><label>كلمة المرور الحالية<input name="current_password" type="password" required autocomplete="current-password"></label><label>كلمة المرور الجديدة<input name="new_password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></label>${formEnd('تغيير كلمة المرور')}`,async data=>{
    await service.call('change_password',{current_password:data.get('current_password'),new_password:data.get('new_password')});closeDialog();toast('تم تغيير كلمة المرور وإنهاء الجلسات الأخرى لهذا الحساب.');});}
  document.addEventListener('click',async event=>{
    const el=event.target.closest('button');if(!el)return;const d=el.dataset;
    try{
      if(d.whLoginMode){showLogin(d.whLoginMode);return;}
      if(d.whLogout!==undefined){await service.logout();return;}
      if(d.whView){historyMode=false;auditItem=null;await showView(d.whView);return;}
      if(d.whRefresh!==undefined){await showView(view,{keepPage:true});return;}
      if(d.whHistory!==undefined){historyMode=d.whHistory==='true';await showView('custody');return;}
      if(d.whPage){pageOffset=Math.max(0,pageOffset+(d.whPage==='next'?50:-50));await showView(view,{keepPage:true});return;}
      if(d.whAudit){auditItem=d.whAudit;await showView('audit');return;}
      if(d.whAllAudit!==undefined){auditItem=null;await showView('audit');return;}
      if(d.whAuditBefore){auditBefore=d.whAuditBefore;await showView('audit',{keepPage:true});return;}
      if(d.whBorrow){requestModal({item:items.get(d.whBorrow)});return;}
      if(d.whBoxBorrow){requestModal({box:boxes.find(b=>b.id===d.whBoxBorrow)});return;}
      if(d.whReturn){requestModal({returnUnit:d.whReturn});return;}
      if(d.whApprove){approveModal(d.whApprove);return;}
      if(d.whReject){rejectModal(d.whReject);return;}
      if(d.whCancel){el.disabled=true;await service.call('cancel_request',{id:d.whCancel});await afterMutation('تم إلغاء الطلب.');return;}
      if(d.whReviewItem){reviewItem(d.whReviewItem);return;}
      if(d.whCondition){updateCondition(d.whCondition);return;}
      if(d.whEditBox){editBox(d.whEditBox);return;}
      if(d.whEditItem){editItem(d.whEditItem);return;}
      if(d.whQr){showQr(d.whQr);return;}
      if(d.whWorker){el.disabled=true;await service.call('set_worker_active',{id:d.whWorker,active:d.active==='true'});await afterMutation('تم تحديث صلاحية العامل.');return;}
      if(d.whNewStaff!==undefined){staffModal();return;}
      if(d.whStaff){staffModal(d.whStaff);return;}
      if(d.whPassword!==undefined){passwordModal();return;}
    }catch(err){toast(err.message,true);el.disabled=false;}
  });
  document.addEventListener('change',event=>{if(event.target.id==='wh-inventory-box'){selectedInventoryBox=event.target.value;renderInventory();}});
  ['pointerdown','keydown','touchstart'].forEach(type=>document.addEventListener(type,()=>{lastActivity=Date.now();},{passive:true}));
  window.addEventListener('warehouse-session-ended',()=>{
    pageGeneration++;closeDialog();panel.innerHTML='';toolbar.innerHTML='';requestsCache=[];loansCache=[];notice.textContent='';
    showLogin();
  });
  window.addEventListener('hashchange',()=>{if(catalog&&(service.user||guest))openInitialLocation().catch(e=>toast(e.message,true));});
  setInterval(()=>{
    if(service.user&&Date.now()-lastActivity>=15*60*1000){service.logout().catch(()=>{});toast('انتهت الجلسة لحماية بياناتك.');}
  },10000);
  setInterval(()=>{
    if(service.user&&Date.now()-lastActivity<14*60*1000&&!currentDialog&&!document.hidden&&view==='requests')showView('requests',{keepPage:true});
  },30000);
  showLogin();
  if(/^#box=[0-9a-f-]{36}$/i.test(location.hash)||location.hash==='#rb001'){
    refreshCatalog().then(async()=>{guest=true;access.hidden=true;document.body.classList.remove('wh-locked');renderToolbar();await openInitialLocation();})
      .catch(err=>toast(err.message,true));
  }
})();
