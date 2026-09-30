# Матрица паритета (Parity Matrix): iOS & Android

Матрица соответствия моделей данных, полей, типов и бизнес-логики между мобильными платформами CentyChat (**iOS** и **Android**) на основе контрактов сервера (`server/src/api/index.js`, `server/src/ws/server.js`).

---

## 1. Архитектурный стек платформ

| Компонент / Слой | iOS (Apple) | Android (Google) | Требование к паритету |
|---|---|---|---|
| **Язык разработки** | Swift 5.9+ / Swift 6 | Kotlin 1.9+ / 2.0+ | Строгая типизация, null-safety |
| **UI-фреймворк** | SwiftUI | Jetpack Compose | Декларативный UI, единый дизайн-код CentyChat |
| **Архитектурный паттерн** | MVVM / MVI (Clean Architecture) | MVI / MVVM (Clean Architecture) | Единые стейты экранов (`ViewState`), однонаправленный поток данных |
| **Асинхронность** | Swift Concurrency (`async/await`, `Task`, `AsyncStream`) | Kotlin Coroutines & `Flow` (`StateFlow`, `SharedFlow`) | Идентичная реактивная модель |
| **Локальная БД / Кэш** | GRDB.swift или SwiftData / SQLite | Room Database / SQLite | Идентичная схема SQLite таблиц, WAL-режим |
| **Сетевой HTTP-клиент** | `URLSession` (нативный) | `OkHttp` + `Retrofit` / `Ktor Client` | HTTP/1.1 и HTTP/2, единые interceptors |
| **WebSocket-клиент** | `URLSessionWebSocketTask` | `OkHttp WebSocket` | Автореконнект, бинарные кадры, Heartbeat |
| **Безопасное хранилище** | iOS Keychain Services (`kSecClassGenericPassword`) | Android Keystore + `EncryptedSharedPreferences` | Шифрование AES-GCM токена и `device_secret` |
| **Биометрия** | `LocalAuthentication` (Face ID / Touch ID) | `BiometricPrompt` API | Защита входа в приложение по PIN / биометрии |
| **Системные звонки (VoIP)** | `CallKit` + `PushKit` (VoIP Push) | `TelecomManager` / `ConnectionService` + High-Priority Push | Нативный экран входящего системного вызова |
| **Аудио-движок** | `AVAudioEngine` / `AudioUnit` | `AudioRecord` + `AudioTrack` / `Oboe` (C++) | PCM 16 кГц 16-бит моно, буфер 512 сэмплов |
| **Фоновые задачи** | `BGAppRefreshTask` / Silent Push | `WorkManager` / Foreground Service | Синхронизация непрочитанных сообщений |

---

## 2. Матрица функционального паритета (Feature Parity)

