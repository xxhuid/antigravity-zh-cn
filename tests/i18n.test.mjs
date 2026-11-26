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
  detectAsarPath,
  findAsarPatchTargets,
  injectIntoSource,
  MARKER_END,
  MARKER_START,
  resolveBackupAction,
  stripInjectedBlocks,
} from '../patcher/patch.mjs';
import { isInjectableCdpTarget } from '../launcher/launch.mjs';
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

  // Verify contextual "New": standalone button -> "新建", inline model badge -> "新"
  const createBtn = doc.createElement('button');
  createBtn.textContent = 'New';
  const modelRow = doc.createElement('button');
  const modelName = doc.createElement('span');
  modelName.textContent = 'Gemini 4 Neon';
  const newBadge = doc.createElement('span');
  newBadge.textContent = 'New';
  modelRow.appendChild(modelName);
  modelRow.appendChild(newBadge);
  doc.body.appendChild(createBtn);
  doc.body.appendChild(modelRow);

  translator.translateTree(doc.body);
  assert.equal(createBtn.textContent, '新建');
  assert.equal(newBadge.textContent, '新');

  translator.setLocale('en');
  assert.equal(splitDiv.textContent, 'No automations yet');
  assert.equal(hybridDiv.textContent, 'No unknown widgets yet');
  assert.equal(createBtn.textContent, 'New');
  assert.equal(newBadge.textContent, 'New');

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

test('user content & customization boundaries protect user text while allowing mixed-row action buttons and restoring reparented nodes', () => {
  const { bundle } = loadAndValidateLocales(ROOT_DIR);
  const { win, doc, storage } = createMockEnv();

  // 1. Strict protected: Markdown / AI response body (even nested buttons stay untouched)
  const markdownRoot = doc.createElement('div');
  markdownRoot.setAttribute('data-markdown-root', 'true');
  const mdPara = doc.createElement('p');
  mdPara.textContent = 'Settings';
  const mdBtn = doc.createElement('button');
  mdBtn.textContent = 'Settings';
  markdownRoot.appendChild(mdPara);
  markdownRoot.appendChild(mdBtn);

  // 2. Mixed protected: file tree item (file name & data-uri button stay protected; Delete button translates)
  const treeItem = doc.createElement('div');
  treeItem.setAttribute('role', 'treeitem');
  const fileLabel = doc.createElement('span');
  fileLabel.textContent = 'Settings';
  const fileUriBtn = doc.createElement('button');
  fileUriBtn.setAttribute('data-uri', 'file:///workspace/Settings');
  fileUriBtn.textContent = 'Settings';
  const treeDeleteBtn = doc.createElement('button');
  treeDeleteBtn.setAttribute('aria-label', 'Delete');
  treeDeleteBtn.textContent = 'Delete';
  treeItem.appendChild(fileLabel);
  treeItem.appendChild(fileUriBtn);
  treeItem.appendChild(treeDeleteBtn);

  // 3. Mixed protected: sidebar conversation row (title link stays protected; action button translates)
  const convoRow = doc.createElement('div');
  convoRow.setAttribute('data-testid', 'conversation-row-sidebar');
  const convoLink = doc.createElement('a');
  convoLink.textContent = 'New Conversation';
  const convoAction = doc.createElement('button');
  convoAction.setAttribute('title', 'Delete');
  convoAction.textContent = 'Delete';
  convoRow.appendChild(convoLink);
  convoRow.appendChild(convoAction);

  // 4. Customization author name / description stays untouched
  const customName = doc.createElement('div');
  customName.setAttribute('data-testid', 'customization-name');
  customName.textContent = 'Automations';

  // 5. Normal UI node that will later be reparented into protected Markdown
  const movableSpan = doc.createElement('span');
  movableSpan.textContent = 'Settings';

  for (const el of [markdownRoot, treeItem, convoRow, customName, movableSpan]) {
    doc.body.appendChild(el);
  }

  const translator = createTranslator(bundle, { window: win, document: doc, storage });
  translator.translateTree(doc.body);

  assert.equal(mdPara.textContent, 'Settings');
  assert.equal(mdBtn.textContent, 'Settings');
  assert.equal(fileLabel.textContent, 'Settings');
  assert.equal(fileUriBtn.textContent, 'Settings');
  assert.equal(treeDeleteBtn.textContent, '删除');
  assert.equal(treeDeleteBtn.getAttribute('aria-label'), '删除');
  assert.equal(convoLink.textContent, 'New Conversation');
  assert.equal(convoAction.textContent, '删除');
  assert.equal(convoAction.getAttribute('title'), '删除');
  assert.equal(customName.textContent, 'Automations');
  assert.equal(movableSpan.textContent, '设置');

  // Reparent translated node into protected Markdown -> must restore original English text
  markdownRoot.appendChild(movableSpan);
  translator.translateTree(markdownRoot);
  assert.equal(movableSpan.textContent, 'Settings');
});

