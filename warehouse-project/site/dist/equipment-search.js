// Index only inventory with an assigned location; exclude the demonstration case.
function buildEquipmentSearchIndex() { return (window.warehouseAllBoxes?window.warehouseAllBoxes():bravoBoxes).flatMap(box => {
  const entries = [];
  function visit(items, parentName = '', mainIndex = null) {
    items.forEach((item, index) => {
      const rootIndex = mainIndex ?? index;
      if (String(item.name || "").trim()) entries.push({ box, item, parentName, mainIndex: rootIndex });
      visit(item.children || [], item.name, rootIndex);
    });
  }
  visit(contentsFor(box)?.items || []);
  return entries;
}); }
let equipmentSearchIndex=buildEquipmentSearchIndex();
window.addEventListener('warehouse-catalog',()=>{equipmentSearchIndex=buildEquipmentSearchIndex();updateEquipmentResults();});
function normalizeEquipmentName(value) {
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').trim();
}
function findEquipment(query) {
  const words = normalizeEquipmentName(query).split(' ').filter(Boolean);
  return words.length ? equipmentSearchIndex.filter(entry => {
    const name = normalizeEquipmentName(entry.item.name);
    return words.every(word => name.includes(word));
  }) : [];
}
const equipmentSearch = document.getElementById('equipment-search');
equipmentSearch.innerHTML = `
  <label for="equipment-query">البحث عن معدة</label>
  <div class="equipment-search-controls"><input id="equipment-query" type="search" autocomplete="off" placeholder="اكتب اسم المعدة أو جزءًا منه" aria-describedby="equipment-search-help" aria-controls="equipment-results"><button id="equipment-search-clear" type="button">مسح البحث</button></div>
  <p id="equipment-search-help" class="note">البحث في المعدات والملحقات المسجلة بمواقعها في المستودع.</p>
  <p id="equipment-search-status" role="status" aria-live="polite" aria-atomic="true"></p>
  <ul id="equipment-results" class="equipment-results" aria-label="نتائج البحث" hidden></ul>`;
const equipmentQuery = document.getElementById('equipment-query');
const equipmentResults = document.getElementById('equipment-results');
const equipmentSearchStatus = document.getElementById('equipment-search-status');
let equipmentMatches = [];
const equipmentLocation = entry => `${rowNames[entry.box.row||1]} · الصف ${entry.box.row||1} · الجهة ${entry.box.side||'A'} · القسم ${pad(entry.box.bay)} · المستوى ${entry.box.level} · الصندوق ${entry.box.label} (${entry.box.position} في الموقع)`;
function updateEquipmentResults() {
  equipmentMatches = findEquipment(equipmentQuery.value);
  const hasQuery = Boolean(normalizeEquipmentName(equipmentQuery.value));
  equipmentResults.hidden = !hasQuery || !equipmentMatches.length;
  equipmentSearchStatus.textContent = !hasQuery ? '' : equipmentMatches.length ? `${equipmentMatches.length} نتيجة — اختر المعدة لفتح صندوقها.` : 'لا توجد معدات مطابقة في البيانات المسجلة.';
  equipmentResults.innerHTML = equipmentMatches.map((entry, index) => {
    const item = entry.item;
    return `<li><button type="button" data-equipment-result="${index}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(equipmentLocation(entry))}</span>${entry.parentName ? `<span>ضمن: ${escapeHtml(entry.parentName)}</span>` : ''}${item.quantity != null ? `<span>الكمية: ${escapeHtml(item.quantity)}</span>` : ''}${item.sourceCode ? `<span>رمز المعدة في الكشف: <bdi>${escapeHtml(item.sourceCode)}</bdi></span>` : ''}${item.notes ? `<span>ملاحظات: ${escapeHtml(item.notes)}</span>` : ''}</button>${window.warehouseSearchActions?window.warehouseSearchActions(entry):''}</li>`;
  }).join('');
}
equipmentQuery.addEventListener('input', updateEquipmentResults);
document.getElementById('equipment-search-clear').addEventListener('click', () => {
  equipmentQuery.value = '';
  updateEquipmentResults();
  equipmentQuery.focus();
});
equipmentQuery.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    equipmentResults.hidden = true;
  } else if (event.key === 'ArrowDown' && !equipmentResults.hidden) {
    event.preventDefault();
    equipmentResults.querySelector('button')?.focus();
  }
});
equipmentResults.addEventListener('keydown', event => {
  const buttons = [...equipmentResults.querySelectorAll('button')];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    equipmentResults.hidden = true;
    equipmentQuery.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
});
equipmentResults.addEventListener('click', async event => {
  const button = event.target.closest('[data-equipment-result]');
  if (!button) return;
  if (state.busy) {
    equipmentSearchStatus.textContent = 'انتظر اكتمال حركة الصندوق ثم اختر النتيجة.';
    return;
  }
  const entry = equipmentMatches[Number(button.dataset.equipmentResult)];
  if (!entry) return;
  // Finish the current case animation before moving to another location.
  equipmentQuery.disabled = true;
  try {
    if (app.querySelector('.rb-stage') && rbScene.open) await rbSetOpen(false);
    if (state.open) await setOpen(false);
    Object.assign(state, { row: entry.box.row||1, side: entry.box.side||'A', bay: entry.box.bay, level: entry.box.level, box: entry.box.id, view: 'case', open: false });
    Object.assign(rbScene, { boxId: entry.box.id, open: false, page: Math.floor(entry.mainIndex / rbPageSize) });
    renderBravo();
    const group = app.querySelectorAll('.rb-inventory > li')[entry.mainIndex];
    let target = group?.querySelector('button');
    if (entry.parentName) {
      const mainItem = contentsFor(entry.box).items[entry.mainIndex];
      const childIndex = (mainItem.children || []).indexOf(entry.item);
      target = group?.querySelectorAll('.rb-accessories > li')[childIndex] || target;
    }
    if (target) {
      target.classList.add('equipment-search-hit');
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    equipmentResults.hidden = true;
    equipmentSearchStatus.textContent = `${entry.item.name} — ${equipmentLocation(entry)}`;
    document.getElementById('announce').textContent = equipmentSearchStatus.textContent;
  } finally {
    equipmentQuery.disabled = false;
  }
});
