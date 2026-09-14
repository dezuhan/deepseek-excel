'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Mock mode: /api/chat does not call DeepSeek so the test can run offline.
process.env.MOCK_LLM = '1';
const server = require('../server.js');

test('parseEnv ignores comments and strips quotes', () => {
  const parsed = server.parseEnv([
    '# komentar',
    'DEEPSEEK_API_KEY=sk-abc123',
    'DEEPSEEK_MODEL="deepseek-flash"',
    "BASE_URL='https://api.deepseek.com'",
    'baris tanpa sama dengan',
    '',
  ].join('\n'));
  assert.equal(parsed.DEEPSEEK_API_KEY, 'sk-abc123');
  assert.equal(parsed.DEEPSEEK_MODEL, 'deepseek-flash');
  assert.equal(parsed.BASE_URL, 'https://api.deepseek.com');
  assert.equal(Object.keys(parsed).length, 3);
});

test('maskKey never leaks the full key', () => {
  const masked = server.maskKey('sk-1234567890abcdef');
  assert.equal(masked, 'sk-…cdef');
  assert.equal(server.maskKey(''), '');
  assert.equal(server.maskKey('pendek'), '****');
});

test('buildUpstreamBody rejects a tool outside the allowlist', () => {
  assert.throws(
    () => server.buildUpstreamBody({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'hapus_semua' } }],
    }),
    /disallowed/,
  );
});

test('buildUpstreamBody validates messages, model, and temperature', () => {
  assert.throws(() => server.buildUpstreamBody({ messages: [] }), /must not be empty/);
  assert.throws(
    () => server.buildUpstreamBody({ messages: Array.from({ length: 61 }, () => ({ role: 'user', content: 'x' })) }),
    /max 60/,
  );
  assert.throws(
    () => server.buildUpstreamBody({ messages: [{ role: 'user', content: 'x' }], temperature: 9 }),
    /temperature/,
  );
  assert.throws(
    () => server.buildUpstreamBody({ messages: [{ role: 'user', content: 'x' }], model: 'nama model aneh!' }),
    /Invalid model name/,
  );

  const ok = server.buildUpstreamBody({
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'read_range', parameters: {} } }],
  });
  assert.equal(ok.stream, true);
  assert.equal(ok.tools.length, 1);
});

test('the /api endpoint rejects a request without a pane token', async (t) => {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const unauthorized = await fetch(`${base}/api/health`);
  assert.equal(unauthorized.status, 401);
  const body = await unauthorized.json();
  assert.match(body.error, /Invalid pane token/);

  const authorized = await fetch(`${base}/api/health`, { headers: { 'x-dsh-pane-token': server.PANE_TOKEN } });
  assert.equal(authorized.status, 200);
  const health = await authorized.json();
  assert.equal(health.ok, true);
  assert.equal(health.mock, true);
  assert.equal(health.limits.maxCellsWrite > 0, true);
});

test('the pane token is served via /pane-token.js and taskpane.html has no inline token', async (t) => {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const page = await fetch(`${base}/taskpane.html`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/pane-token.js'));
  assert.equal(html.includes(server.PANE_TOKEN), false, 'token tidak boleh tertanam di HTML');

  const tokenScript = await fetch(`${base}/pane-token.js`);
  assert.equal(tokenScript.status, 200);
  assert.match(tokenScript.headers.get('content-type'), /javascript/);
  const js = await tokenScript.text();
  assert.ok(js.includes(`window.__PANE_TOKEN__ = ${JSON.stringify(server.PANE_TOKEN)};`));
});

test('/api/chat uses mock mode and streams SSE', async (t) => {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-pane-token': server.PANE_TOKEN },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'halo' }], stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /data: /);
  assert.match(text, /\[DONE\]/);
});

test('/api/chat rejects an unknown tool before touching upstream', async (t) => {  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-pane-token': server.PANE_TOKEN },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'halo' }],
      tools: [{ type: 'function', function: { name: 'format_disk' } }],
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /disallowed/);
});

test('server messages follow the x-dsh-locale header (en-US default, id-ID available)', async (t) => {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const english = await fetch(`${base}/api/health`);
  assert.equal(english.status, 401);
  assert.match((await english.json()).error, /Invalid pane token/);

  const indonesian = await fetch(`${base}/api/health`, { headers: { 'x-dsh-locale': 'id-ID' } });
  assert.equal(indonesian.status, 401);
  assert.match((await indonesian.json()).error, /Token pane/);

  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-pane-token': server.PANE_TOKEN,
      'x-dsh-locale': 'id-ID',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'halo' }],
      tools: [{ type: 'function', function: { name: 'format_disk' } }],
    }),
  });
  assert.equal(chat.status, 400);
  assert.match((await chat.json()).error, /tidak dikenal/);
});

test('the classic pane is still available as a rollback', async (t) => {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const response = await fetch(`${base}/taskpane-classic.html`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /PANE KLASIK/);
  assert.ok(html.includes('js/ui.js'), 'pane klasik harus memuat view vanilla');
});

test('Vite build assets are served under /ui/*', async (t) => {
  const indexFile = path.join(__dirname, '..', 'dist', 'index.html');
  if (!fs.existsSync(indexFile)) {
    t.skip('dist belum dibangun');
    return;
  }
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const page = await fetch(`${base}/taskpane.html`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/pane-token.js'));

  const jsMatch = /\/ui\/(index-[\w-]+\.js)/.exec(html);
  const cssMatch = /\/ui\/(index-[\w-]+\.css)/.exec(html);
  assert.ok(jsMatch, 'bundel JS tidak direferensikan');
  assert.ok(cssMatch, 'bundel CSS tidak direferensikan');

  const jsResponse = await fetch(`${base}/ui/${jsMatch[1]}`);
  assert.equal(jsResponse.status, 200);
  assert.match(jsResponse.headers.get('content-type'), /javascript/);
  const cssResponse = await fetch(`${base}/ui/${cssMatch[1]}`);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get('content-type'), /css/);
});

test('ribbon icons under /assets/* are not overwritten by build assets', async (t) => {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  const icon = await fetch(`${base}/assets/icon-32.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
});

test('Markdown engine files are served for the classic pane', async (t) => {
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.address().port}`;

  for (const file of ['marked.js', 'dompurify.js']) {
    const response = await fetch(`${base}/vendor/${file}`);
    assert.equal(response.status, 200, `${file} must be served`);
    assert.match(response.headers.get('content-type'), /javascript/);
    const body = await response.text();
    assert.ok(body.length > 5000, `${file} looks empty`);
  }

  const missing = await fetch(`${base}/vendor/not-a-library.js`);
  assert.equal(missing.status, 404);
});
