# Устанавливает CentyChat без NSIS-инсталлятора (Setup.exe).
# Просто копирует уже собранное приложение и создаёт ярлыки - никакого
# UAC.dll и прочих NSIS-плагинов тут нет, поэтому блокировка Smart App
# Control ("не удалось подтвердить издателя файла UAC.dll") здесь не
# срабатывает: этому конкретному триггеру просто неоткуда взяться.
#
# Само приложение (CentyChat.exe) при первом запуске всё равно
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
# CentyChat-Setup-<version>.exe (см. docs/автообновление.md).
#
# Переименование в CentyChat (1.1.0)
# ----------------------------------
# Раньше приложение называлось «OpenMyChat Enterprise»: exe «OpenMyChat
# Enterprise.exe», ярлыки «OpenMyChat Enterprise.lnk», папка
# Programs\OpenMyChat Enterprise. Установка «копией», сделанная раньше,
# обновляется на месте: та же папка (её адрес хранит запись в «Установке и
# удалении программ»), а прежние exe и ярлыки убираются - иначе по старому
# ярлыку запускалась бы прежняя версия. Данные сотрудника лежат не здесь, а в
# %APPDATA%\mychat-desktop, и этот скрипт их не трогает.
#
# Если приложение уже стоит через Setup.exe, скрипт отказывается ставить
# вторую копию и предлагает обновить его установщиком. Обратный случай
# (Setup.exe поверх копии 1.0.0) разбирает сам установщик, см.
# desktop/build/installer.nsh. Проверки папок, закрытие приложения и удаление -
# в copy-install-common.ps1 (его подключают и install.ps1, и uninstall.ps1).
#
# -ServerUrl/-Channel - необязательные параметры этого скрипта: если заданы,
# он настраивает машину (политика реестра HKLM\SOFTWARE\Policies\CentyChat)
# через configure-client.ps1 - но это требует прав администратора, которых у
# установки "для себя" может не быть.

