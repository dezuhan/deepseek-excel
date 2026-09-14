/**
 * Real implementation of the high-level API on top of Office.js (Excel.run).
 * Every Excel operation in this app goes through this file; the bridge only calls
 * methods here, so the mock version (mock-api.js) can replace it.
 */
(function (global) {
  'use strict';

  const V = global.DSX.validate;

  function t(key, params) {
    const i18n = global.DSX && global.DSX.i18n;
    return i18n ? i18n.t(key, params) : key;
  }

  function friendly(err) {
    const code = err && (err.code || err.name);
    const message = (err && err.message) || String(err);
    switch (code) {
      case 'ItemNotFound':
        return new Error(t('api.err.itemNotFound'));
      case 'AccessDenied':
        return new Error(t('api.err.accessDenied'));
      case 'InvalidArgument':
      case 'InvalidReference':
        return new Error(t('api.err.invalidArg', { message }));
      case 'GeneralException':
        return new Error(t('api.err.general', { message }));
      default:
        return new Error(message);
    }
  }

  function clean(value) {
    return value === undefined || value === null ? '' : value;
  }

  function cleanMatrix(matrix) {
    return (matrix || []).map((row) => (row || []).map(clean));
  }

  function fillMatrix(rows, columns, value) {
    return Array.from({ length: rows }, () => Array.from({ length: columns }, () => value));
  }

  /** Excel.js returns sheet-prefixed addresses ("Sheet1!A1:D5"); strip the prefix. */
  function strip(address) {
    const text = address === undefined || address === null ? '' : String(address);
    const bang = text.lastIndexOf('!');
    return bang >= 0 ? text.slice(bang + 1) : text;
  }

  async function sheetsOf(context) {
    const sheets = context.workbook.worksheets;
    sheets.load('items/name,items/position');
    await context.sync();
    return sheets;
  }

  async function requireSheet(context, name) {
    const sheets = await sheetsOf(context);
    if (!name) return sheets.getActiveWorksheet();
    const wanted = String(name).trim().toLowerCase();
    const found = sheets.items.find((s) => s.name.toLowerCase() === wanted);
    if (!found) {
      throw new Error(t('api.err.sheetMissing', {
        name,
        sheets: sheets.items.map((s) => s.name).join(', '),
      }));
    }
    return found;
  }

  async function ensureWriteAllowed(context, sheet) {
    sheet.protection.load('protected');
    await context.sync();
    if (sheet.protection.protected) {
      throw new Error(t('api.err.sheetProtected', { name: sheet.name }));
    }
  }

  function wrap(fn) {
    return async function wrapped(...args) {
      try {
        return await fn.apply(null, args);
      } catch (err) {
        throw friendly(err);
      }
    };
  }

  const api = {
    kind: 'office',

    supports(set, version) {
      try {
        return typeof Office !== 'undefined' && Office.context && Office.context.requirements
          ? Office.context.requirements.isSetSupported(set, version)
          : false;
      } catch (err) {
        return false;
      }
    },

    getWorkbookName: wrap(async () => {
      return Excel.run(async (context) => {
        const props = context.workbook.properties;
        props.load('title');
        await context.sync();
        return props.title || '(workbook tanpa judul)';
      });
    }),

    overview: wrap(async (options) => {
      const sampleRows = V.clampNumber(options && options.includeSampleRows, 0, 5, 3);
      return Excel.run(async (context) => {
        const sheets = await sheetsOf(context);
        const active = sheets.getActiveWorksheet();
        active.load('name');
        const selection = context.workbook.getSelectedRange();
        selection.load('address');
        const props = context.workbook.properties;
        props.load('title');

        const usedRanges = sheets.items.map((sheet) => sheet.getUsedRangeOrNullObject());
        usedRanges.forEach((range) => range.load('address,rowCount,columnCount,isNullObject'));
        const tableTitles = sheets.items.map((sheet) => {
          const tables = sheet.tables;
          tables.load('items/name');
          return tables;
        });
        const chartTitles = sheets.items.map((sheet) => {
          const charts = sheet.charts;
          charts.load('items/name,items/chartType');
          return charts;
        });
        await context.sync();

        const result = {
          workbook: props.title || '(tanpa judul)',
          activeSheet: active.name,
          selection: selection.address || '',
          sheetCount: sheets.items.length,
          sheets: [],
        };

        for (const [i, sheet] of sheets.items.entries()) {
          const used = usedRanges[i];
          const entry = {
            name: sheet.name,
            position: sheet.position,
            tables: tableTitles[i].items.map((t) => t.name),
            charts: chartTitles[i].items.map((c) => ({ name: c.name, type: c.chartType })),
            usedRange: null,
            rowCount: 0,
            columnCount: 0,
          };
          if (!used.isNullObject) {
            entry.usedRange = strip(used.address);
            entry.rowCount = used.rowCount;
            entry.columnCount = used.columnCount;
            if (sampleRows > 0) {
              const columns = Math.min(used.columnCount, 12);
              const rows = Math.min(used.rowCount, sampleRows + 1);
              const head = used.getCell(0, 0).getResizedRange(rows - 1, columns - 1);
              head.load('values');
              await context.sync();
              const values = cleanMatrix(head.values);
              entry.headers = values[0] || [];
              entry.sample = values.slice(1);
            }
          }
          result.sheets.push(entry);
        }
        return result;
      });
    }),

    readRange: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed) throw new Error(t('api.err.invalidAddress', { address: params.address }));
      const maxCells = V.clampNumber(params.maxCells, 10, 50000, 2000);
      const includeFormulas = params.includeFormulas !== false;

      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const target = parsed.unbounded
          ? sheet.getUsedRangeOrNullObject()
          : sheet.getRange(parsed.text);
        if (parsed.unbounded) {
          target.load('address,rowCount,columnCount,isNullObject');
          await context.sync();
          if (target.isNullObject) {
            return { sheet: sheet.name, address: parsed.text, values: [], formulas: [], truncated: false, note: t('api.err.emptyRange') };
          }
        } else {
          target.load('rowCount,columnCount');
          await context.sync();
        }

        let truncated = false;
        let effective = target;
        const totalCells = target.rowCount * target.columnCount;
        if (totalCells > maxCells) {
          const columns = Math.max(target.columnCount, 1);
          const rows = Math.max(1, Math.floor(maxCells / columns));
          effective = target.getCell(0, 0).getResizedRange(Math.min(rows, target.rowCount) - 1, columns - 1);
          truncated = true;
        }
        effective.load('address,values,numberFormat');
        if (includeFormulas) effective.load('formulas');
        await context.sync();

        return {
          sheet: sheet.name,
          address: strip(effective.address),
          requestedAddress: parsed.text,
          rows: effective.values.length,
          columns: effective.values[0] ? effective.values[0].length : 0,
          values: cleanMatrix(effective.values),
          formulas: includeFormulas ? cleanMatrix(effective.formulas) : undefined,
          numberFormat: effective.numberFormat,
          truncated,
          note: truncated
            ? t('api.err.truncated', { range: parsed.text, cells: totalCells })
            : undefined,
        };
      });
    }),

    getTables: wrap(async (params) => {
      return Excel.run(async (context) => {
        const sheets = await sheetsOf(context);
        const targets = params && params.sheet
          ? [await requireSheet(context, params.sheet)]
          : sheets.items;
        const tables = targets.map((sheet) => {
          const collection = sheet.tables;
          collection.load('items/name,items/showHeaders,items/style');
          return collection;
        });
        await context.sync();
        const out = [];
        for (const [i, collection] of tables.entries()) {
          for (const table of collection.items) {
            const range = table.getRange();
            const body = table.getDataBodyRange();
            range.load('address,rowCount,columnCount');
            body.load('rowCount,isNullObject');
            await context.sync();
            out.push({
              name: table.name,
              sheet: targets[i].name,
              address: strip(range.address),
              headerRow: table.showHeaders ? range.rowCount - (body.isNullObject ? 0 : body.rowCount) : 0,
              rowCount: range.rowCount,
              dataRows: body.isNullObject ? 0 : body.rowCount,
              columnCount: range.columnCount,
            });
          }
        }
        return out;
      });
    }),

    listCharts: wrap(async (params) => {
      return Excel.run(async (context) => {
        const sheets = await sheetsOf(context);
        const targets = params && params.sheet ? [await requireSheet(context, params.sheet)] : sheets.items;
        const collections = targets.map((sheet) => {
          const charts = sheet.charts;
          charts.load('items/name,items/chartType,items/top,items/left,items/width,items/height');
          return charts;
        });
        await context.sync();
        const out = [];
        for (const [i, collection] of collections.entries()) {
          for (const chart of collection.items) {
            out.push({
              name: chart.name,
              sheet: targets[i].name,
              type: chart.chartType,
              top: chart.top,
              left: chart.left,
              width: chart.width,
              height: chart.height,
            });
          }
        }
        return out;
      });
    }),

    listNamedRanges: wrap(async () => {
      return Excel.run(async (context) => {
        const names = context.workbook.names;
        names.load('items/name,items/formula');
        await context.sync();
        return names.items.map((n) => ({ name: n.name, formula: n.formula }));
      });
    }),

    writeRange: wrap(async (params) => {
      const check = V.validateMatrix(params.values, params.address);
      if (!check.ok) throw new Error(check.error);
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        await ensureWriteAllowed(context, sheet);
        const range = sheet.getRange(V.parseAddress(params.address).text);
        if (params.mode === 'formulas') {
          range.formulas = params.values.map((row) => row.map((cell) => (cell === null ? '' : cell)));
        } else {
          const suspicious = params.values.flat().filter((cell) => V.isFormula(cell));
          if (suspicious.length) {
            throw new Error(t('api.err.formulasInValues', { sample: suspicious[0] }));
          }
          range.values = params.values.map((row) => row.map((cell) => (cell === null ? '' : cell)));
        }
        if (params.numberFormat) {
          range.numberFormat = fillMatrix(check.rows, check.columns, params.numberFormat);
        }
        range.format.autofitColumns();
        await context.sync();
        return { sheet: sheet.name, address: strip(range.address), cells: check.cellCount, mode: params.mode };
      });
    }),

    writeTableRows: wrap(async (params) => {
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        await ensureWriteAllowed(context, sheet);
        const table = sheet.tables.getItem(params.tableName);
        const rows = params.rows.map((row) => row.map((cell) => (cell === null ? '' : cell)));
        const append = params.append !== false;
        if (append) {
          table.rows.add(null, rows);
        } else {
          const body = table.getDataBodyRange();
          body.load('rowCount,columnCount');
          await context.sync();
          const rowCount = Math.min(rows.length, body.rowCount);
          const columnCount = Math.max(Math.min(rows[0].length, body.columnCount), 1);
          const target = body.getCell(0, 0).getResizedRange(rowCount - 1, columnCount - 1);
          target.values = rows.map((row) => row.slice(0, columnCount));
        }
        await context.sync();
        return { sheet: sheet.name, table: params.tableName, rows: rows.length, appended: append };
      });
    }),

    formatRange: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed) throw new Error(t('api.err.invalidAddress', { address: params.address }));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const range = sheet.getRange(parsed.text);
        range.load('rowCount,columnCount');
        await context.sync();

        const fmt = range.format;
        const applied = [];
        if (params.bold !== undefined) { fmt.font.bold = Boolean(params.bold); applied.push('bold'); }
        if (params.italic !== undefined) { fmt.font.italic = Boolean(params.italic); applied.push('italic'); }
        if (params.fontSize !== undefined) { fmt.font.size = V.clampNumber(params.fontSize, 1, 409, 11); applied.push('fontSize'); }
        if (params.fontColor) {
          const color = V.hexColor(params.fontColor);
          if (!color) throw new Error(t('api.err.colorInvalid', { kind: 'font', color: params.fontColor }));
          fmt.font.color = color;
          applied.push('fontColor');
        }
        if (params.fillColor) {
          const color = V.hexColor(params.fillColor);
          if (!color) throw new Error(t('api.err.colorInvalid', { kind: 'fill', color: params.fillColor }));
          fmt.fill.color = color;
          applied.push('fillColor');
        }
        if (params.horizontalAlignment) { fmt.horizontalAlignment = params.horizontalAlignment; applied.push('horizontalAlignment'); }
        if (params.verticalAlignment) { fmt.verticalAlignment = params.verticalAlignment; applied.push('verticalAlignment'); }
        if (params.wrapText !== undefined) { fmt.wrapText = Boolean(params.wrapText); applied.push('wrapText'); }
        if (params.columnWidth !== undefined) { fmt.columnWidth = V.clampNumber(params.columnWidth, 1, 255, 10); applied.push('columnWidth'); }
        if (params.rowHeight !== undefined) { fmt.rowHeight = V.clampNumber(params.rowHeight, 1, 409, 15); applied.push('rowHeight'); }
        if (params.numberFormat) {
          range.numberFormat = fillMatrix(range.rowCount, range.columnCount, params.numberFormat);
          applied.push('numberFormat');
        }
        if (!applied.length) throw new Error(t('api.err.formatPropMissing'));
        await context.sync();
        return { sheet: sheet.name, address: strip(range.address), applied };
      });
    }),

    clearRange: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.rangeRequired', { tool: 'clear_range' }));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        await ensureWriteAllowed(context, sheet);
        const range = sheet.getRange(parsed.text);
        const applyTo = params.applyTo || 'all';
        const map = {
          all: Excel.ClearApplyTo.all,
          contents: Excel.ClearApplyTo.contents,
          formats: Excel.ClearApplyTo.formats,
        };
        range.clear(map[applyTo] || Excel.ClearApplyTo.all);
        await context.sync();
        return { sheet: sheet.name, address: strip(range.address), applyTo };
      });
    }),

    autofitColumns: wrap(async (params) => {
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const parsed = params.address ? V.parseAddress(params.address) : null;
        if (params.address && !parsed) throw new Error(`Invalid address: ${params.address}`);
        const range = parsed ? sheet.getRange(parsed.text) : sheet.getUsedRangeOrNullObject();
        range.load('address,isNullObject');
        await context.sync();
        if (range.isNullObject) return { sheet: sheet.name, address: '', note: t('api.err.autofitEmpty') };
        range.format.autofitColumns();
        await context.sync();
        return { sheet: sheet.name, address: strip(range.address) };
      });
    }),

    insertRows: wrap(async (params) =>
      structural('insert', 'row', params)),

    deleteRows: wrap(async (params) =>
      structural('delete', 'row', params)),

    insertColumns: wrap(async (params) =>
      structural('insert', 'column', params)),

    deleteColumns: wrap(async (params) =>
      structural('delete', 'column', params)),

    addWorksheet: wrap(async (params) => {
      const name = V.sanitizeSheetName(params.name);
      if (!name) throw new Error(t('api.err.nameInvalid'));
      return Excel.run(async (context) => {
        const sheets = await sheetsOf(context);
        if (sheets.items.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(t('api.err.sheetExists', { name }));
        }
        const added = params.position === undefined
          ? sheets.add(name)
          : sheets.add(name, params.position);
        if (params.activate) added.activate();
        await context.sync();
        return { sheet: name, position: params.position === undefined ? null : params.position };
      });
    }),

    renameWorksheet: wrap(async (params) => {
      const newName = V.sanitizeSheetName(params.newName);
      if (!newName) throw new Error(t('api.err.nameInvalid'));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const sheets = await sheetsOf(context);
        if (sheets.items.some((s) => s.name.toLowerCase() === newName.toLowerCase() && s.name !== sheet.name)) {
          throw new Error(t('api.err.sheetInUse', { name: newName }));
        }
        const oldName = sheet.name;
        sheet.name = newName;
        await context.sync();
        return { from: oldName, to: newName };
      });
    }),

    deleteWorksheet: wrap(async (params) => {
      return Excel.run(async (context) => {
        const sheets = await sheetsOf(context);
        if (sheets.items.length <= 1) throw new Error(t('api.err.lastSheet'));
        const sheet = await requireSheet(context, params.sheet);
        const name = sheet.name;
        sheet.delete();
        await context.sync();
        return { deleted: name };
      });
    }),

    sortRange: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.rangeRequired', { tool: 'sort_range' }));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const range = sheet.getRange(parsed.text);
        range.load('rowCount,columnCount');
        await context.sync();
        const key = V.clampNumber(params.keyColumnIndex, 0, range.columnCount - 1, 0);
        range.sort.apply(
          [{ key, ascending: params.ascending !== false }],
          false,
          Boolean(params.hasHeader),
        );
        await context.sync();
        return { sheet: sheet.name, address: range.address, keyColumnIndex: key, ascending: params.ascending !== false };
      });
    }),

    createTable: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.rangeRequired', { tool: 'create_table' }));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const table = sheet.tables.add(parsed.text, params.hasHeaders !== false);
        if (params.name) table.name = params.name;
        table.style = 'TableStyleMedium2';
        table.load('name');
        await context.sync();
        return { sheet: sheet.name, table: table.name, address: parsed.text };
      });
    }),

    createChart: wrap(async (params) => {
      const parsed = V.parseAddress(params.dataAddress);
      if (!parsed) throw new Error(t('api.err.invalidAddress', { address: params.dataAddress }));
      const types = {
        ColumnClustered: 'ColumnClustered',
        BarClustered: 'BarClustered',
        Line: 'Line',
        Pie: 'Pie',
        Doughnut: 'Doughnut',
        Area: 'Area',
        XYScatter: 'XYScatter',
      };
      const type = types[params.chartType];
      if (!type) throw new Error(t('api.err.chartType', { type: params.chartType }));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const chart = sheet.charts.add(type, sheet.getRange(parsed.text), 'Auto');
        if (params.title) chart.title.text = String(params.title);
        chart.setPosition(params.positionCell || 'H2');
        chart.load('name');
        await context.sync();
        return { sheet: sheet.name, chart: chart.name, type, source: parsed.text };
      });
    }),

    applyAutofilter: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.rangeRequired', { tool: 'apply_autofilter' }));
      if (!api.supports('ExcelApi', '1.9')) {
        throw new Error(t('api.err.autofilterUnsupported'));
      }
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        sheet.autoFilter.apply(sheet.getRange(parsed.text));
        await context.sync();
        return { sheet: sheet.name, address: parsed.text, note: t('api.err.autofilterApplied') };
      });
    }),

    conditionalFormat: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.rangeRequired', { tool: 'conditional_format' }));
      if (!api.supports('ExcelApi', '1.6')) {
        throw new Error(t('api.err.conditionalUnsupported'));
      }
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const range = sheet.getRange(parsed.text);
        const type = params.type;
        if (type === 'cellValue') {
          const cf = range.conditionalFormats.add('CellValue');
          cf.cellValue.rule = {
            formula1: params.formula1 !== undefined ? String(params.formula1) : '0',
            formula2: params.formula2 !== undefined ? String(params.formula2) : undefined,
            operator: params.operator || 'GreaterThan',
          };
          if (params.fillColor) cf.cellValue.format.fill.color = V.hexColor(params.fillColor) || '#FEE2E2';
          if (params.fontColor) cf.cellValue.format.font.color = V.hexColor(params.fontColor) || '#991B1B';
        } else if (type === 'colorScale') {
          const cf = range.conditionalFormats.add('ColorScale');
          cf.colorScale.criteria = {
            minimum: { type: 'LowestValue', color: params.fillColor || '#FFFFFF' },
            maximum: { type: 'HighestValue', color: params.fontColor || '#2563EB' },
          };
        } else if (type === 'dataBar') {
          const cf = range.conditionalFormats.add('DataBar');
          cf.dataBar.barDirection = 'LeftToRight';
          cf.dataBar.positiveFormat.fill.color = V.hexColor(params.fillColor) || '#2563EB';
        } else {
          throw new Error(t('api.err.conditionalType', { type }));
        }
        await context.sync();
        return { sheet: sheet.name, address: parsed.text, type };
      });
    }),

    findReplace: wrap(async (params) => {
      if (!params.find) throw new Error(t('api.err.findEmpty'));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        await ensureWriteAllowed(context, sheet);
        const used = sheet.getUsedRangeOrNullObject();
        used.load('address,rowCount,columnCount,isNullObject');
        await context.sync();
        if (used.isNullObject) return { sheet: sheet.name, replaced: 0, note: t('api.err.sheetEmptyShort') };
        const cells = used.rowCount * used.columnCount;
        if (cells > 100000) {
          throw new Error(t('api.err.findTooLarge', { cells }));
        }
        used.load('values');
        await context.sync();
        const values = cleanMatrix(used.values);
        const matchCase = Boolean(params.matchCase);
        const entire = Boolean(params.matchEntireCell);
        const needle = matchCase ? params.find : params.find.toLowerCase();
        let replaced = 0;
        const out = values.map((row) =>
          row.map((cell) => {
            if (typeof cell !== 'string') return cell;
            const hay = matchCase ? cell : cell.toLowerCase();
            let next = cell;
            if (entire) {
              if (hay === needle) {
                next = params.replace;
                replaced += 1;
              }
            } else {
              const escaped = params.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const re = new RegExp(escaped, matchCase ? 'g' : 'gi');
              const matches = cell.match(re);
              if (matches) {
                replaced += matches.length;
                next = cell.replace(re, params.replace);
              }
            }
            return next;
          }),
        );
        if (replaced > 0) used.values = out;
        await context.sync();
        return { sheet: sheet.name, address: strip(used.address), replaced };
      });
    }),

    selectRange: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed) throw new Error(t('api.err.invalidAddress', { address: params.address }));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        sheet.activate();
        const range = sheet.getRange(parsed.text);
        range.select();
        await context.sync();
        return { sheet: sheet.name, address: parsed.text, selected: true };
      });
    }),

    /** Pre-image for the journal/undo: values, formulas, and number format of a range. */
    captureSnapshot: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) return null;
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const range = sheet.getRange(parsed.text);
        range.load('address,rowCount,columnCount,values,formulas,numberFormat');
        await context.sync();
        return {
          sheet: sheet.name,
          address: strip(range.address),
          rows: range.rowCount,
          columns: range.columnCount,
          values: cleanMatrix(range.values),
          formulas: cleanMatrix(range.formulas),
          numberFormat: range.numberFormat,
        };
      });
    }),

    /** Restore a snapshot: values first, then the formula for each cell that actually has one. */
    restoreSnapshot: wrap(async (snapshot) => {
      if (!snapshot) throw new Error(t('api.err.snapshotEmpty'));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, snapshot.sheet);
        const range = sheet.getRange(snapshot.address);
        range.values = snapshot.values;
        if (snapshot.numberFormat) range.numberFormat = snapshot.numberFormat;
        const formulaCells = [];
        for (let r = 0; r < snapshot.formulas.length; r++) {
          for (let c = 0; c < snapshot.formulas[r].length; c++) {
            const f = snapshot.formulas[r][c];
            if (typeof f === 'string' && f.startsWith('=')) formulaCells.push([r, c, f]);
          }
        }
        if (formulaCells.length > 2000) {
          throw new Error(t('api.err.tooManyFormulaCells'));
        }
        for (const [r, c, f] of formulaCells) {
          range.getCell(r, c).formulas = [[f]];
        }
        await context.sync();
        return { sheet: snapshot.sheet, address: snapshot.address, formulaCells: formulaCells.length };
      });
    }),

    /** Whether the sheet may be written to (not protected). */
    isWritable: wrap(async (sheetName) => {
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, sheetName);
        sheet.protection.load('protected');
        await context.sync();
        return !sheet.protection.protected;
      });
    }),

    /** Office document settings: per-file personalization that travels inside the workbook. */
    getSetting: wrap(async (key) => {
      return Excel.run(async (context) => {
        const settings = context.workbook.settings;
        settings.load('items/key,items/value');
        await context.sync();
        const found = settings.items.find((item) => item.key === key);
        return found ? found.value : null;
      });
    }),

    setSetting: wrap(async (params) => {
      return Excel.run(async (context) => {
        const settings = context.workbook.settings;
        if (params.value === null || params.value === undefined) settings.remove(params.key);
        else settings.add(params.key, params.value);
        await context.sync();
        return true;
      });
    }),

    /** Compact sheet list (name + position) for plan validation. */
    listSheets: wrap(async () => {
      return Excel.run(async (context) => {
        const sheets = await sheetsOf(context);
        return sheets.items.map((s) => ({ name: s.name, position: s.position }));
      });
    }),

    /** Used-range address of a sheet (used to bound snapshots of deleted rows/columns). */
    usedRangeAddress: wrap(async (sheetName) => {
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, sheetName);
        const used = sheet.getUsedRangeOrNullObject();
        used.load('address,rowCount,columnCount,isNullObject');
        await context.sync();
        if (used.isNullObject) return null;
        return { address: strip(used.address), rows: used.rowCount, columns: used.columnCount };
      });
    }),

    /** Format pre-image (for undoing a format_range operation). */
    captureFormat: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) return null;
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const range = sheet.getRange(parsed.text);
        range.load('address,numberFormat');
        const fmt = range.format;
        fmt.load('horizontalAlignment,verticalAlignment,wrapText,columnWidth,rowHeight');
        fmt.font.load('bold,italic,size,color');
        fmt.fill.load('color');
        await context.sync();
        return {
          sheet: sheet.name,
          address: strip(range.address),
          format: {
            bold: fmt.font.bold,
            italic: fmt.font.italic,
            fontSize: fmt.font.size,
            fontColor: fmt.font.color,
            fillColor: fmt.fill.color,
            horizontalAlignment: fmt.horizontalAlignment,
            verticalAlignment: fmt.verticalAlignment,
            wrapText: fmt.wrapText,
            columnWidth: fmt.columnWidth,
            rowHeight: fmt.rowHeight,
            numberFormat: range.numberFormat,
          },
        };
      });
    }),

    restoreFormat: wrap(async (snapshot) => {
      if (!snapshot) return null;
      const f = snapshot.format || {};
      const skipped = [];
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, snapshot.sheet);
        const range = sheet.getRange(snapshot.address);
        const fmt = range.format;
        const applyFont = (key) => {
          if (f[key] === null || f[key] === undefined) skipped.push(key);
          else fmt.font[key] = f[key];
        };
        applyFont('bold');
        applyFont('italic');
        if (f.wrapText === null || f.wrapText === undefined) skipped.push('wrapText');
        else fmt.wrapText = f.wrapText;
        if (f.fontSize !== null && f.fontSize !== undefined) fmt.font.size = f.fontSize;
        else skipped.push('fontSize');
        if (f.fontColor) fmt.font.color = f.fontColor;
        else skipped.push('fontColor');
        if (f.fillColor) fmt.fill.color = f.fillColor;
        else skipped.push('fillColor');
        if (f.horizontalAlignment) fmt.horizontalAlignment = f.horizontalAlignment;
        if (f.verticalAlignment) fmt.verticalAlignment = f.verticalAlignment;
        if (f.columnWidth !== null && f.columnWidth !== undefined) fmt.columnWidth = f.columnWidth;
        if (f.rowHeight !== null && f.rowHeight !== undefined) fmt.rowHeight = f.rowHeight;
        if (f.numberFormat) range.numberFormat = f.numberFormat;
        await context.sync();
        return { sheet: snapshot.sheet, address: snapshot.address, skipped: [...new Set(skipped)] };
      });
    }),

    /** Undo create_table: turn the last table in the sheet back into a plain range. */
    removeLastTable: wrap(async (params) => {
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const tables = sheet.tables;
        tables.load('items/name');
        await context.sync();
        if (!tables.items.length) throw new Error(t('api.err.noTableToUndo'));
        const table = tables.items[tables.items.length - 1];
        const name = table.name;
        table.convertToRange();
        await context.sync();
        return { sheet: sheet.name, table: name, convertedToRange: true };
      });
    }),

    /** Undo create_chart: delete the last chart in the sheet. */
    deleteLastChart: wrap(async (params) => {
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const charts = sheet.charts;
        charts.load('items/name');
        await context.sync();
        if (!charts.items.length) throw new Error(t('api.err.noChartToUndo'));
        const chart = charts.items[charts.items.length - 1];
        const name = chart.name;
        chart.delete();
        await context.sync();
        return { sheet: sheet.name, deletedChart: name };
      });
    }),

    removeAutofilter: wrap(async (params) => {
      if (!api.supports('ExcelApi', '1.9')) throw new Error(t('api.err.autofilterShort'));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        sheet.autoFilter.remove();
        await context.sync();
        return { sheet: sheet.name, autofilterRemoved: true };
      });
    }),

    /** Undo conditional_format: delete the last conditional format on that range. */
    undoLastConditionalFormat: wrap(async (params) => {
      const parsed = V.parseAddress(params.address);
      if (!parsed || parsed.unbounded) throw new Error(t('api.err.conditionalUndoAddress'));
      return Excel.run(async (context) => {
        const sheet = await requireSheet(context, params.sheet);
        const range = sheet.getRange(parsed.text);
        const formats = range.conditionalFormats;
        formats.load('items/type');
        await context.sync();
        if (!formats.items.length) throw new Error(t('api.err.noConditionalToUndo'));
        formats.items[formats.items.length - 1].delete();
        await context.sync();
        return { sheet: sheet.name, address: parsed.text, removed: true };
      });
    }),
  };

  async function structural(action, axis, params) {
    const index = V.clampNumber(params.index, 1, V.MAX_ROW, 1);
    const count = V.clampNumber(params.count, 1, 1000, 1);
    if (index !== Number(params.index)) {
      throw new Error(t('api.err.indexInvalid', { index: params.index }));
    }
    if (axis === 'row' && index + count - 1 > V.MAX_ROW) throw new Error(t('api.err.rowLimit'));
    if (axis === 'column' && index + count - 1 > V.MAX_COL) throw new Error(t('api.err.columnLimit'));

    return Excel.run(async (context) => {
      const sheet = await requireSheet(context, params.sheet);
      await ensureWriteAllowed(context, sheet);
      const range = axis === 'row'
        ? sheet.getRangeByIndexes(index - 1, 0, count, 1).getEntireRow()
        : sheet.getRangeByIndexes(0, index - 1, 1, count).getEntireColumn();
      if (action === 'insert') {
        range.insert(axis === 'row' ? Excel.InsertShiftDirection.down : Excel.InsertShiftDirection.right);
      } else {
        range.delete(axis === 'row' ? Excel.DeleteShiftDirection.up : Excel.DeleteShiftDirection.left);
      }
      await context.sync();
      return { sheet: sheet.name, action, axis, index, count };
    });
  }

  global.DSX = global.DSX || {};
  global.DSX.officeApi = api;
})(typeof self !== 'undefined' ? self : this);