test('frame-budgeted async mutation flush translates 650 added sibling nodes across multiple frames without dropping tail nodes', () => {
  const { bundle } = loadAndValidateLocales(ROOT_DIR);
  const { win, doc, storage } = createMockEnv();

  const rafQueue = [];
  win.requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  win.cancelAnimationFrame = () => {};

  let observerCb = null;
  class ControlledMutationObserver {
    constructor(cb) {
      observerCb = cb;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  const translator = createTranslator(bundle, {
    window: win,
    document: doc,
    storage,
    MutationObserver: ControlledMutationObserver,
  });
  translator.startObserver(doc.body);

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const nodes = [];
  for (let i = 0; i < 650; i++) {
    const span = doc.createElement('span');
    span.textContent = 'Settings';
    container.appendChild(span);
    nodes.push(span);
  }

  observerCb([{ type: 'childList', addedNodes: [container] }]);

  // Run first frame slice only, then move an unvisited tail node into a protected Markdown container
  // before resuming subsequent frames to verify cross-frame boundary re-evaluation!
  assert.ok(rafQueue.length > 0);
  let frameCount = 1;
  rafQueue.shift()();

  const mdShield = doc.createElement('div');
  mdShield.setAttribute('data-markdown-root', 'true');
  doc.body.appendChild(mdShield);
  const movedTailNode = nodes[640];
  mdShield.appendChild(movedTailNode);

  while (rafQueue.length > 0 && frameCount < 20) {
    const cb = rafQueue.shift();
    frameCount++;
    cb();
  }

  assert.ok(frameCount >= 3, `Expected 650 nodes to be time-sliced across >=3 frames, got ${frameCount}`);
  assert.equal(nodes[0].textContent, '设置');
  assert.equal(nodes[500].textContent, '设置');
  assert.equal(movedTailNode.textContent, 'Settings', 'Node moved into protected zone between frames must NOT be translated');
  assert.equal(nodes[649].textContent, '设置');
  translator.stopObserver();
});

test('scoped dictionaries, punctuation stripping, and hotkey suffix preservation work without global pollution', () => {
  const { win, doc, storage } = createMockEnv();
  const customBundle = {
    defaultLocale: 'zh-CN',
    locales: [
      { code: 'en', builtin: true, exact: {}, patterns: [], scoped: [] },
      {
        code: 'zh-CN',
        name: 'Simplified Chinese',
        nativeName: '简体中文',
        exact: {
          Settings: '设置',
          'Command Palette': '命令面板',
        },
        patterns: [],
        scoped: [
          {
            selector: '[data-testid="swarm-panel"]',
            exact: {
              Live: '实时',
            },
          },
        ],
      },
    ],
  };

  const globalLive = doc.createElement('span');
  globalLive.textContent = 'Live';
  const swarmPanel = doc.createElement('div');
  swarmPanel.setAttribute('data-testid', 'swarm-panel');
  const swarmLive = doc.createElement('span');
  swarmLive.textContent = 'Live';
  swarmPanel.appendChild(swarmLive);

  const puncEl = doc.createElement('span');
  puncEl.textContent = 'Settings:';
  const hotkeyEl = doc.createElement('span');
  hotkeyEl.textContent = 'Command Palette (Ctrl+Shift+P)';

  for (const el of [globalLive, swarmPanel, puncEl, hotkeyEl]) {
    doc.body.appendChild(el);
  }

  const translator = createTranslator(customBundle, { window: win, document: doc, storage });
  translator.translateTree(doc.body);

  assert.equal(globalLive.textContent, 'Live', 'Scoped word must NOT pollute outside its scope');
  assert.equal(swarmLive.textContent, '实时', 'Scoped word must translate inside matching container');
  assert.equal(puncEl.textContent, '设置：');
  assert.equal(hotkeyEl.textContent, '命令面板 (Ctrl+Shift+P)');

  // Verify real zh-CN sidebar context menu, tooltip hotkeys, and Updated/Worked/Thought patterns
  const { bundle: realBundle } = loadAndValidateLocales(ROOT_DIR);
  const realTranslator = createTranslator(realBundle, { window: win, document: doc, storage });
  assert.equal(realTranslator.translateString('Archive Conversation Ctrl+Alt+A'), '归档对话 Ctrl+Alt+A');
  assert.equal(realTranslator.translateString('Pin Alt+Shift+P'), '置顶 Alt+Shift+P');
  assert.equal(realTranslator.translateString('Pin ⌥⇧P'), '置顶 ⌥⇧P');
  assert.equal(realTranslator.translateString('Mark Unread'), '标为未读');
  assert.equal(realTranslator.translateString('Split'), '分屏');
  assert.equal(realTranslator.translateString('Archive'), '归档');
  assert.equal(realTranslator.translateString('Updated 1:46'), '更新于 1:46');
  assert.equal(realTranslator.translateString('Worked for 1m'), '已工作 1 分钟');
  assert.equal(realTranslator.translateString('Thought for 12s'), '已思考 12 秒');
  assert.equal(realTranslator.translateString('Connected'), '已连接');
  assert.equal(realTranslator.translateString('Local Windows environment'), '本地 Windows 环境');
  assert.equal(
    realTranslator.translateString(
      'The app is currently connected to a WSL distro. Reopening locally relaunches it directly on Windows.',
    ),
    '应用当前已连接到 WSL 发行版。在本地重新打开将直接在 Windows 上重启应用。',
  );
  assert.equal(realTranslator.translateString('Reopen Locally'), '在本地重新打开');
  assert.equal(realTranslator.translateString('Feedback Type'), '反馈类型');
  assert.equal(realTranslator.translateString('Bug Report'), 'Bug 报告');
  assert.equal(realTranslator.translateString('Feature Request'), '功能建议');
  assert.equal(realTranslator.translateString('Auth and Billing'), '账号与账单');
  assert.equal(realTranslator.translateString('Remote Control Issue'), '远程控制问题');
  assert.equal(realTranslator.translateString('General Feedback'), '常规反馈');
  assert.equal(realTranslator.translateString('Description'), '详细描述');
  assert.equal(
    realTranslator.translateString(
      'Please describe the issue in detail. The more actionable your feedback, the quicker our team can address your request. Some helpful information includes:',
    ),
    '请详细描述遇到的问题。你的反馈越具体，我们团队就越快定位并处理。可包含以下信息：',
  );
  assert.equal(realTranslator.translateString('Steps to reproduce the issue'), '复现问题的步骤');
  assert.equal(realTranslator.translateString('Expected behavior'), '预期表现');
  assert.equal(realTranslator.translateString('Actual behavior'), '实际表现');
  assert.equal(realTranslator.translateString('Any error messages'), '相关报错信息');
  assert.equal(realTranslator.translateString('Any relevant information'), '其他相关信息');
  assert.equal(realTranslator.translateString('Describe the bug you encountered...'), '请描述你遇到的 Bug...');
  assert.equal(realTranslator.translateString('Steps to Reproduce'), '复现步骤');
  assert.equal(realTranslator.translateString('Please list the steps to reproduce the issue'), '请列出复现该问题的步骤');
  assert.equal(realTranslator.translateString('Attach a screenshot (optional)'), '附加截图（可选）');
  assert.equal(realTranslator.translateString('Attach Antigravity server logs'), '附加 Antigravity 服务端日志');
  assert.equal(realTranslator.translateString('Send feedback as xxhuid@gmail.com'), '使用 xxhuid@gmail.com 提交反馈');
  assert.equal(realTranslator.translateString('Visit '), '访问 ');
  assert.equal(realTranslator.translateString('Legal Help'), '法律帮助');
  assert.equal(
    realTranslator.translateString(' to ask for content changes for legal reasons.'),
    ' 以因法律原因申请更改内容。',
  );

  translator.setLocale('en');
  assert.equal(swarmLive.textContent, 'Live');
  assert.equal(puncEl.textContent, 'Settings:');
  assert.equal(hotkeyEl.textContent, 'Command Palette (Ctrl+Shift+P)');
});

test('Linux portable ASAR detection requires a real file and CDP target filter blocks external/DevTools pages', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-i18n-linux-'));
  try {
    // Create a decoy directory named app.asar under ~/Applications/Portable/Antigravity/resources/app.asar
    const decoyDir = path.join(tmp, 'Applications', 'Portable', 'Antigravity', 'resources', 'app.asar');
    fs.mkdirSync(decoyDir, { recursive: true });

    // Create a real file under ~/Applications/Portable/Antigravity-x64/resources/app.asar
    const realFile = path.join(tmp, 'Applications', 'Portable', 'Antigravity-x64', 'resources', 'app.asar');
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, 'mock-asar');

    const detected = detectAsarPath('linux', { homeDir: tmp, rootDir: path.join(tmp, 'repo'), arch: 'x64' });
    assert.equal(detected, realFile);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Verify CDP target filter
  assert.equal(
    isInjectableCdpTarget({ type: 'page', url: 'file:///app/index.html', webSocketDebuggerUrl: 'ws://1' }),
    true,
  );
  assert.equal(
    isInjectableCdpTarget({ type: 'page', url: 'http://127.0.0.1:41234/', webSocketDebuggerUrl: 'ws://1' }),
    true,
  );
  assert.equal(
    isInjectableCdpTarget({ type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://1' }),
    false,
  );
  assert.equal(
    isInjectableCdpTarget({ type: 'webview', url: 'https://github.com/login', webSocketDebuggerUrl: 'ws://1' }),
    false,
  );
});

test('mountLanguageUI NEVER injects Language card into chat messages, Markdown, or inline <code> containing anchor text', () => {
  const { bundle } = loadAndValidateLocales(ROOT_DIR);
  const { win, doc, storage } = createMockEnv();

  // Case 1: Inline <code>Interface Layout</code> inside a chat Markdown list item (exact live bug)
  const mdRoot = doc.createElement('div');
  mdRoot.setAttribute('data-markdown-root', 'true');
  const ul = doc.createElement('ul');
  const li = doc.createElement('li');
  const code = doc.createElement('code');
  code.textContent = 'Interface Layout';
  li.appendChild(code);
  ul.appendChild(li);

  // Case 2: Exact primary subtitle quoted inside AI response text
  const aiResp = doc.createElement('div');
  aiResp.setAttribute('data-testid', 'planner-response-text');
  const quotedSubtitle = doc.createElement('div');
  quotedSubtitle.textContent =
    'Configure agent execution, queued message delivery, and permissions.';
  aiResp.appendChild(quotedSubtitle);

  // Case 3: Stray <div>Interface Layout</div> outside any Settings context
  const strayDiv = doc.createElement('div');
  strayDiv.textContent = 'Interface Layout';

  mdRoot.appendChild(ul);
  doc.body.appendChild(mdRoot);
  doc.body.appendChild(aiResp);
  doc.body.appendChild(strayDiv);

  const translator = createTranslator(bundle, { window: win, document: doc, storage });
  translator.translateTree(doc.body);
  const ui = mountLanguageUI(translator, { window: win, document: doc, storage });

  assert.equal(
    doc.querySelector('[data-ag-i18n-ui="settings-section"]'),
    null,
    'Language settings card must NOT be injected into chat/Markdown/code or non-Settings containers',
  );

  // Now open a genuine Settings -> General pane (fallback-only, without subtitle) -> MUST inject there
  const settingsPane = doc.createElement('div');
  const generalTitle = doc.createElement('div');
  generalTitle.textContent = 'General';
  const layoutHeading = doc.createElement('div');
  layoutHeading.textContent = 'Interface Layout';
  settingsPane.appendChild(generalTitle);
  settingsPane.appendChild(layoutHeading);
  doc.body.appendChild(settingsPane);

  translator.translateTree(settingsPane);
  ui.injectIntoSettings();

  const injected = doc.querySelector('[data-ag-i18n-ui="settings-section"]');
  assert.ok(injected, 'Language settings card should still inject into a real Settings -> General pane');
  assert.equal(injected.parentNode, settingsPane);
  ui.destroy();
});
