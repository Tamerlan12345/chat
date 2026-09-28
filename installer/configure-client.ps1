#Requires -RunAsAdministrator
# Настраивает машину для автообновления OpenMyChat Enterprise: пишет
# %ProgramData%\OpenMyChat Enterprise\client.json, который собранное
# приложение читает при старте (desktop/src/main/client-config.js) -
# адрес сервера и канал обновлений, без переменных окружения и без
# пользовательского файла (см. docs/superpowers/specs/2026-09-28-autoupdate-design.md,
# раздел «Клиентский файл машины»).
#
# Почему нужны права администратора
# ----------------------------------
# ProgramData общий на всех пользователей компьютера, а client.json задаёт,
# на какой сервер ходит приложение и включено ли автообновление. Если бы
# любой пользователь мог его переписать, он мог бы перенаправить чужой
# клиент на подложный сервер или тихо выключить проверку подписи
# обновлений у себя. Поэтому каталог создаётся с ACL, где обычные
# пользователи (S-1-5-32-545) могут только читать и выполнять (RX), а
# писать могут лишь администраторы (S-1-5-32-544) и система (S-1-5-18).
#
# Запуск:
#   configure-client.ps1 -ServerUrl https://chat.company.kz [-Channel stable|beta] [-DisableUpdates]
#   настроить-клиент.bat (тот же скрипт, для тех, кто не любит PowerShell)

param(
    [string]$ServerUrl,
    [ValidateSet('stable', 'beta')]
    [string]$Channel,
    [switch]$DisableUpdates
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Явная проверка https - та же, что и в isAllowedServerUrl на клиенте
# (desktop/src/main/server-url.js): адрес без TLS означает, что и сам чат, и
# обновления ходят открытым текстом, а мы полагаемся на https для того,
# чтобы клиент вообще мог доверять серверу.
if ($ServerUrl -and $ServerUrl -notmatch '^https://') {
    Write-Host "ОТКАЗ: -ServerUrl должен начинаться с https:// (получено: $ServerUrl)" -ForegroundColor Red
    Write-Host "Обновления и синхронизация по http не поддерживаются - см. docs/автообновление.md." -ForegroundColor Yellow
    exit 2
}

$ConfigDir = Join-Path $env:ProgramData 'OpenMyChat Enterprise'
$ConfigPath = Join-Path $ConfigDir 'client.json'

if (-not (Test-Path -LiteralPath $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}

# Сбрасываем унаследованные права и ставим ровно три записи: Администраторы
# и SYSTEM - полный доступ, обычные пользователи - только чтение и
# выполнение. /inheritance:r отключает наследование от %ProgramData%,
# иначе туда попали бы более широкие права, унаследованные сверху.
$icaclsArgs = @(
    $ConfigDir,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-32-544:(OI)(CI)F',
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-545:(OI)(CI)RX'
)
$icaclsOutput = & icacls @icaclsArgs 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Не удалось настроить права доступа на $ConfigDir" -ForegroundColor Red
    Write-Host ($icaclsOutput -join "`n") -ForegroundColor Red
    exit 1
}
Write-Host "Права доступа на $ConfigDir настроены (администраторы и SYSTEM - полный доступ, остальные - только чтение)." -ForegroundColor Green

# Сливаем с уже существующим файлом, а не перезаписываем его целиком: на
# машине мог быть, например, ключ, добавленный вручную ИТ-отделом или
# будущей версией клиента, который этот скрипт ещё не знает. Такие ключи
# сохраняются как есть - и на верхнем уровне, и внутри "updates".
$existing = $null
if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $raw = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
        if ($raw) { $existing = $raw | ConvertFrom-Json }
    } catch {
        Write-Host "Существующий client.json повреждён и будет пересоздан: $($_.Exception.Message)" -ForegroundColor Yellow
        $existing = $null
    }
}

# ConvertFrom-Json даёт PSCustomObject - собираем обычный Hashtable, чтобы
# было удобно проверять и дописывать ключи, включая неизвестные скрипту.
$result = [ordered]@{}
if ($existing) {
    foreach ($prop in $existing.PSObject.Properties) {
        $result[$prop.Name] = $prop.Value
    }
}

if ($ServerUrl) {
    $result['serverUrl'] = $ServerUrl
} elseif (-not $result.Contains('serverUrl')) {
    $result['serverUrl'] = $null
}

$existingUpdates = [ordered]@{}
if ($result.Contains('updates') -and $result['updates']) {
    foreach ($prop in $result['updates'].PSObject.Properties) {
        $existingUpdates[$prop.Name] = $prop.Value
    }
}
if (-not $existingUpdates.Contains('enabled')) { $existingUpdates['enabled'] = $true }
if (-not $existingUpdates.Contains('channel')) { $existingUpdates['channel'] = 'stable' }

if ($Channel) { $existingUpdates['channel'] = $Channel }
if ($DisableUpdates) { $existingUpdates['enabled'] = $false }

$result['updates'] = $existingUpdates

$json = $result | ConvertTo-Json -Depth 10

# UTF-8 без BOM: собранное приложение читает файл через node:fs, и BOM в
# начале JSON ломает JSON.parse ("Unexpected token"). New-Item/Set-Content
# в Windows PowerShell 5.1 по умолчанию пишут BOM - поэтому запись только
# через File.WriteAllText с явной кодировкой без BOM.
[System.IO.File]::WriteAllText($ConfigPath, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "Записан $ConfigPath :" -ForegroundColor Cyan
Write-Host $json
Write-Host ""
Write-Host "Готово. Перезапустите OpenMyChat Enterprise на этой машине, чтобы изменения применились." -ForegroundColor Green
