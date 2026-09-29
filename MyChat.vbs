Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
desktopDir = baseDir & "\desktop"
serverDir = baseDir & "\server"
builtExe = desktopDir & "\release\win-unpacked\CentyChat.exe"

' 1. Check if server is running; if not, start it silently in background
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.Open "GET", "http://localhost:2004/health", False
http.Send
If Err.Number <> 0 Or http.Status <> 200 Then
    WshShell.CurrentDirectory = serverDir
    WshShell.Run "node src\index.js", 0, False
    WScript.Sleep 1500
End If
On Error GoTo 0

' 2. Launch native desktop application form silently
If fso.FileExists(builtExe) Then
    WshShell.CurrentDirectory = desktopDir & "\release\win-unpacked"
    WshShell.Run """" & builtExe & """", 1, False
Else
    WshShell.CurrentDirectory = desktopDir
    WshShell.Run "node node_modules\electron\cli.js .", 0, False
End If
