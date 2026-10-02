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

Статусы отражают **реальное состояние на аудите 2026-10-02** (раздел 0 плана `docs/superpowers/plans/2026-10-02-mobile-completion.md`), а не намерения. Прежние ✅ были заявлены без подтверждающего кода или проверки и сняты.

Обозначения: **✓** — реализовано и подтверждено (тесты зелёные в CI/локально и/или проверено на живом стенде); **◐** — код есть, но не проверен вживую либо работает частично (дефект указан); **✗** — отсутствует или сломано; **?** — не проверялось аудитом; **—** — к платформе не относится. Номера `D1…D15` — дефекты из раздела 0 плана. Пока авторизованные экраны ни разу не видел человек (в debug Bearer не уходит по HTTP, локального HTTPS не было), **ни одна авторизованная функция не получает ✓**; ✓ появится после Задач 3/6/8 и сквозной проверки на стенде `mobile/dev`. Платформенные оговорки: 21 коммит iOS (Keychain fail-closed, аудиореле ~900 строк, редизайн инбокса, иконка) локально не компилировался под iOS; на Android один тест `ServerEndpointPolicyTest` (кириллица) красный и не закоммичен.

| Модуль / Фича | Описание бизнес-логики | iOS | Android | Дефект / комментарий |
|---|---|:---:|:---:|---|
| **Device Knock** | Стабильный UUID устройства, отправка в `/api/auth/knock` при старте. | ◐ | ◐ | Код есть, живого прогона нет. Сервер: `paired` / `login_required` / `pending` — см. фикстуры `http/auth.knock-*.json`. |
| **Device Claim** | Сохранение секрета (≥43 символов `[A-Za-z0-9_-]`) сразу после входа по паролю (не позднее 5 мин). | ◐ | ◐ | Живого прогона нет. |
| **Auth & Refresh** | JWT, проактивное продление **ещё действующего** токена. | ◐ | ◐ | Истёкший токен продлить нельзя (только пароль или `/auth/knock`): `ws-protocol.md` §6.3. Долгоживущего refresh на сервере нет. |
| **Must Change Password** | Перехват 403 `MUST_CHANGE_PASSWORD`, экран смены пароля. | ✗ | ◐ | D9: iOS застревает, двойной sheet. |
| **Direct Messaging** | Личная переписка, статусы `delivered`/`read`. | ◐ | ◐ | D1 (потеря при разрыве, нет outbox), D2 (iOS: открытый чат без realtime), D3 (двойной `new_message`+`direct_message` → двойной unread), D4. |
| **Channel Messaging** | Каналы, счётчики непрочитанного. | ◐ | ◐ | Те же D1–D4. |
| **Create chat / channel** | Новый личный чат, создание канала. | ✗ | ✗ | D6: iOS — сломан sheet; Android — отсутствует. |
| **Reconnect resync + индикатор** | Пересинхронизация после реконнекта, индикатор соединения. | ✗ | ✗ | D4. Сервер готов (задача 5): `GET /api/sync` по курсору и `afterId`; алгоритм — ws-protocol §6.3 «Алгоритм переподключения клиента». Клиентская модель — `delivery-state.md` (задача 13), реализация клиентами — волна 2. |
| **Message Editing** | Правка в окне `message_edit_window_minutes`. | ✗ | ? | D2: на iOS обработчики `updateMessage*` — заглушки. |
| **Message Deleting** | Удаление в окне `message_delete_window_minutes`. | ✗ | ? | D2 (iOS); Android не проверялся. |
| **Typing Indicator** | «печатает…», автосброс. | ✗ | ? | D2 (iOS: realtime открытого чата). |
| **Presence & DND** | `online`/`away`/`dnd`. | ◐ | ◐ | Живого прогона нет. |
| **Wake (Побудка)** | Приём с вибрацией/звуком, кулдаун 60 с. | ◐ | ◐ | Только foreground (D10). |
| **Voice Calls (Signalling)** | `call_offer/answer/rejected/end`. | ◐ | ✗ | D7 (Android: повторный звонок сразу закрывается, «назад» не завершает звонок — ViewModel привязаны к Activity). D10: только foreground. |
| **Background / incoming call** | CallKit / foreground service / push. | ✗ | ✗ | D10. Сервер: push готов (задача 18, `push.md`: FCM/APNs, PushKit VoIP, только id, вызов ждёт и доставляется при подключении); клиенты — не реализовано. |
| **Audio Relay (WebSocket)** | PCM 16 кГц через WS binary. | ◐ | ◐ | iOS: код ~900 строк ни разу не компилировался; D15 — возможный краш Swift 6 в аудиоколбэках (`installTap`/`scheduleBuffer` из @MainActor). |
| **Silence Suppression / Jitter Buffer** | `SILENCE_THRESHOLD`, 60/250 мс. | ◐ | ◐ | Юнит-логика есть; в связке с живым звонком не проверена. |
| **Announcements** | Список, бейджи, «Ознакомлен». | ◐ | ◐ | Живого прогона нет. |
| **Org Structure** | Дерево отделов, поиск, карточка коллеги. | ? | ? | Аудитом не проверялось. |
| **File Policy Filter** | Предпроверка расширений (`/api/files/policy`). | ✗ | ✗ | D5: политика не применяется. Список расширений — **без точки**. |
| **File Upload/Download** | Загрузка с прогрессом, просмотр картинок/PDF. | ✗ | ✗ | D5: iOS — картинки без Bearer не грузятся; Android — upload отсутствует. |
| **Offline Cache / Outbox** | Очередь неотправленных, кэш диалогов. | ✗ | ✗ | D1. Сервер готов (задача 5): идемпотентная отправка по `client_msg_id` (WS и REST), повтор возвращает сохранённую запись. Клиенты — волна 2. |
| **Error / loading / retry states** | Понятные ошибки вместо `catch {}`. | ✗ | ✗ | D11. |
| **Навигация** | Корректный back stack, очистка при выходе. | ? | ✗ | D8 (Android: вкладки копятся, `onLoggedOut` не чистит стек). |
| **Accessibility** | Dynamic Type/fontScale, VoiceOver/TalkBack, 44pt/48dp, локализация RU. | ✗ | ✗ | D12. |
| **Дизайн как у десктопа** | Токены `theme.css`, DayNight, единая навигация. | ◐ | ✗ | D13: iOS — только инбокс; Android — 3 копии NavigationBar, XML-тема не DayNight. |
| **Store / Compliance** | iPad `UIRequiresFullScreen`, PrivacyInfo (SystemBootTime). | ✗ | — | D14. |
| **Фиксированный сервер + брендированный вход** | Адрес зашит в сборку, без экрана «подключиться». | ✗ | ✗ | Задачи 11–12; контракт: `ws-protocol.md` §1.1. |

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
| `metadata_json` | `TEXT` | `String?` | `String?` | Да | JSON-**строка** (`{"file_id":1}`); отдельного поля `metadata` сервер не отдаёт — клиент разбирает строку сам |
| `created_at` | `TEXT` | `Date` (ISO-8601) | `Instant` (ISO-8601) | Нет | Дата и время отправки |
| `updated_at` | `TEXT` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Дата и время правки |
| `is_deleted` | `INTEGER` | `Bool` (0/1 -> Bool) | `Boolean` | Нет | Флаг удаления |
| `sender_username` | `TEXT` | `String?` | `String?` | Да | Логин автора |
| `sender_name` | `TEXT` | `String` | `String` | Нет | Отображаемое имя автора |
| `sender_avatar` | `TEXT` | `String?` | `String?` | Да | Аватар автора |
| `sender_department` | `TEXT` | `String?` | `String?` | Да | Подразделение автора |
| `file_original_name` | `TEXT` | `String?` | `String?` | Да | Неизменное имя вложенного файла |
| `delivery_status` | `TEXT` | `DeliveryStatus?` | `DeliveryStatus?` | Да | `null` / `delivered` / `read`. Есть **только** в `GET /api/messages/direct/{id}`; в каналах, REST-ответе `POST` и живых кадрах `new_message`/`direct_message`/`message_updated` поля нет (ключ отсутствует) |

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
| `target_ids_json` | `string` | `String` | `String` | Нет | JSON-строка с массивом id (`"[]"` при `all`) |
| `read_at` | `string` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Только в `GET /api/announcements`; в WS `new_announcement` ключа нет |
| `confirmed_at` | `string` | `Date?` (ISO-8601) | `Instant?` (ISO-8601) | Да | Дата ознакомления текущим юзером; только в REST-списке |
| `is_confirmed` | `number` | `Bool` (0/1 -> Bool) | `Boolean` | Да (ключа может не быть) | Подтверждено текущим пользователем; в WS-кадре отсутствует — считать `false` |

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

- [x] OpenAPI 3.1 спецификация HTTP эндпоинтов — `mobile/contracts/openapi.yaml` (описание `/auth/refresh` исправлено: истёкший токен не продлевается, старый отзывается сразу).
- [x] Протокол WebSocket — `mobile/contracts/ws-protocol.md`; все серверные события из §4 приведены дословными кадрами реального сервера; исправлены §6.2 и §6.3 (нет продления истёкшего токена, нет `afterId`, дубль `new_message`).
- [x] Общие JSON-фикстуры — `mobile/contracts/fixtures/` (снимаются `mobile/dev/capture-fixtures.mjs`, дрейф ловит `server/test/mobile-contract-fixtures.test.js`).
- [ ] Обе платформы декодируют **каждую** фикстуру в unit-тестах (iOS — Задача 6, Android — Задача 8).
- [x] Серверные пробелы: идемпотентность `client_msg_id`, дельта-синхронизация `/api/sync` + `afterId`, «доставлено» после реконнекта — задача 5.
- [ ] Push-уведомления — после задачи 5.
- [ ] Паритет функций подтверждён на живом стенде (матрица §2 содержит ✓ только после этого).
