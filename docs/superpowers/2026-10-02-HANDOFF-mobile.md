# CentyChat Mobile — передача работы следующему агенту (2026-10-02, 16:50)

Это отчёт для агента (Claude Code / Codex), который продолжит работу над мобильными клиентами CentyChat. Прочитайте его целиком до любых действий.

## 0. TL;DR

- **Сервер готов полностью** по плану (задачи 3, 4, 5, 13, 16, 18, 19, 20).
- **Android:** готовы задачи 2, 8, 12, 9, 17. **Задача 21** («Сотрудники» + общий поиск) **не начата**: была только разведка, кода нет. ⚠️ Android-тест фикстур сейчас красный — см. §5.
- **iOS:** готовы задачи 1, 6, 11. Дальше нужна сборка. На этой Windows-машине нет Xcode, а GitHub Actions упёрся в лимит расходов (приватный репозиторий, macOS-минуты считаются ×10). **Владелец будет собирать iOS на своём MacBook.**
- Интеграционная ветка — `mobile-release-parity-impl`. Перед завершением сессии отправлена на `origin`.
- Источники правды:
  - план: `docs/superpowers/plans/2026-10-02-mobile-completion.md`;
  - дизайн-бриф: `docs/superpowers/plans/2026-10-02-design-brief.md`;
  - продукт: `PRODUCT.md`;
  - контракты: `mobile/contracts/*`;
  - журнал решений: `docs/superpowers/sdd-archive/2026-10-02/progress.md` (копия журнала SDD).

## 1. Репозиторий, ветки, worktree

Корень: `C:/Users/user/Documents/Нет в репо/chat`. Remote: `https://github.com/Tamerlan12345/chat.git`.

| Worktree (`.claude/worktrees/…`) | Ветка | Роль | Владеет путями |
|---|---|---|---|
| `mobile-release-parity` | `mobile-release-parity-impl` | **интеграционная**, сюда вливается всё после ревью | план/доки |
| `m-ios` | `mobile/ios` | iOS Lead | `mobile/ios/**`, `.github/workflows/mobile-ios.yml` |
| `m-android` | `mobile/android` | Android Lead | `mobile/android/**`, `.github/workflows/mobile-android.yml` |
| `m-integration` | `mobile/integration` | Integration (сервер + контракты) | `server/**`, `mobile/contracts/**`, `mobile/dev/**` |
| `m-qa` | `mobile/qa` | QA | `mobile/qa/**` (ещё не запускался) |

Правила:
- Агент правит только свои пути. Слияние делает контроллер:
  - сначала `git merge --no-ff mobile/<role>` в интеграционной ветке;
  - потом `git merge --ff-only mobile-release-parity-impl` в worktree роли.