| Модуль / Фича | Описание бизнес-логики | iOS | Android | Статус |
|---|---|:---:|:---:|:---:|
| **Device Knock** | Генерация стабильного UUID v4 устройства, отправка в `/api/auth/knock` при старте. | ✅ | ✅ | Обязательно |
| **Device Claim** | Сохранение 256-битного секрета после входа по паролю для беспарольного входа. | ✅ | ✅ | Обязательно |
| **Auth & Refresh** | Авторизация JWT, проактивное обновление токена до истечения `exp`. | ✅ | ✅ | Обязательно |
| **Must Change Password** | Перехват 403 `MUST_CHANGE_PASSWORD` и принудительный экран смены пароля. | ✅ | ✅ | Обязательно |
| **Direct Messaging** | Личная переписка 1-на-1, статусы доставки (`delivered`), статусы прочтения (`read`). | ✅ | ✅ | Обязательно |
| **Channel Messaging** | Корпоративные каналы (`#Общий` и др.), счетчики непрочитанных, роли. | ✅ | ✅ | Обязательно |
| **Message Editing** | Правка текста с валидацией окна `message_edit_window_minutes`. | ✅ | ✅ | Обязательно |
| **Message Deleting** | Удаление с валидацией окна `message_delete_window_minutes`. | ✅ | ✅ | Обязательно |
| **Typing Indicator** | Индикатор «печатает…» с автосбросом через 3 секунды. | ✅ | ✅ | Обязательно |
| **Presence & DND** | Переключение `online` / `away` и режим «Не беспокоить» (`dnd`). | ✅ | ✅ | Обязательно |
| **Wake (Побудка)** | Прием сигнала с вибрацией и звуком. Отправка с кулдауном 60с. | ✅ | ✅ | Обязательно |
| **Voice Calls (Signalling)** | Сигналинг вызова (`call_offer`, `call_answer`, `call_rejected`, `call_end`). | ✅ | ✅ | Обязательно |
| **Audio Relay (WebSocket)** | Захват микрофона и воспроизведение через WS binary stream (16 кГц PCM). | ✅ | ✅ | Обязательно |
| **Silence Suppression** | Отсечение тишины при передаче звука (`SILENCE_THRESHOLD = 0.0015`). | ✅ | ✅ | Обязательно |
| **Jitter Buffer** | Планировщик звука с задержкой 60 мс и потолком 250 мс. | ✅ | ✅ | Обязательно |
| **Announcements** | Список распоряжений, бейджи срочности, кнопка «Ознакомлен». | ✅ | ✅ | Обязательно |
| **Org Structure** | Иерархическое дерево отделов, поиск сотрудников, карточка коллеги. | ✅ | ✅ | Обязательно |
| **File Policy Filter** | Локальная предпроверка расширений файлов перед загрузкой (`/api/files/policy`). | ✅ | ✅ | Обязательно |
| **File Upload/Download** | Фоновая загрузка с прогресс-баром, просмотр изображений и PDF. | ✅ | ✅ | Обязательно |
| **Offline Cache** | Локальная очередь неотправленных сообщений и кэш диалогов в SQLite. | ✅ | ✅ | Обязательно |

---

## 3. Таблица сопоставления моделей и полей (Model Parity)

### 3.1. User / Пользователь

| Поле в JSON / БД | Тип Server | Тип iOS (Swift) | Тип Android (Kotlin) | Nullable | Описание |
|---|---|---|---|:---:|---|
| `id` | `INTEGER` | `Int64` | `Long` | Нет | Уникальный ID пользователя |
| `username` | `TEXT` | `String` | `String` | Нет | Корпоративный логин |
| `full_name` | `TEXT` | `String` | `String` | Нет | ФИО сотрудника |
| `email` | `TEXT` | `String?` | `String?` | Да | Корпоративная почта |
| `phone` | `TEXT` | `String?` | `String?` | Да | Телефон сотрудника |
| `job_title` | `TEXT` | `String?` | `String?` | Да | Должность |
| `department_id` | `INTEGER` | `Int64?` | `Long?` | Да | ID подразделения |
| `department_name` | `TEXT` (JOIN) | `String?` | `String?` | Да | Название подразделения |
| `role_id` | `INTEGER` | `Int64?` | `Long?` | Да | ID системной роли |
| `role_name` | `TEXT` (JOIN) | `String?` | `String?` | Да | Название роли |
| `permissions` | `object` | `RolePermissions?` | `RolePermissions?` | Да | Объект прав учетной записи |
| `uin` | `INTEGER` | `Int?` | `Int?` | Да | Внутренний номер UIN |
| `extension` | `TEXT` | `String?` | `String?` | Да | Внутренний телефонный номер |
| `company` | `TEXT` | `String?` | `String?` | Да | Компания (АО СК «Сентрас Иншуранс») |
| `avatar_url` | `TEXT` | `String?` | `String?` | Да | Data URL или URL аватарки |
| `status` | `TEXT` | `UserStatus` | `UserStatus` | Нет | `online`, `away`, `dnd`, `offline` |
| `custom_status` | `TEXT` | `String?` | `String?` | Да | Пользовательский статус (до 200 симв.) |
| `last_seen` | `TEXT` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Время последней активности |
| `is_active` | `INTEGER` | `Bool` (0/1 -> Bool) | `Boolean` | Нет | 1 = активен, 0 = отключен |
| `must_change_password` | `INTEGER` | `Bool` (0/1 -> Bool) | `Boolean` | Нет | 1 = обязательна смена пароля |
| `approval_status` | `TEXT` | `String` | `String` | Нет | `pending`, `approved`, `rejected` |
| `created_at` | `TEXT` | `Date` (ISO-8601) | `Instant` (ISO-8601) | Нет | Дата создания записи |

