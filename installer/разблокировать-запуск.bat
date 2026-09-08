@echo off
chcp 65001 >nul
title Разблокировка приложений Centras Chat

echo ================================================================
echo   Снятие блокировки SmartScreen с дистрибутивов Centras Chat
echo ================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path '%~dp0*.exe' | Unblock-File; Write-Host '✓ Файлы успешно разблокированы!' -ForegroundColor Green"

echo.
echo Теперь вы можете запускать:
echo   - OpenMyChat-Enterprise-Setup.exe
echo   - OpenMyChat-Enterprise-Portable.exe
echo.
echo Если окно SmartScreen все еще появляется:
echo   Нажмите 'Подробнее' -> затем 'Выполнить в любом случае'.
echo.
pause
