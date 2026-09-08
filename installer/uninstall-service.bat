@echo off
chcp 65001 > nul
echo =====================================================================
echo   Удаление службы MyChat Enterprise Server
echo =====================================================================

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Требуются права Администратора!
    pause
    exit /b 1
)

echo Остановка службы MyChatServer...
sc stop "MyChatServer" >nul 2>&1
echo Удаление службы MyChatServer...
sc delete "MyChatServer" >nul 2>&1

echo Удаление правила брандмауэра...
netsh advfirewall firewall delete rule name="MyChat Server (Port 2004)" >nul 2>&1

echo [✓] Служба MyChatServer и правила брандмауэра успешно удалены.
pause
