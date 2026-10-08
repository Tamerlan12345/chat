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

Статусы — по **слитому состоянию** ветки `mobile-release-parity-impl` после волн исправлений S, D, A и I и финальной полировки (`fix/final-polish`, 2026-10-07): `final-rereview.md`, `fixwave-A-report.md`, `fixwave-I-report.md`, `fixwave-S-report.md` (папка SDD `2026-10-05-continuation`). Номера `A-I…`/`A-M…`, `I-I…`/`I-M…` — пункты финального ревью Android/iOS, `P…` — пункты ревью паритета. Все пункты волны исправлений Android и iOS **закрыты** (исправлены или осознанно приняты по решению ревью).

Обозначения: **✓** — реализовано, тесты зелёные в CI и сверено с контрактом; **◐** — реализовано частично или ждёт ключей / проверки на устройстве (указано); **✗** — нет; **—** — к платформе не относится. «Сервер» — состояние сервера и контрактов.

| Модуль / Фича | Контракт | Сервер | iOS | Android | Комментарий |
|---|---|:---:|:---:|:---:|---|
| **Вход по паролю, knock, claim** | `openapi.yaml`, фикстуры `http/auth.*` | ✓ | ✓ | ✓ | Исправлено: iOS P9 (логин только обрезается, регистр не меняется), Android P8 (устройство «заявляется» и после входа по регистрации). |
| **Продление токена, 401** | `ws-protocol.md` §6.3, `delivery-state.md` | ✓ | ✓ | ✓ | Исправлено: Android A-I4 (каждый запрос привязан к своей учётной записи, продлённый токен сохраняется только для текущего сеанса); iOS I-I1 (Keychain `AfterFirstUnlockThisDeviceOnly`, «заблокировано» ≠ «нет токена»), I-I2 (холодный запуск без сети сохраняет сеанс). На устройстве ещё проверить: принудительный 401 на Android, заблокированный iPhone. |
| **Выход** | `push.md` §2, `copy-ru.md` §1 | ✓ | ✓ | ✓ | Исправлено: Android A-I1/P10 (`logout` с `device_id`, секрет устройства стирается), уведомления снимаются на обеих платформах (A-M3, iOS P10). Тексты подтверждения — `copy/ru.json`. |
| **Доставка: очередь, редьюсер, синхронизация** | `delivery-state.md`, векторы `fixtures/reducers/` | ✓ | ✓ | ✓ | 71 вектор (включая `CANCELLED_MAX`) зелёные на обеих платформах. Исправлено: Android P4 (текст уходит как набран), P11 (пауза при сбоях записи на диск); iOS — `message_deleted` без целого id не снимает отложенные `cancel`, фоновая досылка `BGAppRefreshTask` (P12; обработчик проверяется только на устройстве). |
| **Правка и удаление сообщений** | `ws-protocol.md` §3.3–3.4 | ✓ | ✓ | ✓ | Сервер (волна S): правка, обогнанная удалением, больше не рассылает `message_updated` после надгробия — автору `MESSAGE_DELETED`. |
| **Несколько устройств: присутствие, `viewing`, `notify`, `conversation_read`** | `multi-device.md`, векторы `fixtures/notify/` | ✓ | ✓ | ✓ | Настольный клиент (P16): простаивающее окно с открытым чатом глушит уведомление (вектор 05), `mark_read` только у низа чата, свёрнутое окно не `away` (нужна новая оболочка). Android не прогоняет векторы `notify` (`multi-device.md` §10 это допускает). |
| **Вложения: загрузка, скачивание, политика** | `openapi.yaml` `/files/*`, `copy-ru.md` §8 | ✓ | ✓ | ✓ | Списки безопасных типов совпадают (21 тип). Исправлено: Android P1–P3 (не больше 2 загрузок, временные статусы 0/401/408/429/5xx/507 ждут с учётом `Retry-After`, порядок выбора сохраняется); iOS M1/M2. |
| **Регистрация по коду из письма** | `registration.md` §1 | ✓ | ✓ | ✓ | Обе платформы скрывают вход при `allow_registration=false`, на 403 `REGISTRATION_DISABLED` (request и verify) показывают `reg.disabled`, ждут 429. Настольный клиент — прежний `/auth/register`; его 403 теперь тоже несёт `code: REGISTRATION_DISABLED` и канонический текст (финальная полировка, D5). |
| **Удаление учётной записи** | `registration.md` §3 | ✓ | ✓ | ✓ | Исправлено: iOS P7 (текст предупреждения), M4 (сбой локальной очистки после успеха на сервере). Сервер (волна S): рассылка без стёртых данных, копии аватара удаляются. |
| **Жалобы и блокировки** | `registration.md` §4 | ✓ | ✓ | ✓ | Исправлено: iOS P5–P7 (поле ввода блокируется при `DM_NOT_ALLOWED`, скрытие только в личных, тексты). Сервер: блокировка закрывает и звонки, «Побудку», правку. Настольный клиент: причины жалоб по-русски (desktop I1); своего интерфейса блокировок нет (M4 desktop, принято, после выпуска). |
| **Push: сообщения, звонки, `read`** | `push.md`, `docs/PUSH-SETUP.md` | ✓ | ◐ | ◐ | **Код готов, нужны ключи** (решение P). Android: FCM, плагин Google Services применяется только при `google-services.json`. iOS: APNs, шаблон entitlements, разрешение на уведомления, нажатие, тихий `read`. Без ключей push выключен; реальная доставка ещё не проверялась — шаги владельца в `docs/PUSH-SETUP.md`, проверка на устройстве. |
| **Звонки (сигналинг, CallKit / полноэкранное)** | `ws-protocol.md` §3.9, `push.md` §3 | ✓ | ◐ | ◐ | Сигналинг одинаков (векторы `c01`–`c10`). Android: push о звонке — обычное уведомление «Входящий звонок» на 30 с, без полноэкранного `CallStyle` и без службы микрофона переднего плана. iOS: нет PushKit/CallKit — VoIP-токен не регистрируется, push о звонке не приходит, звонок доходит только до работающего приложения. Осознанно вне v1. |
| **«Побудка»** | `ws-protocol.md` §3.8 | ✓ | ◐ | ◐ | Только на переднем плане. Звук и сигнал — проверка на устройстве. |
| **Тексты** | `copy-ru.md`, `copy/ru.json` | — | ✓ | ✓ | `copy/ru.json` — единственный источник: Android `CopyRuTest` и iOS `CopyRuTests` читают его в CI; настольный клиент сверен (22/22). |
| **Хранилище секретов** | `ws-protocol.md` §6 | — | ✓ | ✓ | Android: fail-closed, сбой записи виден. iOS I-I1 исправлен. |
| **Магазин / соответствие требованиям** | — | — | ◐ | ◐ | В коде исправлено: iOS I-I3 (PrivacyInfo), M7/M8 (Info.plist, иконка RGB); Android A-M5 (`usesCleartextTraffic=false`, `ManifestHardeningTest`). Остаются шаги владельца: подпись, версии, политика конфиденциальности и поддержка, демо-аккаунт — `docs/RELEASE-CHECKLIST.md`. |