param(
    [string]$ServerUrl,
    [ValidateSet('stable', 'beta')]
    [string]$Channel
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExeName = 'CentyChat.exe'
$ShortcutName = 'CentyChat.lnk'
# Имена до переименования - только чтобы убрать их за собой.
$LegacyExeName = 'OpenMyChat Enterprise.exe'
$LegacyShortcutName = 'OpenMyChat Enterprise.lnk'
# Ключ записи в «Установке и удалении программ» - идентификатор: по нему
# uninstall.ps1 и повторный запуск этого скрипта находят установку. С
# переименованием в CentyChat не менялся (показываемое имя - DisplayName).
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenMyChatEnterprise'

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

$CommonScript = Join-Path $ScriptDir 'copy-install-common.ps1'
if (-not (Test-Path -LiteralPath $CommonScript)) {
    Write-Host "Не найден $CommonScript - положите его рядом с install.ps1 (он входит в папку installer)." -ForegroundColor Red
    exit 1
}
. $CommonScript

# Если приложение уже стоит через Setup.exe (это видно по записи NSIS в
# реестре), вторую копию рядом не ставим: у них общий профиль сотрудника, и
# запущенной оказалась бы только одна - какая, решал бы случай. Поверх папки
# NSIS тоже не пишем: её деинсталлятор и автообновление рассчитывают на свои
# файлы. Обновлять такую установку - установщиком Setup.exe.
$NsisDir = Get-CentyChatNsisInstall
if ($NsisDir) {
    Write-Host "CentyChat уже установлен на этом компьютере установщиком Setup.exe:" -ForegroundColor Red
    Write-Host "  $NsisDir" -ForegroundColor Red
    Write-Host "Установка «копией» рядом не выполняется - получились бы две копии приложения." -ForegroundColor Yellow
    Write-Host "Обновите его установщиком CentyChat-Setup-<версия>.exe (или дождитесь автообновления)." -ForegroundColor Yellow
    Write-Host "Если Setup.exe на этом компьютере запустить нельзя, сначала удалите приложение" -ForegroundColor Yellow
    Write-Host "через «Установку и удаление программ», затем запустите install.bat снова." -ForegroundColor Yellow
    exit 1
}

# Новая установка - в Programs\CentyChat; уже стоящая «копией» (в том числе
# прежняя, в Programs\OpenMyChat Enterprise) обновляется в своей папке. Адрес
# из реестра принимается, только если это папка приложения в
# %LOCALAPPDATA%\Programs (Test-CentyChatCopyDir): uninstall.ps1 удаляет её
# целиком, и неверный адрес в записи не должен стать поводом стереть чужое.
$ProgramsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
$InstallDir = Join-Path $ProgramsRoot 'CentyChat'
$PreviousDir = (Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue).InstallLocation
if ($PreviousDir) {
    if (Test-CentyChatCopyDir -Path $PreviousDir -ProgramsRoot $ProgramsRoot) {
        $InstallDir = [IO.Path]::GetFullPath($PreviousDir).TrimEnd('\')
    } else {
        Write-Host "Запись прежней установки указывает на «$PreviousDir» - это не папка приложения, она не используется." -ForegroundColor Yellow
    }
}

Write-Host "Устанавливаю CentyChat в:`n  $InstallDir" -ForegroundColor Cyan

# Запущенное из этой папки приложение закрывается до копирования, как это
# делает и Setup.exe: иначе копирование оборвётся на занятых файлах.
if ((Test-Path -LiteralPath $InstallDir) -and -not (Stop-CentyChatCopyApp -Dir $InstallDir)) {
    Write-Host "Приложение в $InstallDir не закрывается - закройте его вручную и запустите установку снова." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse -Force

$ExePath = Join-Path $InstallDir $ExeName

# Прежний exe рядом с новым не оставляем: по старому ярлыку или закреплению
# на панели задач запускалась бы прежняя версия.
$LegacyExePath = Join-Path $InstallDir $LegacyExeName
if (Test-Path -LiteralPath $LegacyExePath) {
    try {
        Remove-Item -LiteralPath $LegacyExePath -Force
    } catch {
        Write-Host "Не удалось удалить прежний $LegacyExeName (приложение ещё запущено?) - закройте его и запустите установку снова." -ForegroundColor Yellow
    }
}

# Ярлыки на рабочем столе и в меню "Пуск" (установка на пользователя, без
# прав администратора - как и NSIS-версия с perMachine=false).
$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [Environment]::GetFolderPath('Desktop')
$ProgramsMenu = [Environment]::GetFolderPath('Programs')
$InstallPrefix = $InstallDir.TrimEnd('\') + '\'

foreach ($dir in @($Desktop, $ProgramsMenu)) {
    # Прежний ярлык убирается, только если ведёт в эту же папку: ярлык другой
    # установки (например, NSIS-версии 1.0.0) не трогаем.
    $legacyLnk = Join-Path $dir $LegacyShortcutName
    if (Test-Path -LiteralPath $legacyLnk) {
        $legacyTarget = $WshShell.CreateShortcut($legacyLnk).TargetPath
        if ($legacyTarget -and $legacyTarget.StartsWith($InstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $legacyLnk -Force
        }
    }

    $sc = $WshShell.CreateShortcut((Join-Path $dir $ShortcutName))
    $sc.TargetPath = $ExePath
    $sc.WorkingDirectory = $InstallDir
    $sc.IconLocation = $ExePath
    $sc.Description = 'CentyChat Desktop Client'
    $sc.Save()
}

# Запись для "Установка и удаление программ" (по пользователю, HKCU - не
# требует прав администратора) - чтобы приложение можно было штатно удалить.
New-Item -Path $UninstallKey -Force | Out-Null
Set-ItemProperty -Path $UninstallKey -Name 'DisplayName' -Value 'CentyChat'
Set-ItemProperty -Path $UninstallKey -Name 'DisplayIcon' -Value $ExePath
Set-ItemProperty -Path $UninstallKey -Name 'InstallLocation' -Value $InstallDir
Set-ItemProperty -Path $UninstallKey -Name 'UninstallString' -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
Set-ItemProperty -Path $UninstallKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $UninstallKey -Name 'NoRepair' -Value 1 -Type DWord
Copy-Item -LiteralPath (Join-Path $ScriptDir 'uninstall.ps1') -Destination $InstallDir -Force
Copy-Item -LiteralPath $CommonScript -Destination $InstallDir -Force

# Автозапуск (значение с именем AppUserModelId, его пишет само приложение):
# если он был включён, он указывал на прежний exe. Приложение поправит путь
# при следующем запуске, но до него вход в Windows запускал бы удалённый файл.
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ((Get-ItemProperty -LiteralPath $RunKey -ErrorAction SilentlyContinue).'com.openmychat.desktop') {
    Set-ItemProperty -LiteralPath $RunKey -Name 'com.openmychat.desktop' -Value "`"$ExePath`" --autostart"
}

Write-Host "`nГотово! Ярлык создан на рабочем столе и в меню Пуск." -ForegroundColor Green

Write-Host ""
Write-Host "Внимание: это установка «копией», не через NSIS-установщик." -ForegroundColor Yellow
Write-Host "Приложение НЕ будет обновляться автоматически - оно лишь покажет" -ForegroundColor Yellow
Write-Host "уведомление о новой версии со ссылкой на скачивание. Для" -ForegroundColor Yellow
Write-Host "автообновления раздайте сотрудникам CentyChat-Setup-*.exe" -ForegroundColor Yellow
Write-Host "(см. docs/автообновление.md)." -ForegroundColor Yellow

# Политика машины (адрес сервера/канал обновлений) пишется в
# HKLM\SOFTWARE\Policies\CentyChat - это могут только
# администраторы, см. configure-client.ps1. Установка "для себя" (эта - без
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

    # Хэш-таблица, а не массив: при splatting массива строка '-ServerUrl'
    # уходит в скрипт позиционным значением, а не именем параметра.
    $configArgs = @{}
    if ($ServerUrl) { $configArgs['ServerUrl'] = $ServerUrl }
    if ($Channel) { $configArgs['Channel'] = $Channel }

    if ($isAdmin) {
        Write-Host ""
        Write-Host "Права администратора есть - записываю политику машины (HKLM\SOFTWARE\Policies\CentyChat)..." -ForegroundColor Cyan
        try {
            $global:LASTEXITCODE = 0
            & $ConfigureScript @configArgs
            if ($LASTEXITCODE) {
                Write-Host "Настройка политики машины завершилась с кодом $LASTEXITCODE - см. сообщение выше." -ForegroundColor Red
            }
        } catch {
            # Установка приложения уже прошла успешно - сбой настройки
            # политики не должен превращаться в общий провал install.ps1.
            Write-Host "Настройка автообновления не удалась: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$ConfigureScript`""
        foreach ($name in $configArgs.Keys) { $cmd += " -$name `"$($configArgs[$name])`"" }
        Write-Host ""
        Write-Host "Прав администратора нет - политику машины (HKLM\SOFTWARE\Policies\CentyChat)" -ForegroundColor Yellow
        Write-Host "должен записать ИТ-отдел от имени администратора (или групповой политикой):" -ForegroundColor Yellow
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
