#!/bin/bash
# 小账本一键启动（Phase 2）：启动本地服务（仅 127.0.0.1）并打开浏览器
#
# 事实源：SQLite，位于 ~/Library/Application Support/Ledger/ledger.db
# 长期使用请安装登录项（登录后自动启动）：scripts/install-login-item.sh
# 本脚本把服务跑在前台，Ctrl+C 即停止；日志同时写入数据目录的 logs/server.log。

set -u
cd "$(dirname "$0")"

find_node() {
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node/bin/node "$(command -v node 2>/dev/null)"; do
    if [ -n "${candidate:-}" ] && [ -x "$candidate" ] && "$candidate" -e "require('node:sqlite')" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node)" || {
  echo "未找到支持 node:sqlite 的 Node 运行时（需要 Node 22 以上）。"
  echo "安装后重试，或直接指定：node server/main.js"
  exit 1
}

echo "使用 Node：$NODE_BIN"
echo "启动本地服务（仅监听 127.0.0.1）…"
exec "$NODE_BIN" server/main.js "$@"
