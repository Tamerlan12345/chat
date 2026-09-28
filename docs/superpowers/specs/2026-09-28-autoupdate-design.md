# Автообновление клиента с собственного сервера — дизайн (MVP)

Дата: 2026-09-28. Источник: исследование кода (desktop/, server/, installer/), решения владельца.

## Цель

Администратор публикует новую версию настольного клиента на сервере компании (локальная сеть, без интернета и GitHub), а установленные у сотрудников приложения сами скачивают, проверяют подпись и ставят обновление.

## Что уже есть и что это значит

| Факт | Следствие |
|---|---|
| Интерфейс (React, `desktop/dist`) раздаётся сервером — окно грузит `SERVER_URL` | Интерфейс обновляется при каждом выкате сервера. Автообновление нужно только для оболочки Electron (exe) |
| `desktop/src/main/main.js:77` жёстко задаёт `DEFAULT_SERVER_URL`; `server-url.js` в собранной сборке игнорирует переменные окружения (так задумано) | Для сервера в локальной сети нужен админский файл `%ProgramData%\OpenMyChat Enterprise\client.json` |
| `session.defaultSession.webRequest.onBeforeRequest` режет http/ws в собранной сборке | electron-updater ходит через `session.fromPartition('electron-updater')` — на нём нужен такой же фильтр |
| NSIS: `oneClick:false, perMachine:false` → показывается страница «для меня / для всех» | Установка «для всех» требует прав администратора при обновлении. Принудительно ставим «для текущего пользователя» |
| `build/installer.nsh` `customUnInstall` удаляет автозапуск при любом удалении, в том числе на шаге обновления | Обернуть в `${ifNot} ${isUpdated}` |
| Подпись: `sign-windows.js` → `sign-file.ps1`, закреплённый отпечаток `0EB61614FC390FCD11BDF8DBFD40BE62EE10862A`, CN=`Centras Insurance (АО Сентрас Иншуранс)` | Этот же отпечаток проверяем на клиенте |
| electron-builder кладёт `publisherName` в `app-update.yml` только если задан `win.signtoolOptions.publisherName`; без него `NsisUpdater.verifySignature` пропускает проверку | Задать `publisherName` явно + проверка при старте + собственный `verifyUpdateCodeSignature` |
| `sign-and-publish.ps1` переподписывает копию Setup.exe → sha512 перестаёт совпадать с `latest.yml` | Уже подписанное закреплённым сертификатом не переподписывать |
| docker-compose `read_only: true`, писать можно только в `/app/server/data` | Релизы хранятся в `data/updates/` |
| Portable-сборка не обновляется electron-updater | Portable и «копия» (install.ps1) — только уведомление со ссылкой на скачивание |

## Архитектура

```
админ (загрузка в консоли или папка data/updates/inbox/<имя>)
      │
      ▼
server/data/updates/releases/<ver>/{OpenMyChat-Enterprise-Setup-<ver>.exe, .blockmap, OpenMyChat-Enterprise-Portable-<ver>.exe?, release.json}
server_settings.update_policy
      │
      ├── GET /updates/policy.json
      ├── GET /updates/<channel>/latest.yml      (генерируется на запрос)
      └── GET /updates/<channel>/<file>          (только по белому списку имён)
      ▼
desktop main: updater.js (electron-updater NsisUpdater, provider generic, setFeedURL)
   - только https, запросы только на origin обновлений
   - sha512 (electron-updater) + своя проверка Authenticode: закреплённый отпечаток, Status=Valid, ProductVersion == версии из yml и > текущей
   - состояние → трей + системное уведомление + IPC 'update-status' в интерфейс
   - установка при выходе (autoInstallOnAppQuit) или «Перезапустить и обновить»; обязательное — с отсчётом, не во время сеанса удалённого стола
```

Поэтапная раздача (rollout) делается на сервере, а не через `stagingPercentage`.

## Конфигурация

### Клиентский файл машины — `%ProgramData%\OpenMyChat Enterprise\client.json`

