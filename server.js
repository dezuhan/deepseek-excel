'use strict';
/**
 * DeepSeek Excel local server.
 *
 * The server's job is ONLY:
 *  - to serve the task pane + static assets over HTTPS (localhost),
 *  - to inject the pane token into the HTML (so other local processes cannot use the API key),
 *  - to forward /api/chat to api.deepseek.com with the API key from .env (the key never reaches the pane),
 *  - to cap the request size and allowlist tool names.
 *
 * There is no spreadsheet logic here: all Excel operations run in the pane through Office.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const i18n = require('./public/js/i18n.js');
const { DocumentStore } = require('./store.js');
const pricingHelpers = require('./pricing.js');
const registerStoreApi = require('./api-store.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const DIST_DIR = path.join(ROOT, 'dist');
// DSX_ENV_FILE keeps automated tests away from the developer's real .env file.
const ENV_PATH = process.env.DSX_ENV_FILE ? path.resolve(process.env.DSX_ENV_FILE) : path.join(ROOT, '.env');

// ---------------------------------------------------------------- .env loader
function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

loadEnv(ENV_PATH);

// ---------------------------------------------------------------- configuration
function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const cfg = {
  port: intFromEnv('PORT', 3000),
  host: (process.env.HOST_LABEL || 'excel').toLowerCase(),
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  effort: (process.env.DEEPSEEK_EFFORT || 'high').toLowerCase(),
  maxCellsWrite: intFromEnv('MAX_CELLS_PER_WRITE', 5000),
  maxCellsRead: intFromEnv('MAX_CELLS_PER_READ', 2000),
  maxToolIterations: intFromEnv('MAX_TOOL_ITERATIONS', 12),
  mock: process.env.MOCK_LLM === '1' || process.argv.includes('--mock'),
  debug: process.env.DEBUG_LOG === '1',
};

const FALLBACK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const PANE_TOKEN = crypto.randomUUID();
const MODEL_RE = /^[A-Za-z0-9._:-]{2,80}$/;

function debugLog(...args) {
  if (cfg.debug) console.log('[debug]', ...args.map((a) => redact(String(a))));
}

function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1***');
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** The server message language follows the x-dsh-locale header from the sidebar (default en-US). */
function localeOf(req) {
  return i18n.resolveLocale(req && req.get ? req.get('x-dsh-locale') : null);
}

function msg(locale, key, params) {
  return i18n.translate(locale, key, params);
}

function mapUpstreamError(status, bodyText, locale) {
  const body = redact(bodyText || '').slice(0, 400);
  switch (status) {
    case 400:
      return msg(locale, 'server.upstream400', { body });
    case 401:
      return msg(locale, 'server.upstream401');
    case 402:
      return msg(locale, 'server.upstream402');
    case 422:
      return msg(locale, 'server.upstream422', { body });
    case 429:
      return msg(locale, 'server.upstream429');
    case 500:
    case 502:
    case 503:
      return msg(locale, 'server.upstream5xx', { status });
    default:
      return msg(locale, 'server.upstreamUnexpected', { status, body });
  }
}

// ---------------------------------------------------------------- .env storage
function writeEnv(updates) {
  const existing = fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) : {};
  const merged = { ...existing, ...updates };
  const order = [
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_MODEL',
    'DEEPSEEK_EFFORT',
    'DEEPSEEK_BASE_URL',
    'HOST_LABEL',
    'PORT',
    'MAX_CELLS_PER_WRITE',
    'MAX_CELLS_PER_READ',
    'MAX_TOOL_ITERATIONS',
    'MOCK_LLM',
    'DEBUG_LOG',
  ];
  const lines = ['# Generated by DeepSeek Excel (scripts/setup.ps1). Do not share.', ''];
  for (const key of order) {
    if (merged[key] !== undefined) lines.push(`${key}=${merged[key]}`);
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!order.includes(key)) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, { mode: 0o600 });
  restrictAcl(ENV_PATH);
}

