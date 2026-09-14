/**
 * Agent loop: assembles the context, calls DeepSeek, runs tools through the bridge,
 * and stops to wait for the user's decision whenever there is a change plan.
 *
 * Advanced behaviours required by the DeepSeek API:
 *  - `reasoning_content` is echoed back on every later turn when tools are in play, otherwise
 *    the API rejects the request with HTTP 400.
 *  - token usage from the final stream chunk is forwarded to the pane (cost meter).
 *
 * Configuration comes from the pane: system prompt (stored server side), personalization
 * (global from the server + file scope from the workbook) and the reasoning effort.
 */
(function (global) {
  'use strict';

  const DSX = (global.DSX = global.DSX || {});

  const MAX_TOOL_RESULT_CHARS = 12000;
  const HISTORY_BUDGET_CHARS = 120000;

  function t(key, params) {
    const i18n = DSX.i18n;
    return i18n ? i18n.t(key, params) : key;
  }

  const state = {
    tools: [],
    history: [],
    contextNote: '',
    busy: false,
    abortController: null,
    waiting: null,
    hooks: {},
    options: {
      systemPrompt: '',
      personalization: { global: '', file: '' },
      effort: 'high',
      model: undefined,
    },
  };

  function estimateChars(messages) {
    let total = 0;
    for (const message of messages) {
      total += (message.content || '').length;
      if (message.tool_calls) total += JSON.stringify(message.tool_calls).length;
      total += 40;
    }
    return total;
  }

  /** Drop old turns when the budget is exceeded, never splitting a tool_call from its result. */
  function trimHistory(history) {
    if (estimateChars(history) <= HISTORY_BUDGET_CHARS) return history.slice();
    const kept = [];
    let total = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      const size = (message.content || '').length + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0) + 40;
      if (total + size > HISTORY_BUDGET_CHARS && kept.length) break;
      total += size;
      kept.unshift(message);
    }
    while (kept.length && kept[0].role === 'tool') kept.shift();
    return kept;
  }

  /** Base prompt + personalization layers (global first, then the per-file one). */
  function buildSystemMessages() {
    const messages = [{ role: 'system', content: state.options.systemPrompt || t('agent.system') }];
    const globalText = (state.options.personalization.global || '').trim();
    const fileText = (state.options.personalization.file || '').trim();

    if (globalText) {
      messages.push({
        role: 'system',
        content: `GLOBAL PERSONALIZATION (applies to every workbook, set by the user):\n${globalText}`,
      });
    }
    if (fileText) {
      messages.push({
        role: 'system',
        content: `PERSONALIZATION FOR THIS FILE ONLY (set by the user, stored inside this workbook):\n${fileText}`,
      });
    }
    if (state.contextNote) {
      messages.push({
        role: 'system',
        content: `CURRENT WORKBOOK CONTEXT (result of get_workbook_overview):\n<sheet_data>\n${state.contextNote}\n</sheet_data>`,
      });
    }
    return messages;
  }

  function buildMessages() {
    return buildSystemMessages().concat(trimHistory(state.history));
  }

  function stringifyResult(toolName, value) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      text = String(value);
    }
    if (text.length > MAX_TOOL_RESULT_CHARS) {
      text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… (truncated; narrow the request for details)`;
    }
    return `TOOL RESULT ${toolName}:\n<sheet_data>\n${text}\n</sheet_data>`;
  }

  async function loadTools() {
    const response = await fetch('/shared/tools.json', { headers: { 'x-dsh-pane-token': global.__PANE_TOKEN__ || '' } });
    if (!response.ok) throw new Error(t('agent.toolsLoadFailed'));
    state.tools = await response.json();
    return state.tools;
  }

  async function refreshContext() {
    const outcome = await DSX.bridge.callTool('get_workbook_overview', { includeSampleRows: 2 });
    if (outcome.status === 'done') {
      state.contextNote = JSON.stringify(outcome.result);
      if (state.hooks.onStatus) state.hooks.onStatus(t('status.contextUpdated'));
    } else if (state.hooks.onStatus) {
      state.hooks.onStatus(t('status.contextFailed', { error: outcome.error }));
    }
    return state.contextNote;
  }

  async function callModel() {
    state.abortController = new AbortController();
    const result = await DSX.client.chat({
      messages: buildMessages(),
      tools: state.tools,
      model: state.options.model,
      effort: state.options.effort,
      signal: state.abortController.signal,
      onDelta: (delta, full) => state.hooks.onAssistantDelta && state.hooks.onAssistantDelta(delta, full),
      onReasoning: (delta) => state.hooks.onReasoning && state.hooks.onReasoning(delta),
    });
    if (result.usage && state.hooks.onUsage) {
      state.hooks.onUsage(result.usage, { model: state.options.model, effort: state.options.effort });
    }
    return result;
  }

  function parseToolArgs(rawArgs) {
    if (!rawArgs || !String(rawArgs).trim()) return {};
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      throw new Error(`Tool arguments are not valid JSON: ${String(rawArgs).slice(0, 200)}`);
    }
  }

  /** Runs tool calls from `startIndex`; stops and stores state when a plan needs approval. */
  async function runToolBatch(calls, startIndex) {
    for (let i = startIndex; i < calls.length; i += 1) {
      const call = calls[i];
      const name = (call.function && call.function.name) || '';
      let args = {};
      let outcome;
      try {
        args = parseToolArgs(call.function && call.function.arguments);
      } catch (err) {
        outcome = { status: 'error', error: err.message };
      }
      if (state.hooks.onToolCall) state.hooks.onToolCall(name, args);
      if (!outcome) {
        try {
          outcome = await DSX.bridge.callTool(name, args);
        } catch (err) {
          outcome = { status: 'error', error: err.message };
        }
      }

      if (outcome.status === 'pending') {
        state.waiting = { calls, index: i, planId: outcome.plan.id, toolName: name, callId: call.id };
        if (state.hooks.onPlan) state.hooks.onPlan(outcome.plan);
        if (state.hooks.onStatus) state.hooks.onStatus(t('status.waitingApproval'));
        return { waiting: true };
      }

      const payload = outcome.status === 'done'
        ? { status: outcome.autoApplied ? 'applied_auto' : 'ok', result: outcome.result }
        : { status: 'failed', error: outcome.error };
      state.history.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: stringifyResult(name, payload),
      });
      if (state.hooks.onToolResult) state.hooks.onToolResult(name, payload.status, payload);
    }
    return { done: true };
  }

  async function runLoop() {
    const maxIterations = DSX.bridge.getConfig().maxToolIterations || 12;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const { message } = await callModel();
      const calls = message.tool_calls || [];

      if (!calls.length) {
        const assistantMessage = { role: 'assistant', content: message.content || '' };
        if (message.reasoning_content) assistantMessage.reasoning_content = message.reasoning_content;
        state.history.push(assistantMessage);
        if (state.hooks.onAssistantDone) state.hooks.onAssistantDone(message.content || '');
        return { done: true };
      }

      const assistantMessage = { role: 'assistant', content: message.content || '', tool_calls: calls };
      if (message.reasoning_content) assistantMessage.reasoning_content = message.reasoning_content;
      state.history.push(assistantMessage);
      if (state.hooks.onAssistantDone) state.hooks.onAssistantDone(message.content || '');
      const outcome = await runToolBatch(calls, 0);
      if (outcome.waiting) return { waiting: true };
    }
    const note = t('agent.iterationLimit', { max: maxIterations });
    if (state.hooks.onError) state.hooks.onError(note);
    return { done: true, note };
  }

  async function send(text) {
    if (state.busy) return { ok: false, error: t('agent.busy') };
    const content = String(text || '').trim();
    if (!content) return { ok: false, error: t('agent.emptyMessage') };
    state.busy = true;
    state.waiting = null;
    state.history.push({ role: 'user', content });
    try {
      if (!state.contextNote) await refreshContext();
      return await runLoop();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (state.hooks.onStatus) state.hooks.onStatus(t('status.stopped'));
        state.history.push({ role: 'assistant', content: t('agent.abortedAssistant') });
        return { ok: false, aborted: true };
      }
      if (state.hooks.onError) state.hooks.onError(err.message);
      return { ok: false, error: err.message };
    } finally {
      state.busy = false;
      state.abortController = null;
    }
  }

  async function decide(planId, decision) {
    const waiting = state.waiting;
    if (!waiting || waiting.planId !== planId) return { ok: false, error: t('agent.noPendingPlan') };
    state.waiting = null;
    state.busy = true;
    try {
      let payload;
      if (decision === 'apply') {
        const applied = await DSX.bridge.applyPlan(planId);
        payload = applied.ok
          ? { status: 'applied', result: applied.result }
          : { status: 'failed', error: applied.error };
      } else {
        DSX.bridge.rejectPlan(planId);
        payload = {
          status: 'rejected_by_user',
          note: 'The user cancelled this change. Do not repeat the same operation without a new reason.',
        };
      }
      const call = waiting.calls[waiting.index];
      state.history.push({
        role: 'tool',
        tool_call_id: call.id,
        name: waiting.toolName,
        content: stringifyResult(waiting.toolName, payload),
      });
      if (state.hooks.onToolResult) state.hooks.onToolResult(waiting.toolName, payload.status, payload);

      const outcome = await runToolBatch(waiting.calls, waiting.index + 1);
      if (outcome.waiting) return { ok: true, waiting: true };
      await runLoop();
      return { ok: true };
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, aborted: true };
      if (state.hooks.onError) state.hooks.onError(err.message);
      return { ok: false, error: err.message };
    } finally {
      state.busy = false;
    }
  }

  function abort() {
    if (state.abortController) state.abortController.abort();
  }

  function reset() {
    state.history = [];
    state.contextNote = '';
    state.waiting = null;
  }

  DSX.agent = {
    init(hooks) {
      state.hooks = hooks || {};
      return state;
    },
    /** Updates prompt / personalization / effort / model without touching the conversation. */
    configure(options) {
      const patch = options || {};
      if (patch.systemPrompt !== undefined) state.options.systemPrompt = patch.systemPrompt;
      if (patch.effort !== undefined) state.options.effort = patch.effort;
      if (patch.model !== undefined) state.options.model = patch.model;
      if (patch.personalization) {
        state.options.personalization = {
          global: patch.personalization.global !== undefined
            ? patch.personalization.global
            : state.options.personalization.global,
          file: patch.personalization.file !== undefined
            ? patch.personalization.file
            : state.options.personalization.file,
        };
      }
      return { ...state.options, personalization: { ...state.options.personalization } };
    },
    getOptions: () => ({ ...state.options, personalization: { ...state.options.personalization } }),
    loadTools,
    refreshContext,
    send,
    decide,
    abort,
    reset,
    isBusy: () => state.busy,
    isWaiting: () => Boolean(state.waiting),
    /** Conversation history used to persist and restore a chat session. */
    getHistory: () => state.history.slice(),
    loadHistory(messages) {
      state.history = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
      return state.history.length;
    },
    history: () => state.history.slice(),
    _state: state,
  };
})(typeof self !== 'undefined' ? self : this);