```json
{ "serverUrl": "https://chat.centras.local", "updates": { "enabled": true, "channel": "stable" } }
```
- `serverUrl`: только https (`isAllowedServerUrl({isPackaged:true})`); неверное значение игнорируется и пишется в лог.
- `updates.channel`: `stable` | `beta`; неизвестное → `stable`.
- Приоритет в собранной сборке: ProgramData `client.json` → текущая константа `DEFAULT_SERVER_URL`. Ни переменных окружения, ни пользовательского файла.
- В разработке (`!isPackaged`) — прежнее поведение с переменными окружения; обновления выключены.
- `updates.enabled=false` — выключатель обновлений на машине.

### Состояние на пользователя — `%APPDATA%\OpenMyChat Enterprise\update-state.json`
`{ "installId": "<uuid v4>", "lastCheckAt": "...", "lastError": "..." }`. installId случайный, нужен только для корзин раздачи и статистики.

### Сервер (env, `config/index.js`)
- `UPDATES_DIR` (по умолчанию `path.join(DATA_DIR, 'updates')`)
- `UPDATES_DISABLED=true` — жёсткий выключатель, консоль его не переопределяет
- `UPDATES_MAX_CONCURRENT_DOWNLOADS` (по умолчанию 20) — сверх него 503 + `Retry-After: 60`
- `UPDATES_MAX_FILE_MB` (по умолчанию 600)

### Настройка сервера `update_policy` (JSON-строка в `server_settings`; ключ добавить в регулярку `INTERNAL_SETTING` в `server/src/api/index.js`, чтобы менять её можно было только через отдельный проверяемый маршрут)

```json
{
  "enabled": true,
  "channels": {
    "stable": { "target": "1.2.0", "rolloutPercent": 25 },
    "beta":   { "target": "1.3.0-beta.1", "rolloutPercent": 100 }
  },
  "minVersion": "1.1.0",
  "checkIntervalMinutes": 240,
  "message": "Исправлена передача файлов"
}
```
Проверка: версии — строгий semver `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`; `target` должен существовать среди импортированных релизов (или быть `null`); `rolloutPercent` — целое 0–100; `minVersion` (или `null`) не больше `stable.target`; `checkIntervalMinutes` 30–1440; `message` ≤ 500 символов.

## Контракты маршрутов

### Публичные (без входа пользователя; за IP-фильтром и ready-gate; монтируются в `app.js` ДО статики и UA-фильтра: `app.use('/updates', require('./updates/router'))`)

Заголовки от клиента: `X-MyChat-Install-Id` (uuid), `X-MyChat-Client-Version`, `X-MyChat-Install-Kind` (`nsis|nsis-machine|portable|copy`), необязательный `X-MyChat-Update-Error`.

- `GET /updates/policy.json` → 200, `Cache-Control: no-store`:
  `{ enabled, channel, offeredVersion|null, mandatory, minVersion|null, message|null, checkIntervalMinutes, setupUrl|null, portableUrl|null }`. `channel` берётся из query `?channel=` (`stable` по умолчанию). `mandatory = clientVersion < minVersion`.
- `GET /updates/:channel/latest.yml`
  - `:channel` ∈ {stable, beta}, иначе 404.
  - Выключено (env или политика) или нет target → 404.
  - Право на версию: `compare(clientVersion, minVersion) < 0 || bucket(installId, target) < rolloutPercent`, где `bucket = readUInt32BE(sha256(installId + ':' + target)[0..4]) % 100`; нет/неверный installId → корзина 99.
  - Нет права → 404 (клиент считает это «обновлений нет»).
  - Тело строится из `release.json`, а не из загруженного текста: `version`, `files: [{url, sha512, size}]`, `path`, `sha512`, `releaseDate`, необязательный `releaseNotes`. Без `stagingPercentage`.
  - `Content-Type: text/yaml; charset=utf-8`, `Cache-Control: no-store`.
  - Побочно: запись в `client_installs` не чаще раза в 10 минут на installId (учёт в памяти).
  - Ограничение частоты: `checkRateLimit('upd:'+ip, {maxAttempts:120, windowMs:60000})`.
