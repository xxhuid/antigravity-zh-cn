#!/usr/bin/env node
/**
 * Antigravity Multi-Language Update Checker & Self-Updater (Zero Dependencies)
 * - Checks GitHub Releases for newer versions of antigravity-zh-cn
 * - Inspects local Antigravity client version vs backup version to detect post-upgrade patch invalidation
 * - Supports one-click self-update for both Git clones (`git pull --ff-only`) and portable ZIP releases
 *
 * Usage:
 *   node scripts/update.mjs           # Check for updates only
 *   node scripts/update.mjs --apply   # Check and apply update if available
 *   node scripts/update.mjs --json    # Output structured JSON status
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, ROOT_DIR } from './build-bundle.mjs';
import { detectAsarPath, findAsarPatchTargets } from '../patcher/patch.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_SLUG = 'xxhuid/antigravity-zh-cn';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases/latest`;
const BACKUP_SUFFIX = '.zh-cn.bak';

/**
 * Parse a SemVer string like "v0.3.2" or "0.4.0-beta.1".
 */
export function parseSemver(version) {
  const cleaned = String(version || '').trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

/**
 * Compare two SemVer strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease !== pb.prerelease) return pa.prerelease > pb.prerelease ? 1 : -1;
  return 0;
}

export function getLocalPackageVersion(rootDir = ROOT_DIR) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * Inspect local Antigravity client installation and patch status.
 * Detects when an official client update overwrote app.asar and invalidated the patch.
 */
export function inspectClientPatchStatus(asarPath = detectAsarPath()) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    return {
      found: false,
      asarPath: asarPath || '',
      backupPath: '',
      appVersion: 'unknown',
      backupVersion: null,
      isPatched: false,
      hasBackup: false,
      clientUpgradedSincePatch: false,
      state: 'not-found',
    };
  }

  const backupPath = `${asarPath}${BACKUP_SUFFIX}`;
  const current = findAsarPatchTargets(asarPath);
  const hasBackup = fs.existsSync(backupPath);
  let backupVersion = null;
  if (hasBackup) {
    try {
      backupVersion = findAsarPatchTargets(backupPath).appVersion;
    } catch {
      backupVersion = null;
    }
  }

  const clientUpgradedSincePatch = Boolean(
    !current.isPatched && hasBackup && backupVersion && backupVersion !== current.appVersion,
  );

  let state = 'unpatched';
  if (current.isPatched) {
    state = 'patched';
  } else if (clientUpgradedSincePatch) {
    state = 'client-upgraded';
  } else if (hasBackup) {
    state = 'restored';
  }

  return {
    found: true,
    asarPath,
    backupPath,
    appVersion: current.appVersion,
    backupVersion,
    isPatched: current.isPatched,
    hasBackup,
    clientUpgradedSincePatch,
    state,
  };
}

function defaultHttpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'antigravity-zh-cn-updater',
          Accept: 'application/vnd.github+json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          defaultHttpGetJson(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${err.message}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
    });
    req.on('error', reject);
  });
}

function downloadFile(url, destPath, timeoutMs = 30000, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'antigravity-zh-cn-updater',
          Accept: 'application/octet-stream',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (maxRedirects <= 0) {
            reject(new Error('重定向次数过多'));
            return;
          }
          downloadFile(res.headers.location, destPath, timeoutMs, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载失败: HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => resolve(destPath));
        });
        out.on('error', (err) => {
          fs.rmSync(destPath, { force: true });
          reject(err);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`下载超时 (${timeoutMs}ms)`));
    });
    req.on('error', (err) => {
      fs.rmSync(destPath, { force: true });
      reject(err);
    });
  });
}

/**
 * Check GitHub latest release against local package.json version.
 * Never throws; returns structured result with `ok: false` on network errors.
 */
export async function checkForUpdates(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const currentVersion = options.currentVersion || getLocalPackageVersion(rootDir);
  const timeoutMs = options.timeoutMs || 5000;
  const fetchJson = options.fetchJson || defaultHttpGetJson;
  const apiUrl = options.apiUrl || LATEST_RELEASE_API;

  try {
    const release = await fetchJson(apiUrl, timeoutMs);
    const rawTag = String(release.tag_name || release.name || '').trim();
    const latestVersion = rawTag.replace(/^v/i, '');
    if (!parseSemver(latestVersion)) {
      return {
        ok: false,
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: RELEASES_PAGE_URL,
        zipAssetUrl: null,
        zipAssetName: null,
        error: `无法解析远程版本号: ${rawTag || '(空)'}`,
      };
    }

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const zipAsset =
      assets.find((a) => /^antigravity-zh-cn-.*\.zip$/i.test(String(a.name || ''))) ||
      assets.find((a) => /\.zip$/i.test(String(a.name || ''))) ||
      null;

    const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      tagName: rawTag || `v${latestVersion}`,
      hasUpdate,
      publishedAt: release.published_at || '',
      releaseUrl: release.html_url || RELEASES_PAGE_URL,
      zipAssetUrl: zipAsset ? zipAsset.browser_download_url : null,
      zipAssetName: zipAsset ? zipAsset.name : null,
      releaseNotes: String(release.body || '').trim(),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: RELEASES_PAGE_URL,
      zipAssetUrl: null,
      zipAssetName: null,
      error: err && err.message ? err.message : String(err),
    };
  }
}

export function isGitRepository(rootDir = ROOT_DIR) {
  return fs.existsSync(path.join(rootDir, '.git'));
}

function extractZipArchive(zipPath, destDir) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'pipe' },
    );
  } else {
    try {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'pipe' });
    } catch {
      execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'pipe' });
    }
  }
}

