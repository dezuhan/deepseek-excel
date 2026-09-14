'use strict';
/**
 * Project naming tests: "DeepSeek Excell by dezuhan" as the project name,
 * while the name inside Excel stays "DeepSeek Excel", plus the GitHub details.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');
const manifestMinimal = fs.readFileSync(path.join(root, 'manifest-minimal.xml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const i18n = require('../public/js/i18n.js');

test('package.json uses the project name "deepseek-excell-by-dezuhan" and credits dezuhan', () => {
  // The npm name cannot contain uppercase letters or spaces, so an npm-safe version is used.
  assert.equal(pkg.name, 'deepseek-excell-by-dezuhan');
  assert.match(pkg.description, /DeepSeek Excell by dezuhan/);
  assert.match(pkg.author, /dezuhan/);
  assert.match(pkg.author, /github\.com\/dezuhan/);
  assert.equal(pkg.homepage, 'https://github.com/dezuhan');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
});

test('the add-in name inside Excel stays "DeepSeek Excel"', () => {
  for (const source of [manifest, manifestMinimal]) {
    assert.match(source, /<DisplayName DefaultValue="DeepSeek Excel"\/>/);
    assert.equal(/DeepSeek Excell/.test(source), false, 'nama proyek tidak boleh masuk ke manifest');
  }
  assert.match(manifest, /<bt:String id="Button\.Label" DefaultValue="DeepSeek Excel">/);
  assert.match(manifest, /<bt:String id="Group\.Label" DefaultValue="DeepSeek Excel"\/>/);
});

test('manifest lists the provider and SupportUrl pointing to dezuhan on GitHub', () => {
  for (const source of [manifest, manifestMinimal]) {
    assert.match(source, /<ProviderName>dezuhan<\/ProviderName>/);
    assert.match(source, /<SupportUrl DefaultValue="https:\/\/github\.com\/dezuhan"\/>/);
  }
});

test('the language dictionary carries the project name and GitHub link in both locales', () => {
  for (const locale of i18n.SUPPORTED_LOCALES) {
    assert.equal(i18n.messages[locale]['app.project'], 'DeepSeek Excell by dezuhan');
    assert.equal(i18n.messages[locale]['about.github'], 'github.com/dezuhan');
    assert.ok(i18n.messages[locale]['settings.about'], `${locale} kehilangan settings.about`);
    // The name displayed inside Excel does not change.
    assert.equal(i18n.messages[locale]['app.name'], 'DeepSeek Excel');
  }
});

test('React pane shows the GitHub link on the Settings > About page', () => {
  const page = fs.readFileSync(path.join(root, 'ui', 'src', 'components', 'SettingsPage.jsx'), 'utf8');
  assert.match(page, /https:\/\/github\.com\/dezuhan/);
  assert.match(page, /t\('app\.project'\)/);
  const header = fs.readFileSync(path.join(root, 'ui', 'src', 'components', 'Header.jsx'), 'utf8');
  assert.match(header, /title=\{t\('app\.project'\)\}/);
});

test('classic pane also carries the project name and GitHub link', () => {
  const classic = fs.readFileSync(path.join(root, 'public', 'taskpane-classic.html'), 'utf8');
  assert.match(classic, /data-i18n="app\.project"/);
  assert.match(classic, /https:\/\/github\.com\/dezuhan/);
});

test('README explains the difference between project name and add-in name', () => {
  assert.match(readme, /^# DeepSeek Excell by dezuhan/m);
  assert.match(readme, /The name inside Excel stays/);
  assert.match(readme, /https:\/\/github\.com\/dezuhan/);
});

test('documentation is English (no leftover Indonesian in docs and scripts)', () => {
  // i18n.js is excluded on purpose: its id-ID values are the Indonesian product translation.
  const indonesian = /\b(yang|dengan|tidak|adalah|untuk|karena|sudah|belum|atau|bila|juga|agar|dari|pada|tersebut|sebagai|melalui|setiap|harus|dapat|jika|maka)\b/i;
  const files = [
    'README.md',
    'install.ps1',
    '.env.example',
    ...fs.readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.ps1')).map((name) => `scripts/${name}`),
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = source.split(/\r?\n/);
    const offending = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => indonesian.test(entry.line))
      .slice(0, 3)
      .map((entry) => `${file}:${entry.number}: ${entry.line.trim().slice(0, 90)}`);
    assert.deepEqual(offending, [], `Indonesian text found:\n${offending.join('\n')}`);
  }
});

test('source comments are English too (JS/JSX, excluding the i18n dictionary)', () => {
  const indonesian = /\b(yang|dengan|tidak|adalah|untuk|karena|sudah|belum|atau|bila|juga|agar|dari|pada|tersebut|sebagai|melalui|setiap|harus|dapat|jika|maka)\b/i;
  const targets = [
    'server.js',
    'vite.config.mjs',
    ...fs.readdirSync(path.join(root, 'public', 'js'))
      .filter((name) => name.endsWith('.js') && name !== 'i18n.js' && name !== 'heroicons.js')
      .map((name) => `public/js/${name}`),
  ];
  for (const file of targets) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const offending = source
      .split(/\r?\n/)
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => indonesian.test(entry.line))
      .slice(0, 3)
      .map((entry) => `${file}:${entry.number}: ${entry.line.trim().slice(0, 90)}`);
    assert.deepEqual(offending, [], `Indonesian text found:\n${offending.join('\n')}`);
  }
});
