' free-API 本地代理 — 静默启动器（供开机自启动使用）
' 隐藏窗口、脱离终端运行 node proxy.js；无控制台日志，便于后台常驻。
Option Explicit
Dim sh, fso, nodeExe, managedNode, scriptDir, proxyJs, ret
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
proxyJs = fso.BuildPath(scriptDir, "proxy.js")

' 解析 node：优先 NODE_EXE 环境变量，其次 PATH，最后回退到 WorkBuddy 托管 node（按版本号自动探测）
Dim nodeFromEnv
nodeFromEnv = sh.ExpandEnvironmentStrings("%NODE_EXE%")
If nodeFromEnv <> "%NODE_EXE%" And fso.FileExists(nodeFromEnv) Then
  nodeExe = nodeFromEnv
Else
  ret = sh.Run("cmd /c where node >nul 2>nul", 0, True)
  If ret = 0 Then
    nodeExe = "node"
  Else
    managedNode = sh.BuildPath(sh.ExpandEnvironmentStrings("%USERPROFILE%"), _
      ".workbuddy\binaries\node\versions\22.22.2-2\node.exe")
    nodeExe = managedNode
  End If
End If

If Not fso.FileExists(nodeExe) Then
  WScript.Echo "未找到 node：" & nodeExe & vbCrLf & "请先安装 Node.js 或确认 WorkBuddy 托管 node 路径。"
  WScript.Quit 1
End If

' 窗口样式 0 = 隐藏；最后一个参数 False = 不等待（脱离终端常驻）
sh.Run """" & nodeExe & """ """ & proxyJs & """", 0, False
