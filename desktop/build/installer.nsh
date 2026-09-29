; NSIS additions (electron-builder includes build/installer.nsh automatically).
;
; customInstallMode: ставим isForceCurrentInstall — обновление всегда идёт
; в тот же профиль (per-user), в котором уже стоит приложение, без диалога
; выбора "для всех пользователей / только для меня". Без этого молчаливое
; автообновление (Задача 9) может упереться в лишний экран.
;
; customUnInstall: очистка автозапуска (HKCU ...\Run) — только при настоящем
; удалении. ${isUpdated} истинно, когда инсталлятор запущен электрон-апдейтером
; поверх уже стоящей версии (сначала удаляет старую, затем ставит новую); в
; этом случае автозапуск удалять нельзя — иначе автообновление на лету гасило
; бы автозапуск при каждом обновлении. При настоящем удалении ${isUpdated}
; ложно, и запись убирается, чтобы Windows не пыталась запускать удалённый exe
; при каждом входе. Имя значения — AppUserModelId приложения, под ним Electron
; и пишет автозапуск.
;
; Переименование OpenMyChat Enterprise -> CentyChat (1.1.0)
; ----------------------------------------------------------
; appId и AppUserModelId остаются com.openmychat.desktop — не менять. Из appId
; electron-builder выводит GUID ключей установки (HKCU\Software\{GUID} с
; InstallLocation и ...\Uninstall\{GUID}). По тому же GUID новый установщик
; находит установленную 1.0.0, запускает её деинсталлятор с --updated (тот
; убирает прежнюю папку вместе с «OpenMyChat Enterprise.exe», ярлыки
; «OpenMyChat Enterprise.lnk» и их закрепления, но не данные сотрудника) и
; ставит CentyChat на её место — одной записью в «Установке и удалении
; программ». Подробности — docs/автообновление.md, раздел 8.
;
; customInstall: прежний деинсталлятор обычно удаляет и сам себя — electron-
; builder запускает его копию из %TEMP%. Если политика запуск из %TEMP%
; запрещает, он запускается прямо из папки установки, и занятый файл
; «Uninstall OpenMyChat Enterprise.exe» остаётся. Убираем его: в папке
; установки (туда ставят тихая установка /S и автообновление) и уровнем выше
; (обычная установка с выбором папки кладёт CentyChat в подпапку прежней
; папки). Другой программы с таким именем файла быть не может.

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  Push $R0
  Delete "$INSTDIR\Uninstall OpenMyChat Enterprise.exe"
  ${GetParent} "$INSTDIR" $R0
  ${if} $R0 != ""
    Delete "$R0\Uninstall OpenMyChat Enterprise.exe"
  ${endIf}
  Pop $R0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.openmychat.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.openmychat.desktop"
  ${endIf}
!macroend
