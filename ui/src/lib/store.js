import { useCallback, useSyncExternalStore } from 'react';

/** Tiny dependency-free store; used for all task pane state. */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();
  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore(store) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return [state, store.setState];
}

/** Language key from the engine (window.DSX.i18n) + re-render when the language changes. */
export function createI18nBinding() {
  const engine = window.DSX && window.DSX.i18n;
  const listeners = new Set();
  const store = createStore({ locale: engine ? engine.getLocale() : 'en-US' });
  return {
    store,
    t: (key, params) => (engine ? engine.t(key, params) : key),
    getLocale: () => (engine ? engine.getLocale() : 'en-US'),
    supported: () => (engine ? engine.SUPPORTED_LOCALES : ['en-US']),
    setLocale(locale) {
      if (engine) engine.setLocale(locale);
      store.setState({ locale: engine ? engine.getLocale() : locale });
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Language hook: returns t(), locale, and the setLocale that triggers a re-render. */
export function useI18n(binding) {
  const [state] = useStore(binding.store);
  const t = useCallback((key, params) => binding.t(key, params), [binding, state.locale]);
  return {
    t,
    locale: state.locale,
    setLocale: binding.setLocale,
    supported: binding.supported,
  };
}
