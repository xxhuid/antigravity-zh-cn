/**
 * Antigravity UI i18n Core Engine
 * - Multi-language registry with instant runtime switching
 * - Strict DOM isolation (never mutates code blocks, terminals, inputs, or file paths)
 * - Original text/attribute WeakMap tracking for clean round-trip switching (zh-CN <-> en <-> other locales)
 */

const STORAGE_KEY_LOCALE = 'antigravity_i18n_locale';

const SKIP_TAGS = new Set([
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'MATH',
  'CANVAS',
  'VIDEO',
  'AUDIO',
]);

const SKIP_SELECTORS = [
  '[data-ag-i18n-ui]',
  '[data-ag-i18n-ignore]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]',
  '[role="code"]',
  '.monaco-editor',
  '.xterm',
  '.cm-editor',
  '.CodeMirror',
  '[data-terminal]',
];

const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'];

const DEFAULT_EN_UI = {
  sectionTitle: 'Language',
  settingLabel: 'Display Language',
  settingDescription:
    'Choose the display language for Antigravity UI. Changes take effect immediately.',
  modalTitle: 'Select Interface Language',
  modalSubtitle:
    'Switches instantly without restart. Shortcut: Ctrl+Alt+L (Cmd+Option+L on macOS).',
  toggleFloatingLabel: 'Show quick-switch floating button',
  floatingHint: 'If hidden, press Ctrl+Alt+L (Cmd+Option+L on macOS) or re-enable it here anytime.',
  closeButton: 'Close',
  badgeLabel: 'EN',
  badgeTooltip: 'Switch Antigravity UI Language (Ctrl+Alt+L)',
};

