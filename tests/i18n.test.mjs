import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTranslator, shouldSkipElement } from '../engine/translator.js';
import { mountLanguageUI } from '../engine/language-ui.js';
import {
  buildMainMenuHookSnippet,
  buildRendererPreloadSnippet,
  findAsarPatchTargets,
  injectIntoSource,
  MARKER_END,
  MARKER_START,
  resolveBackupAction,
  stripInjectedBlocks,
} from '../patcher/patch.mjs';
import {
  buildAsarFromMap,
  getAsarEntry,
  readAsarFileBuffer,
  readAsarHeader,
  rewriteAsarArchive,
} from '../patcher/asar-codec.mjs';
import { buildBundle, loadAndValidateLocales, ROOT_DIR } from '../scripts/build-bundle.mjs';

/**
 * Minimal Mock DOM for unit-testing DOM isolation, round-trip switching, and Settings UI injection
 * with zero external dependencies.
 */
class MockNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] || null : null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
}

class MockText extends MockNode {
  constructor(text) {
    super(3);
    this.nodeValue = String(text);
  }
  get textContent() {
    return this.nodeValue;
  }
  set textContent(v) {
    this.nodeValue = String(v);
  }
}

class MockElement extends MockNode {
  constructor(tagName) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.listeners = new Map();
    this.className = '';
    this.id = '';
    this.value = '';
    this.type = '';
    this.checked = false;
    this.selected = false;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) {
    if (k === 'class' && this.className) return this.className;
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      list.filter((item) => item !== fn),
    );
  }
  dispatchEvent(ev) {
    const list = this.listeners.get(ev.type) || [];
    for (const fn of list) fn(ev);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(val) {
    this.childNodes = [];
    if (val !== '' && val !== null && val !== undefined) {
      this.appendChild(new MockText(String(val)));
    }
  }
  set innerHTML(val) {
    if (val === '') this.childNodes = [];
  }
  matchesSimple(sel) {
    const s = sel.trim();
    if (s.startsWith('.')) {
      return this.className.split(/\s+/).includes(s.slice(1));
    }
    const attrEq = s.match(/^\[([^=\]]+)="([^"]*)"\]$/);
    if (attrEq) {
      return this.getAttribute(attrEq[1]) === attrEq[2];
    }
    const attrHas = s.match(/^\[([^=\]]+)\]$/);
    if (attrHas) {
      return this.getAttribute(attrHas[1]) !== null;
    }
    if (s.includes('.')) {
      const [tagPart, clsPart] = s.split('.');
      return this.tagName === tagPart.toUpperCase() && this.className.split(/\s+/).includes(clsPart);
    }
    return this.tagName === s.toUpperCase();
  }
  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (cur.matchesSimple(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelectorAll(selectorList) {
    const parts = selectorList.split(',').map((s) => s.trim());
    const results = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (parts.some((p) => !p.includes('>') && child.matchesSimple(p))) {
            results.push(child);
          }
          walk(child);
        }
      }
    };
    walk(this);
    return results;
  }
  querySelector(selectorList) {
    return this.querySelectorAll(selectorList)[0] || null;
  }
}

function createMockEnv() {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const head = new MockElement('head');
  const body = new MockElement('body');
  const documentElement = new MockElement('html');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const doc = {
    documentElement,
    head,
    body,
    createElement: (tag) => new MockElement(tag),
    createTextNode: (txt) => new MockText(txt),
    getElementById: (id) => {
      const all = [head, body];
      while (all.length) {
        const cur = all.pop();
        if (cur.id === id) return cur;
        for (const c of cur.childNodes) if (c.nodeType === 1) all.push(c);
      }
      return null;
    },
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
  };

  const winListeners = new Map();
  const win = {
    localStorage: storage,
    addEventListener: (t, fn) => {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push(fn);
    },
    removeEventListener: (t, fn) => {
      const list = winListeners.get(t) || [];
      winListeners.set(
        t,
        list.filter((x) => x !== fn),
      );
    },
  };
  return { win, doc, storage };
}

