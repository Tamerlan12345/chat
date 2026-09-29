@echo off
chcp 65001 > nul
echo =====================================================================
echo   Удаление службы CentyChat Server
echo =====================================================================

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Требуются права Администратора!
    pause
    exit /b 1
)

:: Имена службы и правила брандмауэра — прежние идентификаторы, см. install-service.bat.
echo Остановка службы MyChatServer...
sc stop "MyChatServer" >nul 2>&1
echo Удаление службы MyChatServer...
sc delete "MyChatServer" >nul 2>&1

echo Удаление правила брандмауэра...
netsh advfirewall firewall delete rule name="MyChat Server (Port 2004)" >nul 2>&1

echo [✓] Служба CentyChat Server (MyChatServer) и правила брандмауэра успешно удалены.
pause
