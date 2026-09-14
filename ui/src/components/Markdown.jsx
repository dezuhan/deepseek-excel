import { useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/**
 * Renders Markdown produced by the engine (marked + DOMPurify).
 *
 * `mode="input"` is the composer preview: heading markers (`#`, `##`) stay literal there,
 * while model answers (`mode="output"`, the default) render real headings.
 *
 * A "Copy" button is injected into every code block after mount. It is added here instead of
 * inside the sanitized HTML so the sanitizer always runs on the raw engine output only.
 */
export default function Markdown({ text, className, mode = 'output', copyLabel = 'Copy', copiedLabel = 'Copied' }) {
  const html = useMemo(() => renderMarkdown(text, { headings: mode !== 'input' }), [text, mode]);
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('[data-copy-button]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.copyButton = 'true';
      button.className = 'md-copy';
      button.textContent = copyLabel;
      button.setAttribute('aria-label', copyLabel);
      pre.appendChild(button);
    });
  }, [html, copyLabel]);

  const handleClick = async (event) => {
    const button = event.target.closest('[data-copy-button]');
    if (!button) return;
    const pre = button.closest('pre');
    const code = pre ? pre.querySelector('code') || pre : null;
    if (!code) return;
    const value = code.textContent || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', 'readonly');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        document.body.removeChild(helper);
      }
      button.textContent = copiedLabel;
      window.setTimeout(() => {
        button.textContent = copyLabel;
      }, 1500);
    } catch (err) {
      button.textContent = '!';
    }
  };

  if (!html) return null;

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className={cn('md', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
