@echo off
REM Cyrillic text lives in install.ps1, not here: cmd.exe misparses UTF-8
REM bytes in its own command lines regardless of chcp, which broke `title`.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
