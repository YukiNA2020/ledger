#!/bin/bash
# 小账本登录启动项安装脚本（Phase 2）
#
# 作用：写入 ~/Library/LaunchAgents/com.ledger.local.plist 并加载，
#      使 macOS 登录后自动启动本地服务并打开产品页。
#
# 这是一次系统级改动（修改用户的 LaunchAgents 与 launchd 状态）。
# 卸载：scripts/uninstall-login-item.sh
# 只查看不安装：node server/login-item.js print

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
  echo "未找到支持 node:sqlite 的 Node 运行时（需要 Node 22 以上）。"
  exit 1
}

echo "即将执行以下改动："
echo "  1. 写入 $HOME/Library/LaunchAgents/com.ledger.local.plist"
echo "  2. 通过 launchctl 加载该启动项（登录后自动启动本地服务）"
echo "  3. 使用的 Node：$NODE_BIN"
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

echo
"$NODE_BIN" server/login-item.js install --node "$NODE_BIN" --activate
echo
"$NODE_BIN" server/login-item.js status
echo
echo "完成。如需立即验证，请重启 Mac（或注销后重新登录），确认自动打开 http://127.0.0.1:8421/"
