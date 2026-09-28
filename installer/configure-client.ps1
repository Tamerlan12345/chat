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
# Каталог мог существовать до этого скрипта (там же лежит policy.json от
# rd-consent.js) и мог быть создан обычным пользователем - тогда владелец
# каталога он, и владелец может переписать ACL себе обратно, каким бы
# строгим он ни был. Поэтому сначала переносим владение на администраторов
# (/setowner /T - и каталог, и всё, что уже внутри), потом ставим ACL с /T,
# чтобы он докатился и до уже лежащих файлов, а не только до новых. И
# отдельно, уже после записи client.json, закрепляем ACL на самом файле и
# проверяем результат Get-Acl - не полагаясь на то, что /T каталога
# идеально дотянулся до файла, который мы только что перезаписали.
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

# Get-MyChatDangerousAcl — отдельным файлом, а не функцией здесь же, чтобы
# её можно было прогнать напрямую в тесте (реальный Get-Acl на реальном
# файле), а не только проверить текстом.
. (Join-Path $PSScriptRoot 'acl-guard.ps1')

# Явная проверка https - та же, что и в isAllowedServerUrl на клиенте
# (desktop/src/main/server-url.js): адрес без TLS означает, что и сам чат, и
# обновления ходят открытым текстом, а мы полагаемся на https для того,
# чтобы клиент вообще мог доверять серверу.
if ($ServerUrl -and $ServerUrl -notmatch '^https://') {
    Write-Host "ОТКАЗ: -ServerUrl должен начинаться с https:// (получено: $ServerUrl)" -ForegroundColor Red
    Write-Host "Обновления и синхронизация по http не поддерживаются - см. docs/автообновление.md." -ForegroundColor Yellow
    exit 2
}

# Запускает icacls и сверяет $LASTEXITCODE - icacls не бросает исключение
# при ошибке (это внешний процесс), поэтому без явной проверки скрипт
# продолжил бы работу с ACL, которую на самом деле не удалось поставить.
function Invoke-MyChatIcacls {
    param(
        [Parameter(Mandatory)]
        [string[]]$IcaclsArgs,
        [Parameter(Mandatory)]
        [string]$FailureMessage
    )
    $output = & icacls @IcaclsArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host $FailureMessage -ForegroundColor Red
        Write-Host ($output -join "`n") -ForegroundColor Red
        exit 1
    }
    return $output
}

$ConfigDir = Join-Path $env:ProgramData 'OpenMyChat Enterprise'
$ConfigPath = Join-Path $ConfigDir 'client.json'

if (-not (Test-Path -LiteralPath $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}

# Владелец - на администраторов, рекурсивно (каталог и всё, что уже
# внутри): иначе прежний владелец-непривилегированный пользователь мог бы
# в любой момент переписать ACL, который мы сейчас поставим, себе обратно.
Invoke-MyChatIcacls -IcaclsArgs @($ConfigDir, '/setowner', '*S-1-5-32-544', '/T', '/C') `
    -FailureMessage "Не удалось назначить владельца для $ConfigDir"

# Сбрасываем унаследованные права и ставим ровно три записи: Администраторы
# и SYSTEM - полный доступ, обычные пользователи - только чтение и
# выполнение. /inheritance:r отключает наследование от %ProgramData%,
# иначе туда попали бы более широкие права, унаследованные сверху. /T -
# рекурсивно, на все файлы, что уже лежат в каталоге (например,
# policy.json от rd-consent.js или client.json от предыдущего запуска), а
# не только на сам каталог и будущие файлы.
Invoke-MyChatIcacls -IcaclsArgs @(
        $ConfigDir,
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-32-544:(OI)(CI)F',
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-545:(OI)(CI)RX',
        '/T',
        '/C'
    ) -FailureMessage "Не удалось настроить права доступа на $ConfigDir"

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
    # ConvertFrom-Json может вернуть массив или простое значение (число,
    # строку, $true) для файла вида "[1,2]" или "5" - это валидный JSON, но
    # не объект с ключами. .PSObject.Properties у такого значения либо
    # пуст, либо не то, что ожидается - считаем это порчей файла, а не
    # набором неизвестных ключей для слияния.
    if ($existing -and -not ($existing -is [System.Management.Automation.PSCustomObject])) {
        Write-Host "Существующий client.json - не объект JSON (массив или значение), будет пересоздан." -ForegroundColor Yellow
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
    # Тот же случай, что и с $existing выше: значение "updates" в
    # повреждённом или подделанном файле может оказаться строкой, числом
    # или массивом - тогда это не объект настроек, а мусор, который не
    # нужно (и нельзя) перебирать через .PSObject.Properties.
    if ($result['updates'] -is [System.Management.Automation.PSCustomObject]) {
        foreach ($prop in $result['updates'].PSObject.Properties) {
            $existingUpdates[$prop.Name] = $prop.Value
        }
    } else {
        Write-Host "Существующий ключ updates в client.json - не объект JSON, будет пересоздан." -ForegroundColor Yellow
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

# ACL каталога с /T должен был докатиться и до client.json, но файл только
# что перезаписан - WriteAllText не трогает существующий ACL записи, но
# лишняя проверка здесь дешева, а её отсутствие означало бы, что мы просто
# верим, что каталожный /T отработал без сюрпризов (антивирус, блокировка
# файла другим процессом, гонка). Закрепляем ACL явно на файле и проверяем
# результат - если у кого-то постороннего всё ещё есть запись, это отказ,
# а не предупреждение: смысл всего скрипта в том, что этот файл нельзя
# переписать без прав администратора.
Invoke-MyChatIcacls -IcaclsArgs @(
        $ConfigPath,
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-32-544:F',
        '*S-1-5-18:F',
        '*S-1-5-32-545:RX'
    ) -FailureMessage "Не удалось настроить права доступа на $ConfigPath"

$dangerousAcl = Get-MyChatDangerousAcl -Path $ConfigPath
if ($dangerousAcl.Count -gt 0) {
    Write-Host "ОТКАЗ: после настройки ACL право на запись в $ConfigPath всё ещё есть у постороннего:" -ForegroundColor Red
    $dangerousAcl | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "client.json удалён не был, но доверять ему нельзя - проверьте ACL вручную (Get-Acl)." -ForegroundColor Yellow
    exit 1
}
Write-Host "Права на $ConfigPath проверены: запись есть только у администраторов и SYSTEM." -ForegroundColor Green

Write-Host ""
Write-Host "Записан $ConfigPath :" -ForegroundColor Cyan
Write-Host $json
Write-Host ""
Write-Host "Готово. Перезапустите OpenMyChat Enterprise на этой машине, чтобы изменения применились." -ForegroundColor Green
