/**
 * Markdown engine for the task pane.
 *
 * Output: `marked` (GFM: tables, task lists, strikethrough, autolinks) followed by a strict
 * `DOMPurify` pass, so model output and workbook data can never inject script, event handlers
 * or `javascript:` URLs into the pane.
 *
 * Input: `renderMarkdown` is reused for the live preview while composing, so what the user
 * writes goes through exactly the same pipeline as the answers.
 *
 * Extra safety on top of DOMPurify:
 *  - raw HTML in the source is escaped instead of parsed
 *  - embedded images (`![](…)`) are reduced to their alt text; no remote image is ever loaded
 *  - links are forced to `target="_blank" rel="noopener noreferrer"` and only http, https,
 *    mailto, anchors and relative URLs survive
 */
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a', 'span', 'input',
];

/** The composer preview deliberately drops headings: `#` stays literal while typing. */
const INPUT_TAGS = ALLOWED_TAGS.filter((tag) => !/^h[1-6]$/.test(tag));

const ALLOWED_ATTR = [
  'href', 'title', 'target', 'rel', 'class',
  'colspan', 'rowspan', 'align', 'type', 'checked', 'disabled',
];

const SAFE_URL = /^(https?:|mailto:|#|\/)/i;

function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(href) {
  const value = String(href || '').trim();
  if (!value) return '';
  // Strip whitespace and control characters that are used to disguise "javascript:" payloads.
  const cleaned = value.replace(/[\u0000-\u001F\u007F\s]/g, '');
  return SAFE_URL.test(cleaned) ? value : '';
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
});

/** Renderer shared by both engines; only heading handling differs between output and input. */
function sharedRenderer() {
  return {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    },
    image({ text }) {
      // Remote images are never rendered inside the pane; keep the alt text only.
      return text ? `<em>${escapeHtml(text)}</em>` : '';
    },
    html({ text }) {
      return escapeHtml(text);
    },
  };
}

marked.use({ renderer: sharedRenderer() });

/**
 * Input engine: `#`, `##`, `###` (and setext underlines) are shown as plain text instead of
 * becoming headings. The model's answers keep full heading support — only the composer is limited.
 */
const markedInput = new Marked({
  gfm: true,
  breaks: true,
  async: false,
});

markedInput.use({
  renderer: {
    ...sharedRenderer(),
    heading({ raw }) {
      const literal = String(raw === undefined || raw === null ? '' : raw).replace(/\s+$/, '');
      return literal ? `<p>${escapeHtml(literal)}</p>` : '';
    },
  },
});

const purify = typeof window !== 'undefined' ? createDOMPurify(window) : null;

if (purify) {
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * Renders Markdown into sanitized HTML. Unsafe or broken input degrades to escaped text.
 * `options.headings === false` is the composer mode: heading markers stay literal.
 */
export function renderMarkdown(text, options) {
  const source = text === undefined || text === null ? '' : String(text);
  if (!source.trim()) return '';
  const headings = !(options && options.headings === false);
  const engine = headings ? marked : markedInput;
  let html;
  try {
    html = engine.parse(source);
  } catch (err) {
    return `<p>${escapeHtml(source)}</p>`;
  }
  if (!purify) return `<p>${escapeHtml(source)}</p>`;
  return purify.sanitize(html, {
    ALLOWED_TAGS: headings ? ALLOWED_TAGS : INPUT_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'img', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'src', 'onerror', 'onload', 'onclick'],
    KEEP_CONTENT: true,
  });
}

/** Plain-text projection of Markdown (tooltips, copy fallbacks). */
export function markdownToText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z]*\n?/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\-\d.]+\s*/gm, '')
    .trim();
}
