'use strict';
/**
 * Manifest validation with Microsoft's official validator (office-addin-manifest),
 * so schema mistakes show up here instead of when Excel rejects the add-in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest } = require('office-addin-manifest');

const root = path.join(__dirname, '..');

async function validate(file) {
  const result = await validateManifest(path.join(root, file));
  const inner = result.report || {};
  const errors = (inner.errors || []).map((issue) => {
    const where = issue.line ? ` (line ${issue.line}:${issue.column || 0})` : '';
    return `${issue.title || 'Error'}${where}: ${issue.content || ''}`.trim();
  });
  return { result, inner, errors, warnings: inner.warnings || [] };
}

for (const file of ['manifest.xml', 'manifest-minimal.xml']) {
  test(`${file} passes the official Office Add-in validator`, async () => {
    const { result, inner, errors } = await validate(file);
    assert.deepEqual(errors, [], `manifest tidak valid:\n${errors.join('\n')}`);
    assert.equal(result.isValid, true, `status: ${inner.status}`);
    assert.equal(inner.status, 'Accepted');
  });
}

test('manifest.xml declares en-US as the default and id-ID as the override', () => {
  const manifest = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');
  assert.match(manifest, /<DefaultLocale>en-US<\/DefaultLocale>/);
  assert.match(manifest, /<Description DefaultValue="[^"]*">\s*<Override Locale="id-ID"/);
  assert.match(manifest, /<bt:Override Locale="id-ID"/);

  // Every text-typed element must have a DefaultValue (used when the locale does not match).
  for (const match of manifest.matchAll(/<(?:DisplayName|Description|IconUrl|HighResolutionIconUrl|SupportUrl|bt:String|bt:Image|bt:Url)\s+[^>]*?>/g)) {
    assert.match(match[0], /(DefaultValue|resid)="/, `elemen tanpa DefaultValue/resid: ${match[0]}`);
  }
});

test('every resid in VersionOverrides is defined in Resources', () => {
  const manifest = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');
  const resourcesStart = manifest.indexOf('<Resources>');
  const overridesPart = manifest.slice(0, resourcesStart);
  const resourcesPart = manifest.slice(resourcesStart);
  const used = new Set([...overridesPart.matchAll(/resid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(used.size >= 5, `hanya ${used.size} resid dipakai`);
  for (const resid of used) {
    assert.ok(resourcesPart.includes(`id="${resid}"`), `resid ${resid} tidak didefinisikan`);
  }
});



test('the add-in id stays unique across the Excel and Word add-ins', () => {
  // Both add-ins register under HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer,
  // so sharing a GUID would silently overwrite the other registration.
  const siblingManifest = path.join(root, '..', 'word-deepseek', 'manifest.xml');
  if (!fs.existsSync(siblingManifest)) return; // sibling project not shipped alongside this one
  const ownId = /<Id>([^<]+)<\/Id>/.exec(fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8'))[1];
  const siblingId = /<Id>([^<]+)<\/Id>/.exec(fs.readFileSync(siblingManifest, 'utf8'))[1];
  assert.notEqual(ownId, siblingId, 'Excel and Word add-ins must use different GUIDs');
});
