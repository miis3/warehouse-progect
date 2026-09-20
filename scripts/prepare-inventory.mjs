import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
// Git checkouts may translate LF to CRLF on Windows. Hash canonical Git text,
// not the checkout's line-ending convention; preserve the existing source digest.
export const inventorySourceHash = raw => createHash('sha256').update(raw.replace(/\r\n/g,'\n')).digest('hex');
// Stable UUIDs derive from the ORIGINAL imported identity, never the current label/location.
export function stableId(key) {
  const b = createHash('sha1').update('warehouse-progect:inventory:v1:' + key).digest().subarray(0, 16);
  b[6] = (b[6] & 15) | 80; b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function prepareInventory() {
  const app = read('warehouse-project/site/dist/app.js');
  const raw = read('warehouse-project/site/dist/bravo-contents.js');
  const contents = JSON.parse(raw.slice(raw.indexOf('=') + 1).trim().replace(/;$/, ''));
  const distribution = vm.runInNewContext(app.match(/const bravoDistribution=(\[[\s\S]*?\n\]);/)[1]);
  const rowNames = ['برافو', 'اللوجستي والادارة', 'الاسبير', 'المعسكر', 'الفا'];
  const locations = rowNames.flatMap((name, i) => (i === 0 || i === 4 ? ['A'] : ['A','B']).flatMap(side =>
    Array.from({length:6}, (_, b) => Array.from({length:4}, (_, l) => ({
      id:stableId(`location:${i+1}:${side}:${b+1}:${l+1}`), row:i+1, row_name:name, side, bay:b+1, level:l+1
    }))).flat()));
  const boxes = [], items = [];
  distribution.forEach((bays, l) => bays.forEach((labels, b) => labels.forEach((label, p) => {
    const legacy_id = `bravo-s${b+1}-l${l+1}-box${p+1}`;
    const content = contents[label.replace(/^RB-SA-/, 'SA-').replace(/^SA([0-9])/, 'SA-$1')];
    const box = {id:stableId(legacy_id), legacy_id, label, location_id:stableId(`location:1:A:${b+1}:${l+1}`), position:p+1,
      contents_missing:!content, source_sheet:content?.sourceSheet ?? null};
    boxes.push(box);
    function visit(list, parent_id=null, prefix='') {
      list.forEach((item, i) => {
        const source_path = prefix + i, id = stableId(`${legacy_id}:item:${source_path}`);
        items.push({id,box_id:box.id,parent_id,sort_order:i,source_path,name:item.name ?? '',source_code:item.sourceCode ?? '',
          source_quantity:item.quantity ?? null,notes:item.notes ?? '',is_group:!!item.children?.length,source_record:item});
        visit(item.children || [], id, source_path + '.');
      });
    }
    visit(content?.items || []);
  })));
  return {version:1,source:'R-A.xlsx / كشف تحميل برافو.xlsx',source_sha256:inventorySourceHash(raw),locations,boxes,items};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = prepareInventory();
  mkdirSync(resolve(root,'docs'),{recursive:true});
  writeFileSync(resolve(root,'warehouse-project/data/inventory-manifest.json'),JSON.stringify(data,null,2)+'\n');
  const summary = {locations:data.locations.length,boxes:data.boxes.length,items:data.items.length,
    missingBoxes:data.boxes.filter(b=>b.contents_missing).map(b=>b.label),groups:data.items.filter(i=>i.is_group).length,
    unnamed:data.items.filter(i=>!i.name.trim()).length,unitsCreated:0};
  writeFileSync(resolve(root,'docs/inventory-review.md'),`# مراجعة نقل البيانات\n\n${JSON.stringify(summary,null,2)}\n\nالمعرّفات ثابتة ومستقلة عن الموقع والاسم. حُفظت السجلات الأصلية وأرقام RA والكميات كما وردت.\n\nلا تُنشأ قطع قابلة للصرف قبل مراجعة الأمين للكمية والحالة. مجموعات المعدات عناوين؛ أجزاؤها تُراجع كبنود مستقلة. تكرار SA-010 وSA-008 محفوظ ولا يعني اعتماد مضاعفة الكميات. SA-025 والسجل غير المسمى يبقيان محفوظين بانتظار المراجعة.\n\nبيانات الأرشيف الأوسع في data/bravo-contents.json وملفات inputs لم تُحذف أو تُستبدل.\n`);
  console.log(summary);
}
