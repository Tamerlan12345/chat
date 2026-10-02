# CentyChat iOS Native Client

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
│   │   ├── MainTabView.swift                    # Основной экран с вкладками (Чаты / Распоряжения / Профиль)
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
│   │   │   └── APIError.swift                   # Локализованные сетевые ошибки
│   │   ├── Repositories/                        # Протоколы репозиториев и live-реализации
│   │   ├── Logging/Log.swift                    # Категории os.Logger
│   │   ├── WebSocket/
│   │   │   ├── WebSocketClient.swift            # WebSocket клиент: бэкофф 1-2-4…30 с, ping, connectionState
│   │   │   ├── WebSocketTransport.swift         # Абстракция сокета (URLSessionWebSocketTask)
│   │   │   ├── AudioRelayEngine.swift           # Упаковка/распаковка 1028-байтных аудиокадров
│   │   │   └── JitterBuffer.swift               # Планировщик джиттер-буфера (60мс..250мс)
│   │   ├── Storage/
│   │   │   └── KeychainManager.swift            # Хранилище токенов и секретов в Keychain
│   │   ├── Audio/
│   │   │   └── AudioSessionManager.swift        # Конфигурация AVAudioSession для VoIP
│   │   └── Utils/
│   │       ├── DateParser.swift                 # Потокобезопасный парсер ISO-8601
│   │       └── ValidationRules.swift            # Правила окон правки и удаления сообщений
│   ├── Features/
│   │   ├── ServerConnect/
│   │   │   └── ServerConnectView.swift          # Ввод и валидация адреса сервера
│   │   ├── Auth/
│   │   │   ├── LoginView.swift                  # Вход по логину и паролю + Device Claim
│   │   │   └── ChangePasswordModalView.swift    # Обязательная/плановая смена пароля
│   │   ├── ChatList/
│   │   │   ├── ChatListView.swift               # Список бесед (Личные / Каналы)
│   │   │   ├── ConversationRowView.swift        # Ячейка личного диалога
│   │   │   └── ChannelRowView.swift             # Ячейка канала
│   │   ├── ChatDetail/
│   │   │   ├── ChatDetailView.swift             # Экран чата, тайпинг, звонки, отправка фото
│   │   │   └── MessageBubbleView.swift          # Пузыри сообщений, контекстное меню с проверкой окон
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
│   │           ├── AvatarView.swift             # Аватар с инициалами и бейджем статуса
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
    ├── Support/TestDoubles.swift                # Фейковые репозитории и TestApp-контейнер
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

## 3. Соответствие контрактам и матрице паритета

1. **Модели данных**: Все поля и типы строго выровнены с `mobile/contracts/parity-matrix.md` и `mobile/contracts/openapi.yaml`.
2. **Временные окна сообщений (`ValidationRules`)**: Проверяет настройки `message_edit_window_minutes` и `message_delete_window_minutes` (-1 = отключено, 0 = без ограничений, >0 = минуты). Суперадминистратор имеет право на модераторское удаление в любое время.
3. **Обязательная смена пароля (`MUST_CHANGE_PASSWORD`)**: При флаге `must_change_password` или ошибке 403 с кодом `MUST_CHANGE_PASSWORD` сессия переходит в фазу `passwordChangeRequired`: экран смены пароля показывается один раз как корневой, после успеха сессия аутентифицирована и запускается реалтайм.
4. **Побудка (Wake Buzzer)**: Кулдаун 60 секунд с активным таймером обратного отсчета; прием сигнала вызывает виброотклик `UINotificationFeedbackGenerator.error` и баннер.
5. **Аудио-релей звонка**: Передача бинарных фреймов по 1028 байт (UInt32BE peer ID + 512 сэмплов Int16BE), детекция тишины при амплитуде `< 0.0015`, джиттер-буфер с удержанием 60 мс и потолком 250 мс.
6. **Готовность к App Store**:
   - `PrivacyInfo.xcprivacy`: Заполнены `NSPrivacyCollectedDataTypes` (Name, EmailAddress, PhoneNumber, UserID, EmailsOrTextMessages, AudioData, PhotosOrVideos для App Functionality) и `NSPrivacyAccessedAPITypes` (UserDefaults CA92.1, FileTimestamp C617.1, DiskSpace E174.1).
   - `Info.plist`: Добавлены `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`. Поле `UIBackgroundModes` содержит `audio`, `fetch`, `remote-notification` (исключен `voip` по Guideline 2.5.4 до интеграции CallKit).
