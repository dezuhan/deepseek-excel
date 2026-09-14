/**
 * Theme handling: System / Light / Dark.
 * The choice is stored locally and applied as the shadcn `.dark` class on <html>.
 */
const STORAGE_KEY = 'deepseek-excel-theme';
export const THEMES = ['system', 'light', 'dark'];

let media = null;
let current = 'system';

function systemPrefersDark() {
  return Boolean(media && media.matches);
}

export function applyTheme(theme) {
  current = THEMES.includes(theme) ? theme : 'system';
  const dark = current === 'dark' || (current === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
  return current;
}

export function getTheme() {
  return current;
}

export function setTheme(theme) {
  const applied = applyTheme(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, applied);
  } catch (err) {
    /* localStorage may be blocked */
  }
  return applied;
}

export function initTheme() {
  media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let stored = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    stored = null;
  }
  applyTheme(stored || 'system');
  if (media && media.addEventListener) {
    media.addEventListener('change', () => {
      if (current === 'system') applyTheme('system');
    });
  }
  return current;
}
