#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[ERROR] 未检测到 Node.js (>=18)。"
  echo "[TIP] 请先安装 Node.js：https://nodejs.org/ 或运行 brew install node"
  echo ""
  read -r -p "按回车退出..." _
  exit 1
fi

node "$SCRIPT_DIR/scripts/cli.mjs" "$@"
