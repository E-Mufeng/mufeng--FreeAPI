#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "========================================"
echo " Free API 工作台 · 本地代理启动器"
echo "========================================"
echo " 注意：不要直接双击 index.html 打开！"
echo " 必须通过本代理访问：http://127.0.0.1:8787/"
echo "========================================"
echo " 正在启动代理..."
node proxy/proxy.js > proxy.log 2>&1 &
PID=$!
echo " [$(date '+%Y-%m-%d %H:%M:%S')] 代理已启动（PID $PID），日志写入 proxy.log"
sleep 2
echo " 正在打开浏览器..."
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:8787/"
elif command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:8787/"
else
  echo " 无法自动打开浏览器，请手动访问 http://127.0.0.1:8787/"
fi
echo " 浏览器已打开。按回车停止代理服务。"
read -r
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