test('locales manifest and zh-CN dictionaries validate and compile to valid JS bundle', () => {
  const { bundle, menuLocales } = loadAndValidateLocales(ROOT_DIR);
  assert.ok(bundle.locales.some((l) => l.code === 'en'));
  assert.ok(bundle.locales.some((l) => l.code === 'zh-CN'));
  assert.equal(menuLocales['zh-CN'].File, '文件');

  const built = buildBundle(ROOT_DIR);
  assert.ok(fs.existsSync(built.runtimeOut));
  assert.ok(fs.existsSync(built.menuOut));

  const runtimeCode = fs.readFileSync(built.runtimeOut, 'utf8');
  // Validate compiled bundle has zero syntax errors
  assert.doesNotThrow(() => new Function(runtimeCode));
});

test('translator translates UI strings and regex patterns while strictly protecting code/terminal/paths', () => {
  const { bundle } = loadAndValidateLocales(ROOT_DIR);
  const { win, doc, storage } = createMockEnv();

  const btn = doc.createElement('button');
  btn.textContent = 'New Conversation';

  const statusSpan = doc.createElement('span');
  statusSpan.textContent = '3 files changed';

  const searchInput = doc.createElement('input');
  searchInput.setAttribute('placeholder', 'Search...');

  const codeEl = doc.createElement('code');
  codeEl.textContent = 'Settings';

  const monaco = doc.createElement('div');
  monaco.className = 'monaco-editor';
  const monacoSpan = doc.createElement('span');
  monacoSpan.textContent = 'Settings';
  monaco.appendChild(monacoSpan);

  const terminal = doc.createElement('div');
  terminal.className = 'xterm';
  const termSpan = doc.createElement('span');
  termSpan.textContent = 'Running';
  terminal.appendChild(termSpan);

  const pathSpan = doc.createElement('span');
  pathSpan.textContent = 'C:\\Users\\demo\\Settings';

  for (const el of [btn, statusSpan, searchInput, codeEl, monaco, terminal, pathSpan]) {
    doc.body.appendChild(el);
  }

  const translator = createTranslator(bundle, { window: win, document: doc, storage });
  translator.translateTree(doc.body);

  assert.equal(btn.textContent, '新建对话');
  assert.equal(statusSpan.textContent, '3 个文件已变更');
  assert.equal(searchInput.getAttribute('placeholder'), '搜索...');

  // Strictly isolated nodes remain untouched
  assert.equal(shouldSkipElement(codeEl), true);
  assert.equal(codeEl.textContent, 'Settings');
  assert.equal(monacoSpan.textContent, 'Settings');
  assert.equal(termSpan.textContent, 'Running');
  assert.equal(pathSpan.textContent, 'C:\\Users\\demo\\Settings');

  // Switch back to English restores original text & attributes cleanly
  translator.setLocale('en');
  assert.equal(btn.textContent, 'New Conversation');
  assert.equal(statusSpan.textContent, '3 files changed');
  assert.equal(searchInput.getAttribute('placeholder'), 'Search...');
  assert.equal(doc.documentElement.lang, 'en');

  // Register a future language pack dynamically (e.g., Japanese) and switch seamlessly
  translator.registerLocale({
    code: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    exact: {
      'New Conversation': '新しい会話',
      'Search...': '検索...',
    },
  });
  translator.setLocale('ja');
  assert.equal(btn.textContent, '新しい会話');
  assert.equal(searchInput.getAttribute('placeholder'), '検索...');
  assert.equal(storage.getItem('antigravity_i18n_locale'), 'ja');
});

