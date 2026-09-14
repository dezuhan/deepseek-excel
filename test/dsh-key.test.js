'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'dsh-key.ps1');
const sample = path.join(__dirname, 'fixtures', 'credentials.sample.yaml');
const reference = path.join(__dirname, 'fixtures', 'credentials.reference.yaml');

const powershell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const canRun = Boolean(powershell && fs.existsSync(powershell));

function runKeyScript(args) {
  return new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      },
    );
  });
}

test('dsh-key.ps1 returns the masked key from the fixture', { skip: !canRun && 'PowerShell is not available' }, async () => {
  const result = await runKeyScript(['-Path', sample]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'sk-…mnop');
  assert.equal(result.stdout.includes('sk-fixture1234567890abcdefghijklmnop'), false);
});

test('dsh-key.ps1 -Raw returns the raw key for setup', { skip: !canRun && 'PowerShell is not available' }, async () => {
  const result = await runKeyScript(['-Path', sample, '-Raw']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'sk-fixture1234567890abcdefghijklmnop');
});

test('dsh-key.ps1 rejects a value that is a reference (exit 3)', { skip: !canRun && 'PowerShell is not available' }, async () => {
  const result = await runKeyScript(['-Path', reference, '-Raw']);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
});

test('dsh-key.ps1 returns exit 3 when the file does not exist', { skip: !canRun && 'PowerShell is not available' }, async () => {
  const result = await runKeyScript(['-Path', path.join(__dirname, 'fixtures', 'tidak-ada.yaml')]);
  assert.equal(result.code, 3);
});
