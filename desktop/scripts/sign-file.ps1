# Подписывает один файл. Вызывается из scripts/sign-windows.js — хука
# electron-builder — для внутреннего «OpenMyChat Enterprise.exe», dll и
# самих установщиков, пока они ещё не упакованы.
#
# Коды выхода: 0 — подписан (или подпись третьей стороны оставлена),
# 2 — нет сертификата, 3 — подпись не встала.

param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'signing-common.ps1')

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "нет файла: $Path"
    exit 3
}

if (Test-ThirdPartySigned $Path) {
    Write-Host "уже подписан третьей стороной, оставлен: $(Split-Path -Leaf $Path)"
    exit 0
}

$cert = Get-MyChatSigningCert
if (-not $cert) {
    Write-Host "нет сертификата с отпечатком $(Get-MyChatExpectedThumbprint) в Cert:\CurrentUser\My"
    exit 2
}

$r = Invoke-MyChatSign $Path $cert
if (-not $r.Signed) {
    Write-Host "подпись не поставлена: $(Split-Path -Leaf $Path)"
    exit 3
}
$stamp = if ($r.Timestamp) { 'с меткой времени' } else { 'БЕЗ метки времени' }
Write-Host "подписан, ${stamp}: $(Split-Path -Leaf $Path)"
exit 0
