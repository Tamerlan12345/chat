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
; при каждом входе. Имя значения — AppUserModelId приложения: под ним его
; пишет Electron (app.setLoginItemSettings, name по умолчанию).
;
; Переименование OpenMyChat Enterprise -> CentyChat (1.1.0)
; ----------------------------------------------------------
; appId и AppUserModelId остаются com.openmychat.desktop — не менять. Из appId
; electron-builder выводит GUID ключей установки (HKCU\Software\{GUID} с
; InstallLocation и ...\Uninstall\{GUID}). По тому же GUID новый установщик
; находит установленную через Setup.exe версию 1.0.0, запускает её
; деинсталлятор с --updated (тот закрывает запущенную 1.0.0, убирает прежнюю
; папку вместе с «OpenMyChat Enterprise.exe», ярлыки «OpenMyChat
; Enterprise.lnk» и их закрепления, но не данные сотрудника) и ставит
; CentyChat на её место — одной записью в «Установке и удалении программ».
;
; Установку «копией» (installer/install.ps1) шаблон electron-builder не
; видит: у неё своя запись ...\Uninstall\OpenMyChatEnterprise, а в 1.0.0 она
; лежала в %LOCALAPPDATA%\Programs\OpenMyChat Enterprise. Если установки
; через Setup.exe нет, а такая копия есть, она убирается в customInstall:
; закрывается запущенная 1.0.0 (иначе новая версия упёрлась бы в блокировку
; единственного экземпляра — профиль у них общий), удаляются её ярлыки,
; запись и папка. Подробности — docs/автообновление.md, раздел 8.
;
; Автозапуск: деинсталлятор 1.0.0 удаляет значение автозапуска при любом
; удалении, в том числе при обновлении, а приложение прописывает его заново
; только при запуске (autostart.js, applyAutostart при каждом старте). После
; тихой установки (/S) без запуска сотрудник остался бы без автозапуска до
; первого ручного старта, а у копии значение вело бы на удалённый exe.
; Поэтому значение читается до установки (customInit) и, если было,
; переписывается на новый exe (customInstall).
;
; Всё, что меняет систему, — в макросах: их вставляет шаблон внутрь секции
; установки, где подключены LogicLib, FileFunc и плагины. Имена заданы через
; !define /ifndef, чтобы тест (desktop/test/installer-nsh.test.js) подставил
; песочницу вместо настоящего профиля.

!define /ifndef CENTY_AUMID "com.openmychat.desktop"
!define /ifndef CENTY_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define /ifndef CENTY_COPY_ARP_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenMyChatEnterprise"
!define /ifndef CENTY_LEGACY_COPY_DIR "$LOCALAPPDATA\Programs\OpenMyChat Enterprise"
!define /ifndef CENTY_LEGACY_EXE "OpenMyChat Enterprise.exe"
!define /ifndef CENTY_LEGACY_DESKTOP_LNK "$DESKTOP\OpenMyChat Enterprise.lnk"
!define /ifndef CENTY_LEGACY_MENU_LNK "$SMPROGRAMS\OpenMyChat Enterprise.lnk"
!define /ifndef CENTY_LEGACY_UNINSTALLER "Uninstall OpenMyChat Enterprise.exe"

!ifndef BUILD_UNINSTALLER
  ; InstallLocation установки «копией», если установки через Setup.exe нет.
  Var centyLegacyCopyDir
  ; Значение автозапуска до установки (пусто — автозапуск был выключен).
  Var centyRunCommand
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; В .onInit, до удаления прежней версии.
!macro customInit
  Push $0
  Push $1
  ReadRegStr $centyRunCommand HKCU "${CENTY_RUN_KEY}" "${CENTY_AUMID}"
  StrCpy $centyLegacyCopyDir ""
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $0 == ""
  ${andIf} $1 == ""
    ReadRegStr $centyLegacyCopyDir HKCU "${CENTY_COPY_ARP_KEY}" InstallLocation
  ${endIf}
  Pop $1
  Pop $0
!macroend

