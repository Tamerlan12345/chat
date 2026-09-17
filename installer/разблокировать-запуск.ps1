# Снимает пометку «загружено из интернета» только с подлинных дистрибутивов.
#
# Раньше разблокировался любой .exe рядом со скриптом — подложенный в ту же
# папку файл запускался бы без проверки SmartScreen. Теперь пометка снимается
# лишь с файлов, чья подпись действительна и поставлена корпоративным
# сертификатом с закреплённым отпечатком. Остальные не трогаются.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Тот же отпечаток, что в установить-сертификат.ps1.
$PinnedThumbprint = '0EB61614FC390FCD11BDF8DBFD40BE62EE10862A'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = Get-ChildItem -Path (Join-Path $ScriptDir '*.exe') -ErrorAction SilentlyContinue

if (-not $files) {
    Write-Host "Рядом со скриптом нет ни одного .exe." -ForegroundColor Yellow
    exit 0
}

$refused = 0
foreach ($file in $files) {
    $sig = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $thumb = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { '' }

    if ($thumb -eq $PinnedThumbprint -and $sig.Status -eq 'Valid') {
        Unblock-File -LiteralPath $file.FullName
        Write-Host "  $($file.Name): подпись подлинная — разблокирован" -ForegroundColor Green
        continue
    }

    $refused++
    if ($thumb -eq $PinnedThumbprint -and $sig.Status -eq 'UnknownError') {
        Write-Host "  $($file.Name): НЕ разблокирован — сначала запустите установить-сертификат.bat" -ForegroundColor Yellow
    } elseif (-not $thumb) {
        Write-Host "  $($file.Name): НЕ разблокирован — файл не подписан" -ForegroundColor Red
    } else {
        Write-Host "  $($file.Name): НЕ разблокирован — подпись чужая или повреждена ($($sig.Status))" -ForegroundColor Red
    }
}

Write-Host ""
if ($refused -gt 0) {
    Write-Host "Файлы без подлинной подписи не запускайте и сообщите о них в ИТ-отдел." -ForegroundColor Yellow
    exit 1
}
exit 0
