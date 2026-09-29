# Подписывает собранные дистрибутивы и раскладывает их в installer/.
#
# Почему отдельным шагом, а не средствами electron-builder
# -------------------------------------------------------
# electron-builder подписывает через signtool.exe из Windows SDK. Когда SDK на
# машине нет, он всё равно пишет в журнал «signing with signtool.exe» и
# завершается успешно — а файлы остаются БЕЗ подписи. Ошибка тихая: сборка
# зелёная, установщик готов, и только у сотрудника на его компьютере
# выясняется, что издатель по-прежнему неизвестен.
#
# Set-AuthenticodeSignature — часть самого PowerShell и не требует ни SDK, ни
# отдельных загрузок. Здесь же ставится метка времени: без неё подпись
# перестаёт считаться действительной в тот день, когда истечёт сертификат,
# и все уже установленные копии разом «портятся».
#
# Внутренний «CentyChat.exe» и dll подписываются раньше — во время
# npm run dist, хуком scripts/sign-windows.js, пока они ещё не упакованы в
# установщик. Здесь это проверяется: выпуск с неподписанным внутренним exe
# останавливается.
#
# Setup и Portable, которые называет electron-builder (build.nsis.artifactName
# и build.portable.artifactName в package.json), уже содержат версию и нужный
# нам вид имени — просто копируются под этим же именем, без переименования.
# Если целевой файл уже подписан ЗАКРЕПЛЁННЫМ отпечатком (например, повторный
# запуск после сбоя публикации), он не переподписывается — Set-AuthenticodeSignature
# на уже подписанном файле не вредит, но лишний проход по сети до серверов
# меток времени не нужен.
#
# Запуск:  npm run sign   (из папки desktop, после npm run dist)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'signing-common.ps1')

$DesktopDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ReleaseDir = Join-Path $DesktopDir 'release'
$InstallerDir = Join-Path (Split-Path -Parent $DesktopDir) 'installer'

if (-not (Test-Path $ReleaseDir)) {
    Write-Host "Нет папки release — сначала соберите: npm run dist" -ForegroundColor Red
    exit 1
}

# Сертификат берётся из личного хранилища пользователя, который собирает. В
# репозитории закрытого ключа нет и быть не должно: подписать чужим именем
# смог бы каждый, у кого есть доступ к исходникам. Выбирается строго по
# закреплённому отпечатку (signing-common.ps1).
$cert = Get-MyChatSigningCert

if (-not $cert) {
    Write-Host "В хранилище Cert:\CurrentUser\My нет действующего сертификата подписи кода" -ForegroundColor Red
    Write-Host "с отпечатком $(Get-MyChatExpectedThumbprint)." -ForegroundColor Red
    Write-Host "Дистрибутивы останутся неподписанными — Windows будет спрашивать про издателя." -ForegroundColor Yellow
    exit 1
}

Write-Host "Подписываю сертификатом: $($cert.Subject.Split(',')[0])" -ForegroundColor Cyan
Write-Host ""

# Внутреннее приложение должно быть подписано ещё при сборке: внутрь готового
# установщика его уже не подписать.
$Unpacked = Join-Path $ReleaseDir 'win-unpacked'
if (-not (Test-Path $Unpacked)) {
    Write-Host "Нет папки release\win-unpacked — сначала соберите: npm run dist" -ForegroundColor Red
    exit 1
}
$unsigned = @()
Get-ChildItem -Path $Unpacked -Recurse -File -Include '*.exe', '*.dll' | ForEach-Object {
    if (-not (Test-MyChatSignature $_.FullName) -and -not (Test-ThirdPartySigned $_.FullName)) {
        $unsigned += $_.FullName.Substring($Unpacked.Length + 1)
    }
}
if ($unsigned.Count -gt 0) {
    Write-Host "Внутри сборки есть неподписанные файлы:" -ForegroundColor Red
    $unsigned | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "Пересоберите на этой машине: npm run dist (хук подписи возьмёт сертификат сам)." -ForegroundColor Yellow
    exit 1
}
Write-Host "  win-unpacked: все exe и dll подписаны" -ForegroundColor Green
Write-Host ""

# publisherName обязателен для electron-updater: без него верификации подписи
# скачанного обновления не с чем сверяться, и это лучше поймать здесь, а не
# после того, как файл уже разошёлся по сети как обновление.
$AppUpdateYml = Join-Path $Unpacked 'resources\app-update.yml'
if (-not (Test-Path -LiteralPath $AppUpdateYml) -or
    -not (Select-String -LiteralPath $AppUpdateYml -Pattern 'publisherName' -Quiet)) {
    Write-Host "В release\win-unpacked\resources\app-update.yml нет publisherName." -ForegroundColor Red
    Write-Host "Проверьте build.win.signtoolOptions.publisherName в package.json и пересоберите." -ForegroundColor Yellow
    exit 1
}
Write-Host "  app-update.yml: publisherName на месте" -ForegroundColor Green
Write-Host ""

