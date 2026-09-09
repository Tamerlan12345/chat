$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\OpenMyChat Enterprise'
$Desktop = [Environment]::GetFolderPath('Desktop')
$ProgramsMenu = [Environment]::GetFolderPath('Programs')

Write-Host "Удаляю OpenMyChat Enterprise..." -ForegroundColor Cyan

Remove-Item -Path (Join-Path $Desktop 'OpenMyChat Enterprise.lnk') -Force
Remove-Item -Path (Join-Path $ProgramsMenu 'OpenMyChat Enterprise.lnk') -Force
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenMyChatEnterprise' -Force -Recurse

# Удаляем сам каталог с приложением последним и в отдельном процессе, т.к.
# этот скрипт сам может выполняться из этого же каталога (см. UninstallString
# в install.ps1) - PowerShell не может удалить папку, из которой сам запущен.
Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    "Start-Sleep -Seconds 1; Remove-Item -Path '$InstallDir' -Recurse -Force -ErrorAction SilentlyContinue"
) -WindowStyle Hidden

Write-Host "Готово." -ForegroundColor Green
