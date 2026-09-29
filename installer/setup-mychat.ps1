# PowerShell Installer & Shortcut Wizard for CentyChat
# (the file keeps its old name setup-mychat.ps1: other docs refer to it)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Split-Path -Parent $ScriptDir
$DesktopPath = [Environment]::GetFolderPath("Desktop")

$WshShell = New-Object -ComObject WScript.Shell

# 0. Remove shortcuts this wizard created before the rename to CentyChat, so
#    the desktop does not end up with two of each. Only ours: a shortcut with
#    the same name that points elsewhere (e.g. the commercial MyChat client)
#    is left alone.
foreach ($legacy in @('MyChat Enterprise.lnk', 'MyChat Web Console.lnk')) {
    $legacyPath = Join-Path $DesktopPath $legacy
    if (-not (Test-Path -LiteralPath $legacyPath)) { continue }
    $old = $WshShell.CreateShortcut($legacyPath)
    if ($old.Arguments -like '*launch.vbs*' -or $old.TargetPath -like 'http://localhost:2004/admin*') {
        Remove-Item -LiteralPath $legacyPath -Force
        Write-Host "[OK] Old shortcut removed: $legacy" -ForegroundColor Green
    }
}

# 1. Create Desktop Shortcut for CentyChat Client (Silent Launch, No CMD window)
$ClientShortcut = $WshShell.CreateShortcut("$DesktopPath\CentyChat.lnk")
$ClientShortcut.TargetPath = "wscript.exe"
$ClientShortcut.Arguments = "`"$ScriptDir\launch.vbs`""
$ClientShortcut.WorkingDirectory = "$BaseDir"
$ClientShortcut.Description = "CentyChat Client"
$ClientShortcut.Save()
Write-Host "[OK] Desktop shortcut created: CentyChat.lnk" -ForegroundColor Green

# 2. Create Desktop Shortcut for Server Web Management
$ServerShortcut = $WshShell.CreateShortcut("$DesktopPath\CentyChat Web Console.lnk")
$ServerShortcut.TargetPath = "http://localhost:2004/admin"
$ServerShortcut.Description = "CentyChat Web Console"
$ServerShortcut.Save()
Write-Host "[OK] Desktop shortcut created: CentyChat Web Console.lnk" -ForegroundColor Green
