'use strict';
/**
 * Tiny CouchDB-style document store.
 *
 * Documents are plain JSON files that follow the CouchDB document model:
 *   { "_id": "session:abc", "_rev": "2-9f3c1a…", "type": "session", … }
 *
 * Implemented semantics:
 *  - `_rev` is `<generation>-<md5 of the body>`; every write bumps the generation
 *  - optimistic concurrency: `put` with a stale `_rev` fails with a 409 conflict
 *  - deletes are tombstones (`_deleted: true`) so `allDocs` can skip them
 *  - `allDocs({ includeDocs, descending, limit, type })` mirrors the CouchDB view options
 *
 * The store is intentionally dependency free and file backended: it gives us the CouchDB
 * document contract (ids, revisions, conflicts, tombstones) that the project asked for,
 * without requiring a CouchDB server to be installed next to Excel.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ID_PATTERN = /^[A-Za-z0-9._:@-]{1,160}$/;

class ConflictError extends Error {
  constructor(id, rev, currentRev) {
    super(`Document update conflict for "${id}" (sent ${rev || 'no rev'}, current ${currentRev || 'none'})`);
    this.status = 409;
    this.name = 'ConflictError';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.name = 'ValidationError';
  }
}

function assertValidId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ValidationError(`Invalid document id: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Stable hash of a document body (keys sorted) so identical content yields identical revs. */
function hashBody(body) {
  const clean = { ...body };
  delete clean._rev;
  const json = JSON.stringify(clean, Object.keys(clean).sort());
  return crypto.createHash('md5').update(json).digest('hex');
}

function nextRev(previousRev, body) {
  const generation = previousRev ? Number.parseInt(String(previousRev).split('-')[0], 10) + 1 : 1;
  return `${Number.isFinite(generation) ? generation : 1}-${hashBody(body)}`;
}

function fileNameFor(id) {
  return `${encodeURIComponent(id)}.json`;
}

class DocumentStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  pathFor(id) {
    return path.join(this.directory, fileNameFor(assertValidId(id)));
  }

  /** Reads a document; returns null for missing or tombstoned documents. */
  get(id) {
    const file = this.pathFor(id);
    if (!fs.existsSync(file)) return null;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ValidationError(`Corrupted document ${id}: ${err.message}`);
    }
    if (doc._deleted) return null;
    return doc;
  }

  /** Raw read including tombstones (used by tests and cleanup tooling). */
  getRaw(id) {
    const file = this.pathFor(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /**
   * Creates or updates a document.
   * Pass `_rev` to require a specific current revision (optimistic concurrency).
   */
  put(document) {
    if (!document || typeof document !== 'object') throw new ValidationError('Document must be an object');
    const id = assertValidId(document._id);
    const existing = this.getRaw(id);
    const currentRev = existing && !existing._deleted ? existing._rev : null;
    if (document._rev !== undefined && document._rev !== currentRev) {
      throw new ConflictError(id, document._rev, currentRev);
    }
    const body = { ...document, _id: id };
    delete body._rev;
    const saved = { ...body, _rev: nextRev(currentRev, body) };
    fs.writeFileSync(this.pathFor(id), `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
    return saved;
  }

  /** Writes a tombstone so the id is never reused silently. */
  remove(id, rev) {
    const existing = this.getRaw(assertValidId(id));
    const currentRev = existing && !existing._deleted ? existing._rev : null;
    if (!existing) return { ok: true, id, rev: null };
    if (rev !== undefined && rev !== currentRev) throw new ConflictError(id, rev, currentRev);
    const tombstone = { _id: id, _rev: nextRev(currentRev, { _id: id }), _deleted: true, deletedAt: new Date().toISOString() };
    fs.writeFileSync(this.pathFor(id), `${JSON.stringify(tombstone, null, 2)}\n`, 'utf8');
    return { ok: true, id, rev: tombstone._rev };
  }

  /**
   * Lists documents (CouchDB `_all_docs` shape): rows of { id, key, value: { rev }, doc? }.
   * Sorted by id ascending unless `descending` is requested.
   */
  allDocs(options = {}) {
    const { includeDocs = false, descending = false, limit = 100, type = null, prefix = null } = options;
    const rows = [];
    for (const entry of fs.readdirSync(this.directory)) {
      if (!entry.endsWith('.json')) continue;
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(path.join(this.directory, entry), 'utf8'));
      } catch (err) {
        continue; // ignore unreadable files instead of failing the whole listing
      }
      if (doc._deleted) continue;
      if (type && doc.type !== type) continue;
      if (prefix && !String(doc._id).startsWith(prefix)) continue;
      const row = { id: doc._id, key: doc._id, value: { rev: doc._rev } };
      if (includeDocs) row.doc = doc;
      rows.push(row);
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (descending) rows.reverse();
    return { total_rows: rows.length, offset: 0, rows: rows.slice(0, Math.max(0, limit)) };
  }

  /** Convenience helper for `allDocs` with documents included. */
  list(type, options = {}) {
    return this.allDocs({ ...options, type, includeDocs: true }).rows.map((row) => row.doc);
  }

  count(type) {
    return this.allDocs({ type, limit: Number.MAX_SAFE_INTEGER }).rows.length;
  }
}

module.exports = { DocumentStore, ConflictError, ValidationError, nextRev, hashBody };
