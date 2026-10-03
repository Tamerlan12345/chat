# Общая часть установки «копией» (install.ps1 и uninstall.ps1): где искать
# установку, что считать её папкой, как закрыть приложение и удалить папку.
# Только функции, ничего не делает при подключении — его подключают точкой
# оба скрипта и тесты (desktop/test/copy-install.test.js).
#
# Папку, адрес которой пришёл из реестра, удалить целиком можно, только если
# это действительно папка приложения: запись в HKCU может править любой
# процесс пользователя, и «InstallLocation = профиль пользователя» с
# рекурсивным удалением стёрли бы всё.

# GUID установки через Setup.exe (NSIS). electron-builder выводит его из
# appId com.openmychat.desktop (UUID v5 в своём пространстве имён) и пишет
# HKCU|HKLM\Software\<GUID>\InstallLocation. Тест сверяет его с appId.
$CentyChatNsisGuid = 'c4559137-0689-5b77-a7f1-85e1ce7e9fea'
$CentyChatNsisKeys = @(
    "HKCU:\Software\$CentyChatNsisGuid",
    "HKLM:\Software\$CentyChatNsisGuid"
)

# Имена exe в папке установки «копией»: нынешнее и до переименования.
$CentyChatExeNames = @('CentyChat.exe', 'OpenMyChat Enterprise.exe')

# Папка установки через Setup.exe или $null.
function Get-CentyChatNsisInstall {
    param([string[]]$KeyPaths = $CentyChatNsisKeys)
    foreach ($key in $KeyPaths) {
        $location = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).InstallLocation
        if ($location) { return [string]$location }
    }
    return $null
}

# Можно ли считать папку установкой «копией»: прямая подпапка
# %LOCALAPPDATA%\Programs (туда ставит install.ps1), настоящая папка, а не
# точка соединения или ссылка, и в ней уже лежит exe приложения.
function Test-CentyChatCopyDir {
    param(
        [string]$Path,
        [string]$ProgramsRoot = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs' } else { '' })
    )
    if (-not $Path -or -not $ProgramsRoot) { return $false }
    if (-not [IO.Path]::IsPathRooted($Path)) { return $false }
    try {
        $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
        $root = [IO.Path]::GetFullPath($ProgramsRoot).TrimEnd('\')
    } catch {
        return $false
    }
    $parent = [IO.Path]::GetDirectoryName($full)
    if (-not $parent -or -not [string]::Equals($parent.TrimEnd('\'), $root, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if (-not $item -or -not $item.PSIsContainer) { return $false }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    foreach ($name in $CentyChatExeNames) {
        if (Test-Path -LiteralPath (Join-Path $full $name) -PathType Leaf) { return $true }
    }
    return $false
}

# Процессы, запущенные из папки (приложение и его дочерние процессы Chromium).
function Get-CentyChatProcessesIn {
    param([string]$Dir)
    # И папка, и путь процесса приводятся к одному виду: GetFullPath в Windows
    # PowerShell раскрывает короткие имена 8.3 (C:\Users\RUNNER~1\... →
    # C:\Users\runneradmin\...), а WMI отдаёт путь так, как процесс был
    # запущен. Без этого процесс, запущенный по короткому пути (так выглядит
    # %TEMP% у пользователей с длинным именем), не находился и не закрывался.
    $prefix = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) {
        $processes = @(Get-WmiObject -Class Win32_Process -ErrorAction SilentlyContinue)
    }
    @($processes | Where-Object {
        $exePath = $_.ExecutablePath
        if (-not $exePath) { return $false }
        try { $exePath = [IO.Path]::GetFullPath($exePath) } catch { }
        $exePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

# Закрывает приложение, запущенное из папки, как это делает и установщик
# NSIS: иначе копирование упрётся в занятые файлы на середине.
# → $true, если в папке не осталось запущенных процессов.
function Stop-CentyChatCopyApp {
    param([string]$Dir, [int]$TimeoutSeconds = 15)
    foreach ($process in (Get-CentyChatProcessesIn -Dir $Dir)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-CentyChatProcessesIn -Dir $Dir).Count -gt 0) {
        if ((Get-Date) -gt $deadline) { return $false }
        Start-Sleep -Milliseconds 300
    }
    return $true
}

# Удаляет папку, не заходя в точки соединения и символические ссылки:
# Remove-Item -Recurse в PowerShell 5.1 проходит по ним и удалил бы то, на что
# они указывают. Сама ссылка удаляется, её цель остаётся.
# → $true, если всё удалено.
function Remove-CentyChatCopyDir {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $true }
    $ok = $true
    try {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName) } else { [IO.File]::Delete($item.FullName) }
            return $true
        }
        if ($item.PSIsContainer) {
            foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
                if (-not (Remove-CentyChatCopyDir -Path $child.FullName)) { $ok = $false }
            }
            if ($ok) { [IO.Directory]::Delete($item.FullName) }
        } else {
            if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) {
                $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
            }
            [IO.File]::Delete($item.FullName)
        }
    } catch {
        return $false
    }
    return $ok
}
