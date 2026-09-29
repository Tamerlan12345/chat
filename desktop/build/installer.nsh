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
; видит: у неё своя запись ...\Uninstall\OpenMyChatEnterprise. Если установки
; через Setup.exe нет, а запись копии указывает на её папку (та же проверка,
; что Test-CentyChatCopyDir в installer/copy-install-common.ps1: прямая
; подпапка %LOCALAPPDATA%\Programs, не ссылка, в ней CentyChat.exe или
; «OpenMyChat Enterprise.exe»), копия — хоть 1.0.0, хоть уже обновлённая
; новым install.ps1 — убирается в customInstall: закрывается запущенное из её
; папки приложение (иначе новая версия упёрлась бы в блокировку единственного
; экземпляра — профиль у них общий), папка удаляется, а запись и прежние
; ярлыки — только после того, как папки не стало. Не удалось освободить
; папку — копия остаётся как была, вместе с записью: её можно удалить штатно.
; Подробности — docs/автообновление.md, раздел 8.
;
; Автозапуск: деинсталлятор 1.0.0 удаляет значение автозапуска при любом
; удалении, в том числе при обновлении, а приложение прописывает его заново
; только при запуске (autostart.js, applyAutostart при каждом старте). После
; тихой установки (/S) без запуска сотрудник остался бы без автозапуска до
; первого ручного старта, а у копии значение вело бы на удалённый exe.
; Поэтому значение читается до установки (customInit) и переписывается на
; новый exe (customInstall) — только если оно вело в прежнюю установку
; (Setup.exe или убранную копию) или в эту папку; чужой путь (например,
; portable) не трогается.
;
; Всё, что меняет систему, — в макросах: их вставляет шаблон внутрь секции
; установки, где подключены LogicLib, FileFunc и плагины. Имена заданы через
; !define /ifndef, чтобы тест (desktop/test/installer-nsh.test.js) подставил
; песочницу вместо настоящего профиля.

!define /ifndef CENTY_AUMID "com.openmychat.desktop"
!define /ifndef CENTY_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define /ifndef CENTY_COPY_ARP_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenMyChatEnterprise"
!define /ifndef CENTY_COPY_PROGRAMS_DIR "$LOCALAPPDATA\Programs"
!define /ifndef CENTY_EXE "CentyChat.exe"
!define /ifndef CENTY_LEGACY_EXE "OpenMyChat Enterprise.exe"
!define /ifndef CENTY_LEGACY_DESKTOP_LNK "$DESKTOP\OpenMyChat Enterprise.lnk"
!define /ifndef CENTY_LEGACY_MENU_LNK "$SMPROGRAMS\OpenMyChat Enterprise.lnk"
!define /ifndef CENTY_LEGACY_UNINSTALLER "Uninstall OpenMyChat Enterprise.exe"

!ifndef BUILD_UNINSTALLER
  ; InstallLocation прежней установки через Setup.exe (HKCU или HKLM).
  Var centyNsisDir
  ; InstallLocation установки «копией» — только если установки через
  ; Setup.exe нет.
  Var centyCopyDir
  ; Что стало с копией: "" — её нет или папка не её; "separate" — убрана;
  ; "nested" — новая установка внутри её папки; "kept" — папку освободить
  ; не удалось, копия оставлена как была.
  Var centyCopyState
  ; Значение автозапуска до установки (пусто — автозапуск был выключен).
  Var centyRunCommand
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; В .onInit (после initMultiUser), до удаления прежней версии.
!macro customInit
  Push $0
  ReadRegStr $centyRunCommand HKCU "${CENTY_RUN_KEY}" "${CENTY_AUMID}"
  StrCpy $centyCopyDir ""
  StrCpy $centyCopyState ""
  ReadRegStr $centyNsisDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $centyNsisDir == ""
    ReadRegStr $centyNsisDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endIf}
  ${if} $centyNsisDir == ""
    ReadRegStr $centyCopyDir HKCU "${CENTY_COPY_ARP_KEY}" InstallLocation
    StrCpy $0 $centyCopyDir 1 -1
    ${if} $0 == "\"
      StrCpy $centyCopyDir $centyCopyDir -1
    ${endIf}
  ${endIf}
  Pop $0
!macroend

