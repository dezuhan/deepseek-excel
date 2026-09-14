'use strict';
/**
 * Smoke tests for the React + shadcn/ui task pane in jsdom.
 *
 * The real bundle (ui/src/main.jsx) is built with esbuild and then run inside
 * jsdom together with the vanilla engine (window.DSX) and a fake API, so the
 * boot → render → change plan → Apply flow is actually executed.
 * This replaces visual verification because this machine has no full browser.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const ENGINE_FILES = [
  'i18n.js',
  'heroicons.js',
  'validate.js',
  'journal.js',
  'office-api.js',
  'mock-api.js',
  'office-bridge.js',
  'deepseek-client.js',
  'agent.js',
];

let bundlePromise = null;

function buildBundle() {
  if (!bundlePromise) {
    const outfile = path.join(os.tmpdir(), `dsh-pane-smoke-${process.pid}.js`);
    bundlePromise = esbuild
      .build({
        entryPoints: [path.join(root, 'ui', 'src', 'main.jsx')],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'chrome114',
        jsx: 'automatic',
        outfile,
        loader: { '.css': 'empty' },
        alias: { '@': path.join(root, 'ui', 'src') },
        define: { 'process.env.NODE_ENV': '"development"' },
        logLevel: 'silent',
      })
      .then(() => fs.readFileSync(outfile, 'utf8'));
  }
  return bundlePromise;
}

async function mountPane() {
  const bundle = await buildBundle();
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'https://localhost:3000/taskpane.html?mock=1',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__PANE_TOKEN__ = 'uji-token';
  // jsdom does not provide matchMedia; supply a stub so the dark theme path is covered.
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  // Radix ScrollArea (used by the chat, the history drawer and the settings pages) observes its
  // viewport; WebView2 ships ResizeObserver, jsdom does not.
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  for (const file of ENGINE_FILES) {
    window.eval(fs.readFileSync(path.join(root, 'public', 'js', file), 'utf8'));
  }

  const config = {
    model: 'deepseek-flash',
    effort: 'high',
    host: 'excel',
    hasKey: true,
    keyMasked: 'sk-…test',
    maxCellsWrite: 5000,
    maxCellsRead: 2000,
    maxToolIterations: 12,
    mock: false,
    efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }],
  };
  const tools = fs.readFileSync(path.join(root, 'shared', 'tools.json'), 'utf8');
  const sessions = [];
  const calls = [];
  window.__DSX_TEST_CALLS__ = calls;
  window.fetch = async (url, options) => {
    const target = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ url: target, method, body: options && options.body ? JSON.parse(options.body) : null });
    let body;
    if (target.includes('/api/config')) body = method === 'POST' ? { ok: true, ...config } : config;
    else if (target.includes('/api/models')) body = { source: 'mock', models: ['deepseek-flash', 'deepseek-v4-pro'] };
    else if (target.includes('/shared/tools.json')) body = JSON.parse(tools);
    else if (target.includes('/api/sessions') && method === 'POST') {
      const session = {
        _id: `session:excel:test-${sessions.length + 1}`,
        id: `session:excel:test-${sessions.length + 1}`,
        _rev: '1-test',
        rev: '1-test',
        title: 'Test chat',
        model: config.model,
        effort: config.effort,
        messages: [],
        messageCount: 0,
        turnCount: 0,
        totals: { requests: 0, totalCost: 0, currency: 'USD' },
        updatedAt: new Date().toISOString(),
      };
      sessions.push(session);
      body = { session };
    } else if (target.includes('/api/sessions/') && method === 'PUT') body = { session: sessions[0] || null };
    else if (target.includes('/api/sessions/') && method === 'DELETE') body = { ok: true };
    else if (target.includes('/api/sessions')) body = { sessions, total: sessions.length };
    else if (target.includes('/api/personalization') && method === 'PUT') {
      const sent = options && options.body ? JSON.parse(options.body) : {};
      const entries = sent.entries || [];
      const text = entries
        .map((entry) => [entry.title ? `## ${entry.title}` : '', entry.text].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n\n');
      body = { personalization: { text, entries, rev: '2-test' } };
    } else if (target.includes('/api/personalization')) {
      body = {
        personalization: { text: 'global note', entries: [{ id: 'entry-1', title: '', text: 'global note' }], rev: '1-test' },
      };
    }
    else if (target.includes('/api/prompts')) body = { active: { id: 'prompt:excel:system:en-US', rev: '1-test', content: 'base prompt' }, prompts: [] };
    else if (target.includes('/api/cost')) {
      body = {
        pricing: { version: '2026-09', offPeakMultiplier: 0.5 },
        peak: { isPeak: false, nextChangeInMinutes: 42 },
        prices: [{ model: 'deepseek-flash', label: 'DeepSeek Flash', currency: 'USD', inputCacheMiss: 0.3, output: 1.2 }],
        balance: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] },
      };
    } else body = {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  const errors = [];
  const originalError = window.console.error;
  window.console.error = (...args) => {
    const message = args.map(String).join(' ');
    if (message.includes('not wrapped in act')) return; // React warning outside act()
    errors.push(message);
    originalError.apply(window.console, args);
  };

  window.eval(bundle);
  await settle(window, 400);
  return { dom, window, errors, calls, sessions };
}

function settle(window, ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function withPane(run) {
  const context = await mountPane();
  try {
    await run(context);
  } finally {
    context.dom.window.close();
  }
}

function bodyText(window) {
  return window.document.body.textContent || '';
}

function findButton(window, label) {
  return [...window.document.querySelectorAll('button')].find((button) => (button.textContent || '').trim().includes(label));
}

test('the React task pane mounts and shows the shadcn UI in the default language (en-US)', async () => {
  await withPane(async ({ window, errors }) => {
    assert.equal(window.__DSH_PANE_MOUNTED__, true, 'React bundle must mount');
    assert.deepEqual(errors, [], `unexpected console.error: ${errors.join(' | ')}`);

    const text = bodyText(window);
    assert.match(text, /DeepSeek Excel/);
    // Simple, Gemini-like empty state: no greeting block, only short suggestions.
    assert.equal(/Hi! I can read and edit this spreadsheet/.test(text), false, 'the greeting must be gone');
    assert.equal(/Create a monthly expense tracker/.test(text), false, 'example greeting lines must be gone');
    assert.match(text, /Analyze selection/);
    assert.match(text, /Summarize sheet/);
    assert.match(text, /Send/);
    // The status line is hidden while everything is fine (simple Gemini-like shell),
    // so readiness is asserted through the store instead.
    assert.equal(window.__DSH_PANE__.store.getState().phase, 'ready');
    assert.equal(window.__DSH_PANE__.store.getState().statusLevel, 'ok');
    assert.match(text, /Mock mode:/);
    assert.match(text, /no changes yet/);

    // The shadcn components really are used (attributes typical of shadcn/ui).
    assert.ok(window.document.querySelector('[data-slot="button"]'), 'Button is missing');
    assert.ok(window.document.querySelector('[data-slot="textarea"]'), 'Textarea is missing');
    assert.ok(window.document.querySelector('[data-slot="scroll-area"]'), 'ScrollArea is missing');
    // Icons come from the Heroicons pack (not home-made emoji/images).
    assert.ok(window.document.querySelector('svg path'), 'Heroicons are not rendered');

    // Model, effort and language live in the full-page settings surface now.
    window.__DSH_PANE__.openSettings();
    await settle(window, 250);
    assert.ok(window.document.querySelector('[data-testid="settings-page"]'), 'the settings page did not open');
    assert.equal(
      window.document.querySelector('[role="dialog"]'),
      null,
      'settings must be a full page, not a floating dialog',
    );
    for (const key of ['model', 'interface', 'personalize', 'cost', 'about']) {
      assert.ok(window.document.getElementById(`settings-menu-${key}`), `settings menu entry "${key}" is missing`);
    }
    assert.equal(window.document.querySelectorAll('[data-slot="select-trigger"]').length, 0, 'the menu page has no form fields');

    window.__DSH_PANE__.setSettingsPage('model');
    await settle(window, 200);
    assert.ok(
      window.document.querySelectorAll('[data-slot="select-trigger"]').length >= 3,
      'fetch mode, model and effort selects are missing',
    );
    assert.ok(window.document.querySelector('[data-slot="switch"]'), 'auto-apply switch is missing');

    window.__DSH_PANE__.setSettingsPage('cost');
    await settle(window, 200);
    assert.ok(window.document.querySelector('[data-slot="badge"]'), 'peak/off-peak badge is missing');
  });
});

test('switching the language to id-ID immediately changes the UI text', async () => {
  await withPane(async ({ window }) => {
    window.__DSH_PANE__.setLocale('id-ID');
    await settle(window, 120);
    const text = bodyText(window);
    assert.match(text, /Kirim/);
    assert.match(text, /Konteks/);
    assert.match(text, /Undo terakhir/);
    assert.match(text, /Mode mock:/);
    assert.match(text, /Bahasa diganti ke Indonesia\./);
    assert.equal(text.includes('Analyze selection'), false, 'English labels must be gone');
    assert.equal(text.includes('Send'), false, 'English send label must be gone');
  });
});

test('a change plan appears as a card and can be applied from the UI', async () => {
  await withPane(async ({ window }) => {
    // Fake LLM: ask for one write tool, then reply with plain text.
    let calls = 0;
    window.DSX.client.chat = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          finishReason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_uji',
                type: 'function',
                function: {
                  name: 'write_range',
                  arguments: JSON.stringify({
                    sheet: 'Sheet1',
                    address: 'B2',
                    mode: 'values',
                    values: [['nilai uji']],
                  }),
                },
              },
            ],
          },
        };
      }
      return { finishReason: 'stop', message: { role: 'assistant', content: 'Selesai.' } };
    };

    await window.__DSH_PANE__.sendMessage('tulis nilai uji');
    await settle(window, 200);

    const text = bodyText(window);
    assert.match(text, /Write values/, 'label rencana harus terlihat');
    assert.match(text, /Write 1 cells|Write 1 cell/, 'ringkasan rencana harus terlihat');
    assert.match(text, /Apply/);

    const applyButton = findButton(window, 'Apply');
    assert.ok(applyButton, 'tombol Terapkan tidak ditemukan');
    applyButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(window, 250);

    assert.equal(window.DSX.bridge.history().count, 1, 'perubahan harus tercatat di jurnal');
    assert.equal(window.DSX.bridge.pendingPlans().length, 0, 'rencana harus dikonsumsi');
    assert.match(bodyText(window), /1 changes?/, 'info jurnal harus diperbarui');
  });
});

test('the Settings > About page shows the project name and the dezuhan GitHub link', async () => {
  await withPane(async ({ window }) => {
    window.__DSH_PANE__.openSettings();
    await settle(window, 250);
    window.__DSH_PANE__.setSettingsPage('about');
    await settle(window, 200);
    const link = [...window.document.querySelectorAll('a')].find(
      (anchor) => anchor.getAttribute('href') === 'https://github.com/dezuhan',
    );
    assert.ok(link, 'the GitHub link is missing from Settings > About');
    assert.match(window.document.body.textContent, /DeepSeek Excell by dezuhan/);
    // The name displayed inside Excel stays the same.
    assert.match(window.document.body.textContent, /DeepSeek Excel/);
  });
});

test('Settings > Interface switches language and theme, and the theme sticks', async () => {
  await withPane(async ({ window }) => {
    const document = window.document;
    window.__DSH_PANE__.openSettings();
    await settle(window, 200);
    window.__DSH_PANE__.setSettingsPage('interface');
    await settle(window, 200);

    // Language list contains both shipped locales.
    const language = document.getElementById('settings-language');
    const theme = document.getElementById('settings-theme');
    assert.ok(language && theme, 'the interface page must expose language and theme');

    window.__DSH_PANE__.setThemeMode('dark');
    await settle(window, 80);
    assert.equal(document.documentElement.classList.contains('dark'), true, 'Dark theme must set .dark');
    assert.equal(window.localStorage.getItem('deepseek-excel-theme'), 'dark', 'the choice must persist');

    window.__DSH_PANE__.setThemeMode('light');
    await settle(window, 80);
    assert.equal(document.documentElement.classList.contains('dark'), false, 'Light theme must clear .dark');

    window.__DSH_PANE__.setThemeMode('system');
    await settle(window, 80);
    assert.equal(window.localStorage.getItem('deepseek-excel-theme'), 'system');
  });
});

test('Settings > Model switches the fetch mode between live and mock', async () => {
  await withPane(async ({ window, calls }) => {
    window.__DSH_PANE__.openSettings();
    await settle(window, 200);
    window.__DSH_PANE__.setSettingsPage('model');
    await settle(window, 200);

    await window.__DSH_PANE__.setFetchMode(true);
    await settle(window, 120);
    assert.equal(window.__DSH_PANE__.store.getState().mock, true);
    const put = calls.filter((call) => call.url.includes('/api/config') && call.method === 'POST');
    assert.equal(put.some((call) => call.body.mock === true), true, 'mock mode must reach the server');
    assert.match(bodyText(window), /Mock/);
  });
});

test('suggested commands fill the composer instead of sending immediately', async () => {
  await withPane(async ({ window, calls }) => {
    const suggestion = [...window.document.querySelectorAll('button')].find(
      (button) => (button.textContent || '').trim() === 'Analyze selection',
    );
    assert.ok(suggestion, 'the empty state must offer suggestions');
    suggestion.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(window, 120);

    const state = window.__DSH_PANE__.store.getState();
    assert.match(state.draft, /Analyze the data I have selected/);
    assert.equal(state.timeline.filter((item) => item.kind === 'user').length, 0, 'nothing may be sent yet');
    assert.equal(calls.some((call) => call.url.includes('/api/chat')), false, 'no chat request may be started');
    const textarea = window.document.querySelector('[data-slot="textarea"]');
    assert.equal(textarea.value, state.draft, 'the draft must be visible in the composer');

    // A second suggestion is appended so the user can chain instructions.
    const second = [...window.document.querySelectorAll('button')].find(
      (button) => (button.textContent || '').trim() === 'Summarize sheet',
    );
    second.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(window, 120);
    const merged = window.__DSH_PANE__.store.getState().draft;
    assert.ok(merged.length > state.draft.length, 'the next suggestion must be appended');
    assert.equal(window.document.querySelector('[data-slot="textarea"]').value, merged);
  });
});

test('the history drawer groups chats by date and shows their turn count', async () => {
  await withPane(async ({ window, sessions }) => {
    const now = Date.now();
    sessions.push(
      {
        id: 'session:excel:today',
        rev: '1-a',
        title: 'Today chat',
        turnCount: 3,
        messageCount: 6,
        updatedAt: new Date(now - 60 * 1000).toISOString(),
      },
      {
        id: 'session:excel:old',
        rev: '1-b',
        title: 'Old chat',
        turnCount: 1,
        messageCount: 3,
        updatedAt: new Date(now - 40 * 24 * 3600 * 1000).toISOString(),
      },
    );
    window.__DSH_PANE__.toggleHistory(true);
    await settle(window, 150);
    assert.ok(window.document.querySelector('[role="dialog"]'), 'the history drawer did not open');

    const text = bodyText(window);
    assert.match(text, /Today chat/);
    assert.match(text, /Old chat/);
    assert.match(text, /Today/);
    assert.match(text, /Older/);
    assert.match(text, /3 turns/);
    assert.match(text, /1 turn(?!s)/);
    assert.equal(/0 messages/.test(text), false, 'the drawer must not report raw message counts');

    // Layout contract: the drawer is a left sheet built as a flex column, so the header stays at
    // the top and long titles are clipped inside the panel (a centred grid dialog used to stretch
    // the rows and let the list spill over the chat).
    const panel = window.document.querySelector('[data-testid="history-panel"]');
    assert.ok(panel, 'the drawer panel is missing');
    assert.equal(panel.style.display, 'flex', 'the panel must override the dialog grid');
    assert.equal(panel.style.flexDirection, 'column');
    assert.match(panel.className, /overflow-hidden/);
    assert.match(panel.className, /left-0/);
    const header = panel.firstElementChild;
    assert.equal(header.getAttribute('data-slot'), 'dialog-header', 'the header must be the first child');
    assert.match(header.className, /shrink-0/);
    assert.match(header.textContent, /Chats/);
    for (const row of panel.querySelectorAll('li')) {
      assert.match(row.className, /min-w-0/, 'rows must be allowed to shrink instead of overflowing');
    }
  });
});

test('a destructive plan is flagged and its button uses the risky style', async () => {
  await withPane(async ({ window }) => {
    window.DSX.client.chat = async () => ({
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_hapus',
            type: 'function',
            function: {
              name: 'delete_rows',
              arguments: JSON.stringify({ sheet: 'Sheet1', index: 3, count: 2 }),
            },
          },
        ],
      },
    });

    await window.__DSH_PANE__.sendMessage('hapus dua baris');
    await settle(window, 200);

    const text = bodyText(window);
    assert.match(text, /Delete rows/);
    assert.ok(findButton(window, 'Apply (risky)'), 'tombol berisiko tidak muncul');
    // The card uses the shadcn destructive style.
    const card = window.document.querySelector('[data-plan-id]');
    assert.ok(card && /destructive/.test(card.className), 'kartu destruktif harus ditandai');
  });
});

test('composer formats Markdown in place inside the input, without headings', async () => {
  await withPane(async ({ window }) => {
    const document = window.document;
    // Toolbar buttons come from the Markdown action list (localized aria-labels).
    for (const label of ['Bold', 'Italic', 'Inline code', 'Link', 'Bullet list', 'Numbered list', 'Quote']) {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.getAttribute('aria-label') === label,
      );
      assert.ok(button, `toolbar button "${label}" is missing`);
    }

    // Type Markdown the way React sees it, then apply the Bold action to the selected word.
    const textarea = document.querySelector('[data-slot="textarea"]');
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(textarea, 'laporan **tebal** dan `kode`');
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    textarea.setSelectionRange(0, 7);
    await settle(window, 60);

    const boldButton = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === 'Bold',
    );
    boldButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(window, 80);
    assert.match(textarea.value, /\*\*laporan\*\*/);

    // The draft is previewed automatically: there is no eye / "Preview Markdown" toggle any more.
    assert.equal(
      [...document.querySelectorAll('button')].some(
        (candidate) => (candidate.getAttribute('aria-label') || '').includes('Preview Markdown'),
      ),
      false,
      'the preview toggle must be gone',
    );
    assert.equal(
      [...document.querySelectorAll('button')].some(
        (candidate) => (candidate.getAttribute('aria-label') || '').includes('Back to editing'),
      ),
      false,
      'the edit-mode toggle must be gone',
    );

    // Plain input on purpose: no preview box, no highlight layer, no toggle. Markdown is rendered
    // only after sending (your own bubble) and for the model's answers.
    assert.equal(document.querySelector('[data-testid="composer-preview"]'), null, 'no preview box');
    assert.equal(document.querySelector('[data-testid="composer-highlight"]'), null, 'no highlight layer');
    assert.equal(document.querySelector('[data-testid="composer-input"]'), null, 'no overlay wrapper');
    assert.match(textarea.value, /\*\*laporan\*\*/, 'the raw Markdown stays in the input');

    // Heading markers are irrelevant on input now (there is no input rendering at all).
    assert.equal(
      [...document.querySelectorAll('button')].some(
        (candidate) => /heading/i.test(candidate.getAttribute('aria-label') || ''),
      ),
      false,
      'the markdown toolbar must not offer headings on input',
    );
  });
});

