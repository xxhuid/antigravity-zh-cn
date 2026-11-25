/**
 * Runtime Bootstrapper (compiled with bundled locales into dist/i18n-runtime.js)
 */

export function bootstrapAntigravityI18n(bundle, createTranslatorFn, mountLanguageUIFn) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  if (window.__ANTIGRAVITY_I18N__ && window.__ANTIGRAVITY_I18N__.__initialized) {
    return window.__ANTIGRAVITY_I18N__;
  }

  const translator = createTranslatorFn(bundle, { window, document });
  let uiController = null;

  const start = () => {
    uiController = mountLanguageUIFn(translator, { window, document });
    translator.startObserver(document.body, () => {
      if (uiController) uiController.injectIntoSettings();
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  const api = {
    __initialized: true,
    version: bundle.version || '0.2.0',
    getLocale: () => translator.getLocale(),
    setLocale: (code) => translator.setLocale(code),
    getAvailableLocales: () => translator.getAvailableLocales(),
    registerLocale: (pack) => {
      const registered = translator.registerLocale(pack);
      if (uiController) {
        uiController.injectIntoSettings();
        uiController.syncFloatingBadge();
      }
      return registered;
    },
    collectUntranslated: () => translator.collectUntranslated(document.body),
    setDebugMode: (enabled) => uiController && uiController.setDebugEnabled(Boolean(enabled)),
    openLanguageModal: () => uiController && uiController.openLanguageModal(),
  };

  window.__ANTIGRAVITY_I18N__ = api;
  return api;
}