function restrictAcl(file) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME;
  if (!user) return;
  execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(R,W)`], (err) => {
    if (err) debugLog('icacls failed (not fatal):', err.message);
  });
}

// ---------------------------------------------------------------- tools allowlist
function loadTools() {
  const file = path.join(SHARED_DIR, 'tools.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('shared/tools.json must be an array');
  return parsed;
}

let TOOLS;
let TOOL_NAMES;
try {
  TOOLS = loadTools();
  TOOL_NAMES = new Set(TOOLS.map((t) => t.function && t.function.name).filter(Boolean));
} catch (err) {
  console.error('Failed to load shared/tools.json:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------- express
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Pane token: only the pages we serve ourselves hold this token.
app.use('/api', (req, res, next) => {
  const token = req.get('x-dsh-pane-token');
  if (!token || token !== PANE_TOKEN) {
    return res.status(401).json({ error: msg(localeOf(req), 'server.tokenInvalid') });
  }
  next();
});

// CouchDB-style document store (chat sessions, prompts, global personalization, pricing overrides)
// plus the DeepSeek cost meter (balance, peak hours, latest pricing).
// DSX_STORE_DIR lets tests (or a user) relocate the store away from the project folder.
const storeDir = process.env.DSX_STORE_DIR ? path.resolve(process.env.DSX_STORE_DIR) : path.join(ROOT, 'store');
const store = new DocumentStore(storeDir);
const pricing = pricingHelpers.loadPricing(path.join(SHARED_DIR, 'pricing.json'));
const storeApi = registerStoreApi(app, {
  store,
  pricing,
  pricingHelpers,
  i18n,
  cfg,
  localeOf,
  msg,
});

/** React task pane (shadcn/ui) produced by `npm run build:ui`. */
function builtPaneAvailable() {
  return fs.existsSync(path.join(DIST_DIR, 'index.html'));
}

function paneDiagnosticHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>DeepSeek Excel</title></head>
<body style="font:13px 'Segoe UI',system-ui,sans-serif;padding:12px;line-height:1.5">
  <strong>The React interface has not been built yet.</strong>
  <p>Run <code>npm run build:ui</code> and then reload this pane.</p>
  <p>The classic (vanilla) pane is still available: <a href="/taskpane-classic.html">/taskpane-classic.html</a></p>
</body>
</html>`;
}

app.get('/taskpane.html', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!builtPaneAvailable()) return res.type('html').send(paneDiagnosticHtml());
  res.type('html').send(fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8'));
});

// The pane token is served as a JS file (not an inline script) so we do not
// depend on the webview's inline script policy, and so the token changes
// every time the server runs.
app.get('/pane-token.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`window.__PANE_TOKEN__ = ${JSON.stringify(PANE_TOKEN)};\n`);
});

app.use('/shared', express.static(SHARED_DIR, { etag: false, maxAge: 0 }));

// Markdown engine for the classic (vanilla) pane: the same libraries the React pane bundles,
// served straight from node_modules so no copy has to be kept in sync.
const VENDOR_FILES = {
  'marked.js': path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
  'dompurify.js': path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.min.js'),
};

app.get('/vendor/:file', (req, res) => {
  const target = VENDOR_FILES[req.params.file];
  if (!target || !fs.existsSync(target)) {
    return res.status(404).type('text/plain').send('Vendor file not available. Run npm install.');
  }
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(fs.readFileSync(target, 'utf8'));
});
// Vite build assets (hashed JS/CSS). Deliberately under /ui/* so that /assets/*
// stays reserved for the add-in ribbon icons (manifest.xml).
app.use('/ui', express.static(path.join(DIST_DIR, 'ui'), { etag: false, maxAge: 0 }));
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));

app.get('/', (req, res) => res.redirect('/taskpane.html'));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    host: cfg.host,
    keyPresent: Boolean(cfg.apiKey),
    keyMasked: maskKey(cfg.apiKey),
    model: cfg.model,
    effort: cfg.effort,
    baseUrl: cfg.baseUrl,
    mock: cfg.mock,
    store: {
      sessions: store.count('session'),
      prompts: store.count('prompt'),
      globalPersonalization: Boolean(store.get(`personalization:global:${cfg.host}`)),
    },
    limits: {
      maxCellsWrite: cfg.maxCellsWrite,
      maxCellsRead: cfg.maxCellsRead,
      maxToolIterations: cfg.maxToolIterations,
    },
  });
});

app.get('/api/models', async (req, res) => {
  if (cfg.mock) return res.json({ source: 'mock', models: FALLBACK_MODELS });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = (data.data || []).map((m) => m.id).filter(Boolean);
    res.json({ source: 'upstream', models: models.length ? models : FALLBACK_MODELS });
  } catch (err) {
    debugLog('failed to fetch the model list:', err.message);
    res.json({ source: 'fallback', models: FALLBACK_MODELS, note: 'Could not reach DeepSeek; using the fallback list.' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    model: cfg.model,
    effort: cfg.effort,
    host: cfg.host,
    hasKey: Boolean(cfg.apiKey),
    keyMasked: maskKey(cfg.apiKey),
    maxCellsWrite: cfg.maxCellsWrite,
    maxCellsRead: cfg.maxCellsRead,
    maxToolIterations: cfg.maxToolIterations,
    baseUrl: cfg.baseUrl,
    mock: cfg.mock,
    efforts: pricing.efforts,
  });
});

