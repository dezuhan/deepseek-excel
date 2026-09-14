/**
 * A1 address validation + value matrix. Runs in the browser (window.DSX.validate)
 * as well as in Node (require) so it can be tested automatically without Excel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.DSX = root.DSX || {};
    root.DSX.validate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_ROW = 1048576;
  const MAX_COL = 16384;

  /** Get the i18n dictionary (browser: DSX.i18n; Node: require('./i18n.js')). */
  function i18nOrNull() {
    if (typeof self !== 'undefined' && self.DSX && self.DSX.i18n) return self.DSX.i18n;
    if (typeof globalThis !== 'undefined' && globalThis.DSX && globalThis.DSX.i18n) return globalThis.DSX.i18n;
    if (typeof require === 'function') {
      try {
        return require('./i18n.js');
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  function msg(key, params) {
    const i18n = i18nOrNull();
    return i18n ? i18n.t(key, params) : key;
  }

  function columnToIndex(letters) {
    let n = 0;
    for (const ch of String(letters).toUpperCase()) {
      const code = ch.charCodeAt(0);
      if (code < 65 || code > 90) return -1;
      n = n * 26 + (code - 64);
    }
    return n;
  }

  function indexToColumn(index) {
    let n = Number(index);
    if (!Number.isInteger(n) || n < 1 || n > MAX_COL) return '';
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  /**
   * Parse an A1 address. Returns null when it is not valid.
   * Supports: 'A1', 'A1:D20', '5:7' (whole rows), 'A:C' (whole columns),
   * with or without '$'. A sheet name is NOT accepted here (it uses a separate parameter).
   */
  function parseAddress(address) {
    if (typeof address !== 'string') return null;
    let raw = address.trim();
    // Tolerance for sheet-prefixed addresses from Excel.js ("Sheet1!A1:D5", "'Sheet Name'!A1").
    const bang = raw.lastIndexOf('!');
    if (bang >= 0) raw = raw.slice(bang + 1);
    const text = raw.toUpperCase().replace(/\$/g, '');
    if (!text) return null;

    let m = /^([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?$/.exec(text);
    if (m) {
      const startCol = columnToIndex(m[1]);
      const startRow = Number(m[2]);
      const endCol = m[3] ? columnToIndex(m[3]) : startCol;
      const endRow = m[4] ? Number(m[4]) : startRow;
      if (startCol < 1 || endCol < 1 || startCol > MAX_COL || endCol > MAX_COL) return null;
      if (startRow < 1 || endRow < 1 || startRow > MAX_ROW || endRow > MAX_ROW) return null;
      return makeRect('range', startCol, startRow, endCol, endRow, text);
    }

    m = /^(\d{1,7}):(\d{1,7})$/.exec(text);
    if (m) {
      const startRow = Number(m[1]);
      const endRow = Number(m[2]);
      if (startRow < 1 || endRow < 1 || startRow > MAX_ROW || endRow > MAX_ROW) return null;
      const rect = makeRect('rows', 1, startRow, MAX_COL, endRow, text);
      rect.unbounded = true;
      return rect;
    }

    m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(text);
    if (m) {
      const startCol = columnToIndex(m[1]);
      const endCol = columnToIndex(m[2]);
      if (startCol < 1 || endCol < 1 || startCol > MAX_COL || endCol > MAX_COL) return null;
      const rect = makeRect('cols', startCol, 1, endCol, MAX_ROW, text);
      rect.unbounded = true;
      return rect;
    }

    return null;
  }

  function makeRect(kind, c1, r1, c2, r2, text) {
    const startCol = Math.min(c1, c2);
    const endCol = Math.max(c1, c2);
    const startRow = Math.min(r1, r2);
    const endRow = Math.max(r1, r2);
    const startA1 = `${indexToColumn(startCol)}${startRow}`;
    const endA1 = `${indexToColumn(endCol)}${endRow}`;
    return {
      kind,
      text,
      startCol,
      startRow,
      endCol,
      endRow,
      rows: endRow - startRow + 1,
      columns: endCol - startCol + 1,
      cellCount: (endRow - startRow + 1) * (endCol - startCol + 1),
      unbounded: false,
      a1: startA1 === endA1 ? startA1 : `${startA1}:${endA1}`,
    };
  }

  /** Reasonable maximum size for a write operation (used for the capacity check). */
  function totalSheetCells() {
    return MAX_ROW * MAX_COL;
  }

  function isFormula(value) {
    return typeof value === 'string' && value.trim().startsWith('=');
  }

  function isBlank(value) {
    return value === null || value === undefined || value === '';
  }

  /**
   * Ensure a 2D matrix matches the dimensions of the address.
   * For an exact 'range' address the dimensions must match precisely.
   */
  function validateMatrix(rawValues, address) {
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      return { ok: false, error: msg('validate.notArray') };
    }
    for (const [i, row] of rawValues.entries()) {
      if (!Array.isArray(row)) return { ok: false, error: msg('validate.rowNotArray', { row: i + 1 }) };
    }
    const parsed = parseAddress(address);
    if (!parsed) return { ok: false, error: msg('validate.invalidAddress', { address }) };

    const rows = rawValues.length;
    const cols = Math.max(...rawValues.map((r) => r.length));
    const ragged = rawValues.some((r) => r.length !== cols);
    if (ragged) {
      return { ok: false, error: msg('validate.ragged', { columns: cols }) };
    }
    if (parsed.kind === 'range') {
      if (rows !== parsed.rows || cols !== parsed.columns) {
        return {
          ok: false,
          error: msg('validate.dimensionMismatch', {
            rows,
            columns: cols,
            range: parsed.text,
            expectedRows: parsed.rows,
            expectedColumns: parsed.columns,
          }),
        };
      }
    } else if (parsed.kind === 'rows') {
      if (rows !== parsed.rows) {
        return {
          ok: false,
          error: msg('validate.rowCountMismatch', { rows, range: parsed.text, expected: parsed.rows }),
        };
      }
    } else if (cols !== parsed.columns) {
      return {
        ok: false,
        error: msg('validate.columnCountMismatch', { columns: cols, range: parsed.text, expected: parsed.columns }),
      };
    }
    return { ok: true, rows, columns: cols, cellCount: rows * cols };
  }

  /** A sheet name that is safe for Excel. */
  function sanitizeSheetName(name) {
    if (typeof name !== 'string') return '';
    let clean = name.trim().replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    clean = clean.replace(/^'+|'+$/g, '').replace(/'{2,}/g, "'").trim();
    if (clean.length > 31) clean = clean.slice(0, 31).trim();
    return clean;
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function hexColor(value) {
    if (typeof value !== 'string') return null;
    const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    return m ? `#${m[1].toUpperCase()}` : null;
  }

  /** Summarize a matrix for a UI preview without flooding the DOM. */
  function summarizeMatrix(values, maxRows) {
    const limit = maxRows || 8;
    const rows = values || [];
    return {
      totalRows: rows.length,
      columns: rows.length ? Math.max(...rows.map((r) => r.length)) : 0,
      sample: rows.slice(0, limit),
      truncated: rows.length > limit,
    };
  }

  return {
    MAX_ROW,
    MAX_COL,
    columnToIndex,
    indexToColumn,
    parseAddress,
    totalSheetCells,
    isFormula,
    isBlank,
    validateMatrix,
    sanitizeSheetName,
    clampNumber,
    hexColor,
    summarizeMatrix,
  };
});