test('mountLanguageUI injects Language selector into Settings panel and switches locales interactively', () => {
  const { bundle } = loadAndValidateLocales(ROOT_DIR);
  const { win, doc, storage } = createMockEnv();

  // Simulate Antigravity's real Settings modal layout: left <nav> + right <div> content pane
  const nav = doc.createElement('nav');
  const navBtn = doc.createElement('button');
  navBtn.textContent = 'General';
  nav.appendChild(navBtn);

  const settingsPane = doc.createElement('div');
  const titleDiv = doc.createElement('div');
  titleDiv.textContent = 'General';
  const descDiv = doc.createElement('div');
  descDiv.textContent = 'Configure agent execution, queued message delivery, and permissions.';
  const layoutHeading = doc.createElement('div');
  layoutHeading.textContent = 'Interface Layout';
  const modeCard = doc.createElement('div');
  modeCard.textContent = 'Software Engineering';

  settingsPane.appendChild(titleDiv);
  settingsPane.appendChild(descDiv);
  settingsPane.appendChild(layoutHeading);
  settingsPane.appendChild(modeCard);

  const timeSpan = doc.createElement('span');
  timeSpan.textContent = '2m ago';
  const menuSpan = doc.createElement('span');
  menuSpan.textContent = 'Workspace';
  const quotaSpan = doc.createElement('span');
  quotaSpan.textContent =
    'You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours.';
  const planSpan = doc.createElement('span');
  planSpan.textContent = 'Your plan: Google AI Pro';

  doc.body.appendChild(nav);
  doc.body.appendChild(settingsPane);
  doc.body.appendChild(timeSpan);
  doc.body.appendChild(menuSpan);
  doc.body.appendChild(quotaSpan);
  doc.body.appendChild(planSpan);

  const translator = createTranslator(bundle, { window: win, document: doc, storage });
  translator.translateTree(doc.body);
  const ui = mountLanguageUI(translator, { window: win, document: doc, storage });

  assert.equal(titleDiv.textContent, '通用');
  assert.equal(descDiv.textContent, '配置 Agent 执行方式、排队消息发送策略与权限规则。');
  assert.equal(layoutHeading.textContent, '界面布局');
  assert.equal(modeCard.textContent, '软件工程模式');
  assert.equal(timeSpan.textContent, '2 分钟前');
  assert.equal(menuSpan.textContent, '工作区');
  assert.equal(quotaSpan.textContent, '已使用部分每周额度，将在 6 天 22 小时后完全重置。');
  assert.equal(planSpan.textContent, '当前方案：Google AI Pro');

  const section = doc.querySelector('[data-ag-i18n-ui="settings-section"]');
  assert.ok(section, 'Language settings section should be injected into Settings content pane');
  assert.equal(section.parentNode, settingsPane, 'Should inject inside right content pane, not left nav');

  const triggerLabel = section.querySelector('.ag-i18n-trigger-label');
  assert.ok(triggerLabel);
  assert.equal(triggerLabel.textContent, '简体中文 (zh-CN)');

  // Verify collectUntranslated detects untranslated English labels while ignoring Chinese/code
  const mystery = doc.createElement('span');
  mystery.textContent = 'Brand New Feature';
  doc.body.appendChild(mystery);
  const missing = translator.collectUntranslated(doc.body);
  assert.equal(missing['Brand New Feature'], '');
  assert.equal(Object.prototype.hasOwnProperty.call(missing, 'Workspace'), false);

  // Simulate user opening dropdown and verify redundant injectIntoSettings() does NOT destroy option nodes
  const enOptionBefore = section.querySelector('[data-locale="en"]');
  assert.ok(enOptionBefore, 'English option should exist in custom dropdown menu');
  ui.injectIntoSettings();
  const enOption = section.querySelector('[data-locale="en"]');
  assert.strictEqual(enOption, enOptionBefore, 'Dropdown options must not be recreated when unchanged');
  enOption.dispatchEvent({ type: 'click', target: enOption });

  assert.equal(translator.getLocale(), 'en');
  assert.equal(layoutHeading.textContent, 'Interface Layout');
  assert.equal(menuSpan.textContent, 'Workspace');

  // Verify custom toggle switch updates floating button preference
  const switchBtn = section.querySelector('.ag-i18n-switch');
  assert.ok(switchBtn);
  assert.equal(switchBtn.getAttribute('data-checked'), 'true');
  switchBtn.dispatchEvent({ type: 'click', target: switchBtn });
  assert.equal(switchBtn.getAttribute('data-checked'), 'false');

  // Verify React-split adjacent text nodes merge cleanly (e.g. ["No", " automations yet"])
  // and ambiguous short words ("No") never produce broken hybrid strings like "否 unknown items"
  const splitDiv = doc.createElement('div');
  splitDiv.appendChild(doc.createTextNode('No'));
  splitDiv.appendChild(doc.createTextNode(' automations yet'));
  doc.body.appendChild(splitDiv);

  const hybridDiv = doc.createElement('div');
  hybridDiv.appendChild(doc.createTextNode('No'));
  hybridDiv.appendChild(doc.createTextNode(' unknown widgets yet'));
  doc.body.appendChild(hybridDiv);

  translator.setLocale('zh-CN');
  assert.equal(splitDiv.textContent, '暂无自动化任务');
  assert.equal(hybridDiv.textContent, 'No unknown widgets yet');

  translator.setLocale('en');
  assert.equal(splitDiv.textContent, 'No automations yet');
  assert.equal(hybridDiv.textContent, 'No unknown widgets yet');

  // Re-calling injectIntoSettings is idempotent (no duplicate settings sections)
  ui.injectIntoSettings();
  assert.equal(doc.querySelectorAll('[data-ag-i18n-ui="settings-section"]').length, 1);
  ui.destroy();
});

