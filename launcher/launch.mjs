#!/usr/bin/env node
/**
 * Antigravity 2.0 Non-Destructive Multi-Language Launcher (CDP Runtime Injection)
 * - Does NOT modify any Antigravity binary or app.asar file
 * - Launches Antigravity with --remote-debugging-port and injects dist/i18n-runtime.js
 * - Automatically injects into new windows/reloads and survives minor UI updates
 *
 * Usage:
 *   node launcher/launch.mjs [--app <path>] [--port 9222] [--attach-only] [--rebuild]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, ROOT_DIR } from '../scripts/build-bundle.mjs';

const __filename = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const args = {
    app: process.env.ANTIGRAVITY_APP_PATH || '',
    port: Number(process.env.ANTIGRAVITY_CDP_PORT || 9222),
    attachOnly: false,
    rebuild: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--app' && argv[i + 1]) args.app = argv[++i];
    else if (token === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
    else if (token === '--attach-only') args.attachOnly = true;
    else if (token === '--rebuild') args.rebuild = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

export function detectAntigravityExecutable(platform = process.platform) {
  const candidates = [];
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(localAppData, 'Programs', 'Google Antigravity', 'Antigravity.exe'),
      path.join(localAppData, 'Antigravity', 'Antigravity.exe'),
      path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
      path.join(programFiles, 'Google', 'Antigravity', 'Antigravity.exe'),
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
            candidates.push(path.join(base, ver, 'Antigravity.exe'));
          }
        } catch {
          // Ignore unreadable directories
        }
      }
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity'),
    );
  } else {
    candidates.push(
      '/usr/bin/antigravity',
      '/usr/local/bin/antigravity',
      '/opt/Antigravity/antigravity',
      path.join(os.homedir(), '.local', 'bin', 'antigravity'),
    );
  }
  return candidates.find((p) => fs.existsSync(p)) || '';
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('CDP request timed out'));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCdpTargets(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(targets) && targets.length > 0) {
        return targets;
      }
    } catch {
      // Wait for Electron DevTools endpoint to come up
    }
    await sleep(400);
  }
  throw new Error(
    `未能在 ${timeoutMs / 1000}s 内连接到 CDP 端口 ${port}。请先完全退出正在运行的 Antigravity（包括系统托盘），再重新通过启动器运行。`,
  );
}

function injectIntoTarget(wsUrl, runtimeScript) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new Error('当前 Node.js 版本不支持内置 WebSocket，请升级至 Node.js 22+。'));
      return;
    }

    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        }
      } catch {
        // Ignore non-JSON frames
      }
    });

    ws.addEventListener('error', (err) => {
      reject(new Error(`WebSocket 连接失败: ${err.message || wsUrl}`));
    });

    ws.addEventListener('open', async () => {
      try {
        await send('Page.enable');
        await send('Page.addScriptToEvaluateOnNewDocument', { source: runtimeScript });
        await send('Runtime.evaluate', {
          expression: runtimeScript,
          awaitPromise: false,
          silent: false,
        });
        ws.close();
        resolve();
      } catch (err) {
        ws.close();
        reject(err);
      }
    });
  });
}

function printHelp() {
  console.log(`
Antigravity 多语言非破坏性启动器 (CDP 动态注入)

用法:
  node launcher/launch.mjs [选项]

选项:
  --app <路径>      手动指定 Antigravity 可执行文件路径（也可通过环境变量 ANTIGRAVITY_APP_PATH 指定）
  --port <端口>     指定 CDP 调试端口（默认 9222）
  --attach-only     仅附加到已开启调试端口的 Antigravity 实例，不启动新进程
  --rebuild         启动前强制重新构建 dist/i18n-runtime.js
  -h, --help        显示帮助信息
`);
}

function getNewestMtimeMs(dirPath) {
  let max = 0;
  if (!fs.existsSync(dirPath)) return max;
  const stack = [dirPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > max) max = mtime;
      }
    }
  }
  return max;
}

function isRuntimeBundleStale(runtimePath) {
  if (!fs.existsSync(runtimePath)) return true;
  const bundleMtime = fs.statSync(runtimePath).mtimeMs;
  const latestSrc = Math.max(
    getNewestMtimeMs(path.join(ROOT_DIR, 'locales')),
    getNewestMtimeMs(path.join(ROOT_DIR, 'engine')),
  );
  return latestSrc > bundleMtime;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const runtimePath = path.join(ROOT_DIR, 'dist', 'i18n-runtime.js');
  if (args.rebuild || isRuntimeBundleStale(runtimePath)) {
    console.log('[i18n] 检测到词库或引擎有更新，正在自动构建多语言运行时脚本...');
    buildBundle(ROOT_DIR);
  }
  const runtimeScript = fs.readFileSync(runtimePath, 'utf8');

  let child = null;
  if (!args.attachOnly) {
    const exePath = args.app || detectAntigravityExecutable();
    if (!exePath) {
      console.error('[ERROR] 未自动检测到 Antigravity 客户端，请通过 --app "<路径>" 指定可执行文件。');
      process.exit(1);
    }
    console.log(`[i18n] 启动 Antigravity: ${exePath}`);
    console.log(`[i18n] 远程调试端口: ${args.port} (仅监听本机 127.0.0.1)`);
    child = spawn(exePath, [`--remote-debugging-port=${args.port}`], {
      detached: false,
      stdio: 'ignore',
    });
    child.on('exit', (code) => {
      console.log(`[i18n] Antigravity 已退出 (code=${code ?? 0})。`);
      process.exit(0);
    });
  }

  console.log('[i18n] 等待客户端窗口就绪...');
  await waitForCdpTargets(args.port);

  const injectedTargets = new Set();
  const pollAndInject = async () => {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${args.port}/json/list`);
      for (const target of targets) {
        if (!target.webSocketDebuggerUrl) continue;
        if (target.type !== 'page' && target.type !== 'webview') continue;
        if (injectedTargets.has(target.id)) continue;

        try {
          await injectIntoTarget(target.webSocketDebuggerUrl, runtimeScript);
          injectedTargets.add(target.id);
          console.log(`[i18n] 已注入多语言引擎 -> ${target.title || target.url || target.id}`);
        } catch (err) {
          console.warn(`[i18n] 注入目标 ${target.id} 失败: ${err.message}`);
        }
      }
    } catch {
      if (args.attachOnly) {
        console.log('[i18n] 与 CDP 端口断开连接，退出监听。');
        process.exit(0);
      }
    }
  };

  await pollAndInject();
  console.log('[i18n] 多语言引擎运行中！可在 Antigravity 设置页或按 Ctrl+Shift+L 切换界面语言。');

  const timer = setInterval(pollAndInject, 2500);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  });
}
