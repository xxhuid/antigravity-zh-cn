/**
 * Antigravity UI i18n Core Engine
 * - Multi-language registry with instant runtime switching (zh-CN <-> en <-> custom locales)
 * - Strict DOM & user-content boundary isolation:
 *     * Hard-skips code, terminals, editors, inputs, SVGs, iframes, and our own UI
 *     * Protects user/AI message bodies, Markdown, file trees, conversation/project names,
 *       and customization/plugin author descriptions (while still translating nested UI action buttons
 *       in mixed containers like file tree items or conversation rows)
 *     * Restores original text/attributes automatically if a node is moved into a protected container
 * - Zero memory leaks: WeakMap-only node tracking (no strong Sets retaining detached DOM nodes)
 * - High performance:
 *     * Per-slice transient WeakMap mode cache (O(1) per element, no O(N * depth) ancestor re-walks)
 *     * Per-locale translation memoization + fast ASCII short-circuit
 *     * Overlap root deduplication + disconnected node pruning
 *     * Frame-budgeted async mutation flushing (max 200 nodes / 6ms per rAF slice, never drops tail nodes)
 * - Optional scoped dictionaries so context-specific terms never pollute global exact matching
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
  'IFRAME',
]);

const HARD_SKIP_SELECTORS = [
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

// Strictly protected user/author content containers: nothing inside (including nested buttons) is translated
const STRICT_PROTECTED_SELECTORS = [
  '[data-markdown-root]',
  '[data-testid="user-message-content"]',
  '.user-message-content',
  '[data-testid="planner-response-text"]',
  '.planner-response-text',
  '[data-testid="user-input-step"]',
  '.user-input-step',
  '.markdown-body',
  '.prose',
  '[data-uri][data-quotable-inline]',
  '[data-testid="breadcrumb-segment"]',
  '.breadcrumb-segment',
  '[data-project-label]',
  '[data-testid="conversation-title"]',
  '[data-testid="customization-name"]',
  '[data-testid="customization-description"]',
  '[data-customization-author]',
  '[data-plugin-description]',
  '[data-skill-description]',
];

// Mixed containers: item names/plain text stay protected, while explicit UI action buttons inside can be translated
const MIXED_PROTECTED_SELECTORS = [
  '[role="tree"]',
  '[role="treeitem"]',
  '[data-testid="conversation-row-sidebar"]',
  '[data-testid="project-header"]',
];

const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'];

const MODE_TRANSLATE = 0;
const MODE_PROTECTED_MIXED = 1;
const MODE_PROTECTED_STRICT = 2;
const MODE_HARD_SKIP = 3;

const MAX_TRANSLATION_CACHE_SIZE = 4000;
const ASYNC_SLICE_NODE_BUDGET = 200;
const ASYNC_SLICE_TIME_BUDGET_MS = 6;

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
  // Pure digits, punctuation, or whitespace (or non-ASCII-only text with no Latin letters)
  if (!/[A-Za-z]/.test(trimmed)) return true;
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

function compileScopedEntries(scoped) {
  if (!Array.isArray(scoped)) return [];
  const compiled = [];
  for (const entry of scoped) {
    if (!entry || typeof entry.selector !== 'string' || !entry.selector.trim()) continue;
    const exact = Object.assign({}, entry.exact || {});
    const patterns = compilePatterns(entry.patterns || []);
    if (Object.keys(exact).length === 0 && patterns.length === 0) continue;
    compiled.push({
      selector: entry.selector.trim(),
      exact,
      patterns,
    });
  }
  return compiled;
}

function getElementAttr(el, name) {
  if (!el || typeof el !== 'object') return null;
  if (typeof el.getAttribute === 'function') return el.getAttribute(name);
  if (el.attributes && Object.prototype.hasOwnProperty.call(el.attributes, name)) {
    return el.attributes[name];
  }
  return null;
}

function hasElementClass(el, cls) {
  const className = typeof el.className === 'string' ? el.className : getElementAttr(el, 'class') || '';
  if (!className) return false;
  return className.split(/\s+/).includes(cls);
}

/**
 * Check whether a single element (NOT its ancestors) matches a simple or compound selector.
 * Supports real browser Element.matches and minimal Mock DOMs without Element.matches.
 */