test('Markdown is rendered only after sending: your own bubble and the model answer', async () => {
  await withPane(async ({ window }) => {
    window.DSX.client.chat = async () => ({
      finishReason: 'stop',
      message: { role: 'assistant', content: '**Done** with `code`' },
    });
    await window.__DSH_PANE__.sendMessage('**tebal** dan `kode`');
    await settle(window, 250);

    const document = window.document;
    const strong = [...document.querySelectorAll('.md strong')].map((element) => element.textContent);
    assert.ok(strong.includes('tebal'), 'the sent message must render Markdown in the timeline');
    assert.ok(strong.includes('Done'), 'the model answer must render Markdown');
    assert.ok(document.querySelector('.md code'), 'inline code must render after sending');
    // The input itself stays plain text.
    assert.equal(document.querySelector('form').querySelector('.md'), null, 'the input must not render Markdown');
  });
});

test('the composer footer shows a compact cost meter (balance · peak) instead of the Markdown hint', async () => {
  await withPane(async ({ window, calls }) => {
    const document = window.document;
    // The balance is fetched on boot so the footer is populated before the first message.
    assert.equal(
      calls.some((call) => call.url.includes('/api/cost')),
      true,
      'the cost meter must be loaded on boot',
    );

    const meter = document.querySelector('[data-testid="composer-cost"]');
    assert.ok(meter, 'the compact cost meter is missing from the composer footer');
    const text = meter.textContent;
    assert.match(text, /12\.34 USD/, 'the balance must be visible');
    assert.match(text, /\u00b7/, 'balance and peak must be separated by a middle dot (·)');
    assert.match(text, /Off-peak/);
    assert.equal(/Markdown supported/.test(document.body.textContent), false, 'the Markdown hint must be gone');

    // Clicking it opens Settings straight on the Cost page.
    meter.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(window, 250);
    assert.ok(document.querySelector('[data-testid="settings-page"]'), 'settings did not open');
    assert.equal(document.querySelector('[data-testid="settings-heading"]').textContent.trim(), 'Cost meter');
  });
});

