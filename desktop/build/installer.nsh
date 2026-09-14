; NSIS additions (electron-builder includes build/installer.nsh automatically).
;
; The app registers itself for per-user autostart (HKCU ...\Run) under its
; AppUserModelId. Uninstalling left that value behind, so Windows kept trying
; to launch a deleted exe at every sign-in. Remove it on uninstall; after an
; upgrade the new version re-registers itself on first launch.

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.openmychat.desktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.openmychat.desktop"
!macroend
