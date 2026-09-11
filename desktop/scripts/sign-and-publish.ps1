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
# Запуск:  npm run sign   (из папки desktop, после npm run dist)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$DesktopDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ReleaseDir = Join-Path $DesktopDir 'release'
$InstallerDir = Join-Path (Split-Path -Parent $DesktopDir) 'installer'

if (-not (Test-Path $ReleaseDir)) {
    Write-Host "Нет папки release — сначала соберите: npm run dist" -ForegroundColor Red
    exit 1
}

# Сертификат берётся из личного хранилища пользователя, который собирает. В
# репозитории закрытого ключа нет и быть не должно: подписать чужим именем
# смог бы каждый, у кого есть доступ к исходникам.
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
        Select-Object -First 1

if (-not $cert) {
    Write-Host "В хранилище Cert:\CurrentUser\My нет действующего сертификата подписи кода." -ForegroundColor Red
    Write-Host "Дистрибутивы останутся неподписанными — Windows будет спрашивать про издателя." -ForegroundColor Yellow
    exit 1
}

Write-Host "Подписываю сертификатом: $($cert.Subject.Split(',')[0])" -ForegroundColor Cyan
Write-Host ""

# Службы меток времени перебираются по очереди: они бывают недоступны, а
# подпись без метки времени умирает вместе с сертификатом.
$TimestampServers = @(
    'http://timestamp.digicert.com',
    'http://timestamp.sectigo.com',
    'http://timestamp.globalsign.com/tsa/r6advanced1'
)

$Targets = @(
    @{ Pattern = '*Setup*.exe'; Name = 'OpenMyChat-Enterprise-Setup.exe' },
    @{ Pattern = 'OpenMyChat Enterprise *.exe'; Name = 'OpenMyChat-Enterprise-Portable.exe' }
)

$signed = 0
foreach ($target in $Targets) {
    $source = Get-ChildItem (Join-Path $ReleaseDir $target.Pattern) -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -notlike '*uninstaller*' } |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $source) {
        Write-Host "  не найден: $($target.Pattern)" -ForegroundColor Yellow
        continue
    }

    $dest = Join-Path $InstallerDir $target.Name
    Copy-Item $source.FullName $dest -Force

    $result = $null
    foreach ($server in $TimestampServers) {
        $result = Set-AuthenticodeSignature -FilePath $dest -Certificate $cert `
                  -HashAlgorithm SHA256 -TimestampServer $server -ErrorAction SilentlyContinue
        if ($result -and $result.TimeStamperCertificate) { break }
    }

    $check = Get-AuthenticodeSignature $dest
    if (-not $check.SignerCertificate) {
        Write-Host "  $($target.Name): ПОДПИСЬ НЕ ПОСТАВЛЕНА" -ForegroundColor Red
        continue
    }

    $stamp = if ($check.TimeStamperCertificate) { 'с меткой времени' } else { 'БЕЗ метки времени' }
    Write-Host "  $($target.Name): подписан, $stamp" -ForegroundColor Green
    $signed++
}

Write-Host ""
if ($signed -eq 0) {
    Write-Host "Ни один файл не подписан." -ForegroundColor Red
    exit 1
}

# Статус UnknownError здесь — норма: подпись на месте, но корневой сертификат
# самоподписанный, и на машине сборщика он в доверенные не добавлен. У
# сотрудников это решает installer/установить-сертификат.bat.
Write-Host "Готово. Дистрибутивы в: $InstallerDir" -ForegroundColor Green
Write-Host "Не забудьте раздать вместе с ними установить-сертификат.bat —" -ForegroundColor Yellow
Write-Host "без корневого сертификата Windows подпись проверить не сможет." -ForegroundColor Yellow