- `master` не трогать. Работа над мобильными клиентами живёт в `mobile-release-parity-impl` (на GitHub открыт PR #3).
- Папка `.superpowers/` исключена через `.git/info/exclude`: в ней рабочие файлы SDD (брифы, отчёты, пакеты ревью). Ключевое архивировано в `docs/superpowers/sdd-archive/2026-10-02/`.
- Окончания строк: в репо CRLF/LF вперемешку. Не переформатируйте файлы целиком.

## 2. Скиллы и порядок работы (обязательно)

Скиллы проекта лежат в `.agents/skills/` (установлены через `npx skills add`) и в `~/.claude/skills/`.

**Оркестрация** (по требованию владельца — только через субагентов):
- `subagent-driven-development` (`~/.claude/skills/subagent-driven-development/`) — основной процесс.
  - На каждую задачу плана запускается свежий implementer-субагент, затем task-reviewer (соответствие спецификации + качество).
  - Fix-loop не больше 5 раундов: раунды 1–3 продолжают того же implementer, 4–5 идут свежим агентом на более сильной модели.
  - После всех задач — финальное ревью всей ветки.
  - Скрипты:
    - `scripts/sdd-workspace PLAN` — рабочая папка;
    - `scripts/task-brief PLAN N` — бриф задачи (берёт заголовок `### Task N:`);
    - `scripts/review-package PLAN BASE refs/heads/<branch>` — diff для ревью. Используйте `refs/heads/...`, иначе git путает ветку `mobile/ios` с одноимённой папкой.
  - Инструкции ревьюера: `.superpowers/sdd/2026-10-02-mobile-completion/reviewer-instructions.md` и `re-review-instructions.md` (копии лежат в архиве).
- Скиллы `parallel-feature-development`, `team-composition-patterns`, `task-coordination-strategies` (`.agents/skills/`) дают модель ролей:
  - iOS Lead;
  - Android Lead;
  - Integration;
  - QA.

  Роли работают параллельно в разных worktree, внутри одной роли задачи идут последовательно.
- **Журнал прогресса** ведите в `<workspace>/progress.md`:
  - формат строки: `Task N: complete (commits a..b, review clean)`;
  - каждое решение контроллера: `Ruling: <что> — <почему> — <цена ошибки>`;
  - незакрытые мелочи: `minor (deferred)`.

**Дизайн:**
- `impeccable` (`~/.claude/skills/impeccable/`):
  - запуск: `sh ~/.claude/skills/impeccable/scripts/impeccable context --target mobile/android` из корня worktree;
  - справочники `reference/ios.md`, `android.md`, `craft-floor.md`, `animate.md`, `delight.md`, `layout.md`, `polish.md`.
  - Мир бренда задан (графит десктопа, один индиго, градиент только на знаке «C»), поэтому концепции заново не разыгрываются.
  - После каждой UI-задачи нужно независимое дизайн-ревью по скриншотам и кадрам видео (кадры из mp4 извлекаются Python `imageio-ffmpeg` в scratchpad).

**iOS:**
- `write-swift`, `swiftui-patterns`, `mobile-ios-design`, `app-store-review` (`.agents/skills/`). Сам `app-store-review` здесь только чек-лист качества: распространение корпоративное.

**Android:**
- `mobile-android-design`, `navigation-3`, `edge-to-edge` (`.agents/skills/`).

**Качество и безопасность:**
- `test-driven-development` — сначала падающий тест;
- `verification-before-completion`;
- `requesting-code-review`;
- `security-and-hardening` (`.claude/skills/security-and-hardening/`) — модель угроз для всего, что касается авторизации, сети, файлов и push.

## 3. Решения владельца (не пересматривать)

1. **Распространение корпоративное**: TestFlight / Apple Business Manager Custom App и Managed Google Play. Публичных сторов нет.
2. **Сервер в релизе фиксирован**: `https://centychat-production.up.railway.app`. Экрана «Подключиться к серверу» нет. **Debug-сборки по умолчанию смотрят на dev-стенд** (`https://10.0.2.2:8443` на Android-эмуляторе, `https://localhost:8443` на iOS-симуляторе), production из debug — только явным `-Pcentychat.serverUrl` или настройкой xcconfig.
3. **Push**: в payload только id. Ни текста, ни имён через Google/Apple.
4. **Сервер можно менять только аддитивно**, без поломки `desktop/`.
5. **Дизайн — близко к десктопу**, плавно, с анимациями. Это бриф v1, затем «UI layer v2», затем «People surface + universal search», затем «Anti-AI polish pass».
6. **Поиск контактов**: вкладка «Сотрудники» + общий поиск в «Чатах». В карточке показываются телефон, email, статус и «был(а) в сети».
7. **Отменённое пользователем сообщение никогда не доставляется** (`client_msg_id` + `cancel_message`).
8. **Сертификаты не закрепляем (pinning не делаем)**, пока у компании нет своего домена. Railway выдаёт wildcard-сертификат Let's Encrypt.
9. Владелец приоритизировал **визуал и контакты** выше офлайн-очереди. На Android порядок: 21 → 23 → 15.

## 4. Что сделано (по задачам; подробности — в плане и архивном журнале)

**Сервер / контракты (Integration):**
- **T3:** локальный HTTPS/WSS-стенд `mobile/dev/stand.mjs` с сидом (alice/bob; пароли в `mobile/dev/README.md`) и CA `mobile/dev/certs/` (в git не попадает).
- **T4:** контракты исправлены, общие фикстуры `mobile/contracts/fixtures/` (manifest + http/ws/push), тест расхождения фикстур с сервером.
- **T5:** `client_msg_id` (идемпотентность), `GET /api/messages?afterId`, `GET /api/sync?since=<epoch>.<seq>` (монотонный счётчик `sync_state`, 410 при смене эпохи), «доставлено» после переподключения.
- **T13:** `mobile/contracts/delivery-state.md` — единая клиентская модель доставки, эталонный reducer `mobile/contracts/reference/delivery-reducer.mjs`, **70 табличных векторов** `mobile/contracts/fixtures/reducers/`. Обе платформы обязаны проходить все векторы.
- **T16:**
  - кадры одного сокета обрабатываются последовательно;
  - `RATE_LIMITED` с `retry_after_ms`;
  - коды и `retryable` у ошибок;
  - `messageId` в ошибках правки и удаления;
  - `cancel_message`;
  - `last_message_id` в каналах;
  - `updated_at` в `message_deleted`.
- **T18:**
  - push FCM HTTP v1 + APNs HTTP/2 (только id), регистрация токенов `POST/DELETE /api/devices/push-token`;
  - каждая попытка перепроверяет владельца и сессию;
  - жизненный цикл push-звонка (`call_unavailable`, «надгробия» с `call_end`).
  - Описание: `mobile/contracts/push.md`.
- **T19:** звонки:
  - идемпотентный `call_answer`;
  - `offerSeq`;
  - тексты причин завершения звонка на десктопе.
- **T20:**
  - Range/ETag для скачивания;
  - миниатюры `/api/files/thumb/:id`;
  - ширина, высота и доминантный цвет вложений;
  - аватары по URL только по opt-in: заголовок `X-Avatar-Format: url` и WS `/ws?avatars=url`;
  - принять звонок можно только с одного сокета (`answered_elsewhere`);
  - зависимость `sharp` 0.35.5.
- Тесты: сервер ~713 зелёных, desktop 460.

**Android (`mobile/android`):**
- **T2:** сборка на Windows с кириллицей в пути. Сборочная папка перенесена в `%TEMP%/centychat-android-build/CentyChat-<hash>`, `android.overridePathCheck=true`. JDK: `C:/tmp/jdk17/jdk-17.0.20.1+1`.
- **T8:** Navigation 3 (свои стеки у вкладок, ViewModel на запись), Hilt, репозитории/UiState, исправления реалтайма, backoff только по `auth_success`, исправления звонков.
- **T12:**
  - прод-сервер в release;
  - миграция старых сессий;
  - брендированный вход;
  - dev-CA доверен только в debug;
  - тест фикстур.
- **T9:** токены десктопа, DayNight, SplashScreen, компоненты, контраст AA (`ThemeTokensTest`), исправлены визуальные баги.
- **T17 «UI layer v2»:**
  - сгруппированные пузыри;
  - липкая дата;
  - «↓ N новых»;
  - клавиатура, приклеенная к композеру (`reverseLayout` + `imeNestedScroll`);
  - shared element «список → чат»;
  - «сообщение приземляется» (`ChatLanding`);
  - галочки доставки рисуются штрихом;
  - свайп для ответа, контекстное меню;
  - иллюстрации пустых состояний;
  - уровень громкости в звонке;
  - debug-галерея компонентов.

  Дизайн-ревью: **ship**. Последние цифры: 216 unit и 48 instrumented.

**iOS (`mobile/ios`, только CI-сборки до блокировки оплаты):**
- **T1:** сборка Swift 6, nonisolated-фабрики аудио-колбэков, PrivacyInfo (SystemBootTime 35F9.1), ориентации iPad, `ScreenshotTourTests`.
- **T6:** `AppState` разбит на сторы (`SessionStore`, `RealtimeStore`, `ConversationsStore`, `ChatStore`, …), репозитории, `AppContainer`. Также:
  - дедупликация событий;
  - непрочитанные/`mark_read` с учётом `scenePhase`;
  - backoff только по `auth_success`;
  - String Catalog (ru), `os.Logger`.
- **T11:**
  - `ServerEnvironment` (release зафиксирован; CI-джоба проверяет бинарь Release);
  - стирание учётных данных от чужого хоста;
  - брендированный `LoginView`;
  - точный порт знака «C» (`BrandMarkTests`);
  - тест декодирования фикстур.
- Последний зелёный прогон: https://github.com/Tamerlan12345/chat/actions/runs/36970343746 (133 unit + 5 UI). Скриншоты: ветка `ci/ios-screenshots/<sha>/`, читается через `gh api` (blob-хранилище артефактов из этой сети недоступно).

## 5. Что осталось — по порядку

### Android (worktree `m-android`)

1. **T21 — начать заново (кода нет).**
   - Агент остановился, не написав ни строки. HEAD `mobile/android` = `ca49056`.
   - ⚠️ **Сейчас красный** `ContractFixturesTest.everyFixtureInTheManifestDecodes`: 9 фикстур не декодируются (`POST/DELETE /api/devices/push-token`, `PUT /api/users/avatar` и 6 файлов вида `push`). Чинить первым шагом.
   - Открытые вопросы из разведки агента:
     - серверный поиск сообщений регистрозависим для кириллицы (SQLite `LIKE`). Нужна правка на сервере (Integration): `lower()` + нормализация, или колонка для поиска;
     - счётчик «в сети» в оргдереве считает и «отошёл» — фильтр «В сети» должен считать так же (сделать как на десктопе: online + away);
     - `/api/users` не отдаёт `can_call` коллег, поэтому «Звонки недоступны» решается по правам самого звонящего.
   - План разведки: архивный `task-21-report.md`.
1a. **T21 — содержание.**
   - Сначала прочитайте WIP-коммит и раздел состояния в архивном отчёте (`sdd-archive/2026-10-02/task-21-report.md`, если успел записаться).
   - Спецификация: `sdd-archive/2026-10-02/people-search-spec.md` = раздел «People surface + universal search» дизайн-брифа.
   - Не забудьте:
     - `ContractFixturesTest` должен принимать новые виды из T18–T20 (`push`, `call_end.no_call`, `message_cancelled`, поля изображений);
     - opt-in аватаров `X-Avatar-Format: url` и `/ws?avatars=url`;
     - на dev-стенд нужно засеять ≥10 сотрудников в ≥3 отделах. Делайте это скриптом в scratchpad, не в репозиторий.
   - После реализации: ревью кода + дизайн-ревью (impeccable), затем merge.
2. **T23** — раздел «Anti-"AI-generated" polish pass» для всех экранов. Плюс отложенные мелочи T17:
   - панель навигации при возврате появляется на 250–290 мс позже;
   - анимация панели теряет кадры под R8;
   - вход своего пузыря без перелёта текста заменён на fade — таблицу анимаций нужно поправить.
3. **T15** — ядро сообщений волны 2:
   - Kotlin-reducer, проходящий **все 70 векторов**;
   - Room-outbox;
   - исполнитель эффектов на WorkManager;
   - `/api/sync` + 410;
   - отправка `reply_to_id` (ответ сейчас только локальный черновик);
   - queued/failed/retry/cancel на реальных данных;
   - правило `showsMeta` для QUEUED/SENDING вне конца группы + FIFO-тест (решение по T17);
   - правило §3.4 «скрывать сообщения с ожидающим удалением».
4. **Волна 3:**
   - вложения: picker, политика, прогресс, миниатюры по `/api/files/thumb`, просмотр;
   - создание чата и канала (FAB / «Начать чат»);
   - «Сменить пароль» в профиле;
   - фоновые звонки: ForegroundService `microphone|phoneCall` + уведомление;
   - FCM-клиент: нужен `google-services.json` из Firebase-проекта владельца — **у владельца его ещё нет**. Push-модель описана в `push.md` §3–§5.
   - Пароль-free knock: отправлять сохранённый device secret (сейчас knock без секрета не отправляется вовсе).
5. **Релиз:**
   - AAB;
   - Play App Signing (ключи у владельца);
   - Data safety;
   - декларация foreground service;
   - R8 keep-правила по прогону;
   - QA на реальном устройстве.

### iOS (worktree `m-ios`, сборка на MacBook владельца)

**Как собирать на Mac:**
1. `git fetch && git checkout mobile-release-parity-impl` (или `mobile/ios`).
2. Открыть `mobile/ios/CentyChat.xcodeproj`, схема `CentyChat`, Xcode 16+, iOS 17+.
3. Тесты: `xcodebuild -project mobile/ios/CentyChat.xcodeproj -scheme CentyChat -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' test CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual`. Ad-hoc подпись нужна для Keychain в симуляторе.
4. Dev-стенд для UI-тестов:
   - `node mobile/dev/stand.mjs`;
   - CA в симулятор: `xcrun simctl keychain booted add-root-cert mobile/dev/certs/dev-ca.crt`.
5. Debug-сервер задаётся в xcconfig/Info.plist (`CENTYCHAT_SERVER_URL`). Для iOS ещё нужно применить решение «debug по умолчанию = стенд», как на Android.

**Задачи:**
- **T7 (расширенная):** дизайн-система + все экраны + «UI layer v2» + «People surface + universal search» + «Anti-AI polish».
  - Учесть замечания дизайн-ревью T17 «Parity notes for iOS» из архивного журнала:
    - `joined` 2pt;
    - контур на всю группу пузырей;
    - липкая дата только при прокрутке;
    - стабильное правило показа времени;
    - скелетон только без кэша;
    - непрозрачная заливка поднятого пузыря;
    - перелёт текста через `matchedGeometryEffect`;
    - системное скрытие таб-бара;
    - `.navigationTransition(.zoom)`;
    - при Reduce Motion — кроссфейд 150 мс.
  - Аватар: hue по имени тем же алгоритмом, что на десктопе и в Android.
  - Перенести мелочи T11:
    - иконка «глаз» вылезает за поле на крупных шрифтах;
    - `Retry-After: 0` ничего не показывает;
    - двойной тап даёт ложную вибрацию;
    - лог стенда печатает пароли;
    - в Release Info.plist лишний ключ `CentyChatServerURL`;
    - тексты про «адрес сервера».
  - Тест фикстур iOS должен знать новые виды T18–T20.
- **T14:** Swift-reducer по 70 векторам, SwiftData-outbox, синхронизация, отправка ответов.
- **Волна 3:**
  - CallKit + PushKit (VoIP): каждый VoIP-push обязан сообщаться в CallKit;
  - Notification Service Extension: подтягивает текст с сервера по id;
  - вложения;
  - создание чатов.
  - Нужны: Apple Developer Team, APNs-ключ `.p8`, bundle id `<bundle>.voip`.
- **Релиз:** подпись, TestFlight / ABM, app-store-review как чек-лист.

### QA (worktree `m-qa`)
- **T10:**
  - `mobile/qa/test-scenarios/e2e-matrix.md` — исправить посылки AUTH-02 и SYNC-03;
  - `reports/parity-audit-report.md` — ссылки на доказательства;
  - живой прогон на эмуляторе: вход → чат → отправка → выход;
  - список расхождений iOS и Android.
- Перед релизом: `release-signoff.md` — только с доказательствами (CI, устройства).

### Финал
- Финальное ревью всей ветки `mobile-release-parity-impl` против `master`, на самой сильной модели. Не забыть все `minor (deferred)` из журнала.
- `superpowers:finishing-a-development-branch` — merge или PR в `master` только с согласия владельца.

## 6. Известные ловушки

- **Кириллица в пути ломает Gradle.** Используйте:
  - `JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache …`;
  - **не** ставьте `MSYS_NO_PATHCONV=1` в Git Bash: ломает пути Gradle.
- **Эмулятор `Pixel_8` (`emulator-5554`)** умирает через ~2 ч фонового процесса. Перезапуск: `"$LOCALAPPDATA/Android/Sdk/emulator/emulator.exe" -avd Pixel_8 -port 5554 -no-snapshot-save`.
- **Рабочий сервер.** Не ходите туда тестами. Из-за прошлых ошибок туда ушло около 4 отклонённых входов с dev-учётками. Теперь debug по умолчанию смотрит на стенд.
- **Локальный сервер владельца на `:2004`** — не трогать. Стенд работает на своих портах.
- **gitleaks в CI** сканирует всю историю. Не коммитьте ключи (RFC-векторы разрешены в `.gitleaks.toml`).
- **Разрешения.** Классификатор прав блокирует агентам `git merge` интеграционной ветки в их worktree. Merge делает контроллер. Push разрешён: `mobile-release-parity-impl` (по решению владельца) и `mobile/ios` (для CI).
- **`gh run download`** из этой сети не работает (blob reset). Скриншоты iOS — через ветку `ci/ios-screenshots`.

## 7. Где детали

- `docs/superpowers/sdd-archive/2026-10-02/progress.md` — полный журнал: каждая задача, каждое ревью, каждое `Ruling:` и `minor (deferred)`.
- `docs/superpowers/sdd-archive/2026-10-02/task-*-report.md` — отчёты исполнителей (что сделано, тесты, решения).
- `docs/superpowers/sdd-archive/2026-10-02/global-constraints.md`, `reviewer-instructions.md`, `re-review-instructions.md`.
- Доказательства: Android — `mobile/android/build-evidence/task9|task17|task21/` в `m-android` (в git не попадают, лежат только на диске); iOS — ветка `ci/ios-screenshots`.
