# Устанавливает OpenMyChat Enterprise без NSIS-инсталлятора (Setup.exe).
# Просто копирует уже собранное приложение и создаёт ярлыки - никакого
# UAC.dll и прочих NSIS-плагинов тут нет, поэтому блокировка Smart App
# Control ("не удалось подтвердить издателя файла UAC.dll") здесь не
# срабатывает: этому конкретному триггеру просто неоткуда взяться.
#
# Само приложение (OpenMyChat Enterprise.exe) при первом запуске всё равно
# не подписано цифровой подписью - если Smart App Control включён в
# строгом режиме, он теоретически может проверить и его тоже. Этот скрипт
# решает именно ту проблему, которая уже наблюдалась (плагин установщика),
# а не гарантирует обход проверки для любого будущего сценария.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExeName = 'OpenMyChat Enterprise.exe'

# Ищем собранное приложение либо рядом со скриптом (для раздачи сотрудникам -
# просто кладём папку win-unpacked рядом с install.bat/install.ps1), либо
# внутри репозитория (для локального теста у разработчика).
$Candidates = @(
    (Join-Path $ScriptDir 'app'),
    (Join-Path $ScriptDir 'win-unpacked'),
    (Join-Path $ScriptDir '..\desktop\release\win-unpacked')
)
$SourceDir = $Candidates | Where-Object { Test-Path (Join-Path $_ $ExeName) } | Select-Object -First 1

if (-not $SourceDir) {
    Write-Host "Не найдена собранная папка приложения (ожидается 'app', 'win-unpacked' рядом со скриптом, или ..\desktop\release\win-unpacked)." -ForegroundColor Red
    Write-Host "Соберите приложение (npm run dist в папке desktop) и положите папку win-unpacked рядом с этим скриптом." -ForegroundColor Yellow
    exit 1
}

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\OpenMyChat Enterprise'

Write-Host "Устанавливаю OpenMyChat Enterprise в:`n  $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse -Force

$ExePath = Join-Path $InstallDir $ExeName

# Ярлыки на рабочем столе и в меню "Пуск" (установка на пользователя, без
# прав администратора - как и NSIS-версия с perMachine=false).
$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [Environment]::GetFolderPath('Desktop')
$ProgramsMenu = [Environment]::GetFolderPath('Programs')

foreach ($lnkPath in @(
    (Join-Path $Desktop 'OpenMyChat Enterprise.lnk'),
    (Join-Path $ProgramsMenu 'OpenMyChat Enterprise.lnk')
)) {
    $sc = $WshShell.CreateShortcut($lnkPath)
    $sc.TargetPath = $ExePath
    $sc.WorkingDirectory = $InstallDir
    $sc.IconLocation = $ExePath
    $sc.Description = 'OpenMyChat Enterprise Desktop Client'
    $sc.Save()
}

# Запись для "Установка и удаление программ" (по пользователю, HKCU - не
# требует прав администратора) - чтобы приложение можно было штатно удалить.
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenMyChatEnterprise'
New-Item -Path $UninstallKey -Force | Out-Null
Set-ItemProperty -Path $UninstallKey -Name 'DisplayName' -Value 'OpenMyChat Enterprise'
Set-ItemProperty -Path $UninstallKey -Name 'DisplayIcon' -Value $ExePath
Set-ItemProperty -Path $UninstallKey -Name 'InstallLocation' -Value $InstallDir
Set-ItemProperty -Path $UninstallKey -Name 'UninstallString' -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
Set-ItemProperty -Path $UninstallKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $UninstallKey -Name 'NoRepair' -Value 1 -Type DWord
Copy-Item -Path (Join-Path $ScriptDir 'uninstall.ps1') -Destination $InstallDir -Force -ErrorAction SilentlyContinue

Write-Host "`nГотово! Ярлык создан на рабочем столе и в меню Пуск." -ForegroundColor Green

try {
    $launch = Read-Host "Запустить сейчас? (y/n)"
    if ($launch -eq 'y') {
        Start-Process -FilePath $ExePath
    }
} catch {
    # Не интерактивный запуск (например, через удалённое развёртывание) -
    # просто пропускаем автозапуск, установка уже завершена успешно.
}
