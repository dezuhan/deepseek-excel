'use strict';
/**
 * Tests for the CouchDB-style document store, the pricing/peak-hour helpers and the new
 * server APIs (chat sessions, personalization, system prompts, cost meter, pricing override).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { DocumentStore } = require('../store.js');
const pricingHelpers = require('../pricing.js');
const pricing = pricingHelpers.loadPricing(path.join(__dirname, '..', 'shared', 'pricing.json'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsx-store-'));
}

// ------------------------------------------------------------------ document store
test('document store creates, reads and bumps revisions (CouchDB semantics)', () => {
  const store = new DocumentStore(tempDir());
  const first = store.put({ _id: 'session:a', type: 'session', title: 'one' });
  assert.equal(first._rev.split('-')[0], '1');
  assert.equal(store.get('session:a').title, 'one');

  const second = store.put({ ...first, title: 'two' });
  assert.equal(second._rev.split('-')[0], '2');
  assert.equal(store.get('session:a').title, 'two');
});

test('document store rejects stale revisions with a 409 conflict', () => {
  const store = new DocumentStore(tempDir());
  const doc = store.put({ _id: 'session:b', title: 'original' });
  store.put({ ...doc, title: 'changed' });
  assert.throws(() => store.put({ ...doc, title: 'stale write' }), (err) => err.status === 409 && err.name === 'ConflictError');
  assert.equal(store.get('session:b').title, 'changed');
});

test('document store keeps tombstones and hides deleted documents', () => {
  const store = new DocumentStore(tempDir());
  const doc = store.put({ _id: 'session:c', title: 'gone' });
  const removed = store.remove('session:c', doc._rev);
  assert.equal(removed.ok, true);
  assert.equal(store.get('session:c'), null);
  assert.equal(store.getRaw('session:c')._deleted, true);
  assert.equal(store.allDocs({ limit: 10 }).rows.length, 0);
  assert.throws(() => store.remove('session:c', 'wrong-rev'), (err) => err.status === 409);
});

test('document store list supports type filters, limiting and descending order', () => {
  const store = new DocumentStore(tempDir());
  store.put({ _id: 'session:1', type: 'session' });
  store.put({ _id: 'session:2', type: 'session' });
  store.put({ _id: 'prompt:1', type: 'prompt' });
  assert.equal(store.list('session').length, 2);
  assert.equal(store.count('prompt'), 1);
  assert.equal(store.allDocs({ limit: 1 }).rows.length, 1);
  const descending = store.allDocs({ descending: true, limit: 1 }).rows[0].id;
  assert.equal(descending, 'session:2');
  assert.equal(store.allDocs({ prefix: 'prompt:' }).rows.length, 1);
});

// ------------------------------------------------------------------------- pricing
test('peak hours follow the published UTC windows (01-04 and 06-10, Monday-Friday)', () => {
  const mondayPeak = new Date('2026-09-14T02:00:00Z'); // Monday 02:00 UTC
  const mondayGap = new Date('2026-09-14T05:00:00Z'); // between the two windows
  const mondaySecondPeak = new Date('2026-09-14T07:30:00Z');
  const saturday = new Date('2026-09-19T02:00:00Z'); // Saturday is never peak
  const boundary = new Date('2026-09-14T04:00:00Z'); // window end is exclusive

  assert.equal(pricingHelpers.isPeakAt(pricing, mondayPeak), true);
  assert.equal(pricingHelpers.isPeakAt(pricing, mondayGap), false);
  assert.equal(pricingHelpers.isPeakAt(pricing, mondaySecondPeak), true);
  assert.equal(pricingHelpers.isPeakAt(pricing, saturday), false);
  assert.equal(pricingHelpers.isPeakAt(pricing, boundary), false);

  const status = pricingHelpers.peakStatus(pricing, mondayPeak);
  assert.equal(status.isPeak, true);
  assert.equal(status.nextChangeInMinutes, 120); // 02:00 -> 04:00
  assert.equal(pricingHelpers.peakStatus(pricing, mondayGap).multiplier, 0.5);
});

test('cost estimation uses peak/off-peak rates and cache-hit pricing', () => {
  const usage = { prompt_tokens: 1000000, completion_tokens: 500000 };
  const peak = pricingHelpers.estimateCost(pricing, 'deepseek-flash', usage, true);
  assert.equal(Number(peak.inputCost.toFixed(4)), 0.3);
  assert.equal(Number(peak.outputCost.toFixed(4)), 0.6);
  assert.equal(Number(peak.totalCost.toFixed(4)), 0.9);

  const offPeak = pricingHelpers.estimateCost(pricing, 'deepseek-flash', usage, false);
  assert.equal(Number(offPeak.totalCost.toFixed(4)), 0.45); // half price off-peak

  const cached = pricingHelpers.estimateCost(
    pricing,
    'deepseek-v4-pro',
    { prompt_tokens: 1000000, completion_tokens: 0, prompt_cache_hit_tokens: 1000000 },
    true,
  );
  assert.equal(Number(cached.totalCost.toFixed(4)), 0.044);
  assert.equal(cached.cacheHitTokens, 1000000);
  assert.equal(cached.cacheMissTokens, 0);

  const totals = pricingHelpers.sumUsage([peak, offPeak]);
  assert.equal(totals.requests, 2);
  assert.equal(Number(totals.totalCost.toFixed(4)), 1.35);
  assert.equal(totals.byModel['deepseek-flash'].requests, 2);
});

test('pricing file documents the DeepSeek effort levels and default', () => {
  assert.deepEqual(pricing.efforts.map((entry) => entry.id), ['off', 'low', 'high', 'max']);
  assert.equal(pricing.efforts.find((entry) => entry.id === 'off').thinking, false);
  assert.equal(pricing.efforts.find((entry) => entry.id === 'max').reasoningEffort, 'max');
  assert.equal(pricing.defaultEffort, 'high');
});

// --------------------------------------------------------------------- server API
process.env.MOCK_LLM = '1';
process.env.DSX_STORE_DIR = tempDir();
// POST /api/config persists to .env: point it at a throwaway file so the tests can never
// flip the developer's real server into mock mode (or change their model).
process.env.DSX_ENV_FILE = path.join(tempDir(), '.env');
const server = require('../server.js');

async function withServer(run) {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-dsh-pane-token': server.PANE_TOKEN },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  };
  try {
    await run(call);
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }
}

test('session API: create, list, read, update, conflict and delete', async () => {
  await withServer(async (call) => {
    const created = await call('POST', '/api/sessions', { title: 'Harness test', model: 'deepseek-flash', effort: 'low' });
    assert.equal(created.status, 201);
    const id = created.body.session._id;
    assert.equal(created.body.session.title, 'Harness test');
    assert.equal(created.body.session.effort, 'low');

    const list = await call('GET', '/api/sessions?limit=5');
    assert.equal(list.status, 200);
    assert.ok(list.body.sessions.some((session) => session.id === id));
    assert.equal(list.body.host, 'excel');

    // Raw usage is costed server side when the session is saved.
    const updated = await call('PUT', `/api/sessions/${encodeURIComponent(id)}`, {
      _rev: created.body.session._rev,
      messages: [{ role: 'user', content: 'hi' }],
      usage: [{ prompt_tokens: 1000000, completion_tokens: 0, model: 'deepseek-flash', at: '2026-09-14T02:00:00Z' }],
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.session.messages.length, 1);
    assert.equal(updated.body.session.totals.requests, 1);
    assert.equal(Number(updated.body.session.totals.totalCost.toFixed(4)), 0.3); // peak rate

    const conflict = await call('PUT', `/api/sessions/${encodeURIComponent(id)}`, { _rev: '1-stale', messages: [] });
    assert.equal(conflict.status, 409);

    const read = await call('GET', `/api/sessions/${encodeURIComponent(id)}`);
    assert.equal(read.body.session._id, id);

    const removed = await call('DELETE', `/api/sessions/${encodeURIComponent(id)}`, null);
    assert.equal(removed.status, 200);
    const missing = await call('GET', `/api/sessions/${encodeURIComponent(id)}`);
    assert.equal(missing.status, 404);
  });
});

test('personalization API stores a single global document per host', async () => {
  await withServer(async (call) => {
    const initial = await call('GET', '/api/personalization');
    assert.equal(initial.body.personalization.scope, 'global');

    const saved = await call('PUT', '/api/personalization', { text: 'Always answer in Indonesian.' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.personalization.text, 'Always answer in Indonesian.');

    const reloaded = await call('GET', '/api/personalization');
    assert.equal(reloaded.body.personalization.text, 'Always answer in Indonesian.');
    assert.ok(reloaded.body.personalization.rev);
  });
});

test('session API: a new chat already carries its first turn and its usage', async () => {
  await withServer(async (call) => {
    const created = await call('POST', '/api/sessions', {
      title: 'hi',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
      usage: [{ prompt_tokens: 1000000, completion_tokens: 0, model: 'deepseek-flash', at: '2026-09-14T02:00:00Z' }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.messages.length, 2, 'the first turn must never be dropped');
    assert.equal(created.body.session.totals.requests, 1, 'usage sent with the first turn is costed');

    const list = await call('GET', '/api/sessions?limit=5');
    const summary = list.body.sessions.find((session) => session.id === created.body.session._id);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.turnCount, 1, 'the drawer counts user turns, not raw messages');
  });
});

test('personalization API: entry list round-trip, legacy text and per-host isolation', async () => {
  await withServer(async (call) => {
    const saved = await call('PUT', '/api/personalization', {
      entries: [
        { id: 'a', title: 'Tone', text: 'Always answer in Indonesian.' },
        { id: 'b', title: '', text: 'Never touch column A.' },
      ],
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.personalization.entries.length, 2);
    assert.equal(saved.body.personalization.entries[0].title, 'Tone');
    // The composed text is what the agent receives: heading plus a blank line between entries.
    assert.equal(
      saved.body.personalization.text,
      '## Tone\nAlways answer in Indonesian.\n\nNever touch column A.',
    );

    const reloaded = await call('GET', '/api/personalization');
    assert.equal(reloaded.body.personalization.entries.length, 2);
    assert.equal(reloaded.body.personalization.text, saved.body.personalization.text);

    // An empty list clears everything but keeps the document.
    const cleared = await call('PUT', '/api/personalization', { entries: [] });
    assert.equal(cleared.body.personalization.entries.length, 0);
    assert.equal(cleared.body.personalization.text, '');
    assert.ok(cleared.body.personalization.rev);
  });
});

test('config API switches the fetch mode between live and mock at runtime', async () => {
  await withServer(async (call) => {
    const current = await call('GET', '/api/config');
    assert.equal(current.body.mock, true, 'the test server starts in mock mode');

    const live = await call('POST', '/api/config', { mock: false });
    assert.equal(live.status, 200);
    assert.equal(live.body.mock, false);
    assert.equal((await call('GET', '/api/config')).body.mock, false);

    const back = await call('POST', '/api/config', { mock: true });
    assert.equal(back.body.mock, true);
    assert.equal((await call('GET', '/api/config')).body.mock, true);
  });
});

test('prompt API seeds the system prompt document and allows fine-tuning plus reset', async () => {
  await withServer(async (call) => {
    const seeded = await call('GET', '/api/prompts?locale=en-US&host=excel');
    assert.equal(seeded.status, 200);
    assert.equal(seeded.body.active.id, 'prompt:excel:system:en-US');
    assert.ok(seeded.body.active.content.length > 500);
    assert.ok(seeded.body.prompts.some((prompt) => prompt.id === seeded.body.active.id));

    const updated = await call('PUT', `/api/prompts/${encodeURIComponent(seeded.body.active.id)}`, {
      content: 'You are a custom Excel assistant.',
    });
    assert.equal(updated.body.prompt.content, 'You are a custom Excel assistant.');

    const empty = await call('PUT', `/api/prompts/${encodeURIComponent(seeded.body.active.id)}`, { content: '   ' });
    assert.equal(empty.status, 400);

    const reset = await call('POST', '/api/prompts/reset', { locale: 'en-US', host: 'excel' });
    assert.ok(reset.body.prompt.content.length > 500);
    assert.match(reset.body.prompt.content, /DeepSeek Excel/);

    const lokalisasi = await call('GET', '/api/prompts?locale=id-ID&host=excel');
    assert.equal(lokalisasi.body.active.locale, 'id-ID');
  });
});

test('cost API reports balance (mock), pricing table and peak status', async () => {
  await withServer(async (call) => {
    const cost = await call('GET', '/api/cost');
    assert.equal(cost.status, 200);
    assert.equal(cost.body.host, 'excel');
    assert.ok(cost.body.balance, 'mock mode must return a balance payload');
    assert.equal(typeof cost.body.peak.isPeak, 'boolean');
    assert.ok(Array.isArray(cost.body.prices));
    assert.equal(cost.body.prices.length, 2);
    assert.equal(cost.body.pricing.offPeakMultiplier, 0.5);
    assert.deepEqual(cost.body.pricing.efforts.map((entry) => entry.id), ['off', 'low', 'high', 'max']);
  });
});

test('pricing override API stores a CouchDB document that is merged on read', async () => {
  await withServer(async (call) => {
    const saved = await call('PUT', '/api/pricing', {
      models: { 'deepseek-flash': { label: 'Flash (custom)', inputCacheHit: 0.001, inputCacheMiss: 0.1, output: 0.5 } },
      note: 'internal rate card',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.override.type, 'pricing-override');

    const cost = await call('GET', '/api/cost');
    const flash = cost.body.pricing.models['deepseek-flash'];
    assert.equal(flash.label, 'Flash (custom)');
    assert.equal(flash.inputCacheMiss, 0.1);
    // Untouched models keep the shipped prices.
    assert.equal(cost.body.pricing.models['deepseek-v4-pro'].output, 3.96);
  });
});

test('pane diagnostics report the store contents', async () => {
  await withServer(async (call) => {
    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.host, 'excel');
    assert.equal(typeof health.body.store.sessions, 'number');
    assert.equal(health.body.effort, 'high');
  });
});
