/**
 * Mock API with an interface identical to office-api.js, but its data lives in memory.
 * Used to develop/test the UI without Excel: open
 *   https://localhost:3000/taskpane.html?mock=1
 * in Edge/Chrome.
 */
(function (global) {
  'use strict';

  const V = global.DSX.validate;

  function t(key, params) {
    const i18n = global.DSX && global.DSX.i18n;
    return i18n ? i18n.t(key, params) : key;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms || 40));
  }

  function key(row, col) {
    return `${row},${col}`;
  }

  function createState() {
    const sheet1 = {
      name: 'Sheet1',
      position: 0,
      cells: new Map(),
      formats: new Map(),
      tables: [],
      charts: [],
      protected: false,
      autoFilter: null,
      conditionalFormats: [],
    };
    const seed = [
      ['Tanggal', 'Keterangan', 'Kategori', 'Jumlah'],
      ['01/03/2026', 'Gaji', 'Pemasukan', 7500000],
      ['03/03/2026', 'Belanja bulanan', 'Kebutuhan', 1850000],
      ['05/03/2026', 'Transport', 'Kebutuhan', 420000],
      ['10/03/2026', 'Kopi & jajan', 'Gaya hidup', 265000],
    ];
    seed.forEach((row, r) => row.forEach((value, c) => sheet1.cells.set(key(r, c), { value })));
    return {
      title: 'Mock Workbook (UI test mode)',
      sheets: [sheet1],
      activeSheet: 'Sheet1',
      selection: 'A1:D5',
      settings: new Map(),
    };
  }

  const state = createState();

  function sheetByName(name) {
    const wanted = String(name || '').trim().toLowerCase();
    const found = state.sheets.find((s) => s.name.toLowerCase() === wanted);
    if (!found) {
      throw new Error(t('api.err.sheetMissing', { name, sheets: state.sheets.map((s) => s.name).join(', ') }));
    }
    return found;
  }

  function activeSheet() {
    return sheetByName(state.activeSheet);
  }

  function getCell(sheet, row, col) {
    return sheet.cells.get(key(row, col)) || null;
  }

  function setCell(sheet, row, col, cell) {
    if (cell === null || cell === undefined) sheet.cells.delete(key(row, col));
    else sheet.cells.set(key(row, col), cell);
  }

  function rectAddress(parsed) {
    if (!parsed) throw new Error(t('validate.invalidAddress', { address: '' }));
    return parsed.text;
  }

  function matrixFromRange(sheet, parsed) {
    const values = [];
    const formulas = [];
    const numberFormat = [];
    for (let r = parsed.startRow; r <= parsed.endRow; r++) {
      const vRow = [];
      const fRow = [];
      const nRow = [];
      for (let c = parsed.startCol; c <= parsed.endCol; c++) {
        const cell = getCell(sheet, r - 1, c - 1);
        vRow.push(cell ? (cell.formula !== undefined ? cell.value : cell.value ?? '') : '');
        fRow.push(cell && cell.formula ? cell.formula : '');
        nRow.push(cell && cell.numberFormat ? cell.numberFormat : 'General');
      }
      values.push(vRow);
      formulas.push(fRow);
      numberFormat.push(nRow);
    }
    return { values, formulas, numberFormat };
  }

  function usedRange(sheet) {
    if (!sheet.cells.size) return null;
    let maxRow = 0;
    let maxCol = 0;
    for (const k of sheet.cells.keys()) {
      const [r, c] = k.split(',').map(Number);
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }
    return V.parseAddress(`A1:${V.indexToColumn(maxCol + 1)}${maxRow + 1}`);
  }

  function countNonEmpty(sheet, parsed) {
    let count = 0;
    for (let r = parsed.startRow; r <= parsed.endRow; r++) {
      for (let c = parsed.startCol; c <= parsed.endCol; c++) {
        const cell = getCell(sheet, r - 1, c - 1);
        if (cell && cell.value !== '' && cell.value !== undefined && cell.value !== null) count++;
      }
    }
    return count;
  }

  const api = {
    kind: 'mock',
    state,

    supports() {
      return true;
    },

    async getWorkbookName() {
      await sleep();
      return state.title;
    },

    async overview(options) {
      await sleep();
      const sampleRows = V.clampNumber(options && options.includeSampleRows, 0, 5, 3);
      return {
        workbook: state.title,
        activeSheet: state.activeSheet,
        selection: state.selection,
        sheetCount: state.sheets.length,
        sheets: state.sheets.map((sheet) => {
          const used = usedRange(sheet);
          const entry = {
            name: sheet.name,
            position: sheet.position,
            tables: sheet.tables.map((t) => t.name),
            charts: sheet.charts.map((c) => ({ name: c.name, type: c.type })),
            usedRange: used ? used.text : null,
            rowCount: used ? used.rows : 0,
            columnCount: used ? used.columns : 0,
          };
          if (used && sampleRows > 0) {
            const head = matrixFromRange(sheet, used).values.slice(0, sampleRows + 1);
            entry.headers = head[0] || [];
            entry.sample = head.slice(1);
          }
          return entry;
        }),
      };
    },

    async readRange(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      if (!parsed) throw new Error(t('api.err.invalidAddress', { address: params.address }));
      let effective = parsed;
      let truncated = false;
      if (parsed.unbounded) {
        const used = usedRange(sheet);
        if (!used) return { sheet: sheet.name, address: parsed.text, values: [], truncated: false, note: t('api.err.emptyRange') };
        effective = used;
      }
      const maxCells = V.clampNumber(params.maxCells, 10, 50000, 2000);
      if (effective.cellCount > maxCells) {
        const rows = Math.max(1, Math.floor(maxCells / effective.columns));
        const endRow = Math.min(effective.startRow + rows - 1, effective.endRow);
        effective = V.parseAddress(
          `${V.indexToColumn(effective.startCol)}${effective.startRow}:${V.indexToColumn(effective.endCol)}${endRow}`,
        );
        truncated = true;
      }
      const data = matrixFromRange(sheet, effective);
      return {
        sheet: sheet.name,
        address: effective.text,
        requestedAddress: parsed.text,
        rows: data.values.length,
        columns: data.values[0] ? data.values[0].length : 0,
        values: data.values,
        formulas: params.includeFormulas === false ? undefined : data.formulas,
        numberFormat: data.numberFormat,
        truncated,
        note: truncated ? 'Only part of the data was read (mock mode).' : undefined,
      };
    },

    async getTables(params) {
      await sleep();
      const sheets = params && params.sheet ? [sheetByName(params.sheet)] : state.sheets;
      return sheets.flatMap((sheet) =>
        sheet.tables.map((t) => ({
          name: t.name,
          sheet: sheet.name,
          address: t.address,
          rowCount: t.rows,
          dataRows: Math.max(t.rows - (t.hasHeaders ? 1 : 0), 0),
          columnCount: t.columns,
        })),
      );
    },

    async listCharts(params) {
      await sleep();
      const sheets = params && params.sheet ? [sheetByName(params.sheet)] : state.sheets;
      return sheets.flatMap((sheet) => sheet.charts.map((c) => ({ name: c.name, sheet: sheet.name, type: c.type })));
    },

    async listNamedRanges() {
      await sleep();
      return [];
    },

    async listSheets() {
      await sleep();
      return state.sheets.map((s) => ({ name: s.name, position: s.position }));
    },

    /** Document settings stub so per-file personalization can be exercised in mock mode. */
    async getSetting(key) {
      await sleep();
      return state.settings.has(key) ? state.settings.get(key) : null;
    },

    async setSetting(params) {
      await sleep();
      if (params.value === null || params.value === undefined) state.settings.delete(params.key);
      else state.settings.set(params.key, params.value);
      return true;
    },

    async writeRange(params) {
      await sleep();
      const check = V.validateMatrix(params.values, params.address);
      if (!check.ok) throw new Error(check.error);
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      for (let r = 0; r < params.values.length; r++) {
        for (let c = 0; c < params.values[r].length; c++) {
          const raw = params.values[r][c];
          const cell = {};
          if (params.mode === 'formulas' && V.isFormula(raw)) {
            cell.formula = raw;
            cell.value = `«hasil ${raw}»`;
          } else {
            cell.value = raw;
          }
          if (params.numberFormat) cell.numberFormat = params.numberFormat;
          setCell(sheet, parsed.startRow - 1 + r, parsed.startCol - 1 + c, cell);
        }
      }
      return { sheet: sheet.name, address: parsed.text, cells: check.cellCount, mode: params.mode };
    },

    async writeTableRows(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const table = sheet.tables.find((t) => t.name === params.tableName);
      if (!table) throw new Error(t('api.err.tableMissingMock', { table: params.tableName }));
      const parsed = V.parseAddress(table.address);
      const startRow = parsed.startRow + (table.hasHeaders ? 1 : 0) + (params.append === false ? 0 : table.rows);
      params.rows.forEach((row, r) => {
        row.forEach((value, c) => setCell(sheet, startRow - 1 + r, parsed.startCol - 1 + c, { value }));
      });
      table.rows += params.rows.length;
      return { sheet: sheet.name, table: table.name, rows: params.rows.length, appended: params.append !== false };
    },

    async formatRange(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      if (!parsed) throw new Error(t('api.err.invalidAddress', { address: params.address }));
      for (let r = parsed.startRow; r <= parsed.endRow; r++) {
        for (let c = parsed.startCol; c <= parsed.endCol; c++) {
          const current = sheet.formats.get(key(r - 1, c - 1)) || {};
          sheet.formats.set(key(r - 1, c - 1), { ...current, ...params });
        }
      }
      return { sheet: sheet.name, address: parsed.text, applied: Object.keys(params).filter((k) => !['sheet', 'address'].includes(k)) };
    },

    async clearRange(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.rangeRequired', { tool: 'clear_range' }));
      for (let r = parsed.startRow; r <= parsed.endRow; r++) {
        for (let c = parsed.startCol; c <= parsed.endCol; c++) {
          if (params.applyTo !== 'formats') sheet.cells.delete(key(r - 1, c - 1));
          if (params.applyTo !== 'contents') sheet.formats.delete(key(r - 1, c - 1));
        }
      }
      return { sheet: sheet.name, address: parsed.text, applyTo: params.applyTo || 'all' };
    },

    async autofitColumns(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      return { sheet: sheet.name, address: params.address || (usedRange(sheet) || {}).text || '' };
    },

    async insertRows(params) {
      return mockStructural('insert', 'row', params);
    },
    async deleteRows(params) {
      return mockStructural('delete', 'row', params);
    },
    async insertColumns(params) {
      return mockStructural('insert', 'column', params);
    },
    async deleteColumns(params) {
      return mockStructural('delete', 'column', params);
    },

    async addWorksheet(params) {
      await sleep();
      const name = V.sanitizeSheetName(params.name);
      if (!name) throw new Error(t('api.err.nameInvalid'));
      if (state.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(t('api.err.sheetExists', { name }));
      }
      const sheet = { name, position: state.sheets.length, cells: new Map(), formats: new Map(), tables: [], charts: [], protected: false };
      if (params.position === undefined) state.sheets.push(sheet);
      else state.sheets.splice(params.position, 0, sheet);
      state.sheets.forEach((s, i) => { s.position = i; });
      if (params.activate) state.activeSheet = name;
      return { sheet: name, position: sheet.position };
    },

    async renameWorksheet(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const newName = V.sanitizeSheetName(params.newName);
      if (!newName) throw new Error(t('api.err.nameInvalid'));
      const old = sheet.name;
      sheet.name = newName;
      if (state.activeSheet === old) state.activeSheet = newName;
      return { from: old, to: newName };
    },

    async deleteWorksheet(params) {
      await sleep();
      if (state.sheets.length <= 1) throw new Error(t('api.err.lastSheet'));
      const sheet = sheetByName(params.sheet);
      state.sheets = state.sheets.filter((s) => s !== sheet);
      state.sheets.forEach((s, i) => { s.position = i; });
      if (state.activeSheet === sheet.name) state.activeSheet = state.sheets[0].name;
      return { deleted: sheet.name };
    },

    async sortRange(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.rangeRequired', { tool: 'sort_range' }));
      const data = matrixFromRange(sheet, parsed).values;
      const header = params.hasHeader ? data.shift() : null;
      const keyIndex = V.clampNumber(params.keyColumnIndex, 0, parsed.columns - 1, 0);
      const dir = params.ascending === false ? -1 : 1;
      data.sort((a, b) => {
        const av = a[keyIndex];
        const bv = b[keyIndex];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
      const final = header ? [header, ...data] : data;
      final.forEach((row, r) =>
        row.forEach((value, c) => setCell(sheet, parsed.startRow - 1 + r, parsed.startCol - 1 + c, { value })),
      );
      return { sheet: sheet.name, address: parsed.text, keyColumnIndex: keyIndex, ascending: params.ascending !== false };
    },

    async createTable(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      const used = usedRange(sheet);
      const name = params.name || `Tabel${sheet.tables.length + 1}`;
      sheet.tables.push({
        name,
        address: parsed.text,
        rows: parsed.rows,
        columns: parsed.columns,
        hasHeaders: params.hasHeaders !== false,
      });
      if (used) sheet.autoFilter = parsed.text;
      return { sheet: sheet.name, table: name, address: parsed.text };
    },

    async createChart(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const name = `Chart${sheet.charts.length + 1}`;
      sheet.charts.push({ name, type: params.chartType, source: params.dataAddress });
      return { sheet: sheet.name, chart: name, type: params.chartType, source: params.dataAddress };
    },

    async applyAutofilter(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      sheet.autoFilter = params.address;
      return { sheet: sheet.name, address: params.address, note: t('api.err.autofilterAppliedMock') };
    },

    async conditionalFormat(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      sheet.conditionalFormats.push(params);
      return { sheet: sheet.name, address: params.address, type: params.type };
    },

    async findReplace(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const used = usedRange(sheet);
      if (!used) return { sheet: sheet.name, replaced: 0 };
      let replaced = 0;
      for (let r = used.startRow; r <= used.endRow; r++) {
        for (let c = used.startCol; c <= used.endCol; c++) {
          const cell = getCell(sheet, r - 1, c - 1);
          if (!cell || typeof cell.value !== 'string') continue;
          const hay = params.matchCase ? cell.value : cell.value.toLowerCase();
          const needle = params.matchCase ? params.find : String(params.find).toLowerCase();
          if (hay.includes(needle)) {
            replaced++;
            cell.value = params.matchEntireCell
              ? params.replace
              : cell.value.replace(new RegExp(params.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), params.matchCase ? 'g' : 'gi'), params.replace);
          }
        }
      }
      return { sheet: sheet.name, address: used.text, replaced };
    },

    async selectRange(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      state.activeSheet = sheet.name;
      state.selection = params.address;
      return { sheet: sheet.name, address: params.address, selected: true };
    },

    async captureSnapshot(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) return null;
      const data = matrixFromRange(sheet, parsed);
      return {
        sheet: sheet.name,
        address: parsed.text,
        rows: parsed.rows,
        columns: parsed.columns,
        values: data.values,
        formulas: data.formulas,
        numberFormat: data.numberFormat,
      };
    },

    async restoreSnapshot(snapshot) {
      await sleep();
      const sheet = sheetByName(snapshot.sheet);
      const parsed = V.parseAddress(snapshot.address);
      let formulaCells = 0;
      snapshot.values.forEach((row, r) =>
        row.forEach((value, c) => {
          const f = snapshot.formulas[r] ? snapshot.formulas[r][c] : '';
          const cell = { value };
          if (typeof f === 'string' && f.startsWith('=')) {
            cell.formula = f;
            formulaCells++;
          }
          if (snapshot.numberFormat && snapshot.numberFormat[r]) cell.numberFormat = snapshot.numberFormat[r][c];
          setCell(sheet, parsed.startRow - 1 + r, parsed.startCol - 1 + c, cell);
        }),
      );
      return { sheet: snapshot.sheet, address: snapshot.address, formulaCells };
    },

    async isWritable(sheetName) {
      await sleep();
      return !sheetByName(sheetName).protected;
    },

    async countNonEmpty(sheetName, address) {
      await sleep();
      const sheet = sheetByName(sheetName);
      const parsed = V.parseAddress(address);
      return parsed ? countNonEmpty(sheet, parsed) : 0;
    },

    async usedRangeAddress(sheetName) {
      await sleep();
      const used = usedRange(sheetByName(sheetName));
      return used ? { address: used.text, rows: used.rows, columns: used.columns } : null;
    },

    async captureFormat(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) return null;
      return {
        sheet: sheet.name,
        address: parsed.text,
        format: { numberFormat: matrixFromRange(sheet, parsed).numberFormat },
      };
    },

    async restoreFormat(snapshot) {
      await sleep();
      if (!snapshot) return null;
      const sheet = sheetByName(snapshot.sheet);
      const parsed = V.parseAddress(snapshot.address);
      for (let r = parsed.startRow; r <= parsed.endRow; r++) {
        for (let c = parsed.startCol; c <= parsed.endCol; c++) {
          const current = sheet.formats.get(key(r - 1, c - 1)) || {};
          sheet.formats.set(key(r - 1, c - 1), { ...current });
        }
      }
      return { sheet: snapshot.sheet, address: snapshot.address, skipped: [] };
    },

    async removeLastTable(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const table = sheet.tables.pop();
      if (!table) throw new Error(t('api.err.noTableToUndo'));
      return { sheet: sheet.name, table: table.name, convertedToRange: true };
    },

    async deleteLastChart(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const chart = sheet.charts.pop();
      if (!chart) throw new Error(t('api.err.noChartToUndo'));
      return { sheet: sheet.name, deletedChart: chart.name };
    },

    async removeAutofilter(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      sheet.autoFilter = null;
      return { sheet: sheet.name, autofilterRemoved: true };
    },

    async undoLastConditionalFormat(params) {
      await sleep();
      const sheet = sheetByName(params.sheet);
      const removed = sheet.conditionalFormats.pop();
      if (!removed) throw new Error(t('api.err.noConditionalToUndo'));
      return { sheet: sheet.name, address: params.address, removed: true };
    },
  };

  async function mockStructural(action, axis, params) {
    await sleep();
    const sheet = sheetByName(params.sheet);
    const index = V.clampNumber(params.index, 1, V.MAX_ROW, 1);
    const count = V.clampNumber(params.count, 1, 1000, 1);
    const next = new Map();
    for (const [k, cell] of sheet.cells.entries()) {
      let [r, c] = k.split(',').map(Number);
      const pos1 = (axis === 'row' ? r : c) + 1;
      if (action === 'insert') {
        if (pos1 >= index) {
          if (axis === 'row') r += count;
          else c += count;
        }
      } else if (pos1 >= index && pos1 < index + count) {
        continue; // deleted row/column
      } else if (pos1 >= index + count) {
        if (axis === 'row') r -= count;
        else c -= count;
      }
      next.set(key(r, c), cell);
    }
    sheet.cells = next;
    return { sheet: sheet.name, action, axis, index, count };
  }

  global.DSX = global.DSX || {};
  global.DSX.mockApi = api;
})(typeof self !== 'undefined' ? self : this);