test('assistant answers still render headings (output keeps what the input drops)', async () => {
  await withPane(async ({ window }) => {
    window.DSX.client.chat = async () => ({
      finishReason: 'stop',
      message: { role: 'assistant', content: '## Ringkasan\n\nSemua beres.' },
    });
    await window.__DSH_PANE__.sendMessage('ringkas');
    await settle(window, 250);
    const heading = window.document.querySelector('.md h2');
    assert.ok(heading, 'assistant headings must still be rendered');
    assert.match(heading.textContent, /Ringkasan/);
  });
});

test('assistant answers render GFM tables and code blocks with a copy button', async () => {
  await withPane(async ({ window }) => {
    window.DSX.client.chat = async () => ({
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: [
          'Summary:',
          '',
          '| Sheet | Rows |',
          '| --- | ---: |',
          '| Sheet1 | 5 |',
          '',
          '```',
          '=SUM(B2:B5)',
          '```',
          '',
          '**Done.**',
        ].join('\n'),
      },
    });

    await window.__DSH_PANE__.sendMessage('summarize');
    await settle(window, 250);

    const document = window.document;
    const table = document.querySelector('.md table');
    assert.ok(table, 'GFM table was not rendered');
    assert.match(table.textContent, /Sheet1/);

    const pre = document.querySelector('.md pre');
    assert.ok(pre, 'fenced code block was not rendered');
    assert.match(pre.textContent, /=SUM\(B2:B5\)/);
    assert.ok(pre.querySelector('[data-copy-button]'), 'copy button was not injected into the code block');

    assert.ok(document.querySelector('.md strong'), 'bold text was not rendered');
  });
});

