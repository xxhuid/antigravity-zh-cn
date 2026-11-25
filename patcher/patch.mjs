#!/usr/bin/env node
/**
 * Antigravity 2.0 Static ASAR Patcher (Zero Dependencies, Unpacked-Safe, Sandbox-Compatible)
 *
 * Improvements:
 *   - Built-in pure Node.js ASAR codec: preserves all `unpacked: true` entries verbatim without
 *     touching `app.asar.unpacked` (eliminates ENOENT on `*.bak.unpacked` and avoids repacking bloat).
 *   - Inlines the renderer i18n engine directly inside preload / HTML entry so it works even when
 *     Electron runs with `sandbox: true` and `contextIsolation: true` (zero `require('fs')` needed).
 *   - Always creates a pristine backup `app.asar.zh-cn.bak` before touching `app.asar`.
 *
 * Usage:
 *   node patcher/patch.mjs --status  [--asar <path>]
 *   node patcher/patch.mjs --apply   [--asar <path>] [--locale zh-CN] [--dry-run]
 *   node patcher/patch.mjs --restore [--asar <path>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, ROOT_DIR } from '../scripts/build-bundle.mjs';
import {
  getAsarEntry,
  listAsarFiles,
  readAsarFileBuffer,
  readAsarHeader,
  rewriteAsarArchive,
} from './asar-codec.mjs';

const __filename = fileURLToPath(import.meta.url);

export const MARKER_START = '/* ANTIGRAVITY-I18N-START */';
export const MARKER_END = '/* ANTIGRAVITY-I18N-END */';
export const HTML_MARKER_START = '<!-- ANTIGRAVITY-I18N-START -->';
export const HTML_MARKER_END = '<!-- ANTIGRAVITY-I18N-END -->';
const BACKUP_SUFFIX = '.zh-cn.bak';

export function stripInjectedBlocks(source) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const jsRe = new RegExp(`\\r?\\n?${esc(MARKER_START)}[\\s\\S]*?${esc(MARKER_END)}\\r?\\n?`, 'g');
  const htmlRe = new RegExp(
    `\\r?\\n?${esc(HTML_MARKER_START)}[\\s\\S]*?${esc(HTML_MARKER_END)}\\r?\\n?`,
    'g',
  );
  return source.replace(jsRe, '\n').replace(htmlRe, '\n');
}

/**
 * Build a sandbox-safe inline renderer preload snippet (no `require('fs')` / Node APIs required).
 */
export function buildRendererPreloadSnippet(runtimeJsCode) {
  return [
    '',
    MARKER_START,
    `(function () {`,
    `  if (typeof window === 'undefined' || typeof document === 'undefined') return;`,
    `  const __runI18n = function () {`,
    `    try {`,
    runtimeJsCode,
    `    } catch (e) {`,
    `      console.warn('[antigravity-i18n] runtime init skipped:', e);`,
    `    }`,
    `  };`,
    `  if (document.readyState === 'loading') {`,
    `    window.addEventListener('DOMContentLoaded', __runI18n, { once: true });`,
    `  } else {`,
    `    __runI18n();`,
    `  }`,
    `})();`,
    MARKER_END,
    '',
  ].join('\n');
}

/**
 * Build an inline HTML <script> fallback snippet when an Electron app loads an HTML entry directly.
 */
export function buildHtmlScriptSnippet(runtimeJsCode) {
  const safeCode = runtimeJsCode.replace(/<\/script>/gi, '<\\/script>');
  return [
    '',
    HTML_MARKER_START,
    `<script>`,
    safeCode,
    `</script>`,
    HTML_MARKER_END,
    '',
  ].join('\n');
}

/**
 * Build an inline Electron main-process native Menu hook (translates File/Edit/View/Window/Help).
 */
