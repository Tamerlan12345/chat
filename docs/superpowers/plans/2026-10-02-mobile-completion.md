# CentyChat Mobile — план доработки iOS и Android до релиза

> Преемник `2026-09-30-mobile-release-parity.md` (Codex). Задачи 1–6 и 10 оттуда считаются выполненными; 7–9 и 11 поглощены этим планом.
> Исполнение: оркестратор (основная сессия) + субагенты iOS Lead / Android Lead / Integration / QA. Скиллы: `.agents/skills/*`.

## 0. Исходное состояние (аудит 2026-10-02)

**Что реально есть**
- Ветка `mobile-release-parity-impl`, worktree `.claude/worktrees/mobile-release-parity`. Локально на **21 коммит впереди** `origin` — эти коммиты (Keychain fail-closed, аудиореле iOS ~900 строк, редизайн инбокса, иконка) **ни разу не компилировались под iOS**.
- iOS: Xcode-проект (iOS 17, Swift 6), CI `mobile-ios.yml` на macos-15 был зелёным на `98378e6` (22 unit + 1 UI-тест). Локальной сборки нет (Windows; MacBook Air 2014 тянет только Xcode 12.5).
- Android: Gradle wrapper, AGP 8.7 / Kotlin 2.0.21 / Compose BOM 2024.10, `testDebugUnitTest lint assembleDebug assembleRelease` зелёные локально и в CI; 1 тест (`ServerEndpointPolicyTest`, кириллица) красный и не закоммичен.
- Вживую авторизованные экраны **не видел никто**: в debug Bearer не уходит по HTTP, локального HTTPS нет → «сервер недоступен, войти не могу».
- QA-отчёты честно в статусе BLOCKED / NOT READY / UNVERIFIED.

**Ключевые дефекты (обе платформы)**
| # | Дефект | iOS | Android |
|---|---|---|---|
| D1 | Сообщение теряется при разрыве, композер очищается сразу, нет outbox | ✗ | ✗ |
| D2 | Открытый чат не получает realtime-события (стабы `updateMessage*`) / WS не слушается при первом старте | ✗ | — |
| D3 | `new_message` + `direct_message/channel_message` приходят дублем → двойной unread | ✗ | частично |
| D4 | Нет пересинхронизации после реконнекта, нет индикатора соединения | ✗ | ✗ |
| D5 | Вложения: картинки без Bearer не грузятся (iOS), upload отсутствует (Android), политика не применяется | ✗ | ✗ |
| D6 | Создание личного чата/канала: сломан sheet (iOS), отсутствует (Android) | ✗ | ✗ |
| D7 | ViewModel привязаны к Activity: повторный звонок сразу закрывается, назад не завершает звонок | — | ✗ |
| D8 | Вкладки копятся в back stack, `onLoggedOut` не чистит стек | — | ✗ |
| D9 | Застревание при `mustChangePassword`, двойной sheet | ✗ | — |
| D10 | Звонки только в foreground: нет CallKit / foreground service / push | ✗ | ✗ |
| D11 | Ошибки глотаются (`catch {}` / `print`), нет loading/error/retry | ✗ | ✗ |
| D12 | Доступность: Dynamic Type/fontScale, VoiceOver/TalkBack, 44pt/48dp, захардкоженные строки RU/EN | ✗ | ✗ |
| D13 | Дизайн не совпадает с десктопом кроме инбокса; Android — 3 разных копии NavigationBar, XML-тема не DayNight | частично | ✗ |
| D14 | Store-блокеры: iPad-ориентации без `UIRequiresFullScreen`, PrivacyInfo без SystemBootTime (`mach_absolute_time`) | ✗ | — |
| D15 | Возможный краш Swift 6 в аудиоколбэках (`installTap`/`scheduleBuffer` из @MainActor) | ? | — |

**Серверные пробелы, мешающие мобильному UX:** нет push (APNs/FCM), нет `client_msg_id`/идемпотентности, нет дельта-синхронизации (`afterId`/`updatedSince`), «доставлено» не ставится после реконнекта, нет долгоживущего refresh (истёкший токен → только пароль или `/auth/knock`), нет Range/thumbnails, аватар — data URL до 5 МБ.

**Ошибки в контрактах:** `ws-protocol.md §6.3` (refresh истёкшего токена и «докачка через beforeId» не работают), не описан дубль `new_message`, `parity-matrix.md` ставит ✅ там, где кода нет; общих фикстур нет.

## Решения владельца (2026-10-02)

- **iOS-сборка:** разрешено пушить `mobile-release-parity-impl` после каждой волны и гонять macOS CI на GitHub Actions.
- **Сервер:** можно менять, но только аддитивно (S1–S3 входят в волну 1). Десктоп не ломать.
- **Распространение:** корпоративное — TestFlight / Apple Business Manager Custom App и Managed Google Play private app. Публичное App Review не нужно, `app-store-review` применяем как чек-лист качества.
- **Push:** нужны. Тестирование:
  - Android: FCM на эмуляторе с Google Play Services, бесплатный Firebase-проект;
  - iOS: в CI через `xcrun simctl push` с `.apns`-payload (аккаунт не нужен), настоящий APNs — после появления Apple Developer Program.

## 1. Принципы

