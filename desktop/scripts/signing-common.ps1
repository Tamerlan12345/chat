# Общая часть подписи: поиск сертификата и подпись одного файла.
# Подключается точкой из sign-file.ps1 (его вызывает electron-builder для
# каждого exe и dll ДО упаковки в установщик) и из sign-and-publish.ps1.
#
# Сертификат выбирается по отпечатку, а не «первый подходящий в хранилище»:
# иначе при втором сертификате подписи кода в хранилище сборщика (тестовом,
# чужом) дистрибутив молча подписался бы не тем, и на машинах сотрудников
# подпись перестала бы сходиться с закреплённым отпечатком в
# installer/установить-сертификат.ps1.
#
# Префикс MyChat в именах функций и переменных — внутренний, как и у
# переменных окружения MYCHAT_*: по этим именам их находят sign-and-publish.ps1,
# publish-update.ps1 и тесты. С переименованием продукта в CentyChat он не
# менялся.

$MyChatPinnedThumbprint = '0EB61614FC390FCD11BDF8DBFD40BE62EE10862A'

function Get-MyChatExpectedThumbprint {
    $override = $env:MYCHAT_SIGN_THUMBPRINT
    if ($override) { return ($override -replace '\s', '').ToUpperInvariant() }
    return $MyChatPinnedThumbprint
}

function Get-MyChatSigningCert {
    $thumb = Get-MyChatExpectedThumbprint
    Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $thumb -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
        Select-Object -First 1
}

# Службы меток времени перебираются по очереди: они бывают недоступны, а
# подпись без метки времени умирает вместе с сертификатом.
$MyChatTimestampServers = @(
    'http://timestamp.digicert.com',
    'http://timestamp.sectigo.com',
    'http://timestamp.globalsign.com/tsa/r6advanced1'
)

# Подписан ли файл нашим сертификатом. Статус тут не годится: на машине
# сборщика корень самоподписанный и не в доверенных, статус — UnknownError.
function Test-MyChatSignature([string]$Path) {
    $sig = Get-AuthenticodeSignature -LiteralPath $Path
    return [bool]($sig.SignerCertificate -and $sig.SignerCertificate.Thumbprint -eq (Get-MyChatExpectedThumbprint))
}

# Файлы, уже подписанные третьей стороной (например, d3dcompiler_47.dll от
# Microsoft), не переподписываются: их подпись действительна сама по себе.
function Test-ThirdPartySigned([string]$Path) {
    $sig = Get-AuthenticodeSignature -LiteralPath $Path
    return [bool]($sig.Status -eq 'Valid' -and $sig.SignerCertificate -and
        $sig.SignerCertificate.Thumbprint -ne (Get-MyChatExpectedThumbprint))
}

# sha512 в формате base64 — том же, что electron-builder пишет в latest.yml и
# app-update.yml. Get-FileHash отдаёт hex; пересчитывать hex-строку в байты
# через `-split`/`[byte[]]` — ломкий путь: в Windows PowerShell 5.1 `[byte[]]`
# слева от `-split` разбирается как часть самого оператора, а не как приведение
# типа результата, и «A1» затем пытается привести к byte по основанию 10, а не
# 16 — падает на первой же паре с буквой. Здесь читаем файл потоково и считаем
# хеш через System.Security.Cryptography напрямую — без этой ловушки.
function Get-MyChatSha512Base64([string]$Path) {
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            return [Convert]::ToBase64String($sha.ComputeHash($stream))
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Invoke-MyChatSign([string]$Path, $Cert) {
    $result = $null
    foreach ($server in $MyChatTimestampServers) {
        $result = Set-AuthenticodeSignature -LiteralPath $Path -Certificate $Cert `
                  -HashAlgorithm SHA256 -TimestampServer $server -ErrorAction SilentlyContinue
        if ($result -and $result.TimeStamperCertificate) { break }
    }
    $check = Get-AuthenticodeSignature -LiteralPath $Path
    return [pscustomobject]@{
        Signed    = [bool]($check.SignerCertificate -and $check.SignerCertificate.Thumbprint -eq $Cert.Thumbprint)
        Timestamp = [bool]$check.TimeStamperCertificate
    }
}
