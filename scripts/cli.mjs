#!/usr/bin/env node
/**
 * Antigravity Multi-Language One-Click Interactive Manager (Zero Dependencies)
 * Designed for non-CLI users (launched via double-click .bat / .command / .sh)
 * and power users alike (`npm start`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR } from './build-bundle.mjs';
import {
  applySelfUpdate,
  checkForUpdates,
  getLocalPackageVersion,
  inspectClientPatchStatus,
} from './update.mjs';

const __filename = fileURLToPath(import.meta.url);

function isAntigravityRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /Antigravity\.exe/i.test(out);
    }
    const res = spawnSync('pgrep', ['-f', 'Antigravity'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function tryStopAntigravity() {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/IM', 'Antigravity.exe', '/F'], { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', 'tell application "Antigravity" to quit'], { stdio: 'ignore' });
      return true;
    }
    execFileSync('pkill', ['-f', 'Antigravity'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runNodeScript(relScript, args = []) {
  const scriptPath = path.join(ROOT_DIR, relScript);
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  return res.status === 0;
}

function ask(rl, promptText) {
  return new Promise((resolve) => {
    rl.question(promptText, (ans) => resolve(ans.trim()));
  });
}

function formatClientStatusLine(status) {
  if (!status.found) {
    return '未自动检测到客户端（可手动传 --asar 或 --app 指定路径）';
  }
  if (status.state === 'patched') {
    return `v${status.appVersion} | 已应用汉化补丁`;
  }
  if (status.state === 'client-upgraded') {
    return `v${status.appVersion} | [!] 检测到官方已更新 (${status.backupVersion} -> ${status.appVersion})，请按 [1] 一键恢复汉化`;
  }
  return `v${status.appVersion} | 官方原版（未打补丁）`;
}

function formatUpdateStatusLine(updateInfo) {
  if (!updateInfo) return '检查中...';
  if (!updateInfo.ok) return `离线 / 检查失败 (${updateInfo.error})`;
  if (updateInfo.hasUpdate) {
    return `发现新版本 v${updateInfo.latestVersion}！（按 [6] 一键升级）`;
  }
  return `v${updateInfo.latestVersion}（已是最新）`;
}

async function ensureAppClosedForPatch(rl) {
  if (!isAntigravityRunning()) return true;
  console.log('\n[!] 检测到 Antigravity 客户端当前正在运行，打补丁/还原前必须完全退出。');
  const ans = await ask(rl, '是否由本工具自动关闭 Antigravity 后继续？(Y/n): ');
  if (ans && /^n/i.test(ans)) {
    console.log('[INFO] 已取消操作。请手动彻底退出 Antigravity（含系统托盘）后再重试。');
    return false;
  }
  const stopped = tryStopAntigravity();
  if (!stopped) {
    console.log('[WARN] 自动关闭未成功，请手动退出 Antigravity 后重试。');
    return false;
  }
  // Brief wait for Windows file locks on app.asar to release
  await new Promise((r) => setTimeout(r, 1200));
  return true;
}

function printMenu(localVersion, updateInfo, clientStatus) {
  console.log('');
  console.log('==================================================================');
  console.log(`  Antigravity 多语言汉化工具  v${localVersion}`);
  console.log('==================================================================');
  console.log(`  远程版本状态 : ${formatUpdateStatusLine(updateInfo)}`);
  console.log(`  客户端状态   : ${formatClientStatusLine(clientStatus)}`);
  console.log('------------------------------------------------------------------');
  console.log('  [1] 一键安装 / 恢复静态汉化补丁（双击原图标生效；官方更新后需重按 [1]）');
  console.log('  [2] 一键还原官方英文原版（仅用于撤回静态补丁）');
  console.log('  [3] 立即以无侵入模式启动（CDP，不改文件、官方更新不失效）');
  if (process.platform === 'win32') {
    console.log('  [4] 创建桌面「Antigravity (中文版)」快捷方式（同 [3] 无侵入模式，省去每次开黑框）');
  } else {
    console.log('  [4] 预演静态补丁计划（不修改任何文件）');
  }
  console.log('  [5] 安装 / 卸载 Agent 中文工作流插件（全局生效、官方更新不失效）');
  console.log('  [6] 检查汉化包更新 & 一键自动升级');
  console.log('  [7] 查看详细诊断状态');
  console.log('  [0] 退出');
  console.log('==================================================================');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--apply')) {
    process.exit(runNodeScript('patcher/patch.mjs', ['--apply']) ? 0 : 1);
  }
  if (argv.includes('--restore')) {
    process.exit(runNodeScript('patcher/patch.mjs', ['--restore']) ? 0 : 1);
  }
  if (argv.includes('--launch')) {
    process.exit(runNodeScript('launcher/launch.mjs') ? 0 : 1);
  }
  if (argv.includes('--update')) {
    process.exit(runNodeScript('scripts/update.mjs', ['--apply']) ? 0 : 1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('[i18n] 正在检测本机 Antigravity 状态与最新版本...');
  let updateInfo = await checkForUpdates({ timeoutMs: 3500 });

  try {
    while (true) {
      const localVersion = getLocalPackageVersion(ROOT_DIR);
      const clientStatus = inspectClientPatchStatus();
      printMenu(localVersion, updateInfo, clientStatus);

      const choice = await ask(rl, '请输入数字并按回车: ');
      console.log('');

      if (choice === '0' || /^q(uit)?$/i.test(choice)) {
        console.log('已退出。');
        break;
      }

      if (choice === '1') {
        if (process.platform === 'darwin') {
          console.log('[!] 提示：macOS 上静态补丁可能破坏 Apple Silicon 官方签名，更推荐选项 [3]（CDP 无侵入启动）。');
          const confirmMac = await ask(rl, '仍要继续应用静态补丁吗？(y/N): ');
          if (!/^y/i.test(confirmMac)) continue;
        }
        const closed = await ensureAppClosedForPatch(rl);
        if (!closed) continue;
        runNodeScript('patcher/patch.mjs', ['--apply']);
        await ask(rl, '\n按回车返回主菜单...');
        continue;
      }

      if (choice === '2') {
        const closed = await ensureAppClosedForPatch(rl);
        if (!closed) continue;
        runNodeScript('patcher/patch.mjs', ['--restore']);
        await ask(rl, '\n按回车返回主菜单...');
        continue;
      }

      if (choice === '3') {
        console.log('[INFO] 即将以非破坏性 CDP 模式启动 Antigravity（不修改任何官方文件）...');
        console.log('[INFO] 若 Antigravity 已在运行，请先彻底退出后再启动以确保成功注入。\n');
        runNodeScript('launcher/launch.mjs');
        await ask(rl, '\n按回车返回主菜单...');
        continue;
      }

      if (choice === '4') {
        if (process.platform === 'win32') {
          const ps1 = path.join(ROOT_DIR, 'launcher', 'start-windows.ps1');
          spawnSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-CreateShortcut'],
            { cwd: ROOT_DIR, stdio: 'inherit' },
          );
        } else {
          runNodeScript('patcher/patch.mjs', ['--apply', '--dry-run']);
        }
        await ask(rl, '\n按回车返回主菜单...');
        continue;
      }

      if (choice === '5') {
        const pluginDir = path.join(
          process.env.HOME || process.env.USERPROFILE || '',
          '.gemini',
          'config',
          'plugins',
          'antigravity-zh-cn',
        );
        const installed = fs.existsSync(pluginDir);
        console.log(`当前 Agent 中文工作流插件状态: ${installed ? '已安装' : '未安装'}`);
        const sub = await ask(rl, '请选择: [1] 安装/更新插件  [2] 卸载插件  [0] 返回: ');
        if (sub === '1') {
          runNodeScript('scripts/install-agent-plugin.mjs');
        } else if (sub === '2') {
          runNodeScript('scripts/install-agent-plugin.mjs', ['--uninstall']);
        }
        await ask(rl, '\n按回车返回主菜单...');
        continue;
      }

      if (choice === '6') {
        console.log('[i18n] 正在重新检查 GitHub 最新版本...');
        updateInfo = await checkForUpdates({ timeoutMs: 8000 });
        if (!updateInfo.ok) {
          console.log(`[WARN] 检查更新失败: ${updateInfo.error}`);
          console.log(`[INFO] 你可以手动打开浏览器查看: ${updateInfo.releaseUrl}`);
        } else if (!updateInfo.hasUpdate) {
          console.log(`[OK] 当前已是最新版本 (v${updateInfo.currentVersion})！`);
        } else {
          console.log(`[NEW] 发现新版本: v${updateInfo.currentVersion} -> v${updateInfo.latestVersion}`);
          if (updateInfo.releaseNotes) {
            console.log('\n--- 更新说明 ---');
            console.log(updateInfo.releaseNotes.slice(0, 800));
            console.log('----------------\n');
          }
          const confirm = await ask(rl, '是否立即自动更新本地汉化包？(Y/n): ');
          if (!confirm || !/^n/i.test(confirm)) {
            const res = await applySelfUpdate(updateInfo);
            console.log(res.ok ? `[OK] ${res.message}` : `[ERROR] ${res.message}`);
            if (res.ok) {
              updateInfo = await checkForUpdates({ timeoutMs: 5000 });
              const refreshedClient = inspectClientPatchStatus();
              if (refreshedClient.found && (refreshedClient.isPatched || refreshedClient.clientUpgradedSincePatch)) {
                const repatch = await ask(
                  rl,
                  '\n检测到你正在使用静态补丁模式，是否立即重新应用新版汉化补丁？(Y/n): ',
                );
                if (!repatch || !/^n/i.test(repatch)) {
                  const closed = await ensureAppClosedForPatch(rl);
                  if (closed) {
                    runNodeScript('patcher/patch.mjs', ['--apply']);
                  }
                }
              }
            }
          }
        }
        await ask(rl, '\n按回车返回主菜单...');
        continue;
      }

      if (choice === '7') {
        runNodeScript('patcher/patch.mjs', ['--status']);
        await ask(rl, '\n按回车返回主菜单...');
        continue;
      }

      console.log('[WARN] 无效选项，请输入 0~7 之间的数字。');
    }
  } finally {
    rl.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(`[ERROR] ${err.message || err}`);
    process.exit(1);
  });
}
