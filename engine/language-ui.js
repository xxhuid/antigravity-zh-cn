/**
 * Antigravity In-App Language Settings UI
 * 1. Injects a native-looking "界面语言 / Language" card right below the page subtitle in Settings (General / Appearance / Application)
 * 2. Provides Ctrl+Alt+L (Cmd+Option+L) modal (avoiding Antigravity's native Ctrl+Shift+L shortcut) + optional floating badge
 * 3. Includes a 1-click "Copy untranslated UI strings (JSON)" helper for community dictionary contributions
 */

const STORAGE_KEY_FLOATING = 'antigravity_i18n_floating_btn';
const STORAGE_KEY_DEBUG = 'antigravity_i18n_debug';
const STYLE_ID = 'ag-i18n-styles';

// Unique Settings -> General page subtitle (mounts Language settings in one clean place)
const SETTINGS_SUBTITLE_ANCHORS = new Set([
  'Configure agent execution, queued message delivery, and permissions.',
  '配置 Agent 执行方式、排队消息发送策略与权限规则。',
]);

// Fallback section headings inside General if Antigravity updates its subtitle in a future release
const SETTINGS_FALLBACK_ANCHORS = new Set([
  'Interface Layout',
  '界面布局',
]);

const UI_CSS = `
[data-ag-i18n-ui="settings-section"] {
  margin: 16px 0 20px 0;
  font-family: inherit;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-section-heading {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 8px 2px;
  opacity: 0.9;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-card {
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  background: rgba(128, 128, 128, 0.03);
  overflow: visible;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 16px;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-row + .ag-i18n-row {
  border-top: 1px solid rgba(128, 128, 128, 0.14);
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-title,
[data-ag-i18n-ui="settings-section"] .ag-i18n-float-title {
  font-size: 13.5px;
  font-weight: 500;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-desc {
  font-size: 12px;
  opacity: 0.65;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-dropdown {
  position: relative;
  flex-shrink: 0;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 158px;
  height: 32px;
  padding: 0 12px 0 14px;
  border-radius: 999px;
  border: 1px solid rgba(128, 128, 128, 0.16);
  background: rgba(128, 128, 128, 0.1);
  color: inherit;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease, border-color 0.15s ease;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-trigger:hover,
[data-ag-i18n-ui="settings-section"] .ag-i18n-dropdown[data-open="true"] .ag-i18n-trigger {
  background: rgba(128, 128, 128, 0.16);
  border-color: rgba(128, 128, 128, 0.28);
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-chevron {
  font-size: 11px;
  opacity: 0.65;
  transition: transform 0.15s ease;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-dropdown[data-open="true"] .ag-i18n-chevron {
  transform: rotate(180deg);
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 2147483200;
  min-width: 186px;
  padding: 5px;
  border-radius: 12px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  background: canvas;
  color: canvastext;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
  display: none;
  flex-direction: column;
  gap: 2px;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-dropdown[data-open="true"] .ag-i18n-menu {
  display: flex;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 8px 11px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-option:hover {
  background: rgba(128, 128, 128, 0.12);
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-option[data-active="true"] {
  background: rgba(37, 99, 235, 0.1);
  color: #2563eb;
  font-weight: 500;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.3);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.18s ease;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-switch[data-checked="true"] {
  background: #2563eb;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-switch-knob {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
  transform: translateX(0);
  transition: transform 0.18s ease;
}
[data-ag-i18n-ui="settings-section"] .ag-i18n-switch[data-checked="true"] .ag-i18n-switch-knob {
  transform: translateX(18px);
}
[data-ag-i18n-ui="floating-badge"] {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  background: rgba(29, 78, 216, 0.88);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(6px);
  transition: transform 0.15s ease, opacity 0.15s ease;
  opacity: 0.84;
}
[data-ag-i18n-ui="floating-badge"]:hover {
  transform: scale(1.06);
  opacity: 1;
}
[data-ag-i18n-ui="modal-backdrop"] {
  position: fixed;
  inset: 0;
  z-index: 2147483500;
  background: rgba(0, 0, 0, 0.48);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(3px);
}
[data-ag-i18n-ui="modal-card"] {
  width: min(440px, 92vw);
  border-radius: 14px;
  padding: 20px;
  background: canvas;
  color: canvastext;
  border: 1px solid rgba(128, 128, 128, 0.3);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
  font-family: inherit;
}
[data-ag-i18n-ui="modal-card"] h3 {
  margin: 0 0 6px 0;
  font-size: 16px;
  font-weight: 600;
}
[data-ag-i18n-ui="modal-card"] p {
  margin: 0 0 14px 0;
  font-size: 12px;
  opacity: 0.72;
}
[data-ag-i18n-ui="modal-card"] .ag-i18n-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
[data-ag-i18n-ui="modal-card"] .ag-i18n-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
[data-ag-i18n-ui="modal-card"] .ag-i18n-item[data-active="true"] {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.14);
  font-weight: 600;
}
[data-ag-i18n-ui="modal-card"] .ag-i18n-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
[data-ag-i18n-ui="modal-card"] .ag-i18n-scan-btn {
  padding: 6px 11px;
  border-radius: 7px;
  border: 1px dashed rgba(128, 128, 128, 0.45);
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-ag-i18n-ui="modal-card"] .ag-i18n-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(128, 128, 128, 0.2);
  font-size: 12px;
}
[data-ag-i18n-ui="modal-card"] .ag-i18n-close {
  padding: 6px 14px;
  border-radius: 7px;
  border: 1px solid rgba(128, 128, 128, 0.32);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
`;

