@echo off
chcp 65001 > nul
:: Служба должна запускаться из каталога, недоступного на запись обычным
:: пользователям — см. install-service.bat.
echo =====================================================================
echo   Настройка Брандмауэра Windows для CentyChat Server (Порт 2004 TCP)
echo =====================================================================
:: profile=domain,private — не публичная сеть: сервер компании не должен
:: быть виден с любой сети, к которой подключился ноутбук.
:: Имя правила «MyChat Server (Port 2004)» — идентификатор (по нему правило
:: удаляет uninstall-service.bat), с переименованием в CentyChat не менялось.
netsh advfirewall firewall add rule name="MyChat Server (Port 2004)" dir=in action=allow protocol=TCP localport=2004 profile=domain,private
echo [✓] Правило брандмауэра успешно добавлено (домен/частная сеть).
echo.
:: Если сетевой адаптер сервера Windows отнесла к «Общественной» сети
:: (Public), правило на нём не действует и клиенты не подключатся. Правило
:: не расширяется на публичный профиль — меняется профиль сети сервера.
echo ВНИМАНИЕ: правило действует только в доменной и частной сети. Если сеть
echo сервера отмечена как «Общественная» (Public), клиенты не подключатся.
echo Не расширяйте правило на публичный профиль - смените профиль сети.
echo В PowerShell от имени администратора:
echo   Get-NetConnectionProfile
echo   Set-NetConnectionProfile -InterfaceIndex НОМЕР -NetworkCategory Private
echo (НОМЕР - InterfaceIndex адаптера сервера из вывода первой команды;
echo в домене профиль DomainAuthenticated ставится сам - менять его не нужно.)
pause
