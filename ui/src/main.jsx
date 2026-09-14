import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { createPane } from '@/lib/pane';
import { initTheme } from '@/lib/theme';

(window.Office || {}).onReady?.(() => {});

const pane = createPane();
// Hook for debugging in DevTools and for the jsdom smoke test (test/ui-react.test.js).
window.__DSH_PANE__ = pane;

function render(message) {
  const container = document.getElementById('root');
  if (message) {
    container.innerHTML = `<div style="padding:12px;font:13px 'Segoe UI',system-ui,sans-serif;color:#b42318">${message}</div>`;
    return;
  }
  createRoot(container).render(
    <StrictMode>
      <App pane={pane} />
    </StrictMode>,
  );
  window.__DSH_PANE_MOUNTED__ = true;
}

try {
  render(null);
} catch (error) {
  render(`Failed to load the interface: ${error && error.message}`);
}

pane.boot();

// Theme: System follows the Windows/Office preference, Light and Dark are explicit user choices.
// Applied as the shadcn `.dark` class and restored from localStorage on every pane load.
initTheme();

window.addEventListener('unhandledrejection', (event) => {
  pane.reportError(event.reason && event.reason.message ? event.reason.message : String(event.reason));
});