app.post('/api/config', (req, res) => {
  const locale = localeOf(req);
  const body = req.body || {};
  const updates = {};
  const out = {};

  if (body.model !== undefined) {
    const model = String(body.model).trim();
    if (!MODEL_RE.test(model)) return res.status(400).json({ error: msg(locale, 'server.modelInvalid') });
    cfg.model = model;
    updates.DEEPSEEK_MODEL = model;
    out.model = model;
  }
  for (const [field, key, min, max] of [
    ['maxCellsWrite', 'MAX_CELLS_PER_WRITE', 10, 50000],
    ['maxCellsRead', 'MAX_CELLS_PER_READ', 10, 50000],
    ['maxToolIterations', 'MAX_TOOL_ITERATIONS', 1, 40],
  ]) {
    if (body[field] !== undefined) {
      const value = Number.parseInt(body[field], 10);
      if (!Number.isFinite(value) || value < min || value > max) {
        return res.status(400).json({ error: msg(locale, 'server.fieldRange', { field, min, max }) });
      }
      cfg[field] = value;
      updates[key] = String(value);
      out[field] = value;
    }
  }
  if (body.effort !== undefined) {
    const effort = String(body.effort).toLowerCase();
    if (!pricing.efforts.some((entry) => entry.id === effort)) {
      return res.status(400).json({ error: msg(locale, 'server.effortInvalid', { options: pricing.efforts.map((e) => e.id).join(', ') }) });
    }
    cfg.effort = effort;
    updates.DEEPSEEK_EFFORT = effort;
    out.effort = effort;
  }
  if (body.mock !== undefined) {
    cfg.mock = Boolean(body.mock);
    updates.MOCK_LLM = cfg.mock ? '1' : '0';
    out.mock = cfg.mock;
  }
  if (body.apiKey !== undefined) {
    const apiKey = String(body.apiKey).trim();
    if (apiKey && !/^[A-Za-z0-9._-]{10,200}$/.test(apiKey)) {
      return res.status(400).json({ error: msg(locale, 'server.apiKeyFormat') });
    }
    cfg.apiKey = apiKey;
    updates.DEEPSEEK_API_KEY = apiKey;
    out.hasKey = Boolean(apiKey);
    out.keyMasked = maskKey(apiKey);
  }

  try {
    if (Object.keys(updates).length) writeEnv(updates);
  } catch (err) {
    return res.status(500).json({ error: msg(locale, 'server.configWriteFailed', { error: err.message }) });
  }
  res.json({ ok: true, ...out });
});

// ---------------------------------------------------------------- chat proxy
function buildUpstreamBody(body, locale) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) throw new HttpError(400, msg(locale, 'server.messagesEmpty'));
  if (messages.length > 60) throw new HttpError(400, msg(locale, 'server.tooManyMessages'));

  const model = body.model ? String(body.model) : cfg.model;
  if (!MODEL_RE.test(model)) throw new HttpError(400, msg(locale, 'server.modelInvalid'));

  const payload = {
    model,
    messages,
    stream: body.stream === undefined ? true : Boolean(body.stream),
  };
  if (payload.stream) {
    // Usage is only reported on the last chunk when explicitly requested; the cost meter needs it.
    payload.stream_options = { include_usage: true };
  }

  // Thinking mode + effort (OpenAI format). "off" disables thinking entirely.
  const effortId = body.effort ? String(body.effort).toLowerCase() : cfg.effort;
  const effortEntry = pricing.efforts.find((entry) => entry.id === effortId);
  if (!effortEntry) {
    throw new HttpError(400, msg(locale, 'server.effortInvalid', { options: pricing.efforts.map((e) => e.id).join(', ') }));
  }
  payload.thinking = { type: effortEntry.thinking ? 'enabled' : 'disabled' };
  if (effortEntry.thinking && effortEntry.reasoningEffort) {
    payload.reasoning_effort = effortEntry.reasoningEffort;
  }

  if (body.temperature !== undefined) {
    const temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new HttpError(400, msg(locale, 'server.temperatureInvalid'));
    }
    payload.temperature = temperature;
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    if (body.tools.length > 40) throw new HttpError(400, msg(locale, 'server.tooManyTools'));
    for (const tool of body.tools) {
      const name = tool && tool.function && tool.function.name;
      if (!name || !TOOL_NAMES.has(name)) {
        throw new HttpError(400, msg(locale, 'server.toolNotAllowed', { name: name || '-' }));
      }
    }
    payload.tools = body.tools;
    if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;
  }
  return payload;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function sseWrite(res, text) {
  res.write(text);
}

