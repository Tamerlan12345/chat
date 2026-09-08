---
date: 2026-09-07
type: architecture-deployment
project: "[[Projects/MyChat Analog]]"
stack: [Node.js 24, SQLite 3 WAL, WebSockets, Windows Service sc.exe, Firewall, Exponential Backoff]
tags: [architecture, server, deployment, windows-service, networking, connection-lifecycle]
ai-first: true
---

## For future agent
Эта заметка детально описывает жизненный цикл сервера OpenMyChat Enterprise, регламент развертывания в корпоративной инфраструктуре АО «Страховая компания «Сентрас Иншуранс», сетевые порты, алгоритмы подключения клиентов, механизм heartbeat и отказоустойчивое авто-переподключение.

---

## 1. Как поднимать сервер OpenMyChat

Сервер представляет собой легковесный, высокопроизводительный сервис на Node.js 24 LTS с встроенной базой SQLite 3 в режиме Write-Ahead Logging (WAL). Доступны три основных сценария развертывания:

### Сценарий А: Служба Windows (Windows Service) — Продакшн на Windows Server
Для обеспечения непрерывной работы 24/7/365 и автоматического старта при загрузке операционной системы сервер регистрируется как системная служба через штатную утилиту Windows Service Controller (`sc.exe`):

```cmd
:: Установка и автозапуск службы
sc create "MyChatServer" binPath= "C:\Program Files\OpenMyChat\server\mychat-service.exe" start= auto DisplayName= "OpenMyChat Enterprise Communication Service"

:: Настройка политики автоматического восстановления при падении
sc failure "MyChatServer" reset= 86400 actions= restart/5000/restart/10000/restart/60000

:: Запуск службы
net start "MyChatServer"
```

Готовый скрипт развертывания службы включен в поставку дистрибутива: `installer/install-service.bat`.

### Сценарий Б: Демон PM2 или Docker Container — Linux / Виртуализация
В инфраструктуре Linux или микросервисной среде CentOS / Ubuntu:
```bash
# Запуск через менеджер процессов PM2 с кластеризацией и логами
pm2 start server/src/index.js --name "mychat-server" --max-memory-restart 500M
pm2 save
pm2 startup
```

### Сценарий В: Сетевые порты и брандмауэр (Firewall)
Сервер использует единый мультиплексированный порт **2004 TCP** для REST API и полнодуплексного протокола WebSocket. Для разрешения входящего трафика в Windows Defender Firewall выполняется команда:
```cmd
netsh advfirewall firewall add rule name="OpenMyChat Server (Port 2004)" dir=in action=allow protocol=TCP localport=2004 profile=any
```

---

## 2. Как клиенты коннектятся к серверу (Сетевой протокол и Handshake)

> **Исправлено 2026-09-08**: предыдущая версия этой диаграммы описывала
> `POST /api/auth/instant-login` как штатный SSO-механизм. Это был
> беспарольный бэкдор (любой мог получить токен любого сотрудника без
> пароля) — endpoint удалён при аудите безопасности, см.
> [[Architecture/Architecture - Key decisions]] и
> `docs/designs/auth-access-control-remediation.md`. Диаграмма ниже
> отражает реальный, актуальный код.

```mermaid
sequenceDiagram
    autonumber
    actor User as Клиентское приложение (Electron/React)
    participant Srv as MyChat Server (Port 2004)
    participant DB as SQLite WAL (mychat.db)

    Note over User,Srv: Фаза 1: Обнаружение и Проверка узла
    User->>Srv: GET /api/settings/info (Ping Handshake)
    Srv-->>User: 200 OK { version: "2026.1.0", company_name: "АО СК Сентрас Иншуранс" }

    Note over User,Srv: Фаза 2а: Первый вход (логин/пароль)
    User->>Srv: POST /api/auth/login { username, password }
    Srv->>DB: Проверка scrypt-хэша пароля
    DB-->>Srv: Данные пользователя (Роль, Права, UIN)
    Srv-->>User: 200 OK { token: "JWT", user: {...} } (или 429 при переборе)

    Note over User,Srv: Фаза 2б: Повторный запуск на уже привязанном устройстве
    User->>Srv: POST /api/auth/knock { device_id }
    Srv->>DB: Проверка, что device_id уже привязан admin'ом к этому пользователю
    Srv-->>User: 200 OK { token: "JWT" } (только для paired-устройств; без пароля НЕ выдаётся)

    Note over User,Srv: Фаза 3: Установка полнодуплексного WebSocket
    User->>Srv: WS Connect: ws://<host>:2004/ws (без токена в URL)
    User->>Srv: WS message: { type: "auth", token: "JWT" }
    Srv->>Srv: Верификация токена, проверка is_active и must_change_password
    Srv-->>User: WS Event: auth_success { user }
    Srv->>User: Broadcast: user_status_changed { userId, status: "online" }

    Note over User,Srv: Фаза 4: Heartbeat
    loop Каждые 30 секунд
        Srv->>User: WS ping (протокольный, ws.ping())
        User-->>Srv: WS pong
    end
```

---

## 3. Отказоустойчивость и Reconnect

> **Исправлено 2026-09-08**: ниже было описание экспоненциального backoff
> с формулой и джиттером — в коде (`App.jsx`, `initWebSocket`/`ws.onclose`)
> этого нет. Реализация проще: фиксированный повтор через 3 секунды,
> без роста интервала и без джиттера. Это не авария, но для будущего
> агента: если понадобится настоящий backoff (например, чтобы не
   устраивать "громовое стадо" реконнектов сразу у всех клиентов после
> перезапуска сервера), это ещё не сделано — см. концепт-заметку
> по улучшениям от 2026-09-08.

В случае сбоя сети (обрыв кабеля, перезагрузка маршрутизатора, перевод ноутбука в спящий режим):
1. Событие сокета `onclose` переводит UI статус-бара в состояние "Отключено — переподключение".
2. Ровно через 3 секунды клиент вызывает `initWebSocket(authToken)` заново — без изменения интервала при повторных неудачах.
3. При восстановлении линка клиент повторно отправляет `{type: 'auth', token}` и запрашивает актуальные данные через `loadBaseData`.
4. В приложении есть диалог `ServerConnectModal.jsx`, позволяющий сменить адрес сервера и проверить задержку отклика (Latency Ping Meter), с профилями вроде:
   - **Локальный ПК**: `http://localhost:2004`
   - **Centras Офис LAN**: `http://192.168.10.15:2004`
   - **Centras Облако/WAN**: `https://ch.cic.kz:2004`

Связано с:
- [[Architecture/Architecture - Overview]]
- [[Architecture/Architecture - Realtime and WebRTC]]
- [[Architecture/Architecture - Key decisions]]