1. **Contract-first.** Любая фича начинается с изменения `mobile/contracts` + JSON-фикстур; обе платформы декодируют одни и те же фикстуры в тестах.
2. **Одинаковая логика — одинаковые редьюсеры.** Delivery-state, дедуп событий, unread, окна правки описаны как таблицы переходов в контракте; на каждой платформе — чистая функция `reduce(state, event)` + тесты на общих фикстурах.
3. **Нативный UI.** iOS — HIG/SwiftUI, Android — Material 3/Compose. Общие только бренд-токены из `desktop/src/renderer/src/styles/theme.css`.
4. **Доказательства, а не заявления.** Фича «готова» только с зелёным CI (iOS — macOS runner), скриншотами светлой/тёмной темы с обеих платформ и обновлённой строкой parity-матрицы.
5. **Владение файлами.** Агент правит только свои пути (см. §3) — конфликтов слияния нет по построению.

## 2. Целевая архитектура

### iOS (Swift 6, iOS 17, SwiftUI, Observation)
- Разрезать `AppState` (722 строки) на feature-сторы `@Observable @MainActor`: `SessionStore`, `RealtimeStore`, `ConversationsStore`, `ChatStore` (на диалог), `AnnouncementsStore`, `CallStore`, `ProfileStore`.
- Слой `Repositories` (протоколы) между сторами и `APIClient`/`WebSocketClient`; DI через `Environment` + `AppContainer`. View не обращаются к синглтонам.
- Персистентность: SwiftData (кэш диалогов/сообщений + outbox).
- `AuthenticatedImageLoader` (Bearer, кэш, ошибка вместо вечного спиннера).
- iPad: `NavigationSplitView` (список + чат), либо `UIRequiresFullScreen` — решение в F0.
- Аудио: колбэки AVAudioEngine — `nonisolated` + выделенная очередь, в MainActor только состояние; CallKit для аудиосессии и системного UI звонка.
- String Catalog (`ru` базовый), `#Preview` для каждого экрана, `os.Logger` вместо `print`.

### Android (Kotlin 2, Compose, Material 3)
- Обновить AGP/Kotlin/Compose BOM, targetSdk 36 (требование Google Play с 31.08.2026).
- **Navigation 3**: `NavDisplay` + `rememberViewModelStoreNavEntryDecorator` (ViewModel на destination → закрывает D7), отдельные стеки вкладок (D8), `ListDetailSceneStrategy` для планшетов/foldable, `NavigationSuiteScaffold`. Удалить неиспользуемый `navigation-compose` и самописный `NavBackStack`.
- Hilt (DI), Room (кэш + outbox), DataStore (настройки), Coil 3 с OkHttp-интерцептором авторизации, WorkManager для досылки outbox.
- Единый `UiState` на экран (sealed Loading/Content/Empty/Error), Snackbar для ошибок, pull-to-refresh.
- Edge-to-edge: `contentPadding` в списках, DayNight-тема + SplashScreen API, `stringResource` везде, semantics/Role/stateDescription, 48dp.
- Звонки: `ForegroundService` (`microphone|phoneCall`), audio focus, уведомление звонка; позже `ConnectionService`/Telecom Jetpack.

### Сервер (минимально необходимое, обратно совместимо с десктопом)
- S1 `client_msg_id` в `send_message` (идемпотентность, эхо в `new_message`).
- S2 Дельта-синхронизация: `GET /api/messages?afterId=` + `GET /api/sync?since=` (правки/удаления по `updated_at`).
- S3 «Доставлено» после реконнекта получателя и на REST-пути.
- S4 Push: `POST/DELETE /api/devices/push-token`, отправка APNs (alert + VoIP) и FCM; payload без текста сообщения (только id) — по требованию приватности.
- S5 (P2) Range для `/files/download`, превью изображений, аватар по URL вместо data URL.

## 3. Команда и владение

| Роль | Владеет путями | Скиллы |
|---|---|---|
| **Оркестратор** (основная сессия) | план, `mobile/qa/reports/*`, мерж веток | parallel-feature-development, team-composition-patterns, task-coordination-strategies |
| **Integration Agent** | `server/**`, `mobile/contracts/**` | test-driven-development, security-and-hardening |
| **iOS Lead** | `mobile/ios/**`, `.github/workflows/mobile-ios.yml` | write-swift, swiftui-patterns, mobile-ios-design, app-store-review |
| **Android Lead** | `mobile/android/**`, `.github/workflows/mobile-android.yml` | mobile-android-design, navigation-3, edge-to-edge |
| **QA Agent** | `mobile/qa/**`, тестовые фикстуры (read-only к коду) | qa, verification-before-completion, requesting-code-review |

Каждый агент работает в своём git worktree от общей интеграционной ветки; оркестратор сливает после QA-гейта.

## 4. Feature-модули и волны

Обозначения статуса: iOS / Android — ✓ готово, ◐ частично, ✗ нет.

