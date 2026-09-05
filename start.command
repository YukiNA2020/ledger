#!/bin/bash
# 小账本一键启动：本地静态服务 + 打开浏览器（macOS 双击运行）
# 隐私说明：仅在本机启动 http 服务加载静态文件，应用本身零外联网络请求。

cd "$(dirname "$0")"

PORT=8421
# 端口被占用时（上次未正常退出）直接复用
if ! lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "启动本地服务: http://localhost:$PORT"
  python3 -m http.server $PORT >/dev/null 2>&1 &
  SERVER_PID=$!
  trap "kill $SERVER_PID 2>/dev/null" EXIT
  sleep 1
else
  echo "复用已在运行的服务: http://localhost:$PORT"
fi

open "http://localhost:$PORT"
echo ""
echo "小账本已在浏览器打开。关闭此终端窗口即可停止本地服务。"
echo "数据保存在浏览器 IndexedDB 中（与本终端无关）。"
wait