- `GET /updates/:channel/:file`
  - `:file` должен соответствовать `^[A-Za-z0-9._-]{1,128}$` и быть ключом индекса `{имя → абсолютный путь}`, собранного из всех `release.json` (любых релизов: electron-updater запрашивает blockmap старой версии).
  - Никакого `path.join` с вводом. Дополнительно `absPath.startsWith(RELEASES_DIR + path.sep)`.
  - `res.sendFile(absPath, {acceptRanges:true, cacheControl:false})`, `Cache-Control: public, max-age=31536000, immutable`, `Content-Type: application/octet-stream`, `Content-Disposition: attachment`. Один `Range` → 206.
  - Предел одновременных скачиваний → 503 + `Retry-After: 60`.

### Админские (`/api/admin/updates`, `requireAuth` + только супер-админ)
- `GET /api/admin/updates` → `{ disabledByEnv, policy, releases:[{version, files:[{name,size,sha512}], importedAt, importedBy, notes}], inbox:[{name, problems:[...]}], fleet:{ total, byVersion:{}, byKind:{}, errors:{} } }`
- `POST /api/admin/updates/releases` — multipart: `yml` (latest.yml), `setup` (exe), `blockmap` (необязательно), `portable` (необязательно), `notes` (текст). Отдельный экземпляр multer: `dest: UPDATES_DIR/.tmp/<rand>`, `limits:{fileSize: UPDATES_MAX_FILE_MB*1MB, files:4, fields:5}`. 201 → сводка релиза; 400 → `{error}`; 409 → версия уже есть.
- `POST /api/admin/updates/inbox/:name/import` — `:name` по `^[0-9A-Za-z._-]{1,64}$`, разрешённый каталог — прямой потомок `UPDATES_DIR/inbox`. Проверка та же, что при загрузке; файлы переносятся.
- `PUT /api/admin/updates/policy` — тело = политика; проверяется; сохраняется; аудит `update_policy_changed`.
- `DELETE /api/admin/updates/releases/:version` — 409, если версия — target какого-либо канала; аудит `update_release_deleted`.
- Импорт пишет аудит `update_release_imported` с `{version, sha512, size}`.

### Проверка релиза (`update-store.service.js`, общая для загрузки и inbox)
1. Разбор yml строгим мини-парсером: верхний уровень `version`, `path`, `sha512`, `releaseDate`; `files[]` с `url`, `sha512`, `size` (`blockMapSize` допустим). Неизвестная форма → отказ.
2. Версия — строгий semver и ещё не существует.
3. Имена файлов проходят безопасную регулярку и имеют вид `OpenMyChat-Enterprise-Setup-<version>.exe`, portable — `OpenMyChat-Enterprise-Portable-<version>.exe`, blockmap — `<setup>.blockmap`.
4. exe начинается с `MZ`; размер ≤ лимита и равен `size` из yml.
5. sha512 (base64) exe совпадает с `sha512` из yml. Несовпадение: «Файл переподписан после сборки — загрузите файл из desktop/release».
6. Запись `release.json`, затем `fs.rename(tmpDir, releases/<version>)`; при любой ошибке tmp удаляется. Пересборка индекса.

## Клиент — модули

Новые чистые модули (тестируются без Electron, как `autostart.js`):

1. `desktop/src/main/client-config.js`
   - `readClientConfig({ programData, readFile, isPackaged })` → `{ serverUrl|null, updates:{enabled, channel}, source, problems:[] }`
   - `resolveEffectiveServerUrl({ config, hardDefault, isPackaged, env })` — оборачивает существующий `resolveServerUrl`.
