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
#   $env:MYCHAT_UPDATE_TOKEN = '<токен супер-администратора>'
#   npm run publish:update -- -Server https://chat.company.kz [-Notes "Что нового"]
# Токен лучше передавать переменной MYCHAT_UPDATE_TOKEN: параметр -Token
# остаётся в истории PowerShell и виден в списке процессов.

param(
    [string]$Server,
    [string]$Token,
    [string]$Notes
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'signing-common.ps1')

# Публикуется только Setup, подписанный закреплённым сертификатом — тем же,
# что закреплён в клиенте (desktop/src/main/update-verify.js,
# PINNED_THUMBPRINTS). Переопределение отпечатка из signing-common.ps1
# (переменная для тестовой подписи) здесь намеренно не действует: выпуск,
# подписанный другим сертификатом, клиенты всё равно отвергнут
# (signature-foreign) — лучше узнать об этом до раздачи.
$PinnedThumbprint = '0EB61614FC390FCD11BDF8DBFD40BE62EE10862A'

# Файлы выпуска → поля multipart. Имена полей — ровно те, что принимает
# сервер (server/src/updates/admin-router.js, UPLOAD_FIELDS): yml, setup,
# blockmap, portable. README.txt — только для человека и на сервер не уходит
# (сервер принимает не больше четырёх файлов).
function Get-MyChatUploadParts {
    param(
        [Parameter(Mandatory)][string]$UpdateDir,
        [Parameter(Mandatory)][string]$SetupName,
        [Parameter(Mandatory)][string]$PortableName
    )
    $parts = [ordered]@{
        yml      = (Join-Path $UpdateDir 'latest.yml')
        setup    = (Join-Path $UpdateDir $SetupName)
        blockmap = (Join-Path $UpdateDir "$SetupName.blockmap")
        portable = (Join-Path $UpdateDir $PortableName)
    }
    return $parts
}

