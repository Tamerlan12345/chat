# Get-MyChatDangerousAcl — проверяет ACL файла: возвращает список записей,
# где право реально ИЗМЕНИТЬ файл (записать данные, сменить атрибуты, права
# или владельца, удалить) есть у кого-то, кроме администраторов и SYSTEM.
# Используется в configure-client.ps1 после того, как он сам выставляет ACL
# на client.json — как проверка результата, а не просто «icacls отработал
# без ошибки».
#
# Вынесено в отдельный файл (а не осталось функцией внутри
# configure-client.ps1), чтобы её можно было прогнать по-настоящему —
# powershell.exe, реальный Get-Acl на реальном файле — из теста
# (desktop/test/installer-acl-guard.test.js), а не только грепом текста.
# Текстовая проверка не поймала бы саму суть прошлой ошибки: код был
# синтаксически верным и выглядел правильно, но на настоящем NTFS ACL
# ошибался.
#
# Почему маска прав — НЕ Modify/FullControl
# -------------------------------------------
# Modify и FullControl — составные флаги: Modify (0x301BF) включает в себя
# и часть прав на чтение (в частности ReadAndExecute), FullControl —
# вообще все биты. Если маску «опасных» прав строить через них, то
# `(bits -band riskyMask) -ne 0` истинно и для ACE, где стоит только
# ReadAndExecute + Synchronize (ровно то, что этот же скрипт выдаёт группе
# «Пользователи» через RX) — потому что биты ReadAndExecute пересекаются с
# битами внутри Modify. Из-за этого первая версия этой функции считала
# опасным ЛЮБОЙ, в том числе полностью корректный, результат собственной
# настройки ACL и всегда завершалась отказом.
#
# Правильная маска — только атомарные права именно на ИЗМЕНЕНИЕ, ни одно из
# которых не пересекается с битами чтения/выполнения:
#   WriteData, AppendData, WriteAttributes, WriteExtendedAttributes,
#   Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership
function Get-MyChatDangerousAcl {
    param([Parameter(Mandatory)][string]$Path)

    $allowedSids = @('S-1-5-32-544', 'S-1-5-18')
    $riskyRights = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership

    $acl = Get-Acl -LiteralPath $Path
    $dangerous = @()
    foreach ($rule in $acl.Access) {
        # Deny-записи не разрешают ничего — пропускаем, интересуют только
        # Allow: именно они реально дают право что-то изменить.
        if ($rule.AccessControlType -ne 'Allow') { continue }
        $sid = $null
        try {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        } catch {
            $sid = $rule.IdentityReference.Value
        }
        if ($allowedSids -contains $sid) { continue }
        if (([int]$rule.FileSystemRights -band [int]$riskyRights) -ne 0) {
            $dangerous += "$($rule.IdentityReference) ($sid): $($rule.FileSystemRights)"
        }
    }
    return $dangerous
}