async function callUpstream(payload, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 800 * attempt;
      debugLog(`upstream ${response.status}, retry #${attempt + 1} in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 15000)));
      return callUpstream(payload, attempt + 1);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/chat', async (req, res) => {
  const locale = localeOf(req);
  let payload;
  try {
    payload = buildUpstreamBody(req.body || {}, locale);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    return res.status(status).json({ error: err.message });
  }

  if (cfg.mock) return mockChat(payload, res);

  if (!cfg.apiKey) {
    return res.status(503).json({ error: msg(locale, 'server.noApiKey') });
  }

  let upstream;
  try {
    upstream = await callUpstream(payload);
  } catch (err) {
    return res.status(502).json({ error: msg(locale, 'server.unreachable', { error: err.message }) });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({ error: mapUpstreamError(upstream.status, text, locale) });
  }

  if (!payload.stream) {
    const data = await upstream.json();
    return res.json(data);
  }

  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  } catch (err) {
    debugLog('stream interrupted:', err.message);
    sseWrite(res, `data: ${JSON.stringify({ error: msg(locale, 'server.streamBroken', { error: err.message }) })}\n\n`);
  }
  res.end();
});

// ---------------------------------------------------------------- mock LLM
// Used to develop the UI without calling DeepSeek (npm run start:mock or ?mock=1).
function mockChat(payload, res) {
  const messages = payload.messages || [];
  const last = messages[messages.length - 1] || {};
  const hasToolResult = messages.some((m) => m.role === 'tool');
  const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const tools = payload.tools || [];
  const wantsWrite = /tulis|isi|buat|edit|format|hapus|tambah|ubah/i.test(String(userText));

  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();

  const write = (delta, toolCalls, finish) => {
    const chunk = {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const text = hasToolResult
    ? 'All right, I prepared the changes and I received the result. Summary: the operation ran successfully on the active workbook.'
    : wantsWrite && tools.some((t) => t.function?.name === 'write_range')
      ? 'I prepared the change plan first, so you can now click Apply.'
      : 'This is mock mode (without calling DeepSeek). I can read the workbook and propose changes; try asking to "fill A1:C3 with sample data".';

  let i = 0;
  const step = () => {
    if (i < text.length) {
      write({ content: text.slice(i, i + 24) }, null, null);
      i += 24;
      setTimeout(step, 25);
      return;
    }
    if (wantsWrite && !hasToolResult && tools.some((t) => t.function?.name === 'write_range')) {
      write(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_mock_1',
              type: 'function',
              function: {
                name: 'write_range',
                arguments: JSON.stringify({
                  sheet: 'Sheet1',
                  address: 'A1:C3',
                  mode: 'values',
                  values: [
                    ['Contoh', 'Nilai', 'Total'],
                    ['Baris 1', 10, 10],
                    ['Baris 2', 20, 20],
                  ],
                }),
              },
            },
          ],
        },
        null,
        'tool_calls',
      );
    } else {
      write({}, null, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  };
  setTimeout(step, 60);
}

// ---------------------------------------------------------------- error handler
app.use((err, req, res, next) => {
  const locale = localeOf(req);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: msg(locale, 'server.bodyTooLarge') });
  }
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  debugLog('unexpected error:', err && err.stack);
  res.status(500).json({ error: msg(locale, 'server.internal', { error: err && err.message }) });
});

// ---------------------------------------------------------------- start
async function start() {
  const devCerts = require('office-addin-dev-certs');
  let server;
  let scheme = 'https';
  try {
    const httpsOptions = await devCerts.getHttpsServerOptions();
    server = require('https').createServer(httpsOptions, app);
  } catch (err) {
    console.warn(`[warning] dev certificate unavailable (${err.message}); using http://localhost.`);
    console.warn('[warning] Excel desktop can still load it, but Office will flag the content as insecure.');
    server = require('http').createServer(app);
    scheme = 'http';
  }

  server.listen(cfg.port, '127.0.0.1', () => {
    console.log('DeepSeek Excel is ready.');
    console.log(`  Sidebar : ${scheme}://localhost:${cfg.port}/taskpane.html`);
    console.log(`  Mode    : ${cfg.mock ? 'MOCK (without DeepSeek)' : `DeepSeek (${cfg.model})`}`);
    console.log(`  API key : ${cfg.apiKey ? maskKey(cfg.apiKey) : 'NOT SET - run scripts/setup.ps1'}`);
    console.log('  Note    : the sidebar must be loaded from Excel; the pane token is regenerated on every server start.');
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, cfg, parseEnv, maskKey, mapUpstreamError, buildUpstreamBody, HttpError, PANE_TOKEN, TOOL_NAMES: () => TOOL_NAMES };