function isLikelyNonUIText(trimmed) {
  if (!trimmed || trimmed.length > 260) return true;
  // Pure digits, punctuation, or whitespace
  if (/^[\d\s.,:;!?+\-*/=<>()[\]{}|\\/@#$%^&~`'"]+$/.test(trimmed)) return true;
  // URLs
  if (/^https?:\/\//i.test(trimmed)) return true;
  // File paths (Windows or Unix)
  if (/^[a-zA-Z]:\\/.test(trimmed) || /^(\/|\.\/|\.\.\/|~\/)[\w.\-/]+$/.test(trimmed)) {
    return true;
  }
  // CLI flags
  if (/^--?[a-zA-Z0-9][\w-]*$/.test(trimmed)) return true;
  return false;
}

function normalizeWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  const compiled = [];
  for (const item of patterns) {
    if (!item || typeof item.regex !== 'string' || typeof item.replace !== 'string') continue;
    try {
      compiled.push({
        re: new RegExp(item.regex, item.flags || ''),
        replace: item.replace,
      });
    } catch {
      // Ignore malformed pattern at runtime; build validator catches these beforehand
    }
  }
  return compiled;
}

function elementMatchesAnySelector(el, selectors) {
  if (!el || typeof el !== 'object') return false;
  if (typeof el.closest === 'function') {
    for (const sel of selectors) {
      try {
        if (el.closest(sel)) return true;
      } catch {
        // Ignore selector errors in minimal DOM environments
      }
    }
    return false;
  }
  // Fallback traversal for minimal mock DOMs without Element.closest
  let cur = el;
  while (cur) {
    const attrs = cur.attributes || {};
    const getAttr = (name) =>
      typeof cur.getAttribute === 'function' ? cur.getAttribute(name) : attrs[name];
    if (getAttr('data-ag-i18n-ui') !== null && getAttr('data-ag-i18n-ui') !== undefined) {
      return true;
    }
    if (getAttr('data-ag-i18n-ignore') !== null && getAttr('data-ag-i18n-ignore') !== undefined) {
      return true;
    }
    const ce = getAttr('contenteditable');
    if (ce === 'true' || ce === '') return true;
    const role = getAttr('role');
    if (role === 'textbox' || role === 'code') return true;
    const className = typeof cur.className === 'string' ? cur.className : '';
    if (
      className.includes('monaco-editor') ||
      className.includes('xterm') ||
      className.includes('cm-editor') ||
      className.includes('CodeMirror')
    ) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode || null;
  }
  return false;
}

export function shouldSkipElement(el) {
  if (!el || el.nodeType !== 1) return false;
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const tag = (cur.tagName || '').toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    cur = cur.parentElement || cur.parentNode || null;
  }
  return elementMatchesAnySelector(el, SKIP_SELECTORS);
}

export function createTranslator(bundle, options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const storage = options.storage || (win && win.localStorage ? win.localStorage : null);

  const locales = new Map();
  const localeOrder = [];

  function registerLocale(pack) {
    if (!pack || !pack.code) {
      throw new Error('Locale pack must define a non-empty "code"');
    }
    const exact = Object.assign({}, pack.exact || {});
    const exactLower = Object.create(null);
    for (const [k, v] of Object.entries(exact)) {
      if (k.includes(' ')) {
        const lower = k.toLowerCase();
        if (!(lower in exactLower)) exactLower[lower] = v;
      }
    }
    const normalized = {
      code: pack.code,
      name: pack.name || pack.code,
      nativeName: pack.nativeName || pack.name || pack.code,
      direction: pack.direction || 'ltr',
      builtin: Boolean(pack.builtin),
      ui: Object.assign({}, DEFAULT_EN_UI, pack.ui || {}),
      exact,
      exactLower,
      patterns: compilePatterns(pack.patterns || []),
    };
    if (!locales.has(normalized.code)) {
      localeOrder.push(normalized.code);
    }
    locales.set(normalized.code, normalized);
    return normalized;
  }

  // Register locales from compiled bundle
  const initialLocales = (bundle && bundle.locales) || [];
  for (const pack of initialLocales) {
    registerLocale(pack);
  }
  if (!locales.has('en')) {
    registerLocale({
      code: 'en',
      name: 'English',
      nativeName: 'English (Original)',
      direction: 'ltr',
      builtin: true,
      ui: DEFAULT_EN_UI,
      exact: {},
      patterns: [],
    });
  }

  function readSavedLocale() {
    try {
      if (storage && typeof storage.getItem === 'function') {
        const saved = storage.getItem(STORAGE_KEY_LOCALE);
        if (saved && locales.has(saved)) return saved;
      }
    } catch {
      // Ignore storage access restrictions
    }
    const fallback = (bundle && bundle.defaultLocale) || 'zh-CN';
    return locales.has(fallback) ? fallback : 'en';
  }

  let currentLocale = readSavedLocale();
  const listeners = new Set();
  const originalTextMap = new WeakMap();
  const originalAttrMap = new WeakMap();
  const lastAppliedTextMap = new WeakMap();
  const lastAppliedAttrMap = new WeakMap();
  const trackedTextNodes = new Set();
  const trackedElements = new Set();
  const trackedMergedParents = new Set();
  const mergedParentOriginals = new WeakMap();

  const AMBIGUOUS_SHORT_WORDS = new Set(['No', 'Yes', 'On', 'Off', 'In', 'Or', 'To', 'By', 'At']);

  let isApplying = false;
  let observer = null;
  let scheduledFlush = null;
  const pendingRoots = new Set();

  function getLocaleMeta(code = currentLocale) {
    return locales.get(code) || locales.get('en');
  }

  function translateString(rawText, localeCode = currentLocale) {
    if (typeof rawText !== 'string' || !rawText) return rawText;
    const pack = locales.get(localeCode);
    if (!pack || pack.builtin || localeCode === 'en') {
      return rawText;
    }

    const leading = rawText.match(/^\s*/)[0];
    const trailing = rawText.match(/\s*$/)[0];
    const core = normalizeWhitespace(rawText);
    if (!core) return rawText;

    // Exact dictionary matches always win (even for longer Settings descriptions)
    if (Object.prototype.hasOwnProperty.call(pack.exact, core)) {
      return `${leading}${pack.exact[core]}${trailing}`;
    }

    // Multi-word case-insensitive fallback (handles Title Case vs Sentence case variants safely)
    if (core.includes(' ')) {
      const lowerKey = core.toLowerCase();
      if (pack.exactLower && lowerKey in pack.exactLower) {
        return `${leading}${pack.exactLower[lowerKey]}${trailing}`;
      }
    }

    if (isLikelyNonUIText(core)) return rawText;

    for (const entry of pack.patterns) {
      if (entry.re.test(core)) {
        const replaced = core.replace(entry.re, entry.replace);
        if (replaced !== core) {
          return `${leading}${replaced}${trailing}`;
        }
      }
    }

    return rawText;
  }

  function isFollowedByEnglishSibling(node) {
    let sib = node.nextSibling;
    while (sib) {
      const txt =
        sib.nodeType === 3
          ? originalTextMap.get(sib) ?? sib.nodeValue ?? ''
          : sib.textContent || '';
      if (txt.trim()) {
        return /^[A-Za-z]/.test(txt.trim());
      }
      sib = sib.nextSibling;
    }
    return false;
  }

  function setNodeValueTracked(node, nextValue) {
    lastAppliedTextMap.set(node, nextValue);
    if (node.nodeValue !== nextValue) {
      node.nodeValue = nextValue;
    }
  }

  function setAttrTracked(el, attr, nextValue) {
    let applied = lastAppliedAttrMap.get(el);
    if (!applied) {
      applied = new Map();
      lastAppliedAttrMap.set(el, applied);
    }
    applied.set(attr, nextValue);
    if (el.getAttribute(attr) !== nextValue) {
      el.setAttribute(attr, nextValue);
    }
  }

  function drainSelfMutations() {
    if (observer && typeof observer.takeRecords === 'function') {
      try {
        observer.takeRecords();
      } catch {
        // Ignore in minimal mock observers
      }
    }
  }

  function resolveNodeTranslation(node, sourceText) {
    const parent = node.parentElement || node.parentNode;
    // Guard against mis-translating split English phrases like `<span>No</span> automations yet`
    if (AMBIGUOUS_SHORT_WORDS.has(sourceText.trim()) && isFollowedByEnglishSibling(node)) {
      return sourceText;
    }

    // Contextual disambiguation for "New":
    // Standalone "+ New" action button -> "新建", while inline feature/model "New" badge -> "新"
    if (sourceText.trim() === 'New' && currentLocale === 'zh-CN' && parent) {
      const btn = typeof parent.closest === 'function' ? parent.closest('button') : null;
      const btnText = btn ? (btn.textContent || '').replace(/[+\s]/g, '') : '';
      const isCreateBtn = btnText === 'New' || btnText === '新建';
      const leading = sourceText.match(/^\s*/)[0];
      const trailing = sourceText.match(/\s*$/)[0];
      return `${leading}${isCreateBtn ? '新建' : '新'}${trailing}`;
    }

    return translateString(sourceText, currentLocale);
  }

  function processTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    const parent = node.parentElement || node.parentNode;
    if (!parent || shouldSkipElement(parent)) return;

    const currentValue = node.nodeValue;
    if (typeof currentValue !== 'string' || !currentValue.trim()) return;

    if (!originalTextMap.has(node)) {
      originalTextMap.set(node, currentValue);
      trackedTextNodes.add(node);
    }

    const sourceText = originalTextMap.get(node);
    setNodeValueTracked(node, resolveNodeTranslation(node, sourceText));
  }

  /**
   * Handle React-split adjacent text nodes inside a single element (e.g. `<div>{"No"}{" automations yet"}</div>`).
   * Returns true if the element's text children were translated as a merged phrase.
   */
  function tryProcessMergedTextChildren(el) {
    const children = el.childNodes;
    if (!children || children.length < 2) return false;
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeType !== 3) return false;
    }

    let snapshot = mergedParentOriginals.get(el);
    if (!snapshot || snapshot.nodes.length !== children.length) {
      const nodes = Array.from(children);
      const texts = nodes.map((n) => (originalTextMap.has(n) ? originalTextMap.get(n) : n.nodeValue || ''));
      const combined = texts.join('');
      const probe = translateString(combined, currentLocale);
      if (probe === combined && currentLocale !== 'en') {
        return false;
      }
      snapshot = { nodes, texts, combined };
      mergedParentOriginals.set(el, snapshot);
      trackedMergedParents.add(el);
    }

    const nextCombined = translateString(snapshot.combined, currentLocale);
    if (nextCombined === snapshot.combined) {
      for (let i = 0; i < snapshot.nodes.length; i++) {
        setNodeValueTracked(snapshot.nodes[i], snapshot.texts[i]);
      }
    } else {
      setNodeValueTracked(snapshot.nodes[0], nextCombined);
      for (let i = 1; i < snapshot.nodes.length; i++) {
        setNodeValueTracked(snapshot.nodes[i], '');
      }
    }
    return true;
  }

  function processElementAttributes(el) {
    if (!el || el.nodeType !== 1) return;
    // Allow placeholder/aria-label/title on INPUT/TEXTAREA unless explicitly ignored,
    // while still skipping our own UI and code/terminal containers.
    const tag = (el.tagName || '').toUpperCase();
    const isInputLike = tag === 'INPUT' || tag === 'TEXTAREA';
    if (!isInputLike && shouldSkipElement(el)) return;
    if (isInputLike && elementMatchesAnySelector(el, SKIP_SELECTORS)) return;

    if (typeof el.getAttribute !== 'function' || typeof el.setAttribute !== 'function') return;

    let attrCache = originalAttrMap.get(el);
    for (const attr of TRANSLATABLE_ATTRS) {
      const val = el.getAttribute(attr);
      if (typeof val !== 'string' || !val.trim()) continue;
      if (!attrCache) {
        attrCache = new Map();
        originalAttrMap.set(el, attrCache);
        trackedElements.add(el);
      }
      if (!attrCache.has(attr)) {
        attrCache.set(attr, val);
      }
      const sourceVal = attrCache.get(attr);
      const nextVal = translateString(sourceVal, currentLocale);
      setAttrTracked(el, attr, nextVal);
    }
  }

  function translateTree(root) {
    if (!root) return;
    const prevApplying = isApplying;
    isApplying = true;
    try {
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;

        if (node.nodeType === 3) {
          processTextNode(node);
          continue;
        }

        if (node.nodeType === 1) {
          processElementAttributes(node);
          if (shouldSkipElement(node)) continue;
          if (node.shadowRoot) {
            stack.push(node.shadowRoot);
          }
          if (tryProcessMergedTextChildren(node)) {
            continue;
          }
        }

        const children = node.childNodes;
        if (children && children.length) {
          for (let i = children.length - 1; i >= 0; i--) {
            stack.push(children[i]);
          }
        }
      }
    } finally {
      if (!prevApplying) drainSelfMutations();
      isApplying = prevApplying;
    }
  }

  function reapplyAllTracked() {
    const prevApplying = isApplying;
    isApplying = true;
    try {
      for (const el of Array.from(trackedMergedParents)) {
        if (!el.parentNode) {
          trackedMergedParents.delete(el);
          continue;
        }
        tryProcessMergedTextChildren(el);
      }

      for (const node of Array.from(trackedTextNodes)) {
        if (!node.parentNode) {
          trackedTextNodes.delete(node);
          continue;
        }
        const sourceText = originalTextMap.get(node);
        if (typeof sourceText !== 'string') continue;
        setNodeValueTracked(node, resolveNodeTranslation(node, sourceText));
      }

      for (const el of Array.from(trackedElements)) {
        if (!el.parentNode) {
          trackedElements.delete(el);
          continue;
        }
        const attrCache = originalAttrMap.get(el);
        if (!attrCache) continue;
        for (const [attr, sourceVal] of attrCache.entries()) {
          const nextVal = translateString(sourceVal, currentLocale);
          setAttrTracked(el, attr, nextVal);
        }
      }
    } finally {
      if (!prevApplying) drainSelfMutations();
      isApplying = prevApplying;
    }
  }

  function syncDocumentLang() {
    if (!doc || !doc.documentElement) return;
    const meta = getLocaleMeta(currentLocale);
    try {
      doc.documentElement.lang = meta.code;
      doc.documentElement.dir = meta.direction || 'ltr';
    } catch {
      // Ignore in read-only mock environments
    }
  }

  function setLocale(code) {
    if (!locales.has(code)) {
      throw new Error(`Unknown locale "${code}". Registered: ${localeOrder.join(', ')}`);
    }
    const changed = code !== currentLocale;
    currentLocale = code;

    try {
      if (storage && typeof storage.setItem === 'function') {
        storage.setItem(STORAGE_KEY_LOCALE, code);
      }
    } catch {
      // Ignore storage errors
    }

    syncDocumentLang();
    reapplyAllTracked();
    if (doc && doc.body) {
      translateTree(doc.body);
    }

    if (changed) {
      const meta = getLocaleMeta(code);
      for (const fn of listeners) {
        try {
          fn(code, meta);
        } catch {
          // Isolate listener errors
        }
      }
      if (win && typeof win.dispatchEvent === 'function' && typeof win.CustomEvent === 'function') {
        win.dispatchEvent(new win.CustomEvent('antigravity-i18n:change', { detail: { code, meta } }));
      }
    }
    return currentLocale;
  }

  function scheduleFlush(onFlushCallback) {
    if (scheduledFlush !== null) return;
    const run = () => {
      scheduledFlush = null;
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      for (const r of roots) {
        translateTree(r);
      }
      if (typeof onFlushCallback === 'function') {
        onFlushCallback();
      }
    };
    if (win && typeof win.requestAnimationFrame === 'function') {
      scheduledFlush = win.requestAnimationFrame(run);
    } else {
      scheduledFlush = setTimeout(run, 16);
    }
  }

  function startObserver(root = doc && doc.body, onMutationFlush = null) {
    if (!root) return null;
    syncDocumentLang();
    translateTree(root);

    const MO =
      options.MutationObserver ||
      (win && win.MutationObserver) ||
      (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (!MO) return null;

    if (observer) observer.disconnect();
    observer = new MO((mutations) => {
      if (isApplying) return;
      let dirty = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const added of m.addedNodes || []) {
            if (added.nodeType === 1 && elementMatchesAnySelector(added, ['[data-ag-i18n-ui]'])) {
              continue;
            }
            pendingRoots.add(added);
            dirty = true;
          }
        } else if (m.type === 'characterData') {
          const target = m.target;
          const parent = target && (target.parentElement || target.parentNode);
          if (parent && !shouldSkipElement(parent)) {
            // Ignore our own translation writes so original English text is NEVER overwritten
            if (lastAppliedTextMap.has(target) && lastAppliedTextMap.get(target) === target.nodeValue) {
              continue;
            }
            // Text changed legitimately by app state: refresh original source
            originalTextMap.set(target, target.nodeValue);
            trackedTextNodes.add(target);
            pendingRoots.add(target);
            dirty = true;
          }
        } else if (m.type === 'attributes' && TRANSLATABLE_ATTRS.includes(m.attributeName)) {
          const el = m.target;
          if (el && el.nodeType === 1) {
            const val = el.getAttribute(m.attributeName);
            const appliedMap = lastAppliedAttrMap.get(el);
            if (appliedMap && appliedMap.get(m.attributeName) === val) {
              continue;
            }
            if (typeof val === 'string') {
              let cache = originalAttrMap.get(el);
              if (!cache) {
                cache = new Map();
                originalAttrMap.set(el, cache);
                trackedElements.add(el);
              }
              cache.set(m.attributeName, val);
              pendingRoots.add(el);
              dirty = true;
            }
          }
        }
      }
      if (dirty) {
        scheduleFlush(onMutationFlush);
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRS,
    });
    return observer;
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function getAvailableLocales() {
    return localeOrder.map((code) => {
      const item = locales.get(code);
      return {
        code: item.code,
        name: item.name,
        nativeName: item.nativeName,
        direction: item.direction,
        builtin: item.builtin,
      };
    });
  }

  function collectUntranslated(root = doc && doc.body) {
    if (!root) return {};
    const found = {};
    const stack = [root];
    const hasLatin = /[A-Za-z]{2,}/;
    const hasCjk = /[\u4e00-\u9fff]/;
    const ignoredBrands = new Set(['Antigravity', 'Google Antigravity', 'Gemini', 'Claude', 'GPT']);

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;

      if (node.nodeType === 3) {
        const parent = node.parentElement || node.parentNode;
        if (!parent || shouldSkipElement(parent)) continue;
        const raw = originalTextMap.get(node) || node.nodeValue || '';
        const core = normalizeWhitespace(raw);
        if (
          !core ||
          core.length > 140 ||
          ignoredBrands.has(core) ||
          /^(Gemini|Claude|GPT|o1|o3)\b/.test(core) ||
          isLikelyNonUIText(core) ||
          !hasLatin.test(core) ||
          hasCjk.test(core) ||
          /@/.test(core)
        ) {
          continue;
        }
        const translated = translateString(core, currentLocale);
        if (translated === core && !Object.prototype.hasOwnProperty.call(found, core)) {
          found[core] = '';
        }
        continue;
      }

      if (node.nodeType === 1) {
        if (shouldSkipElement(node)) continue;
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }

      const children = node.childNodes;
      if (children && children.length) {
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i]);
        }
      }
    }
    return found;
  }

  return {
    registerLocale,
    getAvailableLocales,
    getLocale: () => currentLocale,
    getLocaleMeta,
    setLocale,
    translateString,
    translateTree,
    collectUntranslated,
    startObserver,
    stopObserver,
    subscribe,
  };
}
