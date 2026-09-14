'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// deepseek-client.js uses the UMD pattern: in Node there is no "self", so
// the object attaches to module.exports.
const mod = require('../public/js/deepseek-client.js');
mod.__PANE_TOKEN__ = 'token-uji';
const client = mod.DSX.client;

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'deepseek-tool-call.chunks.json'), 'utf8'),
);

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
      }),
    },
    json: async () => ({}),
  };
}

function jsonErrorResponse(status, body) {
  return {
    ok: false,
    status,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    json: async () => body,
  };
}

test('chat assembles content and tool_calls split across chunks', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  let capturedHeaders = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    capturedHeaders = options.headers;
    const chunks = fixture.chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
    chunks.push('data: [DONE]\n\n');
    return sseResponse(chunks);
  };

  const deltas = [];
  try {
    const result = await client.chat({
      messages: [{ role: 'user', content: 'isi A1:B2' }],
      tools: [{ type: 'function', function: { name: 'write_range', parameters: {} } }],
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(result.message.content, 'Saya siapkan rencananya.');
    assert.equal(deltas.join(''), 'Saya siapkan rencananya.');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.message.tool_calls.length, 1);

    const call = result.message.tool_calls[0];
    assert.equal(call.id, 'call_abc');
    assert.equal(call.function.name, 'write_range');
    const args = JSON.parse(call.function.arguments);
    assert.deepEqual(args, { sheet: 'Sheet1', address: 'A1:B2', mode: 'values', values: [[1, 2], [3, 4]] });

    assert.equal(capturedBody.stream, true);
    assert.equal(capturedBody.tools.length, 1);
    assert.equal(capturedHeaders['x-dsh-pane-token'], 'token-uji');
  } finally {
    global.fetch = originalFetch;
  }
});

test('chat without tool_calls leaves no tool_calls property behind', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Halo' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
  try {
    const result = await client.chat({ messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(result.message.content, 'Halo');
    assert.equal(result.finishReason, 'stop');
    assert.equal('tool_calls' in result.message, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chat forwards an error from the stream', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => sseResponse([`data: ${JSON.stringify({ error: 'Saldo habis' })}\n\n`]);
  try {
    await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'hai' }] }), /Saldo habis/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chat uses the error message from a non-OK response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonErrorResponse(401, { error: 'API key DeepSeek tidak valid' });
  try {
    await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'hai' }] }), /tidak valid/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chat gives a clear message when the local server is down', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  try {
    await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'hai' }] }), /local server/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chat lets an AbortError through unchanged', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  try {
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hai' }] }),
      (err) => err.name === 'AbortError',
    );
  } finally {
    global.fetch = originalFetch;
  }
});