### 3.2. Channel / Корпоративный канал

| Поле в JSON / БД | Тип Server | Тип iOS (Swift) | Тип Android (Kotlin) | Nullable | Описание |
|---|---|---|---|:---:|---|
| `id` | `INTEGER` | `Int64` | `Long` | Нет | Уникальный ID канала |
| `name` | `TEXT` | `String` | `String` | Нет | Название канала (`#Общий`) |
| `topic` | `TEXT` | `String?` | `String?` | Да | Описание темы канала |
| `type` | `TEXT` | `ChannelType` | `ChannelType` | Нет | `public`, `private`, `system` |
| `owner_id` | `INTEGER` | `Int64?` | `Long?` | Да | Создатель канала |
| `created_at` | `TEXT` | `Date` (ISO-8601) | `Instant` (ISO-8601) | Нет | Дата создания канала |
| `member_role` | `TEXT` (JOIN) | `String?` | `String?` | Да | Роль текущего юзера: `admin`, `member` |
| `members_count` | `INTEGER` (COUNT) | `Int` | `Int` | Нет | Число участников |
| `unread_count` | `INTEGER` (COUNT) | `Int` | `Int` | Нет | Количество непрочитанных сообщений |
| `last_message_text` | `TEXT` | `String?` | `String?` | Да | Текст последнего сообщения |
| `last_message_time` | `TEXT` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Время последнего сообщения |

### 3.3. Message / Сообщение переписки

| Поле в JSON / БД | Тип Server | Тип iOS (Swift) | Тип Android (Kotlin) | Nullable | Описание |
|---|---|---|---|:---:|---|
| `id` | `INTEGER` | `Int64` | `Long` | Нет | ID сообщения |
| `conversation_type` | `TEXT` | `ConversationType` | `ConversationType` | Нет | `direct` или `channel` |
| `target_id` | `INTEGER` | `Int64` | `Long` | Нет | ID канала или ID получателя |
| `sender_id` | `INTEGER` | `Int64` | `Long` | Нет | ID автора сообщения |
| `text` | `TEXT` | `String` | `String` | Нет | Текст (до 16000 символов) |
| `type` | `TEXT` | `MessageType` | `MessageType` | Нет | `text`, `file`, `image` |
| `reply_to_id` | `INTEGER` | `Int64?` | `Long?` | Да | ID сообщения, на которое отвечают |
| `metadata_json` | `TEXT` | `String?` | `String?` | Да | Сырая JSON-строка метаданных |
| `metadata` | `object` (parsed) | `MessageMetadata?` | `MessageMetadata?` | Да | Разобранный объект (`file_id` и др.) |
| `created_at` | `TEXT` | `Date` (ISO-8601) | `Instant` (ISO-8601) | Нет | Дата и время отправки |
| `updated_at` | `TEXT` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Дата и время правки |
| `is_deleted` | `INTEGER` | `Bool` (0/1 -> Bool) | `Boolean` | Нет | Флаг удаления |
| `sender_username` | `TEXT` | `String?` | `String?` | Да | Логин автора |
| `sender_name` | `TEXT` | `String` | `String` | Нет | Отображаемое имя автора |
| `sender_avatar` | `TEXT` | `String?` | `String?` | Да | Аватар автора |
| `sender_department` | `TEXT` | `String?` | `String?` | Да | Подразделение автора |
| `file_original_name` | `TEXT` | `String?` | `String?` | Да | Неизменное имя вложенного файла |
| `delivery_status` | `TEXT` | `DeliveryStatus?` | `DeliveryStatus?` | Да | `delivered` или `read` |

