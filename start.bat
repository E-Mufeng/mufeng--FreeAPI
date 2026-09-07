@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo  Free API 工作台 · 本地代理启动器
echo ========================================
echo  注意：不要直接双击 index.html 打开！
echo  必须通过本代理访问：http://127.0.0.1:8787/
echo ========================================
echo  正在启动代理...
start /b node proxy/proxy.js > proxy.log 2>&1
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /format:list') do set DATETIME=%%I
set LOG_STARTED=%DATETIME:~0,4%-%DATETIME:~4,2%-%DATETIME:~6,2% %DATETIME:~8,2%:%DATETIME:~10,2%
echo [%LOG_STARTED%] 代理已尝试启动，日志写入 proxy.log
timeout /t 2 /nobreak >nul
echo  正在打开浏览器...
start "" "http://127.0.0.1:8787/"
echo  浏览器已打开。关闭本窗口将停止代理服务。
echo ========================================
pause
endlocal