function isInsideNavigation(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const tag = (cur.tagName || '').toUpperCase();
    if (tag === 'NAV' || tag === 'ASIDE' || tag === 'BUTTON' || tag === 'A') return true;
    const role = typeof cur.getAttribute === 'function' ? cur.getAttribute('role') : null;
    if (role === 'navigation' || role === 'tablist' || role === 'tab' || role === 'button') {
      return true;
    }
    cur = cur.parentElement || cur.parentNode || null;
  }
  return false;
}

function isElementVisible(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return true;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function walkElementsDeep(root, visitor) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeType === 1) {
      if (typeof node.getAttribute === 'function' && node.getAttribute('data-ag-i18n-ui')) {
        continue;
      }
      if (visitor(node) === true) return;
      if (node.shadowRoot) stack.push(node.shadowRoot);
    }
    const children = node.childNodes;
    if (children && children.length) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  }
}

export function mountLanguageUI(translator, options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const storage = options.storage || (win && win.localStorage ? win.localStorage : null);
  if (!doc) return null;

  function isFloatingEnabled() {
    try {
      if (storage && typeof storage.getItem === 'function') {
        const raw = storage.getItem(STORAGE_KEY_FLOATING);
        if (raw !== null) return raw !== 'false';
      }
    } catch {
      // Ignore storage restrictions
    }
    return options.floatingButton !== false;
  }

  function isDebugEnabled() {
    try {
      if (storage && typeof storage.getItem === 'function') {
        return storage.getItem(STORAGE_KEY_DEBUG) === 'true';
      }
    } catch {
      // Ignore storage restrictions
    }
    return false;
  }

  function setDebugEnabled(enabled) {
    try {
      if (storage && typeof storage.setItem === 'function') {
        storage.setItem(STORAGE_KEY_DEBUG, enabled ? 'true' : 'false');
      }
    } catch {
      // Ignore storage restrictions
    }
  }

  function setFloatingEnabled(enabled) {
    try {
      if (storage && typeof storage.setItem === 'function') {
        storage.setItem(STORAGE_KEY_FLOATING, enabled ? 'true' : 'false');
      }
    } catch {
      // Ignore storage restrictions
    }
    syncFloatingBadge();
    const existing =
      typeof doc.querySelector === 'function'
        ? doc.querySelector('[data-ag-i18n-ui="settings-section"]')
        : null;
    if (existing) refreshSettingsSection(existing);
  }

  function ensureStyles() {
    if (!doc.head || typeof doc.getElementById !== 'function') return;
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = UI_CSS;
    doc.head.appendChild(style);
  }

  function populateDropdown(dropdownEl, force = false) {
    const locales = translator.getAvailableLocales();
    const active = translator.getLocale();
    const sig = `${active}|${locales.map((l) => `${l.code}:${l.nativeName}`).join(',')}`;
    if (!force && dropdownEl.getAttribute('data-sig') === sig) {
      return;
    }
    dropdownEl.setAttribute('data-sig', sig);

    const activeMeta = locales.find((l) => l.code === active) || locales[0];
    const labelEl = dropdownEl.querySelector && dropdownEl.querySelector('.ag-i18n-trigger-label');
    const menuEl = dropdownEl.querySelector && dropdownEl.querySelector('.ag-i18n-menu');
    if (labelEl && activeMeta) {
      labelEl.textContent = `${activeMeta.nativeName} (${activeMeta.code})`;
    }
    if (!menuEl) return;
    menuEl.innerHTML = '';
    for (const loc of locales) {
      const optBtn = doc.createElement('button');
      optBtn.type = 'button';
      optBtn.className = 'ag-i18n-option';
      optBtn.setAttribute('role', 'option');
      optBtn.setAttribute('data-locale', loc.code);
      optBtn.setAttribute('data-active', loc.code === active ? 'true' : 'false');
      optBtn.textContent = `${loc.nativeName} (${loc.code})${loc.code === active ? ' ✓' : ''}`;
      optBtn.addEventListener('click', (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        dropdownEl.setAttribute('data-open', 'false');
        translator.setLocale(loc.code);
      });
      menuEl.appendChild(optBtn);
    }
  }

  function closeAllDropdowns() {
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    const openOnes = doc.querySelectorAll('[data-ag-i18n-ui="settings-section"] .ag-i18n-dropdown');
    for (const el of openOnes) {
      el.setAttribute('data-open', 'false');
    }
  }

  function createSettingsSection() {
    const ui = translator.getLocaleMeta().ui;
    const wrapper = doc.createElement('div');
    wrapper.setAttribute('data-ag-i18n-ui', 'settings-section');

    const heading = doc.createElement('div');
    heading.className = 'ag-i18n-section-heading';
    heading.textContent = ui.sectionTitle || 'Language';

    const card = doc.createElement('div');
    card.className = 'ag-i18n-card';

    const langRow = doc.createElement('div');
    langRow.className = 'ag-i18n-row';

    const meta = doc.createElement('div');
    meta.className = 'ag-i18n-meta';

    const title = doc.createElement('div');
    title.className = 'ag-i18n-title';
    title.textContent = ui.settingLabel;

    const desc = doc.createElement('div');
    desc.className = 'ag-i18n-desc';
    desc.textContent = ui.settingDescription;

    meta.appendChild(title);
    meta.appendChild(desc);

    // Custom Antigravity-style pill dropdown
    const dropdown = doc.createElement('div');
    dropdown.className = 'ag-i18n-dropdown';
    dropdown.setAttribute('data-open', 'false');

    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ag-i18n-trigger';
    trigger.setAttribute('aria-label', ui.settingLabel);
    trigger.setAttribute('aria-haspopup', 'listbox');

    const triggerLabel = doc.createElement('span');
    triggerLabel.className = 'ag-i18n-trigger-label';

    const chevron = doc.createElement('span');
    chevron.className = 'ag-i18n-chevron';
    chevron.textContent = '▾';

    trigger.appendChild(triggerLabel);
    trigger.appendChild(chevron);

    const menu = doc.createElement('div');
    menu.className = 'ag-i18n-menu';
    menu.setAttribute('role', 'listbox');

    trigger.addEventListener('click', (ev) => {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      const nextOpen = dropdown.getAttribute('data-open') !== 'true';
      closeAllDropdowns();
      dropdown.setAttribute('data-open', nextOpen ? 'true' : 'false');
    });

    dropdown.appendChild(trigger);
    dropdown.appendChild(menu);
    populateDropdown(dropdown);

    langRow.appendChild(meta);
    langRow.appendChild(dropdown);

    const floatRow = doc.createElement('div');
    floatRow.className = 'ag-i18n-row';

    const floatMeta = doc.createElement('div');
    floatMeta.className = 'ag-i18n-meta';

    const floatTitle = doc.createElement('div');
    floatTitle.className = 'ag-i18n-float-title';
    floatTitle.textContent = ui.toggleFloatingLabel;

    const floatDesc = doc.createElement('div');
    floatDesc.className = 'ag-i18n-desc ag-i18n-float-desc';
    floatDesc.textContent =
      ui.floatingHint || 'Ctrl+Alt+L can also open the language picker anytime.';

    floatMeta.appendChild(floatTitle);
    floatMeta.appendChild(floatDesc);

    // Custom iOS / Antigravity-style pill toggle switch
    const switchBtn = doc.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'ag-i18n-switch';
    switchBtn.setAttribute('role', 'switch');
    const checked = isFloatingEnabled();
    switchBtn.setAttribute('data-checked', checked ? 'true' : 'false');
    switchBtn.setAttribute('aria-checked', checked ? 'true' : 'false');
    switchBtn.setAttribute('aria-label', ui.toggleFloatingLabel);

    const knob = doc.createElement('span');
    knob.className = 'ag-i18n-switch-knob';
    switchBtn.appendChild(knob);

    switchBtn.addEventListener('click', (ev) => {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      setFloatingEnabled(!isFloatingEnabled());
    });

    floatRow.appendChild(floatMeta);
    floatRow.appendChild(switchBtn);

    card.appendChild(langRow);
    card.appendChild(floatRow);
    wrapper.appendChild(heading);
    wrapper.appendChild(card);
    return wrapper;
  }

  function findSettingsAnchor(root) {
    if (!root) return null;
    let subtitleMatch = null;
    let fallbackMatch = null;

    walkElementsDeep(root, (el) => {
      if (isInsideNavigation(el)) return false;
      const hasElementChild = Array.from(el.childNodes || []).some((n) => n.nodeType === 1);
      if (hasElementChild) return false;
      const text = (el.textContent || '').trim();
      if (!text) return false;

      if (SETTINGS_SUBTITLE_ANCHORS.has(text) && isElementVisible(el)) {
        subtitleMatch = { el, mode: 'after' };
        return true;
      }
      if (!fallbackMatch && SETTINGS_FALLBACK_ANCHORS.has(text) && isElementVisible(el)) {
        fallbackMatch = { el, mode: 'before' };
      }
      return false;
    });

    return subtitleMatch || fallbackMatch;
  }

  function refreshSettingsSection(section) {
    const ui = translator.getLocaleMeta().ui;
    const heading = section.querySelector && section.querySelector('.ag-i18n-section-heading');
    const title = section.querySelector && section.querySelector('.ag-i18n-title');
    const desc = section.querySelector && section.querySelector('.ag-i18n-desc');
    const dropdown = section.querySelector && section.querySelector('.ag-i18n-dropdown');
    const trigger = section.querySelector && section.querySelector('.ag-i18n-trigger');
    const floatTitle = section.querySelector && section.querySelector('.ag-i18n-float-title');
    const floatDesc = section.querySelector && section.querySelector('.ag-i18n-float-desc');
    const switchBtn = section.querySelector && section.querySelector('.ag-i18n-switch');
    if (heading) heading.textContent = ui.sectionTitle || 'Language';
    if (title) title.textContent = ui.settingLabel;
    if (desc) desc.textContent = ui.settingDescription;
    if (trigger) trigger.setAttribute('aria-label', ui.settingLabel);
    if (dropdown) populateDropdown(dropdown);
    if (floatTitle) floatTitle.textContent = ui.toggleFloatingLabel;
    if (floatDesc) {
      floatDesc.textContent =
        ui.floatingHint || 'Ctrl+Alt+L can also open the language picker anytime.';
    }
    if (switchBtn) {
      const checked = isFloatingEnabled();
      switchBtn.setAttribute('data-checked', checked ? 'true' : 'false');
      switchBtn.setAttribute('aria-checked', checked ? 'true' : 'false');
      switchBtn.setAttribute('aria-label', ui.toggleFloatingLabel);
    }
  }

  function injectIntoSettings() {
    if (!doc.body) return false;

    const match = findSettingsAnchor(doc.body);
    const existing =
      typeof doc.querySelector === 'function'
        ? doc.querySelector('[data-ag-i18n-ui="settings-section"]')
        : null;

    if (!match || !match.el || !match.el.parentNode) {
      if (existing) refreshSettingsSection(existing);
      return Boolean(existing);
    }

    // If our section is already mounted inside the same container as the active anchor, just refresh
    if (existing && existing.parentNode === match.el.parentNode) {
      refreshSettingsSection(existing);
      return true;
    }

    // Remove any orphaned/hidden instance from a previous tab
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    const section = createSettingsSection();
    if (match.mode === 'after') {
      if (match.el.nextSibling) {
        match.el.parentNode.insertBefore(section, match.el.nextSibling);
      } else {
        match.el.parentNode.appendChild(section);
      }
    } else {
      match.el.parentNode.insertBefore(section, match.el);
    }
    return true;
  }

  let badgeEl = null;
  let modalBackdropEl = null;

  function syncFloatingBadge() {
    if (!doc.body) return;
    const enabled = isFloatingEnabled();
    if (!enabled) {
      if (badgeEl && badgeEl.parentNode) {
        badgeEl.parentNode.removeChild(badgeEl);
      }
      badgeEl = null;
      return;
    }

    const ui = translator.getLocaleMeta().ui;
    if (!badgeEl) {
      badgeEl = doc.createElement('button');
      badgeEl.type = 'button';
      badgeEl.setAttribute('data-ag-i18n-ui', 'floating-badge');
      badgeEl.addEventListener('click', () => openLanguageModal());
      doc.body.appendChild(badgeEl);
    }
    badgeEl.textContent = ui.badgeLabel || translator.getLocale().slice(0, 2).toUpperCase();
    badgeEl.setAttribute('title', ui.badgeTooltip);
    badgeEl.setAttribute('aria-label', ui.badgeTooltip);
  }

  function closeLanguageModal() {
    if (modalBackdropEl && modalBackdropEl.parentNode) {
      modalBackdropEl.parentNode.removeChild(modalBackdropEl);
    }
    modalBackdropEl = null;
  }

  function copyTextToClipboard(text) {
    if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
      return win.navigator.clipboard.writeText(text).catch(() => {});
    }
    return Promise.resolve();
  }

  function openLanguageModal() {
    if (!doc.body) return;
    closeLanguageModal();

    const ui = translator.getLocaleMeta().ui;
    const active = translator.getLocale();
    const locales = translator.getAvailableLocales();

    const backdrop = doc.createElement('div');
    backdrop.setAttribute('data-ag-i18n-ui', 'modal-backdrop');
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) closeLanguageModal();
    });

    const card = doc.createElement('div');
    card.setAttribute('data-ag-i18n-ui', 'modal-card');

    const title = doc.createElement('h3');
    title.textContent = ui.modalTitle;

    const subtitle = doc.createElement('p');
    subtitle.textContent = ui.modalSubtitle;

    const list = doc.createElement('div');
    list.className = 'ag-i18n-list';

    for (const loc of locales) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-i18n-item';
      btn.setAttribute('data-locale', loc.code);
      btn.setAttribute('data-active', loc.code === active ? 'true' : 'false');
      btn.textContent = `${loc.nativeName} (${loc.code})${loc.code === active ? ' ✓' : ''}`;
      btn.addEventListener('click', () => {
        translator.setLocale(loc.code);
        openLanguageModal();
      });
      list.appendChild(btn);
    }

    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(list);

    // Only show contributor untranslated-string scanner when debug mode is explicitly enabled
    if (isDebugEnabled()) {
      const tools = doc.createElement('div');
      tools.className = 'ag-i18n-tools';
      const scanBtn = doc.createElement('button');
      scanBtn.type = 'button';
      scanBtn.className = 'ag-i18n-scan-btn';
      scanBtn.textContent = ui.scanUntranslatedLabel || 'Copy untranslated strings (JSON)';
      scanBtn.addEventListener('click', () => {
        const missing = translator.collectUntranslated ? translator.collectUntranslated(doc.body) : {};
        const count = Object.keys(missing).length;
        copyTextToClipboard(JSON.stringify(missing, null, 2));
        scanBtn.textContent =
          count > 0
            ? `${ui.scanCopiedPrefix || 'Copied'} (${count})`
            : ui.scanNoneLabel || 'All UI strings translated!';
      });
      tools.appendChild(scanBtn);
      card.appendChild(tools);
    }

    const footer = doc.createElement('div');
    footer.className = 'ag-i18n-footer';

    const toggleLabel = doc.createElement('label');
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isFloatingEnabled();
    checkbox.addEventListener('change', () => setFloatingEnabled(checkbox.checked));
    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(doc.createTextNode(` ${ui.toggleFloatingLabel}`));

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ag-i18n-close';
    closeBtn.textContent = ui.closeButton;
    closeBtn.addEventListener('click', closeLanguageModal);

    footer.appendChild(toggleLabel);
    footer.appendChild(closeBtn);

    card.appendChild(footer);
    backdrop.appendChild(card);

    doc.body.appendChild(backdrop);
    modalBackdropEl = backdrop;
  }

  function handleKeydown(ev) {
    if (!ev) return;
    const isMod = ev.ctrlKey || ev.metaKey;
    // Use Ctrl+Alt+L (Cmd+Option+L on macOS) to avoid clashing with Antigravity's Ctrl+Shift+L
    if (isMod && ev.altKey && (ev.key === 'L' || ev.key === 'l')) {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (modalBackdropEl) closeLanguageModal();
      else openLanguageModal();
    } else if (ev.key === 'Escape') {
      closeAllDropdowns();
      if (modalBackdropEl) closeLanguageModal();
    }
  }

  function handleClick(ev) {
    const target = ev && ev.target;
    const insideDropdown =
      target && typeof target.closest === 'function' && Boolean(target.closest('.ag-i18n-dropdown'));
    if (!insideDropdown) {
      closeAllDropdowns();
    }
    const insideOwnUI =
      target && typeof target.closest === 'function' && Boolean(target.closest('[data-ag-i18n-ui]'));
    if (insideOwnUI) return;
    setTimeout(() => injectIntoSettings(), 80);
    setTimeout(() => injectIntoSettings(), 280);
  }

  ensureStyles();
  syncFloatingBadge();
  injectIntoSettings();

  const unsubscribe = translator.subscribe(() => {
    syncFloatingBadge();
    injectIntoSettings();
  });

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('keydown', handleKeydown);
    win.addEventListener('click', handleClick, false);
  }

  return {
    injectIntoSettings,
    openLanguageModal,
    closeLanguageModal,
    syncFloatingBadge,
    setDebugEnabled,
    destroy() {
      unsubscribe();
      closeLanguageModal();
      if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('keydown', handleKeydown);
        win.removeEventListener('click', handleClick, false);
      }
    },
  };
}
