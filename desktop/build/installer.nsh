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
; при каждом входе.

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.openmychat.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.openmychat.desktop"
  ${endIf}
!macroend
