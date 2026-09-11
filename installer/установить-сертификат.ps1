# Устанавливает корневой сертификат Centras, которым подписаны дистрибутивы.
#
# Зачем это нужно
# ---------------
# Файлы уже подписаны сертификатом «Centras Insurance», но сертификат
# самоподписанный: Windows не знает, кто его выдал. Пока он не лежит в
# «Доверенных корневых центрах сертификации», построить цепочку доверия не от
# чего, и подпись считается недействительной — со всеми последствиями в виде
# «не удалось проверить издателя».
#
# Проверить текущее состояние можно так:
#   Get-AuthenticodeSignature 'OpenMyChat-Enterprise-Setup.exe' | Select Status
# До установки сертификата Status = UnknownError, после = Valid.
#
# Важно: одного «Доверенного издателя» (TrustedPublisher) недостаточно — именно
# на этом здесь всё и останавливалось. Нужны ОБА хранилища: Root даёт цепочку
# доверия, TrustedPublisher снимает вопрос о запуске.
#
# Чего этот скрипт НЕ делает
# --------------------------
# Он не влияет на Smart App Control. Тот доверяет только тем удостоверяющим
# центрам, которые входят в программу доверенных корней Microsoft, и никакой
# корпоративный сертификат в этот список добавить нельзя. На устройствах,
# управляемых доменом, Smart App Control отключается сам — там этого скрипта
# достаточно. На личном компьютере с включённым Smart App Control —
# нет; см. docs/смарт-контроль.md.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CertPath = Join-Path $ScriptDir 'Centras-Corporate-Root.cer'

if (-not (Test-Path $CertPath)) {
    Write-Host "Не найден файл сертификата: $CertPath" -ForegroundColor Red
    exit 1
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertPath)
Write-Host ""
Write-Host "Сертификат:  $($cert.Subject)" -ForegroundColor Cyan
Write-Host "Отпечаток:   $($cert.Thumbprint)"
Write-Host "Действителен до: $($cert.NotAfter.ToString('dd.MM.yyyy'))"
Write-Host ""

# С правами администратора ставим на всю машину — тогда сертификат действует
# для всех учётных записей и для служб. Без них — только для текущего
# пользователя: этого достаточно, чтобы приложение запускалось у него.
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$scope = if ($isAdmin) { 'LocalMachine' } else { 'CurrentUser' }
if ($isAdmin) {
    Write-Host "Права администратора есть — ставлю для всего компьютера." -ForegroundColor Green
} else {
    Write-Host "Прав администратора нет — ставлю только для текущего пользователя." -ForegroundColor Yellow
    Write-Host "Этого достаточно, чтобы приложение запускалось у вас." -ForegroundColor Yellow
}
Write-Host ""

foreach ($storeName in @('Root', 'TrustedPublisher')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, $scope)
    try {
        $store.Open('ReadWrite')
        $already = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
        if ($already) {
            Write-Host "  $scope\$storeName — уже установлен" -ForegroundColor DarkGray
        } else {
            $store.Add($cert)
            Write-Host "  $scope\$storeName — установлен" -ForegroundColor Green
        }
    } catch {
        # Добавление в Root для текущего пользователя показывает окно
        # подтверждения Windows. Отказ в нём — это отказ, а не сбой.
        Write-Host "  $scope\$storeName — не удалось: $($_.Exception.Message)" -ForegroundColor Red
    } finally {
        $store.Close()
    }
}

Write-Host ""
Write-Host "Проверяю подписи дистрибутивов…" -ForegroundColor Cyan

$anyChecked = $false
Get-ChildItem -Path (Join-Path $ScriptDir '*.exe') -ErrorAction SilentlyContinue | ForEach-Object {
    $anyChecked = $true
    $sig = Get-AuthenticodeSignature -FilePath $_.FullName
    $color = if ($sig.Status -eq 'Valid') { 'Green' } else { 'Yellow' }
    Write-Host ("  {0}: {1}" -f $_.Name, $sig.Status) -ForegroundColor $color
}

if (-not $anyChecked) {
    Write-Host "  Рядом со скриптом нет ни одного .exe — проверять нечего." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Готово. Если статус подписи стал Valid, предупреждение об" -ForegroundColor Green
Write-Host "издателе при запуске больше не появится." -ForegroundColor Green
Write-Host ""