2. `desktop/src/main/update-policy.js`
   - `compareVersions(a,b)` — semver с пререлизами (1.10.0 > 1.9.0; 1.2.0-beta.1 < 1.2.0).
   - `detectInstallKind({ isPackaged, execPath, env, exists, programFiles })` → `dev` | `portable` (есть `env.PORTABLE_EXECUTABLE_FILE`) | `nsis-machine` (exe под `%ProgramFiles%`) | `nsis` (рядом лежит `Uninstall OpenMyChat Enterprise.exe`) | `copy`.
   - `updateBaseUrl({ serverOrigin, channel })` → `https://…/updates/<channel>/` или null (не https → null).
   - `feedOptions({ baseUrl })` → `{ provider:'generic', url: baseUrl, channel:'latest', useMultipleRangeRequest:false }`.
   - `requestHeaders({ installId, version, kind, lastError })`.
   - `nextCheckDelay({ intervalMin, attempt, rand })` — первая проверка через 60–300 с после старта; дальше интервал ± 15% случайного сдвига; при ошибках экспоненциальная задержка, не больше 6 ч.
   - `updateCapability(kind)` → `auto` (nsis) | `notify` (portable, copy, nsis-machine) | `none` (dev).
3. `desktop/src/main/update-verify.js`
   - `PINNED_THUMBPRINTS = ['0EB61614FC390FCD11BDF8DBFD40BE62EE10862A']`.
   - `buildPsCommand(file)` — `-LiteralPath`, `'` экранируется как `''`, вывод JSON с `Status`, `SignerCertificate.Thumbprint`, `VersionInfo.ProductVersion`.
   - `evaluateSignature(json, { pinned, expectedVersion, currentVersion })` → null (ок) или код ошибки: `signature-untrusted` (Status не Valid), `signature-foreign` (отпечаток не закреплён), `version-mismatch` (ProductVersion ≠ ожидаемой или ≤ текущей), `signature-unreadable` (битый JSON / нет полей).
   - `verifyInstaller(file, { expectedVersion, currentVersion, run })` — запускает `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive` по абсолютному пути, тайм-аут 30 с; любая ошибка запуска/разбора/тайм-аут → отказ.
4. `desktop/src/main/updater.js` — класс `UpdateController`, зависимости внедряются:
   - `constructor({ autoUpdater, app, config, kind, serverOrigin, log, notify, sendToRenderer, hostSession, fetchJson, statePath, readFile, writeFile, now, timers, readAppUpdateYml })`
   - `start()`, `stop()`, `checkNow({ userInitiated })` (не чаще раза в минуту), `installNow()`, `getState()`
   - Состояние: `{ status: 'disabled'|'idle'|'checking'|'available'|'downloading'|'downloaded'|'error'|'unsupported', currentVersion, offeredVersion, progress, mandatory, message, kind, error, downloadUrl }`
   - Для `kind==='nsis'`: `autoDownload=true`, `autoInstallOnAppQuit=true`, `allowDowngrade=false`, `allowPrerelease = channel==='beta'`, `disableWebInstaller=true`, `setFeedURL(feedOptions)`, `requestHeaders`, `verifyUpdateCodeSignature = (names, file) => verifyInstaller(file, …)`.
   - Защита «сборка настроена неверно»: если в `app-update.yml` нет `publisherName` → `status:'error', error:'build-misconfigured'`, проверок нет.
   - Цикл: GET `policy.json` → выключено → idle; `offeredVersion > current` → `autoUpdater.checkForUpdates()`; события electron-updater → состояния; 404 на latest.yml = «нет обновлений».
   - Скачано: пункт трея «Перезапустить и обновить до X», системное уведомление, IPC в интерфейс.
   - Обязательное (`mandatory`): во время сеанса удалённого стола — ждать и перепроверять раз в 60 с; иначе диалог «Обязательное обновление до X. Перезапуск через 5 минут» [Перезапустить сейчас] [Через 5 минут] — одна отсрочка; затем `installNow()`.
   - `installNow()`: только из `downloaded`; завершить сеанс удалённого стола; `app.isQuitting=true`; `autoUpdater.quitAndInstall(true, true)`.
   - `notify`-виды: только политика; если `offeredVersion > current` → `available` с `downloadUrl` (portable → `portableUrl`, иначе `setupUrl`); действие — `shell.openExternal(downloadUrl)`.
   - Коды последней ошибки (`signature-untrusted`, `signature-foreign`, `version-mismatch`, `sha512`, `network`, `http-5xx`) сохраняются и уходят в следующем запросе заголовком.

