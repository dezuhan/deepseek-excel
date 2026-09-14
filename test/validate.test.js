'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/js/validate.js');

test('parseAddress: basic forms', () => {
  const single = V.parseAddress('A1');
  assert.equal(single.kind, 'range');
  assert.deepEqual(
    [single.startCol, single.startRow, single.endCol, single.endRow],
    [1, 1, 1, 1],
  );
  assert.equal(single.cellCount, 1);

  const block = V.parseAddress('A1:D20');
  assert.equal(block.rows, 20);
  assert.equal(block.columns, 4);
  assert.equal(block.cellCount, 80);
  assert.equal(block.a1, 'A1:D20');
});

test('parseAddress: absolute, reversed, and lowercase forms are normalized', () => {
  const absolute = V.parseAddress('$B$2:$C$3');
  assert.equal(absolute.a1, 'B2:C3');
  const reversed = V.parseAddress('D20:A1');
  assert.equal(reversed.a1, 'A1:D20');
  const lower = V.parseAddress('b2:c3');
  assert.equal(lower.a1, 'B2:C3');
});

test('parseAddress: sheet-prefixed addresses are cleaned up', () => {
  assert.equal(V.parseAddress('Sheet1!A1:D5').a1, 'A1:D5');
  assert.equal(V.parseAddress("'Nama Sheet'!B2").a1, 'B2');
});

test('parseAddress: whole rows/columns are flagged as unbounded', () => {
  const rows = V.parseAddress('5:7');
  assert.equal(rows.kind, 'rows');
  assert.equal(rows.unbounded, true);
  assert.equal(rows.rows, 3);
  assert.equal(rows.cellCount, 3 * 16384);

  const cols = V.parseAddress('A:C');
  assert.equal(cols.kind, 'cols');
  assert.equal(cols.unbounded, true);
  assert.equal(cols.columns, 3);
});

test('parseAddress: invalid input is rejected', () => {
  for (const bad of ['', '   ', 'A0', 'AAAA1', 'ZZZ1', 'A1:B', '1:A', 'A1:', 'abc', 'A1:D1048577', '1048577:1', null, undefined, 42]) {
    assert.equal(V.parseAddress(bad), null, `seharusnya null: ${String(bad)}`);
  }
});

test('columnToIndex / indexToColumn round-trip', () => {
  assert.equal(V.columnToIndex('A'), 1);
  assert.equal(V.columnToIndex('Z'), 26);
  assert.equal(V.columnToIndex('AA'), 27);
  assert.equal(V.columnToIndex('XFD'), 16384);
  assert.equal(V.indexToColumn(1), 'A');
  assert.equal(V.indexToColumn(26), 'Z');
  assert.equal(V.indexToColumn(27), 'AA');
  assert.equal(V.indexToColumn(16384), 'XFD');
  assert.equal(V.indexToColumn(0), '');
});

test('validateMatrix: dimensions must match', () => {
  const ok = V.validateMatrix([[1, 2], [3, 4]], 'A1:B2');
  assert.equal(ok.ok, true);
  assert.equal(ok.cellCount, 4);

  const mismatch = V.validateMatrix([[1, 2]], 'A1:B2');
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /do not match range/);

  const ragged = V.validateMatrix([[1, 2], [3]], 'A1:B2');
  assert.equal(ragged.ok, false);
  assert.match(ragged.error, /not rectangular/);

  const notArray = V.validateMatrix('bukan array', 'A1:B2');
  assert.equal(notArray.ok, false);

  const empty = V.validateMatrix([], 'A1:B2');
  assert.equal(empty.ok, false);
});

test('validateMatrix: a whole-row address only matches the row count', () => {
  const rows = V.validateMatrix([[1], [2]], '3:4');
  assert.equal(rows.ok, true);
  const wrongRows = V.validateMatrix([[1]], '3:4');
  assert.equal(wrongRows.ok, false);
});

test('sanitizeSheetName cleans up forbidden names', () => {
  assert.equal(V.sanitizeSheetName('Laporan [2026]'), 'Laporan 2026');
  assert.equal(V.sanitizeSheetName("'Data'"), 'Data');
  assert.equal(V.sanitizeSheetName('a/b\\c:d*e?f'), 'a b c d e f');
  assert.equal(V.sanitizeSheetName('x'.repeat(40)).length, 31);
  assert.equal(V.sanitizeSheetName('   '), '');
});

test('small helpers: isFormula, isBlank, hexColor, clampNumber', () => {
  assert.equal(V.isFormula(' =SUM(A1:A2)'), true);
  assert.equal(V.isFormula('teks = bukan formula'), false);
  assert.equal(V.isBlank(''), true);
  assert.equal(V.isBlank(null), true);
  assert.equal(V.isBlank(0), false);
  assert.equal(V.hexColor('#1f2937'), '#1F2937');
  assert.equal(V.hexColor('1f2937'), '#1F2937');
  assert.equal(V.hexColor('merah'), null);
  assert.equal(V.clampNumber(99, 1, 10, 5), 10);
  assert.equal(V.clampNumber('x', 1, 10, 5), 5);
});