| Модуль | Содержание | Сейчас iOS / Android | Зависит от |
|---|---|---|---|
| **F0 Foundation** | дизайн-токены из десктопа, навигационный каркас, DI, логирование, локализация, баннер соединения, общие компоненты (Avatar, StatusDot, EmptyState, ErrorState) | ◐ / ◐ | — |
| **F1 Onboarding & Auth** | сервер → health, вход, knock/claim, обязательная смена пароля, logout, восстановление сессии через device-secret | ◐ / ✓ | F0 |
| **F2 Realtime core** | WS-клиент, дедуп событий, backoff, resync после реконнекта, typing, presence | ◐ / ◐ | F0, S2 |
| **F3 Conversations** | личные + каналы, корректный unread, поиск, новый чат/канал, loading/error/empty | ◐ / ◐ | F2 |
| **F4 Chat** | лента, пагинация `beforeId`, статусы, правка/удаление с подтверждением, ответы, read receipts, многострочный ввод | ◐ / ◐ | F2, F5 |
| **F5 Outbox & cache** | durable очередь, состояния queued→sending→sent→delivered→read / failed, retry/cancel, кэш офлайн | ✗ / ✗ | S1, S2 |
| **F6 Attachments** | политика до выбора, picker, прогресс/ошибка/повтор, авторизованное скачивание, просмотр изображений и PDF | ◐ / ✗ | F4, F5 |
| **F7 Announcements** | список, детали, «Ознакомлен», ошибки | ◐ / ◐ | F0 |
| **F8 Calls** | аудиореле 16 кГц, разрешения и восстановление, CallKit / Foreground Service, гарнитура/динамик | ◐ / ◐ | F2 |
| **F9 Profile & Settings** | редактирование профиля, статус/DND, побудка, смена пароля, «О приложении» | ◐ / ◐ | F1 |
| **F10 Contacts / Org** | оргструктура `/org/tree`, карточка сотрудника → начать чат/звонок (есть на десктопе) | ✗ / ✗ | F3 |
| **F11 Search** | глобальный поиск `/messages/search` | ✗ / ✗ | F4 |
| **F12 Push** | регистрация токенов, уведомления о сообщениях, входящий звонок в фоне (PushKit/FCM high-priority) | ✗ / ✗ | S4, аккаунты Apple/Firebase |

### Волна 0 — Разблокировка (1–2 дня)
1. Прогнать iOS CI на всех 21 локальных коммитах, починить компиляцию; добавить в CI выгрузку скриншотов XCUITest как артефакта (замена живого симулятора для ревью дизайна).
2. Android: починить кодировку `ServerEndpointPolicyTest`, закрепить `JAVA_HOME` для локальной сборки.
3. Тестовый HTTPS-стенд для входа (Railway или локальный TLS через mkcert + доверенный CA в debug), чтобы авторизованные экраны можно было увидеть на эмуляторе.
4. Integration: исправить `ws-protocol.md §6.3`, описать дубль `new_message`, завести `mobile/contracts/fixtures/` (DTO + WS-события), переписать parity-матрицу на реальные статусы.

**Гейт:** iOS и Android CI зелёные на HEAD, вход на стенд работает с эмулятора Android и в iOS UI-тесте.

### Волна 1 — Фундамент + сервер (параллельно)
- Integration: S1, S2, S3 + тесты сервера, фикстуры.
- iOS: F0 (разрез AppState, DI, токены, String Catalog, iPad-решение, PrivacyInfo), F1 (D9), фикс D2/D15.
- Android: F0 (апгрейд тулчейна, Nav3, Hilt, тема DayNight, strings, общий scaffold), F1 (стек при logout).
- QA: UI-тест-харнесс на обеих платформах (iOS XCUITest + Compose UI tests), сценарии onboarding.

**Гейт:** обе платформы проходят одинаковый сценарий «сервер → вход → инбокс → выход», скриншоты light/dark, parity F0/F1 = ✓.

### Волна 2 — Сообщения (ядро продукта)
F2 → F5 → F3 → F4 на обеих платформах параллельно, против фикстур S1/S2.
**Гейт:** тест «отправка в офлайне → рестарт приложения → реконнект → ровно одна доставка» проходит на обеих платформах; unread совпадает; правка/удаление собеседника видны в открытом чате.

### Волна 3 — Файлы, объявления, профиль, звонки
F6, F7, F9, F8 (CallKit / Foreground Service, восстановление после отказа в микрофоне).
**Гейт:** вложение jpg/pdf выбрано→загружено→открыто на обеих платформах из одной фикстуры; звонок iOS↔Android↔Desktop на реальных устройствах (ручная проверка, фиксируется в отчёте).

### Волна 4 — Паритет с десктопом и push
F10, F11, S4 + F12 (при наличии аккаунтов Apple Developer / Firebase).

### Волна 5 — Release readiness
- Полировка дизайна (`impeccable`, `ios-design-review`), доступность: Dynamic Type XXL / fontScale 2.0, VoiceOver/TalkBack, контраст.
- iOS / App Store: подпись и TestFlight, `app-store-review` чек-лист (PrivacyInfo, permission-строки, iPad, демо-аккаунт и стенд для App Review, удаление аккаунта если есть регистрация в приложении).
- Android / Google Play: AAB, Play App Signing, targetSdk 36, Data safety, декларация foreground service типов, R8 keep-правила по результатам release-прогона.
- QA: e2e-матрица, отчёт release-signoff только с ссылками на CI-артефакты и устройства.

## 5. Цикл работы над каждым модулем

1. Integration публикует контракт + фикстуры (PR в интеграционную ветку).
2. iOS Lead и Android Lead параллельно: failing test на фикстурах → реализация → UI → скриншоты.
3. QA: прогон тестов, сверка поведения по чек-листу модуля, обновление parity-матрицы; расхождение = блокер.
4. Оркестратор: код-ревью (`requesting-code-review`), слияние, CI на HEAD.

## 6. Риски