; В конце секции установки: файлы, запись и ярлыки новой версии уже на месте,
; приложение ещё не запущено.
!macro customInstall
  Push $R0
  Push $R1
  Push $R2

  ; Прежний деинсталлятор в папке установки. На деле не остаётся: в режиме
  ; обновления деинсталлятор 1.0.0 переносит всё содержимое папки, включая
  ; самого себя, в свой $PLUGINSDIR (un.atomicRMDir), а если перенос не
  ; удался — прерывает установку целиком. Удаление одного файла с этим
  ; именем оставлено как безвредная страховка.
  Delete "$INSTDIR\${CENTY_LEGACY_UNINSTALLER}"
  ${GetParent} "$INSTDIR" $R0
  ${if} $R0 != ""
    Delete "$R0\${CENTY_LEGACY_UNINSTALLER}"
  ${endIf}

  ; Установка «копией» 1.0.0 при отсутствии установки через Setup.exe.
  ; Трогается только папка ровно ${CENTY_LEGACY_COPY_DIR} (туда её ставил
  ; install.ps1 версии 1.0.0) и только если там ещё лежит ${CENTY_LEGACY_EXE}.
  ${if} $centyLegacyCopyDir != ""
  ${andIf} $centyLegacyCopyDir == "${CENTY_LEGACY_COPY_DIR}"
  ${andIf} ${FileExists} "$centyLegacyCopyDir\${CENTY_LEGACY_EXE}"
    ; Запущенная 1.0.0 из этой папки закрывается — до запуска новой версии и
    ; до удаления папки (новые файлы лежат в другой папке, им она не мешает).
    ; Путь передаётся через переменную окружения, а не вклеивается в
    ; команду: так его не испортят ни кавычки, ни другие особые символы. Без
    ; PowerShell (заблокирован политикой) — taskkill по имени exe у текущего
    ; пользователя.
    System::Call 'kernel32::SetEnvironmentVariable(t "CENTY_LEGACY_DIR", t "$centyLegacyCopyDir")'
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $$env:CENTY_LEGACY_DIR.TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, 'OrdinalIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0"`
    Pop $R0
    ${if} $R0 != 0
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${CENTY_LEGACY_EXE}" /FI "USERNAME eq %USERNAME%"`
      Pop $R0
    ${endIf}
    Sleep 1000

    ; Ярлыки 1.0.0 — ровно с этим именем: их создавал install.ps1, а
    ; установки через Setup.exe (со своими ярлыками) здесь нет.
    ; UninstShortcut снимает и закрепление на панели задач, иначе оно вело
    ; бы на удалённый exe.
    ${if} ${FileExists} "${CENTY_LEGACY_DESKTOP_LNK}"
      WinShell::UninstShortcut "${CENTY_LEGACY_DESKTOP_LNK}"
      Delete "${CENTY_LEGACY_DESKTOP_LNK}"
    ${endIf}
    ${if} ${FileExists} "${CENTY_LEGACY_MENU_LNK}"
      WinShell::UninstShortcut "${CENTY_LEGACY_MENU_LNK}"
      Delete "${CENTY_LEGACY_MENU_LNK}"
    ${endIf}

    DeleteRegKey HKCU "${CENTY_COPY_ARP_KEY}"

    ; Папка — целиком, если новая установка не в ней самой и не внутри неё
    ; (сотрудник мог выбрать её в окне выбора папки). Иначе убирается только
    ; прежний exe, чтобы по старым ссылкам не запускалась 1.0.0.
    ; Не RMDir /r: он заходит в точки соединения (junction) и стёр бы то, на
    ; что они указывают (проверено тестом installer-nsh). rmdir /s из cmd
    ; удаляет саму ссылку, а не её цель; путь — из той же переменной
    ; окружения, в кавычках, так что особые символы cmd в нём безопасны.
    StrCpy $R1 "$centyLegacyCopyDir\"
    StrLen $R2 $R1
    StrCpy $R0 "$INSTDIR\" $R2
    ${if} $R0 == $R1
      Delete "$centyLegacyCopyDir\${CENTY_LEGACY_EXE}"
    ${else}
      nsExec::Exec `"$SYSDIR\cmd.exe" /d /c rmdir /s /q "%CENTY_LEGACY_DIR%"`
      Pop $R0
    ${endIf}
  ${endIf}

  ; Запись установки «копией», которой больше нет: та же папка теперь
  ; принадлежит этой установке, либо её uninstall.ps1 уже удалён (папку
  ; убрал деинсталлятор 1.0.0). Иначе в «Установке и удалении программ»
  ; осталась бы вторая, нерабочая запись.
  ReadRegStr $R0 HKCU "${CENTY_COPY_ARP_KEY}" InstallLocation
  ${if} $R0 != ""
    ${if} $R0 == $INSTDIR
    ${orIfNot} ${FileExists} "$R0\uninstall.ps1"
      DeleteRegKey HKCU "${CENTY_COPY_ARP_KEY}"
      ${if} $R0 == $INSTDIR
        Delete "$INSTDIR\uninstall.ps1"
        Delete "$INSTDIR\copy-install-common.ps1"
      ${endIf}
    ${endIf}
  ${endIf}

  ${if} $centyRunCommand != ""
    WriteRegStr HKCU "${CENTY_RUN_KEY}" "${CENTY_AUMID}" '"$appExe" --autostart'
  ${endIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "${CENTY_RUN_KEY}" "${CENTY_AUMID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${CENTY_AUMID}"
  ${endIf}
!macroend