### 3.4. DirectConversation / Диалог в списке чатов

| Поле в JSON | Тип Server | Тип iOS (Swift) | Тип Android (Kotlin) | Nullable | Описание |
|---|---|---|---|:---:|---|
| `user_id` | `number` | `Int64` | `Long` | Нет | ID собеседника |
| `username` | `string` | `String?` | `String?` | Да | Логин собеседника |
| `full_name` | `string` | `String` | `String` | Нет | ФИО собеседника |
| `avatar_url` | `string` | `String?` | `String?` | Да | Аватар собеседника |
| `status` | `string` | `UserStatus` | `UserStatus` | Нет | Онлайн-статус (`online`, `away`...) |
| `custom_status` | `string` | `String?` | `String?` | Да | Пользовательский статус |
| `job_title` | `string` | `String?` | `String?` | Да | Должность |
| `department_name` | `string` | `String?` | `String?` | Да | Отдел |
| `last_message_id` | `number` | `Int64?` | `Long?` | Да | ID последнего сообщения |
| `last_message_text` | `string` | `String?` | `String?` | Да | Текст последнего сообщения |
| `last_message_time` | `string` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Время последнего сообщения |
| `last_message_sender_id` | `number` | `Int64?` | `Long?` | Да | Автор последнего сообщения |
| `last_message_type` | `string` | `MessageType?` | `MessageType?` | Да | Тип последнего сообщения |
| `unread_count` | `number` | `Int` | `Int` | Нет | Количество непрочитанных |

### 3.5. Announcement / Корпоративное оповещение

| Поле в JSON | Тип Server | Тип iOS (Swift) | Тип Android (Kotlin) | Nullable | Описание |
|---|---|---|---|:---:|---|
| `id` | `number` | `Int64` | `Long` | Нет | ID оповещения |
| `author_id` | `number` | `Int64` | `Long` | Нет | Автор распоряжения |
| `title` | `string` | `String` | `String` | Нет | Заголовок оповещения |
| `content` | `string` | `String` | `String` | Нет | Текст распоряжения |
| `target_type` | `string` | `AnnouncementTarget` | `AnnouncementTarget` | Нет | `all`, `departments`, `users` |
| `priority` | `string` | `AnnouncementPriority`| `AnnouncementPriority` | Нет | `normal`, `urgent`, `critical` |
| `expires_at` | `string` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Срок действия |
| `created_at` | `string` | `Date` (ISO-8601) | `Instant` (ISO-8601) | Нет | Время публикации |
| `author_name` | `string` | `String` | `String` | Нет | ФИО автора |
| `author_job_title` | `string` | `String?` | `String?` | Да | Должность автора |
| `confirmed_at` | `string` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Дата ознакомления текущим юзером |
| `is_confirmed` | `number` | `Bool` (0/1 -> Bool) | `Boolean` | Нет | Подтверждено текущим пользователем |

---

## 4. Паритет бизнес-логики и правил валидации

### 4.1. Временные окна правки и удаления сообщений

Оба мобильных клиента получают настройки сервера через `GET /api/settings/info`:
- `message_edit_window_minutes`: строка с целым числом минут (`"-1"`, `"0"`, `">0"`).
- `message_delete_window_minutes`: строка с целым числом минут.

**Алгоритм валидации на клиенте**:
```
function canEditOrDelete(createdAt, windowMinutesStr, isSuperAdmin = false) {
    if (isSuperAdmin && action === 'delete') return true; // суперадмин модератор
    val windowMinutes = windowMinutesStr.toIntOrNull() ?: 60;
    if (windowMinutes == -1) return false; // действие выключено на сервере
    if (windowMinutes == 0) return true;  // без ограничений по времени
    
    val ageMs = currentTimeMs - parseIso8601(createdAt).timeMs;
    return ageMs <= windowMinutes * 60 * 1000;
}
```
*Если функция возвращает `false`, пункты «Изменить» и «Удалить» скрываются из контекстного меню сообщения.*