- **iOS без Mac**: каждая итерация iOS = push + ~5 мин CI. Смягчение: мелкие коммиты, скриншоты как артефакты, позже облачный Mac для ручной проверки.
- **Push требует аккаунтов** (Apple Developer Program, Firebase) и решения о приватности payload.
- **Публикация корпоративного мессенджера**: App Review требует доступный стенд и демо-аккаунт; альтернатива — Apple Business Manager (Custom App) / Managed Google Play (private app).
- **Серверные изменения** затрагивают десктоп — только аддитивные поля и новые эндпоинты, десктопные тесты в гейте.

## 7. Исполняемые задачи (subagent-driven-development)

### Global Constraints (binding for every task)

- Integration branch: `mobile-release-parity-impl`. Per-role worktrees (created by the controller):
  - iOS → `C:/Users/user/Documents/Нет в репо/chat/.claude/worktrees/m-ios` (branch `mobile/ios`), owns `mobile/ios/**`, `.github/workflows/mobile-ios.yml`.
  - Android → `.../worktrees/m-android` (branch `mobile/android`), owns `mobile/android/**`, `.github/workflows/mobile-android.yml`.
  - Integration → `.../worktrees/m-integration` (branch `mobile/integration`), owns `server/**`, `mobile/contracts/**`, `mobile/dev/**`.
  - QA → `.../worktrees/m-qa` (branch `mobile/qa`), owns `mobile/qa/**`.
  - Never edit paths you do not own. Never push except where a task says so.
- Release builds: HTTPS/WSS only; tokens fail closed; no plaintext secrets; Android backup exclusions stay intact. Debug-only exceptions must be build-config gated.
- `mobile/contracts/*` is the source of truth. Platform behaviour must match it; contract changes come from Integration only.
- Server changes are additive and backward compatible with `desktop/` (existing desktop/server tests must keep passing).
- UI: iOS = SwiftUI + HIG (semantic colours, Dynamic Type, 44pt targets, VoiceOver labels, `ContentUnavailableView`, String Catalog `ru`). Android = Compose + Material 3 (edge-to-edge, IME insets, 48dp targets, `stringResource`, semantics, DayNight). Brand tokens come from `desktop/src/renderer/src/styles/theme.css` (primary `#5b4ee6`/`#6457ee`, bg `#fcfcfd`/`#24242a`, online `#2da44e`, away `#d4951c`, dnd `#d9363b`, brand gradient `#ec8ee0→#c078ee→#7c44ea→#2a72ee→#00daff`).
- All user-facing copy in Russian.
- TDD: failing test first for every behaviour change; small logical commits with conventional messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verification commands:
  - Android (Windows, Cyrillic path workaround): `cd mobile/android && JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache testDebugUnitTest lint assembleDebug`. Emulator `Pixel_8` is running as `emulator-5554`; adb at `$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe`.
  - iOS: no local Xcode. Push branch `mobile/ios` to `origin` and watch `gh run list --branch mobile/ios --workflow mobile-ios` / `gh run watch <id> --exit-status`; read failures with `gh run view <id> --log-failed`. A task is not done until the run is green.
  - Server: `cd server && npm test`.

### Task 1: iOS — make HEAD compile, green CI, screenshot evidence, store-blocker metadata

Worktree `m-ios`. 21 commits since the last green iOS CI (`98378e6`) were never compiled (Keychain fail-closed, `AudioCallRelay`, inbox redesign, `CentyColors`).
- Push `mobile/ios`, read the CI failures, fix compile errors and test failures until `mobile-ios` is green. Do not weaken tests to pass.
- Swift 6 isolation in `Core/Audio/AudioCallRelay.swift`: AVAudioEngine `installTap`/`scheduleBuffer` completion and `requestRecordPermission` callbacks run off the main thread. Make these closures `nonisolated`/`@Sendable`, hop to the main actor only for state, and add a unit test that invokes the tap handler from a background queue without crashing.
- `PrivacyInfo.xcprivacy`: declare `NSPrivacyAccessedAPICategorySystemBootTime` with reason `35F9.1` (used via `mach_absolute_time`). Add an XCTest that parses the bundled manifest and asserts the category is present (`mobile/qa/*.ps1` is QA-owned; do not edit it).
- `Info.plist`: remove `UIRequiredDeviceCapabilities=armv7`; keep iPad support with all four orientations (iPad multitasking) — do not add `UIRequiresFullScreen`.
- Delete the dead duplicate entry point `CentyChat/App/CentyChatApp.swift` (excluded from target) and update the pbxproj exception list.
- Add UI test `ScreenshotTourTests` that launches with the existing `LaunchTestFixture` flags and captures `XCTAttachment(screenshot:)` with `.keepAlways` for every reachable screen in light and dark appearance; CI already uploads the xcresult.
- Acceptance: green `mobile-ios` run on the pushed head; report the run URL.

### Task 2: Android — baseline green on Windows + live emulator smoke

Worktree `m-android`.
- `ServerEndpointPolicyTest.invalidServerUrlUsesTheRussianOnboardingMessage` was saved with `?` instead of Cyrillic (uncommitted in the integration worktree; re-create it in your worktree). Write it with the real Russian message used by `ServerEndpointPolicy`, make sure Kotlin/Java compilation reads sources as UTF-8 on Windows, make the test pass.
- Add `mobile/android/README.md` with the exact Windows verification commands (Global Constraints) and how to install on `emulator-5554`.
- Install the debug APK on `emulator-5554`, launch, capture screenshots of server setup and login (`adb exec-out screencap -p`) into `mobile/android/build-evidence/` (git-ignored) and describe them in the report.
- Acceptance: full Android command green; screenshots captured.

