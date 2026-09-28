# Безопасность (раунд 3), фильтр файлов, правка/удаление сообщений, автообновление — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть находки аудита безопасности раунда 3, добавить из Rocket.Chat админский фильтр типов файлов и правку/удаление сообщений, и сделать автообновление настольного клиента с собственного сервера компании.

**Architecture:** Сервер — Express 5 + `ws` + `node:sqlite` (переписка) + отдельное хранилище учётных записей (PostgreSQL/SQLite через `server/src/db/identity`). Клиент — Electron (main/preload в `desktop/src/main`, `desktop/src/preload`), интерфейс React раздаётся сервером (`desktop/src/renderer`). Автообновление — electron-updater (generic provider) против маршрутов `/updates/*` нашего сервера, с закреплённой подписью Authenticode.

**Tech Stack:** Node 22+, Express 5, ws 8, multer 2, node:sqlite, pg, Electron 44, electron-builder 26.15.3, React 19, Vite 6, тесты — встроенный `node --test`.

**Источники (читать по ссылкам из задач, не целиком):**
- Аудит: `docs/superpowers/specs/2026-09-28-security-audit-round3.md` (находки #1–#18)
- Автообновление: `docs/superpowers/specs/2026-09-28-autoupdate-design.md`
- Сравнение с Rocket.Chat: `docs/superpowers/specs/2026-09-28-rocketchat-comparison.md`

## Global Constraints

- Весь текст интерфейса, сообщений об ошибках, логов и комментариев — на русском, в стиле окружающего кода (комментарии объясняют «почему», а не «что»).
- Тесты — только встроенный `node --test`. Каждый новый тестовый файл ОБЯЗАТЕЛЬНО добавляется в явный список скрипта `"test"` в `server/package.json` или `desktop/package.json` — иначе он не запускается.
- Сервер: `cd server && npm test` — исходно 221 pass / 1 skipped / 0 fail. Клиент: `cd desktop && npm test` — исходно 202 pass / 0 fail. После каждой задачи оба набора (тот, что задача затронула) — 0 fail.
- HTTP-тесты сервера строятся через `server/test/helpers` (`freshBoot()` и т. п.), по образцу `server/test/http-routes.test.js` и `server/test/security-hardening.test.js`.
- Новые зависимости: только `electron-updater` в `desktop` (Задача 8). На сервере — никаких новых пакетов (YAML пишется своим мини-парсером).
- SQL — только параметризованный. Пути к файлам — никогда не строятся из пользовательского ввода без проверки по белому списку.
- Все административные изменения пишутся в журнал аудита через существующий `AuditService` (по образцу соседних маршрутов).
- Коммиты — на русском, каждый заканчивается строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Ветка `feature/security-autoupdate-rc-parity`; в master не коммитить.
- Платформа — Windows 11; командная оболочка — Git Bash или PowerShell.
- Настройки, которые меняются только через отдельный проверяемый маршрут, добавляются в регулярку `INTERNAL_SETTING` в `server/src/api/index.js` (там же, где уже скрыты внутренние ключи).

---

### Task 1: Устройства — секрет привязан к владельцу, выход отвязывает, knock ограничен

Закрывает находки аудита **#1, #8, #9 (серверная часть)**.

**Files:**
- Modify: `server/src/services/device.service.js` (bind ~181-191, autoMatchByIp ~238-246, knock ~42-100, claim ~268-283)
- Modify: `server/src/services/auth.service.js` (~60-72: выпуск токена по устройству)
- Modify: `server/src/db/identity/schema.js` (оба диалекта: колонки `secret_user_id`, `secret_expires_at` в `device_pairings`, миграция для существующих баз)
- Modify: `server/src/api/index.js` (`/auth/knock` ~229-246; новый `POST /api/auth/device/unbind`)
- Modify: `desktop/src/renderer/src/App.jsx` (выход вызывает unbind; ~452-462, ~558)
- Test: `server/test/device-security.test.js` (новый; добавить в `server/package.json`)

**Interfaces:**
- Produces: `POST /api/auth/device/unbind` (requireAuth; тело `{ device_id }`) → 200 `{ ok: true }`; очищает `secret_hash`, `secret_token_version`, `secret_user_id` для этого устройства, если оно привязано к вызывающему.

**Требования:**
1. При любой смене `user_id` в `device_pairings` (bind, autoMatchByIp, любой `ON CONFLICT … DO UPDATE SET user_id`) — `secret_hash=NULL, secret_token_version=NULL, secret_user_id=NULL`.
2. `claimDeviceSecret` пишет `secret_user_id = user_id` и `secret_expires_at = now + DEVICE_SECRET_TTL_DAYS` (новая настройка в `server/src/config/index.js`, по умолчанию 30).
3. `knock` выдаёт токен, только если `secret_user_id === pairing.user_id`, секрет не истёк и `secret_token_version` совпадает; иначе `login_required`.
4. Токен по устройству НЕ обновляет `auth_time`: переносится исходный `auth_time` из момента `claim` (хранить `secret_auth_time` или использовать время claim), так что `SESSION_MAX_DAYS` действует.
5. `/auth/knock`: длины `device_id` ≤ 128, `device_name` ≤ 128, `platform` ≤ 64, `client_version` ≤ 32 (обрезать или 400); не больше 20 записей `pending_devices` с одного IP (сверх — 429 без вставки) и не больше 5000 всего; уведомление админам (`broadcastToAdmins`) не чаще раза в 10 секунд на IP. При старте сервера удалять `pending_devices` старше 30 дней.
6. `token_version` не отдаётся ограниченным (scoped) администраторам в `GET /api/admin/users` (`user.service.js:16-19,85`).
7. Клиент: «Выход» вызывает `POST /api/auth/device/unbind` (ошибка сети не блокирует выход) и удаляет секрет из `localStorage`.

**Тест-кейсы (`server/test/device-security.test.js`):**
- claim секрета пользователем A → перепривязка устройства к B → knock со старым секретом → `login_required`.
- claim A → knock → токен A, у которого `auth_time` равен времени claim, а не текущему.
- секрет с истёкшим `secret_expires_at` → `login_required`.
- unbind → knock с тем же секретом → `login_required`; unbind чужого устройства → секрет не очищается.
- 21-й knock с новым `device_id` с одного IP → 429, строк в `pending_devices` — 20.
- `device_name` длиной 10 000 символов → в базе ≤ 128 (или 400).
- scoped-админ получает список пользователей без поля `token_version`; супер-админ — с полем.

- [ ] Step 1: написать тесты, запустить `cd server && node --test test/device-security.test.js` — падают
- [ ] Step 2: реализовать требования 1–6 на сервере, требование 7 на клиенте
- [ ] Step 3: `node --test test/device-security.test.js` — проходят; затем `npm test` — 0 fail
- [ ] Step 4: коммит `Устройства: секрет привязан к владельцу, выход отвязывает, knock ограничен`

---

### Task 2: Границы полномочий — scoped-админ, адресные оповещения, приватные каналы

Закрывает находки аудита **#2, #3, #4, #10, #11**.

**Files:**
- Modify: `server/src/api/index.js` (`assertWithinAdminScope` ~182-202; создание оповещения ~1088-1095; подтверждение ~1102-1116; журнал подтверждений ~1123; `POST /channels` ~1244-1257; импорт ~1494-1502)
- Modify: `server/src/services/org-parser.service.js` (`applyImport` ~314-316, ~381-407)
- Modify: `server/src/services/announcement.service.js` (новая функция получателей; проверка при подтверждении)
- Modify: `server/src/ws/server.js` (если нужна функция адресной рассылки)
- Test: `server/test/scope-containment.test.js` (новый; добавить в `server/package.json`)

**Interfaces:**
- Produces: `AnnouncementService.getRecipientIds(announcement) → Promise<number[]>` (та же логика видимости, что в `getAnnouncementsForUser`); `AnnouncementService.isVisibleTo(announcementId, userId) → Promise<boolean>`.

**Требования:**
1. `assertWithinAdminScope`: если в теле есть ключ `admin_scope_dept_id` (`'admin_scope_dept_id' in payload`) и действующий не супер-админ → 403, при любом значении (включая `null`).
2. `applyImport`: если действующий — scoped-админ, корень области обязателен (нет области → 403/ошибка без изменений); ветка обновления существующего пользователя отказывает для супер-админов/админов и для пользователей вне области, и не переносит пользователя за пределы области. Проверки те же, что в `assertWithinAdminScope`.
3. Создание оповещения и чтение журнала подтверждений: разрешено только `isSuperAdmin(req.user) || permissions.can_broadcast`. Scoped-админ с `can_broadcast` видит журнал только своих оповещений.
4. Новое оповещение: при `target_type === 'all'` — `broadcast` как раньше; иначе — `sendToUser` каждому из `getRecipientIds` (плюс автору). Полный текст никогда не уходит неадресатам.
5. Подтверждение ознакомления: 404, если оповещение не существует, 403 — если не адресовано пользователю; только для реальной записи — событие в сокеты (адресатам и автору, не всем).
6. `POST /channels` с `type:'private'`: событие `channel_created` — только первоначальным участникам.

**Тест-кейсы (`server/test/scope-containment.test.js`):**
- scoped-админ `PUT /api/admin/users/<свой id> {admin_scope_dept_id:null}` → 403; область не изменилась.
- scoped-админ импортирует строку, совпадающую с пользователем вне области → пользователь не изменён; с супер-админом → не изменён.
- scoped-админ с `can_broadcast:false` → 403 на создание оповещения и на журнал подтверждений.
- оповещение с `target_type:'users', target_ids:[B]` → сокет C не получает `new_announcement`; B получает.
- подтверждение несуществующего id → 404; подтверждение не адресованного → 403, строки подтверждения нет.
- приватный канал с участниками [A,B] → сокет C не получает `channel_created`.

- [ ] Step 1: тесты → падают
- [ ] Step 2: реализация 1–6
- [ ] Step 3: тесты → проходят; `npm test` → 0 fail
- [ ] Step 4: коммит `Полномочия: scoped-админ не выходит за область, адресные оповещения и приватные каналы не утекают`

---

### Task 3: Проверка ввода, пределы размеров, старые токены, /health, scrypt, права ролей

Закрывает находки аудита **#5, #7, #12, #16, #17, #18**.

**Files:**
- Modify: `server/src/services/user.service.js` (`updateProfile` ~179-219)
- Modify: `server/src/services/message.service.js` (`sendMessage` ~216-219)
- Modify: `server/src/ws/server.js` (`MAX_MESSAGE_BYTES` ~14, разбор ~297, лимит ~307)
- Modify: `server/src/services/auth.service.js` (старые токены ~112-116; блокировка ~280-299)
- Modify: `server/src/app.js` (`/health` ~164-171)
- Modify: `server/src/db/identity/password.js` (~12)
- Modify: `server/src/api/index.js` (`PUT /admin/roles/:id` ~595-637)
- Modify: `server/src/db/identity/index.js` (~117-155 автоимпорт), `server/src/config/index.js`
- Test: `server/test/input-limits.test.js` (новый; добавить в `server/package.json`)

**Interfaces:**
- Produces: `MessageService.MAX_TEXT_LENGTH = 16000` (экспортируемая константа; Задача 7 использует её при правке).

**Требования:**
1. Профиль (сам пользователь): `full_name` и `job_title` через `PUT /api/users/profile` больше НЕ меняются (игнорировать или 403 — меняет только админ, пункт плана 1.8.3); `email` ≤ 254 и формат `^[^\s@]+@[^\s@]+\.[^\s@]+$`; `phone` ≤ 32 и только `[0-9+()\-\s]`. Нарушение → 400 с русским сообщением. В админском обновлении пользователя — те же пределы плюс `full_name`/`job_title` ≤ 120.
2. Текст сообщения ≤ `MAX_TEXT_LENGTH` символов; больше → ошибка «Сообщение слишком длинное (не больше 16000 символов)».
3. WS: кадр больше 256 KB отклоняется до `JSON.parse` для всех типов, кроме тех, где большие кадры нужны (проверить `rd_*`, `ice_candidate`, `call_*`: для них оставить текущий предел). Реализация: сначала проверка размера `Buffer.byteLength`, общий предел — 256 KB, исключения — по префиксу типа через дешёвую проверку подстроки `"type":"rd_` до разбора, либо разбор только после проверки размера для обычных кадров.
4. Старые токены (`exp > 1e11`) отклоняются, если текущая дата позже `LEGACY_TOKEN_CUTOFF` (config, по умолчанию `2026-10-15T00:00:00Z`).
5. Блокировка входа: вместо жёсткой блокировки учётной записи — задержка по IP+имени (как было задумано в пункте плана 1.7): после `LOGIN_MAX_FAILED_ATTEMPTS` учётная запись НЕ блокируется для других IP; блокируется только пара IP+имя. При блокировке учётной записи администратора — событие в центр безопасности (существующий `security-monitor`).
6. `/health`: анонимному запросу — только `{ status }`; `version`, `identityStore`, `uptime` — только с действующим токеном супер-админа.
7. scrypt: `N = 131072` (2^17); существующее перехеширование при входе переводит старые хеши. Проверить, что `maxmem` достаточен (`128 * N * r * 2`).
8. Права ролей: `PUT /admin/roles/:id` принимает только известные ключи (`is_admin`, `is_scoped_admin`, `can_broadcast`, `can_create_channels`, `can_upload_files` и все прочие, уже используемые в коде — собрать по `permissions.` в `server/src`), только булевы значения; иначе 400.
9. Автоимпорт из `identity.db` / `pre-identity-split.db` в пустое хранилище — только при `IDENTITY_AUTO_IMPORT=true`; без флага — предупреждение в лог и отказ.

**Тест-кейсы (`server/test/input-limits.test.js`):**
- `PUT /api/users/profile {full_name:'Директор'}` → имя не изменилось.
- `email:'x'` → 400; `phone:'abc'` → 400; `email` 300 символов → 400.
- сообщение 16 001 символ → ошибка; 16 000 → доставлено.
- WS-кадр 300 KB типа `send_message` → соединение получает ошибку/закрывается, сообщение не сохранено.
- токен с `exp` в миллисекундах после отсечки → 401.
- 11 неудачных входов с IP1 для `admin` → вход с IP2 верным паролем проходит.
- анонимный `GET /health` → ключей только `status`.
- хеш нового пароля содержит параметр N=131072 (по формату строки хеша в `password.js`).
- `PUT /admin/roles/:id {permissions:{is_god:true}}` → 400; `{can_broadcast:'yes'}` → 400.

- [ ] Step 1: тесты → падают
- [ ] Step 2: реализация 1–9
- [ ] Step 3: тесты → проходят; `npm test` → 0 fail (старые тесты, завязанные на жёсткую блокировку или `/health`, привести в соответствие новой политике, не ослабляя)
- [ ] Step 4: коммит `Проверка ввода и пределы: профиль, длина сообщений, кадры WS, старые токены, /health, scrypt, права ролей`

---

### Task 4: Клиент — закрытое меню и DevTools, скачивания под контролем, имя файла из хранилища, CI

Закрывает находки аудита **#6 (клиентская часть), #9 (хранение токена — частично), #13, #14, #15**.

**Files:**
- Modify: `desktop/src/main/main.js` (меню, DevTools, `session.on('will-download')`)
- Modify: `desktop/package.json` (`electronFuses.grantFileProtocolExtraPrivileges: false`)
- Create: `desktop/src/main/download-guard.js` (чистый модуль)
- Reuse: `desktop/src/main/received-file.js` (список опасных расширений, запись Zone.Identifier)
- Modify: `desktop/src/renderer/src/components/ChatView.jsx` (~241-266: имя скачивания)
- Modify: `server/src/services/message.service.js` или выдача сообщений — у файловых сообщений в ответе есть `file_original_name` (из таблицы `files`), если его ещё нет в `metadata_json`
- Modify: `.github/workflows/security.yml`
- Modify: `installer/install-service.bat`, `installer/setup-firewall.bat`
- Test: `desktop/test/download-guard.test.js` (новый; добавить в `desktop/package.json`)

**Interfaces:**
- Produces: `download-guard.js`: `safeDownloadName(name) → string` (снимает управляющие символы, U+202E/U+202A–U+202E/U+2066–U+2069, завершающие точки/пробелы, зарезервированные имена Windows; опасное расширение → добавляется `.txt`… ИЛИ переиспользует правило из `received-file.js` — взять именно его, не изобретать второе); `isDangerousExtension(name) → boolean`.

**Требования:**
1. В собранной сборке: `Menu.setApplicationMenu(null)`; `webContents.on('devtools-opened', () => webContents.closeDevTools())` для всех окон; сочетания F12/Ctrl+Shift+I не открывают DevTools (`before-input-event`). В разработке — без изменений.
2. `electronFuses.grantFileProtocolExtraPrivileges: false`.
3. `session.defaultSession.on('will-download', (e, item) => …)`: имя через `safeDownloadName`; опасное расширение → системный диалог подтверждения (как в пути удалённого стола); после завершения — Zone.Identifier (`ZoneId=3`), как в `received-file.js`.
4. `ChatView.jsx`: имя скачивания — исходное имя файла из хранилища (`metadata.original_name` / `file_original_name`), а не `m.text`.
5. CI: аудит desktop без `--omit=dev` (Electron — это поставляемая среда); `npm ci --ignore-scripts` там, где сборка не нужна; действия закреплены по SHA с комментарием-тегом.
6. `install-service.bat`: абсолютный путь к `node.exe` (параметр или `%ProgramFiles%\nodejs\node.exe` с проверкой существования), правило брандмауэра `profile=domain,private`; то же в `setup-firewall.bat`. В начале файла комментарий: служба должна запускаться из каталога, недоступного на запись обычным пользователям.

**Тест-кейсы (`desktop/test/download-guard.test.js`):**
- `'отчёт‮fdp.exe'` → нет U+202E в результате, считается опасным.
- `'invoice.pdf.exe'` → опасное; `'report.pdf'` → нет.
- `'CON.txt'`, `'file. '` → безопасное имя без зарезервированного/хвоста.
- поддельный `electron` не нужен — модуль чистый.
- статическая проверка: `package.json` содержит `grantFileProtocolExtraPrivileges: false`; `main.js` содержит `setApplicationMenu(null)` и `will-download` (чтение файла как текста, по образцу существующих `main-guards.test.js`).

- [ ] Step 1: тесты → падают
- [ ] Step 2: реализация 1–6
- [ ] Step 3: `cd desktop && npm test` → 0 fail; `cd server && npm test` → 0 fail
- [ ] Step 4: коммит `Клиент: закрыты DevTools и меню, скачивания проверяются, имя файла из хранилища; CI и служба`

---

### Task 5: Фильтр типов файлов — настраивает только администратор (для всех и для конкретных сотрудников)

Функция из Rocket.Chat (File Upload → Accepted Media Types), расширенная по требованию владельца: разрешённые типы задаются глобально и дополнительно для отдельных сотрудников. Закрывает серверную часть находки **#6**.

**Files:**
- Create: `server/src/services/file-policy.service.js`
- Modify: `server/src/api/index.js` (`/files/upload` ~1318; новые маршруты; `INTERNAL_SETTING`)
- Modify: `server/src/services/file.service.js` (проверка сигнатуры содержимого до `rename`)
- Create: `desktop/src/renderer/src/components/FilePolicyAdmin.jsx`
- Create: `desktop/src/renderer/src/lib/file-policy.mjs` (чистые функции для клиента)
- Modify: `desktop/src/renderer/src/components/AdminUserModal.jsx` (вкладка «Файлы», только супер-админ)
- Modify: `desktop/src/renderer/src/components/ChatView.jsx` (предпроверка при выборе файла, `accept` у `<input type=file>`)
- Test: `server/test/file-policy.test.js`, `desktop/test/file-policy.test.mjs` (новые; добавить в оба `package.json`)

**Interfaces:**
- Produces:
  - Настройка `file_policy` (JSON в `server_settings`, внутренняя): `{ "enabled": true, "allowed": ["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","csv","rtf","odt","ods","png","jpg","jpeg","gif","webp","bmp","zip","7z","rar","mp3","wav","ogg","m4a","mp4","webm","mov","eml","msg","xml","json"], "perUser": { "<userId>": ["exe","msi"] }, "maxPerUserEntries": 50 }` — значение `allowed` выше и есть значение по умолчанию при отсутствии настройки.
  - `FilePolicyService.getPolicy()`, `FilePolicyService.setPolicy(draft, actor)`, `FilePolicyService.effectiveAllowed(userId) → string[]`, `FilePolicyService.check({ userId, originalName, headBytes }) → null | { code, message }`.
  - `GET /api/files/policy` (requireAuth) → `{ enabled, allowed: string[] }` — действующий список для вызывающего.
  - `GET /api/admin/file-policy` / `PUT /api/admin/file-policy` (только супер-админ; аудит `file_policy_changed` с разницей).
- Consumes: `received-file.js`-подобный список опасных расширений не нужен на сервере — политика «разрешено только то, что в списке».

**Требования:**
1. Расширение — по последней точке, в нижнем регистре, без точки; имя с U+202E/U+2066–U+2069 или управляющими символами → отказ `name-invalid`; нет расширения → отказ `ext-missing` (если в списке нет пустой строки — пустую строку разрешать нельзя).
2. `enabled:false` → проверка расширения выключена (прежнее поведение), но проверка имени (п. 1, кроме `ext-missing`) и сигнатуры (п. 3) остаются.
3. Сигнатура содержимого: для `png` (`89 50 4E 47`), `jpg/jpeg` (`FF D8 FF`), `gif` (`GIF8`), `webp` (`RIFF....WEBP`), `pdf` (`%PDF`), `zip/docx/xlsx/pptx/odt/ods` (`PK\x03\x04`), `exe/msi/dll` (`MZ` для exe/dll, `D0 CF 11 E0` для msi) — несовпадение → отказ `content-mismatch` «Содержимое файла не соответствует расширению». Любой файл, начинающийся с `MZ`, при расширении не из {exe, dll, sys, scr, com} → `content-mismatch` (переименованный исполняемый).
4. Проверка выполняется на сервере после приёма во временный файл и ДО `rename`; при отказе временный файл удаляется, ответ 415 `{ error, code }`.
5. Действующий список пользователя = `allowed ∪ perUser[userId]`. Проверка черновика политики: расширения по `^[a-z0-9]{1,10}$`, не больше 200 в `allowed`, ключи `perUser` — id существующих активных пользователей, не больше 50 записей на пользователя; иначе 400.
6. `file_policy` — во `INTERNAL_SETTING`: общий `PUT /api/admin/settings` его не меняет.
7. Вкладка «Файлы» (супер-админ): переключатель «Фильтр включён»; список разрешённых для всех (метки с удалением и поле добавления; кнопка «Вернуть по умолчанию»); раздел «Исключения для сотрудников»: выбор сотрудника из справочника и его дополнительные расширения; предупреждение красным, если в любом списке есть `exe`, `msi`, `bat`, `cmd`, `ps1`, `vbs`, `js`, `scr`, `com`, `dll`, `lnk`, `hta`.
8. Клиент при выборе файла вызывает `GET /api/files/policy` (кэш на сеанс, сброс при 415) и сразу показывает понятную ошибку, не отправляя файл; `accept` у поля выбора — из списка.

**Тест-кейсы:**
- Сервер (`server/test/file-policy.test.js`): по умолчанию `report.pdf` с `%PDF` → 200; `tool.exe` → 415 `ext-not-allowed`; `photo.png` с байтами `MZ` → 415 `content-mismatch`; `a‮fdp.exe` → 415 `name-invalid`; админ добавил `exe` для пользователя A → A загружает `tool.exe` (`MZ`) → 200, B → 415; `enabled:false` → `data.bin` → 200, но `x.png` с `MZ` → 415; `PUT /api/admin/settings {file_policy:…}` → 400; scoped-админ `PUT /api/admin/file-policy` → 403; `allowed:['../x']` → 400; после отказа во временной папке нет файла; `GET /api/files/policy` для A содержит `exe`, для B — нет.
- Клиент (`desktop/test/file-policy.test.mjs`): `extensionOf('A.PDF') === 'pdf'`; `checkName` ловит U+202E; `isRiskyExtension('ps1') === true`; `acceptAttr(['pdf','png']) === '.pdf,.png'`.

- [ ] Step 1: тесты → падают
- [ ] Step 2: сервер (1–6), затем интерфейс (7–8)
- [ ] Step 3: оба набора → 0 fail; `cd desktop && npm run build` проходит
- [ ] Step 4: коммит `Фильтр файлов: разрешённые типы задаёт администратор — для всех и для отдельных сотрудников`

---

### Task 6: Правка и удаление своих сообщений

Функция из Rocket.Chat (Message → Allow Message Editing / Deleting, Block Editing After N minutes, Keep History).

**Files:**
- Modify: `server/src/db/index.js` (новая таблица `message_history`; колонки `messages.updated_at`, `messages.is_deleted` уже есть)
- Modify: `server/src/services/message.service.js` (`editMessage`, `deleteMessage`; выдача удалённых без текста; превью ответа на удалённое)
- Modify: `server/src/ws/server.js` (типы `edit_message`, `delete_message`; записи в `RATE_LIMITS`)
- Modify: `server/src/services/file.service.js` (`canUserAccessFile` и `getRecentFiles` игнорируют удалённые сообщения)
- Modify: `desktop/src/renderer/src/components/ChatView.jsx`, `desktop/src/renderer/src/App.jsx` (обработка событий, меню сообщения, режим правки)
- Modify: `desktop/src/renderer/src/components/AdminUserModal.jsx` (две настройки в существующем разделе общих настроек)
- Create: `desktop/src/renderer/src/lib/message-actions.mjs`
- Test: `server/test/message-edit-delete.test.js`, `desktop/test/message-actions.test.mjs` (новые; добавить в оба `package.json`)

**Interfaces:**
- Consumes: `MessageService.MAX_TEXT_LENGTH` (Задача 3).
- Produces:
  - Таблица `message_history (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, action TEXT NOT NULL /* 'edit'|'delete' */, old_text TEXT, old_metadata_json TEXT, actor_id INTEGER NOT NULL, created_at TEXT NOT NULL)`.
  - `MessageService.editMessage({ messageId, actorId, text }) → Promise<message>`; `MessageService.deleteMessage({ messageId, actorId, isSuperAdmin }) → Promise<{ id, conversation_type, target_id, sender_id }>`.
  - WS от клиента: `{ type:'edit_message', messageId, text }`, `{ type:'delete_message', messageId }`. От сервера тем же получателям, что и при отправке: `{ type:'message_updated', message }`, `{ type:'message_deleted', messageId, conversationType, targetId }`. Ошибки: `{ type:'error', context:'edit_message'|'delete_message', message }`.
  - Настройки (обычные, не внутренние): `message_edit_window_minutes` (по умолчанию `60`), `message_delete_window_minutes` (по умолчанию `60`); `0` — без ограничения; `-1` — действие выключено.

**Требования:**
1. Править можно только своё, не удалённое сообщение типа `text`, в пределах окна; новый текст не пустой и ≤ `MAX_TEXT_LENGTH`; ставится `updated_at`; старый текст пишется в `message_history`.
2. Удалять можно своё сообщение в пределах окна; супер-админ — любое и без окна (модерация, аудит `message_deleted_by_admin`). Удаление: `is_deleted=1`, `text=''`, `metadata_json=NULL`; старые текст и метаданные — в `message_history`.
3. Выдача сообщений (история, поиск, превью ответа) — у удалённых `text=''`, `is_deleted=1`, без метаданных; поиск удалённые не находит.
4. После удаления сообщения с вложением доступ к файлу у получателей пропадает (у загрузившего — остаётся), если нет других неудалённых ссылок.
5. Интерфейс: у своих сообщений в меню — «Изменить» (текст в поле ввода, Enter — сохранить, Esc — отмена) и «Удалить» (через `ConfirmDialog`); пункты скрыты, если окно истекло или действие выключено (сервер всё равно проверяет); у изменённых — пометка «изменено» с временем в подсказке; удалённое показывается строкой «Сообщение удалено» курсивом.
6. Настройки двух окон — в админской панели (общие настройки), подписи «Изменять сообщение можно (минут, 0 — всегда, −1 — нельзя)» и то же для удаления.

**Тест-кейсы:**
- Сервер: правка своего → `message_updated` у обоих участников ЛС, `updated_at` задан, запись в `message_history` со старым текстом; правка чужого → ошибка; правка после окна (подменить `created_at` в базе) → ошибка; правка удалённого → ошибка; правка на 16 001 символ → ошибка; удаление своего → `message_deleted` участникам канала, в истории выдачи `text===''`; удаление чужого пользователем → ошибка; супер-админ удаляет чужое → ок, запись аудита; окно `-1` → правка отклонена; после удаления сообщения с файлом получатель не скачивает файл (403), загрузивший — скачивает; ответ на удалённое сообщение не показывает его текст.
- Клиент (`message-actions.mjs`): `canEdit(msg, {me, now, windowMin})` — чужое/удалённое/не text/истекло/`-1` → false, `0` → true; `canDelete` аналогично; `applyUpdate(list, message)` заменяет по id; `applyDelete(list, id)` ставит `is_deleted` и очищает текст.

- [ ] Step 1: тесты → падают
- [ ] Step 2: сервер (1–4), интерфейс (5–6)
- [ ] Step 3: оба набора → 0 fail; `cd desktop && npm run build` проходит
- [ ] Step 4: коммит `Сообщения: правка и удаление своих, история изменений, окна времени задаёт администратор`

---

### Task 7: Автообновление — сервер: хранилище релизов, политика, маршруты /updates, админский API

Спецификация: `docs/superpowers/specs/2026-09-28-autoupdate-design.md`, разделы «Конфигурация → Сервер», «Настройка сервера update_policy», «Контракты маршрутов», «Проверка релиза», «Сервер — файлы». Значения (регулярки, заголовки, коды, пределы) брать оттуда дословно.

**Files:**
- Modify: `server/src/config/index.js`
- Create: `server/src/services/update-store.service.js`, `server/src/services/update-policy.service.js`, `server/src/updates/router.js`
- Modify: `server/src/app.js` (монтирование `/updates` после ready-gate и IP-фильтра, ДО статики и UA-фильтра)
- Modify: `server/src/api/index.js` (`/api/admin/updates*`, `update_policy` в `INTERNAL_SETTING`)
- Modify: `server/src/db/identity/schema.js` (таблица `client_installs`, оба диалекта)
- Test: `server/test/update-store.test.js`, `server/test/update-policy.test.js`, `server/test/update-routes.test.js` (новые; добавить в `server/package.json`); дополнить `server/test/ip-access.test.js` (маршруты `/updates/*` под `ALLOWED_CLIENT_IPS`)

**Interfaces:**
- Produces: HTTP-контракты из спецификации (их использует Задача 9 на клиенте и Задача 10 в интерфейсе); `UpdatePolicyService.compareVersions(a, b) → -1|0|1` — тот же алгоритм, что в клиентском `update-policy.js` (Задача 9), общий набор векторов проверки: `['1.0.0','1.0.1',-1]`, `['1.10.0','1.9.0',1]`, `['1.2.0-beta.1','1.2.0',-1]`, `['1.2.0-beta.2','1.2.0-beta.10',-1]`, `['1.2.0','1.2.0',0]`.

**Тест-кейсы (из спецификации):**
- store: корректный импорт из каталога и из загрузки (тестовый «exe» = `MZ` + заполнитель, yml строит тест); несовпадение sha512 → отказ с текстом про переподпись; несовпадение размера, не-`MZ`, неверная версия, повтор версии (409); имена с `../`, `..\\`, `%2e%2e`, абсолютные пути, NUL, слишком длинные, не соответствующие версии; неудачный импорт не оставляет tmp и частичного релиза; индекс находит blockmap старой версии; удаление версии, являющейся target, → отказ; `readYml` отвергает неожиданную форму, `renderYml` → `readYml` даёт исходное.
- policy: корзина детерминирована; из 10 000 случайных id при 25% подходят 25% ± 3; раздача 0 → только обход по minVersion, 100 → все; minVersion обходит корзину; выключено (политика или env) → ничего; нет installId → корзина 99; ошибки проверки политики; общие векторы `compareVersions`.
- routes (через `freshBoot`): `policy.json` и `latest.yml` → 200, `text/yaml`, `no-store`; 404 при выключении/без релизов/без права; файл → 200 с `immutable`, `Range: bytes=0-9` → 206; неизвестное имя и варианты обхода пути → 404; запрос с UA без «Electron» доходит до `/updates` (не съедается фильтром статики); предел одновременных скачиваний → 503; админские маршруты: без токена 401, обычный пользователь и scoped-админ 403, супер-админ 200; загрузка multipart (через `FormData`/`Blob`) — счастливый путь и превышение размера → 413; `PUT` политики с ошибками → 400; записи аудита `update_policy_changed`, `update_release_imported`; `PUT /api/admin/settings` с `update_policy` → 400; запись `client_installs` троттлится, предел строк соблюдается.

- [ ] Step 1: тесты → падают
- [ ] Step 2: config → store → policy → router → admin API → schema
- [ ] Step 3: тесты → проходят; `npm test` → 0 fail
- [ ] Step 4: коммит `Автообновление, сервер: релизы, политика раздачи, маршруты /updates и админский API`

---

### Task 8: Автообновление — сборка и подпись клиента

Спецификация: раздел «Сборка / подпись / публикация» в `docs/superpowers/specs/2026-09-28-autoupdate-design.md`.

**Files:**
- Modify: `desktop/package.json` (`electron-updater` в `dependencies` с точной версией, `build.publish`, `publisherName`, `verifyUpdateCodeSignature`, `artifactName` для nsis и portable, `--publish never` во всех вызовах `electron-builder`, скрипт `publish:update`)
- Modify: `desktop/build/installer.nsh` (макросы `customInstallMode` и `customUnInstall` с `${ifNot} ${isUpdated}` — дословно из спецификации)
- Modify: `desktop/scripts/sign-and-publish.ps1` (новые имена; не переподписывать уже подписанное закреплённым отпечатком; проверка `publisherName` в `release/win-unpacked/resources/app-update.yml`)
- Create: `desktop/scripts/publish-update.ps1`
- Test: `desktop/test/build-config.test.js` (новый; добавить в `desktop/package.json`)

**Interfaces:**
- Produces: имена артефактов `OpenMyChat-Enterprise-Setup-<version>.exe`, `OpenMyChat-Enterprise-Setup-<version>.exe.blockmap`, `OpenMyChat-Enterprise-Portable-<version>.exe`, `latest.yml` — их ожидает серверная проверка из Задачи 7.

**Требования:**
1. Версию `electron-updater` выбрать совместимую с `electron-builder@26.15.3` (та же линейка `builder-util-runtime`, проверить `npm ls builder-util-runtime`), установить `npm install electron-updater@<точная> --save-exact`.
2. Убедиться по исходнику установленного `electron-updater` (`node_modules/electron-updater/out/NsisUpdater.js`), что сеттер `verifyUpdateCodeSignature` существует, и записать в отчёт точную сигнатуру — Задача 9 от неё зависит.
3. Поднять `version` в `desktop/package.json` до `1.1.0` (первая оболочка с автообновлением).
4. Сборку (`npm run dist`) запускать НЕ обязательно (подпись требует сертификата на машине); если запускается — проверить, что в `release/` появились файлы с новыми именами и `latest.yml`.

**Тест-кейсы (`desktop/test/build-config.test.js`, чтение файлов как текста/JSON):**
- `package.json`: `build.publish[0].provider === 'generic'`; `build.win.signtoolOptions.publisherName` содержит `Centras Insurance (АО Сентрас Иншуранс)`; `artifactName` у nsis и portable — с дефисами и `${version}`; `electron-updater` в `dependencies` (не в devDependencies) и версия точная (без `^`/`~`); блок `electronFuses` содержит все прежние ключи с прежними значениями и `grantFileProtocolExtraPrivileges:false`; каждый скрипт с `electron-builder` содержит `--publish never`.
- `installer.nsh` содержит `customInstallMode`, `isForceCurrentInstall`, `${ifNot} ${isUpdated}`.
- `publish-update.ps1` существует и содержит закреплённый отпечаток `0EB61614FC390FCD11BDF8DBFD40BE62EE10862A`.

- [ ] Step 1: тесты → падают
- [ ] Step 2: реализация 1–3
- [ ] Step 3: `cd desktop && npm test` → 0 fail
- [ ] Step 4: коммит `Автообновление, сборка: electron-updater, имена артефактов, установка на пользователя, публикация без переподписи`

---

### Task 9: Автообновление — главный процесс клиента

Спецификация: разделы «Конфигурация → Клиентский файл машины / Состояние на пользователя» и «Клиент — модули» (пункты 1–4 и «Изменения main.js», «Preload») в `docs/superpowers/specs/2026-09-28-autoupdate-design.md`.

**Files:**
- Create: `desktop/src/main/client-config.js`, `desktop/src/main/update-policy.js`, `desktop/src/main/update-verify.js`, `desktop/src/main/updater.js`
- Modify: `desktop/src/main/main.js` (адрес сервера через `client-config`, суффикс UA, фильтр раздела `electron-updater`, `UpdateController`, трей, IPC)
- Modify: `desktop/src/preload/preload.js`
- Modify: `desktop/test/client-hardening.test.js` (фильтр раздела updater)
- Test: `desktop/test/client-config.test.js`, `desktop/test/update-policy.test.js`, `desktop/test/update-verify.test.js`, `desktop/test/updater.test.js` (новые; добавить в `desktop/package.json`)

**Interfaces:**
- Consumes: HTTP-контракты `/updates/*` (Задача 7); сигнатура `verifyUpdateCodeSignature` из отчёта Задачи 8; общие векторы `compareVersions` (Задача 7).
- Produces: IPC `update-get-state`, `update-check`, `update-install`, `update-open-download`, `get-app-info`, событие `update-status`; preload `window.electronAPI.getAppInfo()`, `getUpdateState()`, `checkForUpdates()`, `installUpdate()`, `openUpdateDownload()`, `onUpdateStatus(cb) → unsubscribe`. Состояние — объект из раздела 4 спецификации.

**Тест-кейсы (из спецификации):**
- client-config: файл ProgramData побеждает константу; http, URL с учётными данными, мусорный JSON, BOM, отсутствующий файл → игнорируется с записью в `problems`; разработка — env работает; собранная сборка env игнорирует; `updates.enabled=false`; неизвестный канал → `stable`.
- update-policy: общие векторы `compareVersions`; `detectInstallKind` для portable/Program Files/uninstaller/copy/dev; базовый URL — только https, завершающий `/`, канал; `feedOptions.useMultipleRangeRequest === false`; границы случайного сдвига и потолок задержки `nextCheckDelay`; `updateCapability`.
- update-verify: Valid + закреплённый + совпадающая версия → null; чужой отпечаток, `UnknownError`, `HashMismatch`, `NotSigned`, нет `SignerCertificate`, несовпадение ProductVersion, ProductVersion ≤ текущей, битый JSON, ошибка запуска, тайм-аут → каждый отклонён своим кодом; экранирование пути с `'` и пробелами; **согласованность**: `PINNED_THUMBPRINTS[0]` равен `$MyChatPinnedThumbprint` в `desktop/scripts/signing-common.ps1` и `$PinnedThumbprint` в `installer/установить-сертификат.ps1` и `installer/разблокировать-запуск.ps1` (если этих файлов нет — найти скрипты установки сертификата в `installer/` через поиск по отпечатку и сверить с ними).
- updater (поддельный `autoUpdater` на EventEmitter, поддельные таймеры и fetch): выключенный конфиг → нет запросов; нет `publisherName` → `build-misconfigured`, нет `checkForUpdates`; политика ничего не предлагает → нет `checkForUpdates`; предложено → `checkForUpdates`, `setFeedURL`/`requestHeaders` содержат installId/версию/вид; события → состояние + `sendToRenderer`; 404 latest.yml → idle, не error; ошибка → задержка, `lastError` сохранён и уходит в следующем запросе; portable/copy → нет `checkForUpdates`, `available` с `downloadUrl`; `installNow` отклоняется не из `downloaded`, откладывается во время сеанса удалённого стола, ставит `isQuitting` до `quitAndInstall(true,true)`; путь обязательного обновления с отсрочкой; ограничение частоты `checkNow`.
- client-hardening: фильтр раздела updater блокирует http и чужой origin, пропускает https того же origin.

- [ ] Step 1: тесты → падают
- [ ] Step 2: client-config → update-policy → update-verify → updater → main.js/preload
- [ ] Step 3: `cd desktop && npm test` → 0 fail; `npm run build` проходит; `node -e "require('./src/main/updater.js')"` из `desktop/` не падает на импорте
- [ ] Step 4: коммит `Автообновление, клиент: проверка подписи, поэтапная раздача, трей и обязательные обновления`

---

### Task 10: Автообновление — интерфейс: баннер, вкладка «Обновления», реальная версия клиента

Спецификация: абзац «Интерфейс» раздела «Клиент — модули» в `docs/superpowers/specs/2026-09-28-autoupdate-design.md`.

**Files:**
- Create: `desktop/src/renderer/src/lib/update-status.mjs`, `desktop/src/renderer/src/lib/update-admin.mjs`
- Create: `desktop/src/renderer/src/components/UpdateBanner.jsx`, `desktop/src/renderer/src/components/UpdatesAdmin.jsx`
- Modify: `desktop/src/renderer/src/App.jsx` (баннер рядом со стопкой уведомлений; `client_version` при knock ~411 — из `getAppInfo()`)
- Modify: `desktop/src/renderer/src/components/AdminUserModal.jsx` (пункт «Обновления» для супер-админа; подвал «Версия: …» — настоящая версия сервера и клиента вместо жёсткой строки)
- Modify: `server/src/services/device.service.js` (путь уже привязанного устройства в `knock` тоже обновляет `client_version`)
- Test: `desktop/test/update-status.test.mjs`, `desktop/test/update-admin.test.mjs` (новые; добавить в `desktop/package.json`)

**Interfaces:**
- Consumes: preload API и состояние из Задачи 9; `GET/PUT/POST/DELETE /api/admin/updates*` и `GET /updates/policy.json` из Задачи 7.
- Produces: `bannerFor(state, { legacyShell }) → null | { tone:'info'|'warn'|'error', text, action: null | { kind:'install'|'download'|'check', label } }`; `validatePolicyDraft(draft, releases) → string[]` (список ошибок), `describeRollout(percent) → string`, `compareVersions` (те же векторы).

**Требования:**
1. Баннер: `available`/`downloading` — «Загружается обновление X (N%)»; `downloaded` — «Обновление X готово» + кнопка «Перезапустить»; `mandatory` — тон warn и текст «Обязательное обновление»; `available` с `downloadUrl` — кнопка «Скачать»; `error: build-misconfigured` и ошибки подписи — тон error, текст для ИТ; `legacyShell` → «Установите новую версию приложения» с кнопкой, открывающей `setupUrl` из `/updates/policy.json`.
2. Вкладка «Обновления» (по образцу `SecurityCenter.jsx`): таблица релизов (версия, размер, дата, кто импортировал, удалить); форма загрузки (4 поля файлов + заметки, прогресс через XHR); список inbox с «Импортировать»; редактор политики по каналам (target из списка релизов, раздача с кнопками 5/25/50/100, minVersion, интервал, сообщение); распределение версий и ошибок по парку; при `disabledByEnv` — плашка «Обновления выключены на сервере (UPDATES_DISABLED)».

**Тест-кейсы:** `bannerFor` для каждого состояния, для `legacyShell` и для `mandatory`; `validatePolicyDraft`: minVersion > target, раздача вне 0–100, неизвестный target, интервал вне 30–1440; `describeRollout(25)` содержит «25%»; `compareVersions` — общие векторы.

- [ ] Step 1: тесты → падают
- [ ] Step 2: реализация
- [ ] Step 3: `cd desktop && npm test` → 0 fail; `npm run build` проходит; `cd server && npm test` → 0 fail
- [ ] Step 4: коммит `Автообновление, интерфейс: баннер обновления и вкладка «Обновления» для администратора`

---

### Task 11: Автообновление — установщик и документация администратора

Спецификация: раздел «Установщик» в `docs/superpowers/specs/2026-09-28-autoupdate-design.md`.

**Files:**
- Create: `installer/configure-client.ps1`, `installer/настроить-клиент.bat`
- Modify: `installer/install.ps1` (параметры `-ServerUrl`, `-Channel`)
- Modify: `installer/SHA256SUMS.txt` механизм (если в `sign-and-publish.ps1` перечислены имена — уже сделано в Задаче 8; здесь только проверить)
- Create: `docs/автообновление.md`
- Modify: `docs/аудит-и-улучшения.md` (пункт про автообновление — отметить сделанным со ссылкой)
- Test: `desktop/test/installer-scripts.test.js` (новый; добавить в `desktop/package.json`)

**Требования:**
1. `configure-client.ps1`: `#Requires -RunAsAdministrator`; проверка https; ACL дословно из спецификации; запись `client.json` в UTF-8 без BOM (`[System.IO.File]::WriteAllText(path, json, (New-Object System.Text.UTF8Encoding $false))`), слияние с существующим файлом с сохранением неизвестных ключей; итог печатается.
2. `install.ps1`: необязательные параметры; с правами администратора вызывает `configure-client.ps1`; без них — печатает команду для ИТ; сообщение, что установка копией только уведомляет об обновлениях, и рекомендация `OpenMyChat-Enterprise-Setup-*.exe`.
3. `docs/автообновление.md`: для администратора — подготовка (HTTPS с доверенным TLS-сертификатом, корневой сертификат Centras на машинах, `client_max_body_size 600m` на прокси), выпуск версии (поднять версию → `npm run release` → `npm run publish:update` → загрузка в консоль или копирование в `data/updates/inbox/`), раздача по процентам, обязательная версия, откат (новая версия с большим номером — откат на меньший номер запрещён намеренно), выключатели (`UPDATES_DISABLED`, `client.json updates.enabled=false`), диагностика (коды ошибок парка и что с ними делать), первичный переход парка 1.0.0 (баннер «Установите новую версию»).

**Тест-кейсы (`desktop/test/installer-scripts.test.js`, чтение как текста):** `configure-client.ps1` содержит `RunAsAdministrator`, `/inheritance:r`, `S-1-5-32-545:(OI)(CI)RX`, `UTF8Encoding $false`, проверку `https://`; `install.ps1` содержит параметры `ServerUrl` и `Channel`; `docs/автообновление.md` существует и содержит `UPDATES_DISABLED` и `publish:update`.

- [ ] Step 1: тесты → падают
- [ ] Step 2: реализация
- [ ] Step 3: `cd desktop && npm test` → 0 fail
- [ ] Step 4: коммит `Автообновление: настройка клиента на машине и инструкция администратора`
