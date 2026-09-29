$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Ключ записи в «Установке и удалении программ» - прежний идентификатор (см.
# install.ps1). Папка установки берётся из него: установки «копией», сделанные
# до переименования в CentyChat, остались в Programs\OpenMyChat Enterprise.
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenMyChatEnterprise'
$InstallDir = (Get-ItemProperty -LiteralPath $UninstallKey).InstallLocation
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\CentyChat' }
$InstallPrefix = $InstallDir.TrimEnd('\') + '\'
$Desktop = [Environment]::GetFolderPath('Desktop')
$ProgramsMenu = [Environment]::GetFolderPath('Programs')

Write-Host "Удаляю CentyChat..." -ForegroundColor Cyan

# Ярлыки - новый и прежний («OpenMyChat Enterprise.lnk»), и только те, что
# ведут в эту папку: ярлык другой установки не трогаем.
$WshShell = New-Object -ComObject WScript.Shell
foreach ($dir in @($Desktop, $ProgramsMenu)) {
    foreach ($name in @('CentyChat.lnk', 'OpenMyChat Enterprise.lnk')) {
        $lnk = Join-Path $dir $name
        if (-not (Test-Path -LiteralPath $lnk)) { continue }
        $target = $WshShell.CreateShortcut($lnk).TargetPath
        if ($target -and $target.StartsWith($InstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $lnk -Force
        }
    }
}
Remove-Item -LiteralPath $UninstallKey -Force -Recurse

# Папка удаляется, только если это действительно папка приложения: адрес
# взят из реестра, и рекурсивное удаление чужой папки было бы непоправимо.
$isAppDir = (Test-Path -LiteralPath (Join-Path $InstallDir 'CentyChat.exe')) -or
            (Test-Path -LiteralPath (Join-Path $InstallDir 'OpenMyChat Enterprise.exe'))
if ($isAppDir) {
    # Удаляем сам каталог с приложением последним и в отдельном процессе, т.к.
    # этот скрипт сам может выполняться из этого же каталога (см. UninstallString
    # в install.ps1) - PowerShell не может удалить папку, из которой сам запущен.
    $quoted = $InstallDir -replace "'", "''"
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        "Start-Sleep -Seconds 1; Remove-Item -LiteralPath '$quoted' -Recurse -Force -ErrorAction SilentlyContinue"
    ) -WindowStyle Hidden
} else {
    Write-Host "В $InstallDir нет CentyChat.exe - папка не удалена." -ForegroundColor Yellow
}

Write-Host "Готово." -ForegroundColor Green