### Task 3: Integration — local HTTPS dev stand with seed data

Worktree `m-integration`. Goal: log in from the Android emulator and from iOS CI UI tests against a real server. The server itself is HTTP-only (`server/src/index.js`); HTTPS is expected from a reverse proxy (`HTTPS_TERMINATED`, `TRUSTED_PROXY_IPS` in `.env.example`).
- `mobile/dev/tls-proxy.mjs`: zero-dependency Node HTTPS+WSS reverse proxy (`node:https`, `node:http`, upgrade handling) in front of the server, listening on `0.0.0.0:8443`, setting `X-Forwarded-Proto: https`.
- `mobile/dev/make-dev-ca.sh`: generates (openssl) a dev root CA and a leaf cert with SANs `localhost`, `127.0.0.1`, `10.0.2.2` into `mobile/dev/certs/` (git-ignored). Document where the CA public cert is so platform tasks can trust it in debug builds only; do not edit `mobile/android` or `mobile/ios`.
- `mobile/dev/seed.mjs`: seeds a fresh server data dir with users `alice`/`bob` (passwords meeting the server password policy, documented in `mobile/dev/README.md`), one channel, a few direct and channel messages, one announcement, and one attachment — through the server's own services/APIs where practical.
- `mobile/dev/README.md`: one-command start (server + proxy) for Windows Git Bash and for the macOS CI runner; dev-only env file `mobile/dev/dev.env`.
- Test: a Node test that boots server+proxy on random ports, logs in as `alice` over HTTPS with the dev CA, opens WSS and receives `auth_success`.
- Acceptance: `cd server && npm test` green + new test green.

### Task 4: Integration — contract corrections and shared fixtures

Worktree `m-integration`.
- `mobile/contracts/ws-protocol.md`: fix §6.3 (an expired token cannot be refreshed: re-login or `/auth/knock` with device secret; `/auth/refresh` only for a still-valid token; there is no `afterId` catch-up yet). Document that `new_message` is sent together with `direct_message`/`channel_message` for the same message and clients must dedupe by message id. Document every server→client event mobile uses (`auth_success`, `auth_error`, `server_disconnect`, `new_message`, `direct_message`, `channel_message`, `message_status_updated`, `messages_read`, `message_updated`, `message_deleted`, `user_typing`, `user_status_changed`, `channel_created`, `channel_deleted`, `new_announcement`, `announcement_acknowledged`, `call_*`, `call_denied`, `call_unavailable`, `wake_*`, `error`) with exact JSON shapes taken from `server/src/ws`.
- `mobile/contracts/fixtures/`: JSON fixtures produced from real server code paths: auth (login/knock/me), users, channels, direct conversations, messages page, file policy, announcements, and one file per WS event above. `fixtures/README.md` describes naming and that both platforms must decode every fixture in unit tests.
- A server test that regenerates/validates fixtures against current serializers so they cannot drift.
- `mobile/contracts/parity-matrix.md`: replace ✅ claims with real status from section 0 of this plan (honest ✗/◐).
- Acceptance: server tests green; fixtures cover every event listed.

### Task 5: Integration — idempotent send, delta sync, delivered-on-reconnect (S1–S3)

Worktree `m-integration`. Additive only.
- S1: WS `send_message` (and aliases) plus REST `POST /messages/direct/:id`, `POST /messages/channels/:id` accept optional `client_msg_id` (string ≤64). Persist with a unique index on `(sender_id, client_msg_id)`. A duplicate returns/broadcasts the existing message instead of inserting. Echo `client_msg_id` in `new_message`/`direct_message`/`channel_message` payloads and REST responses.
- S2: `GET /api/messages?conversationType&targetId&afterId&limit` (ascending, ≤200) and `GET /api/sync?since=<cursor>` returning messages created/edited/deleted after the cursor across all conversations visible to the user, plus `next_cursor`. Maintain `updated_at` on edit/delete.
- S3: when a recipient (re)authenticates on WS, mark undelivered direct messages to them `delivered` and emit `message_status_updated` to online senders; the REST send path also marks delivered when the recipient is online.
- Update `openapi.yaml`, `ws-protocol.md`, fixtures.
- Tests for each (duplicate send → one row; afterId paging; sync after edit/delete; delivered after reconnect). Desktop and existing server tests unaffected.

### Task 6: iOS — architecture split and correctness fixes (F0/F1/F2 base)

Worktree `m-ios`. Depends on Tasks 1 and 4 (merge integration branch first).
- Split `App/AppState.swift` into `@Observable @MainActor` stores: `SessionStore`, `RealtimeStore` (single WS event pump + dedupe by message id), `ConversationsStore`, `ChatStore` (per conversation), `AnnouncementsStore`, `CallStore`, `ProfileStore`; `…Repository` protocols over `APIClient`/`WebSocketClient`; `AppContainer` injected via `Environment`. Views must not reference `APIClient.shared`/`WebSocketClient.shared`.
- WS listening starts whenever a session becomes authenticated (including after first-run server setup and after re-login) and stops on logout; the incoming-audio listener is re-armed. Implement message status/content/deletion updates so an open chat reflects realtime events.
- `mustChangePassword`: single presentation; after success the session becomes authenticated.
- Reconnect backoff must grow (not reset on each `connect()`); expose `connectionState`.
- Initial data load is not all-or-nothing: each list has its own loading/error state.
- Replace `print` with `os.Logger`; add String Catalog `Localizable.xcstrings` (ru), move all user-facing literals, translate English leftovers.
- Unit tests decode every file in `mobile/contracts/fixtures`.
- Acceptance: green CI; tests for dedupe, realtime edit/delete in open chat, WS lifecycle on login/logout, password-change flow.