---

### 4.2. Обработка обязательной смены пароля (`MUST_CHANGE_PASSWORD`)

Если при выполнении любого HTTP-запроса получен статус `403` с телом:
```json
{
  "error": "Требуется смена пароля перед продолжением работы",
  "code": "MUST_CHANGE_PASSWORD"
}
```
или в профиле пользователя установлено `must_change_password === true` (1):
1. Текущий экран блокируется.
2. Приложение отображает модальный экран «Обязательная смена пароля».
3. Разрешены только запросы:
   - `GET /api/auth/me`
   - `POST /api/users/password`
   - `POST /api/auth/logout`
   - `POST /api/auth/refresh`
   - `POST /api/auth/device/unbind`
4. После успешного ответа `POST /api/users/password` сохраняется новый токен из ответа, и пользователь возвращается к главному экрану чата.

---

### 4.3. Побудка (Wake Buzzer)

1. **Отправка**:
   - Клиент отправляет `{ "type": "wake_send", "targetUserId": id }`.
   - Запускается локальный таймер обратного отсчета на **60 секунд** (кнопка побудки блокируется с показом секунд).
2. **Получение (`wake_ring`)**:
   - Клиент воспроизводит системный виброотклик (Haptic Feedback `UINotificationFeedbackGenerator.error` на iOS, `Vibrator.vibrate(VibrationEffect.createWaveform(...))` на Android).
   - Воспроизводится звуковой сигнал привлечения внимания.
   - Показывается всплывающее уведомление (Toast / In-App Banner): «Вас вызывает: [Имя сотрудника]».

---

### 4.4. Обработка аудиокадров звонка (Audio Relay)

Формат двоичных WebSocket фреймов строго согласован:
- **Отправка (Микрофон -> WS)**:
  - Буфер: `[UInt32BE peerId] + [512 сэмплов Int16BE]`.
  - Длина ровно `1028` байт.
  - Если средняя амплитуда сэмплов `< 0.0015`, кадр отбрасывается (Silence Gating).
- **Прием (WS -> Динамик)**:
  - Чтение первых 4 байт как `senderId` (UInt32BE). Проверка, что `senderId == currentPeerId`.
  - Оставшиеся 1024 байта преобразуются в массив из 512 сэмплов Float32 `[-1.0..1.0]`.
  - Кадр передается в `JitterScheduler`:
    - Начальный буфер опережения: **60 мс**.
    - Максимальный джиттер-буфер: **250 мс**.
    - При превышении 250 мс буфер сбрасывается к 60 мс во избежание растущего лага.

---

### 4.5. Проактивное продление сессии (Token Refresh)

1. JWT токен содержит `iat` (время выпуска) и `exp` (время истечения, обычно 12 часов).
2. Мобильное приложение за **30 минут до истечения `exp`** автоматически вызывает `POST /api/auth/refresh`.
3. Полученный новый токен сохраняется в защищенное хранилище (Keychain / EncryptedSharedPreferences).
4. Активный WebSocket не переподключается — сервер автоматически переводит открытый сокет на новый токен (`wsServer.replaceSocketToken`).

---

## 5. Контрольный чек-лист готовности контрактов

- [x] Полная OpenAPI 3.1 спецификация всех HTTP эндпоинтов создана в `mobile/contracts/openapi.yaml`.
- [x] Детальный протокол WebSocket сообщений с таймингами и бинарным форматом звука создан в `mobile/contracts/ws-protocol.md`.
- [x] Таблица архитектурного паритета, моделей и бизнес-правил создана в `mobile/contracts/parity-matrix.md`.
- [x] Все поля и типы строго соответствуют серверным модулям `server/src/api/index.js`, `server/src/ws/server.js`, `server/src/services/`.
- [x] Файлы вне директорий `mobile/contracts/` и `mobile/docs/` не модифицировались.
