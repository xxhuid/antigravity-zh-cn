#!/usr/bin/env node
/**
 * Optional Installer for the Bundled Antigravity Agent Chinese Workflow Plugin
 * Copies ./agent-plugin/ into:
 *   - Global (default): ~/.gemini/config/plugins/antigravity-zh-cn
 *   - Workspace (--workspace <dir>): <dir>/.agents/plugins/antigravity-zh-cn
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT_DIR, 'agent-plugin');
const PLUGIN_DIR_NAME = 'antigravity-zh-cn';

function parseArgs(argv) {
  const args = { workspace: '', uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) args.workspace = argv[++i];
    else if (argv[i] === '--uninstall') args.uninstall = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDir = args.workspace
    ? path.resolve(args.workspace, '.agents', 'plugins', PLUGIN_DIR_NAME)
    : path.join(os.homedir(), '.gemini', 'config', 'plugins', PLUGIN_DIR_NAME);

  if (args.uninstall) {
    if (!fs.existsSync(targetDir)) {
      console.log(`[INFO] 未找到已安装的 Agent 插件: ${targetDir}`);
      return;
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`[OK] 已卸载 Agent 中文工作流插件: ${targetDir}`);
    return;
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(SOURCE_DIR, targetDir, { recursive: true, force: true });
  console.log(`[OK] 已安装 Agent 中文工作流插件至: ${targetDir}`);
  console.log('[INFO] 打开 Antigravity -> Skills & Customizations 即可查看并开关该插件。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
