const rbScene={open:false,page:0,boxId:null};
const rbBox=()=>locationBoxes().find(b=>b.id===state.box);
const photoKey=item=>{if(/N95/i.test(item.name))return 'face mask n95';const lines=item.name.split('\n').filter(s=>!/[\u0600-\u06ff]/.test(s));return (lines.join(' ').trim()||item.name).replace(/\s+/g,' ').trim().toLowerCase();};
const rbPhoto=item=>equipmentPhotos[item.photo_key||photoKey(item)]||null;
const rbQuantity=item=>item.quantity==null?(item.children?.length?'مجموعة':'الكمية غير مذكورة'):'الكمية: '+escapeHtml(item.quantity);
const rbStatus=()=>rbItems().length?'المعدات المعروضة من '+(rbScene.page*6+1)+' إلى '+Math.min((rbScene.page+1)*6,rbItems().length):'محتويات هذا الصندوق بانتظار الكشف';
const rbPageSize=6;
const rbItems=()=>contentsFor(rbBox())?.items||[];
const rbName=item=>item.name.split('\n').map(s=>s.trim()).filter(s=>/[\u0600-\u06ff]/.test(s)).join(' ')||item.name;
function rbPhotoCards(){
 return rbItems().slice(rbScene.page*rbPageSize,(rbScene.page+1)*rbPageSize).map((item,slot)=>{
 const index=rbScene.page*rbPageSize+slot,photo=rbPhoto(item),count=Math.min(rbPageSize,rbItems().length-rbScene.page*rbPageSize);
 const x=count===1?50:count===2?[35,65][slot]:[20,50,80][slot%3],y=count<=3?350:slot<3?435:255;
 return `<div class="rb-item" style="--slot-x:${x}%;--slot-y:${y}px;--order:${slot}">${photo?`<img src="${escapeHtml(photo.src)}" alt="صورة توضيحية: ${escapeHtml(rbName(item))}" width="160" height="140">`:`<span class="wh-empty">لا توجد صورة مضافة</span>`}<span>${escapeHtml(rbName(item))}</span><small>${rbQuantity(item)}</small></div>`;
 }).join('');
}
function renderRb001(box){
 if(rbScene.boxId!==box.id){Object.assign(rbScene,{boxId:box.id,open:false,page:0});}
 const items=rbItems(),pages=Math.ceil(items.length/rbPageSize);
 app.innerHTML=`<div class="topline"><div><div class="breadcrumbs">${rowNames[state.row]} / الجهة ${state.side} / القسم ${pad(state.bay)} / لفل ${state.level}</div><h1>الصندوق <b dir="ltr">${escapeHtml(box.label)}</b></h1></div><button data-action="boxes">رجوع إلى الصناديق ←</button></div>
 <div class="rb-inspect"><section class="stage rb-stage ${rbScene.open?'opened':''}" aria-label="صندوق ${escapeHtml(box.label)} التفاعلي"><div class="stage-label"><b dir="ltr">${code()}</b><small>${items.length?items.length+' بندًا رئيسيًا · صور توضيحية تقريبية':'بانتظار كشف المحتويات'}</small></div><div id="rb-items">${rbPhotoCards()}</div><button class="case sprite ${rbScene.open?'open':''}" data-action="rb-toggle" aria-label="${rbScene.open?'إغلاق':'فتح'} الصندوق ${escapeHtml(box.label)}" aria-expanded="${rbScene.open}"></button><span class="statusline" id="rb-status">${rbScene.open?rbStatus():'اضغط على الصندوق لفتحه'}</span></section>
 <aside class="details rb-details"><h2>محتويات الصندوق</h2><p class="note">الصور للتوضيح؛ الشكل والموديل قد يختلفان عن المعدات الموجودة لديكم.</p><button class="primary wide" id="rb-toggle" data-action="rb-toggle">${rbScene.open?'إرجاع المعدات وإغلاق الصندوق':'فتح الصندوق'}</button><nav class="rb-pagination" aria-label="مجموعات المعدات">${Array.from({length:pages},(_,p)=>`<button data-rb-page="${p}" aria-label="عرض المعدات من ${p*6+1} إلى ${Math.min((p+1)*6,items.length)}" aria-pressed="${rbScene.page===p}" class="${rbScene.page===p?'selected':''}">${p+1}</button>`).join('')}</nav><p class="note">${items.length?'اختر مجموعة أو اسم معدة لعرضها. الملحقات مدرجة أسفل مجموعتها.':'لم يرد هذا الصندوق في كشف المحتويات؛ لا توجد معدات معتمدة لعرضها.'}</p><ol class="rb-inventory">${items.map((item,index)=>`<li><button data-rb-page="${Math.floor(index/6)}" class="${Math.floor(index/6)===rbScene.page?'active':''}"><span>${escapeHtml(rbName(item))}</span><b>${item.quantity==null?(item.children?.length?'مجموعة':'غير مذكورة'):escapeHtml(item.quantity)}</b></button>${item.notes?`<p class="note rb-item-note">${escapeHtml(item.notes)}</p>`:''}${item.children?.length?`<ul class="rb-accessories">${item.children.map(child=>`<li><span>${escapeHtml(rbName(child))}${child.notes?`<small>${escapeHtml(child.notes)}</small>`:''}</span><b>${child.quantity==null?'غير مذكورة':escapeHtml(child.quantity)}</b></li>`).join('')}</ul>`:''}</li>`).join('')}</ol></aside></div>
 <details class="rb-sources"><summary>مصادر الصور التوضيحية</summary><ul>${items.map((item,index)=>{const p=rbPhoto(item);return p?`<li><a href="${escapeHtml(p.source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(rbName(item))}</a>${p.credit?' — '+escapeHtml(p.credit):''}</li>`:'';}).join('')}</ul></details>`;
 window.warehouseEnhance?.(box);
}
const rbDisabledBeforeAnimation=new WeakMap();
function rbLock(locked){state.busy=locked;app.querySelectorAll('button').forEach(b=>{if(locked){if(!rbDisabledBeforeAnimation.has(b))rbDisabledBeforeAnimation.set(b,b.disabled);b.disabled=true;}else{b.disabled=rbDisabledBeforeAnimation.get(b)??b.disabled;rbDisabledBeforeAnimation.delete(b);}});}
async function rbSetOpen(open){
 rbLock(true);const stage=app.querySelector('.rb-stage'),box=stage.querySelector('.case');
 if(open){box.classList.add('open');await delay(220);stage.classList.add('opened');await delay(900);}else{stage.classList.remove('opened');await delay(900);box.classList.remove('open');await delay(220);}
 rbScene.open=open;rbLock(false);box.setAttribute('aria-expanded',String(open));box.setAttribute('aria-label',(open?'إغلاق':'فتح')+' الصندوق '+rbBox().label);
 document.getElementById('rb-toggle').textContent=open?'إرجاع المعدات وإغلاق الصندوق':'فتح الصندوق';
 document.getElementById('rb-status').textContent=open?rbStatus():'اضغط على الصندوق لفتحه';
 document.getElementById('announce').textContent=open?'فُتح الصندوق وظهرت مجموعة المعدات':'عادت المعدات وأُغلق الصندوق';
}
async function handleRbAction(d){
 if(d.action==='rb001'){Object.assign(state,{row:1,side:'A',bay:5,level:1,view:'case',box:(window.warehouseAllBoxes?.().find(b=>b.legacy_id==='bravo-s5-l1-box2')?.id||'bravo-s5-l1-box2'),open:false});rbScene.open=false;rbScene.page=0;renderBravo();return true;}
 if(d.action==='rb-toggle'){await rbSetOpen(!rbScene.open);return true;}
 if(d.rbPage!==undefined){const p=Number(d.rbPage);if(p===rbScene.page){if(!rbScene.open)await rbSetOpen(true);return true;}
 const wasOpen=rbScene.open;if(wasOpen){rbLock(true);app.querySelector('.rb-stage').classList.remove('opened');await delay(900);}
 rbScene.page=p;renderRb001(locationBoxes().find(b=>b.id===state.box));
 if(wasOpen){rbLock(true);const stage=app.querySelector('.rb-stage');stage.classList.remove('opened');void stage.offsetWidth;await delay(40);stage.classList.add('opened');await delay(900);rbLock(false);}else{await rbSetOpen(true);}return true;}
 if(d.action==='boxes'&&app.querySelector('.rb-stage')){if(rbScene.open)await rbSetOpen(false);rbScene.page=0;state.box=null;renderBravo();return true;}
 return false;
}
