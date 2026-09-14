'use strict';
/**
 * Core functional tests for spreadsheet execution: bridge + mock API + journal/undo.
 * Every flow that in Excel runs through Office.js is tested here using the
 * mock-api (in-memory data), so the plan/undo/cap logic is actually executed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// The pane modules use the IIFE pattern with root = self; point that at globalThis
// so they all share the same DSX object as in the browser.
global.self = global;
global.DSX = {
  validate: require('../public/js/validate.js'),
  Journal: require('../public/js/journal.js').Journal,
  i18n: require('../public/js/i18n.js'),
};
require('../public/js/mock-api.js');
require('../public/js/office-bridge.js');

const DSX = global.DSX;
const bridge = DSX.bridge;

function freshBridge() {
  // mock-api keeps its state in the module closure, so the reset goes through the API.
  bridge.init(DSX.mockApi, { maxCellsWrite: 5000, maxCellsRead: 2000, autoApply: false });
  const journal = bridge.journalEntries();
  if (journal.length) bridge._state.journal.clear();
  bridge._state.pending = [];
  return DSX.mockApi;
}

test('overview reads the structure of the mock workbook', async () => {
  freshBridge();
  const outcome = await bridge.callTool('get_workbook_overview', { includeSampleRows: 2 });
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.result.sheets[0].name, 'Sheet1');
  assert.equal(outcome.result.sheets[0].headers[0], 'Tanggal');
  assert.equal(outcome.result.sheets[0].sample.length, 2);
});

test('write_range builds a plan (not applied immediately)', async () => {
  freshBridge();
  const outcome = await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'F1:G2',
    mode: 'values',
    values: [['a', 1], ['b', 2]],
  });
  assert.equal(outcome.status, 'pending');
  assert.equal(outcome.plan.tool, 'write_range');
  assert.match(outcome.plan.preview.summary, /Write 4 cells/);
  assert.equal(outcome.plan.preview.rows.length, 2);
  assert.equal(outcome.plan.preview.rows[0].cells[0].before, '');

  // No changes yet and no journal yet.
  const check = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'F1:G2' });
  assert.deepEqual(check.result.values, [['', ''], ['', '']]);
  assert.equal(bridge.history().count, 0);
});

test('applyPlan applies the changes and records the journal', async () => {
  freshBridge();
  const plan = (await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'F1:F2',
    mode: 'values',
    values: [['baru'], ['data']],
  })).plan;

  const applied = await bridge.applyPlan(plan.id);
  assert.equal(applied.ok, true);

  const check = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'F1:F2' });
  assert.deepEqual(check.result.values, [['baru'], ['data']]);
  assert.equal(bridge.history().count, 1);
  assert.equal(bridge.pendingPlans().length, 0);
});

test('undoLast restores the data to its original state', async () => {
  const api = freshBridge();
  await bridge.callTool('write_range', { sheet: 'Sheet1', address: 'A2:B2', mode: 'values', values: [['X', 'Y']] });
  const plan = bridge.pendingPlans()[0];
  await bridge.applyPlan(plan.id);

  let read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'A2:B2' });
  assert.deepEqual(read.result.values, [['X', 'Y']]);

  const undone = await bridge.undoLast();
  assert.equal(undone.ok, true);

  read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'A2:B2' });
  assert.deepEqual(read.result.values, [['01/03/2026', 'Gaji']]);
  assert.equal(bridge.history().count, 0);
  assert.ok(api.state);
});

test('rejectPlan discards the plan without touching the data', async () => {
  freshBridge();
  const plan = (await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'A1',
    mode: 'values',
    values: [['DIHAPUS']],
  })).plan;
  bridge.rejectPlan(plan.id);
  assert.equal(bridge.pendingPlans().length, 0);
  const read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'A1' });
  assert.deepEqual(read.result.values, [['Tanggal']]);
});

test('write_range rejects a matrix that does not match the address', async () => {
  freshBridge();
  const outcome = await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'A1:C1',
    mode: 'values',
    values: [['hanya satu kolom']],
  });
  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /do not match range/);
});

test('write_range rejects a cell count above the limit', async () => {
  freshBridge();
  const values = Array.from({ length: 200 }, () => Array.from({ length: 40 }, () => 1));
  const outcome = await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'A1:AN200',
    mode: 'values',
    values,
  });
  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /above the limit/);
});

test('write_range values mode rejects formulas (formulas mode required)', async () => {
  freshBridge();
  const outcome = await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'H1',
    mode: 'values',
    values: [['=SUM(B2:B4)']],
  });
  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /mode 'formulas'/);
});

test('formulas mode is stored as formulas, not text', async () => {
  freshBridge();
  const plan = (await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'E6',
    mode: 'formulas',
    values: [['=SUM(D2:D5)']],
  })).plan;
  const applied = await bridge.applyPlan(plan.id);
  assert.equal(applied.ok, true);
  const read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'E6' });
  assert.equal(read.result.formulas[0][0], '=SUM(D2:D5)');
});

test('overwriting a filled cell is flagged as destructive', async () => {
  freshBridge();
  const outcome = await bridge.callTool('write_range', {
    sheet: 'Sheet1',
    address: 'A1:A2',
    mode: 'values',
    values: [['Tanggal Baru'], ['Baris baru']],
  });
  assert.equal(outcome.status, 'pending');
  assert.equal(outcome.plan.destructive, true);
  assert.match(outcome.plan.preview.notes.join(' '), /overwritten/);
});

test('delete_rows is destructive and can be undone (inverse + snapshot)', async () => {
  freshBridge();
  const before = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'A2:D3' });

  const outcome = await bridge.callTool('delete_rows', { sheet: 'Sheet1', index: 2, count: 2 });
  assert.equal(outcome.status, 'pending');
  assert.equal(outcome.plan.destructive, true);

  const applied = await bridge.applyPlan(outcome.plan.id);
  assert.equal(applied.ok, true);
  const afterDelete = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'A2:D2' });
  assert.notDeepEqual(afterDelete.result.values, before.result.values);

  const undone = await bridge.undoLast();
  assert.equal(undone.ok, true, undone.error);
  const restored = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'A2:D3' });
  assert.deepEqual(restored.result.values, before.result.values);
});

test('add_worksheet followed by undo deletes that sheet', async () => {
  const api = freshBridge();
  const plan = (await bridge.callTool('add_worksheet', { name: 'Laporan [Maret]' })).plan;
  assert.equal(plan.preview.summary.includes('Laporan Maret'), true);
  await bridge.applyPlan(plan.id);

  let sheets = await api.listSheets();
  assert.ok(sheets.some((s) => s.name === 'Laporan Maret'));

  const undone = await bridge.undoLast();
  assert.equal(undone.ok, true, undone.error);
  sheets = await api.listSheets();
  assert.equal(sheets.some((s) => s.name === 'Laporan Maret'), false);
});

test('rename_worksheet / delete_worksheet are validated', async () => {
  freshBridge();
  const same = await bridge.callTool('rename_worksheet', { sheet: 'Sheet1', newName: 'Sheet1' });
  assert.equal(same.status, 'error');
  assert.match(same.error, /already taken/);

  const missing = await bridge.callTool('rename_worksheet', { sheet: 'TidakAda', newName: 'X' });
  assert.equal(missing.status, 'error');
  assert.match(missing.error, /does not exist/);

  const lastSheet = await bridge.callTool('delete_worksheet', { sheet: 'Sheet1' });
  assert.equal(lastSheet.status, 'error');
  assert.match(lastSheet.error, /only sheet/);
});

test('create_chart is validated and its undo deletes the chart', async () => {
  const api = freshBridge();
  const badType = await bridge.callTool('create_chart', { sheet: 'Sheet1', dataAddress: 'A1:D5', chartType: 'Pie3D' });
  assert.equal(badType.status, 'error');
  assert.match(badType.error, /not supported/);

  const plan = (await bridge.callTool('create_chart', { sheet: 'Sheet1', dataAddress: 'A1:D5', chartType: 'ColumnClustered' })).plan;
  await bridge.applyPlan(plan.id);
  assert.equal((await api.listCharts()).length, 1);

  const undone = await bridge.undoLast();
  assert.equal(undone.ok, true, undone.error);
  assert.equal((await api.listCharts()).length, 0);
});

test('find_replace counts matches and can be undone', async () => {
  freshBridge();
  const outcome = await bridge.callTool('find_replace', { sheet: 'Sheet1', find: 'Kebutuhan', replace: 'Pokok' });
  assert.equal(outcome.status, 'pending');
  assert.ok(outcome.plan.preview.counts.matches >= 2);

  await bridge.applyPlan(outcome.plan.id);
  let read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'C1:C5' });
  assert.ok(read.result.values.flat().includes('Pokok'));

  await bridge.undoLast();
  read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'C1:C5' });
  assert.equal(read.result.values.flat().includes('Kebutuhan'), true);
});

test('format_range and its undo use a format snapshot', async () => {
  freshBridge();
  const plan = (await bridge.callTool('format_range', {
    sheet: 'Sheet1',
    address: 'A1:D1',
    bold: true,
    fillColor: '#FEF3C7',
  })).plan;
  assert.equal(plan.preview.summary.includes('bold'), true);
  const applied = await bridge.applyPlan(plan.id);
  assert.equal(applied.ok, true);
  const undone = await bridge.undoLast();
  assert.equal(undone.ok, true, undone.error);
  assert.ok(undone.performed.includes('restoreFormat'));
});

test('a protected sheet cannot be written to', async () => {
  const api = freshBridge();
  const sheet = api.state.sheets[0];
  sheet.protected = true;
  try {
    const outcome = await bridge.callTool('write_range', {
      sheet: 'Sheet1',
      address: 'A1',
      mode: 'values',
      values: [['x']],
    });
    assert.equal(outcome.status, 'error');
    assert.match(outcome.error, /protected/);
  } finally {
    sheet.protected = false;
  }
});

test('an unknown tool is rejected', async () => {
  freshBridge();
  const outcome = await bridge.callTool('hapus_semua_data', {});
  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /Unknown tool/);
});

test('autoApply applies immediately and still records the journal', async () => {
  freshBridge();
  bridge.setConfig({ autoApply: true });
  try {
    const outcome = await bridge.callTool('write_range', {
      sheet: 'Sheet1',
      address: 'J1',
      mode: 'values',
      values: [['otomatis']],
    });
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.autoApplied, true);
    assert.equal(bridge.history().count, 1);
    const read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'J1' });
    assert.deepEqual(read.result.values, [['otomatis']]);
  } finally {
    bridge.setConfig({ autoApply: false });
  }
});

test('undoAll reverses every change in order', async () => {  freshBridge();
  for (const [address, value] of [['K1', 'satu'], ['K2', 'dua']]) {
    const plan = (await bridge.callTool('write_range', { sheet: 'Sheet1', address, mode: 'values', values: [[value]] })).plan;
    await bridge.applyPlan(plan.id);
  }
  assert.equal(bridge.history().count, 2);

  const outcome = await bridge.undoAll();
  assert.equal(outcome.ok, true, JSON.stringify(outcome.results));
  assert.equal(bridge.history().count, 0);
  const read = await bridge.callTool('read_range', { sheet: 'Sheet1', address: 'K1:K2' });
  assert.deepEqual(read.result.values, [[''], ['']]);
});

test('the id-ID language produces Indonesian labels and summaries', async () => {
  freshBridge();
  DSX.i18n.setLocale('id-ID');
  try {
    const outcome = await bridge.callTool('write_range', {
      sheet: 'Sheet1',
      address: 'L1:L2',
      mode: 'values',
      values: [['a'], ['b']],
    });
    assert.equal(outcome.plan.label, 'Tulis nilai');
    assert.match(outcome.plan.preview.summary, /Menulis 2 sel/);
    assert.match(outcome.plan.preview.rows[0].label, /^Baris 1$/);
  } finally {
    DSX.i18n.setLocale('en-US');
  }
});

test('the en-US language (default) produces English labels and summaries', async () => {
  freshBridge();
  assert.equal(DSX.i18n.getLocale(), 'en-US');
  const outcome = await bridge.callTool('format_range', {
    sheet: 'Sheet1',
    address: 'A1:B1',
    bold: true,
  });
  assert.equal(outcome.plan.label, 'Change formatting');
  assert.match(outcome.plan.preview.summary, /^Format A1:B1 on Sheet1: bold$/);
});
