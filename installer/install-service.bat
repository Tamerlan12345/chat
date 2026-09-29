@echo off
chcp 65001 > nul
:: ВАЖНО: служба запускается от имени LocalSystem, поэтому и её файлы
:: (server\src\index.js и сам node.exe), и этот сценарий должны лежать в
:: каталоге, недоступном на запись обычным пользователям (не в папке
:: пользователя, не в общей сетевой папке). Иначе тот, кто может туда
:: записать файл, подменит код, который выполняется с правами системы.
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

:: Путь к node.exe — только абсолютный, без поиска по PATH: порядок каталогов
:: в PATH может быть подменён (переменная окружения пользователя или
:: сессии), и служба SYSTEM запустила бы чужой node.exe. Передайте путь
:: первым параметром, если Node.js стоит не в стандартном месте:
::   install-service.bat "D:\nodejs\node.exe"
set "NODE_PATH=%~1"
if "%NODE_PATH%"=="" set "NODE_PATH=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_PATH%" (
    echo [!] node.exe не найден по пути "%NODE_PATH%"
    echo     Укажите правильный путь первым параметром:
    echo       install-service.bat "C:\путь\к\node.exe"
    pause
    exit /b 1
)

set SERVER_JS=%~dp0..\server\src\index.js

echo Путь к Node.js: %NODE_PATH%
echo Путь к серверу: %SERVER_JS%

:: Open port in firewall — только для доменного/частного профиля: с публичной
:: сети (кафе, гостиница) порт 2004 быть виден не должен.
echo Добавление правила в Брандмауэр Windows (порт 2004, домен/частная сеть)...
netsh advfirewall firewall add rule name="MyChat Server (Port 2004)" dir=in action=allow protocol=TCP localport=2004 profile=domain,private >nul 2>&1

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
echo [✓] Порт 2004 открыт в Брандмауэре (домен/частная сеть).
echo [✓] Сервер будет автоматически запускаться при старте Windows.
echo [✓] Панель администрирования: http://localhost:2004/admin
echo =====================================================================
echo.
:: Если сетевой адаптер сервера Windows отнесла к «Общественной» сети
:: (Public), правило брандмауэра на нём не действует. Правило не
:: расширяется на публичный профиль — меняется профиль сети сервера.
echo ВНИМАНИЕ: порт 2004 открыт только в доменной и частной сети. Если сеть
echo сервера отмечена как «Общественная» (Public), клиенты не подключатся.
echo Не расширяйте правило на публичный профиль - смените профиль сети.
echo В PowerShell от имени администратора:
echo   Get-NetConnectionProfile
echo   Set-NetConnectionProfile -InterfaceIndex НОМЕР -NetworkCategory Private
echo (НОМЕР - InterfaceIndex адаптера сервера из вывода первой команды;
echo в домене профиль DomainAuthenticated ставится сам - менять его не нужно.)
pause