test('async MutationObserver self-writes never overwrite original English text on zh-CN -> en switch', async () => {
  const { bundle } = loadAndValidateLocales(ROOT_DIR);
  const { win, doc, storage } = createMockEnv();

  const heading = doc.createElement('div');
  heading.textContent = 'General';
  const input = doc.createElement('input');
  input.setAttribute('placeholder', 'Ask anything, @ to mention, / for actions');
  doc.body.appendChild(heading);
  doc.body.appendChild(input);

  // Mock real browser MutationObserver that delivers records asynchronously on microtask
  let activeCallback = null;
  let queued = [];
  class AsyncMockMutationObserver {
    constructor(cb) {
      activeCallback = cb;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      const out = queued;
      queued = [];
      return out;
    }
  }

  const translator = createTranslator(bundle, {
    window: win,
    document: doc,
    storage,
    MutationObserver: AsyncMockMutationObserver,
  });

  translator.startObserver(doc.body);
  assert.equal(heading.textContent, '通用');
  assert.equal(input.getAttribute('placeholder'), '随便问点什么，输入 @ 引用上下文，输入 / 调用操作');

  // Even if an async observer delivers characterData/attributes records AFTER isApplying resets,
  // our lastAppliedTextMap / lastAppliedAttrMap guard must NOT overwrite the original English strings!
  activeCallback([
    { type: 'characterData', target: heading.childNodes[0] },
    { type: 'attributes', target: input, attributeName: 'placeholder' },
  ]);

  translator.setLocale('en');
  assert.equal(heading.textContent, 'General');
  assert.equal(input.getAttribute('placeholder'), 'Ask anything, @ to mention, / for actions');

  translator.setLocale('zh-CN');
  assert.equal(heading.textContent, '通用');
  assert.equal(input.getAttribute('placeholder'), '随便问点什么，输入 @ 引用上下文，输入 / 调用操作');
  translator.stopObserver();
});