export function buildMainMenuHookSnippet(menuLocalesObj, defaultLocale = 'zh-CN') {
  return [
    '',
    MARKER_START,
    `(function () {`,
    `  try {`,
    `    if (typeof require !== 'function') return;`,
    `    const electron = require('electron');`,
    `    if (!electron || !electron.Menu || typeof electron.Menu.buildFromTemplate !== 'function') return;`,
    `    const allMenus = ${JSON.stringify(menuLocalesObj || {})};`,
    `    const locale = (typeof process !== 'undefined' && process.env && process.env.ANTIGRAVITY_LOCALE) || ${JSON.stringify(defaultLocale)};`,
    `    const dict = allMenus[locale] || {};`,
    `    const origBuild = electron.Menu.buildFromTemplate.bind(electron.Menu);`,
    `    const translateTemplate = (items) => {`,
    `      if (!Array.isArray(items)) return items;`,
    `      return items.map((item) => {`,
    `        if (!item || typeof item !== 'object') return item;`,
    `        const next = Object.assign({}, item);`,
    `        if (typeof next.label === 'string') {`,
    `          const clean = next.label.replace(/&/g, '').trim();`,
    `          if (dict[clean]) next.label = dict[clean];`,
    `        }`,
    `        if (Array.isArray(next.submenu)) next.submenu = translateTemplate(next.submenu);`,
    `        return next;`,
    `      });`,
    `    };`,
    `    electron.Menu.buildFromTemplate = (tpl) => origBuild(translateTemplate(tpl));`,
    `  } catch (e) {`,
    `    console.warn('[antigravity-i18n] main menu hook skipped:', e);`,
    `  }`,
    `})();`,
    MARKER_END,
    '',
  ].join('\n');
}

export function injectIntoSource(originalSource, snippet) {
  const cleaned = stripInjectedBlocks(originalSource).trimEnd();
  return `${cleaned}\n${snippet}`;
}

export function injectIntoHtml(originalHtml, snippet) {
  const cleaned = stripInjectedBlocks(originalHtml);
  if (/<\/body>/i.test(cleaned)) {
    return cleaned.replace(/<\/body>/i, `${snippet}</body>`);
  }
  if (/<\/html>/i.test(cleaned)) {
    return cleaned.replace(/<\/html>/i, `${snippet}</html>`);
  }
  return `${cleaned}\n${snippet}`;
}

/**
 * Inspect an ASAR header tree directly to find version, patch state, main entry, preload JS files, and fallback HTML files.
 */