test('chat sessions: a finished turn is stored, listed in the drawer and reset by New chat', async () => {
  await withPane(async ({ window, calls }) => {
    window.DSX.client.chat = async () => ({ finishReason: 'stop', message: { role: 'assistant', content: 'Ringkasan selesai.' } });

    await window.__DSH_PANE__.sendMessage('ringkas sheet ini');
    await settle(window, 250);

    const stored = calls.filter((call) => call.url.includes('/api/sessions') && call.method === 'POST');
    assert.equal(stored.length, 1, 'the turn must be persisted as a chat session');
    assert.match(stored[0].body.messages[0].content, /ringkas sheet ini/);
    assert.equal(window.__DSH_PANE__.store.getState().activeSessionId !== null, true);

    // Opening the history drawer lists the saved chat.
    window.__DSH_PANE__.toggleHistory(true);
    await settle(window, 150);
    assert.ok(window.document.querySelector('[role="dialog"]'), 'history drawer did not open');
    assert.match(window.document.body.textContent, /Test chat/);

    // New chat clears the conversation and the active session.
    window.__DSH_PANE__.newChat();
    await settle(window, 80);
    const state = window.__DSH_PANE__.store.getState();
    assert.equal(state.activeSessionId, null);
    assert.equal(state.timeline.filter((item) => item.kind === 'user').length, 0);
    assert.match(window.document.body.textContent, /Started a new chat/);
  });
});

