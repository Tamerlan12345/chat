@echo off
chcp 65001 > nul
echo =====================================================================
echo   Установка MyChat Enterprise Server как системной службы Windows
echo =====================================================================

:: Check administrator privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Требуются права Администратора!
    echo     Запустите этот файл правой кнопкой мыши -> "Запуск от имени администратора".
    pause
    exit /b 1
)

set NODE_PATH=C:\Program Files\nodejs\node.exe
if not exist "%NODE_PATH%" (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do set NODE_PATH=%%i
)

set SERVER_JS=%~dp0..\server\src\index.js

echo Путь к Node.js: %NODE_PATH%
echo Путь к серверу: %SERVER_JS%

:: Open port in firewall
echo Добавление правила в Брандмауэр Windows (порт 2004)...
netsh advfirewall firewall add rule name="MyChat Server (Port 2004)" dir=in action=allow protocol=TCP localport=2004 profile=any >nul 2>&1

:: Create Windows Service via sc.exe
echo Регистрация службы MyChatServer...
sc stop "MyChatServer" >nul 2>&1
sc delete "MyChatServer" >nul 2>&1

sc create "MyChatServer" binPath= "\"%NODE_PATH%\" \"%SERVER_JS%\"" start= auto DisplayName= "MyChat Enterprise Corporate Server"
sc description "MyChatServer" "Автономный локальный сервер корпоративного мессенджера MyChat с базой данных SQLite WAL"
sc failure "MyChatServer" reset= 86400 actions= restart/5000/restart/10000/restart/60000

echo Запуск службы MyChatServer...
sc start "MyChatServer"

echo =====================================================================
echo [✓] Служба MyChatServer успешно установлена и запущена!
echo [✓] Порт 2004 открыт в Брандмауэре.
echo [✓] Сервер будет автоматически запускаться при старте Windows.
echo [✓] Панель администрирования: http://localhost:2004/admin
echo =====================================================================
pause
