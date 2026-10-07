#!/usr/bin/env bash
# 启动 zen-claude-relay（macOS / Linux）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node 18+：https://nodejs.org" >&2
  exit 1
fi

if [ ! -f config.json ]; then
  echo "还没配置过。先跑一次向导："
  echo "    node setup.mjs"
  echo ""
  echo "（或者把 config.example.json 复制成 config.json 自己改）"
  exit 1
fi

exec node proxy.mjs "$@"
