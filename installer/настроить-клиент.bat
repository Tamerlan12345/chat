@echo off
chcp 65001 >nul
title Настройка автообновления OpenMyChat Enterprise

echo ================================================================
echo   Настройка клиента: адрес сервера и канал обновлений
echo ================================================================
echo.
echo Пишет %%ProgramData%%\OpenMyChat Enterprise\client.json - его читает
echo собранный клиент при старте (адрес сервера, включены ли обновления,
echo канал stable/beta). Требуются права администратора.
echo.
echo Примеры запуска из PowerShell (этот bat без параметров запросит
echo только запись текущих/пустых значений):
echo   configure-client.ps1 -ServerUrl https://chat.company.kz
echo   configure-client.ps1 -ServerUrl https://chat.company.kz -Channel beta
echo   configure-client.ps1 -DisableUpdates
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-client.ps1" %*

echo.
pause