export function findAsarPatchTargets(asarPath) {
  const parsed = readAsarHeader(asarPath);
  const allFiles = listAsarFiles(parsed.header).filter(
    (f) => !f.entry.unpacked && !f.entry.link && !f.path.startsWith('node_modules/') && !f.path.includes('/node_modules/'),
  );

  let mainEntry = '';
  let appVersion = 'unknown';
  const pkgEntry = getAsarEntry(parsed.header, 'package.json');
  if (pkgEntry && !pkgEntry.unpacked) {
    try {
      const pkg = JSON.parse(readAsarFileBuffer(asarPath, 'package.json', parsed).toString('utf8'));
      if (pkg.version) appVersion = String(pkg.version);
      if (pkg.main) {
        const normMain = pkg.main.replace(/\\/g, '/').replace(/^\.\//, '');
        if (getAsarEntry(parsed.header, normMain)) {
          mainEntry = normMain;
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  const allPreloads = allFiles
    .filter((f) => /(^|\/)[^/]*preload[^/]*\.(c?js|mjs)$/i.test(f.path))
    .map((f) => f.path);

  // Prefer the primary app window preload (e.g. dist/preload.js) and avoid
  // injecting into browser/webview/sandbox helper preloads.
  const exactPreloads = allPreloads.filter((p) => /(^|\/)preload\.(c?js|mjs)$/i.test(p));
  const preloadFiles =
    exactPreloads.length > 0
      ? exactPreloads
      : allPreloads.filter(
          (p) => !/(browser|webview|jail|capture|webauthn|catcher|ssh|wizard)/i.test(p),
        );

  const htmlFiles = allFiles
    .filter((f) => /(^|\/)index\.html?$/i.test(f.path))
    .map((f) => f.path);

  // Detect whether this ASAR already contains our injected markers
  const checkFiles = [...preloadFiles, ...htmlFiles, ...(mainEntry ? [mainEntry] : [])];
  let isPatched = false;
  for (const rel of checkFiles) {
    try {
      const content = readAsarFileBuffer(asarPath, rel, parsed).toString('utf8');
      if (content.includes(MARKER_START) || content.includes(HTML_MARKER_START)) {
        isPatched = true;
        break;
      }
    } catch {
      // Ignore unreadable file
    }
  }

  return { parsed, appVersion, isPatched, mainEntry, preloadFiles, htmlFiles };
}

/**
 * Determine whether backupPath should be refreshed from current asarPath.
 * Crucial safety rule: when official Antigravity auto-updates overwrite `app.asar` with a newer
 * pristine version, we MUST refresh `app.asar.zh-cn.bak` instead of re-applying an outdated backup!
 */
export function resolveBackupAction(asarPath, backupPath) {
  const current = findAsarPatchTargets(asarPath);
  const hasBackup = fs.existsSync(backupPath);
  const backup = hasBackup ? findAsarPatchTargets(backupPath) : null;

  if (!current.isPatched) {
    // Current app.asar is an unpatched official build (first install OR freshly auto-updated)
    const upgradedFrom =
      backup && backup.appVersion !== current.appVersion ? backup.appVersion : null;
    return {
      action: 'refresh-backup',
      current,
      backup,
      upgradedFrom,
    };
  }

  if (!hasBackup) {
    throw new Error(
      `当前 app.asar 已包含汉化补丁，但未找到原版备份 ${backupPath}；请重新安装官方 Antigravity 后再执行补丁。`,
    );
  }

  if (backup.appVersion !== current.appVersion) {
    throw new Error(
      `检测到版本不一致（当前 app.asar=${current.appVersion}，备份=${backup.appVersion}），已中止以防损坏客户端。`,
    );
  }

  return {
    action: 'reuse-backup',
    current,
    backup,
    upgradedFrom: null,
  };
}

function isExistingFile(filePath) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function detectAsarPath(platform = process.platform, options = {}) {
  const candidates = [];
  const homeDir = options.homeDir || os.homedir();
  const repoDir = options.rootDir || ROOT_DIR;
  const arch = options.arch || process.arch;

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app.asar'),
      path.join(localAppData, 'Programs', 'Google Antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google', 'Antigravity', 'resources', 'app.asar'),
    );
    for (const base of [
      path.join(localAppData, 'Antigravity'),
      path.join(localAppData, 'Google Antigravity'),
    ]) {
      if (fs.existsSync(base)) {
        try {
          const versions = fs
            .readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith('app-'))
            .map((d) => d.name)
            .sort()
            .reverse();
          for (const ver of versions) {
            candidates.push(path.join(base, ver, 'resources', 'app.asar'));
          }
        } catch {
          // Ignore unreadable directories
        }
      }
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(homeDir, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
    );
  } else {
    candidates.push(
      '/opt/Antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
    );
    const portableParents = [
      path.join(homeDir, 'Applications', 'Portable'),
      path.join(homeDir, 'Applications'),
      path.resolve(repoDir, '..'),
    ];
    const dirNames = ['Antigravity', 'antigravity', `Antigravity-${arch}`, 'Antigravity-x64', 'Antigravity-arm64'];
    const seenDirs = new Set();
    for (const parent of portableParents) {
      for (const name of dirNames) {
        const candidate = path.join(parent, name, 'resources', 'app.asar');
        if (!seenDirs.has(candidate)) {
          seenDirs.add(candidate);
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates.find((p) => isExistingFile(p)) || '';
}

function parseArgs(argv) {
  const args = {
    mode: 'status',
    asar: process.env.ANTIGRAVITY_ASAR_PATH || '',
    locale: 'zh-CN',
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--status') args.mode = 'status';
    else if (token === '--apply') args.mode = 'apply';
    else if (token === '--restore') args.mode = 'restore';
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--asar' && argv[i + 1]) args.asar = argv[++i];
    else if (token === '--locale' && argv[i + 1]) args.locale = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
Antigravity 静态补丁工具 (零依赖内置 ASAR 编解码 + 自动备份/还原)

用法:
  node patcher/patch.mjs --status  [--asar <path>]
  node patcher/patch.mjs --apply   [--asar <path>] [--locale zh-CN] [--dry-run]
  node patcher/patch.mjs --restore [--asar <path>]

说明:
  - 首次 --apply 会自动创建原版备份 app.asar.zh-cn.bak，绝不覆盖已有原版备份。
  - 原样保留所有 app.asar.unpacked 条目，不依赖外部 @electron/asar 工具。
  - 若客户端启用了 ASAR 完整性校验或 macOS 签名校验，请运行 --restore 还原并改用非破坏性启动器。
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const asarPath = args.asar || detectAsarPath();
  if (!asarPath) {
    console.error('[ERROR] 未找到 Antigravity 的 resources/app.asar，请通过 --asar "<路径>" 手动指定。');
    process.exit(1);
  }
  const backupPath = `${asarPath}${BACKUP_SUFFIX}`;

  if (args.mode === 'status') {
    console.log(`app.asar 路径: ${asarPath}`);
    console.log(`app.asar 存在: ${fs.existsSync(asarPath) ? '是' : '否'}`);
    console.log(`原版备份路径 : ${backupPath}`);
    console.log(`已存在备份   : ${fs.existsSync(backupPath) ? '是' : '否'}`);
    if (fs.existsSync(asarPath)) {
      const { appVersion, isPatched, mainEntry, preloadFiles, htmlFiles } =
        findAsarPatchTargets(asarPath);
      console.log(`客户端版本   : ${appVersion}`);
      console.log(`当前补丁状态 : ${isPatched ? '已应用汉化补丁' : '官方原版（未打补丁）'}`);
      if (fs.existsSync(backupPath)) {
        const bakInfo = findAsarPatchTargets(backupPath);
        console.log(`原版备份版本 : ${bakInfo.appVersion}`);
      }
      console.log(`检测到主入口 : ${mainEntry || '(未找到)'}`);
      console.log(`检测到 preload: ${preloadFiles.length > 0 ? preloadFiles.join(', ') : '(无)'}`);
      console.log(`检测到 HTML  : ${htmlFiles.length > 0 ? htmlFiles.join(', ') : '(无)'}`);
    }
    return;
  }

  if (args.mode === 'restore') {
    if (!fs.existsSync(backupPath)) {
      console.error(`[ERROR] 未找到备份文件: ${backupPath}`);
      process.exit(1);
    }
    fs.copyFileSync(backupPath, asarPath);
    console.log(`[OK] 已从备份还原原版 app.asar: ${asarPath}`);
    return;
  }

  // Apply mode
  console.log('[i18n] 正在构建多语言运行时与菜单词典...');
  const { runtimeOut, menuOut } = buildBundle(ROOT_DIR);
  const runtimeJsCode = fs.readFileSync(runtimeOut, 'utf8');
  const menuLocalesObj = JSON.parse(fs.readFileSync(menuOut, 'utf8'));

  const plan = resolveBackupAction(asarPath, backupPath);
  const sourceInfo = plan.action === 'reuse-backup' ? plan.backup : plan.current;
  const { parsed, appVersion, mainEntry, preloadFiles, htmlFiles } = sourceInfo;

  if (args.dryRun) {
    console.log('[DRY-RUN] 模拟补丁计划（不会修改任何客户端文件）:');
    console.log(`  1. 目标 app.asar  : ${asarPath} (版本: ${appVersion})`);
    console.log(`  2. 备份策略       : ${plan.action === 'refresh-backup' ? '刷新/新建原版备份' : '复用同版本原版备份'}`);
    console.log(`  3. 主进程菜单入口 : ${mainEntry || '(跳过)'}`);
    console.log(`  4. 渲染层 preload : ${preloadFiles.length > 0 ? preloadFiles.join(', ') : '(无，将回退至 HTML)'}`);
    console.log(`  5. 渲染层 HTML    : ${htmlFiles.length > 0 ? htmlFiles.join(', ') : '(无)'}`);
    return;
  }

  if (plan.action === 'refresh-backup') {
    fs.copyFileSync(asarPath, backupPath);
    if (plan.upgradedFrom) {
      console.log(
        `[OK] 检测到 Antigravity 已升级 (${plan.upgradedFrom} -> ${appVersion})，已自动刷新原版备份: ${backupPath}`,
      );
    } else {
      console.log(`[OK] 已创建原版备份 (v${appVersion}): ${backupPath}`);
    }
  } else {
    console.log(`[INFO] 检测到同版本 (v${appVersion}) 原版备份，将基于干净备份重新打补丁: ${backupPath}`);
  }

  const replacements = new Map();

  if (preloadFiles.length > 0) {
    const preloadSnippet = buildRendererPreloadSnippet(runtimeJsCode);
    for (const rel of preloadFiles) {
      const orig = readAsarFileBuffer(backupPath, rel, parsed).toString('utf8');
      replacements.set(rel, injectIntoSource(orig, preloadSnippet));
      console.log(`[OK] 准备注入渲染层 preload: ${rel}`);
    }
  } else if (htmlFiles.length > 0) {
    const htmlSnippet = buildHtmlScriptSnippet(runtimeJsCode);
    for (const rel of htmlFiles) {
      const orig = readAsarFileBuffer(backupPath, rel, parsed).toString('utf8');
      replacements.set(rel, injectIntoHtml(orig, htmlSnippet));
      console.log(`[OK] 准备注入渲染层 HTML: ${rel}`);
    }
  } else {
    throw new Error('未在 app.asar 中检测到 preload 脚本或 index.html 入口，已中止并保持原文件不变。');
  }

  if (mainEntry) {
    const origMain = readAsarFileBuffer(backupPath, mainEntry, parsed).toString('utf8');
    const menuSnippet = buildMainMenuHookSnippet(menuLocalesObj, args.locale);
    replacements.set(mainEntry, injectIntoSource(origMain, menuSnippet));
    console.log(`[OK] 准备注入主进程原生菜单 Hook: ${mainEntry}`);
  }

  const packedTmp = `${asarPath}.zh-cn.tmp`;
  console.log('[i18n] 正在重写 app.asar（原样保留 app.asar.unpacked）...');
  rewriteAsarArchive(backupPath, packedTmp, replacements);

  try {
    fs.renameSync(packedTmp, asarPath);
  } catch (err) {
    if (fs.existsSync(packedTmp)) {
      try {
        fs.copyFileSync(packedTmp, asarPath);
        fs.unlinkSync(packedTmp);
      } catch (copyErr) {
        fs.rmSync(packedTmp, { force: true });
        if (copyErr.code === 'EBUSY' || copyErr.code === 'EPERM' || copyErr.code === 'EACCES') {
          throw new Error(
            `写入 ${asarPath} 失败（${copyErr.code}）：请先彻底退出正在运行的 Antigravity（包括系统托盘图标）；如安装在 C:\\Program Files，请以管理员身份运行 PowerShell 后重试。`,
          );
        }
        throw copyErr;
      }
    } else {
      throw err;
    }
  }

  console.log('[OK] 静态补丁应用完成！现在可直接打开 Antigravity 查看效果。');
  console.log('[INFO] 如需还原原版，请运行: npm run patch:restore');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}
