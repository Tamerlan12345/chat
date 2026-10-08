# CentyChat iOS Native Client

**Статус на 2026-10-08:** функциональная реализация завершена, разработка новых функций пока на паузе. Сборка, unit-тесты и UI-тесты на симуляторе проходили в CI; проверка привязки Release к рабочему серверу прошла на merge-коммите `6fe90ed`. Полный повторный iOS simulator CI на merge-коммите `6fe90ed`, включая iPad split view, завершился успешно. Подписанный выпуск, установка на физическом устройстве и реальные APNs push не проверены; готовность к публикации пока не подтверждена.

Нативное iOS приложение корпоративного защищенного мессенджера **CentyChat** для сотрудников АО СК «Сентрас Иншуранс».

---

## 1. Технологический стек

- **Язык**: Swift 6.0+ (строгая потокобезопасность `Sendable`, акторы для сети, `struct`/`enum` value types).
- **UI-фреймворк**: SwiftUI + Apple Human Interface Guidelines (HIG), SF Symbols, NavigationStack, тактильный отклик (UIImpactFeedbackGenerator).
- **Архитектура**: MV (Model-View). Состояние разделено на `@Observable @MainActor` сторы по фичам (`SessionStore`, `RealtimeStore`, `ConversationsStore`, `ChatStore`, `AnnouncementsStore`, `CallStore`, `ProfileStore`). Сторы работают через протоколы репозиториев (`ServerRepository`, `AuthRepository`, `ChatRepository`, `AnnouncementsRepository`, `RealtimeRepository`) поверх `APIClient`/`WebSocketClient`. `AppContainer` собирает зависимости и внедряется через `@Environment`; представления не обращаются к сетевым синглтонам.
- **Реалтайм**: единственный насос событий `RealtimeStore` (дедупликация `new_message` + `direct_message`/`channel_message` по id) работает, пока сессия аутентифицирована, и останавливается при выходе.
- **Локализация**: String Catalog `CentyChat/Resources/Localizable.xcstrings` (ru); `scripts/generate-string-catalog.py` дополняет его без Xcode. Логирование через `os.Logger` (`Log`).
- **Сеть**:
  - `APIClient` (`actor`, `URLSession`, проактивный рефреш JWT токена на 401, перехват 403 `MUST_CHANGE_PASSWORD`, multipart загрузка файлов).
  - `WebSocketClient` (`actor`, `URLSessionWebSocketTask`, сердечный ритм 30с ping/pong, экспоненциальный бэкофф с джиттером, бинарный релей аудио).
- **Безопасное хранилище**: `KeychainManager` (iOS Keychain Services, `kSecClassGenericPassword`, хранение JWT, device UUID и 256-битного секрета).
- **Аудио-релей**: `AudioRelayEngine` (16 кГц 16-бит моно PCM, фреймы ровно 1028 байт, Silence Gating `< 0.0015`), `JitterScheduler` (опережение 60 мс, потолок 250 мс).

---

## 2. Структура проекта

