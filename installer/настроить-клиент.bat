@echo off
chcp 65001 >nul
title Настройка автообновления OpenMyChat Enterprise

echo ================================================================
echo   Настройка клиента: адрес сервера и канал обновлений
echo ================================================================
echo.
echo Пишет политику реестра HKLM\SOFTWARE\Policies\OpenMyChat Enterprise -
echo её читает собранный клиент при старте (адрес сервера, включены ли
echo обновления, канал stable/beta). Требуются права администратора.
echo.
echo Примеры запуска (параметры передаются скрипту как есть; без параметров
echo скрипт ничего не меняет, кроме UpdatesEnabled=1, если его ещё нет, и
echo показывает текущую политику):
echo   настроить-клиент.bat -ServerUrl https://chat.company.kz
echo   настроить-клиент.bat -ServerUrl https://chat.company.kz -Channel beta
echo   настроить-клиент.bat -DisableUpdates
echo   настроить-клиент.bat -EnableUpdates
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-client.ps1" %*

echo.
pause
