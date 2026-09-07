Option Explicit
Dim sh, fso, desk, proxyDir, lnk
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
proxyDir = fso.GetParentFolderName(WScript.ScriptFullName)
desk = sh.SpecialFolders("Desktop")
If desk = "" Then desk = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\Desktop"
Set lnk = sh.CreateShortcut(fso.BuildPath(desk, "free-api-proxy.lnk"))
lnk.TargetPath = fso.BuildPath(proxyDir, "start-proxy.bat")
lnk.WorkingDirectory = proxyDir
lnk.Description = "free-API 本地代理（双击启动，显示日志）"
lnk.WindowStyle = 1
lnk.Save()
WScript.Echo "created: " & lnk.FullName