```
mobile/ios/
├── Package.swift                               # Манифест Swift Package Manager
├── README.md                                    # Документация архитектуры
├── CentyChatMobileApp/
│   └── CentyChatMobileApp.swift                 # Точка входа @main
├── CentyChat/
│   ├── App/
│   │   ├── AppContainer.swift                   # Composition root: репозитории, сторы, внедрение в Environment
│   │   ├── RootView.swift                       # Выбор экрана по фазе сессии, звонок и алерты
│   │   ├── MainTabView.swift                    # Вкладки: Чаты / Сотрудники / Объявления / Профиль, у каждой свой стек
│   │   ├── AppNavigation.swift                  # Выбор вкладки, стек вкладки (NavigationRouter), маршруты чата и карточки
│   │   └── Stores/                              # Session/Realtime/Conversations/Chat/Announcements/Call/Profile
│   ├── Models/
│   │   ├── User.swift                           # Модель сотрудника и прав RolePermissions
│   │   ├── Channel.swift                        # Корпоративный канал
│   │   ├── Message.swift                        # Сообщение, типы и метаданные вложений
│   │   ├── DirectConversation.swift             # Диалог в списке личных чатов
│   │   ├── Announcement.swift                   # Корпоративное распоряжение с подтверждением
│   │   ├── CallSession.swift                    # Стейт-машина голосового вызова
│   │   ├── ServerSettings.swift                 # Настройки сервера и проверка доступности
│   │   ├── Attachment.swift                     # Вложения и политика файлов
│   │   ├── AuthResponses.swift                  # DTO аутентификации (Knock, Claim, Login, Password)
│   │   └── WebSocketEvents.swift                # Все типизированные события WS протокола
│   ├── Core/
│   │   ├── Network/
│   │   │   ├── APIClient.swift                  # HTTP REST клиент с авторефрешем
│   │   │   ├── APIError.swift                   # Локализованные сетевые ошибки (с Retry-After)
│   │   │   ├── ServerEnvironment.swift          # Сервер, зафиксированный при сборке (Release — константа)
│   │   │   └── RetryAfter.swift                 # Разбор заголовка Retry-After
│   │   ├── Repositories/                        # Протоколы репозиториев и live-реализации
│   │   ├── Logging/Log.swift                    # Категории os.Logger
│   │   ├── WebSocket/
│   │   │   ├── WebSocketClient.swift            # WebSocket клиент: бэкофф 1-2-4…30 с, ping, connectionState
│   │   │   ├── WebSocketTransport.swift         # Абстракция сокета (URLSessionWebSocketTask)
│   │   │   ├── AudioRelayEngine.swift           # Упаковка/распаковка 1028-байтных аудиокадров
│   │   │   └── JitterBuffer.swift               # Планировщик джиттер-буфера (60мс..250мс)
│   │   ├── Storage/
│   │   │   └── KeychainManager.swift            # Хранилище токенов и секретов в Keychain
│   │   ├── Media/
│   │   │   └── AvatarImageLoader.swift          # Фото сотрудников ссылкой: токен только своему серверу, кэш память+диск, ETag
│   │   ├── Push/
│   │   │   └── PushTokenRegistrar.swift         # APNs-токен на сервере (push.md §2): после входа, при смене токена, снятие при выходе
│   │   ├── Audio/
│   │   │   └── AudioSessionManager.swift        # Конфигурация AVAudioSession для VoIP
│   │   └── Utils/
│   │       ├── DateParser.swift                 # Потокобезопасный парсер ISO-8601
│   │       └── ValidationRules.swift            # Правила окон правки и удаления сообщений
│   ├── Features/
│   │   ├── Auth/
│   │   │   ├── LoginView.swift                  # Фирменный вход: знак C, название компании, карточка логин/пароль
│   │   │   ├── LoginFormModel.swift             # Состояние формы, обратный отсчёт 429/503, защита от двойной отправки
│   │   │   └── ChangePasswordModalView.swift    # Обязательная/плановая смена пароля
│   │   ├── ChatList/
│   │   │   ├── ChatListView.swift               # Список бесед (Личные / Каналы)
│   │   │   ├── ConversationRowView.swift        # Ячейка личного диалога
│   │   │   └── ChannelRowView.swift             # Ячейка канала
│   │   ├── ChatDetail/
│   │   │   ├── ChatDetailView.swift             # Экран чата, тайпинг, звонки, отправка фото
│   │   │   └── MessageBubbleView.swift          # Пузыри сообщений, контекстное меню с проверкой окон
│   │   ├── People/                          # «Сотрудники»: справочник (кэш + /api/users, /api/org/tree), поиск, «Отделы», карточка сотрудника
│   │   ├── Search/                          # Общий поиск в «Чатах»: люди, каналы, сообщения (/api/messages/search), «Недавние»
│   │   ├── Announcements/
│   │   │   └── AnnouncementsView.swift          # Распоряжения руководства и подпись ознакомления
│   │   ├── Call/
│   │   │   └── CallView.swift                   # Интерфейс VoIP звонка (таймер, mute, speaker, отбой)
│   │   └── Profile/
│   │       └── ProfileView.swift                # Профиль сотрудника, статус (online/away/dnd), побудка
│   ├── UI/
│   │   └── DesignSystem/
│   │       ├── CentyColors.swift                # Фирменные цвета Light/Dark
│   │       ├── CentyHaptics.swift               # Тактильный отклик
│   │       └── Components/
│   │           ├── BrandMark.swift              # Знак CentyChat (порт BRAND_C_PATH из десктопа) и надпись
│   │           ├── AvatarView.swift             # Аватар: фото или инициалы на цвете из имени (как на десктопе), бейдж статуса
│   │           ├── StatusBadge.swift            # Индикатор онлайн-статуса
│   │           ├── DeliveryStatusView.swift     # Галочки отправлено/доставлено/прочитано
│   │           ├── TypingIndicatorView.swift    # Анимированный индикатор набора текста
│   │           ├── CentyButton.swift            # Кнопка в HIG стиле
│   │           └── CentyTextField.swift         # Поле ввода со скрытием пароля
│   └── Resources/
│       ├── Localizable.xcstrings                # String Catalog (ru)
│       ├── Info.plist                           # Разрешения микрофона, камеры, фото и VoIP
│       └── PrivacyInfo.xcprivacy                # Декларация конфиденциальности для App Store
└── CentyChatTests/                               # Папка синхронизирована с таргетом: новые файлы подключаются сами
    ├── Support/                                 # Фейковые репозитории, TestApp, in-memory Keychain, URLProtocol-заглушка
    ├── ServerEnvironmentTests.swift             # Release = ровно прод, Debug = настройка сборки
    ├── CredentialBindingTests.swift             # Миграция старого адреса сервера и чужих учётных данных
    ├── LoginFlowTests.swift                     # Ошибки входа, обратный отсчёт, двойная отправка, первый запуск
    ├── ContractFixtureTests.swift               # Декодирование всех фикстур mobile/contracts/fixtures
    ├── RealtimeChatTests.swift                  # Дедупликация, обновления открытого чата
    ├── SessionLifecycleTests.swift              # Жизненный цикл WS, смена пароля, частичная загрузка
    ├── ReconnectBackoffTests.swift              # Рост бэкоффа реконнекта
    ├── LocalizationTests.swift                  # String Catalog и русские тексты ошибок
    ├── DTOParsingTests.swift                    # Тесты сериализации/десериализации моделей
    ├── EditWindowTests.swift                    # Тесты валидации временных окон правки/удаления
    ├── CallStateMachineTests.swift              # Тесты стейт-машины вызова и форматирования
    └── AudioRelayTests.swift                    # Тесты 1028-байтных кадров, silence gating, jitter
```

