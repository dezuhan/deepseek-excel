'use strict';
/**
 * Static contract tests: React pane (shadcn/ui) ↔ classic pane ↔ manifest ↔ assets.
 * Catches the mistakes that most often make the task pane fail to boot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const uiDir = path.join(root, 'ui');
const distDir = path.join(root, 'dist');

const classicHtml = fs.readFileSync(path.join(publicDir, 'taskpane-classic.html'), 'utf8');
const classicUi = fs.readFileSync(path.join(publicDir, 'js', 'ui.js'), 'utf8');
const reactHtml = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- classic pane
test('classic pane: every element used by js/ui.js exists in taskpane-classic.html', () => {
  const ids = new Set([...classicHtml.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const missing = [];
  for (const match of classicUi.matchAll(/\$\('([^']+)'\)/g)) {
    if (!ids.has(match[1])) missing.push(match[1]);
  }
  assert.deepEqual(missing, [], `id hilang di taskpane-classic.html: ${missing.join(', ')}`);
});

test('classic pane: the local scripts it references actually exist', () => {
  // Served dynamically by the server: the pane token and the Markdown engine from node_modules.
  const dynamic = new Set(['/pane-token.js', '/vendor/marked.js', '/vendor/dompurify.js']);
  const missing = [];
  for (const match of classicHtml.matchAll(/<script src="([^"]+)"/g)) {
    const src = match[1];
    if (/^https?:/i.test(src) || dynamic.has(src)) continue;
    if (!fs.existsSync(path.join(publicDir, src))) missing.push(src);
  }
  for (const match of classicHtml.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    const href = match[1];
    if (/^https?:/i.test(href)) continue;
    if (!fs.existsSync(path.join(publicDir, href))) missing.push(href);
  }
  assert.deepEqual(missing, [], `aset hilang: ${missing.join(', ')}`);
});

test('classic pane is free of syntax errors', () => {
  const jsDir = path.join(publicDir, 'js');
  for (const file of fs.readdirSync(jsDir).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
    assert.doesNotThrow(() => new (require('node:vm').Script)(source, { filename: file }), `${file} gagal dikompilasi`);
  }
});

// ---------------------------------------------------------------- React pane
test('React pane: the engine is loaded before the bundle, and the pane token is included', () => {
  const scripts = [...reactHtml.matchAll(/<script([^>]*)src="([^"]+)"/g)].map((match) => match[2]);
  const order = (name) => scripts.findIndex((src) => src.endsWith(name));
  for (const engine of ['i18n.js', 'validate.js', 'journal.js', 'office-bridge.js', 'agent.js']) {
    assert.ok(order(`/js/${engine}`) >= 0, `${engine} tidak dimuat di ui/index.html`);
  }
  assert.ok(reactHtml.includes('/pane-token.js'));
  assert.ok(reactHtml.includes('src="/src/main.jsx"'), 'entry Vite tidak ditemukan');
  assert.ok(/id="pane-loading"/.test(reactHtml), 'jaring pengaman (fallback) tidak ada');
});

test('React pane: every .js/.jsx file compiles with esbuild', () => {
  const files = walk(path.join(uiDir, 'src'), (name) => name.endsWith('.js') || name.endsWith('.jsx'));
  assert.ok(files.length >= 12, `hanya ${files.length} berkas UI`);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const loader = file.endsWith('.jsx') ? 'jsx' : 'js';
    assert.doesNotThrow(
      () => esbuild.transformSync(source, { loader, jsx: 'automatic', format: 'esm' }),
      `${path.relative(root, file)} gagal dikompilasi`,
    );
  }
});

test('React pane uses the expected shadcn/ui components', () => {
  const uiComponents = fs
    .readdirSync(path.join(uiDir, 'src', 'components', 'ui'))
    .filter((name) => name.endsWith('.jsx'))
    .map((name) => name.replace('.jsx', ''));
  for (const expected of ['button', 'card', 'badge', 'separator', 'scroll-area', 'dialog', 'select', 'tooltip', 'input', 'label', 'textarea', 'switch']) {
    assert.ok(uiComponents.includes(expected), `komponen shadcn "${expected}" tidak ada`);
  }
  const button = fs.readFileSync(path.join(uiDir, 'src', 'components', 'ui', 'button.jsx'), 'utf8');
  assert.match(button, /class-variance-authority/, 'Button harus memakai cva seperti shadcn');
  assert.match(button, /data-slot="button"/, 'Button harus memakai atribut data-slot khas shadcn');

  const config = JSON.parse(fs.readFileSync(path.join(root, 'components.json'), 'utf8'));
  assert.equal(config.style, 'new-york-v4');
  assert.equal(config.tailwind.css, 'ui/src/index.css');
  assert.equal(config.aliases.ui, '@/components/ui');
});

test('the shadcn theme is installed: color tokens + dark mode in index.css', () => {
  const css = fs.readFileSync(path.join(uiDir, 'src', 'index.css'), 'utf8');
  assert.match(css, /@import "tailwindcss"/);
  assert.match(css, /@import "shadcn\/tailwind\.css"/);
  assert.match(css, /@custom-variant dark/);
  for (const token of ['--background', '--foreground', '--primary', '--muted', '--destructive', '--border', '--ring']) {
    assert.ok(css.includes(token), `token ${token} tidak ada`);
  }
  assert.match(css, /--color-background: var\(--background\)/, 'pemetaan @theme inline tidak ada');
});

test('the Vite config separates UI assets from the /assets ribbon icons', () => {
  const config = fs.readFileSync(path.join(root, 'vite.config.mjs'), 'utf8');
  assert.match(config, /assetsDir: 'ui'/, 'assetsDir harus "ui" agar tidak bentrok dengan ikon add-in');
  assert.match(config, /root: path\.join\(rootDir, 'ui'\)/);
  assert.match(config, /alias: \{ '@':/);
});

test('the build output (dist) is ready to serve when it has been built', (t) => {
  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    t.skip('dist belum dibangun (npm run build:ui)');
    return;
  }
  const built = fs.readFileSync(indexFile, 'utf8');
  assert.match(built, /\/ui\/index-[\w-]+\.js/, 'bundel JS hasil build tidak direferensikan');
  assert.match(built, /\/ui\/index-[\w-]+\.css/, 'CSS hasil build tidak direferensikan');
  assert.ok(built.includes('/pane-token.js'));
  assert.ok(built.includes('/js/office-bridge.js'), 'mesin harus tetap dimuat dari server lokal');
  assert.ok(fs.existsSync(path.join(distDir, 'ui')), 'folder dist/ui tidak ada');
});

// ---------------------------------------------------------------- manifest
test('manifest is valid: Id, Workbook host, SourceLocation, and icons available', () => {
  const id = /<Id>([0-9a-f-]{36})<\/Id>/i.exec(manifest);
  assert.ok(id, 'manifest harus punya <Id> berupa GUID');
  assert.match(manifest, /<Host Name="Workbook"\/>/);
  assert.match(manifest, /https:\/\/localhost:3000\/taskpane\.html/);
  assert.match(manifest, /<Set Name="ExcelApi" MinVersion="1\.9"\/>/);

  for (const size of [16, 32, 80]) {
    assert.ok(fs.existsSync(path.join(publicDir, 'assets', `icon-${size}.png`)), `icon-${size}.png hilang`);
  }

  const resources = manifest.slice(manifest.indexOf('<Resources>'));
  for (const match of manifest.slice(0, manifest.indexOf('<Resources>')).matchAll(/resid="([^"]+)"/g)) {
    assert.ok(resources.includes(`id="${match[1]}"`), `resid ${match[1]} tidak didefinisikan di Resources`);
  }
});

test('manifest-minimal.xml is valid too and points to the same task pane', () => {
  const minimal = fs.readFileSync(path.join(root, 'manifest-minimal.xml'), 'utf8');
  assert.match(minimal, /<Host Name="Workbook"\/>/);
  assert.match(minimal, /https:\/\/localhost:3000\/taskpane\.html/);
  assert.equal(minimal.includes('<VersionOverrides'), false);
});

// ---------------------------------------------------------------- tools
test('tools.json: every tool has a unique name and an object schema', () => {
  const tools = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'tools.json'), 'utf8'));
  const names = tools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length, 'nama tool harus unik');
  assert.ok(names.length >= 16, `diharapkan >= 16 tool, hanya ada ${names.length}`);
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    assert.ok(Array.isArray(tool.function.parameters.required), `${tool.function.name} tanpa required`);
    for (const key of tool.function.parameters.required) {
      assert.ok(tool.function.parameters.properties[key], `${tool.function.name}: properti wajib ${key} tidak dideklarasikan`);
    }
  }
});

test('every tool in tools.json is registered in the bridge (not "unknown")', async () => {
  global.self = global;
  global.DSX = {
    validate: require('../public/js/validate.js'),
    Journal: require('../public/js/journal.js').Journal,
    i18n: require('../public/js/i18n.js'),
  };
  require('../public/js/mock-api.js');
  require('../public/js/office-bridge.js');
  const bridge = global.DSX.bridge;
  bridge.init(global.DSX.mockApi, {});

  const tools = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'tools.json'), 'utf8'));
  const unknown = [];
  for (const tool of tools) {
    const name = tool.function.name;
    // eslint-disable-next-line no-await-in-loop
    const outcome = await bridge.callTool(name, {});
    if (outcome.status === 'error' && /Unknown tool/.test(outcome.error || '')) unknown.push(name);
    bridge._state.pending = [];
  }
  assert.deepEqual(unknown, [], `tool tidak terdaftar di bridge: ${unknown.join(', ')}`);
});

test('classic pane loads the Markdown engine from /vendor before its own view', () => {
  const scripts = [...classicHtml.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  const order = (needle) => scripts.findIndex((src) => src.includes(needle));
  assert.ok(order('/vendor/marked.js') >= 0, 'marked is not loaded in the classic pane');
  assert.ok(order('/vendor/dompurify.js') >= 0, 'DOMPurify is not loaded in the classic pane');
  assert.ok(order('/vendor/marked.js') < order('js/ui.js'), 'marked must load before the view');
  assert.ok(order('/vendor/dompurify.js') < order('js/ui.js'), 'DOMPurify must load before the view');
  assert.equal(/markdownLite/.test(classicUi), false, 'the hand-written renderer must be gone');
});
