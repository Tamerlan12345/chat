# Готовит выпуск автообновления из уже собранных и подписанных дистрибутивов
# и, при желании, публикует его на сервер компании.
#
# Почему отдельным шагом, а не частью npm run sign
# --------------------------------------------------
# sign-and-publish.ps1 раскладывает подписанные файлы в installer/ — то, что
# раздаётся вручную сотрудникам (сайт, шара, установка «копией»). Автообновление
# — отдельный канал: клиенты electron-updater ходят на /updates/* нашего
# сервера и сверяют версию по latest.yml, а не по имени файла в installer/.
# Раздельные шаги не дают забыть подписать Setup ПЕРЕД тем, как он станет
# доступен для автоматической установки тысяче сотрудников сразу.
#
# Запуск (из папки desktop, после npm run dist и подписи):
#   npm run publish:update
#   npm run publish:update -- -Server https://chat.company.kz -Token <admin-token>

param(
    [string]$Server,
    [string]$Token
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'signing-common.ps1')

# Публикуется только Setup, подписанный закреплённым сертификатом
# (отпечаток 0EB61614FC390FCD11BDF8DBFD40BE62EE10862A, см. signing-common.ps1
# — Get-MyChatExpectedThumbprint/Test-MyChatSignature ниже сверяют именно его).

$DesktopDir = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $DesktopDir 'release'
$YmlPath = Join-Path $ReleaseDir 'latest.yml'

if (-not (Test-Path -LiteralPath $YmlPath)) {
    Write-Host "Нет release\latest.yml — сначала соберите: npm run dist" -ForegroundColor Red
    exit 1
}

# Свой мини-парсер, а не сторонний модуль YAML: файл electron-builder плоский
# (только корневые ключи version/path/sha512 нужны здесь), и лишняя зависимость
# для трёх значений — не оправдана.
function Read-YmlRootValue([string[]]$Lines, [string]$Key) {
    foreach ($line in $Lines) {
        if ($line -match "^$Key`:\s*(.+?)\s*$") {
            $value = $Matches[1].Trim()
            return $value.Trim("'", '"')
        }
    }
    return $null
}

$ymlLines = Get-Content -LiteralPath $YmlPath -Encoding UTF8
$version = Read-YmlRootValue -Lines $ymlLines -Key 'version'
$setupName = Read-YmlRootValue -Lines $ymlLines -Key 'path'
$expectedSha512 = Read-YmlRootValue -Lines $ymlLines -Key 'sha512'

if (-not $version -or -not $setupName -or -not $expectedSha512) {
    Write-Host "release\latest.yml повреждён или не в формате electron-builder (нет version/path/sha512)." -ForegroundColor Red
    exit 1
}

Write-Host "Версия к публикации: $version" -ForegroundColor Cyan

$SetupPath = Join-Path $ReleaseDir $setupName
$BlockmapPath = "$SetupPath.blockmap"
$PortableName = "OpenMyChat-Enterprise-Portable-$version.exe"
$PortablePath = Join-Path $ReleaseDir $PortableName

foreach ($required in @($SetupPath, $BlockmapPath, $PortablePath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Host "Не найден обязательный файл выпуска: $required" -ForegroundColor Red
        Write-Host "Соберите nsis и portable перед публикацией (npm run dist)." -ForegroundColor Yellow
        exit 1
    }
}

# Подпись Setup обязана быть закреплённым сертификатом — иначе клиенты с
# verifyUpdateCodeSignature=true всё равно откажутся ставить обновление, но
# лучше узнать об этом здесь, а не после раздачи по всей сети.
if (-not (Test-MyChatSignature $SetupPath)) {
    Write-Host "$setupName не подписан закреплённым сертификатом (отпечаток $(Get-MyChatExpectedThumbprint))." -ForegroundColor Red
    Write-Host "Подпишите: npm run sign (или соберите заново — хук подписи при npm run dist)." -ForegroundColor Yellow
    exit 1
}
Write-Host "  подпись Setup: закреплённый отпечаток совпадает" -ForegroundColor Green

# sha512 в latest.yml должен совпадать с реальным файлом — это то, что
# electron-updater сверяет перед установкой; расхождение здесь означает, что
# release\ собран не полностью (например, Setup пересобрали без updater-файлов).
$actualHash = (Get-FileHash -LiteralPath $SetupPath -Algorithm SHA512).Hash
$actualBytes = [byte[]] -split ($actualHash -replace '..', '$0 ') | ForEach-Object { [Convert]::ToByte($_, 16) }
$actualSha512 = [Convert]::ToBase64String($actualBytes)
if ($actualSha512 -ne $expectedSha512) {
    Write-Host "sha512 файла $setupName не совпадает со значением в latest.yml." -ForegroundColor Red
    Write-Host "  latest.yml: $expectedSha512" -ForegroundColor Red
    Write-Host "  файл:       $actualSha512" -ForegroundColor Red
    exit 1
}
Write-Host "  sha512 Setup: совпадает с latest.yml" -ForegroundColor Green

