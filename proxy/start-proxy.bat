@echo off
cd /d "%~dp0"
if not exist "config.json" (
  if exist "config.example.json" (
    copy /Y config.example.json config.json >nul
    echo 已根据 config.example.json 生成 config.json（请按需填入真实 key）
  )
)
where node >nul 2>nul
if %errorlevel%==0 (
  set NODE=node
) else if not defined NODE (
  echo 错误：未找到 node.exe。请把 Node 加入 PATH，或在运行前 set NODE=完整路径\node.exe
  pause
  exit /b 1
)
echo 启动 free-API 本地代理 (http://127.0.0.1:8787) ...
"%NODE%" proxy.js
echo 代理已退出。
pause