---

## 3. Сервер и вход

- **Сервер зафиксирован при сборке** (`ServerEnvironment`). Экрана настройки сервера и кнопки «Сменить сервер» нет.
  - **Release**: `https://centychat-production.up.railway.app` — константа в коде; Info.plist, аргументы запуска, переменные окружения и сохранённые значения не читаются (код переопределения под `#if DEBUG` в Release не компилируется; CI проверяет бинарник Release).
  - **Debug**: настройка сборки `CENTYCHAT_SERVER_URL` (ключ Info.plist `CentyChatServerURL`, по умолчанию прод), например `xcodebuild … CENTYCHAT_SERVER_URL=https://localhost:8443` для dev-стенда. UI-тесты могут передать `-centychat-server-url <url>` вместе с `CENTYCHAT_UI_TESTING=1`. Принимается только `https`-origin без пути, логина и query.
- **Миграция**: адрес сервера, сохранённый старыми версиями (`server_url` в Keychain), больше не используется и удаляется. Токен и секрет устройства привязаны к origin выдавшего сервера (`credential_origin`); выданные другим или неизвестным сервером стираются до первого запроса, пользователь попадает на вход.
- **Вход**: ошибки входа обобщённые («Неверный логин или пароль»), текст сервера не показывается; 429/503 — обратный отсчёт по `Retry-After`; кнопка «Войти» заблокирована, пока идёт запрос. Пароль хранится только в памяти формы и стирается после входа; запоминается только последний удачный логин.
- **Dev-стенд в CI**: workflow поднимает `mobile/dev/stand.mjs`, доверяет его CA только в симуляторе и передаёт адрес тестам (`TEST_RUNNER_CENTYCHAT_DEV_STAND_URL`). Тесты никогда не обращаются к проду.

---

## 4. Соответствие контрактам и матрице паритета

1. **Модели данных**: Все поля и типы строго выровнены с `mobile/contracts/parity-matrix.md` и `mobile/contracts/openapi.yaml`.
2. **Временные окна сообщений (`ValidationRules`)**: Проверяет настройки `message_edit_window_minutes` и `message_delete_window_minutes` (-1 = отключено, 0 = без ограничений, >0 = минуты). Суперадминистратор имеет право на модераторское удаление в любое время.
3. **Обязательная смена пароля (`MUST_CHANGE_PASSWORD`)**: При флаге `must_change_password` или ошибке 403 с кодом `MUST_CHANGE_PASSWORD` сессия переходит в фазу `passwordChangeRequired`: экран смены пароля показывается один раз как корневой, после успеха сессия аутентифицирована и запускается реалтайм.
4. **Побудка (Wake Buzzer)**: Кулдаун 60 секунд с активным таймером обратного отсчета; прием сигнала вызывает виброотклик `UINotificationFeedbackGenerator.error` и баннер.
5. **Аудио-релей звонка**: Передача бинарных фреймов по 1028 байт (UInt32BE peer ID + 512 сэмплов Int16BE), детекция тишины при амплитуде `< 0.0015`, джиттер-буфер с удержанием 60 мс и потолком 250 мс.
6. **Готовность к App Store**:
   - `PrivacyInfo.xcprivacy`: Заполнены `NSPrivacyCollectedDataTypes` (Name, EmailAddress, PhoneNumber, UserID, EmailsOrTextMessages, AudioData, PhotosOrVideos для App Functionality) и `NSPrivacyAccessedAPITypes` (UserDefaults CA92.1, FileTimestamp C617.1, DiskSpace E174.1).
   - `Info.plist`: Добавлены `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`. Поле `UIBackgroundModes` содержит `audio`, `fetch`, `remote-notification` (исключен `voip` по Guideline 2.5.4 до интеграции CallKit).
