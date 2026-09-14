/**
 * Change journal + undo plans. Kept in memory and serializable
 * to Office.context.document.settings so the history survives a pane reload.
 *
 * Shape of one entry:
 * {
 *   id, ts, tool, label, destructive, summary,
 *   undo: { calls: [{api, args}], snapshots: [snapshot], formats: [formatSnapshot], note }
 * }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.DSX = root.DSX || {};
    root.DSX.Journal = factory().Journal;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class Journal {
    constructor(options) {
      const opts = options || {};
      this.limit = opts.limit || 25;
      this.maxBytes = opts.maxBytes || 500000;
      this.entries = [];
      this.seq = 0;
    }

    push(entry) {
      this.seq += 1;
      const item = Object.assign({ id: `op-${this.seq}`, ts: Date.now() }, entry);
      this.entries.push(item);
      this.trim();
      return item;
    }

    trim() {
      while (this.entries.length > this.limit) this.entries.shift();
      while (this.entries.length > 1 && this.byteSize() > this.maxBytes) this.entries.shift();
    }

    byteSize() {
      try {
        return JSON.stringify(this.entries).length;
      } catch (err) {
        return this.maxBytes + 1;
      }
    }

    list() {
      return this.entries.slice();
    }

    get(id) {
      return this.entries.find((e) => e.id === id) || null;
    }

    last() {
      return this.entries.length ? this.entries[this.entries.length - 1] : null;
    }

    remove(id) {
      const before = this.entries.length;
      this.entries = this.entries.filter((e) => e.id !== id);
      return this.entries.length < before;
    }

    clear() {
      this.entries = [];
    }

    summary() {
      return {
        count: this.entries.length,
        last: this.last(),
        entries: this.entries.map((e) => ({
          id: e.id,
          ts: e.ts,
          tool: e.tool,
          label: e.label,
          destructive: Boolean(e.destructive),
        })),
      };
    }

    toJSON() {
      return { seq: this.seq, entries: this.entries };
    }

    static fromJSON(data) {
      const journal = new Journal();
      if (!data || !Array.isArray(data.entries)) return journal;
      journal.seq = Number(data.seq) || data.entries.length;
      journal.entries = data.entries.slice(-journal.limit);
      return journal;
    }
  }

  return { Journal };
});
