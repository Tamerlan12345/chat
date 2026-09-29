#Requires -RunAsAdministrator
# Настраивает машину для OpenMyChat Enterprise: пишет политику реестра
# HKLM\SOFTWARE\Policies\OpenMyChat Enterprise, которую собранное приложение
# читает при старте (desktop/src/main/client-config.js):
#   ServerUrl      REG_SZ     адрес сервера компании, только https://
#   UpdatesEnabled REG_DWORD  1 - обновления включены, 0 - выключены
#   UpdateChannel  REG_SZ     stable | beta
# См. docs/автообновление.md и docs/superpowers/specs/2026-09-28-autoupdate-design.md,
# раздел «Политика машины».
#
# Почему реестр, а не файл
# ------------------------
# Раньше настройка лежала в %ProgramData%\OpenMyChat Enterprise\client.json.
# В ProgramData по умолчанию любой пользователь может создать папку и стать
# её владельцем: на ПК, где этот скрипт ещё не запускали, сотрудник мог
# положить туда свой файл и увести приложение всех остальных пользователей
# ПК на чужой сервер. Ключ HKLM\SOFTWARE\Policies пишут только
# администраторы, на любой машине и без подготовки; его же раскладывает
# групповая политика домена (Group Policy Preferences -> Registry) - тогда
# этот скрипт не нужен вовсе. Файл client.json приложение больше не читает.
#
# Запуск (от администратора):
#   configure-client.ps1 -ServerUrl https://chat.company.kz [-Channel stable|beta] [-DisableUpdates | -EnableUpdates]
#   настроить-клиент.bat (тот же скрипт, для тех, кто не любит PowerShell)
# Без -ServerUrl уже записанный адрес не меняется; без -Channel - канал.

param(
    [string]$ServerUrl,
    [ValidateSet('stable', 'beta')]
    [string]$Channel,
    [switch]$DisableUpdates,
    [switch]$EnableUpdates
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PolicyKey = 'HKLM:\SOFTWARE\Policies\OpenMyChat Enterprise'

if ($DisableUpdates -and $EnableUpdates) {
    Write-Host "ОТКАЗ: -DisableUpdates и -EnableUpdates вместе не имеют смысла - укажите один." -ForegroundColor Red
    exit 2
}

# Та же проверка, что и в isAllowedServerUrl на клиенте
# (desktop/src/main/server-url.js): только https и без имени/пароля в адресе.
# Адрес без TLS означает, что и сам чат, и обновления ходят открытым текстом;
# учётные данные в адресе попали бы в журналы. Клиент такой адрес всё равно
# отклонит - лучше отказать здесь, чем молча оставить машину на старом адресе.
if ($ServerUrl) {
    $parsed = $null
    $isUrl = [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$parsed)
    if (-not $isUrl -or $ServerUrl -notmatch '^https://' -or $parsed.Scheme -ne 'https' -or $parsed.UserInfo) {
        Write-Host "ОТКАЗ: -ServerUrl должен быть адресом https:// без имени и пароля (получено: $ServerUrl)" -ForegroundColor Red
        Write-Host "Обновления и синхронизация по http не поддерживаются - см. docs/автообновление.md." -ForegroundColor Yellow
        exit 2
    }
}

# New-Item -Force на уже существующем ключе реестра пересоздаёт его и стирает
# значения, заданные раньше (или групповой политикой) - поэтому только если
# ключа ещё нет.
if (-not (Test-Path -LiteralPath $PolicyKey)) {
    New-Item -Path $PolicyKey -Force | Out-Null
}

# Каждое значение пишется только если его передали: запуск с одним
# -DisableUpdates не должен затирать адрес сервера, записанный раньше.
if ($ServerUrl) {
    New-ItemProperty -LiteralPath $PolicyKey -Name ServerUrl -PropertyType String -Value $ServerUrl -Force | Out-Null
}
if ($Channel) {
    New-ItemProperty -LiteralPath $PolicyKey -Name UpdateChannel -PropertyType String -Value $Channel -Force | Out-Null
}

$current = Get-ItemProperty -LiteralPath $PolicyKey
if ($DisableUpdates) {
    New-ItemProperty -LiteralPath $PolicyKey -Name UpdatesEnabled -PropertyType DWord -Value 0 -Force | Out-Null
} elseif ($EnableUpdates -or $null -eq $current.UpdatesEnabled) {
    # Нет значения - клиент и так считает обновления включёнными; пишем 1
    # явно, чтобы в реестре было видно, что машина настроена.
    New-ItemProperty -LiteralPath $PolicyKey -Name UpdatesEnabled -PropertyType DWord -Value 1 -Force | Out-Null
}

$current = Get-ItemProperty -LiteralPath $PolicyKey
Write-Host ""
Write-Host "Политика $PolicyKey :" -ForegroundColor Cyan
foreach ($name in @('ServerUrl', 'UpdatesEnabled', 'UpdateChannel')) {
    $value = $current.$name
    if ($null -eq $value) { $value = '(не задано - значение по умолчанию)' }
    Write-Host ("  {0,-15} {1}" -f $name, $value)
}
Write-Host ""
Write-Host "Готово. Перезапустите OpenMyChat Enterprise на этой машине, чтобы изменения применились." -ForegroundColor Green