Изменения `main.js`: разрешение адреса сервера через `client-config`; суффикс UA `OpenMyChatDesktop/<version> (<kind>)` (слово Electron остаётся); фильтр `onBeforeRequest` на разделе `electron-updater` (только https и только origin обновлений); создание `UpdateController` после главного окна; пункты трея «Проверить обновления» / «Перезапустить и обновить до X»; IPC под `isFromServerPage(event, {mainWindowOnly:true})`: `update-get-state`, `update-check`, `update-install`, `update-open-download` (адрес берётся из состояния main, не из интерфейса), `get-app-info` → `{version, kind}`.

Preload: `getAppInfo`, `getUpdateState`, `checkForUpdates`, `installUpdate`, `openUpdateDownload`, `onUpdateStatus`.

Интерфейс: `lib/update-status.mjs` (`bannerFor(state, {legacyShell})`), `components/UpdateBanner.jsx`; `legacyShell` = есть `window.electronAPI`, но нет `getUpdateState` (парк 1.0.0) → «Установите новую версию» со ссылкой `setupUrl` из `/updates/policy.json`. Вкладка супер-админа «Обновления» (`components/UpdatesAdmin.jsx`, по образцу `SecurityCenter.jsx`): таблица релизов, загрузка, inbox с импортом, редактор политики (target, раздача 5/25/50/100, minVersion, интервал, сообщение), распределение версий и ошибок по парку. `client_version` при knock — реальная версия из `getAppInfo()`.

## Сборка / подпись / публикация

`desktop/package.json`:
- `dependencies`: `electron-updater` (точная версия, совместимая с electron-builder 26.15.3).
- `build.publish`: `[{ "provider": "generic", "url": "https://updates.invalid/openmychat/", "channel": "latest" }]` — заглушка, клиент всегда вызывает `setFeedURL`.
- `build.win.signtoolOptions.publisherName`: `["Centras Insurance (АО Сентрас Иншуранс)"]`; `build.win.verifyUpdateCodeSignature`: `true`.
- `build.nsis.artifactName`: `"OpenMyChat-Enterprise-Setup-${version}.${ext}"`; `build.portable.artifactName`: `"OpenMyChat-Enterprise-Portable-${version}.${ext}"`.
- Все вызовы `electron-builder` получают `--publish never`. Новый скрипт `"publish:update": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-update.ps1"`.

`desktop/build/installer.nsh`:
```nsis
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.openmychat.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.openmychat.desktop"
  ${endIf}
!macroend
```

`desktop/scripts/sign-and-publish.ps1`: новые имена файлов; если `Test-MyChatSignature $source` уже истинно — копировать без переподписи; падать, если в `release/win-unpacked/resources/app-update.yml` нет `publisherName`.

Новый `desktop/scripts/publish-update.ps1`: читает `release/latest.yml`; проверяет закреплённую подпись Setup и совпадение sha512; собирает `release/update-<version>/` (latest.yml, Setup, blockmap, portable, README.txt); необязательно `-Server https://… -Token …` → загрузка через `POST /api/admin/updates/releases`; иначе печатает «перетащите папку в консоль администратора или скопируйте в data/updates/inbox/».

## Установщик

