'use strict';
/**
 * CouchDB-style store API for the task pane.
 *
 * Surfaces (all behind the pane-token middleware in server.js):
 *   /api/sessions            list / create         (chat history)
 *   /api/sessions/:id        read / update / delete
 *   /api/personalization     global personalization document
 *   /api/prompts             system prompt documents (fine-tuning surface)
 *   /api/cost                balance + pricing + peak status + session totals
 *   /api/pricing             merged pricing document (file + stored override)
 *
 * File-scoped personalization intentionally does NOT live here: it travels with the
 * document inside Office document settings, so it is only visible in that workbook.
 */
const crypto = require('crypto');

const MAX_PERSONALIZATION_CHARS = 8000;
const MAX_TITLE_CHARS = 120;
const BALANCE_TTL_MS = 60_000;

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

module.exports = function registerStoreApi(app, deps) {
  const { store, pricing, pricingHelpers, i18n, cfg, localeOf, msg, seedPricingOverride } = deps;

  let balanceCache = { at: 0, value: null, error: null };

  function newId(prefix) {
    return `${prefix}:${cfg.host}:${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  function sanitizeText(value, max) {
    return String(value === undefined || value === null ? '' : value).slice(0, max);
  }

  function summary(doc) {
    return {
      id: doc._id,
      rev: doc._rev,
      title: doc.title || '',
      host: doc.host || cfg.host,
      fileId: doc.fileId || null,
      model: doc.model || cfg.model,
      effort: doc.effort || cfg.effort,
      messageCount: Array.isArray(doc.messages) ? doc.messages.length : 0,
      turnCount: Array.isArray(doc.messages) ? doc.messages.filter((m) => m && m.role === 'user').length : 0,
      createdAt: doc.createdAt || null,
      updatedAt: doc.updatedAt || null,
      totals: doc.totals || null,
    };
  }

  function mergedPricing() {
    const override = store.get('pricing:override');
    if (!override) return pricing;
    // Drop undefined keys: a partial override must never erase base pricing fields.
    const clean = Object.fromEntries(
      Object.entries(override).filter(([, value]) => value !== undefined && value !== null),
    );
    return {
      ...pricing,
      ...clean,
      models: { ...pricing.models, ...(clean.models || {}) },
    };
  }

  // ---------------------------------------------------------------- sessions
  app.get('/api/sessions', (req, res) => {
    const limit = clampInt(req.query.limit, 1, 200, 30);
    const sessions = store.list('session', { limit, descending: true }).map(summary);
    res.json({ sessions, total: store.count('session'), host: cfg.host });
  });

  /**
   * Shared by POST and PUT: any field the client sends is applied to the stored document.
   * Messages sent while creating the session are kept, so a fresh chat never reports 0 turns.
   */
  function applySessionUpdate(doc, body) {
    const next = {
      ...doc,
      _rev: body._rev !== undefined ? body._rev : doc._rev,
      updatedAt: new Date().toISOString(),
    };
    if (body.title !== undefined) next.title = sanitizeText(body.title, MAX_TITLE_CHARS).trim() || doc.title;
    if (Array.isArray(body.messages)) next.messages = body.messages;
    if (Array.isArray(body.usage)) {
      // Raw usage records are costed here (single source of truth for pricing and peak hours).
      const currentPricing = mergedPricing();
      next.usage = body.usage.map((record) => {
        const when = record.at ? new Date(record.at) : new Date();
        const modelId = record.model || cfg.model;
        const costed = pricingHelpers.estimateCost(
          currentPricing,
          modelId,
          record,
          pricingHelpers.isPeakAt(currentPricing, when),
        );
        return {
          ...(costed || { model: modelId, currency: currentPricing.currency }),
          at: when.toISOString(),
          effort: record.effort || cfg.effort,
        };
      });
      next.totals = pricingHelpers.sumUsage(next.usage);
    }
    if (body.model !== undefined) next.model = sanitizeText(body.model, 80);
    if (body.effort !== undefined) next.effort = sanitizeText(body.effort, 20);
    if (body.fileId !== undefined) next.fileId = body.fileId ? sanitizeText(body.fileId, 200) : null;
    return next;
  }

  app.post('/api/sessions', (req, res) => {
    const body = req.body || {};
    const now = new Date().toISOString();
    const title = sanitizeText(body.title, MAX_TITLE_CHARS).trim();
    const base = {
      _id: newId('session'),
      type: 'session',
      host: cfg.host,
      title: title || msg(localeOf(req), 'session.untitled'),
      fileId: body.fileId ? sanitizeText(body.fileId, 200) : null,
      model: body.model ? sanitizeText(body.model, 80) : cfg.model,
      effort: body.effort ? sanitizeText(body.effort, 20) : cfg.effort,
      createdAt: now,
      updatedAt: now,
      messages: [],
      usage: [],
      totals: pricingHelpers.sumUsage([]),
    };
    res.status(201).json({ session: store.put(applySessionUpdate(base, body)) });
  });

  app.get('/api/sessions/:id', (req, res) => {
    const doc = store.get(req.params.id);
    if (!doc || doc.type !== 'session') {
      return res.status(404).json({ error: msg(localeOf(req), 'session.notFound') });
    }
    res.json({ session: doc });
  });

  app.put('/api/sessions/:id', (req, res) => {
    const existing = store.get(req.params.id);
    if (!existing || existing.type !== 'session') {
      return res.status(404).json({ error: msg(localeOf(req), 'session.notFound') });
    }
    res.json({ session: store.put(applySessionUpdate(existing, req.body || {})) });
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const existing = store.get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: msg(localeOf(req), 'session.notFound') });
    }
    const rev = req.query.rev ? String(req.query.rev) : undefined;
    res.json(store.remove(req.params.id, rev));
  });

  // --------------------------------------------------------- personalization
  const MAX_PERSONALIZATION_ENTRIES = 12;

  /** Reads either the entry list or the legacy single-text shape into a normalized list. */
  function normalizeEntries(doc) {
    if (!doc) return [];
    if (Array.isArray(doc.entries) && doc.entries.length) {
      return doc.entries
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry, index) => ({
          id: sanitizeText(entry.id, 64).trim() || `entry-${index + 1}`,
          title: sanitizeText(entry.title, MAX_TITLE_CHARS).trim(),
          text: sanitizeText(entry.text, MAX_PERSONALIZATION_CHARS),
        }))
        .filter((entry) => entry.text || entry.title)
        .slice(0, MAX_PERSONALIZATION_ENTRIES);
    }
    if (typeof doc.text === 'string' && doc.text.trim()) {
      return [{ id: 'entry-1', title: '', text: doc.text }];
    }
    return [];
  }

  /** The composed text is what the agent receives: headings plus a blank line between entries. */
  function composeEntries(entries) {
    return (entries || [])
      .map((entry) => [entry.title ? `## ${entry.title}` : '', entry.text].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  }

  function personalizationPayload(doc) {
    const entries = normalizeEntries(doc);
    return {
      text: composeEntries(entries),
      entries,
      updatedAt: doc ? doc.updatedAt || null : null,
      rev: doc ? doc._rev : null,
      scope: 'global',
      host: cfg.host,
    };
  }

  app.get('/api/personalization', (req, res) => {
    res.json({ personalization: personalizationPayload(store.get(`personalization:global:${cfg.host}`)) });
  });

  app.put('/api/personalization', (req, res) => {
    const body = req.body || {};
    let entries;
    if (Array.isArray(body.entries)) {
      entries = body.entries
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry, index) => ({
          id: sanitizeText(entry.id, 64).trim() || `entry-${index + 1}`,
          title: sanitizeText(entry.title, MAX_TITLE_CHARS).trim(),
          text: sanitizeText(entry.text, MAX_PERSONALIZATION_CHARS),
        }))
        .filter((entry) => entry.text || entry.title)
        .slice(0, MAX_PERSONALIZATION_ENTRIES);
    } else {
      const text = sanitizeText(body.text, MAX_PERSONALIZATION_CHARS);
      entries = text.trim() ? [{ id: 'entry-1', title: '', text }] : [];
    }
    const id = `personalization:global:${cfg.host}`;
    const existing = store.get(id);
    const saved = store.put({
      _id: id,
      _rev: existing ? existing._rev : undefined,
      type: 'personalization',
      scope: 'global',
      host: cfg.host,
      entries,
      text: composeEntries(entries),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    res.json({ personalization: personalizationPayload(saved) });
  });

  // ---------------------------------------------------------------- prompts
  function promptId(locale, host) {
    return `prompt:${host}:system:${locale}`;
  }

  function ensurePrompt(locale, host) {
    const id = promptId(locale, host);
    const existing = store.get(id);
    if (existing) return existing;
    const content =
      (i18n.messages[locale] && i18n.messages[locale]['agent.system']) ||
      i18n.messages[i18n.DEFAULT_LOCALE]['agent.system'] ||
      '';
    const now = new Date().toISOString();
    return store.put({
      _id: id,
      type: 'prompt',
      scope: 'global',
      host,
      locale,
      name: 'system',
      content,
      seededFrom: `i18n:agent.system:${locale}`,
      createdAt: now,
      updatedAt: now,
    });
  }

  function promptSummary(doc) {
    return {
      id: doc._id,
      rev: doc._rev,
      host: doc.host,
      locale: doc.locale,
      name: doc.name,
      characters: (doc.content || '').length,
      updatedAt: doc.updatedAt,
      seededFrom: doc.seededFrom || null,
    };
  }

  app.get('/api/prompts', (req, res) => {
    const host = sanitizeText(req.query.host, 40) || cfg.host;
    const locale = i18n.resolveLocale(req.query.locale || localeOf(req));
    const active = ensurePrompt(locale, host);
    const prompts = store.list('prompt', { limit: 50, descending: true }).map(promptSummary);
    res.json({ active: { ...promptSummary(active), content: active.content }, prompts });
  });

  app.put('/api/prompts/:id', (req, res) => {
    const existing = store.get(req.params.id);
    if (!existing || existing.type !== 'prompt') {
      return res.status(404).json({ error: msg(localeOf(req), 'prompt.notFound') });
    }
    const content = sanitizeText((req.body || {}).content, 20000);
    if (!content.trim()) {
      return res.status(400).json({ error: msg(localeOf(req), 'prompt.empty') });
    }
    const saved = store.put({ ...existing, content, updatedAt: new Date().toISOString() });
    res.json({ prompt: { ...promptSummary(saved), content: saved.content } });
  });

  app.post('/api/prompts/reset', (req, res) => {
    const host = sanitizeText((req.body || {}).host, 40) || cfg.host;
    const locale = i18n.resolveLocale((req.body || {}).locale || localeOf(req));
    const id = promptId(locale, host);
    const existing = store.get(id);
    if (existing) store.remove(id, existing._rev);
    const seeded = ensurePrompt(locale, host);
    res.json({ prompt: { ...promptSummary(seeded), content: seeded.content } });
  });

  // ------------------------------------------------------------- cost meter
  async function fetchBalance() {
    if (!cfg.apiKey) throw new Error('missing API key');
    const response = await fetch(`${cfg.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  app.get('/api/cost', async (req, res) => {
    const locale = localeOf(req);
    const currentPricing = mergedPricing();
    const peak = pricingHelpers.peakStatus(currentPricing);

    let balance = null;
    let balanceError = null;
    if (cfg.mock) {
      balance = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }], mock: true };
    } else if (!cfg.apiKey) {
      balanceError = msg(locale, 'cost.noKey');
    } else if (Date.now() - balanceCache.at < BALANCE_TTL_MS) {
      balance = balanceCache.value;
      balanceError = balanceCache.error;
    } else {
      try {
        balance = await fetchBalance();
      } catch (err) {
        balanceError = msg(locale, 'cost.balanceFailed', { error: err.message });
      }
      balanceCache = { at: Date.now(), value: balance, error: balanceError };
    }

    const session = req.query.session ? store.get(String(req.query.session)) : null;
    res.json({
      host: cfg.host,
      model: cfg.model,
      effort: cfg.effort,
      balance,
      balanceError,
      peak,
      pricing: {
        version: currentPricing.version,
        source: currentPricing.source,
        currency: currentPricing.currency,
        unit: currentPricing.unit,
        updatedAt: currentPricing.updatedAt,
        offPeakMultiplier: currentPricing.offPeakMultiplier,
        peakWindowsUtc: currentPricing.peakWindowsUtc,
        peakWeekdaysUtc: currentPricing.peakWeekdaysUtc,
        models: currentPricing.models,
        efforts: currentPricing.efforts,
        defaultEffort: currentPricing.defaultEffort,
      },
      prices: Object.keys(currentPricing.models).map((id) => pricingHelpers.priceFor(currentPricing, id, peak.isPeak)),
      sessionTotals: session ? session.totals || null : null,
    });
  });

  app.get('/api/pricing', (req, res) => {
    res.json({ pricing: mergedPricing(), override: store.get('pricing:override') || null });
  });

  app.put('/api/pricing', (req, res) => {
    const body = req.body || {};
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: msg(localeOf(req), 'pricing.invalid') });
    }
    const existing = store.get('pricing:override');
    const patch = { models: body.models || (existing && existing.models) || {} };
    if (body.peakWindowsUtc || (existing && existing.peakWindowsUtc)) {
      patch.peakWindowsUtc = body.peakWindowsUtc || existing.peakWindowsUtc;
    }
    if (body.peakWeekdaysUtc || (existing && existing.peakWeekdaysUtc)) {
      patch.peakWeekdaysUtc = body.peakWeekdaysUtc || existing.peakWeekdaysUtc;
    }
    if (body.offPeakMultiplier || (existing && existing.offPeakMultiplier)) {
      patch.offPeakMultiplier = body.offPeakMultiplier || existing.offPeakMultiplier;
    }
    patch.note = sanitizeText(body.note, 500) || (existing && existing.note) || '';
    patch.updatedAt = new Date().toISOString();
    const saved = store.put({
      _id: 'pricing:override',
      _rev: existing ? existing._rev : undefined,
      type: 'pricing-override',
      ...patch,
      createdAt: existing ? existing.createdAt : patch.updatedAt,
    });
    res.json({ override: saved });
  });

  if (typeof seedPricingOverride === 'function') seedPricingOverride(store);

  return { ensurePrompt, mergedPricing };
};