# Имена — как их задают build.nsis.artifactName и build.portable.artifactName
# в package.json (с версией и дефисами): их же ожидает серверная проверка
# обновлений и publish-update.ps1, так что здесь имя не меняется, только копия
# уходит в installer/ — папку ручной раздачи сотрудникам.
$Targets = @(
    @{ Pattern = 'CentyChat-Setup-*.exe' },
    @{ Pattern = 'CentyChat-Portable-*.exe' }
)

$signed = 0
$copiedNames = @()
foreach ($target in $Targets) {
    $source = Get-ChildItem (Join-Path $ReleaseDir $target.Pattern) -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -notlike '*uninstaller*' -and $_.Extension -eq '.exe' } |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $source) {
        Write-Host "  не найден: $($target.Pattern)" -ForegroundColor Yellow
        continue
    }

    $name = $source.Name
    # Проверяется ДО копирования: source — то, что реально вышло из-под
    # electron-builder на этом прогоне; dest в installer/ всегда перезаписывается
    # Copy-Item -Force ниже, так что проверка dest ПОСЛЕ копии видела бы уже
    # скопированный source и никогда не находила прежнюю подпись установщика
    # из installer/ — переподписывался бы каждый раз, даже когда source уже
    # подписан закреплённым сертификатом (например, повторный запуск после
    # сбоя на шаге контрольных сумм).
    $alreadySigned = Test-MyChatSignature $source.FullName
    $dest = Join-Path $InstallerDir $name
    Copy-Item $source.FullName $dest -Force

    if ($alreadySigned) {
        Write-Host "  $($name): уже подписан закреплённым сертификатом, пропускаю" -ForegroundColor Green
        $copiedNames += $name
        $signed++
        continue
    }

    $check = Invoke-MyChatSign $dest $cert
    if (-not $check.Signed) {
        Write-Host "  $($name): ПОДПИСЬ НЕ ПОСТАВЛЕНА" -ForegroundColor Red
        continue
    }

    $stamp = if ($check.Timestamp) { 'с меткой времени' } else { 'БЕЗ метки времени' }
    Write-Host "  $($name): подписан, $stamp" -ForegroundColor Green
    $copiedNames += $name
    $signed++
}

Write-Host ""
if ($signed -eq 0) {
    Write-Host "Ни один файл не подписан." -ForegroundColor Red
    exit 1
}

# Контрольные суммы. Их публикуют ОТДЕЛЬНЫМ каналом (не рядом с файлами в той
# же папке раздачи): кто может подменить установщик, подменит и лежащий рядом
# список, а сверка с суммой из другого источника подмену выдаёт.
$SumsPath = Join-Path $InstallerDir 'SHA256SUMS.txt'
# Скрипты установки «копией» раздаются тем же комплектом и выполняются у
# сотрудника — их подмену тоже должна выдавать сверка сумм.
$CopyInstallKit = @('install.bat', 'install.ps1', 'uninstall.ps1', 'copy-install-common.ps1')
$SumFiles = $copiedNames + @('Centras-Corporate-Root.cer') + $CopyInstallKit
$lines = foreach ($name in $SumFiles) {
    $file = Join-Path $InstallerDir $name
    if (Test-Path -LiteralPath $file) {
        '{0}  {1}' -f (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(), $name
    } else {
        Write-Host "  для SHA256SUMS не найден: $name" -ForegroundColor Yellow
    }
}
[System.IO.File]::WriteAllText($SumsPath, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ""
Write-Host "SHA-256 (опубликуйте отдельно от файлов):" -ForegroundColor Cyan
$lines | ForEach-Object { Write-Host "  $_" }
Write-Host "Проверка у сотрудника: Get-FileHash .\CentyChat-Setup-<версия>.exe" -ForegroundColor DarkGray
Write-Host ""

# Статус UnknownError здесь — норма: подпись на месте, но корневой сертификат
# самоподписанный, и на машине сборщика он в доверенные не добавлен. У
# сотрудников это решает installer/установить-сертификат.bat.
Write-Host "Готово. Дистрибутивы в: $InstallerDir" -ForegroundColor Green
Write-Host "Не забудьте раздать вместе с ними установить-сертификат.bat —" -ForegroundColor Yellow
Write-Host "без корневого сертификата Windows подпись проверить не сможет." -ForegroundColor Yellow
