'use strict';
/**
 * Language dictionary and translation contract tests:
 *  - both locales have exactly the same keys,
 *  - there are no empty translations,
 *  - every key used by the code actually exists in the dictionary,
 *  - every data-i18n in taskpane.html exists in the dictionary,
 *  - every icon name used by the UI exists in the Heroicons registry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const i18n = require('../public/js/i18n.js');
const heroicons = require('../public/js/heroicons.js');

const NAMESPACES = [
  'app', 'role', 'status', 'welcome', 'composer', 'footer', 'msg', 'plan', 'quick',
  'banner', 'settings', 'lang', 'tool', 'bridge', 'api', 'validate', 'client', 'agent', 'server',
];

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

function sourceFiles() {
  const jsDir = path.join(root, 'public', 'js');
  const files = fs
    .readdirSync(jsDir)
    .filter((name) => name.endsWith('.js') && name !== 'i18n.js' && name !== 'heroicons.js')
    .map((name) => path.join(jsDir, name));
  // The React task pane (shadcn/ui) uses the same keys too.
  files.push(...walk(path.join(root, 'ui', 'src'), (name) => name.endsWith('.js') || name.endsWith('.jsx')));
  files.push(path.join(root, 'server.js'));
  return files;
}

test('the default locale is en-US and id-ID is supported', () => {
  assert.equal(i18n.DEFAULT_LOCALE, 'en-US');
  assert.deepEqual(i18n.SUPPORTED_LOCALES, ['en-US', 'id-ID']);
  assert.equal(i18n.getLocale(), 'en-US');
});

test('both locales have exactly the same keys', () => {
  assert.deepEqual(i18n.missingKeys('id-ID'), [], 'key yang belum diterjemahkan ke id-ID');
  assert.deepEqual(i18n.extraKeys('id-ID'), [], 'key yang hanya ada di id-ID');
});

test('there are no empty translations and the system prompt is long enough', () => {
  for (const locale of i18n.SUPPORTED_LOCALES) {
    for (const [key, value] of Object.entries(i18n.messages[locale])) {
      assert.equal(typeof value, 'string', `${locale}/${key} bukan string`);
      assert.ok(value.trim().length > 0, `${locale}/${key} kosong`);
    }
    assert.ok(i18n.messages[locale]['agent.system'].length > 500, `${locale}: system prompt terlalu pendek`);
  }
  assert.notEqual(i18n.messages['en-US']['agent.system'], i18n.messages['id-ID']['agent.system']);
});

test('resolveLocale handles language code variations', () => {
  assert.equal(i18n.resolveLocale('id-ID'), 'id-ID');
  assert.equal(i18n.resolveLocale('id'), 'id-ID');
  assert.equal(i18n.resolveLocale('in'), 'id-ID');
  assert.equal(i18n.resolveLocale('ID_id'), 'id-ID');
  assert.equal(i18n.resolveLocale('en-GB'), 'en-US');
  assert.equal(i18n.resolveLocale('en'), 'en-US');
  assert.equal(i18n.resolveLocale('fr-FR'), 'en-US');
  assert.equal(i18n.resolveLocale(''), 'en-US');
  assert.equal(i18n.resolveLocale(undefined), 'en-US');
});

test('detectLocale uses the correct priority order', () => {
  assert.equal(i18n.detectLocale({ paramLocale: 'id-ID', storedLocale: 'en-US' }), 'id-ID');
  assert.equal(i18n.detectLocale({ storedLocale: 'id-ID', officeLocale: 'en-US' }), 'id-ID');
  assert.equal(i18n.detectLocale({ officeLocale: 'id-ID', browserLocale: 'en-US' }), 'id-ID');
  assert.equal(i18n.detectLocale({ browserLocale: 'id-ID' }), 'id-ID');
  assert.equal(i18n.detectLocale({}), 'en-US');
});

test('t performs interpolation and fallback', () => {
  i18n.setLocale('en-US');
  assert.equal(i18n.t('plan.apply'), 'Apply');
  assert.equal(i18n.t('footer.changes', { count: 3, label: 'Write values' }), '3 changes · last: Write values');
  // a placeholder without a value is left as-is
  assert.match(i18n.t('footer.changes', { count: 1 }), /\{label\}/);
  // an unknown key is returned as-is so it is easy to spot
  assert.equal(i18n.t('tidak.ada.key'), 'tidak.ada.key');

  i18n.setLocale('id-ID');
  assert.equal(i18n.t('plan.apply'), 'Terapkan');
  assert.equal(i18n.translate('en-US', 'plan.apply'), 'Apply');
  i18n.setLocale('en-US');
});

test('tool statuses used by the agent have translations in every locale', () => {
  const statuses = ['pending', 'ok', 'applied', 'applied_auto', 'failed', 'rejected_by_user'];
  for (const locale of i18n.SUPPORTED_LOCALES) {
    for (const status of statuses) {
      const key = `tool.status.${status}`;
      assert.ok(i18n.messages[locale][key], `${locale} kehilangan ${key}`);
    }
  }
});

test('every i18n key used by the code exists in the dictionary', () => {
  const missing = [];
  const pattern = new RegExp(`(['"])((?:${NAMESPACES.join('|')})\\.[a-zA-Z0-9_.\\-]+)\\1`, 'g');
  // Some literals are dynamic prefixes (for example `quick.analysis` + `.label` / `.prompt`).
  const isDynamicPrefix = (locale, key) =>
    Object.keys(i18n.messages[locale]).some((candidate) => candidate.startsWith(`${key}.`));
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const key = match[2];
      for (const locale of i18n.SUPPORTED_LOCALES) {
        if (!i18n.messages[locale][key] && !isDynamicPrefix(locale, key)) {
          missing.push(`${path.basename(file)}: ${key} (${locale})`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `key i18n tidak ditemukan:\n${missing.join('\n')}`);
});

test('every data-i18n in the classic taskpane exists in the dictionary', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'taskpane-classic.html'), 'utf8');
  const missing = [];
  for (const match of html.matchAll(/data-i18n(?:-html|-placeholder|-title)?="([^"]+)"/g)) {
    const key = match[1];
    for (const locale of i18n.SUPPORTED_LOCALES) {
      if (!i18n.messages[locale][key]) missing.push(`${key} (${locale})`);
    }
  }
  assert.deepEqual(missing, [], `data-i18n tanpa terjemahan: ${missing.join(', ')}`);
});

test('the pane HTML carries no hardcoded Indonesian text', () => {
  for (const file of ['public/taskpane-classic.html', 'ui/index.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    for (const word of ['Kirim', 'Setelan', 'Terapkan', 'Batalkan', 'Menghubungkan', 'Kamu']) {
      assert.equal(withoutScripts.includes(word), false, `teks "${word}" masih hardcoded di ${file}`);
    }
  }
});

test('the React UI uses icons from the generated barrel, not free-form names', () => {
  const barrel = require('../ui/src/lib/icons.js');
  assert.ok(Object.keys(barrel.icons).length >= 20, 'barrel ikon terlalu sedikit');
  const used = new Set();
  for (const file of walk(path.join(root, 'ui', 'src'), (name) => name.endsWith('.jsx') || name.endsWith('.js'))) {
    if (file.endsWith(path.join('lib', 'icons.js'))) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/icons\.([A-Za-z]+)/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 5, `hanya ${used.size} ikon dipakai`);
  for (const name of used) {
    assert.ok(barrel.icons[name], `ikon "${name}" tidak ada di ui/src/lib/icons.js`);
  }
});

test('all icon names used by the UI are available in the Heroicons registry', () => {
  const names = new Set(heroicons.names);
  const used = new Set();
  const files = sourceFiles().filter((file) => file.endsWith('ui.js'));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/sv\('([a-zA-Z]+)'/g)) used.add(match[1]);
    for (const match of source.matchAll(/setIcon\('[^']+',\s*'([a-zA-Z]+)'\)/g)) used.add(match[1]);
    for (const match of source.matchAll(/'([a-zA-Z]+)':\s*'(?:toolRead|toolWrite|chart|table|document|toolCall)'/g)) used.add(match[1]);
  }
  used.add('warning');
  used.add('info');
  used.add('checkCircle');
  for (const name of used) {
    assert.ok(names.has(name), `ikon "${name}" tidak ada di registry Heroicons`);
  }
  assert.ok(names.size >= 20, `registry Heroicons terlalu sedikit: ${names.size}`);
});