; RESULT = 1, если путь PATH лежит внутри папки DIR (без учёта регистра).
; RESULT — не $8 и не $9.
!macro centyInDir _PATH _DIR _RESULT
  Push $9
  Push $8
  StrCpy ${_RESULT} 0
  StrCpy $9 "${_DIR}\"
  StrLen $8 $9
  StrCpy $8 "${_PATH}" $8
  ${if} "${_DIR}" != ""
  ${andIf} $8 == $9
    StrCpy ${_RESULT} 1
  ${endIf}
  Pop $8
  Pop $9
!macroend

; Закрывает приложение (и его процессы Chromium), запущенное из папки
; $centyCopyDir: PowerShell ищет процессы по пути exe. Путь передаётся через
; переменную окружения, а не вклеивается в команду: так его не испортят ни
; кавычки, ни другие особые символы. Удалось ли, видно по тому, освободилась
; ли папка, — код выхода PowerShell этого не говорит.
!macro centyStopCopyApp
  System::Call 'kernel32::SetEnvironmentVariable(t "CENTY_COPY_DIR", t "$centyCopyDir")'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $$env:CENTY_COPY_DIR.TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, 'OrdinalIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0"`
  Pop $R0
  Sleep 1000
!macroend

; Запасной путь, если процессы не закрылись (PowerShell заблокирован
; политикой, WMI недоступен, ConstrainedLanguage): taskkill по имени exe у
; текущего пользователя — тот же продукт, другой сотрудник не затронут.
!macro centyTaskkillApp
  nsExec::Exec `"$SYSDIR\cmd.exe" /d /c taskkill /F /IM "${CENTY_EXE}" /FI "USERNAME eq %USERNAME%"`
  Pop $R0
  nsExec::Exec `"$SYSDIR\cmd.exe" /d /c taskkill /F /IM "${CENTY_LEGACY_EXE}" /FI "USERNAME eq %USERNAME%"`
  Pop $R0
  Sleep 1000
!macroend