### Task 7: iOS — design system and screen polish (impeccable pass)

Worktree `m-ios`. Depends on Task 6.
- Read the design brief at `C:/Users/user/Documents/Нет в репо/chat/.claude/worktrees/mobile-release-parity/docs/superpowers/plans/2026-10-02-design-brief.md` and apply it.
- `UI/DesignSystem`: desktop tokens (colours light/dark, typography mapped to Dynamic Type text styles — no fixed `.system(size:)` except icon glyphs, spacing, radii); components `AvatarView` (deterministic colour from user id, not `hashValue`), `StatusDot`, `EmptyStateView`/`ErrorStateView` (retry), `ConnectionBanner`, bubble styles, buttons.
- Apply to every screen: server setup, login, change password, chat list, chat detail (multi-line composer `axis: .vertical`, 44pt attach/cancel targets, scalable timestamps, date separators via cached `Date.FormatStyle`), announcements (title consistent with tab «Объявления», cards as Buttons), call, profile. iPad: `NavigationSplitView` list + detail.
- Accessibility: labels/hints/values on all controls; Dynamic Type up to AX5 without truncating primary actions.
- `#Preview` for every screen with mock repositories.
- Extend `ScreenshotTourTests` to capture every screen light/dark and at an accessibility text size.
- Acceptance: green CI; screenshots attached; report lists before/after per screen.
- **Extended 2026-10-02:** also implement the design brief section «UI layer v2» in full on iOS:
  - the "message lands" focal sequence;
  - the zoom/matched transition inbox → chat;
  - keyboard glued via `safeAreaInset` + `.scrollDismissesKeyboard(.interactively)`;
  - the four-plane depth model with system materials;
  - all 15 visual components with `#Preview`, including the spot illustrations as SwiftUI `Shape`s;
  - the delight moments and Reduce Motion fallbacks.
  
  Record the simulator videos listed in the brief in CI.

### Task 8: Android — toolchain, Navigation 3, DI, lifecycle fixes (F0/F1)

Worktree `m-android`. Depends on Task 2.
- Upgrade to current stable AGP/Kotlin/Compose BOM compatible with Navigation 3 1.x; compileSdk/targetSdk 36. Remove unused `navigation-compose` and the custom `NavBackStack`.
- Navigation 3 (follow `.agents/skills/navigation-3`): `NavDisplay` with saveable-state and ViewModel-store entry decorators (ViewModel per entry → fixes repeated-call auto-close and back-not-ending-call); top-level tabs with independent back stacks and no duplicate entries; `NavigationSuiteScaffold` (bar/rail by window size); list-detail scene for conversations↔chat on expanded widths; logout clears all stacks to Login.
- Hilt DI replacing the service locator; repositories between ViewModels and `ApiClient`/`WebSocketClient`; one `UiState` sealed type per screen.
- WS: separate flows for chat events and audio frames; expose `connectionState`; handle `auth_error`; dedupe `new_message` vs `direct_message`/`channel_message` by id; fix unread increments for the open chat and own messages; fix direct `message_deleted` matching (server sends `target_id` = recipient).
- Unit tests for navigation state (tab switching, back, logout) and ViewModel scoping; set up `androidTest` with one onboarding Compose UI test running on `emulator-5554`.
- Acceptance: full Android command + `connectedDebugAndroidTest` green.

### Task 9: Android — design system and screen polish (impeccable pass)

Worktree `m-android`. Depends on Task 8.
- Read the same design brief as Task 7 and apply it.
- Theme: XML parent `Theme.Material3.DayNight.NoActionBar` + SplashScreen API; Compose `ColorScheme` light/dark from desktop tokens; full typography scale; delete stale teal `colors.xml`; bubble colours from theme roles (remove `background.red < 0.5f` hack).
- Components mirroring iOS: Avatar (deterministic colour + Coil 3 image via authenticated OkHttp), StatusDot, EmptyState/ErrorState with retry, ConnectionBanner, Snackbar host, pull-to-refresh.
- Fix visible bugs: literal `${channel.membersCount}`, misleading search placeholder, delete confirmation, auto-scroll only when already at bottom, Toast → Snackbar, `ChatScreen` loading/error states, announcements errors surfaced.
- Edge-to-edge: lists use `contentPadding` with insets; IME handling on all forms.
- All literals → `strings.xml` (ru) with plurals; semantics/Role/stateDescription; 48dp targets.
- Debug-only trust of the dev CA from Task 3 via `src/debug/res/xml` network security config so login works on the emulator against `https://10.0.2.2:8443`.
- Screenshot every screen light/dark and fontScale 2.0 on `emulator-5554` into `build-evidence/` and describe in report.
- Acceptance: Android command + androidTest green; screenshots.

### Task 10: QA — parity harness and Wave 1 gate

Worktree `m-qa`. Runs after Tasks 1–9 are merged into the integration branch.
- Update `mobile/qa/test-scenarios/e2e-matrix.md` (fix AUTH-02/SYNC-03 premises per corrected contract) and `reports/parity-audit-report.md` with evidence links (CI run URLs, screenshot paths) for F0/F1.
- Live run on `emulator-5554` against the dev stand: onboarding → login as alice → inbox → open chat → send → logout; record results.
- List parity deviations between iOS and Android screenshots/behaviour as blockers for the next wave.

