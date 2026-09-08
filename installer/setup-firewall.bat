@echo off
chcp 65001 > nul
echo =====================================================================
echo   Настройка Брандмауэра Windows для MyChat Server (Порт 2004 TCP)
echo =====================================================================
netsh advfirewall firewall add rule name="MyChat Server (Port 2004)" dir=in action=allow protocol=TCP localport=2004 profile=any
echo [✓] Правило брандмауэра успешно добавлено.
pause
