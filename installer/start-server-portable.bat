@echo off
chcp 65001 > nul
title CentyChat Server
echo =====================================================================
echo   Запуск сервера CentyChat в портативном режиме...
echo =====================================================================
cd /d "%~dp0..\server"
node src/index.js
pause