; В конце секции установки: файлы, запись и ярлыки новой версии уже на месте,
; приложение ещё не запущено.
!macro customInstall
  Push $R0
  Push $R1
  Push $R2
  Push $R3

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

  ; ── Установка «копией» ────────────────────────────────────────────────
  ${if} $centyCopyDir != ""
  ${andIf} $centyCopyDir != $INSTDIR
    ; Та же проверка, что Test-CentyChatCopyDir: прямая подпапка Programs,
    ; не точка соединения (0x400 — FILE_ATTRIBUTE_REPARSE_POINT; для
    ; несуществующей папки GetFileAttributes даёт -1, и она тоже
    ; отвергается), и в ней exe приложения — файл, а не папка с таким именем.
    ${GetParent} "$centyCopyDir" $R0
    System::Call 'kernel32::GetFileAttributes(t "$centyCopyDir")i .R1'
    IntOp $R1 $R1 & 0x400
    StrCpy $R2 ""
    ${if} ${FileExists} "$centyCopyDir\${CENTY_EXE}"
    ${andIfNot} ${FileExists} "$centyCopyDir\${CENTY_EXE}\*.*"
      StrCpy $R2 "1"
    ${endIf}
    ${if} ${FileExists} "$centyCopyDir\${CENTY_LEGACY_EXE}"
    ${andIfNot} ${FileExists} "$centyCopyDir\${CENTY_LEGACY_EXE}\*.*"
      StrCpy $R2 "1"
    ${endIf}
    ${if} $R0 == "${CENTY_COPY_PROGRAMS_DIR}"
    ${andIf} $R1 == 0
    ${andIf} $R2 == "1"
      !insertmacro centyInDir "$INSTDIR" "$centyCopyDir" $R3
      ${if} $R3 == 1
        StrCpy $centyCopyState "nested"
      ${else}
        StrCpy $centyCopyState "separate"
      ${endIf}
    ${endIf}
  ${endIf}

  ${if} $centyCopyState == "separate"
    !insertmacro centyStopCopyApp
    ; Всё или ничего: папка сначала переименовывается — это удаётся, только
    ; если ни один процесс не держит в ней файлов (запущенный exe, текущая
    ; папка процесса). Не удалось и после taskkill — копия не тронута.
    StrCpy $R3 "$centyCopyDir~centychat-remove"
    ${if} ${FileExists} "$R3\*.*"
      System::Call 'kernel32::SetEnvironmentVariable(t "CENTY_COPY_TRASH", t "$R3")'
      nsExec::Exec `"$SYSDIR\cmd.exe" /d /c rmdir /s /q "%CENTY_COPY_TRASH%"`
      Pop $R0
    ${endIf}
    ClearErrors
    Rename "$centyCopyDir" "$R3"
    ${if} ${Errors}
      !insertmacro centyTaskkillApp
      ClearErrors
      Rename "$centyCopyDir" "$R3"
    ${endIf}
    ${if} ${Errors}
      StrCpy $centyCopyState "kept"
    ${else}
      ; Не RMDir /r: он заходит в точки соединения (junction) и стёр бы то,
      ; на что они указывают (проверено тестом installer-nsh). rmdir /s из
      ; cmd удаляет саму ссылку, а не её цель; путь — из переменной
      ; окружения, в кавычках, так что особые символы cmd в нём безопасны.
      System::Call 'kernel32::SetEnvironmentVariable(t "CENTY_COPY_TRASH", t "$R3")'
      nsExec::Exec `"$SYSDIR\cmd.exe" /d /c rmdir /s /q "%CENTY_COPY_TRASH%"`
      Pop $R0
    ${endIf}
  ${elseIf} $centyCopyState == "nested"
    ; Новая установка внутри папки копии (сотрудник выбрал её в окне выбора
    ; папки): папку не удалить. Убираются exe и скрипт удаления копии —
    ; иначе uninstall.ps1 копии удалил бы папку вместе с новой установкой, —
    ; прочие её файлы остаются.
    !insertmacro centyStopCopyApp
    Delete "$centyCopyDir\${CENTY_EXE}"
    Delete "$centyCopyDir\${CENTY_LEGACY_EXE}"
    ${if} ${FileExists} "$centyCopyDir\${CENTY_EXE}"
    ${orIf} ${FileExists} "$centyCopyDir\${CENTY_LEGACY_EXE}"
      !insertmacro centyTaskkillApp
      Delete "$centyCopyDir\${CENTY_EXE}"
      Delete "$centyCopyDir\${CENTY_LEGACY_EXE}"
    ${endIf}
    Delete "$centyCopyDir\uninstall.ps1"
    Delete "$centyCopyDir\copy-install-common.ps1"
  ${endIf}

  ${if} $centyCopyState == "separate"
  ${orIf} $centyCopyState == "nested"
    ; Ярлыки 1.0.0 — ровно с этим именем: их создавал install.ps1, а
    ; установки через Setup.exe (со своими ярлыками) здесь нет. Ярлык
    ; CentyChat.lnk не трогается — его только что создала эта установка.
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
  ${endIf}

  ; Запись установки «копией», которой больше нет: та же папка теперь
  ; принадлежит этой установке, либо её uninstall.ps1 уже удалён (папку
  ; убрал деинсталлятор 1.0.0). Иначе в «Установке и удалении программ»
  ; осталась бы вторая, нерабочая запись. Копию, которую не удалось
  ; освободить, не трогаем.
  ${if} $centyCopyState != "kept"
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
  ${endIf}

  ; Автозапуск — на новый exe, только если он вёл в эту папку, в прежнюю
  ; установку через Setup.exe или в убранную копию.
  ${if} $centyRunCommand != ""
    StrCpy $R0 $centyRunCommand 1
    ${if} $R0 == '"'
      StrCpy $R0 $centyRunCommand "" 1
    ${else}
      StrCpy $R0 $centyRunCommand
    ${endIf}
    StrCpy $R1 0
    !insertmacro centyInDir "$R0" "$INSTDIR" $R2
    ${if} $R2 == 1
      StrCpy $R1 1
    ${endIf}
    ${if} $centyNsisDir != ""
      !insertmacro centyInDir "$R0" "$centyNsisDir" $R2
      ${if} $R2 == 1
        StrCpy $R1 1
      ${endIf}
    ${endIf}
    ${if} $centyCopyState == "separate"
    ${orIf} $centyCopyState == "nested"
      !insertmacro centyInDir "$R0" "$centyCopyDir" $R2
      ${if} $R2 == 1
        StrCpy $R1 1
      ${endIf}
    ${endIf}
    ${if} $R1 == 1
      WriteRegStr HKCU "${CENTY_RUN_KEY}" "${CENTY_AUMID}" '"$appExe" --autostart'
    ${endIf}
  ${endIf}

  Pop $R3
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