### Shared requirements for Tasks 11–12: fixed production server + branded login (owner request 2026-10-02)

Owner: "remove the connect-to-server button, preset the working server, brand the login page, make it convenient and secure".

- **Production server** `https://centychat-production.up.railway.app` (same default as desktop `desktop/src/main/main.js:92`; `/api/health` 200, valid Let's Encrypt chain, HSTS present). API base `…/api`, WS `wss://centychat-production.up.railway.app/ws`.
- **Release builds:** the server URL is a compile-time constant. No server-setup screen, no "change server" control, no runtime override (no deep link, launch argument, intent extra, or stored value can change it). A previously stored custom server URL from older installs is ignored; if a stored session/device credential was issued for a different host, it is wiped and the user lands on login.
- **Debug builds only:** the URL comes from build configuration (Android `BuildConfig.SERVER_URL` from Gradle property `centychat.serverUrl`, default = production; iOS `CENTYCHAT_SERVER_URL` in the Debug xcconfig/Info.plist key, default = production; iOS UI tests may pass a launch argument honoured only under `#if DEBUG`). Used for the dev stand (`https://10.0.2.2:8443` / `https://localhost:8443`). Still no runtime UI to switch.
- **Threat model (security-and-hardening):**
  - Spoofing/phishing: removing the editable server field removes the "type your corporate password into an attacker's server" vector — keep it removed. Standard system TLS validation + hostname check; HTTPS/WSS only. Certificate pinning is NOT added now (Railway wildcard cert, Let's Encrypt root rotation would brick the app) — recorded as a follow-up once a company domain exists.
  - Information disclosure: password never logged, never persisted (only tokens/device secret in Keychain/Keystore, fail-closed as today); password field is secure entry with autocorrect/suggestions off; login form errors are generic («Неверный логин или пароль») — never reveal whether the login exists; server `company_name` from `/api/settings/info` is rendered as plain text only and length-capped.
  - DoS / abuse: disable the submit button while a request is in flight (no double submit); honour `429 ACCOUNT_THROTTLED` / `Retry-After` and `503 LOGIN_BUSY` with a countdown message instead of retry loops.
  - Convenience without weakening: system password autofill (iOS `textContentType(.username/.password)` + associated-domains not required; Android autofill hints `username`/`password`), keyboard "next"/"go", remember the last login name (not the password) in non-secret prefs, show/hide password toggle, passwordless re-entry via existing device knock/claim untouched.
- **Branded login (design brief):** gradient C mark + «CentyChat» lockup, company name from `/api/settings/info` (fallback «Корпоративный мессенджер»), single card with login/password and full-width primary «Войти», error box styled like desktop `.login-error-box`, content in the upper third and keyboard-safe, light/dark, Dynamic Type / fontScale safe, motion: mark fades/scales in once (respect Reduce Motion), button shows in-place progress.
- Tests (TDD): release config resolves exactly the production URL and exposes no override path; stale stored server URL is ignored and foreign-host session wiped; login error mapping (401 generic, 429 with Retry-After countdown, 503, offline); double-submit prevented; first launch goes straight to login.

### Task 11: iOS — fixed production server and branded login

Worktree `m-ios`. Depends on Task 6. Implement the shared requirements above on iOS: remove `Features/ServerConnect` from the app flow (delete the screen and its routing), introduce `ServerEnvironment` (compile-time constant in Release, xcconfig-driven in Debug), migrate/wipe stale stored server and foreign-host credentials, rebuild `LoginView` per the design brief, update `ScreenshotTourTests` and `AppLaunchTests` (fresh install now shows login, not server setup). Acceptance: green CI with screenshots of login light/dark/AX size.

### Task 12: Android — fixed production server and branded login

Worktree `m-android`. Depends on Task 8. Implement the shared requirements above on Android: remove the server-connect destination and screen, `BuildConfig.SERVER_URL` (release = production constant, debug overridable via Gradle property), migrate/wipe stale stored server and foreign-host credentials, rebuild the login screen per the design brief, Compose UI tests for first launch → login and error states. Debug build pointed at the dev stand must log in as `alice` on `emulator-5554` (trust of the dev CA in debug network-security config only — this moves here from Task 9). Acceptance: Android command + `connectedDebugAndroidTest` green; screenshots light/dark/fontScale 2.0.

### Task 13: Integration — delivery-state contract and shared reducer test vectors (Wave 2 contract-first)

Worktree `m-integration`. Depends on Task 5 (`client_msg_id`, `/api/sync`, delivered-on-reconnect).
- `mobile/contracts/delivery-state.md`: the single client-side model of a message's life, binding on iOS and Android:
  - states `queued → sending → sent → delivered → read` and `failed`;
  - transition table with triggers: enqueue, WS send attempt, echo matched by `client_msg_id`, `message_status_updated`, `messages_read`, ack timeout, WS rate-limit drop, 409 `CLIENT_MSG_ID_CONFLICT`, permanent 4xx, reconnect replay, user retry, user cancel;
  - `client_msg_id` generation rule (charset `[A-Za-z0-9_-]`, ≤64, e.g. UUIDv4 without braces);
  - per-conversation ordering and replay order;
  - retry/backoff policy and max attempts before `failed`;
  - the composer is cleared only after a durable enqueue;
  - temp-id → server-id reconciliation;
  - dedupe of `new_message` vs `direct_message`/`channel_message`;
  - unread rules (no unread for own messages or the open chat);
  - sync merge rules (upsert by id, tombstones, cursor persistence, 410 → full resync);
  - edit/delete while queued.
- `mobile/contracts/reference/delivery-reducer.mjs`: a small pure reference reducer implementing the spec (no I/O).
- `mobile/contracts/fixtures/reducers/*.json`: table-driven test vectors `{ name, initialState, events[], expectedState }` covering every transition and the abuse/edge cases above (at least 30 vectors). Use the same JSON event shapes as the WS/HTTP fixtures.
- A server-side test (`server/test/mobile-delivery-reducer.test.js`, added to the explicit test list) runs every vector against the reference reducer, so vectors are self-consistent. Both platforms will later run the same vectors against their own reducers.
- Acceptance: `cd server && npm test` green; README in `fixtures/reducers/` explains the vector format and that iOS/Android must run all of them.

### Task 16: Integration — close server delivery gaps G1–G4, G7–G9 (additive)

Worktree `m-integration`. Depends on Task 13. Source: `mobile/contracts/delivery-state.md` §10.
- G1: process WS frames of one socket sequentially (per-socket promise queue), so storage order = send order; keep other sockets concurrent. Test two rapid `send_message` frames get ascending ids.
- G2: when a frame is rate-limited, reply `error {context, code:"RATE_LIMITED", retry_after_ms, client_msg_id?|messageId?}` instead of silence (still dropping the frame).
- G3: every `send_message` refusal carries `code` and `retryable` (bool); refusals happen only before the INSERT where possible; a failure after INSERT echoes the stored message instead of an error.
- G4: `edit_message`/`delete_message` errors carry `messageId` and `code` (`EDIT_WINDOW_EXPIRED`, `DELETE_WINDOW_EXPIRED`, `NOT_OWNER`, `NOT_FOUND`, …); deleting an already-deleted message returns the tombstone (idempotent success).
- G7: `last_message_id` in `GET /api/channels`.
- G8: `updated_at` in `message_deleted`.
- G9: `cancel_message {client_msg_id}` — server remembers the cancelled key per sender (bounded TTL, e.g. 24 h); a later send with that key is refused with `code:"CANCELLED"`; if already stored, the server deletes it and broadcasts `message_deleted`.
- Desktop must keep working unchanged (error frames are read only for `message`/`text` there — keep those fields).
- Update `ws-protocol.md`, `delivery-state.md` (use the new signals when present; keep the old fallbacks), the reference reducer, vectors (new vectors for each signal; all existing vectors still pass), fixtures (`--write`), and the Task 13 deferred minors (persisted cancelled-key set; hide messages with a pending delete op).
- TDD; full `npm test` green.

### Task 17: Android — UI layer v2 (transitions, keyboard, depth, visual components)

Worktree `m-android`. Depends on Task 9. Implement the design brief section «UI layer v2» in full on Android:
- motion thesis, with the "message lands" focal sequence and shared-element inbox → chat via Navigation 3 + `SharedTransitionLayout`;
- keyboard glued to the composer with animated IME insets, `reverseLayout`, `imeNestedScroll` interactive dismiss, and a growing composer;
- the four-plane depth model with lift-on-scroll top bars;
- all 15 visual components, as a `ui/components` library with Compose previews, including authored vector spot illustrations as `ImageVector`s;
- the delight moments;
- Reduce-motion fallbacks.

Acceptance: the screen recordings listed in the brief, captured on `emulator-5554` against the dev stand, plus Compose UI tests for SwipeToReply threshold, ContextMenu actions, JumpToLatestPill visibility rule, and ConnectionBanner states. Android command + androidTest green.

### Task 14: iOS — Wave 2 messaging core (outbox, realtime, chat)

Worktree `m-ios`. Depends on Tasks 7 and 16. Implement `mobile/contracts/delivery-state.md` on iOS: a Swift reducer that passes every vector in `mobile/contracts/fixtures/reducers/` (table-driven XCTest reading the JSON), a SwiftData-backed durable outbox + conversation cache, an effects executor (WS send, HTTP flush, timers, persist barrier, sync chain via `/api/sync`, 410 resync), reconnect algorithm, composer cleared only after durable enqueue, visible queued/sending/sent/delivered/read/failed states with retry/cancel per the design brief's motion grammar, history pagination (`beforeId`), and chat polish (reply, edit/delete confirmation). Screenshots of offline send → reconnect in CI against the dev stand.

### Task 15: Android — Wave 2 messaging core (outbox, realtime, chat)

Worktree `m-android`. Depends on Tasks 9 and 16. Same as Task 14 on Android: Kotlin reducer passing every vector (JUnit reading the JSON), Room-backed outbox + cache, effects executor with WorkManager for background flush, `/api/sync` chain + 410 resync, composer rules, visible delivery states with retry/cancel and motion, history paging, reply/edit/delete confirmation. Emulator evidence: airplane mode send → restart → reconnect → exactly one delivery seen from bob's session.

> Execution order per lane: iOS 1 → 6 → 11 → 7 → 14; Android 2 → 8 → 12 → 9 → 17 → 15; Integration 3 → 4 → 5 → 13 → 16; QA 10 after Wave 1.
> Waves 2–5 (outbox/realtime, attachments/announcements/profile/calls, contacts/search/push, release) are appended as Tasks 13+ after the Wave 1 gate, in the same structure.