test('static ASAR codec preserves unpacked entries and applies idempotent patches', () => {
  const original = "const x = 1;\nmodule.exports = x;\n";
  const snippet = buildRendererPreloadSnippet("console.log('i18n');");

  const once = injectIntoSource(original, snippet);
  assert.ok(once.includes(MARKER_START));
  assert.ok(once.includes(MARKER_END));

  const twice = injectIntoSource(once, snippet);
  assert.equal(twice.split(MARKER_START).length - 1, 1, 'Should not duplicate injected marker block');

  const stripped = stripInjectedBlocks(twice).trim();
  assert.equal(stripped, original.trim());

  const mainHook = buildMainMenuHookSnippet({ 'zh-CN': { File: '文件' } }, 'zh-CN');
  assert.ok(mainHook.includes('Menu.buildFromTemplate'));

  // Build a mock ASAR with packed files + an unpacked file (no .unpacked folder on disk!)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-i18n-asar-'));
  try {
    const srcAsar = path.join(tmp, 'app.asar.zh-cn.bak');
    const dstAsar = path.join(tmp, 'app.asar');
    buildAsarFromMap(srcAsar, {
      'package.json': JSON.stringify({ version: '2.35.1', main: 'dist/main.js' }),
      'dist/main.js': '// main entry\n',
      'dist/preload.js': '// preload entry\n',
      'dist/browserStream/capturePreload.js': '// browser capture preload\n',
      'dist/scriptJailPreload.js': '// script jail preload\n',
      'node_modules/native-pkg/addon.node': { unpacked: true, size: 4096 },
    });

    const targets = findAsarPatchTargets(srcAsar);
    assert.equal(targets.appVersion, '2.35.1');
    assert.equal(targets.isPatched, false);
    assert.equal(targets.mainEntry, 'dist/main.js');
    assert.deepEqual(targets.preloadFiles, ['dist/preload.js']);

    const replacements = new Map();
    replacements.set('dist/preload.js', injectIntoSource('// preload entry\n', snippet));
    replacements.set('dist/main.js', injectIntoSource('// main entry\n', mainHook));

    rewriteAsarArchive(srcAsar, dstAsar, replacements);

    // Same-version re-patch should reuse the clean 2.35.1 backup
    const sameVerPlan = resolveBackupAction(dstAsar, srcAsar);
    assert.equal(sameVerPlan.action, 'reuse-backup');
    assert.equal(sameVerPlan.current.isPatched, true);

    // Simulate official auto-update overwriting app.asar with a clean 2.36.0 build:
    // resolveBackupAction MUST refresh the backup instead of downgrading to 2.35.1!
    const upgradedAsar = path.join(tmp, 'app-upgraded.asar');
    buildAsarFromMap(upgradedAsar, {
      'package.json': JSON.stringify({ version: '2.36.0', main: 'dist/main.js' }),
      'dist/main.js': '// main 2.36.0\n',
      'dist/preload.js': '// preload 2.36.0\n',
    });
    const upgradePlan = resolveBackupAction(upgradedAsar, srcAsar);
    assert.equal(upgradePlan.action, 'refresh-backup');
    assert.equal(upgradePlan.upgradedFrom, '2.35.1');
    assert.equal(upgradePlan.current.appVersion, '2.36.0');

    const reparsed = readAsarHeader(dstAsar);
    // Unpacked entry preserved verbatim without needing *.bak.unpacked on disk
    const unpackedEntry = getAsarEntry(reparsed.header, 'node_modules/native-pkg/addon.node');
    assert.equal(unpackedEntry.unpacked, true);
    assert.equal(unpackedEntry.size, 4096);

    // Untouched file preserved verbatim
    const pkgText = readAsarFileBuffer(dstAsar, 'package.json', reparsed).toString('utf8');
    assert.equal(JSON.parse(pkgText).main, 'dist/main.js');

    // Patched preload & main contain injected markers
    const patchedPreload = readAsarFileBuffer(dstAsar, 'dist/preload.js', reparsed).toString('utf8');
    const patchedMain = readAsarFileBuffer(dstAsar, 'dist/main.js', reparsed).toString('utf8');
    assert.ok(patchedPreload.includes(MARKER_START));
    assert.ok(patchedMain.includes('Menu.buildFromTemplate'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
