# Удаляет установку «копией» (install.ps1). Запускается из записи в
# «Установке и удалении программ» - из папки установки, куда install.ps1
# кладёт его вместе с copy-install-common.ps1.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$CommonScript = Join-Path $PSScriptRoot 'copy-install-common.ps1'
if (-not (Test-Path -LiteralPath $CommonScript)) {
    Write-Host "Не найден $CommonScript - удаление не выполнено." -ForegroundColor Red
    exit 1
}
. $CommonScript

# Ключ записи в «Установке и удалении программ» - прежний идентификатор (см.
# install.ps1). Папка берётся из него, а если адрес там не годится - та, где
# лежит сам скрипт. Любой из них принимается, только если это папка
# приложения в %LOCALAPPDATA%\Programs (Test-CentyChatCopyDir): она
# удаляется целиком, и неверный адрес не должен стать поводом стереть чужое.
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenMyChatEnterprise'
$ProgramsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
$InstallDir = $null
foreach ($candidate in @((Get-ItemProperty -LiteralPath $UninstallKey).InstallLocation, $PSScriptRoot)) {
    if ($candidate -and (Test-CentyChatCopyDir -Path $candidate -ProgramsRoot $ProgramsRoot)) {
        $InstallDir = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        break
    }
}
if (-not $InstallDir) {
    Write-Host "Не найдена папка установки CentyChat в $ProgramsRoot - удаление не выполнено." -ForegroundColor Red
    exit 1
}
$InstallPrefix = $InstallDir + '\'
$Desktop = [Environment]::GetFolderPath('Desktop')
$ProgramsMenu = [Environment]::GetFolderPath('Programs')

Write-Host "Удаляю CentyChat из $InstallDir..." -ForegroundColor Cyan

if (-not (Stop-CentyChatCopyApp -Dir $InstallDir)) {
    Write-Host "Приложение не закрывается - закройте его вручную и запустите удаление снова." -ForegroundColor Red
    exit 1
}

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

# Автозапуск - только если он ведёт в эту папку.
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runCommand = (Get-ItemProperty -LiteralPath $RunKey).'com.openmychat.desktop'
if ($runCommand -and $runCommand.TrimStart('"').StartsWith($InstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-ItemProperty -LiteralPath $RunKey -Name 'com.openmychat.desktop'
}

Remove-Item -LiteralPath $UninstallKey -Force -Recurse

# Саму папку удаляет отдельный процесс, когда этот скрипт завершится: он
# может выполняться из неё же, а PowerShell не удалит папку, из которой
# запущен. Путь передаётся через переменные окружения, а не вклеивается в
# команду, - кавычки и другие особые символы в пути ничего не сломают.
# Дочерний процесс ещё раз проверяет папку и удаляет её, не заходя в точки
# соединения (Remove-CentyChatCopyDir).
$env:CENTYCHAT_UNINSTALL_DIR = $InstallDir
$env:CENTYCHAT_UNINSTALL_ROOT = $ProgramsRoot
$env:CENTYCHAT_COPY_COMMON = $CommonScript
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Start-Sleep -Seconds 1; . $env:CENTYCHAT_COPY_COMMON; if (Test-CentyChatCopyDir -Path $env:CENTYCHAT_UNINSTALL_DIR -ProgramsRoot $env:CENTYCHAT_UNINSTALL_ROOT) { [void](Remove-CentyChatCopyDir -Path $env:CENTYCHAT_UNINSTALL_DIR) }'
)

Write-Host "Готово." -ForegroundColor Green
