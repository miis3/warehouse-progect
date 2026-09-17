import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareInventory } from '../scripts/prepare-inventory.mjs';

test('migration retains every located source record and distinct duplicate box', () => {
  const m = prepareInventory();
  assert.equal(m.locations.length,192); assert.equal(m.boxes.length,32); assert.equal(m.items.length,258);
  assert.equal(new Set([...m.boxes,...m.items].map(x=>x.id)).size,290);
  assert.equal(m.items.filter(i=>i.name.trim()).length,257);
  assert.deepEqual(m.boxes.filter(b=>b.contents_missing).map(b=>b.label),['SA-025']);
  assert.equal(m.boxes.filter(b=>b.label.replace('-','')==='SA010').length,3);
  for (const i of m.items) {
    assert.equal(i.name,i.source_record.name); assert.equal(i.source_quantity,i.source_record.quantity ?? null);
    assert.ok(m.boxes.some(b=>b.id===i.box_id));
    if(i.parent_id) assert.ok(m.items.some(p=>p.id===i.parent_id&&p.box_id===i.box_id));
  }
  assert.deepEqual(m,JSON.parse(readFileSync(new URL('../warehouse-project/data/inventory-manifest.json',import.meta.url))));
});
