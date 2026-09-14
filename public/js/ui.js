/**
 * Task pane UI layer: chat, change plan cards, undo, settings, and the
 * language selector (EN-US default, ID-ID available).
 * Icons come from the Heroicons pack through DSX.heroicons (see scripts/build-assets.js).
 */
(function (global) {
  'use strict';

  const DSX = global.DSX;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(global.location.search);
  const mockMode = params.get('mock') === '1';
  const LOCALE_STORAGE_KEY = 'deepseek-excel-locale';

  const QUICK_ACTIONS = [
    { label: 'quick.analysis.label', prompt: 'quick.analysis.prompt' },
    { label: 'quick.format.label', prompt: 'quick.format.prompt' },
    { label: 'quick.table.label', prompt: 'quick.table.prompt' },
    { label: 'quick.chart.label', prompt: 'quick.chart.prompt' },
    { label: 'quick.summary.label', prompt: 'quick.summary.prompt' },
  ];

  const READ_TOOL_ICONS = {
    get_workbook_overview: 'document',
    read_range: 'toolRead',
    get_tables: 'table',
    list_charts: 'chart',
    list_named_ranges: 'document',
    select_range: 'toolRead',
  };

  const WRITE_TOOL_ICONS = {
    create_chart: 'chart',
    create_table: 'table',
  };

  const ui = {
    busy: false,
    pendingPlans: [],
    streamingEl: null,
    streamingText: '',
    reasoningEl: null,
    reasoningText: '',
    hasKey: false,
  };

  function t(key, values) {
    return DSX.i18n.t(key, values);
  }

  function sv(name, options) {
    return DSX.heroicons.has(name) ? DSX.heroicons.svg(name, options) : '';
  }

  function setIcon(id, name) {
    const element = $(id);
    if (element) element.innerHTML = sv(name);
  }

  // --------------------------------------------------------------- language
  function storedLocale() {
    try {
      return global.localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function initialLocale() {
    const officeLocale = global.Office && global.Office.context && global.Office.context.displayLanguage;
    return DSX.i18n.detectLocale({
      paramLocale: params.get('lang'),
      storedLocale: storedLocale(),
      officeLocale,
      browserLocale: global.navigator && global.navigator.language,
    });
  }

  function applyStaticTranslations() {
    const locale = DSX.i18n.getLocale();
    document.documentElement.lang = locale;
    document.title = t('app.name');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml, { apply: t('plan.apply') });
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
  }

  function syncLanguageSelectors() {
    const locale = DSX.i18n.getLocale();
    for (const id of ['lang', 'settings-lang']) {
      const select = $(id);
      if (select) select.value = locale;
    }
  }

  function renderIcons() {
    setIcon('brand-icon', 'brand');
    setIcon('settings-icon', 'settings');
    setIcon('send-icon', 'send');
    setIcon('undo-icon', 'undo');
    setIcon('undo-all-icon', 'trash');
    setIcon('reset-icon', 'reset');
    setIcon('model-icon', 'model');
    setIcon('lang-icon', 'language');
  }

  function switchLocale(locale, options) {
    const opts = options || {};
    DSX.i18n.setLocale(locale);
    try {
      global.localStorage.setItem(LOCALE_STORAGE_KEY, DSX.i18n.getLocale());
    } catch (err) {
      /* localStorage may be blocked; ignore */
    }
    applyStaticTranslations();
    syncLanguageSelectors();
    renderQuickActions();
    refreshHistoryInfo();
    if (opts.silent) return;
    addSystemMessage(t('msg.languageChanged', { language: t(`lang.${DSX.i18n.getLocale()}`) }));
  }

  // --------------------------------------------------------------- helper DOM
  function escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Markdown output for the classic pane.
   *
   * Uses the same engine as the React pane (`marked` + `DOMPurify`, served from /vendor/*);
   * if those files are unavailable the text is escaped and shown as plain paragraphs.
   */
  const MD_ALLOWED_TAGS = [
    'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre',
    'ul', 'ol', 'li', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'a', 'span', 'input',
  ];
  const MD_ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'class', 'colspan', 'rowspan', 'align', 'type', 'checked', 'disabled'];

  let markdownReady = false;

  function ensureMarkdownEngine() {
    if (markdownReady || typeof global.marked === 'undefined' || typeof global.DOMPurify === 'undefined') {
      return markdownReady;
    }
    global.marked.setOptions({ gfm: true, breaks: true });
    global.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    markdownReady = true;
    return true;
  }

  function renderMarkdown(text) {
    const source = String(text === undefined || text === null ? '' : text);
    if (!ensureMarkdownEngine()) {
      return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
    }
    try {
      const html = global.marked.parse(source);
      return global.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: MD_ALLOWED_TAGS,
        ALLOWED_ATTR: MD_ALLOWED_ATTR,
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'img', 'svg', 'math'],
        FORBID_ATTR: ['style', 'srcset', 'src'],
        KEEP_CONTENT: true,
      });
    } catch (err) {
      return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
    }
  }

  function setStatus(text, level) {
    $('status-text').textContent = text;
    const dot = $('status-dot');
    dot.className = `dot${level ? ` ${level}` : ''}`;
  }

  function showBanner(message, kind) {
    const banner = $('banner');
    banner.innerHTML = `${sv(kind === 'error' ? 'warning' : 'info')}<span>${escapeHtml(message)}</span>`;
    banner.className = `banner${kind === 'error' ? ' error' : ''}`;
    banner.classList.remove('hidden');
  }

  function hideBanner() {
    $('banner').classList.add('hidden');
  }

  function scrollToEnd() {
    const messages = $('messages');
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(role, text, options) {
    const opts = options || {};
    const section = document.createElement('section');
    section.className = `msg ${role}`;
    const label = document.createElement('div');
    label.className = 'role';
    label.textContent = t(`role.${role}`);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (opts.html) {
      bubble.classList.add('md');
      bubble.innerHTML = text;
    } else {
      bubble.textContent = text;
    }
    section.appendChild(label);
    section.appendChild(bubble);
    $('messages').appendChild(section);
    if (opts.scroll !== false) scrollToEnd();
    return bubble;
  }

  function addSystemMessage(text) {
    return addMessage('system', text);
  }

  function addToolLine(text, iconName, isError) {
    const div = document.createElement('div');
    div.className = `tool-line${isError ? ' error' : ''}`;
    div.innerHTML = `${sv(iconName || 'toolCall')}<span>${escapeHtml(text)}</span>`;
    $('messages').appendChild(div);
    scrollToEnd();
    return div;
  }

  function beginAssistantStream() {
    ui.streamingText = '';
    ui.reasoningText = '';
    ui.reasoningEl = null;
    const bubble = addMessage('assistant', '');
    ui.streamingEl = bubble;
    bubble.classList.add('spinner');
    return bubble;
  }

  function updateAssistantStream(fullText) {
    if (!ui.streamingEl) beginAssistantStream();
    ui.streamingEl.textContent = fullText;
    scrollToEnd();
  }

  function updateReasoning(delta) {
    ui.reasoningText += delta;
    if (!ui.reasoningEl && ui.streamingEl) {
      const details = document.createElement('details');
      details.className = 'msg system';
      details.innerHTML = `<summary>${escapeHtml(t('msg.reasoning'))}</summary><div class="bubble"><pre></pre></div>`;
      ui.streamingEl.parentElement.parentElement.insertBefore(details, ui.streamingEl.parentElement);
      ui.reasoningEl = details.querySelector('pre');
    }
    if (ui.reasoningEl) ui.reasoningEl.textContent = ui.reasoningText;
  }

  function finishAssistantStream(text) {
    const bubble = ui.streamingEl;
    ui.streamingEl = null;
    if (!bubble) {
      if (text) addMessage('assistant', renderMarkdown(text), { html: true });
      return;
    }
    bubble.classList.remove('spinner');
    if (text && text.trim()) bubble.innerHTML = renderMarkdown(text);
    else bubble.textContent = t('msg.noText');
  }

  function statusLabel(status) {
    const key = `tool.status.${status}`;
    const value = t(key);
    return value === key ? status : value;
  }

  function toolIcon(name) {
    if (READ_TOOL_ICONS[name]) return READ_TOOL_ICONS[name];
    if (WRITE_TOOL_ICONS[name]) return WRITE_TOOL_ICONS[name];
    return 'toolWrite';
  }

  // ------------------------------------------------------------- plan card
  function renderPlanCard(plan) {
    const card = document.createElement('article');
    card.className = `plan${plan.destructive ? ' destructive' : ''}`;
    card.dataset.planId = plan.id;

    const title = document.createElement('h3');
    title.innerHTML = `${plan.destructive ? sv('warning') : sv('clock')}<span>${escapeHtml(plan.label)}</span>`;
    card.appendChild(title);

    const summary = document.createElement('div');
    summary.className = 'summary';
    summary.textContent = plan.preview.summary;
    card.appendChild(summary);

    const rows = plan.preview.rows || [];
    if (rows.length) {
      const table = document.createElement('table');
      const body = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        const before = row.cells.map((c) => (c.before === '' ? t('bridge.preview.empty') : c.before)).join(' · ');
        const after = row.cells.map((c) => c.after).join(' · ');
        tr.innerHTML = `<td>${escapeHtml(row.label)}</td><td class="before">${escapeHtml(before)}</td><td>${escapeHtml(after)}</td>`;
        body.appendChild(tr);
      }
      table.appendChild(body);
      card.appendChild(table);
    }

    const counts = plan.preview.counts || {};
    const countParts = Object.entries(counts)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}: ${value}`);
    if (countParts.length) {
      const div = document.createElement('div');
      div.className = 'counts';
      div.textContent = countParts.join(' · ');
      card.appendChild(div);
    }

    const notes = plan.preview.notes || [];
    if (notes.length) {
      const ul = document.createElement('ul');
      ul.className = 'notes';
      notes.forEach((note) => {
        const li = document.createElement('li');
        li.textContent = note;
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'plan-actions';
    const applyBtn = document.createElement('button');
    applyBtn.className = plan.destructive ? 'danger' : 'primary';
    applyBtn.innerHTML = `${sv('check')}<span>${escapeHtml(t(plan.destructive ? 'plan.applyRisky' : 'plan.apply'))}</span>`;
    applyBtn.addEventListener('click', () => decidePlan(plan.id, 'apply'));
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'ghost';
    rejectBtn.innerHTML = `${sv('close')}<span>${escapeHtml(t('plan.cancel'))}</span>`;
    rejectBtn.addEventListener('click', () => decidePlan(plan.id, 'reject'));
    actions.appendChild(applyBtn);
    actions.appendChild(rejectBtn);

    if (ui.pendingPlans.length > 1) {
      const allBtn = document.createElement('button');
      allBtn.className = 'ghost';
      allBtn.textContent = t('plan.applyAll');
      allBtn.addEventListener('click', applyAllPlans);
      actions.appendChild(allBtn);
    }
    card.appendChild(actions);

    $('pending-area').appendChild(card);
    card.scrollIntoView({ block: 'nearest' });
  }

  function addPendingPlan(plan) {
    ui.pendingPlans.push(plan);
    renderPlanCard(plan);
  }

  function removePlanCard(planId) {
    const card = document.querySelector(`[data-plan-id="${planId}"]`);
    if (card) card.remove();
    ui.pendingPlans = ui.pendingPlans.filter((p) => p.id !== planId);
    document.querySelectorAll('.plan-actions').forEach((el) => {
      const all = el.querySelector('button:last-child');
      if (all && all.textContent === t('plan.applyAll')) all.remove();
    });
  }

  async function decidePlan(planId, decision) {
    if (ui.busy) return;
    removePlanCard(planId);
    setBusy(true);
    try {
      const outcome = await DSX.agent.decide(planId, decision);
      if (!outcome.ok && outcome.error) showBanner(outcome.error, 'error');
    } finally {
      setBusy(false);
      refreshHistoryInfo();
    }
  }

  async function applyAllPlans() {
    const plans = ui.pendingPlans.slice();
    for (const plan of plans) {
      // eslint-disable-next-line no-await-in-loop
      await decidePlan(plan.id, 'apply');
    }
  }

  function setBusy(value) {
    ui.busy = value;
    $('btn-send').disabled = value;
    $('btn-stop').classList.toggle('hidden', !value);
    if (value) setStatus(t('status.working'), 'warn');
    else if (ui.hasKey || mockMode) setStatus(t('status.ready'), 'ok');
    else setStatus(t('status.noKey'), 'err');
  }

  function refreshHistoryInfo() {
    const history = DSX.bridge.history();
    $('history-info').textContent = history.count
      ? t('footer.changes', { count: history.count, label: history.last ? history.last.label : '-' })
      : t('footer.noChanges');
    $('btn-undo').disabled = !history.count;
    $('btn-undo-all').disabled = !history.count;
  }

  async function runUndo(kind) {
    setBusy(true);
    try {
      const outcome = kind === 'all' ? await DSX.bridge.undoAll() : await DSX.bridge.undoLast();
      if (outcome.ok) {
        addSystemMessage(kind === 'all' ? t('msg.undoAllDone') : t('msg.undoDone', { label: outcome.undone }));
      } else {
        showBanner(outcome.error || t('bridge.err.undoNothing'), 'error');
      }
    } finally {
      setBusy(false);
      refreshHistoryInfo();
    }
  }

  // ------------------------------------------------------------- quick actions
  function renderQuickActions() {
    const container = $('quick-actions');
    container.innerHTML = '';
    QUICK_ACTIONS.forEach((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t(action.label);
      button.addEventListener('click', () => {
        $('input').value = t(action.prompt);
        submitComposer();
      });
      container.appendChild(button);
    });
  }

  // ------------------------------------------------------------- settings
  async function openSettings() {
    try {
      const config = await DSX.client.getConfig();
      $('settings-model').value = config.model;
      $('settings-lang').value = DSX.i18n.getLocale();
      $('settings-key-info').textContent = config.hasKey
        ? t('settings.keyCurrent', { masked: config.keyMasked })
        : t('settings.keyMissing');
      $('settings-max-write').value = config.maxCellsWrite;
      $('settings-max-read').value = config.maxCellsRead;
      $('settings-auto-apply').checked = DSX.bridge.getConfig().autoApply;
      $('settings-key').value = '';
      $('settings').classList.remove('hidden');
    } catch (err) {
      showBanner(err.message, 'error');
    }
  }

  async function saveSettings() {
    const body = {
      model: $('settings-model').value,
      maxCellsWrite: Number($('settings-max-write').value),
      maxCellsRead: Number($('settings-max-read').value),
    };
    const key = $('settings-key').value.trim();
    if (key) body.apiKey = key;
    try {
      const result = await DSX.client.setConfig(body);
      const autoApply = $('settings-auto-apply').checked;
      DSX.bridge.setConfig({
        maxCellsWrite: result.maxCellsWrite || body.maxCellsWrite,
        maxCellsRead: result.maxCellsRead || body.maxCellsRead,
        autoApply,
      });
      if (result.model) $('model').value = result.model;
      if (result.hasKey !== undefined) ui.hasKey = result.hasKey;
      const nextLocale = $('settings-lang').value;
      $('settings').classList.add('hidden');
      if (nextLocale !== DSX.i18n.getLocale()) switchLocale(nextLocale);
      addSystemMessage(t(autoApply ? 'settings.savedAuto' : 'settings.savedManual'));
      setBusy(false);
    } catch (err) {
      showBanner(err.message, 'error');
    }
  }

  // ------------------------------------------------------------- composer
  /**
   * Markdown editing shortcut for the classic pane (input side).
   * Wraps the current selection, or inserts the placeholder when nothing is selected.
   */
  function wrapSelection(textarea, before, after) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const inner = text.slice(start, end) || '';
    textarea.value = `${text.slice(0, start)}${before}${inner}${after}${text.slice(end)}`;
    textarea.focus();
    textarea.setSelectionRange(start + before.length, start + before.length + inner.length);
  }

  async function submitComposer() {
    if (ui.busy) return;
    const input = $('input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMessage('user', renderMarkdown(text), { html: true });
    hideBanner();
    setBusy(true);
    beginAssistantStream();
    try {
      const outcome = await DSX.agent.send(text);
      if (outcome && outcome.error) showBanner(outcome.error, 'error');
    } finally {
      setBusy(false);
      refreshHistoryInfo();
    }
  }

  // ------------------------------------------------------------- boot
  async function populateModels() {
    let models = ['deepseek-flash', 'deepseek-v4-pro'];
    try {
      const result = await DSX.client.models();
      if (result.models && result.models.length) models = result.models;
    } catch (err) {
      /* use the fallback list */
    }
    for (const select of [$('model'), $('settings-model')]) {
      select.innerHTML = '';
      models.forEach((model) => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        select.appendChild(option);
      });
    }
    const config = await DSX.client.getConfig().catch(() => null);
    if (config && config.model) {
      $('model').value = config.model;
      $('settings-model').value = config.model;
    }
  }

  function detectOldWebView() {
    const ua = global.navigator.userAgent || '';
    if (!global.fetch || !global.Promise) return true;
    return /MSIE|Trident/i.test(ua);
  }

  async function boot() {
    switchLocale(initialLocale(), { silent: true });
    renderIcons();
    renderQuickActions();

    if (detectOldWebView()) {
      showBanner(t('banner.oldWebView'), 'error');
      return;
    }

    const api = mockMode ? DSX.mockApi : DSX.officeApi;
    if (!mockMode) {
      try {
        await new Promise((resolve) => {
          if (global.Office && global.Office.onReady) global.Office.onReady(() => resolve());
          else resolve();
        });
      } catch (err) {
        /* keep going; the error will surface when Excel is called */
      }
      if (!global.Excel) showBanner(t('banner.officeMissing'), 'error');
    }

    DSX.agent.init({
      onStatus: (text) => setStatus(text, ui.hasKey || mockMode ? 'ok' : 'warn'),
      onAssistantDelta: (delta, full) => updateAssistantStream(full),
      onReasoning: (delta) => updateReasoning(delta),
      onAssistantDone: (text) => finishAssistantStream(text),
      onToolCall: (name, args) => {
        const target = args && args.sheet ? `${args.sheet}${args.address ? `!${args.address}` : ''}` : '';
        addToolLine(
          target ? t('tool.call', { name, target }) : t('tool.callNoTarget', { name }),
          toolIcon(name),
        );
      },
      onToolResult: (name, status) => addToolLine(
        t('tool.result', { name, status: statusLabel(status) }),
        status === 'failed' ? 'warning' : 'checkCircle',
        status === 'failed',
      ),
      onPlan: (plan) => {
        finishAssistantStream(ui.streamingText);
        addPendingPlan(plan);
      },
      onError: (message) => {
        finishAssistantStream(ui.streamingText);
        showBanner(message, 'error');
      },
    });

    try {
      const config = await DSX.client.getConfig();
      ui.hasKey = Boolean(config.hasKey);
      DSX.bridge.init(api, {
        maxCellsWrite: config.maxCellsWrite,
        maxCellsRead: config.maxCellsRead,
        maxToolIterations: config.maxToolIterations,
        autoApply: false,
      });
      await populateModels();
      if (mockMode) {
        showBanner(t('banner.mock'));
      } else if (!config.hasKey) {
        showBanner(t('banner.noKey'), 'error');
      }
      if (mockMode) setStatus(t('status.mockReady'), 'ok');
      else if (ui.hasKey) setStatus(t('status.ready'), 'ok');
      else setStatus(t('status.noKey'), 'err');
    } catch (err) {
      setStatus(t('status.serverDown'), 'err');
      showBanner(t('banner.serverDown', { error: err.message }), 'error');
      return;
    }

    try {
      await DSX.agent.loadTools();
    } catch (err) {
      showBanner(err.message, 'error');
    }

    $('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      submitComposer();
    });
    $('input').addEventListener('keydown', (event) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'e', 'k'].includes(key)) {
        event.preventDefault();
        const wrappers = { b: ['**', '**'], i: ['*', '*'], e: ['`', '`'], k: ['[', '](https://)'] };
        const [before, after] = wrappers[key];
        wrapSelection($('input'), before, after);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitComposer();
      }
    });
    $('btn-stop').addEventListener('click', () => DSX.agent.abort());
    $('btn-context').addEventListener('click', async () => {
      setBusy(true);
      await DSX.agent.refreshContext();
      addSystemMessage(t('msg.contextReloaded'));
      setBusy(false);
    });
    $('btn-undo').addEventListener('click', () => runUndo('last'));
    $('btn-undo-all').addEventListener('click', () => runUndo('all'));
    $('btn-reset').addEventListener('click', () => {
      DSX.agent.reset();
      $('messages').innerHTML = '';
      ui.pendingPlans = [];
      $('pending-area').innerHTML = '';
      addSystemMessage(t('msg.chatReset'));
    });
    $('btn-settings').addEventListener('click', openSettings);
    $('settings-cancel').addEventListener('click', () => $('settings').classList.add('hidden'));
    $('settings-save').addEventListener('click', saveSettings);
    $('lang').addEventListener('change', () => switchLocale($('lang').value));
    $('model').addEventListener('change', async () => {
      const model = $('model').value;
      try {
        await DSX.client.setConfig({ model });
        addSystemMessage(t('msg.modelChanged', { model }));
      } catch (err) {
        showBanner(err.message, 'error');
      }
    });

    refreshHistoryInfo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof self !== 'undefined' ? self : this);

