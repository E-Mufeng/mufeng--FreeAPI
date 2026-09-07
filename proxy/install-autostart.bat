@echo off
cd /d "%~dp0"
setlocal
set "VBS=%~dp0start-proxy-silent.vbs"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\free-api-proxy.lnk"

:: 1) 确保 config.json 存在（避免静默启动因缺配置而失败）
if not exist "%~dp0config.json" (
  if exist "%~dp0config.example.json" (
    copy /Y "%~dp0config.example.json" "%~dp0config.json" >nul
    echo [ok] 已根据 config.example.json 生成 config.json
  ) else (
    echo [错误] 缺少 config.json 且找不到 config.example.json，无法注册自启动。
    pause
    exit /b 1
  )
)

:: 2) 在「启动」文件夹创建指向静默启动器的快捷方式
if not exist "%STARTUP%" mkdir "%STARTUP%"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath='%VBS%'; $s.WorkingDirectory='%~dp0'; $s.Description='free-API 本地代理（开机自启）'; $s.WindowStyle=7; $s.Save()"

if exist "%LNK%" (
  echo [ok] 已注册开机自启动：%LNK%
  echo       下次登录后代理将于后台静默运行（http://127.0.0.1:8787）。
  echo       撤销请运行本目录下的 uninstall-autostart.bat
) else (
  echo [错误] 快捷方式创建失败，请检查权限后重试。
  pause
  exit /b 1
)
endlocal
