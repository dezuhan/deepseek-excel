/**
 * DeepSeek client (through the local /api/chat proxy) + SSE assembler.
 * Tool calls that arrive split across chunks are reassembled by index.
 */
(function (global) {
  'use strict';

  const DSX = (global.DSX = global.DSX || {});

  function i18nOrNull() {
    if (DSX.i18n) return DSX.i18n;
    if (typeof require === 'function') {
      try {
        return require('./i18n.js');
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  function t(key, params) {
    const i18n = i18nOrNull();
    return i18n ? i18n.t(key, params) : key;
  }

  function paneToken() {
    return (global.__PANE_TOKEN__ || '').trim();
  }

  function authHeaders(extra) {
    return Object.assign(
      { 'Content-Type': 'application/json', 'x-dsh-pane-token': paneToken() },
      extra || {},
    );
  }

  async function readError(response) {
    try {
      const data = await response.json();
      if (data && data.error) return data.error;
    } catch (err) {
      /* not JSON */
    }
    return t('client.httpError', { status: response.status });
  }

  async function getJson(path, options) {
    const response = await fetch(path, Object.assign({}, options, { headers: authHeaders(options && options.headers) }));
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  }

  /**
   * Assemble SSE fragments into a single assistant message.
   * onDelta is called for every text fragment, onReasoning for reasoning (when present).
   */
  async function chat(params) {
    const body = {
      messages: params.messages,
      model: params.model,
      effort: params.effort,
      temperature: params.temperature,
      stream: true,
    };
    if (params.tools && params.tools.length) body.tools = params.tools;

    let response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new Error(t('client.serverUnreachable'));
    }
    if (!response.ok) throw new Error(await readError(response));

    const message = { role: 'assistant', content: '', tool_calls: [] };
    let finishReason = null;
    let usage = null;

    const handleChunk = (chunk) => {
      if (chunk && chunk.error) throw new Error(chunk.error);
      // Usage arrives on the final chunk when stream_options.include_usage is set (cost meter).
      if (chunk && chunk.usage) usage = chunk.usage;
      const choice = chunk && chunk.choices && chunk.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        // When tools are used, reasoning_content must be echoed back on later turns,
        // otherwise the DeepSeek API answers with HTTP 400.
        message.reasoning_content = `${message.reasoning_content || ''}${delta.reasoning_content}`;
        if (params.onReasoning) params.onReasoning(delta.reasoning_content);
      }
      if (typeof delta.content === 'string' && delta.content) {
        message.content += delta.content;
        if (params.onDelta) params.onDelta(delta.content, message.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          const index = typeof fragment.index === 'number' ? fragment.index : 0;
          if (!message.tool_calls[index]) {
            message.tool_calls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          const slot = message.tool_calls[index];
          if (fragment.id) slot.id = fragment.id;
          if (fragment.type) slot.type = fragment.type;
          if (fragment.function) {
            if (fragment.function.name) slot.function.name += fragment.function.name;
            if (fragment.function.arguments) slot.function.arguments += fragment.function.arguments;
          }
        }
        if (params.onToolCallDelta) params.onToolCallDelta(message.tool_calls);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (payload && payload !== '[DONE]') {
          let parsed = null;
          try {
            parsed = JSON.parse(payload);
          } catch (err) {
            parsed = null;
          }
          if (parsed) handleChunk(parsed);
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    message.tool_calls = message.tool_calls.filter(Boolean);
    if (!message.tool_calls.length) delete message.tool_calls;
    return { message, finishReason, usage };
  }

  DSX.client = {
    chat,
    health: () => getJson('/api/health'),
    models: () => getJson('/api/models'),
    getConfig: () => getJson('/api/config'),
    setConfig: (body) => getJson('/api/config', { method: 'POST', body: JSON.stringify(body) }),
  };
})(typeof self !== 'undefined' ? self : this);