function elementMatchesSelf(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  if (typeof el.matches === 'function') {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }
  const s = selector.trim();
  // Compound attribute selector like `[data-uri][data-quotable-inline]`
  if (/^(\[[^\]]+\]){2,}$/.test(s)) {
    const parts = s.match(/\[[^\]]+\]/g) || [];
    return parts.every((part) => elementMatchesSelf(el, part));
  }
  if (s.startsWith('.')) {
    return hasElementClass(el, s.slice(1));
  }
  const attrEq = s.match(/^\[([^=\]]+)="([^"]*)"\]$/);
  if (attrEq) {
    return getElementAttr(el, attrEq[1]) === attrEq[2];
  }
  const attrHas = s.match(/^\[([^=\]]+)\]$/);
  if (attrHas) {
    const val = getElementAttr(el, attrHas[1]);
    return val !== null && val !== undefined;
  }
  if (typeof el.matchesSimple === 'function') {
    return el.matchesSimple(s);
  }
  return (el.tagName || '').toUpperCase() === s.toUpperCase();
}

function elementMatchesAnySelf(el, selectors) {
  for (let i = 0; i < selectors.length; i++) {
    if (elementMatchesSelf(el, selectors[i])) return true;
  }
  return false;
}

function isExplicitActionControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = (el.tagName || '').toUpperCase();
  const role = getElementAttr(el, 'role');
  const isButtonLike = tag === 'BUTTON' || role === 'button' || role === 'menuitem';
  if (!isButtonLike) return false;
  // File links or project-label triggers masquerading as buttons must stay protected
  if (
    getElementAttr(el, 'data-uri') !== null ||
    getElementAttr(el, 'data-project-label') !== null ||
    getElementAttr(el, 'data-quotable-inline') !== null
  ) {
    return false;
  }
  return true;
}

/**
 * Compute element translation mode given its parent's already-known mode (O(1) per element).
 */
function classifyElementFromParent(el, parentMode) {
  if (!el || el.nodeType !== 1) return MODE_TRANSLATE;
  if (parentMode === MODE_HARD_SKIP) return MODE_HARD_SKIP;

  const tag = (el.tagName || '').toUpperCase();
  if (SKIP_TAGS.has(tag) || elementMatchesAnySelf(el, HARD_SKIP_SELECTORS)) {
    return MODE_HARD_SKIP;
  }

  if (parentMode === MODE_PROTECTED_STRICT) return MODE_PROTECTED_STRICT;

  if (elementMatchesAnySelf(el, STRICT_PROTECTED_SELECTORS)) {
    return MODE_PROTECTED_STRICT;
  }

  // Links inside conversation-row-sidebar carry conversation titles -> strict protection
  if (
    parentMode === MODE_PROTECTED_MIXED &&
    tag === 'A' &&
    typeof el.closest === 'function' &&
    el.closest('[data-testid="conversation-row-sidebar"]')
  ) {
    return MODE_PROTECTED_STRICT;
  }

  if (parentMode === MODE_PROTECTED_MIXED) {
    // Allow explicit UI action buttons (e.g. Copy / Delete / Pin) inside mixed rows/trees
    if (isExplicitActionControl(el)) {
      return MODE_TRANSLATE;
    }
    return MODE_PROTECTED_MIXED;
  }

  if (elementMatchesAnySelf(el, MIXED_PROTECTED_SELECTORS)) {
    return MODE_PROTECTED_MIXED;
  }

  return MODE_TRANSLATE;
}

/**
 * Resolve element mode by walking ancestors once, optionally reusing a transient per-slice WeakMap.
 */
function resolveElementMode(el, modeCache = null) {
  if (!el || el.nodeType !== 1) return MODE_TRANSLATE;
  if (modeCache && modeCache.has(el)) return modeCache.get(el);

  // Collect ancestor chain up to the first cached node or document root
  const chain = [];
  let cur = el;
  let baseMode = MODE_TRANSLATE;
  while (cur && cur.nodeType === 1) {
    if (modeCache && modeCache.has(cur)) {
      baseMode = modeCache.get(cur);
      break;
    }
    chain.push(cur);
    cur = cur.parentElement || (cur.parentNode && cur.parentNode.nodeType === 1 ? cur.parentNode : null);
  }

  let mode = baseMode;
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    mode = classifyElementFromParent(node, mode);
    if (modeCache) modeCache.set(node, mode);
  }
  return mode;
}

/**
 * Public helper: returns true if text directly inside `el` should NOT be translated.
 */
export function shouldSkipElement(el) {
  if (!el || el.nodeType !== 1) return false;
  return resolveElementMode(el, null) !== MODE_TRANSLATE;
}

