import { createStore, createI18nBinding } from '@/lib/store';
import { READ_TOOL_ICONS, WRITE_TOOL_ICONS } from '@/lib/icons';
import { getTheme, setTheme } from '@/lib/theme';

const LOCALE_STORAGE_KEY = 'deepseek-excel-locale';
const FALLBACK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const FALLBACK_EFFORTS = [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }];

const dsx = () => window.DSX || {};
const paneToken = () => window.__PANE_TOKEN__ || '';

let sequence = 0;
const nextId = (prefix) => `${prefix}-${++sequence}`;

function detectOldWebView() {
  const ua = window.navigator.userAgent || '';
  if (!window.fetch || !window.Promise) return true;
  return /MSIE|Trident/i.test(ua);
}

function toolIcon(name) {
  return READ_TOOL_ICONS[name] || WRITE_TOOL_ICONS[name] || 'toolWrite';
}

function titleFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/**
 * Task pane controller: connects the vanilla engine (window.DSX) to React state and to the
 * server APIs for chat sessions, personalization, system prompts and the cost meter.
 */
export function createPane() {
  const i18n = createI18nBinding();
  const store = createStore({
    phase: 'booting',
    mock: false,
    statusKey: 'status.connecting',
    statusParams: null,
    statusLevel: 'warn',
    banner: null,
    timeline: [],
    plans: [],
    busy: false,
    models: FALLBACK_MODELS,
    model: '',
    hasKey: false,
    config: null,
    settingsOpen: false,
    settingsPage: null,
    historyOpen: false,
    autoApply: false,
    draft: '',
    draftFocus: 0,
    theme: 'system',
    notice: null,
    journalCount: 0,
    journalLabel: '',
    locale: i18n.getLocale(),
    effort: 'high',
    efforts: FALLBACK_EFFORTS,
    sessions: [],
    sessionsLoaded: false,
    activeSessionId: null,
    sessionTitle: '',
    personalization: { global: '', entries: [], file: '', fileId: null, rev: null, dirty: false },
    prompt: { id: null, rev: null, content: '' },
    cost: { loading: false, data: null, error: null },
    usage: [],
    totals: null,
  });

  const { setState } = store;
  const t = (key, params) => i18n.t(key, params);

  let streamingId = null;
  let reasoningId = null;

  async function api(path, options) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-dsh-pane-token': paneToken(),
        'x-dsh-locale': i18n.getLocale(),
        ...((options && options.headers) || {}),
      },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function statusLabel(status) {
    const key = `tool.status.${status}`;
    const value = t(key);
    return value === key ? status : value;
  }

  function push(kind, text, extra) {
    const item = { id: nextId(kind), kind, text, ...(extra || {}) };
    setState((state) => ({ timeline: [...state.timeline, item] }));
    return item.id;
  }

  function updateItem(id, patch) {
    setState((state) => ({ timeline: state.timeline.map((item) => (item.id === id ? { ...item, ...patch } : item)) }));
  }

  function setStatus(key, params, level) {
    setState({ statusKey: key, statusParams: params || null, statusLevel: level || 'ok' });
  }

  function setBanner(key, params, kind) {
    setState({ banner: key ? { key, params: params || null, kind: kind || 'info' } : null });
  }

  function reportError(message) {
    push('error', message);
  }

  function finishStreaming(text) {
    if (streamingId) {
      updateItem(streamingId, { text: text || t('msg.noText'), streaming: false, markdown: true });
      streamingId = null;
    } else if (text) {
      push('assistant', text, { markdown: true });
    }
    reasoningId = null;
  }

  function idleStatus() {
    const state = store.getState();
    if (state.phase !== 'ready') return;
    if (state.mock) setStatus('status.mockReady', null, 'ok');
    else if (state.hasKey) setStatus('status.ready', null, 'ok');
    else setStatus('status.noKey', null, 'err');
  }

  function refreshJournal() {
    const history = dsx().bridge.history();
    setState({ journalCount: history.count, journalLabel: history.last ? history.last.label : '' });
  }

  // ------------------------------------------------------------------ sessions
  async function refreshSessions() {
    try {
      const data = await api('/api/sessions?limit=30');
      setState({ sessions: data.sessions || [], sessionsLoaded: true });
    } catch (err) {
      setState({ sessions: [], sessionsLoaded: true });
    }
  }

  async function persistSession() {
    const state = store.getState();
    const messages = dsx().agent.getHistory();
    if (!messages.length) return null;
    const payload = {
      messages,
      usage: state.usage,
      model: state.model,
      effort: state.effort,
      fileId: state.personalization.fileId,
      title: state.sessionTitle || titleFrom(messages.find((m) => m.role === 'user')?.content) || t('session.untitled'),
    };
    try {
      if (!state.activeSessionId) {
        const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
        const session = created && created.session;
        if (session) setState({ activeSessionId: session._id, sessionTitle: session.title });
      } else {
        const updated = await api(`/api/sessions/${encodeURIComponent(state.activeSessionId)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        const session = updated && updated.session;
        if (session) setState({ sessionTitle: session.title, totals: session.totals });
      }
      await refreshSessions();
      return store.getState().activeSessionId;
    } catch (err) {
      reportError(err.message);
      return null;
    }
  }

  function newChat() {
    dsx().agent.reset();
    streamingId = null;
    reasoningId = null;
    setState({
      timeline: [],
      plans: [],
      activeSessionId: null,
      sessionTitle: '',
      usage: [],
      totals: null,
      historyOpen: false,
    });
    push('system', t('msg.newChat'));
    idleStatus();
  }

  function timelineFromMessages(messages) {
    const timeline = [];
    for (const message of messages || []) {
      if (message.role === 'user') {
        timeline.push({ id: nextId('user'), kind: 'user', text: message.content || '' });
      } else if (message.role === 'assistant') {
        if (message.reasoning_content) {
          timeline.push({ id: nextId('reasoning'), kind: 'reasoning', text: message.reasoning_content });
        }
        if ((message.content || '').trim()) {
          timeline.push({ id: nextId('assistant'), kind: 'assistant', text: message.content, markdown: true });
        }
      } else if (message.role === 'tool') {
        timeline.push({
          id: nextId('tool'),
          kind: 'tool',
          text: t('tool.result', { name: message.name || 'tool', status: statusLabel('ok') }),
          icon: 'checkCircle',
          tone: 'muted',
        });
      }
    }
    return timeline;
  }

  async function loadSession(id) {
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
      const session = data && data.session;
      if (!session) throw new Error(t('session.notFound'));
      dsx().agent.loadHistory(session.messages || []);
      setState({
        timeline: timelineFromMessages(session.messages),
        plans: [],
        activeSessionId: session._id,
        sessionTitle: session.title,
        model: session.model || store.getState().model,
        effort: session.effort || store.getState().effort,
        usage: [],
        totals: session.totals || null,
        historyOpen: false,
      });
      if (session.effort) dsx().agent.configure({ effort: session.effort });
      if (session.model) dsx().agent.configure({ model: session.model });
      push('system', t('msg.sessionLoaded', { title: session.title }));
    } catch (err) {
      reportError(err.message);
    }
  }

  async function deleteSession(id) {
    try {
      const current = store.getState().sessions.find((session) => session.id === id);
      const rev = current && current.rev ? `?rev=${encodeURIComponent(current.rev)}` : '';
      await api(`/api/sessions/${encodeURIComponent(id)}${rev}`, { method: 'DELETE' });
      if (store.getState().activeSessionId === id) {
        dsx().agent.reset();
        setState({ timeline: [], activeSessionId: null, sessionTitle: '', usage: [], totals: null });
      }
      push('system', t('msg.sessionDeleted'));
      await refreshSessions();
    } catch (err) {
      reportError(err.message);
    }
  }

  // ----------------------------------------------------------- personalization
  /** Entries are the unit the Personalize page edits; the composed text is what the agent gets. */
  function composeEntries(entries) {
    return (entries || [])
      .map((entry) => [entry.title ? `## ${entry.title}` : '', entry.text].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  }

  function normalizeEntry(entry, index) {
    return {
      id: entry.id || newEntryId(),
      title: entry.title || '',
      text: entry.text || '',
    };
  }

  /** Locally created entries must never collide with an id that already came from the server. */
  function newEntryId() {
    return `local-${Date.now().toString(36)}-${++sequence}`;
  }

  async function loadPersonalization() {
    let global = { text: '', entries: [], rev: null };
    try {
      const data = await api('/api/personalization');
      global = data.personalization;
    } catch (err) {
      /* keep defaults */
    }
    let file = '';
    let fileId = null;
    try {
      file = await dsx().bridge.getFilePersonalization();
      fileId = await dsx().bridge.getFileId();
    } catch (err) {
      /* document settings unavailable */
    }
    const entries = (global.entries || []).map(normalizeEntry);
    setState({
      personalization: {
        global: global.text || '',
        entries,
        file: file || '',
        fileId,
        rev: global.rev || null,
        dirty: false,
      },
    });
    dsx().agent.configure({ personalization: { global: global.text || composeEntries(entries), file: file || '' } });
  }

  function updatePersonalization(patch) {
    setState((current) => ({ personalization: { ...current.personalization, ...patch, dirty: true } }));
  }

  function addEntry(scope) {
    if (scope === 'file') return; // the file scope is a single note
    const entries = store.getState().personalization.entries;
    setState((current) => ({
      personalization: {
        ...current.personalization,
        entries: [...entries, { id: newEntryId(), title: '', text: '' }],
        dirty: true,
      },
    }));
  }

  function editEntry(id, patch) {
    setState((current) => ({
      personalization: {
        ...current.personalization,
        entries: current.personalization.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
        dirty: true,
      },
    }));
  }

  function removeEntry(id) {
    setState((current) => ({
      personalization: {
        ...current.personalization,
        entries: current.personalization.entries.filter((entry) => entry.id !== id),
        dirty: true,
      },
    }));
  }

  /** Ready-made styles offered on the Personalize page. "default" means "no preset". */
  const PRESETS = ['default', 'professional', 'compact'];

  /**
   * Applies a preset as a single replaceable entry (id `preset:<name>`), keeping the user's own
   * entries untouched, then persists immediately — picking a preset is a deliberate action.
   */
  async function applyPreset(preset) {
    const chosen = PRESETS.includes(preset) ? preset : 'default';
    setState((current) => {
      const kept = current.personalization.entries.filter((entry) => !String(entry.id).startsWith('preset:'));
      const entries =
        chosen === 'default'
          ? kept
          : [{ id: `preset:${chosen}`, title: t(`settings.preset.${chosen}`), text: t(`settings.preset.${chosen}.text`) }, ...kept];
      return { personalization: { ...current.personalization, entries, dirty: true } };
    });
    const saved = await savePersonalization({});
    if (saved) flashNotice('settings.personalization.saved');
    return chosen;
  }

  /**
   * Persists the Personalize page: the entry list (global) and the per-file note.
   * Passing a string keeps the legacy single-text behaviour used by older panes.
   */
  async function savePersonalization(values) {
    const state = store.getState();
    const entries = (values && values.entries) || state.personalization.entries;
    const fileText = values && values.file !== undefined ? values.file : state.personalization.file;
    const legacyText = values && values.global !== undefined ? values.global : null;
    const body = legacyText !== null && !(values && values.entries) ? { text: legacyText } : { entries };
    try {
      const saved = await api('/api/personalization', { method: 'PUT', body: JSON.stringify(body) });
      const serverEntries = (saved.personalization.entries || []).map(normalizeEntry);
      await dsx().bridge.setFilePersonalization(fileText);
      setState((current) => ({
        personalization: {
          ...current.personalization,
          global: saved.personalization.text || '',
          entries: serverEntries,
          file: fileText,
          rev: saved.personalization.rev,
          dirty: false,
        },
      }));
      dsx().agent.configure({
        personalization: {
          global: saved.personalization.text || composeEntries(serverEntries),
          file: fileText,
        },
      });
      push('system', t('settings.personalization.saved'));
      return true;
    } catch (err) {
      reportError(err.message);
      return false;
    }
  }

  // ------------------------------------------------------------- prompt/effort
  async function loadPrompt() {
    try {
      const data = await api(`/api/prompts?locale=${encodeURIComponent(i18n.getLocale())}`);
      setState({ prompt: { id: data.active.id, rev: data.active.rev, content: data.active.content } });
      dsx().agent.configure({ systemPrompt: data.active.content });
    } catch (err) {
      setState({ prompt: { id: null, rev: null, content: t('agent.system') } });
    }
  }

  async function savePrompt(content) {
    const prompt = store.getState().prompt;
    if (!prompt.id) return false;
    try {
      const data = await api(`/api/prompts/${encodeURIComponent(prompt.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      });
      setState({ prompt: { id: data.prompt.id, rev: data.prompt.rev, content: data.prompt.content } });
      dsx().agent.configure({ systemPrompt: data.prompt.content });
      push('system', t('settings.prompt.saved'));
      return true;
    } catch (err) {
      reportError(err.message);
      return false;
    }
  }

  async function resetPrompt() {
    try {
      const data = await api('/api/prompts/reset', {
        method: 'POST',
        body: JSON.stringify({ locale: i18n.getLocale() }),
      });
      setState({ prompt: { id: data.prompt.id, rev: data.prompt.rev, content: data.prompt.content } });
      dsx().agent.configure({ systemPrompt: data.prompt.content });
      push('system', t('settings.prompt.saved'));
      return true;
    } catch (err) {
      reportError(err.message);
      return false;
    }
  }

  async function setEffort(effort) {
    setState({ effort });
    dsx().agent.configure({ effort });
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ effort }) });
    } catch (err) {
      reportError(err.message);
    }
  }

  // ---------------------------------------------------------------- cost meter
  async function refreshCost() {
    setState((state) => ({ cost: { ...state.cost, loading: true, error: null } }));
    try {
      const sessionId = store.getState().activeSessionId;
      const data = await api(`/api/cost${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`);
      setState((state) => ({
        cost: { loading: false, data, error: null },
        totals: data.sessionTotals || state.totals,
      }));
    } catch (err) {
      setState((state) => ({ cost: { ...state.cost, loading: false, error: err.message } }));
    }
  }

  // --------------------------------------------------------------------- hooks
  const hooks = {
    onStatus: (text) => push('system', text),
    onAssistantDelta: (delta, full) => {
      if (!streamingId) streamingId = push('assistant', full || delta, { streaming: true });
      else updateItem(streamingId, { text: full, streaming: true });
    },
    onReasoning: (delta) => {
      if (!reasoningId) reasoningId = push('reasoning', delta, { streaming: true });
      else {
        const current = store.getState().timeline.find((item) => item.id === reasoningId);
        updateItem(reasoningId, { text: `${current ? current.text : ''}${delta}`, streaming: true });
      }
    },
    onAssistantDone: (text) => finishStreaming(text),
    onToolCall: (name, args) => {
      const target = args && args.sheet ? `${args.sheet}${args.address ? `!${args.address}` : ''}` : '';
      push('tool', target ? t('tool.call', { name, target }) : t('tool.callNoTarget', { name }), {
        icon: toolIcon(name),
      });
    },
    onToolResult: (name, status) => {
      push('tool', t('tool.result', { name, status: statusLabel(status) }), {
        icon: status === 'failed' ? 'warning' : 'checkCircle',
        tone: status === 'failed' ? 'error' : 'muted',
      });
    },
    onPlan: (plan) => {
      finishStreaming();
      setState((state) => ({ plans: [...state.plans, plan] }));
    },
    onError: (message) => {
      finishStreaming();
      reportError(message);
    },
    onUsage: (usage, meta) => {
      setState((state) => ({
        usage: [
          ...state.usage,
          {
            ...usage,
            model: (meta && meta.model) || state.model,
            effort: (meta && meta.effort) || state.effort,
            at: new Date().toISOString(),
          },
        ],
      }));
    },
  };

  // ------------------------------------------------------------ public actions
  async function boot() {
    const params = new URLSearchParams(window.location.search);
    const bootMock = params.get('mock') === '1';
    setState({ mock: bootMock, theme: getTheme() });

    let stored = null;
    try {
      stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch (err) {
      stored = null;
    }
    i18n.setLocale(
      dsx().i18n.detectLocale({
        paramLocale: params.get('lang'),
        storedLocale: stored,
        officeLocale: window.Office && window.Office.context ? window.Office.context.displayLanguage : null,
        browserLocale: window.navigator.language,
      }),
    );
    setState({ locale: i18n.getLocale() });

    if (detectOldWebView()) {
      setState({ phase: 'error' });
      setBanner('banner.oldWebView', null, 'error');
      return;
    }

    if (!bootMock) {
      try {
        await new Promise((resolve) => {
          if (window.Office && window.Office.onReady) window.Office.onReady(() => resolve());
          else resolve();
        });
      } catch (err) {
        /* Excel errors surface when the API is actually called */
      }
      if (!window.Excel) setBanner('banner.officeMissing', null, 'error');
    }

    const agent = dsx().agent;
    agent.init(hooks);

    try {
      const config = await dsx().client.getConfig();
      dsx().bridge.init(bootMock ? dsx().mockApi : dsx().officeApi, {
        maxCellsWrite: config.maxCellsWrite,
        maxCellsRead: config.maxCellsRead,
        maxToolIterations: config.maxToolIterations,
        autoApply: false,
      });
      let models = FALLBACK_MODELS;
      try {
        const result = await dsx().client.models();
        if (result.models && result.models.length) models = result.models;
      } catch (err) {
        /* fallback list */
      }
      setState({
        phase: 'ready',
        hasKey: Boolean(config.hasKey),
        mock: bootMock || Boolean(config.mock),
        config,
        models,
        model: config.model,
        effort: config.effort || 'high',
        efforts: config.efforts && config.efforts.length ? config.efforts : FALLBACK_EFFORTS,
      });
      agent.configure({ model: config.model, effort: config.effort || 'high' });

      if (bootMock || config.mock) setBanner('banner.mock');
      else if (!config.hasKey) setBanner('banner.noKey', null, 'error');
      refreshJournal();
      idleStatus();

      await Promise.all([
        loadPrompt().catch(() => null),
        loadPersonalization().catch(() => null),
        refreshSessions().catch(() => null),
        // The composer footer shows a compact cost meter, so balance/pricing are fetched at boot.
        refreshCost().catch(() => null),
        agent.loadTools().catch((err) => reportError(err.message)),
      ]);
    } catch (err) {
      setState({ phase: 'error' });
      setStatus('status.serverDown', null, 'err');
      setBanner('banner.serverDown', { error: err.message }, 'error');
    }
  }

  async function sendMessage(text) {
    const value = String(text || '').trim();
    const state = store.getState();
    if (!value || state.busy || state.phase !== 'ready') return;
    push('user', value);
    setBanner(null);
    setState({ busy: true, draft: '' });
    setStatus('status.working', null, 'warn');
    try {
      const outcome = await dsx().agent.send(value);
      if (outcome && outcome.error) reportError(outcome.error);
      await persistSession();
      refreshCost();
    } finally {
      setState({ busy: false });
      refreshJournal();
      idleStatus();
    }
  }

  async function decidePlan(planId, decision) {
    setState((state) => ({ plans: state.plans.filter((plan) => plan.id !== planId), busy: true }));
    try {
      const outcome = await dsx().agent.decide(planId, decision);
      if (outcome && outcome.error) reportError(outcome.error);
      await persistSession();
      refreshCost();
    } finally {
      setState({ busy: false });
      refreshJournal();
      idleStatus();
    }
  }

  async function undo(kind) {
    setState({ busy: true });
    try {
      const outcome = kind === 'all' ? await dsx().bridge.undoAll() : await dsx().bridge.undoLast();
      if (outcome.ok) push('system', kind === 'all' ? t('msg.undoAllDone') : t('msg.undoDone', { label: outcome.undone }));
      else reportError(outcome.error || t('bridge.err.undoNothing'));
    } finally {
      setState({ busy: false });
      refreshJournal();
      idleStatus();
    }
  }

  async function refreshContext() {
    setState({ busy: true });
    try {
      await dsx().agent.refreshContext();
      push('system', t('msg.contextReloaded'));
    } finally {
      setState({ busy: false });
      idleStatus();
    }
  }

  function setLocale(locale) {
    i18n.setLocale(locale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, i18n.getLocale());
    } catch (err) {
      /* localStorage may be blocked */
    }
    setState({ locale: i18n.getLocale() });
    loadPrompt().catch(() => null);
    push('system', t('msg.languageChanged', { language: t(`lang.${i18n.getLocale()}`) }));
  }

  async function changeModel(model) {
    setState({ model });
    dsx().agent.configure({ model });
    try {
      await dsx().client.setConfig({ model });
    } catch (err) {
      reportError(err.message);
    }
  }

  function openSettings(page) {
    setState({ settingsOpen: true, settingsPage: page || null, notice: null });
    refreshCost();
  }

  function setSettingsPage(page) {
    setState({ settingsPage: page || null, notice: null });
  }

  /** Short-lived inline confirmation: the settings surface covers the timeline. */
  function flashNotice(key, params) {
    setState({ notice: { key, params: params || null } });
    if (flashNotice.timer) window.clearTimeout(flashNotice.timer);
    flashNotice.timer = window.setTimeout(() => setState({ notice: null }), 2600);
  }

  /** Model page: key, fetch mode, default model, effort, cell caps and auto-apply. */
  async function saveSettings(values) {
    const body = {
      model: values.model,
      effort: values.effort,
      maxCellsWrite: Number(values.maxCellsWrite),
      maxCellsRead: Number(values.maxCellsRead),
    };
    if (values.apiKey) body.apiKey = values.apiKey;
    if (values.mock !== undefined) body.mock = Boolean(values.mock);
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });

    const autoApply = Boolean(values.autoApply);
    dsx().bridge.setConfig({
      maxCellsWrite: result.maxCellsWrite || body.maxCellsWrite,
      maxCellsRead: result.maxCellsRead || body.maxCellsRead,
      autoApply,
    });
    setState((current) => ({
      hasKey: result.hasKey !== undefined ? result.hasKey : current.hasKey,
      model: result.model || current.model,
      effort: result.effort || current.effort,
      mock: result.mock !== undefined ? result.mock : current.mock,
      autoApply,
      config: { ...(current.config || {}), ...body, keyMasked: result.keyMasked || (current.config || {}).keyMasked },
    }));
    dsx().agent.configure({ model: result.model || values.model, effort: result.effort || values.effort });
    if (values.language && values.language !== i18n.getLocale()) setLocale(values.language);
    flashNotice(autoApply ? 'settings.savedAuto' : 'settings.savedManual');
    idleStatus();
    refreshCost();
    return true;
  }

  /** Interface page: the theme previews immediately, the language is applied on save. */
  function saveInterface(values) {
    if (values && values.theme) setThemeMode(values.theme);
    if (values && values.language && values.language !== i18n.getLocale()) setLocale(values.language);
    flashNotice('settings.saved');
    return true;
  }

  /** Theme applies to <html class="dark"> and survives a pane reload. */
  function setThemeMode(theme) {
    const applied = setTheme(theme);
    setState({ theme: applied });
    return applied;
  }

  /** Fetch mode switches the server between the live DeepSeek API and canned mock answers. */
  async function setFetchMode(mock) {
    setState({ mock: Boolean(mock) });
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ mock: Boolean(mock) }) });
      setBanner(mock ? 'banner.mock' : null);
      idleStatus();
      refreshCost();
    } catch (err) {
      setState({ mock: !mock });
      reportError(err.message);
    }
  }

  function setDraft(text) {
    setState({ draft: text === undefined || text === null ? '' : String(text) });
  }

  /** Suggested commands land in the composer so they can be edited before sending. */
  function appendDraft(text) {
    const piece = String(text === undefined || text === null ? '' : text).trim();
    if (!piece) return store.getState().draft;
    const current = store.getState();
    const base = (current.draft || '').trim();
    const combined = base ? `${base} ${piece}` : piece;
    setState({ draft: combined, draftFocus: current.draftFocus + 1 });
    return combined;
  }

  function closeSettings() {
    setState({ settingsOpen: false, settingsPage: null, notice: null });
  }

  function toggleHistory(open) {
    const next = open === undefined ? !store.getState().historyOpen : open;
    setState({ historyOpen: next });
    if (next) refreshSessions();
  }

  return {
    store,
    i18n,
    t,
    boot,
    sendMessage,
    decidePlan,
    undo,
    refreshContext,
    resetChat: newChat,
    newChat,
    loadSession,
    deleteSession,
    refreshSessions,
    savePersonalization,
    updatePersonalization,
    addEntry,
    editEntry,
    removeEntry,
    applyPreset,
    setDraft,
    appendDraft,
    setThemeMode,
    setFetchMode,
    saveInterface,
    setSettingsPage,
    flashNotice,
    savePrompt,
    resetPrompt,
    setEffort,
    refreshCost,
    saveSettings,
    setLocale,
    changeModel,
    openSettings,
    closeSettings,
    toggleHistory,
    reportError,
    applyAllPlans: async () => {
      const plans = store.getState().plans.slice();
      for (const plan of plans) {
        // eslint-disable-next-line no-await-in-loop
        await decidePlan(plan.id, 'apply');
      }
    },
  };
}