function findExtractedRoot(extractDir) {
  if (fs.existsSync(path.join(extractDir, 'package.json'))) {
    return extractDir;
  }
  const entries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of entries) {
    const candidate = path.join(extractDir, dir.name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return '';
}

const PORTABLE_SYNC_ENTRIES = [
  'locales',
  'engine',
  'launcher',
  'patcher',
  'scripts',
  'agent-plugin',
  'dist',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'Windows-一键汉化工具.bat',
  'macOS-一键汉化工具.command',
  'Linux-一键汉化工具.sh',
];

/**
 * Apply update in-place via `git pull --ff-only` (for Git clones) or portable ZIP download.
 */
export async function applySelfUpdate(updateInfo, options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const log = options.log || console.log;

  if (isGitRepository(rootDir)) {
    log('[i18n] 检测到当前为 Git 仓库，正在执行 git pull --ff-only...');
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: rootDir,
        encoding: 'utf8',
      }).trim();
      if (status) {
        return {
          ok: false,
          method: 'git',
          message: '当前仓库存在未提交的本地修改，已取消自动拉取以防冲突；请手动 git stash 或处理后再试。',
        };
      }
      const out = execFileSync('git', ['pull', '--ff-only'], {
        cwd: rootDir,
        encoding: 'utf8',
      }).trim();
      if (out) log(out);
      buildBundle(rootDir);
      return {
        ok: true,
        method: 'git',
        newVersion: getLocalPackageVersion(rootDir),
        message: '已通过 Git 拉取最新代码并重新构建词库。',
      };
    } catch (err) {
      return {
        ok: false,
        method: 'git',
        message: `git pull 失败：${err.message || err}`,
      };
    }
  }

  if (!updateInfo || !updateInfo.zipAssetUrl) {
    return {
      ok: false,
      method: 'portable-zip',
      message: `未在最新 Release 中找到便携 ZIP 包，请手动前往下载：${(updateInfo && updateInfo.releaseUrl) || RELEASES_PAGE_URL}`,
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-cn-update-'));
  const zipPath = path.join(tmpDir, updateInfo.zipAssetName || 'release.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    log(`[i18n] 正在下载最新版本便携包: ${updateInfo.zipAssetName}...`);
    await downloadFile(updateInfo.zipAssetUrl, zipPath, options.downloadTimeoutMs || 30000);
    log('[i18n] 正在解压并覆盖更新本地文件...');
    extractZipArchive(zipPath, extractDir);

    const sourceRoot = findExtractedRoot(extractDir);
    if (!sourceRoot) {
      throw new Error('下载的压缩包结构无效（缺少 package.json）');
    }

    for (const entry of PORTABLE_SYNC_ENTRIES) {
      const src = path.join(sourceRoot, entry);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(rootDir, entry);
      fs.cpSync(src, dst, { recursive: true, force: true });
    }

    buildBundle(rootDir);
    return {
      ok: true,
      method: 'portable-zip',
      newVersion: getLocalPackageVersion(rootDir),
      message: `已更新至 v${getLocalPackageVersion(rootDir)} 并重新构建词库。`,
    };
  } catch (err) {
    return {
      ok: false,
      method: 'portable-zip',
      message: `便携包自动更新失败：${err.message || err}（可手动前往 ${updateInfo.releaseUrl} 下载）`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const asJson = argv.includes('--json');

  const clientStatus = inspectClientPatchStatus();
  const updateInfo = await checkForUpdates();

  if (asJson && !apply) {
    console.log(JSON.stringify({ update: updateInfo, client: clientStatus }, null, 2));
    return;
  }

  console.log(`当前汉化包版本 : v${updateInfo.currentVersion}`);
  if (updateInfo.ok) {
    if (updateInfo.hasUpdate) {
      console.log(`发现新版本     : v${updateInfo.latestVersion} (${updateInfo.releaseUrl})`);
    } else {
      console.log(`远程最新版本   : v${updateInfo.latestVersion}（已是最新）`);
    }
  } else {
    console.log(`检查更新失败   : ${updateInfo.error}（可手动访问 ${updateInfo.releaseUrl}）`);
  }

  if (clientStatus.found) {
    const stateLabel =
      clientStatus.state === 'patched'
        ? '已应用汉化补丁'
        : clientStatus.state === 'client-upgraded'
          ? `客户端已升级 (${clientStatus.backupVersion} -> ${clientStatus.appVersion})，补丁已失效，需重新应用`
          : '官方原版（未打补丁）';
    console.log(`Antigravity    : v${clientStatus.appVersion} | ${stateLabel}`);
  } else {
    console.log('Antigravity    : 未自动检测到客户端安装路径');
  }

  if (!apply) return;

  if (!updateInfo.ok) {
    console.error('[ERROR] 无法获取最新版本信息，已取消自动更新。');
    process.exit(1);
  }
  if (!updateInfo.hasUpdate) {
    console.log('[OK] 当前已是最新版本，无需更新。');
    return;
  }

  const res = await applySelfUpdate(updateInfo);
  if (!res.ok) {
    console.error(`[ERROR] ${res.message}`);
    process.exit(1);
  }
  console.log(`[OK] ${res.message}`);
  if (clientStatus.found && (clientStatus.isPatched || clientStatus.clientUpgradedSincePatch)) {
    console.log('[TIP] 如你使用静态补丁模式，请先退出 Antigravity，再运行 npm run patch:apply（或双击一键工具选 [1]）以刷新补丁。');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(`[ERROR] ${err.message || err}`);
    process.exit(1);
  });
}