# Проверка publisherName в app-update.yml — без него electron-updater не с чем
# сверять подпись на клиенте, и обновление в лучшем случае откажет, а в худшем
# (при кастомной проверке) молча пропустит непроверенный файл.
$AppUpdateYml = Join-Path $ReleaseDir 'win-unpacked\resources\app-update.yml'
if (-not (Test-Path -LiteralPath $AppUpdateYml) -or
    -not (Select-String -LiteralPath $AppUpdateYml -Pattern 'publisherName' -Quiet)) {
    Write-Host "В release\win-unpacked\resources\app-update.yml нет publisherName." -ForegroundColor Red
    Write-Host "Проверьте build.win.signtoolOptions.publisherName в package.json и пересоберите." -ForegroundColor Yellow
    exit 1
}
Write-Host "  app-update.yml: publisherName на месте" -ForegroundColor Green
Write-Host ""

# Пакет выпуска — то, что раздаётся серверу целиком: latest.yml + сами файлы
# (blockmap нужен для дифференциальной докачки, portable — для тех, кто
# автообновление не использует, но проверяет версию вручную).
$UpdateDir = Join-Path $ReleaseDir "update-$version"
if (Test-Path -LiteralPath $UpdateDir) {
    Remove-Item -LiteralPath $UpdateDir -Recurse -Force
}
New-Item -ItemType Directory -Path $UpdateDir | Out-Null

Copy-Item -LiteralPath $YmlPath -Destination (Join-Path $UpdateDir 'latest.yml') -Force
Copy-Item -LiteralPath $SetupPath -Destination (Join-Path $UpdateDir $setupName) -Force
Copy-Item -LiteralPath $BlockmapPath -Destination (Join-Path $UpdateDir "$setupName.blockmap") -Force
Copy-Item -LiteralPath $PortablePath -Destination (Join-Path $UpdateDir $PortableName) -Force

$readme = @"
Выпуск OpenMyChat Enterprise $version для автообновления
=========================================================

Состав:
  latest.yml                              — манифест для electron-updater
  $setupName    — установщик (закреплённая подпись Authenticode проверена)
  $setupName.blockmap — блок-карта для дифференциальной докачки
  $PortableName          — portable-сборка (без автообновления)

Раздача администратором:
  1. Перетащите эту папку целиком в консоль администратора
     (Автообновление → Выпуски → Импорт из папки), либо
  2. Скопируйте содержимое в data/updates/inbox/ на сервере — сервер
     подхватит выпуск при следующем обходе inbox.

Откат: предыдущий выпуск остаётся в консоли администратора и может быть
назначен политикой обновления повторно (ProductVersion сверяется всегда,
понижение версии запрещено по умолчанию — allowDowngrade=false).
"@
[System.IO.File]::WriteAllText((Join-Path $UpdateDir 'README.txt'), $readme, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Собрано: $UpdateDir" -ForegroundColor Green
Write-Host "  $setupName"
Write-Host "  $setupName.blockmap"
Write-Host "  $PortableName"
Write-Host "  latest.yml"
Write-Host "  README.txt"
Write-Host ""

if (-not $Server) {
    Write-Host "Сервер не указан (-Server https://... -Token ...)." -ForegroundColor Yellow
    Write-Host "Перетащите папку $UpdateDir в консоль администратора" -ForegroundColor Yellow
    Write-Host "или скопируйте её содержимое в data/updates/inbox/ на сервере." -ForegroundColor Yellow
    exit 0
}

if (-not $Token) {
    Write-Host "-Server указан без -Token — загрузка требует токена администратора." -ForegroundColor Red
    exit 1
}
if ($Server -notmatch '^https://') {
    Write-Host "-Server должен быть https (обновления по http не публикуются)." -ForegroundColor Red
    exit 1
}

Write-Host "Загружаю выпуск на $Server ..." -ForegroundColor Cyan
Add-Type -AssemblyName System.Net.Http
$handler = New-Object System.Net.Http.HttpClientHandler
$client = New-Object System.Net.Http.HttpClient($handler)
try {
    $client.Timeout = [TimeSpan]::FromMinutes(15)
    $client.DefaultRequestHeaders.Authorization =
        New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Token)

    $content = New-Object System.Net.Http.MultipartFormDataContent
    $content.Add((New-Object System.Net.Http.StringContent($version)), 'version')
    Get-ChildItem -LiteralPath $UpdateDir -File | ForEach-Object {
        $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
        $fileContent = New-Object System.Net.Http.ByteArrayContent(, $bytes)
        $content.Add($fileContent, 'files', $_.Name)
    }

    $uri = "$($Server.TrimEnd('/'))/api/admin/updates/releases"
    $response = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if (-not $response.IsSuccessStatusCode) {
        Write-Host "Сервер отказал: $([int]$response.StatusCode) $($response.ReasonPhrase)" -ForegroundColor Red
        if ($body) { Write-Host $body -ForegroundColor Red }
        exit 1
    }
    Write-Host "Выпуск $version опубликован на $Server" -ForegroundColor Green
}
finally {
    $client.Dispose()
    $handler.Dispose()
}
