# PowerShell Installer & Shortcut Wizard for MyChat Enterprise
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Split-Path -Parent $ScriptDir
$DesktopPath = [Environment]::GetFolderPath("Desktop")

# 1. Create Desktop Shortcut for MyChat Client (Silent Launch, No CMD window)
$WshShell = New-Object -ComObject WScript.Shell
$ClientShortcut = $WshShell.CreateShortcut("$DesktopPath\MyChat Enterprise.lnk")
$ClientShortcut.TargetPath = "wscript.exe"
$ClientShortcut.Arguments = "`"$ScriptDir\launch.vbs`""
$ClientShortcut.WorkingDirectory = "$BaseDir"
$ClientShortcut.Description = "MyChat Client 2026"
$ClientShortcut.Save()
Write-Host "[OK] Desktop shortcut created: MyChat Enterprise.lnk" -ForegroundColor Green

# 2. Create Desktop Shortcut for Server Web Management
$ServerShortcut = $WshShell.CreateShortcut("$DesktopPath\MyChat Web Console.lnk")
$ServerShortcut.TargetPath = "http://localhost:2004/admin"
$ServerShortcut.Description = "MyChat Enterprise Web Console"
$ServerShortcut.Save()
Write-Host "[OK] Desktop shortcut created: MyChat Web Console.lnk" -ForegroundColor Green