- Новый `installer/configure-client.ps1` (+ `installer/настроить-клиент.bat`): требует прав администратора; параметры `-ServerUrl`, `-Channel stable|beta`, `-DisableUpdates`; проверяет https; создаёт `%ProgramData%\OpenMyChat Enterprise` с ACL `icacls "<dir>" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX"`; пишет `client.json` в UTF-8 без BOM, сохраняя неизвестные ключи.
- `installer/install.ps1`: необязательные `-ServerUrl`/`-Channel`; с правами администратора вызывает `configure-client.ps1`, без них печатает, что должен выполнить ИТ; сообщает, что установка «копией» только уведомляет, и рекомендует `OpenMyChat-Enterprise-Setup-*.exe`.
- `docs/автообновление.md` для администраторов: порядок выпуска, раздача, откат, условия (HTTPS с доверенным TLS-сертификатом, корневой сертификат на клиентах, `client_max_body_size 600m` на прокси для загрузки).

## Сервер — файлы

- `server/src/config/index.js`: `UPDATES_DIR`, `UPDATES_DISABLED`, `UPDATES_MAX_CONCURRENT_DOWNLOADS`, `UPDATES_MAX_FILE_MB`.
- `server/src/services/update-store.service.js`: `init()`, `listReleases()`, `getRelease(v)`, `resolveFile(name)`, `listInbox()`, `importFromDir(dir, {actor, notes})`, `importUpload(files, {actor, notes})`, `deleteRelease(v, policy)`, `readYml(text)`, `renderYml(release)`.
- `server/src/services/update-policy.service.js`: `getPolicy()`, `setPolicy(draft, actor)`, `validatePolicy(draft, releases)`, `bucketOf(installId, version)`, `decide({channel, installId, clientVersion, policy, releases})` → `{release|null, eligible, mandatory}`, `compareVersions`.
- `server/src/updates/router.js`: публичные маршруты, счётчик одновременных скачиваний (уменьшается на `close`/`finish`), троттлинг записи `client_installs`.
- `server/src/db/identity/schema.js` (оба диалекта): `CREATE TABLE IF NOT EXISTS client_installs (install_id TEXT PRIMARY KEY, client_version TEXT, install_kind TEXT, channel TEXT, ip_address TEXT, last_error TEXT, first_seen_at TEXT NOT NULL, last_check_at TEXT NOT NULL)`; индекс по `client_version`; удаление строк старше 90 дней при старте; предел 50 000 строк (новые id сверх — не записываются).

## Угрозы → меры

| Угроза | Мера |
|---|---|
| Вредоносный установщик с подменённого сервера или от угнанной админки | Закреплённый отпечаток Authenticode + Status=Valid на клиенте; sha512 из yml; только https; раздел updater пускает только на origin обновлений |
| Откат на старую подписанную уязвимую сборку | ProductVersion == версии из yml и > текущей; `allowDowngrade=false` |
| electron-updater пропускает проверку без publisherName или при сбое PowerShell | Явный `publisherName`; проверка `app-update.yml` при старте; своя проверка, отказывающая при любой ошибке |
| Обход пути при скачивании или импорте inbox | Регулярка имени + поиск по индексу, без `path.join` с вводом; регулярка имени inbox + `path.dirname(resolved) === INBOX`; тесты с `..`, `%2f`, `%5c`, `\`, NUL, абсолютными путями, длинными именами |
| Перенаправление клиента на чужой сервер через конфиг | `client.json` только в ProgramData с ACL; в собранной сборке нет ни env, ни пользовательского файла; только https |
| Шторм скачиваний в сети | Процент раздачи, случайный сдвиг расписания, дифференциальная загрузка (blockmap), предел одновременных скачиваний 503/Retry-After, задержка при ошибках |
| Принудительный перезапуск во время работы или удалённого стола | Не ставится во время сеанса удалённого стола; обязательное — с отсчётом и одной отсрочкой; по умолчанию — при выходе |
| Интерфейс (удалённый код) злоупотребляет IPC | Только `mainWindowOnly`; `install` только из `downloaded`; адрес скачивания из состояния main |

Маршруты скачивания без входа пользователя — намеренно: обновление должно работать до входа и на офлайн-странице; целостность обеспечивает подпись, а не секретность.
