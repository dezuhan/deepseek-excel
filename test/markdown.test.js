'use strict';
/**
 * Unit tests for the Markdown engine (ui/src/lib/markdown.js).
 *
 * The module is bundled with esbuild and executed inside jsdom so the real browser code path
 * runs: `marked` renders GFM and `DOMPurify` sanitizes the result against a jsdom window.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
let enginePromise = null;

function loadEngine() {
  if (!enginePromise) {
    const modulePath = path.join(root, 'ui', 'src', 'lib', 'markdown.js').replace(/\\/g, '/');
    enginePromise = esbuild
      .build({
        stdin: {
          contents: `import { renderMarkdown, markdownToText } from '${modulePath}';\nwindow.__MD__ = { renderMarkdown, markdownToText };\n`,
          resolveDir: root,
          loader: 'js',
        },
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'chrome114',
        write: false,
        logLevel: 'silent',
      })
      .then((result) => {
        const code = result.outputFiles[0].text;
        const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
          url: 'https://localhost:3000/taskpane.html',
          runScripts: 'dangerously',
        });
        dom.window.eval(code);
        return dom.window.__MD__;
      });
  }
  return enginePromise;
}

async function render(markdown, options) {
  const engine = await loadEngine();
  return engine.renderMarkdown(markdown, options);
}

test('renders core Markdown constructs', async () => {
  assert.match(await render('**bold**'), /<strong>bold<\/strong>/);
  assert.match(await render('*italic*'), /<em>italic<\/em>/);
  assert.match(await render('~~gone~~'), /<del>gone<\/del>/);
  assert.match(await render('`code`'), /<code>code<\/code>/);
  assert.match(await render('# Title'), /<h1[^>]*>Title<\/h1>/);
  assert.match(await render('## Sub'), /<h2[^>]*>Sub<\/h2>/);
  assert.match(await render('> quoted'), /<blockquote>[\s\S]*quoted/);
  assert.match(await render('---'), /<hr\s*\/?>/);
});

test('input mode keeps heading markers literal while the output still renders headings', async () => {
  // The composer preview (input mode) must not turn "#", "##" or "###" into headings.
  for (const marker of ['#', '##', '###']) {
    const html = await render(`${marker} Ringkasan`, { headings: false });
    assert.equal(/<h[1-6]/.test(html), false, `${marker} must not become a heading in the input preview`);
    assert.match(html, new RegExp(`${marker} Ringkasan`));
  }
  // Setext underlines are headings too, so they stay literal as well.
  const setext = await render('Judul\n=====', { headings: false });
  assert.equal(/<h[1-6]/.test(setext), false);

  // Every other construct keeps working in the input preview.
  const inline = await render('**tebal** dan `kode`', { headings: false });
  assert.match(inline, /<strong>tebal<\/strong>/);
  assert.match(inline, /<code>kode<\/code>/);

  // Model answers (default output mode) keep full heading support.
  assert.match(await render('# Title'), /<h1[^>]*>Title<\/h1>/);
  assert.match(await render('# Title', { headings: true }), /<h1[^>]*>Title<\/h1>/);
});

test('renders lists, block code and GFM tables', async () => {
  const bullets = await render('- one\n- two');
  assert.match(bullets, /<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>/);

  const numbered = await render('1. first\n2. second');
  assert.match(numbered, /<ol>[\s\S]*<li>first<\/li>/);

  const fence = await render('```js\nconst a = 1;\n```');
  assert.match(fence, /<pre>[\s\S]*<code[^>]*>[\s\S]*const a = 1;/);

  const table = await render('| Name | Qty |\n| --- | ---: |\n| Apple | 3 |');
  assert.match(table, /<table>/);
  assert.match(table, /<th[^>]*>Name<\/th>/);
  assert.match(table, /<td[^>]*>Apple<\/td>/);

  const taskList = await render('- [x] done\n- [ ] todo');
  assert.match(taskList, /<input[^>]*type="checkbox"/);
  assert.match(taskList, /checked/);
});

test('single line breaks stay inside the same paragraph', async () => {
  const html = await render('first line\nsecond line');
  assert.match(html, /first line[\s\S]*<br\s*\/?>[\s\S]*second line/);
});

test('links are rewritten to open safely in the system browser', async () => {
  const html = await render('see [docs](https://example.com "title")');
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /title="title"/);

  const auto = await render('visit https://example.com/page now');
  assert.match(auto, /<a href="https:\/\/example\.com\/page"/);

  const mail = await render('[mail](mailto:someone@example.com)');
  assert.match(mail, /href="mailto:someone@example\.com"/);
});

test('script tags, event handlers and raw HTML are neutralized', async () => {
  const script = await render('<script>alert(1)</script>');
  assert.equal(/<script/i.test(script), false);
  assert.match(script, /&lt;script&gt;/);

  // Escaped text may still contain the word "onerror"; what must never appear is a real tag/attribute.
  const img = await render('<img src=x onerror="alert(1)">');
  assert.equal(/<img/i.test(img), false);
  assert.equal(/<\w[^>]*\sonerror\s*=/i.test(img), false);
  assert.equal(/<\w[^>]*\ssrc\s*=/i.test(img), false);
  assert.match(img, /&lt;img/);

  const iframe = await render('<iframe src="https://evil.example"></iframe>');
  assert.equal(/<iframe/i.test(iframe), false);

  const handler = await render('[x](https://a.example "t\" onmouseover=alert(1)")');
  assert.equal(/<\w[^>]*\sonmouseover\s*=/i.test(handler), false);

  const style = await render('<p style="background:url(javascript:alert(1))">x</p>');
  assert.equal(/<\w[^>]*\sstyle\s*=/i.test(style), false);
  assert.match(style, /&lt;p style=/);
});

test('dangerous URL schemes never survive, obfuscated ones included', async () => {
  for (const payload of [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](java\nscript:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
  ]) {
    const html = await render(payload);
    assert.equal(/javascript:/i.test(html), false, `javascript: survived in ${payload}`);
    assert.equal(/vbscript:/i.test(html), false, `vbscript: survived in ${payload}`);
    assert.equal(/data:/.test(html) && /<a /.test(html), false, `data: URL survived in ${payload}`);
  }
});

test('embedded images are reduced to their alt text (no remote loads)', async () => {
  const html = await render('![tracking pixel](https://evil.example/pixel.png)');
  assert.equal(/<img/i.test(html), false);
  assert.match(html, /<em>tracking pixel<\/em>/);
});

test('malformed and empty input degrades gracefully', async () => {
  assert.equal(await render(''), '');
  assert.equal(await render(undefined), '');
  assert.match(await render('[unclosed](https://example.com'), /unclosed/);
  assert.match(await render('| broken | table'), /broken/);
});

test('markdownToText strips markers for tooltips and copy fallbacks', async () => {
  const engine = await loadEngine();
  const text = engine.markdownToText('**bold** and `code` and [link](https://x.example)\n\n- item');
  assert.match(text, /bold and code and link/);
  assert.equal(text.includes('**'), false);
  assert.equal(text.includes(']('), false);
});