Настольный клиент в этой матрице не сравнивается построчно: он использует те же контракты сервера, его расхождения перечислены в `final-review-desktop.md` и в колонке комментариев.

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
- [x] Обе платформы декодируют **каждую** фикстуру из `manifest.json` в unit-тестах (Android `ContractFixturesTest`, iOS `ContractFixtureTests`). Новые фикстуры волны S (регистрация, блокировки, жалобы, удаление аккаунта, `ws/error.dm_not_allowed`) декодируются на обеих платформах.
- [x] Серверные пробелы: идемпотентность `client_msg_id`, дельта-синхронизация `/api/sync` + `afterId`, «доставлено» после реконнекта — задача 5.
- [x] Push-уведомления: сервер, контракт и код клиентов (`push.md`, `docs/PUSH-SETUP.md`; Android FCM, iOS APNs). Ключи FCM/APNs — шаг владельца; без них push выключен.
- [x] Регистрация, удаление аккаунта, жалобы, блокировки — `registration.md`, все ответы сервера, пути в `openapi.yaml`, фикстуры; `openapi.yaml` проверяется тестом дрейфа на каждый снятый маршрут и статус.
- [x] Канонические русские тексты — `copy-ru.md` / `copy/ru.json`.
- [ ] Паритет функций подтверждён сквозной проверкой на стенде `mobile/dev` после волны исправлений (в §2 ✓ — CI и сверка с контрактом, не живой прогон).