test('Settings > Personalize keeps the base prompt, an addable entry list and the file note', async () => {
  await withPane(async ({ window, calls }) => {
    window.__DSH_PANE__.openSettings();
    await settle(window, 200);
    window.__DSH_PANE__.setSettingsPage('personalize');
    await settle(window, 200);

    const setValue = (element, value) => {
      const prototype =
        element instanceof window.HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const click = (id) => {
      const element = window.document.getElementById(id);
      assert.ok(element, `#${id} is missing`);
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    };

    // The base system prompt starts from the stored prompt document.
    const base = window.document.getElementById('settings-prompt');
    assert.ok(base, 'the base system prompt editor is missing');
    assert.equal(base.value, 'base prompt');

    // The entry list starts from what the server already has (one global entry here).
    assert.equal(window.document.getElementById('settings-entry-text-0').value, 'global note');

    // Adding an entry creates an editable row (title + text), which is what the list is for.
    click('settings-add-entry');
    await settle(window, 120);
    setValue(window.document.getElementById('settings-entry-title-1'), 'Writing style');
    setValue(window.document.getElementById('settings-entry-text-1'), 'Always answer in Indonesian.');
    setValue(window.document.getElementById('settings-personalization-file'), 'Use IDR in this workbook.');
    await settle(window, 80);
    click('settings-save-personalization');
    await settle(window, 250);

    const put = calls.filter((call) => call.url.includes('/api/personalization') && call.method === 'PUT');
    assert.equal(put.length, 1);
    assert.equal(put[0].body.entries.length, 2);
    assert.equal(put[0].body.entries[1].title, 'Writing style');
    assert.equal(put[0].body.entries[1].text, 'Always answer in Indonesian.');
    const state = window.__DSH_PANE__.store.getState();
    assert.equal(state.personalization.entries.length, 2);
    assert.equal(state.personalization.global, 'global note\n\n## Writing style\nAlways answer in Indonesian.');
    // The file scope is written into the workbook document settings.
    assert.equal(window.DSX.mockApi.state.settings.get('deepseekPersonalization'), 'Use IDR in this workbook.');
    assert.match(window.DSX.agent.getOptions().personalization.global, /Always answer in Indonesian\./);

    // Removing an entry drops it from the list.
    const remove = window.document.querySelectorAll('button[aria-label="Remove entry"]')[1];
    assert.ok(remove, 'the entry must be removable');
    remove.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(window, 120);
    assert.equal(window.__DSH_PANE__.store.getState().personalization.entries.length, 1);

    // Effort selection reaches the agent and the server config.
    window.__DSH_PANE__.setEffort('max');
    await settle(window, 150);
    assert.equal(window.DSX.agent.getOptions().effort, 'max');
    assert.equal(window.__DSH_PANE__.store.getState().effort, 'max');
    const configPut = calls.filter((call) => call.url.includes('/api/config') && call.method === 'POST');
    assert.equal(configPut.some((call) => call.body.effort === 'max'), true);
  });
});

test('Settings > Personalize presets: professional, to the point, and back to default', async () => {
  await withPane(async ({ window, calls }) => {
    window.__DSH_PANE__.openSettings();
    await settle(window, 200);
    window.__DSH_PANE__.setSettingsPage('personalize');
    await settle(window, 200);

    const click = (id) => {
      const element = window.document.getElementById(id);
      assert.ok(element, `#${id} is missing`);
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    };
    const presets = window.document.querySelector('[data-testid="settings-presets"]');
    assert.ok(presets, 'the presets row is missing');
    for (const name of ['default', 'professional', 'compact']) {
      assert.ok(window.document.getElementById(`settings-preset-${name}`), `preset "${name}" is missing`);
    }

    // Professional adds one replaceable entry and persists it immediately.
    click('settings-preset-professional');
    await settle(window, 250);
    let state = window.__DSH_PANE__.store.getState();
    let presetEntries = state.personalization.entries.filter((entry) => entry.id.startsWith('preset:'));
    assert.equal(presetEntries.length, 1);
    assert.equal(presetEntries[0].title, 'Professional');
    assert.match(presetEntries[0].text, /professional/i);
    let put = calls.filter((call) => call.url.includes('/api/personalization') && call.method === 'PUT');
    assert.equal(put.length, 1, 'choosing a preset saves right away');
    assert.equal(put[0].body.entries[0].id, 'preset:professional');

    // To the point replaces the previous preset instead of stacking up.
    click('settings-preset-compact');
    await settle(window, 250);
    state = window.__DSH_PANE__.store.getState();
    presetEntries = state.personalization.entries.filter((entry) => entry.id.startsWith('preset:'));
    assert.equal(presetEntries.length, 1, 'only one preset entry may exist');
    assert.equal(presetEntries[0].id, 'preset:compact');
    assert.match(presetEntries[0].text, /brief/i);
    put = calls.filter((call) => call.url.includes('/api/personalization') && call.method === 'PUT');
    assert.equal(put[put.length - 1].body.entries[0].id, 'preset:compact');

    // Default removes the preset and keeps the user's own entries.
    click('settings-preset-default');
    await settle(window, 250);
    state = window.__DSH_PANE__.store.getState();
    assert.equal(
      state.personalization.entries.some((entry) => entry.id.startsWith('preset:')),
      false,
      'Default must clear the preset entry',
    );
    assert.equal(state.personalization.entries.length, 1, "the user's own entry survives");
    assert.equal(state.personalization.entries[0].text, 'global note');
  });
});
