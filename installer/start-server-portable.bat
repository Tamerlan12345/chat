@echo off
chcp 65001 > nul
title MyChat Enterprise Server
echo =====================================================================
echo   Запуск сервера MyChat Enterprise в портативном режиме...
echo =====================================================================
cd /d "%~dp0..\server"
node src/index.js
pause
