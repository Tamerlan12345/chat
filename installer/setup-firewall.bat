@echo off
chcp 65001 > nul
:: Служба должна запускаться из каталога, недоступного на запись обычным
:: пользователям — см. install-service.bat.
echo =====================================================================
echo   Настройка Брандмауэра Windows для MyChat Server (Порт 2004 TCP)
echo =====================================================================
:: profile=domain,private — не публичная сеть: сервер компании не должен
:: быть виден с любой сети, к которой подключился ноутбук.
netsh advfirewall firewall add rule name="MyChat Server (Port 2004)" dir=in action=allow protocol=TCP localport=2004 profile=domain,private
echo [✓] Правило брандмауэра успешно добавлено (домен/частная сеть).
pause
