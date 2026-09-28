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
#
# Установка "копией" и автообновление
# ------------------------------------
# У этой установки нет NSIS и нет службы автообновления electron-updater -
# см. docs/superpowers/specs/2026-09-28-autoupdate-design.md, "Portable-сборка
# не обновляется electron-updater". Приложение, поставленное этим скриптом,
# может только уведомить о новой версии ссылкой на скачивание - само оно
# не обновится. Для автообновления сотрудникам нужен собранный установщик
# OpenMyChat-Enterprise-Setup-<version>.exe (см. docs/автообновление.md).
#
# -ServerUrl/-Channel - необязательные параметры этого скрипта: если заданы,
# он настраивает автообновление машины (client.json в ProgramData) через
# configure-client.ps1 - но это требует прав администратора, которых у
# установки "для себя" может не быть.

param(
    [string]$ServerUrl,
    [ValidateSet('stable', 'beta')]
    [string]$Channel
)

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

Write-Host ""
Write-Host "Внимание: это установка «копией», не через NSIS-установщик." -ForegroundColor Yellow
Write-Host "Приложение НЕ будет обновляться автоматически - оно лишь покажет" -ForegroundColor Yellow
Write-Host "уведомление о новой версии со ссылкой на скачивание. Для" -ForegroundColor Yellow
Write-Host "автообновления раздайте сотрудникам OpenMyChat-Enterprise-Setup-*.exe" -ForegroundColor Yellow
Write-Host "(см. docs/автообновление.md)." -ForegroundColor Yellow

# Настройка client.json (адрес сервера/канал обновлений) требует прав
# администратора, потому что каталог в ProgramData доступен на запись
# только им - см. configure-client.ps1. Установка "для себя" (эта - без
# UAC) их может не иметь, поэтому просто печатаем готовую команду для ИТ,
# а не молча пропускаем настройку.
$ConfigureScript = Join-Path $ScriptDir 'configure-client.ps1'
if (($ServerUrl -or $Channel) -and -not (Test-Path -LiteralPath $ConfigureScript)) {
    Write-Host ""
    Write-Host "Не найден $ConfigureScript - настройка автообновления пропущена." -ForegroundColor Yellow
    Write-Host "Положите configure-client.ps1 рядом с install.ps1 и запустите его отдельно." -ForegroundColor Yellow
} elseif ($ServerUrl -or $Channel) {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
               ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    $configArgs = @()
    if ($ServerUrl) { $configArgs += @('-ServerUrl', $ServerUrl) }
    if ($Channel) { $configArgs += @('-Channel', $Channel) }

    if ($isAdmin) {
        Write-Host ""
        Write-Host "Права администратора есть - настраиваю автообновление (client.json)..." -ForegroundColor Cyan
        try {
            & $ConfigureScript @configArgs
        } catch {
            # Установка приложения уже прошла успешно - сбой настройки
            # client.json (например, отказ в диалоге UAC для Root-хранилища
            # сертификата на другом шаге) не должен превращаться в общий
            # провал install.ps1.
            Write-Host "Настройка автообновления не удалась: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$ConfigureScript`""
        foreach ($a in $configArgs) { $cmd += " `"$a`"" }
        Write-Host ""
        Write-Host "Прав администратора нет - настройку автообновления (client.json) должен" -ForegroundColor Yellow
        Write-Host "выполнить ИТ-отдел от имени администратора:" -ForegroundColor Yellow
        Write-Host "  $cmd" -ForegroundColor Cyan
    }
}

try {
    $launch = Read-Host "Запустить сейчас? (y/n)"
    if ($launch -eq 'y') {
        Start-Process -FilePath $ExePath
    }
} catch {
    # Не интерактивный запуск (например, через удалённое развёртывание) -
    # просто пропускаем автозапуск, установка уже завершена успешно.
}