# Загрузка выпуска: POST /api/admin/updates/releases. Файлы идут потоком
# (StreamContent), а не ReadAllBytes: установщик весит сотни мегабайт.
# Токен уходит только заголовком Authorization и нигде не печатается.
function Send-MyChatRelease {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Parts,
        [string]$Notes
    )
    # Windows PowerShell 5.1 (.NET Framework) по умолчанию может предложить
    # серверу только TLS 1.0/1.1, которые современный прокси отвергает.
    $protocols = [Net.SecurityProtocolType]::Tls12
    if ([Enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') {
        $protocols = $protocols -bor [Net.SecurityProtocolType]'Tls13'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor $protocols

    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $client = New-Object System.Net.Http.HttpClient($handler)
    $content = New-Object System.Net.Http.MultipartFormDataContent
    $streams = New-Object System.Collections.Generic.List[System.IO.Stream]
    try {
        $client.Timeout = [TimeSpan]::FromMinutes(30)
        $client.DefaultRequestHeaders.Authorization =
            New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Token)

        foreach ($field in $Parts.Keys) {
            $path = $Parts[$field]
            $stream = [System.IO.File]::OpenRead($path)
            $streams.Add($stream)
            $part = New-Object System.Net.Http.StreamContent($stream)
            $part.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/octet-stream')
            $content.Add($part, $field, [System.IO.Path]::GetFileName($path))
        }
        if ($Notes) {
            $content.Add((New-Object System.Net.Http.StringContent($Notes, [System.Text.Encoding]::UTF8)), 'notes')
        }

        $response = $client.PostAsync($Uri, $content).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return [pscustomobject]@{
            Ok     = [bool]$response.IsSuccessStatusCode
            Status = [int]$response.StatusCode
            Reason = $response.ReasonPhrase
            Body   = $body
        }
    }
    finally {
        $content.Dispose()
        foreach ($s in $streams) { $s.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }
}

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
$setupSignature = Get-AuthenticodeSignature -LiteralPath $SetupPath
if (-not ($setupSignature.SignerCertificate -and $setupSignature.SignerCertificate.Thumbprint -eq $PinnedThumbprint)) {
    Write-Host "$setupName не подписан закреплённым сертификатом (отпечаток $PinnedThumbprint)." -ForegroundColor Red
    Write-Host "Подпишите: npm run sign (или соберите заново — хук подписи при npm run dist)." -ForegroundColor Yellow
    exit 1
}
Write-Host "  подпись Setup: закреплённый отпечаток совпадает" -ForegroundColor Green

# sha512 в latest.yml должен совпадать с реальным файлом — это то, что
# electron-updater сверяет перед установкой; расхождение здесь означает, что
# release\ собран не полностью (например, Setup пересобрали без updater-файлов).
# Get-MyChatSha512Base64 — из signing-common.ps1 (дот-подключён выше).
$actualSha512 = Get-MyChatSha512Base64 -Path $SetupPath
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
$UpdateDirName = "update-$version"
$UpdateDir = Join-Path $ReleaseDir $UpdateDirName
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

Раздача администратором (консоль — вкладка «Обновления», только
супер-администратор):
  1. Раздел «Загрузить релиз»: выберите latest.yml, установщик, blockmap и
     portable из этой папки (README.txt не нужен) — или сразу
     npm run publish:update -- -Server https://<сервер> с токеном в
     переменной MYCHAT_UPDATE_TOKEN.
  2. Либо скопируйте эту папку ЦЕЛИКОМ подпапкой в data/updates/inbox/ на
     сервере — получится data/updates/inbox/$UpdateDirName/latest.yml и т. д.
     (файлы прямо в inbox/ сервер не видит). Затем в разделе «Папка inbox»
     нажмите «Импортировать». Для больших выпусков этот путь надёжнее
     загрузки через браузер.

Откат: только вперёд. Выпуск с номером ниже установленного клиенты не
ставят (allowDowngrade=false, ProductVersion сверяется всегда). Если выпуск
оказался плохим — соберите и опубликуйте СЛЕДУЮЩУЮ версию с исправлением или
прежним содержимым (docs/автообновление.md, раздел «Откат»).
"@
[System.IO.File]::WriteAllText((Join-Path $UpdateDir 'README.txt'), $readme, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Собрано: $UpdateDir" -ForegroundColor Green
Write-Host "  $setupName"
Write-Host "  $setupName.blockmap"
Write-Host "  $PortableName"
Write-Host "  latest.yml"
Write-Host "  README.txt (только для администратора, на сервер не загружается)"
Write-Host ""

if (-not $Server) {
    Write-Host "Сервер не указан (-Server https://..., токен — в `$env:MYCHAT_UPDATE_TOKEN)." -ForegroundColor Yellow
    Write-Host "Загрузите файлы в консоли администратора: вкладка «Обновления» → «Загрузить релиз»," -ForegroundColor Yellow
    Write-Host "или скопируйте папку целиком в data/updates/inbox/$UpdateDirName/ на сервере" -ForegroundColor Yellow
    Write-Host "и нажмите «Импортировать» в разделе «Папка inbox» той же вкладки." -ForegroundColor Yellow
    exit 0
}

if ($Server -notmatch '^https://') {
    Write-Host "-Server должен быть https (обновления по http не публикуются)." -ForegroundColor Red
    exit 1
}

$effectiveToken = $Token
if ($effectiveToken) {
    Write-Host "Токен передан параметром -Token: он остаётся в истории PowerShell. Лучше `$env:MYCHAT_UPDATE_TOKEN." -ForegroundColor Yellow
} else {
    $effectiveToken = $env:MYCHAT_UPDATE_TOKEN
}
if (-not $effectiveToken) {
    Write-Host "Нет токена супер-администратора: задайте `$env:MYCHAT_UPDATE_TOKEN (или -Token)." -ForegroundColor Red
    exit 1
}

$parts = Get-MyChatUploadParts -UpdateDir $UpdateDir -SetupName $setupName -PortableName $PortableName
$uri = "$($Server.TrimEnd('/'))/api/admin/updates/releases"
Write-Host "Загружаю выпуск на $Server ..." -ForegroundColor Cyan
$result = Send-MyChatRelease -Uri $uri -Token $effectiveToken -Parts $parts -Notes $Notes

if (-not $result.Ok) {
    Write-Host "Сервер отказал: $($result.Status) $($result.Reason)" -ForegroundColor Red
    if ($result.Body) { Write-Host $result.Body -ForegroundColor Red }
    exit 1
}
Write-Host "Выпуск $version опубликован на $Server" -ForegroundColor Green
Write-Host "Раздача начнётся после того, как вы назначите его целью канала в разделе «Политика раздачи»." -ForegroundColor Cyan