function isNodeConnected(node, fallbackRoot) {
  if (!node) return false;
  if (typeof node.isConnected === 'boolean') return node.isConnected;
  let cur = node;
  while (cur) {
    if (cur === fallbackRoot) return true;
    cur = cur.parentNode || cur.parentElement || null;
  }
  return false;
}

function nodeContains(ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  if (typeof ancestor.contains === 'function') {
    try {
      return ancestor.contains(descendant);
    } catch {
      // Fall through to parent walk
    }
  }
  let cur = descendant.parentNode || descendant.parentElement || null;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentNode || cur.parentElement || null;
  }
  return false;
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
      scoped: compileScopedEntries(pack.scoped || []),
    };
    if (!locales.has(normalized.code)) {
      localeOrder.push(normalized.code);
    }
    locales.set(normalized.code, normalized);
    translationCache.clear();
    return normalized;
  }

  const translationCache = new Map();

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
      scoped: [],
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

  // WeakMap-only tracking: detached DOM nodes are automatically garbage-collected (zero memory leak)
  const originalTextMap = new WeakMap();
  const originalAttrMap = new WeakMap();
  const lastAppliedTextMap = new WeakMap();
  const lastAppliedAttrMap = new WeakMap();
  const mergedParentOriginals = new WeakMap();

  const AMBIGUOUS_SHORT_WORDS = new Set(['No', 'Yes', 'On', 'Off', 'In', 'Or', 'To', 'By', 'At']);

  let isApplying = false;
  let observer = null;
  let observedRoot = null;
  let scheduledFlush = null;
  let flushCallback = null;
  const pendingRoots = new Set();
  const asyncWorkStack = [];

  const getNow =
    win && win.performance && typeof win.performance.now === 'function'
      ? () => win.performance.now()
      : () => Date.now();

  function getLocaleMeta(code = currentLocale) {
    return locales.get(code) || locales.get('en');
  }

  function cacheTranslation(cacheKey, value) {
    if (translationCache.size >= MAX_TRANSLATION_CACHE_SIZE) {
      translationCache.clear();
    }
    translationCache.set(cacheKey, value);
    return value;
  }

  function lookupCoreTranslation(core, pack) {
    // 1. Exact dictionary match always wins (even for long descriptions)
    if (Object.prototype.hasOwnProperty.call(pack.exact, core)) {
      return pack.exact[core];
    }

    // 2. Multi-word case-insensitive fallback (handles Title Case vs Sentence case safely)
    if (core.includes(' ')) {
      const lowerKey = core.toLowerCase();
      if (pack.exactLower && lowerKey in pack.exactLower) {
        return pack.exactLower[lowerKey];
      }
    }

    if (isLikelyNonUIText(core)) return null;

    // 3. Regex patterns
    for (let i = 0; i < pack.patterns.length; i++) {
      const entry = pack.patterns[i];
      if (entry.re.test(core)) {
        const replaced = core.replace(entry.re, entry.replace);
        entry.re.lastIndex = 0;
        if (replaced !== core) {
          return replaced;
        }
      }
    }

    // 4. Trailing punctuation stripping (e.g. "Settings:" -> "设置：", "Loading..." -> "加载中...")
    const puncMatch = core.match(/^([\w\s\-/]+?)([:：…?!]+|\.{3})$/);
    if (puncMatch) {
      const base = puncMatch[1].trim();
      const punc = puncMatch[2];
      const baseTranslated = Object.prototype.hasOwnProperty.call(pack.exact, base)
        ? pack.exact[base]
        : base.includes(' ') && pack.exactLower && base.toLowerCase() in pack.exactLower
          ? pack.exactLower[base.toLowerCase()]
          : null;
      if (baseTranslated) {
        const localizedPunc =
          pack.code.startsWith('zh') && punc === ':' ? '：' : punc;
        return `${baseTranslated}${localizedPunc}`;
      }
    }

    // 5. Hotkey suffix preservation (e.g. "Command Palette (Ctrl+Shift+P)", "Archive Conversation Ctrl+Alt+A", "Pin ⌥⇧P")
    const hotkeyMatch = core.match(
      /^([\w\s\-/]+?)\s+(\((?:Ctrl|Cmd|Alt|Shift|⌘|⌥|⌃|⇧)[^)]+\)|(?:Ctrl|Cmd|Alt|Shift)\+[\w;:,/+\-]+|[⌘⌥⌃⇧]+[\w;:,/+\-]+)$/i,
    );
    if (hotkeyMatch) {
      const base = hotkeyMatch[1].trim();
      const hotkey = hotkeyMatch[2].trim();
      const baseTranslated = Object.prototype.hasOwnProperty.call(pack.exact, base)
        ? pack.exact[base]
        : base.includes(' ') && pack.exactLower && base.toLowerCase() in pack.exactLower
          ? pack.exactLower[base.toLowerCase()]
          : null;
      if (baseTranslated) {
        return `${baseTranslated} ${hotkey}`;
      }
    }

    return null;
  }

  function translateScopedString(core, el, pack) {
    if (!pack.scoped || pack.scoped.length === 0 || !el || el.nodeType !== 1) return null;
    for (let i = 0; i < pack.scoped.length; i++) {
      const scope = pack.scoped[i];
      let inScope = false;
      if (typeof el.closest === 'function') {
        try {
          inScope = Boolean(el.closest(scope.selector));
        } catch {
          inScope = false;
        }
      } else {
        let cur = el;
        while (cur && cur.nodeType === 1) {
          if (elementMatchesSelf(cur, scope.selector)) {
            inScope = true;
            break;
          }
          cur = cur.parentElement || null;
        }
      }
      if (!inScope) continue;
      if (Object.prototype.hasOwnProperty.call(scope.exact, core)) {
        return scope.exact[core];
      }
      for (let p = 0; p < scope.patterns.length; p++) {
        const entry = scope.patterns[p];
        if (entry.re.test(core)) {
          const replaced = core.replace(entry.re, entry.replace);
          entry.re.lastIndex = 0;
          if (replaced !== core) return replaced;
        }
      }
    }
    return null;
  }

  function translateString(rawText, localeCode = currentLocale, contextEl = null) {
    if (typeof rawText !== 'string' || !rawText) return rawText;
    const pack = locales.get(localeCode);
    if (!pack || pack.builtin || localeCode === 'en') {
      return rawText;
    }

    const core = normalizeWhitespace(rawText);
    if (!core || !/[A-Za-z]/.test(core)) return rawText;

    const leading = rawText.match(/^\s*/)[0];
    const trailing = rawText.match(/\s*$/)[0];

    // Scoped dictionary takes precedence inside matching containers (never cached globally)
    if (contextEl && pack.scoped && pack.scoped.length > 0) {
      const scopedHit = translateScopedString(core, contextEl, pack);
      if (scopedHit !== null) {
        return `${leading}${scopedHit}${trailing}`;
      }
    }

    const cacheKey = `${localeCode}\u0000${core}`;
    if (translationCache.has(cacheKey)) {
      const cached = translationCache.get(cacheKey);
      return cached === null ? rawText : `${leading}${cached}${trailing}`;
    }

    const hit = lookupCoreTranslation(core, pack);
    cacheTranslation(cacheKey, hit);
    return hit === null ? rawText : `${leading}${hit}${trailing}`;
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

  function restoreTextNodeIfTranslated(node) {
    if (!originalTextMap.has(node)) return;
    const orig = originalTextMap.get(node);
    originalTextMap.delete(node);
    setNodeValueTracked(node, orig);
  }

  function restoreMergedParentIfTranslated(el) {
    const snapshot = mergedParentOriginals.get(el);
    if (!snapshot) return;
    mergedParentOriginals.delete(el);
    for (let i = 0; i < snapshot.nodes.length; i++) {
      const child = snapshot.nodes[i];
      originalTextMap.delete(child);
      setNodeValueTracked(child, snapshot.texts[i]);
    }
  }

  function restoreElementAttrsIfTranslated(el) {
    const attrCache = originalAttrMap.get(el);
    if (!attrCache) return;
    originalAttrMap.delete(el);
    for (const [attr, origVal] of attrCache.entries()) {
      setAttrTracked(el, attr, origVal);
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

  function resolveNodeTranslation(node, sourceText, parent) {
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

    return translateString(sourceText, currentLocale, parent);
  }

  function processTextNode(node, parentMode = null, modeCache = null) {
    if (!node || node.nodeType !== 3) return;
    const parent = node.parentElement || node.parentNode;
    if (!parent || parent.nodeType !== 1) return;

    const mode = parentMode !== null ? parentMode : resolveElementMode(parent, modeCache);
    if (mode !== MODE_TRANSLATE) {
      // If a previously translated node was moved into a protected container, restore original text
      restoreTextNodeIfTranslated(node);
      return;
    }

    const currentValue = node.nodeValue;
    if (typeof currentValue !== 'string' || !currentValue.trim()) return;

    const hasOrig = originalTextMap.has(node);
    const sourceText = hasOrig ? originalTextMap.get(node) : currentValue;
    const nextValue = resolveNodeTranslation(node, sourceText, parent);

    if (nextValue !== sourceText) {
      if (!hasOrig) originalTextMap.set(node, sourceText);
      setNodeValueTracked(node, nextValue);
    } else if (hasOrig) {
      // Switching back to English or text no longer translates -> restore and release WeakMap entry
      originalTextMap.delete(node);
      setNodeValueTracked(node, sourceText);
    }
  }

  /**
   * Handle React-split adjacent text nodes inside a single element (e.g. `<div>{"No"}{" automations yet"}</div>`).
   * Returns true if the element's text children were handled as a merged phrase.
   */
  function tryProcessMergedTextChildren(el, elMode = MODE_TRANSLATE) {
    if (elMode !== MODE_TRANSLATE) {
      restoreMergedParentIfTranslated(el);
      return false;
    }
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
      const probe = translateString(combined, currentLocale, el);
      if (probe === combined && currentLocale !== 'en') {
        return false;
      }
      if (probe === combined && !snapshot) {
        return false;
      }
      snapshot = { nodes, texts, combined };
      mergedParentOriginals.set(el, snapshot);
    }

    const nextCombined = translateString(snapshot.combined, currentLocale, el);
    if (nextCombined === snapshot.combined) {
      mergedParentOriginals.delete(el);
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

  function processElementAttributes(el, elMode, parentMode = null, modeCache = null) {
    if (!el || el.nodeType !== 1) return;
    if (typeof el.getAttribute !== 'function' || typeof el.setAttribute !== 'function') return;

    const tag = (el.tagName || '').toUpperCase();
    const isInputLike = tag === 'INPUT' || tag === 'TEXTAREA';

    let allowAttrs = elMode === MODE_TRANSLATE;
    if (isInputLike) {
      // Allow placeholder/aria-label/title on INPUT/TEXTAREA unless inside hard-skip or protected content
      const effectiveParentMode =
        parentMode !== null
          ? parentMode
          : el.parentElement
            ? resolveElementMode(el.parentElement, modeCache)
            : MODE_TRANSLATE;
      allowAttrs =
        effectiveParentMode === MODE_TRANSLATE &&
        !elementMatchesAnySelf(el, HARD_SKIP_SELECTORS) &&
        !elementMatchesAnySelf(el, STRICT_PROTECTED_SELECTORS);
    }

    if (!allowAttrs) {
      restoreElementAttrsIfTranslated(el);
      return;
    }

    let attrCache = originalAttrMap.get(el);
    for (let i = 0; i < TRANSLATABLE_ATTRS.length; i++) {
      const attr = TRANSLATABLE_ATTRS[i];
      const val = el.getAttribute(attr);
      if (typeof val !== 'string' || !val.trim()) continue;

      const hasOrig = Boolean(attrCache && attrCache.has(attr));
      const sourceVal = hasOrig ? attrCache.get(attr) : val;
      const nextVal = translateString(sourceVal, currentLocale, el);

      if (nextVal !== sourceVal) {
        if (!attrCache) {
          attrCache = new Map();
          originalAttrMap.set(el, attrCache);
        }
        if (!hasOrig) attrCache.set(attr, sourceVal);
        setAttrTracked(el, attr, nextVal);
      } else if (hasOrig) {
        attrCache.delete(attr);
        if (attrCache.size === 0) originalAttrMap.delete(el);
        setAttrTracked(el, attr, sourceVal);
      }
    }
  }

  function visitNode(node, parentMode, modeCache, stack) {
    if (!node) return;

    if (node.nodeType === 3) {
      processTextNode(node, parentMode, modeCache);
      return;
    }

    if (node.nodeType === 1) {
      const elMode =
        parentMode !== null
          ? classifyElementFromParent(node, parentMode)
          : resolveElementMode(node, modeCache);
      modeCache.set(node, elMode);

      processElementAttributes(node, elMode, parentMode, modeCache);

      if (elMode === MODE_HARD_SKIP) {
        return;
      }

      if (elMode !== MODE_TRANSLATE) {
        // Restore any previously merged/translated children if this subtree was moved into protected content
        restoreMergedParentIfTranslated(node);
      }

      if (node.shadowRoot) {
        stack.push({ node: node.shadowRoot, parentMode: elMode });
      }

      if (elMode === MODE_TRANSLATE && tryProcessMergedTextChildren(node, elMode)) {
        return;
      }

      const children = node.childNodes;
      if (children && children.length) {
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ node: children[i], parentMode: elMode });
        }
      }
      return;
    }

    // DocumentFragment / ShadowRoot / Document
    const children = node.childNodes;
    if (children && children.length) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], parentMode });
      }
    }
  }

  function translateTree(root) {
    if (!root) return;
    const prevApplying = isApplying;
    isApplying = true;
    const modeCache = new WeakMap();
    try {
      const initialParentMode =
        root.nodeType === 1 && root.parentElement
          ? resolveElementMode(root.parentElement, modeCache)
          : root.nodeType === 3 && root.parentElement
            ? resolveElementMode(root.parentElement, modeCache)
            : null;
      const stack = [{ node: root, parentMode: initialParentMode }];
      while (stack.length > 0) {
        const item = stack.pop();
        visitNode(item.node, item.parentMode, modeCache, stack);
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
    translationCache.clear();

    try {
      if (storage && typeof storage.setItem === 'function') {
        storage.setItem(STORAGE_KEY_LOCALE, code);
      }
    } catch {
      // Ignore storage errors
    }

    syncDocumentLang();

    // Clear stale async work and synchronously re-translate the live tree
    pendingRoots.clear();
    asyncWorkStack.length = 0;

    const targetRoot = observedRoot || (doc && doc.body);
    if (targetRoot) {
      translateTree(targetRoot);
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

  function enqueueDeduplicatedRoots() {
    if (pendingRoots.size === 0) return;
    const fallbackRoot = observedRoot || (doc && doc.body);

    // Collapse massive burst (>500 pending roots) into a single incremental scan of the observed root
    if (pendingRoots.size > 500 && fallbackRoot) {
      pendingRoots.clear();
      asyncWorkStack.length = 0;
      asyncWorkStack.push({ node: fallbackRoot, parentMode: null });
      return;
    }

    const rawRoots = [];
    for (const r of pendingRoots) {
      if (isNodeConnected(r, fallbackRoot)) {
        rawRoots.push(r);
      }
    }
    pendingRoots.clear();

    // Prune redundant child roots whose ancestor is already queued
    for (let i = 0; i < rawRoots.length; i++) {
      const candidate = rawRoots[i];
      let covered = false;
      for (let j = 0; j < rawRoots.length; j++) {
        if (i !== j && rawRoots[j].nodeType === 1 && nodeContains(rawRoots[j], candidate)) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        asyncWorkStack.push({ node: candidate, parentMode: null });
      }
    }
  }

  function runAsyncSlice() {
    scheduledFlush = null;
    enqueueDeduplicatedRoots();

    if (asyncWorkStack.length === 0) {
      if (typeof flushCallback === 'function') flushCallback();
      return;
    }

    // Reset inherited parentMode on nodes carried over from a previous frame so
    // any node moved or detached between frames is freshly re-validated.
    for (let i = 0; i < asyncWorkStack.length; i++) {
      asyncWorkStack[i].parentMode = null;
    }

    const fallbackRoot = observedRoot || (doc && doc.body);
    const prevApplying = isApplying;
    isApplying = true;
    // Fresh transient WeakMap per frame slice — never persisted across frames or mutations
    const modeCache = new WeakMap();
    const startTime = getNow();
    let visited = 0;

    try {
      while (asyncWorkStack.length > 0) {
        const item = asyncWorkStack.pop();
        if (!item || !item.node) continue;
        // Re-check connectedness on top-level roots yielded across frames
        if (item.parentMode === null && !isNodeConnected(item.node, fallbackRoot)) {
          continue;
        }
        visitNode(item.node, item.parentMode, modeCache, asyncWorkStack);
        visited++;

        if (
          visited >= ASYNC_SLICE_NODE_BUDGET ||
          (visited % 32 === 0 && getNow() - startTime >= ASYNC_SLICE_TIME_BUDGET_MS)
        ) {
          break;
        }
      }
    } finally {
      if (!prevApplying) drainSelfMutations();
      isApplying = prevApplying;
    }

    if (asyncWorkStack.length > 0 || pendingRoots.size > 0) {
      scheduleFlush();
    } else if (typeof flushCallback === 'function') {
      flushCallback();
    }
  }

  function scheduleFlush() {
    if (scheduledFlush !== null) return;
    if (win && typeof win.requestAnimationFrame === 'function') {
      scheduledFlush = win.requestAnimationFrame(runAsyncSlice);
    } else {
      scheduledFlush = setTimeout(runAsyncSlice, 16);
    }
  }

  function startObserver(root = doc && doc.body, onMutationFlush = null) {
    if (!root) return null;
    observedRoot = root;
    flushCallback = onMutationFlush;
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
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'childList') {
          const addedNodes = m.addedNodes || [];
          for (let j = 0; j < addedNodes.length; j++) {
            const added = addedNodes[j];
            if (added.nodeType === 1 && elementMatchesSelf(added, '[data-ag-i18n-ui]')) {
              continue;
            }
            pendingRoots.add(added);
            dirty = true;
          }
        } else if (m.type === 'characterData') {
          const target = m.target;
          const parent = target && (target.parentElement || target.parentNode);
          if (parent && parent.nodeType === 1) {
            // Ignore our own translation writes so original English text is NEVER overwritten
            if (lastAppliedTextMap.has(target) && lastAppliedTextMap.get(target) === target.nodeValue) {
              continue;
            }
            // Text changed legitimately by app state: refresh original source and drop any stale merged snapshot
            originalTextMap.delete(target);
            mergedParentOriginals.delete(parent);
            if (!shouldSkipElement(parent)) {
              pendingRoots.add(target);
              dirty = true;
            }
          }
        } else if (m.type === 'attributes' && TRANSLATABLE_ATTRS.includes(m.attributeName)) {
          const el = m.target;
          if (el && el.nodeType === 1) {
            const val = el.getAttribute(m.attributeName);
            const appliedMap = lastAppliedAttrMap.get(el);
            if (appliedMap && appliedMap.get(m.attributeName) === val) {
              continue;
            }
            const cache = originalAttrMap.get(el);
            if (cache) {
              cache.delete(m.attributeName);
              if (cache.size === 0) originalAttrMap.delete(el);
            }
            if (typeof val === 'string') {
              pendingRoots.add(el);
              dirty = true;
            }
          }
        }
      }
      if (dirty) {
        scheduleFlush();
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
    if (scheduledFlush !== null) {
      if (win && typeof win.cancelAnimationFrame === 'function') {
        win.cancelAnimationFrame(scheduledFlush);
      } else {
        clearTimeout(scheduledFlush);
      }
      scheduledFlush = null;
    }
    pendingRoots.clear();
    asyncWorkStack.length = 0;
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
    const modeCache = new WeakMap();
    const stack = [{ node: root, parentMode: null }];
    const hasLatin = /[A-Za-z]{2,}/;
    const hasCjk = /[\u4e00-\u9fff]/;
    const ignoredBrands = new Set(['Antigravity', 'Google Antigravity', 'Gemini', 'Claude', 'GPT']);

    while (stack.length > 0) {
      const item = stack.pop();
      const node = item && item.node;
      if (!node) continue;

      if (node.nodeType === 3) {
        const parent = node.parentElement || node.parentNode;
        if (!parent || parent.nodeType !== 1) continue;
        const mode = item.parentMode !== null ? item.parentMode : resolveElementMode(parent, modeCache);
        if (mode !== MODE_TRANSLATE) continue;

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
        const translated = translateString(core, currentLocale, parent);
        if (translated === core && !Object.prototype.hasOwnProperty.call(found, core)) {
          found[core] = '';
        }
        continue;
      }

      if (node.nodeType === 1) {
        const elMode =
          item.parentMode !== null
            ? classifyElementFromParent(node, item.parentMode)
            : resolveElementMode(node, modeCache);
        modeCache.set(node, elMode);
        if (elMode === MODE_HARD_SKIP || elMode === MODE_PROTECTED_STRICT) continue;
        if (node.shadowRoot) stack.push({ node: node.shadowRoot, parentMode: elMode });
        const children = node.childNodes;
        if (children && children.length) {
          for (let i = children.length - 1; i >= 0; i--) {
            stack.push({ node: children[i], parentMode: elMode });
          }
        }
        continue;
      }

      const children = node.childNodes;
      if (children && children.length) {
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ node: children[i], parentMode: item.parentMode });
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
