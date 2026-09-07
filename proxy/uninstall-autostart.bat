@echo off
setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\free-api-proxy.lnk"

if exist "%LNK%" (
  del /F "%LNK%"
  echo [ok] 已移除开机自启动快捷方式：%LNK%
) else (
  echo [信息] 未发现自启动快捷方式，无需操作。
)
echo 提示：这只会取消“开机自动启动”，不会关闭当前已在运行的代理进程。
echo       如需立即关闭代理，请结束任务管理器中的 node.exe（proxy.js）。
endlocal
