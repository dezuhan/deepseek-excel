'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Journal } = require('../public/js/journal.js');

test('push appends an entry with a sequential id', () => {
  const journal = new Journal({ limit: 5 });
  const first = journal.push({ tool: 'write_range', label: 'Tulis nilai' });
  const second = journal.push({ tool: 'format_range', label: 'Ubah format' });
  assert.equal(first.id, 'op-1');
  assert.equal(second.id, 'op-2');
  assert.equal(journal.list().length, 2);
  assert.equal(journal.last().id, 'op-2');
});

test('trim caps the number of entries at the limit', () => {
  const journal = new Journal({ limit: 2 });
  journal.push({ label: 'a' });
  journal.push({ label: 'b' });
  journal.push({ label: 'c' });
  assert.deepEqual(journal.list().map((e) => e.label), ['b', 'c']);
});

test('remove and clear', () => {
  const journal = new Journal();
  const entry = journal.push({ label: 'hapus aku' });
  assert.equal(journal.remove(entry.id), true);
  assert.equal(journal.remove('op-tidak-ada'), false);
  journal.push({ label: 'x' });
  journal.clear();
  assert.equal(journal.list().length, 0);
});

test('toJSON/fromJSON preserve the history', () => {
  const journal = new Journal({ limit: 10 });
  journal.push({ label: 'satu', undo: { snapshots: [{ sheet: 'Sheet1', address: 'A1' }] } });
  const data = JSON.parse(JSON.stringify(journal.toJSON()));
  const restored = Journal.fromJSON(data);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.last().label, 'satu');
  assert.equal(restored.toJSON().seq, 1);
});

test('fromJSON tolerates corrupted data', () => {
  assert.equal(Journal.fromJSON(null).list().length, 0);
  assert.equal(Journal.fromJSON({ entries: 'bukan array' }).list().length, 0);
});

test('byteSize reports the serialized size', () => {
  const journal = new Journal();
  journal.push({ label: 'x', undo: { snapshots: [] } });
  assert.ok(journal.byteSize() > 10);
});
