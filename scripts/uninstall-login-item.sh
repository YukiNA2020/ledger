#!/bin/bash
# 小账本登录启动项卸载脚本（Phase 2）
#
# 作用：从 launchd 卸载 com.ledger.local 并删除其 plist 文件。
# 数据不受影响：~/Library/Application Support/Ledger 下的数据库与备份保持原样。

set -euo pipefail
cd "$(dirname "$0")/.."

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
  echo "未找到支持 node:sqlite 的 Node 运行时；将直接删除 plist 文件。"
  NODE_BIN=""
}

echo "即将执行以下改动："
echo "  1. 从 launchd 卸载 com.ledger.local（若已加载）"
echo "  2. 删除 $HOME/Library/LaunchAgents/com.ledger.local.plist"
echo "  数据库与备份不会被删除。"
echo
printf '确认继续？[y/N] '
read -r answer
case "$answer" in
  y | Y) ;;
  *)
    echo "已取消，未做任何改动。"
    exit 0
    ;;
esac

if [ -n "$NODE_BIN" ]; then
  "$NODE_BIN" server/login-item.js uninstall --activate
else
  rm -f "$HOME/Library/LaunchAgents/com.ledger.local.plist"
  echo "已删除 plist 文件。"
fi
echo "完成。"
