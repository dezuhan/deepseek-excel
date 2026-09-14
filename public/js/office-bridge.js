/**
 * Bridge between the model and the spreadsheet.
 *
 * Ground rules (following the user's decision = semi-automatic):
 *  - read tools (read-only) run immediately,
 *  - write tools are NOT run immediately: a "plan" is built containing a diff preview,
 *    then it waits for the user to press Apply,
 *  - every application is recorded in the journal together with how to reverse it (undo).
 *
 * All text the user sees comes from DSX.i18n (en-US default, id-ID available).
 * Status values sent to the model stay in English (protocol, not display):
 * 'ok' | 'applied' | 'applied_auto' | 'failed' | 'rejected_by_user' | 'pending'.
 */
(function (global) {
  'use strict';

  const V = global.DSX.validate;
  const Journal = global.DSX.Journal;

  function t(key, params) {
    const i18n = global.DSX && global.DSX.i18n;
    return i18n ? i18n.t(key, params) : key;
  }

  const state = {
    api: null,
    config: {
      maxCellsWrite: 5000,
      maxCellsRead: 2000,
      maxToolIterations: 12,
      autoApply: false,
    },
    journal: new Journal({ limit: 25, maxBytes: 500000 }),
    pending: [],
    seq: 0,
  };

  const CHART_TYPES = ['ColumnClustered', 'BarClustered', 'Line', 'Pie', 'Doughnut', 'Area', 'XYScatter'];

  function str(value, max) {
    const limit = max || 40;
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function colLetter(index) {
    return V.indexToColumn(index);
  }

  function assertRange(address, toolName) {
    const parsed = V.parseAddress(address);
    if (!parsed) throw new Error(t('bridge.err.invalidAddress', { tool: toolName, address }));
    return parsed;
  }

  function assertSize(parsed, limit, what) {
    if (parsed.cellCount > limit) {
      throw new Error(t('bridge.err.tooLarge', { what, cells: parsed.cellCount, limit }));
    }
  }

  // ------------------------------------------------------------------ read tools
  const READ_TOOLS = {
    get_workbook_overview: (api, args) => api.overview(args),
    read_range: (api, args) => api.readRange(args),
    get_tables: (api, args) => api.getTables(args),
    list_charts: (api, args) => api.listCharts(args),
    list_named_ranges: (api, args) => api.listNamedRanges(args),
    select_range: (api, args) => api.selectRange(args),
  };

  // ------------------------------------------------------------------ tool tulis
  const MUTATORS = {
    write_range: {
      label: (args) => t(args.mode === 'formulas' ? 'bridge.label.writeFormulas' : 'bridge.label.writeValues'),
      writesData: true,
      async plan(api, args) {
        const check = V.validateMatrix(args.values, args.address);
        if (!check.ok) throw new Error(check.error);
        if (args.mode === 'values') {
          const suspicious = args.values.flat().filter((cell) => V.isFormula(cell));
          if (suspicious.length) {
            throw new Error(t('bridge.err.valuesNotFormula', { sample: suspicious[0] }));
          }
        }
        const parsed = assertRange(args.address, 'write_range');
        assertSize(parsed, state.config.maxCellsWrite, 'write_range');
        const snapshot = await api.captureSnapshot({ sheet: args.sheet, address: parsed.text });
        let overwrite = 0;
        if (snapshot) {
          snapshot.values.forEach((row) => row.forEach((v) => { if (!V.isBlank(v)) overwrite += 1; }));
        }
        return { snapshot, overwrite, check, parsed };
      },
      preview(args, ctx) {
        const rows = [];
        const limit = Math.min(args.values.length, 8);
        for (let r = 0; r < limit; r += 1) {
          const cells = args.values[r].map((after, c) => ({
            before: ctx.snapshot && ctx.snapshot.values[r] ? str(ctx.snapshot.values[r][c]) : '',
            after: str(after),
          }));
          rows.push({ label: t('bridge.preview.rowLabel', { row: r + 1 }), cells });
        }
        return {
          kind: args.mode === 'formulas' ? 'formula' : 'write',
          summary: t('bridge.preview.writeSummary', {
            cells: ctx.check.cellCount,
            rows: ctx.check.rows,
            columns: ctx.check.columns,
            sheet: args.sheet,
            range: ctx.parsed.text,
          }),
          counts: { cells: ctx.check.cellCount, overwrite: ctx.overwrite },
          rows,
          notes: ctx.overwrite ? [t('bridge.preview.overwrite', { count: ctx.overwrite })] : [],
        };
      },
      destructive: (args, ctx) => ctx.overwrite > 0,
      run: (api, args) => api.writeRange(args),
      undo(args, ctx) {
        if (!ctx.snapshot) return { note: t('bridge.preview.undoUnavailable') };
        return { snapshots: [ctx.snapshot] };
      },
    },

    write_table_rows: {
      label: () => t('bridge.label.writeTableRows'),
      writesData: true,
      async plan(api, args) {
        const tables = await api.getTables({ sheet: args.sheet });
        const table = tables.find((item) => item.name === args.tableName);
        if (!table) {
          const names = tables.map((item) => item.name).join(', ') || '(none)';
          throw new Error(t('bridge.err.tableMissing', { table: args.tableName, sheet: args.sheet, names }));
        }
        if (!Array.isArray(args.rows) || !args.rows.length) throw new Error(t('bridge.err.rowsEmpty'));
        if (args.rows.some((row) => !Array.isArray(row))) throw new Error(t('bridge.err.rowsNotMatrix'));
        const parsed = assertRange(table.address, 'write_table_rows');
        const hasHeader = (table.headerRow || 0) > 0;
        const bodyStart = parsed.startRow + (hasHeader ? 1 : 0);
        const append = args.append !== false;
        const ctx = { table, parsed, hasHeader, bodyStart, append, rowCount: args.rows.length };
        if (append) {
          ctx.startIndex = bodyStart + (table.dataRows || 0);
        } else {
          const address = `${colLetter(parsed.startCol)}${bodyStart}:${colLetter(parsed.endCol)}${bodyStart + args.rows.length - 1}`;
          ctx.address = address;
          ctx.snapshot = await api.captureSnapshot({ sheet: args.sheet, address });
        }
        return ctx;
      },
      preview(args, ctx) {
        const rows = args.rows.slice(0, 8).map((row, i) => ({
          label: t('bridge.preview.rowLabel', { row: i + 1 }),
          cells: row.map((after, c) => ({
            before: ctx.snapshot && ctx.snapshot.values[i] ? str(ctx.snapshot.values[i][c]) : '',
            after: str(after),
          })),
        }));
        return {
          kind: 'table',
          summary: t(ctx.append ? 'bridge.preview.tableAppend' : 'bridge.preview.tableOverwrite', {
            rows: ctx.rowCount,
            table: ctx.table.name,
            sheet: args.sheet,
          }),
          counts: { rows: ctx.rowCount, cells: ctx.rowCount * ctx.parsed.columns },
          rows,
          notes: ctx.append ? [] : [t('bridge.preview.tableOverwriteNote')],
        };
      },
      destructive: (args, ctx) => !ctx.append,
      run: (api, args) => api.writeTableRows(args),
      undo(args, ctx) {
        if (ctx.append) {
          return { calls: [{ api: 'deleteRows', args: { sheet: args.sheet, index: ctx.startIndex, count: ctx.rowCount } }] };
        }
        return { snapshots: ctx.snapshot ? [ctx.snapshot] : [] };
      },
    },

    format_range: {
      label: () => t('bridge.label.formatRange'),
      writesData: false,
      async plan(api, args) {
        const parsed = assertRange(args.address, 'format_range');
        const snapshot = await api.captureFormat({ sheet: args.sheet, address: parsed.text });
        const applied = Object.keys(args).filter((k) => !['sheet', 'address'].includes(k));
        if (!applied.length) throw new Error(t('bridge.err.noFormatProps'));
        return { parsed, snapshot, applied };
      },
      preview(args, ctx) {
        return {
          kind: 'format',
          summary: t('bridge.preview.formatSummary', {
            range: ctx.parsed.text,
            sheet: args.sheet,
            props: ctx.applied.join(', '),
          }),
          counts: { cells: ctx.parsed.cellCount },
          rows: [],
          notes: ctx.snapshot ? [] : [t('bridge.preview.formatNoSnapshot')],
        };
      },
      destructive: () => false,
      run: (api, args) => api.formatRange(args),
      undo(args, ctx) {
        return ctx.snapshot ? { formats: [ctx.snapshot] } : { note: t('bridge.preview.formatUndoNote') };
      },
    },

    clear_range: {
      label: () => t('bridge.label.clearRange'),
      writesData: true,
      async plan(api, args) {
        const parsed = assertRange(args.address, 'clear_range');
        if (parsed.unbounded) throw new Error(t('bridge.err.rangeRequired', { tool: 'clear_range' }));
        const snapshot = await api.captureSnapshot({ sheet: args.sheet, address: parsed.text });
        const formats = args.applyTo === 'contents' ? null : await api.captureFormat({ sheet: args.sheet, address: parsed.text });
        let nonEmpty = 0;
        if (snapshot) snapshot.values.forEach((row) => row.forEach((v) => { if (!V.isBlank(v)) nonEmpty += 1; }));
        return { parsed, snapshot, formats, nonEmpty };
      },
      preview(args, ctx) {
        const rows = [];
        if (ctx.snapshot) {
          const limit = Math.min(ctx.snapshot.values.length, 6);
          for (let r = 0; r < limit; r += 1) {
            rows.push({
              label: t('bridge.preview.rowLabel', { row: r + 1 }),
              cells: ctx.snapshot.values[r].map((before) => ({
                before: str(before),
                after: t('bridge.preview.diffCleared'),
              })),
            });
          }
        }
        return {
          kind: 'clear',
          summary: t('bridge.preview.clearSummary', {
            range: ctx.parsed.text,
            sheet: args.sheet,
            mode: args.applyTo || 'all',
          }),
          counts: { cells: ctx.parsed.cellCount, nonEmpty: ctx.nonEmpty },
          rows,
          notes: ctx.nonEmpty ? [t('bridge.preview.clearNote', { count: ctx.nonEmpty })] : [],
        };
      },
      destructive: () => true,
      run: (api, args) => api.clearRange(args),
      undo(args, ctx) {
        return {
          snapshots: ctx.snapshot ? [ctx.snapshot] : [],
          formats: ctx.formats ? [ctx.formats] : [],
          note: t('bridge.preview.clearUndoNote'),
        };
      },
    },

    autofit_columns: {
      label: () => t('bridge.label.autofitColumns'),
      writesData: false,
      async plan(api, args) {
        const parsed = args.address ? assertRange(args.address, 'autofit_columns') : null;
        return { parsed };
      },
      preview(args, ctx) {
        return {
          kind: 'layout',
          summary: t('bridge.preview.autofitSummary', {
            target: ctx.parsed ? ctx.parsed.text : t('bridge.preview.autofitWhole'),
            sheet: args.sheet,
          }),
          counts: {},
          rows: [],
          notes: [t('bridge.preview.autofitNote')],
        };
      },
      destructive: () => false,
      run: (api, args) => api.autofitColumns(args),
      undo: () => ({ note: t('bridge.preview.autofitNote') }),
    },

    insert_rows: structuralMutator('insert', 'row'),
    delete_rows: structuralMutator('delete', 'row'),
    insert_columns: structuralMutator('insert', 'column'),
    delete_columns: structuralMutator('delete', 'column'),

    add_worksheet: {
      label: (args) => t('bridge.label.addWorksheet', { name: args.name }),
      writesData: false,
      async plan(api, args) {
        const name = V.sanitizeSheetName(args.name);
        if (!name) throw new Error(t('bridge.err.nameInvalid'));
        const sheets = await api.listSheets();
        if (sheets.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(t('bridge.err.sheetExists', { name }));
        }
        const position = args.position === undefined ? sheets.length : V.clampNumber(args.position, 0, sheets.length, sheets.length);
        return { name, position };
      },
      preview(args, ctx) {
        return {
          kind: 'sheet',
          summary: t('bridge.preview.addSheetSummary', { name: ctx.name, position: ctx.position + 1 }),
          counts: {},
          rows: [],
          notes: [],
        };
      },
      destructive: () => false,
      run: (api, args) => api.addWorksheet(args),
      undo: (args, ctx) => ({ calls: [{ api: 'deleteWorksheet', args: { sheet: ctx.name } }] }),
    },

    rename_worksheet: {
      label: (args) => t('bridge.label.renameWorksheet', { name: args.newName }),
      writesData: false,
      async plan(api, args) {
        const newName = V.sanitizeSheetName(args.newName);
        if (!newName) throw new Error(t('bridge.err.nameInvalid'));
        const sheets = await api.listSheets();
        const current = sheets.find((s) => s.name.toLowerCase() === String(args.sheet).toLowerCase());
        if (!current) throw new Error(t('bridge.err.sheetMissing', { name: args.sheet }));
        if (sheets.some((s) => s.name.toLowerCase() === newName.toLowerCase())) {
          throw new Error(t('bridge.err.sheetInUse', { name: newName }));
        }
        return { oldName: current.name, newName };
      },
      preview(args, ctx) {
        return {
          kind: 'sheet',
          summary: t('bridge.preview.renameSheetSummary', { from: ctx.oldName, to: ctx.newName }),
          counts: {},
          rows: [],
          notes: [t('bridge.preview.renameNote')],
        };
      },
      destructive: () => true,
      run: (api, args) => api.renameWorksheet(args),
      undo: (args, ctx) => ({ calls: [{ api: 'renameWorksheet', args: { sheet: ctx.newName, newName: ctx.oldName } }] }),
    },

    delete_worksheet: {
      label: (args) => t('bridge.label.deleteWorksheet', { name: args.sheet }),
      writesData: false,
      async plan(api, args) {
        const sheets = await api.listSheets();
        if (sheets.length <= 1) throw new Error(t('bridge.err.lastSheet'));
        const target = sheets.find((s) => s.name.toLowerCase() === String(args.sheet).toLowerCase());
        if (!target) throw new Error(t('bridge.err.sheetMissing', { name: args.sheet }));
        const used = await api.usedRangeAddress(target.name);
        let snapshot = null;
        let formats = null;
        let note = null;
        if (used) {
          if (used.rows * used.columns <= state.config.maxCellsWrite * 4) {
            snapshot = await api.captureSnapshot({ sheet: target.name, address: used.address });
            formats = await api.captureFormat({ sheet: target.name, address: used.address });
          } else {
            note = t('bridge.preview.deleteSheetSnapshotNote', { cells: used.rows * used.columns });
          }
        }
        return { target, position: target.position, used, snapshot, formats, note };
      },
      preview(args, ctx) {
        const rows = [];
        if (ctx.snapshot) {
          const limit = Math.min(ctx.snapshot.values.length, 5);
          for (let r = 0; r < limit; r += 1) {
            rows.push({
              label: t('bridge.preview.rowLabel', { row: r + 1 }),
              cells: ctx.snapshot.values[r].slice(0, 6).map((before) => ({
                before: str(before),
                after: t('bridge.preview.diffSheetDeleted'),
              })),
            });
          }
        }
        const notes = [t('bridge.preview.deleteSheetNote')];
        if (ctx.note) notes.push(ctx.note);
        if (ctx.target) notes.push(t('bridge.preview.deleteSheetObjectNote'));
        return {
          kind: 'sheet',
          summary: t('bridge.preview.deleteSheetSummary', {
            name: ctx.target.name,
            size: ctx.used
              ? `${ctx.used.rows}×${ctx.used.columns}`
              : t('bridge.preview.deleteSheetEmpty'),
          }),
          counts: { cells: ctx.used ? ctx.used.rows * ctx.used.columns : 0 },
          rows,
          notes,
        };
      },
      destructive: () => true,
      run: (api, args) => api.deleteWorksheet(args),
      undo(args, ctx) {
        return {
          calls: [{ api: 'addWorksheet', args: { name: ctx.target.name, position: ctx.position, activate: false } }],
          snapshots: ctx.snapshot ? [ctx.snapshot] : [],
          formats: ctx.formats ? [ctx.formats] : [],
          note: t('bridge.preview.deleteSheetUndoNote'),
        };
      },
    },

    sort_range: {
      label: () => t('bridge.label.sortRange'),
      writesData: true,
      async plan(api, args) {
        const parsed = assertRange(args.address, 'sort_range');
        if (parsed.unbounded) throw new Error(t('bridge.err.rangeRequired', { tool: 'sort_range' }));
        let snapshot = null;
        let note = null;
        if (parsed.cellCount <= state.config.maxCellsWrite * 4) {
          snapshot = await api.captureSnapshot({ sheet: args.sheet, address: parsed.text });
        } else {
          note = t('bridge.preview.sortTooBig', { cells: parsed.cellCount });
        }
        const rows = snapshot ? snapshot.values.slice(0, 6) : [];
        return { parsed, snapshot, note, rows };
      },
      preview(args, ctx) {
        return {
          kind: 'sort',
          summary: t('bridge.preview.sortSummary', {
            range: ctx.parsed.text,
            sheet: args.sheet,
            column: Number(args.keyColumnIndex) + 1,
            direction: t(args.ascending === false ? 'bridge.preview.sortDesc' : 'bridge.preview.sortAsc'),
          }),
          counts: { cells: ctx.parsed.cellCount },
          rows: ctx.rows.map((row, i) => ({
            label: t('bridge.preview.rowLabel', { row: i + 1 }),
            cells: row.slice(0, 6).map((value) => ({ before: str(value), after: t('bridge.preview.diffSorted') })),
          })),
          notes: [t('bridge.preview.sortNote'), ...(ctx.note ? [ctx.note] : [])],
        };
      },
      destructive: () => true,
      run: (api, args) => api.sortRange(args),
      undo(args, ctx) {
        return ctx.snapshot ? { snapshots: [ctx.snapshot] } : { note: ctx.note || t('bridge.preview.undoUnavailable') };
      },
    },

    create_table: {
      label: () => t('bridge.label.createTable'),
      writesData: false,
      async plan(api, args) {
        const parsed = assertRange(args.address, 'create_table');
        if (parsed.unbounded) throw new Error(t('bridge.err.rangeRequired', { tool: 'create_table' }));
        return { parsed };
      },
      preview(args, ctx) {
        return {
          kind: 'table',
          summary: t('bridge.preview.tableSummary', { range: ctx.parsed.text, sheet: args.sheet }),
          counts: { cells: ctx.parsed.cellCount },
          rows: [],
          notes: [t('bridge.preview.tableNote')],
        };
      },
      destructive: () => false,
      run: (api, args) => api.createTable(args),
      undo: (args) => ({
        calls: [{ api: 'removeLastTable', args: { sheet: args.sheet } }],
        note: t('bridge.preview.tableUndoNote'),
      }),
    },

    create_chart: {
      label: () => t('bridge.label.createChart'),
      writesData: false,
      async plan(api, args) {
        const parsed = assertRange(args.dataAddress, 'create_chart');
        if (!CHART_TYPES.includes(args.chartType)) {
          throw new Error(t('bridge.err.chartType', { type: args.chartType, options: CHART_TYPES.join(', ') }));
        }
        return { parsed };
      },
      preview(args, ctx) {
        return {
          kind: 'chart',
          summary: t('bridge.preview.chartSummary', {
            type: args.chartType,
            range: ctx.parsed.text,
            sheet: args.sheet,
          }),
          counts: { cells: ctx.parsed.cellCount },
          rows: [],
          notes: [],
        };
      },
      destructive: () => false,
      run: (api, args) => api.createChart(args),
      undo: (args) => ({ calls: [{ api: 'deleteLastChart', args: { sheet: args.sheet } }] }),
    },

    apply_autofilter: {
      label: () => t('bridge.label.applyAutofilter'),
      writesData: false,
      async plan(api, args) {
        const parsed = assertRange(args.address, 'apply_autofilter');
        if (parsed.unbounded) throw new Error(t('bridge.err.rangeRequired', { tool: 'apply_autofilter' }));
        if (!api.supports('ExcelApi', '1.9')) throw new Error(t('bridge.err.autofilterUnsupported'));
        return { parsed };
      },
      preview(args, ctx) {
        return {
          kind: 'autofilter',
          summary: t('bridge.preview.autofilterSummary', { range: ctx.parsed.text, sheet: args.sheet }),
          counts: {},
          rows: [],
          notes: [t('bridge.preview.autofilterNote')],
        };
      },
      destructive: () => false,
      run: (api, args) => api.applyAutofilter(args),
      undo: (args) => ({
        calls: [{ api: 'removeAutofilter', args: { sheet: args.sheet } }],
        note: t('bridge.preview.autofilterUndoNote'),
      }),
    },

    conditional_format: {
      label: () => t('bridge.label.conditionalFormat'),
      writesData: false,
      async plan(api, args) {
        const parsed = assertRange(args.address, 'conditional_format');
        if (parsed.unbounded) throw new Error(t('bridge.err.rangeRequired', { tool: 'conditional_format' }));
        if (args.type === 'cellValue' && !args.formula1) throw new Error(t('bridge.err.conditionalFormula'));
        return { parsed };
      },
      preview(args, ctx) {
        return {
          kind: 'conditional',
          summary: t('bridge.preview.conditionalSummary', {
            type: args.type,
            range: ctx.parsed.text,
            sheet: args.sheet,
          }),
          counts: { cells: ctx.parsed.cellCount },
          rows: [],
          notes: args.type === 'cellValue' && args.operator === 'Between' && !args.formula2
            ? [t('bridge.preview.conditionalBetweenNote')]
            : [],
        };
      },
      destructive: () => false,
      run: (api, args) => api.conditionalFormat(args),
      undo: (args, ctx) => ({
        calls: [{ api: 'undoLastConditionalFormat', args: { sheet: args.sheet, address: ctx.parsed.text } }],
      }),
    },

    find_replace: {
      label: () => t('bridge.label.findReplace'),
      writesData: true,
      async plan(api, args) {
        if (!args.find) throw new Error(t('bridge.err.findEmpty'));
        const used = await api.usedRangeAddress(args.sheet);
        if (!used) throw new Error(t('bridge.err.sheetEmpty', { sheet: args.sheet }));
        const cells = used.rows * used.columns;
        let snapshot = null;
        let note = null;
        if (cells <= 50000) {
          snapshot = await api.captureSnapshot({ sheet: args.sheet, address: used.address });
        } else {
          note = t('bridge.preview.snapshotTooBig');
        }
        let matches = 0;
        if (snapshot) {
          const needle = args.matchCase ? args.find : String(args.find).toLowerCase();
          snapshot.values.forEach((row) =>
            row.forEach((cell) => {
              if (typeof cell !== 'string') return;
              const hay = args.matchCase ? cell : cell.toLowerCase();
              if (args.matchEntireCell ? hay === needle : hay.includes(needle)) matches += 1;
            }),
          );
        }
        return { used, snapshot, note, matches };
      },
      preview(args, ctx) {
        return {
          kind: 'find',
          summary: t('bridge.preview.findSummary', {
            find: args.find,
            replace: args.replace,
            sheet: args.sheet,
            matches: ctx.matches,
          }),
          counts: { cells: ctx.used.rows * ctx.used.columns, matches: ctx.matches },
          rows: [],
          notes: [t('bridge.preview.findNote'), ...(ctx.note ? [ctx.note] : [])],
        };
      },
      destructive: () => true,
      run: (api, args) => api.findReplace(args),
      undo(args, ctx) {
        return ctx.snapshot ? { snapshots: [ctx.snapshot] } : { note: ctx.note || t('bridge.preview.undoUnavailable') };
      },
    },
  };

  function structuralMutator(action, axis) {
    const isDelete = action === 'delete';
    const apiMethod = `${action}${axis === 'row' ? 'Rows' : 'Columns'}`;
    const inverseApi = isDelete ? `insert${axis === 'row' ? 'Rows' : 'Columns'}` : `delete${axis === 'row' ? 'Rows' : 'Columns'}`;
    const labelKey = `${action}${axis === 'row' ? 'Rows' : 'Columns'}`;
    return {
      label: () => t(`bridge.label.${labelKey}`),
      writesData: true,
      async plan(api, args) {
        const maxIndex = axis === 'row' ? V.MAX_ROW : V.MAX_COL;
        const index = V.clampNumber(args.index, 1, maxIndex, 1);
        if (Number(args.index) !== index) throw new Error(t('bridge.err.indexInvalid', { index: args.index }));
        const count = V.clampNumber(args.count, 1, 1000, 1);
        if (axis === 'row' && index + count - 1 > V.MAX_ROW) throw new Error(t('bridge.err.rowLimit'));
        if (axis === 'column' && index + count - 1 > V.MAX_COL) throw new Error(t('bridge.err.columnLimit'));
        const used = await api.usedRangeAddress(args.sheet);
        const ctx = { index, count, used, snapshot: null, formats: null, note: null, sample: [] };
        if (isDelete && used) {
          const parsedUsed = V.parseAddress(used.address);
          const address = axis === 'row'
            ? `${colLetter(parsedUsed.startCol)}${index}:${colLetter(parsedUsed.endCol)}${Math.min(index + count - 1, parsedUsed.endRow)}`
            : `${colLetter(index)}${parsedUsed.startRow}:${colLetter(Math.min(index + count - 1, parsedUsed.endCol))}${parsedUsed.endRow}`;
          const parsedRegion = V.parseAddress(address);
          if (parsedRegion && parsedRegion.cellCount <= state.config.maxCellsWrite * 4) {
            ctx.snapshot = await api.captureSnapshot({ sheet: args.sheet, address });
            ctx.formats = await api.captureFormat({ sheet: args.sheet, address });
            if (ctx.snapshot) {
              const values = axis === 'row' ? ctx.snapshot.values : ctx.snapshot.values.map((row) => row.slice(0, 1));
              ctx.sample = values.slice(0, 6);
            }
          } else {
            ctx.note = t('bridge.preview.snapshotTooBig');
          }
        }
        return ctx;
      },
      preview(args, ctx) {
        const isRow = axis === 'row';
        const what = t(isRow ? 'bridge.preview.rowWord' : 'bridge.preview.columnWord');
        const rows = isDelete
          ? ctx.sample.map((row, i) => ({
            label: t('bridge.preview.rowLabel', { row: i + 1 }),
            cells: (Array.isArray(row) ? row : [row]).slice(0, 6).map((value) => ({
              before: str(value),
              after: t('bridge.preview.diffDeleted'),
            })),
          }))
          : [];
        const notes = [];
        if (isDelete) {
          notes.push(t('bridge.preview.deleteNote', {
            what,
            from: ctx.index,
            to: ctx.index + ctx.count - 1,
          }));
        }
        if (ctx.note) notes.push(ctx.note);
        return {
          kind: 'structural',
          summary: t(isDelete ? 'bridge.preview.deleteSummary' : 'bridge.preview.insertSummary', {
            count: ctx.count,
            what,
            axis: t(isRow ? 'bridge.preview.axisRow' : 'bridge.preview.axisColumn'),
            index: ctx.index,
            sheet: args.sheet,
          }),
          counts: { count: ctx.count, index: ctx.index },
          rows,
          notes,
        };
      },
      destructive: () => isDelete,
      run: (api, args) => api[apiMethod]({ ...args, index: args.index, count: args.count || 1 }),
      undo(args, ctx) {
        const calls = [{ api: inverseApi, args: { sheet: args.sheet, index: ctx.index, count: ctx.count } }];
        return {
          calls,
          snapshots: ctx.snapshot ? [ctx.snapshot] : [],
          formats: ctx.formats ? [ctx.formats] : [],
          note: isDelete ? t('bridge.preview.deleteUndoNote') : undefined,
        };
      },
    };
  }

  // ------------------------------------------------------------------ public
  function publicPlan(plan) {
    return {
      id: plan.id,
      tool: plan.tool,
      label: plan.label,
      destructive: plan.destructive,
      createdAt: plan.createdAt,
      preview: plan.preview,
      args: summarizeArgs(plan.tool, plan.args),
    };
  }

  function summarizeArgs(tool, args) {
    const out = {};
    for (const [key, value] of Object.entries(args || {})) {
      if (key === 'values' || key === 'rows' || key === 'formulas') {
        out[key] = `${(value || []).length} rows`;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async function callTool(name, args) {
    if (!state.api) return { status: 'error', tool: name, error: t('bridge.err.notInitialized') };
    const input = args || {};
    if (READ_TOOLS[name]) {
      try {
        const result = await READ_TOOLS[name](state.api, input);
        return { status: 'done', tool: name, result };
      } catch (err) {
        return { status: 'error', tool: name, error: err.message };
      }
    }
    const mutator = MUTATORS[name];
    if (!mutator) return { status: 'error', tool: name, error: t('bridge.err.unknownTool', { name }) };

    if (mutator.writesData && input.sheet) {
      try {
        const writable = await state.api.isWritable(input.sheet);
        if (!writable) {
          return { status: 'error', tool: name, error: t('bridge.err.protected', { sheet: input.sheet }) };
        }
      } catch (err) {
        return { status: 'error', tool: name, error: err.message };
      }
    }

    let ctx;
    try {
      ctx = (await mutator.plan(state.api, input)) || {};
    } catch (err) {
      return { status: 'error', tool: name, error: err.message };
    }

    const plan = {
      id: `plan-${++state.seq}`,
      tool: name,
      args: input,
      label: typeof mutator.label === 'function' ? mutator.label(input) : mutator.label,
      preview: mutator.preview(input, ctx),
      destructive: Boolean(mutator.destructive && mutator.destructive(input, ctx)),
      ctx,
      createdAt: Date.now(),
    };

    if (state.config.autoApply) {
      state.pending.push(plan);
      const applied = await applyPlan(plan.id);
      return applied.ok
        ? { status: 'done', tool: name, result: applied.result, autoApplied: true }
        : { status: 'error', tool: name, error: applied.error };
    }

    state.pending.push(plan);
    return { status: 'pending', tool: name, plan: publicPlan(plan) };
  }

  async function applyPlan(planId) {
    const plan = state.pending.find((p) => p.id === planId);
    if (!plan) return { ok: false, error: t('bridge.err.planMissing') };
    const mutator = MUTATORS[plan.tool];
    try {
      const result = await mutator.run(state.api, plan.args);
      const undo = (mutator.undo && mutator.undo(plan.args, plan.ctx || {})) || {};
      state.journal.push({
        tool: plan.tool,
        label: plan.label,
        destructive: plan.destructive,
        summary: plan.preview.summary,
        result,
        undo: {
          calls: undo.calls || [],
          snapshots: undo.snapshots || [],
          formats: undo.formats || [],
          note: undo.note,
        },
      });
      state.pending = state.pending.filter((p) => p.id !== planId);
      persist();
      return { ok: true, result, journalId: state.journal.last().id };
    } catch (err) {
      state.pending = state.pending.filter((p) => p.id !== planId);
      return { ok: false, error: err.message };
    }
  }

  function rejectPlan(planId) {
    const plan = state.pending.find((p) => p.id === planId);
    state.pending = state.pending.filter((p) => p.id !== planId);
    return { ok: Boolean(plan), id: planId };
  }

  async function applyAll() {
    const ids = state.pending.map((p) => p.id);
    const results = [];
    for (const id of ids) {
      results.push({ id, ...(await applyPlan(id)) });
    }
    return results;
  }

  async function undoEntry(entry) {
    const undo = entry.undo || {};
    const performed = [];
    try {
      for (const call of undo.calls || []) {
        const fn = state.api[call.api];
        if (typeof fn !== 'function') throw new Error(`undo operation unavailable: ${call.api}`);
        await fn(call.args);
        performed.push(call.api);
      }
      for (const snapshot of undo.snapshots || []) {
        if (!snapshot) continue;
        await state.api.restoreSnapshot(snapshot);
        performed.push('restoreSnapshot');
      }
      for (const format of undo.formats || []) {
        if (!format) continue;
        await state.api.restoreFormat(format);
        performed.push('restoreFormat');
      }
      state.journal.remove(entry.id);
      persist();
      return { ok: true, undone: entry.label, performed, note: undo.note };
    } catch (err) {
      return {
        ok: false,
        error: t('bridge.err.undoFailed', { label: entry.label, error: err.message }),
        performed,
      };
    }
  }

  async function undoLast() {
    const entry = state.journal.last();
    if (!entry) return { ok: false, error: t('bridge.err.undoNothing') };
    return undoEntry(entry);
  }

  async function undoAll() {
    const entries = state.journal.list().reverse();
    if (!entries.length) return { ok: false, error: t('bridge.err.undoNothing') };
    const results = [];
    for (const entry of entries) {
      const outcome = await undoEntry(entry);
      results.push({ id: entry.id, label: entry.label, ...outcome });
      if (!outcome.ok) break;
    }
    return { ok: results.every((r) => r.ok), results };
  }

  function persist() {
    try {
      const settings = global.Office && global.Office.context && global.Office.context.document
        && global.Office.context.document.settings;
      if (!settings) return;
      settings.set('deepseekJournal', state.journal.toJSON());
      settings.saveAsync();
    } catch (err) {
      /* settings persistence is optional */
    }
  }

  function restoreJournal() {
    try {
      const settings = global.Office && global.Office.context && global.Office.context.document
        && global.Office.context.document.settings;
      if (!settings) return;
      const saved = settings.get('deepseekJournal');
      if (saved) state.journal = Journal.fromJSON(saved);
    } catch (err) {
      /* ignored */
    }
  }

  global.DSX = global.DSX || {};
  global.DSX.bridge = {
    init(api, config) {
      state.api = api;
      state.config = { ...state.config, ...(config || {}) };
      state.pending = [];
      restoreJournal();
      return state.config;
    },
    getConfig: () => ({ ...state.config }),
    setConfig(partial) {
      state.config = { ...state.config, ...(partial || {}) };
      return { ...state.config };
    },
    callTool,
    pendingPlans: () => state.pending.map(publicPlan),
    applyPlan,
    applyAll,
    rejectPlan,
    undoLast,
    undoAll,
    history: () => state.journal.summary(),
    journalEntries: () => state.journal.list(),
    isReady: () => Boolean(state.api),

    /**
     * Per-file personalization lives in Office document settings, so it travels inside the
     * workbook (and only that workbook). Global personalization is stored on the server.
     */
    async getFilePersonalization() {
      if (!state.api || typeof state.api.getSetting !== 'function') return '';
      const value = await state.api.getSetting('deepseekPersonalization');
      return typeof value === 'string' ? value : '';
    },
    async setFilePersonalization(text) {
      if (!state.api || typeof state.api.setSetting !== 'function') return false;
      await state.api.setSetting({ key: 'deepseekPersonalization', value: String(text || '').slice(0, 8000) });
      return true;
    },
    /** Stable id for the current workbook, created once and stored in the document. */
    async getFileId() {
      if (!state.api || typeof state.api.getSetting !== 'function') return null;
      let id = await state.api.getSetting('deepseekFileId');
      if (typeof id !== 'string' || !id) {
        id = `file:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await state.api.setSetting({ key: 'deepseekFileId', value: id });
      }
      return id;
    },
    _state: state,
  };
})(typeof self !== 'undefined' ? self : this);
