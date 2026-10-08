# Состояние доставки сообщений на клиенте (delivery-state)

Единая модель жизни сообщения на клиенте: очередь отправки (outbox), статусы доставки, слияние с `/api/sync`, правила непрочитанного. **Обязательна для iOS и Android**: обе платформы реализуют свой редьюсер по этому документу и обязаны проходить **все** векторы из `fixtures/reducers/` (см. §11).

- Эталон: `reference/delivery-reducer.mjs` — чистая функция без ввода-вывода, исполняемая версия этого документа. При расхождении текста и эталона ошибка ищется в обоих и исправляется вместе с векторами; платформы сверяются с векторами.
- Векторы: `fixtures/reducers/*.json` (формат — `fixtures/reducers/README.md`). Серверный тест `server/test/mobile-delivery-reducer.test.js` прогоняет их через эталон в `cd server && npm test`.
- Опирается на `ws-protocol.md` (§3.2 `client_msg_id`, §3.4.1 `cancel_message`, §4.2 события сообщений и коды `error`, §6.2–6.3 доставка, курсор и алгоритм переподключения) и `openapi.yaml` (`/messages/*`, `/sync`, `/channels`). Этот документ уточняет §6.3 «Алгоритм переподключения клиента» и при расхождении имеет приоритет для клиентского поведения.
- **Версии сервера.** Сервер закрыл пробелы G1–G4, G7–G9 (§10) дополнительными сигналами. Модель использует их, **когда они есть**, и сохраняет прежние обходы для сервера без них; как отличить — §7.12.

---

## 1. Принципы

1. **Редьюсер чистый.** `reduce(state, event) → { state, effects }`. Никаких часов, случайных чисел, сети и диска внутри. Время приходит в событии (`now`, epoch мс), идентификаторы (`client_msg_id`) генерирует платформа и передаёт в событии.
2. **Состояние — простые данные** (JSON): списки, словари, строки, числа, `null`. Платформа хранит его как угодно, но для сверки с векторами проецирует ровно в форму §3.
3. **Побочные действия — список эффектов**, который возвращает редьюсер (§5). Платформа исполняет их строго по порядку.
4. **Истина — сервер.** Любая серверная запись сообщения побеждает локальную догадку; статусы только повышаются; удаление окончательно.
5. **Повтор безопасен.** Каждое сообщение отправляется с постоянным `client_msg_id`; сервер не создаёт копий (ws-protocol §3.2). Поэтому при неизвестном исходе клиент повторяет, а не гадает.
6. **Отменённое не доставляется.** Сообщение, которое пользователь отменил/удалил до подтверждения, больше никогда не отправляется (§7.10).

## 2. Термины

- **`me`** — id текущего пользователя (из `auth_success.user.id`).
- **Ключ переписки** (`conversation`) — строка `"direct:<id собеседника>"` или `"channel:<id канала>"`, id — десятичное целое > 0 без ведущих нулей (`^(direct|channel):[1-9][0-9]*$`).
  - для записи сообщения: канал — `channel:<target_id>`; личное — `direct:<собеседник>`, где собеседник = `target_id`, если `sender_id == me`, иначе `sender_id`.
- **`client_msg_id`** — ключ идемпотентности, см. §7.1.
- **Запись сообщения** — объект сообщения сервера (кадры `new_message`/`direct_message`/`channel_message`/`message_updated`, элементы `/api/sync`, страницы `/api/messages/...`, тело ответа `POST /api/messages/...`).
- **Голова переписки** — первая по `seq` запись outbox этой переписки, которая не `failed` и не `pending_delete`.
- **Отменённый ключ** (`cancelled`) — `client_msg_id` отменённой записи, удалённой из outbox **без доказательства**, что сервер её не хранит (§7.10).
- **Цепочка синхронизации** — последовательность запросов `/api/sync` от начала (`auth_success`, `sync_start`) до последней страницы (`has_more = false`), неуспеха или обрыва сокета. Каждая цепочка получает номер `chain`.

## 3. Модель состояния

```jsonc
{
  "me": 2,                          // id пользователя или null до первого auth_success
  "connection": "offline",          // "offline" | "online" (сокет авторизован)
  "visible": null,                  // ключ открытой на экране переписки или null
  "sync": {
    "cursor": null,                 // непрозрачная строка next_cursor или null (нет курсора)
    "running": false,               // идёт цепочка синхронизации
    "bootstrap": false,             // текущая цепочка начата без курсора (первый запуск / после 410)
    "chain": 0                      // номер последней начатой цепочки
  },
  "seq": 0,                         // последний выданный порядковый номер outbox
  "outbox": [],                     // записи очереди отправки (§3.1), по возрастанию seq
  "ops": [],                        // операции над подтверждёнными сообщениями (§3.2), в порядке постановки
  "messages": {},                   // { ключ переписки: [сообщения §3.3 по возрастанию id] }; пустых списков нет
  "unread": {},                     // { ключ переписки: число > 0 }; нулевых ключей нет
  "sendLog": [],                    // now каждой WS-отправки send_message за последнюю секунду
  "opsLog": [],                     // now каждой WS-отправки edit_message/delete_message/cancel_message за последнюю секунду
  "wake_at": null,                  // время уже запрошенного будильника tick или null
  "cancelled": []                   // отменённые ключи (§7.10), не больше CANCELLED_MAX, старые первыми
}
```

### 3.1. Запись outbox

Все поля всегда присутствуют.

| Поле | Тип | Смысл |
|---|---|---|
| `client_msg_id` | string | ключ идемпотентности (§7.1); единственный идентификатор записи |
| `conversation` | string | ключ переписки |
| `seq` | int | порядок постановки в очередь (`state.seq + 1` при `enqueue` и `retry`) |
| `text` | string | текст |
| `msgType` | `"text"`\|`"file"`\|`"image"` | тип сообщения |
| `reply_to_id` | int\|null | ответ на сообщение |
| `metadata` | object\|null | метаданные (`{ "file_id": 42 }`) |
| `state` | `"queued"`\|`"sending"`\|`"failed"` | состояние записи |
| `attempts` | int | сколько кадров/запросов этой записи ушло за всё время (не сбрасывается); номер текущей попытки |
| `failures` | int | сколько попыток подряд закончились неудачей — таймаутом или временной ошибкой (§7.3); обрыв, перезапуск и 401 не считаются |
| `maybe_stored` | bool | сервер **мог** сохранить сообщение (кадр хоть раз ушёл и не было отказа) |
| `transport` | `"ws"`\|`"http"`\|null | чем отправлено сейчас (только в `sending`) |
| `ack_deadline` | int\|null | до какого `now` ждать подтверждения (только в `sending`) |
| `next_attempt_at` | int\|null | не отправлять раньше (пауза после неудачи) |
| `failure` | object\|null | `{ "reason": "rejected"\|"max_attempts", "code": string\|null, "message": string\|null }` в `failed` |
| `pending_edit` | string\|null | правка, которую применить после подтверждения (§7.10) |
| `pending_delete` | bool | пользователь отменил: не отправлять, выяснить и удалить (§7.10) |

### 3.2. Операция `ops`

Правка или удаление уже подтверждённого сообщения (с серверным `id`) и отзыв отменённой отправки по ключу. Все поля всегда присутствуют.

| Поле | Тип | Смысл |
|---|---|---|
| `op` | `"edit"`\|`"delete"`\|`"cancel"` | вид |
| `message_id` | int\|null | серверный id (`edit`, `delete`); у `cancel` — `null` |
| `client_msg_id` | string\|null | ключ отменённой записи (`cancel`); иначе `null` |
| `text` | string\|null | новый текст (`edit`), иначе `null` |
| `state` | `"queued"`\|`"sending"` | `sending` — кадр ушёл и ждёт ответа: у `delete`/`cancel` — с таймером `ack_deadline`; у `edit` — без таймера, до подтверждения (§7.10) |
| `attempts` | int | сколько кадров ушло |
| `failures` | int | неудачных попыток (`op_timeout`, временная ошибка) подряд |
| `ack_deadline` | int\|null | до какого `now` ждать ответа (`sending`) |
| `next_attempt_at` | int\|null | пауза после неудачи или `RATE_LIMITED` |

Кадры: `edit` → `{"type":"edit_message","messageId":…,"text":…}`, `delete` → `{"type":"delete_message","messageId":…}`, `cancel` → `{"type":"cancel_message","client_msg_id":…}`. Операция ищется: `delete` — по `message_id`, `cancel` — по `client_msg_id` (каждого не больше одной). **Отправленная правка** — `edit` в `sending` — у сообщения не больше одной: это последняя ушедшая правка, ещё не подтверждённая. Новая отправленная правка того же сообщения вытесняет прежнюю из `ops`.

### 3.3. Сообщение в `messages`

Проекция записи сервера; платформа может хранить больше полей (имя отправителя, вложение), но для сверки с векторами проецирует ровно в эти поля (все всегда присутствуют):

`id`, `client_msg_id` (string\|null), `sender_id`, `text`, `type`, `reply_to_id`, `metadata_json` (строка\|null), `created_at`, `updated_at` (string\|null), `is_deleted` (`0`\|`1`), `status`.

`status`: у своих сообщений (`sender_id == me`) — `"sent"`\|`"delivered"`\|`"read"`; у чужих — `null`. Статус своего сообщения из записи: в канале всегда `"sent"`; в личной — `delivery_status` (`"delivered"`/`"read"`), иначе `"sent"` (в живых кадрах `delivery_status` нет — это `"sent"`).

Список переписки появляется в `messages` только вместе с первым сообщением и никогда не становится пустым: ключей с `[]` нет (сброс — только всего словаря целиком, `{}`).

### 3.4. Что видит пользователь

Лента переписки = `messages[conv]` (по `id`) **без сообщений, для которых в `ops` есть `delete`**, и за ними записи outbox этой переписки **без `pending_delete`** (по `seq`). Скрытие удаляемого — то же правило, что для отменённой записи: пользователь удалил сообщение, и до надгробия оно не показывается (не мелькает при пересинхронизации, после 410, при позднем появлении отменённого — §7.10). Пропало `delete` без надгробия (`DELETE_NOT_CONFIRMED`, `DELETE_REJECTED`) — сообщение снова видно. Надгробие (`is_deleted = 1`) показывается как обычно («сообщение удалено»). Текст записи outbox на экране — `pending_edit ?? text` (правка видна сразу, хотя уйдёт после подтверждения). Отображаемый статус:

| Где | Отображаемое состояние |
|---|---|
| outbox, `state = queued` | **queued** («в очереди», часы) |
| outbox, `state = sending` | **sending** («отправляется») |
| outbox, `state = failed` | **failed** («не отправлено», кнопки «Повторить» / «Удалить») |
| `messages`, `status = sent` | **sent** (одна галочка) |
| `messages`, `status = delivered` | **delivered** (две галочки) |
| `messages`, `status = read` | **read** (две цветные галочки) |

Идентичность строки в UI — `client_msg_id`, если он есть, иначе `id`: при подтверждении (§7.6) пузырь не «прыгает».

```mermaid
stateDiagram-v2
    [*] --> queued: enqueue (после записи на диск)
    queued --> sending: попытка отправки (pump / background_flush)
    sending --> queued: ack_timeout / HTTP 5xx,0,408,429 / error retryable (failures < 5) — пауза
    sending --> queued: error RATE_LIMITED — пауза retry_after_ms, не неудача
    sending --> queued: ws_disconnected / app_restart / HTTP 401 — без паузы, не неудача
    sending --> failed: ack_timeout при failures = 5
    sending --> failed: error send_message с client_msg_id / HTTP 409 / постоянный 4xx
    failed --> queued: retry (пользователь)
    queued --> [*]: cancel, если сервер не мог сохранить
    failed --> [*]: cancel, если сервер не мог сохранить
    queued --> cancelled: cancel, если мог сохранить (pending_delete, не отправляется)
    failed --> cancelled: cancel, если мог сохранить
    sending --> cancelled: cancel в полёте
    cancelled --> [*]: message_cancelled (сервер не сохранит ключ / удалил)
    cancelled --> [*]: синхронизация не нашла ключ — удалить локально, ключ в cancelled
    cancelled --> deleting: запись сервера с ключом — delete_message
    deleting --> [*]: надгробие (message_deleted / is_deleted = 1)
    queued --> sent: эхо / запись сервера с этим client_msg_id
    sending --> sent: эхо / запись сервера с этим client_msg_id
    failed --> sent: запоздалое эхо / запись сервера
    sent --> delivered: message_status_updated / delivery_status
    sent --> read: messages_read / delivery_status
    delivered --> read: messages_read / delivery_status
```

## 4. События

Каждое событие — JSON-объект с `type` и `now` (целое, epoch мс; в пределах одного запуска не убывает). Кадры и тела сервера вкладываются **дословно в форме фикстур** (`fixtures/ws/*`, `fixtures/http/*`); неизвестные поля игнорируются.

### 4.1. От сервера

| `type` | Поля | Откуда |
|---|---|---|
| `ws` | `frame` — кадр сервер→клиент как на проводе | каждый входящий WS-кадр. Обрабатываются `auth_success`, `new_message`, `direct_message`, `channel_message`, `message_updated`, `message_deleted`, `message_cancelled`, `message_status_updated`, `messages_read`, `error`; остальные типы не меняют модель доставки |
| `sync_page` | `chain`, `body` — тело ответа `GET /api/sync` 200 (`http/sync.page.json`) | ответ на эффект `sync_request` с тем же `chain` |
| `sync_reset_410` | `chain`, `body` — тело 410 (`http/sync.cursor-invalid.json`) | ответ 410 `SYNC_CURSOR_INVALID` |
| `sync_failed` | `chain`, `status` (0 — сеть), `retry_after_ms` (int\|отсутствует; из `Retry-After`) | любой другой неуспех `sync_request` |
| `history_page` | `body` — массив записей (`http/messages.direct-page.json`) | ответ на `load_history` или любую загрузку страницы переписки |
| `http_send_result` | `client_msg_id`, `attempt`, `status` (0 — сеть), `body` (JSON ответа или `null`) | ответ на эффект `send_http` |
| `unread_snapshot` | `counts` — `{ ключ переписки: unread_count }`; `last_message_ids`? — `{ ключ переписки: last_message_id \| null }` только для переписок, у которых в ответе списка **есть** поле `last_message_id` (у личных есть всегда, у каналов — с сервера G7) | из `GET /api/channels` и `GET /api/conversations/direct` после `refresh_conversation_lists` |

### 4.2. Локальные

| `type` | Поля | Когда |
|---|---|---|
| `ws_disconnected` | — | сокет закрыт (любая причина, в т.ч. `server_disconnect`) |
| `enqueue` | `client_msg_id`, `conversation`, `text`, `msgType`? (`"text"`), `reply_to_id`? (`null`), `metadata`? (`null`) | пользователь нажал «Отправить» |
| `edit` | ровно одно из `client_msg_id` (запись outbox) / `message_id` (сообщение сервера), `text` | пользователь сохранил правку |
| `delete` | `message_id` | пользователь удалил отправленное сообщение |
| `cancel` | `client_msg_id` | пользователь удалил/отменил неотправленное (queued/sending/failed) |
| `retry` | `client_msg_id`, `new_client_msg_id` (свежий UUID v4; используется, только если нужен новый ключ) | «Повторить» у `failed` |
| `ack_timeout` | `client_msg_id`, `attempt` | будильник из эффекта `schedule` |
| `op_timeout` | `message_id` (у `delete`) или `client_msg_id` (у `cancel`), `attempt` | будильник из эффекта `schedule` |
| `tick` | — | будильник из эффекта `schedule` |
| `sync_start` | — | будильник после `sync_failed`, возврат приложения на передний план, push |
| `background_flush` | — | фоновая задача ОС (iOS BGTask / Android WorkManager) без сокета |
| `conversation_opened` | `conversation` | переписка стала видимой на экране |
| `conversation_closed` | — | переписку закрыли, приложение ушло в фон, экран погас |
| `app_restart` | — | первое событие нового процесса над восстановленным с диска состоянием |

> Отдельного события «попытка отправки записана» нет: редьюсер сам переводит запись в `sending` в том же шаге, где выдаёт `send_ws`/`send_http` (§6.2). Эхо, пришедшее к записи в любом состоянии — `queued` (например, во время паузы после таймаута, до следующей попытки), `sending` или `failed`, — подтверждает её (§7.6).

## 5. Эффекты

Исполняются **строго по порядку** выдачи.

| `type` | Поля | Что делает платформа |
|---|---|---|
| `persist` | `slices` — отсортированный подсписок `["cancelled","cursor","ops","outbox"]` | **барьер**: надёжно записать (транзакция/fsync) эти части **нового** состояния (`outbox` включает `seq`; `cursor` = `sync.cursor`; `cancelled` — список отменённых ключей). Следующие эффекты — только после успешной записи. Ошибка записи — см. ниже. Если `persist` есть, он всегда первый |
| `clear_composer` | `conversation` | очистить поле ввода (только после `persist`, §7.4) |
| `send_ws` | `frame` | отправить кадр в сокет как есть (`send_message`, `edit_message`, `delete_message`, `cancel_message`, `mark_read`). Ошибку записи в сокет не сообщать — придёт `ws_disconnected` / таймаут |
| `send_http` | `client_msg_id`, `attempt`, `method`, `path`, `body` | выполнить запрос; результат — событием `http_send_result` с теми же `client_msg_id` и `attempt` |
| `schedule` | `at`, `event` | в момент `≥ at` диспетчеризовать `event` (дополнив `now`). Отменять будильники не требуется: устаревшие события безвредны (§6.5); одинаковые можно схлопывать |
| `sync_request` | `cursor` (string\|null), `limit`, `chain` | `GET /api/sync?since=<cursor>&limit=<limit>` (без `since`, если `null`); результат — `sync_page` / `sync_reset_410` / `sync_failed` **с тем же `chain`** |
| `refresh_conversation_lists` | — | `GET /api/channels` и `GET /api/conversations/direct`; счётчики — событием `unread_snapshot` |
| `load_history` | `conversation` | загрузить последнюю страницу переписки (`GET /api/messages/...`); результат — `history_page` |
| `user_error` | `code` | показать пользователю ошибку |

Коды `user_error`: `INVALID_CLIENT_MSG_ID`, `INVALID_CONVERSATION`, `INVALID_MESSAGE_TYPE`, `EMPTY_TEXT`, `TEXT_TOO_LONG`, `NOT_EDITABLE`, `NOT_DELETABLE` — ввод отклонён, состояние не изменилось; `DELETE_NOT_CONFIRMED` — удаление не подтвердилось после `MAX_ATTEMPTS` попыток и снято (§7.10); `DELETE_REJECTED` — сервер отказал в удалении (или в отзыве уже сохранённого) окончательно (`error` с `messageId`, G4/G9), операция снята; `EDIT_REJECTED` — сервер отказал в правке окончательно (`error` с `messageId`, G4).

**Ошибка `persist`.** Платформа **отбрасывает новое состояние** (остаётся на прежнем) и не исполняет остальные эффекты этого события. Дальше — по виду события, чтобы очередь не встала:
- действие пользователя (`enqueue`, `edit`, `delete`, `cancel`, `retry`) — показать ошибку; композер не очищается, пользователь повторит сам;
- серверное событие (`ws`, `sync_page`, `sync_reset_410`, `sync_failed`, `history_page`, `http_send_result`, `unread_snapshot`) — данные потеряны для модели, поэтому платформа **принудительно закрывает сокет** (что даёт `ws_disconnected` и переподключение с новой цепочкой синхронизации, которая вернёт те же данные: курсор не сдвинулся) и при постоянной ошибке диска повторяет через `backoff`. Ответ HTTP повторно не нужен: запись осталась `sending`, её будильник `ack_timeout` ещё в силе — повтор тем же ключом безопасен;
- будильник или системное событие (`ack_timeout`, `op_timeout`, `tick`, `sync_start`, `background_flush`, `ws_disconnected`, `app_restart`, `conversation_*`) — диспетчеризовать **то же событие** снова через 1 с (с новым `now`).

Платформа **может** схлопывать подряд идущие одинаковые `send_ws` с кадром `mark_read` одной переписки в пределах 500 мс (предел сервера — 20 `mark_read`/с) — это свобода исполнителя, а не редьюсера.

## 6. Алгоритм

`reduce(state, event)`:
1. применить обработчик события (§6.3), собрав его эффекты;
2. выполнить **насос** (`pump`, §6.2) — всегда, после любого события;
3. если `cancelled`, `sync.cursor`, `ops` или `outbox`/`seq` изменились относительно входного состояния — поставить в начало эффектов `{"type":"persist","slices":[...]}` (только изменившиеся, по алфавиту).

Входное состояние не изменяется (возвращается новое).

### 6.1. Константы

| Имя | Значение | Откуда |
|---|---|---|
| `CLIENT_MSG_ID_RE` | `^[A-Za-z0-9_-]{1,64}$` | сервер, `CLIENT_MSG_ID_RE` |
| `MAX_TEXT_LENGTH` | `16000` (единицы UTF-16, как `String.length` в JS; Swift — `text.utf16.count`) | сервер |
| `ACK_TIMEOUT_MS` | `10000` (и для `send_message`, и для `delete_message`) | ws-protocol §6.3 |
| `HTTP_ACK_TIMEOUT_MS` | `30000` | — |
| `MAX_ATTEMPTS` | `5` — предел `failures` | — |
| `backoff(n)` | `min(1000 · 2^(n−1), 30000)` мс после `n`-й неудачи подряд: 1, 2, 4, 8 с | — |
| `SEND_RATE_MAX` / `SEND_RATE_WINDOW_MS` | `8` за `1000` мс для `send_message` (`sendLog`) | сервер режет 10/с на сокет (ws-protocol §2.3; с G2 — с ответом `RATE_LIMITED`, раньше молча); запас 2 |
| `OPS_RATE_MAX` / `OPS_RATE_WINDOW_MS` | `8` за `1000` мс на все `edit_message`, `delete_message` и `cancel_message` вместе (`opsLog`) | у сервера по 10/с на каждый тип |
| `RATE_LIMITED_RETRY_MS` | `1000` — пауза после `RATE_LIMITED` без `retry_after_ms` | окно сервера |
| `RATE_LIMITED_MAX_RETRY_MS` | `30000` — потолок `retry_after_ms`: больше — считается `30000` | сервер обещает 1…1000; пауза в час от испорченного кадра не должна замораживать очередь |
| `CANCELLED_MAX` | `100` — предел `cancelled` (лишние — самые старые — вытесняются) | — |
| `SYNC_PAGE_LIMIT` | `200` | максимум `/api/sync` |
| `SYNC_RETRY_MS` | `5000` (если нет `retry_after_ms`) | — |
| `KEY_ERRORS` | `CLIENT_MSG_ID_CONFLICT`, `INVALID_CLIENT_MSG_ID`, `CANCELLED` | сервер |
| `WHITESPACE` | U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF | ECMAScript `WhiteSpace` + `LineTerminator` — ровно то, что убирает `trim()` на сервере |

**Пустой текст** — строка, состоящая только из символов `WHITESPACE` (или пустая). Набор фиксирован и **не** берётся из платформы: `Character.isWhitespace` (Kotlin/Java) не считает U+00A0 пробелом, `CharacterSet.whitespacesAndNewlines` (Swift) не содержит U+FEFF, но содержит U+0085. U+200B и U+0085 — не пробелы (вектор 48).

### 6.2. Насос (`pump`)

```
pump(state, now):
  если connection != "online" или sync.running: ничего не делать
  если wake_at != null и wake_at <= now: wake_at = null
  sendLog = [t из sendLog, где now − t < SEND_RATE_WINDOW_MS]
  opsLog  = [t из opsLog,  где now − t < OPS_RATE_WINDOW_MS]
  wakeAt = null
  // 1. операции над подтверждёнными сообщениями, в порядке ops
  для каждой op из ops со state == "queued":
    если op.next_attempt_at != null и > now: wakeAt = min(wakeAt, op.next_attempt_at); пропустить
    если |opsLog| >= OPS_RATE_MAX: wakeAt = min(wakeAt, opsLog[0] + OPS_RATE_WINDOW_MS); пропустить
    opsLog += now; op.attempts += 1; эффект send_ws{frame(op)}
    если op.op == "edit": op.state = "sending"; op.ack_deadline = null; op.next_attempt_at = null
                          // без таймера: молчание не повторяет правку (§7.10); ждёт подтверждения
    иначе: op.state = "sending"; op.ack_deadline = now + ACK_TIMEOUT_MS; op.next_attempt_at = null
           эффект schedule{at: op.ack_deadline, event: {type:"op_timeout", message_id, attempt: op.attempts}}
                                         // у cancel: {type:"op_timeout", client_msg_id, attempt}
  из ops удалить каждую edit в sending, если этим проходом ушла более новая edit того же message_id
  // 2. outbox
  занятые = ∅
  вПолёте = { e.conversation | e ∈ outbox, e.state == "sending", !e.pending_delete }
  для каждой записи e из outbox по возрастанию seq:
    если e.pending_delete или e.state == "failed" или e.conversation ∈ занятые: пропустить
    занятые += e.conversation                     // e — голова своей переписки
    если e.state != "queued" или e.conversation ∈ вПолёте: пропустить   // stop-and-wait
    если e.next_attempt_at != null и e.next_attempt_at > now:
      wakeAt = min(wakeAt, e.next_attempt_at); пропустить
    если |sendLog| >= SEND_RATE_MAX:
      wakeAt = min(wakeAt, sendLog[0] + SEND_RATE_WINDOW_MS); пропустить
    отправить(e, "ws"):
      e.state = "sending"; e.transport = "ws"; e.attempts += 1; e.maybe_stored = true
      e.ack_deadline = now + ACK_TIMEOUT_MS; e.next_attempt_at = null; sendLog += now
      эффект send_ws{frame: send_message(e)}
      эффект schedule{at: e.ack_deadline, event: {type:"ack_timeout", client_msg_id, attempt: e.attempts}}
  если wakeAt != null и wakeAt != wake_at: эффект schedule{at: wakeAt, event: {type:"tick"}}
  wake_at = wakeAt
```

**Запись с `pending_delete` насос не отправляет никогда** и она не занимает переписку.

Кадр `send_message(e)` (все ключи всегда):
`{"type":"send_message","conversationType":"direct","targetId":3,"text":…,"msgType":…,"replyToId":…,"metadata":…,"client_msg_id":…}`.

`background_flush` (только при `connection == "offline"`; иначе ничего): тот же обход голов outbox (без `pending_delete`, с `вПолёте`), но без предела частоты и без будильника; `ops` не трогаются (у правки и удаления нет REST в этом контракте). Подходящая голова (`queued`, `next_attempt_at` нет или `≤ now`) отправляется через HTTP: `transport = "http"`, `ack_deadline = now + HTTP_ACK_TIMEOUT_MS`, эффекты `send_http` и `schedule ack_timeout`:
`{"type":"send_http","client_msg_id":…,"attempt":n,"method":"POST","path":"/api/messages/direct/3","body":{"text":…,"type":…,"reply_to_id":…,"metadata":…,"client_msg_id":…}}` (`/api/messages/channels/<id>` для каналов).

### 6.3. Обработчики

**Начало цепочки** (`startSync`): `sync.chain += 1`, `sync.running = true`, `sync.bootstrap = (sync.cursor == null)`, эффект `sync_request{cursor, limit: 200, chain}`.

**`ws` + `auth_success`**: `me = frame.user.id`; `connection = "online"`; `sendLog = []`, `opsLog = []` (новый сокет); если `!sync.running` — начало цепочки.

**`ws_disconnected`**: `connection = "offline"`; `sync.running = false`; `sendLog = []`, `opsLog = []`; каждая запись outbox `sending` с `transport == "ws"` → `queued`, `transport/ack_deadline/next_attempt_at = null` (`attempts`, `failures`, `maybe_stored` сохраняются); каждая отправленная правка (`edit` в `sending`) **снимается** (правка не повторяется после обрыва, §7.10); каждая другая `op` в `sending` → `queued`, `ack_deadline/next_attempt_at = null`. HTTP-запросы в полёте не трогаются.

**`enqueue`** — проверки по порядку, первая сработавшая даёт `user_error` без изменений:
1. `client_msg_id` не подходит под `CLIENT_MSG_ID_RE` → `INVALID_CLIENT_MSG_ID`;
2. ключ уже есть в outbox, у своего сообщения в `messages` или в `cancelled` → **ничего** (повторная диспетчеризация того же нажатия);
3. `conversation` не ключ переписки → `INVALID_CONVERSATION`;
4. `msgType ∉ {text,file,image}` → `INVALID_MESSAGE_TYPE`;
5. `msgType == "text"` и пустой текст (§6.1) → `EMPTY_TEXT`;
6. длина `> MAX_TEXT_LENGTH` → `TEXT_TOO_LONG`.

Иначе `seq += 1` и в outbox добавляется запись `queued` (`attempts 0`, `failures 0`, `maybe_stored false`, прочие `null`/`false`); эффект `clear_composer{conversation}`.

**Запись сервера** (`ingest(rec, source)`, `source ∈ live | update | sync | history | http`):
```
conv = ключ(rec); own = rec.sender_id == me; reconciled = false
если own и rec.client_msg_id != null и в outbox есть e с этим client_msg_id:   // §7.6
  удалить e из outbox; reconciled = true
  снять op cancel с этим client_msg_id (если есть)                              // §7.10: дальше — delete
  если rec.is_deleted == 0:
    если e.pending_delete: добавить op delete(rec.id)                          // §7.10
    иначе если e.pending_edit != null и e.pending_edit != rec.text: добавить op edit(rec.id, e.pending_edit)
иначе если own и rec.client_msg_id ∈ cancelled:                                 // §7.10, отменённый ключ
  убрать ключ из cancelled; снять op cancel с этим ключом (если есть)
  если rec.is_deleted == 0: добавить op delete(rec.id)
если в messages[conv] есть сообщение с rec.id: слить (§7.9)
иначе если source != "update" или reconciled: вставить проекцию по возрастанию id; inserted = true
если rec.is_deleted == 1: подтвердить удаление rec.id
иначе если есть отправленная правка rec.id и её text == rec.text: снять её      // §7.10, правка применена
если source == "live" и inserted и rec.is_deleted == 0:                         // §7.8
  если own: если conv — канал: unread[conv] удалить
  иначе если conv == visible: если connection == "online": эффект send_ws{mark_read(conv)}
  иначе: unread[conv] += 1
```

«Добавить op delete» не дублирует: если для этого `message_id` уже есть `delete`, ничего не добавляется. Новая op — `queued`, `attempts 0`, `failures 0`, `client_msg_id null` (у `cancel` — `message_id null`, `client_msg_id` = ключ).

**Подтвердить удаление `id`**: удалить из `ops` все операции с `message_id == id` (и `delete`, и устаревшие `edit`).

- `new_message`, `direct_message`, `channel_message` → `ingest(frame.message, "live")`.
- `message_updated` → `ingest(frame.message, "update")` (неизвестное и не своё из outbox — не вставляется).
- `message_deleted` → сообщение ищется **только по `frame.messageId`** во всех переписках (`targetId` кадра — сохранённый `target_id`, не собеседник); найдено — `is_deleted = 1`, `text = ""`, `metadata_json = null`, и если в кадре есть `updated_at` (G8) — `updated_at = frame.updated_at`; в любом случае — подтвердить удаление `messageId`.
- `message_cancelled` (G9) → снять op `cancel` с `frame.client_msg_id`; убрать ключ из `cancelled`; запись outbox с этим ключом и `pending_delete` — удалить (доказано: сервер её не хранит и не сохранит, или удалил сам); если `frame.messageId` — число, подтвердить удаление `messageId`.
- `message_status_updated` → своё сообщение **личной** переписки с `id == messageId`: `status = max(status, frame.status)` для `delivered`/`read`. Каналы и неизвестные id — ничего.
- `messages_read` → для каждого id из `messageIds`: своё сообщение в `messages["direct:" + byUserId]` получает `status = "read"`. Остальные id (чужие, другой переписки, неизвестные) игнорируются.
- `error` — по `context` (`R` — `frame.code == "RATE_LIMITED"`; `pause` — `min(frame.retry_after_ms, RATE_LIMITED_MAX_RETRY_MS)`, если это целое > 0, иначе `RATE_LIMITED_RETRY_MS`):
  - `send_message` с `client_msg_id`, для которого в outbox есть запись `e` не в `failed`:
    - `R` или `frame.retryable == true` — это **не окончательный отказ** (кадр не обработан / сбой до записи), и действует только на живую WS-попытку: если `e.state != "sending"` или `e.transport != "ws"` — ничего (устарело). Иначе `R` → **пауза частоты**: при `e.pending_delete` — как неудачная попытка (ниже); иначе `state = "queued"`, `transport/ack_deadline = null`, `next_attempt_at = now + pause`, `failures` и `maybe_stored` не меняются. Не `R` (`retryable`) → **неудачная попытка**;
    - иначе (`retryable == false` или поля нет — старый сервер) → **отказ** (§7.5);
  - `delete_message` с целым `messageId`, для которого есть `delete` в `sending`: `R` → `state = "queued"`, `ack_deadline = null`, `next_attempt_at = now + pause` (без неудачи); `retryable == true` → **неудача операции**; иначе — операция снимается, эффект `user_error{DELETE_REJECTED}`;
  - `edit_message` с целым `messageId`: `own` — отправленная правка этого `messageId` (`edit` в `sending`), если её `text == frame.text`, иначе нет. `R` → если `own` нет — **ничего** (кадр относится к правке, которую уже вытеснила более новая отправленная: её повтор откатил бы новую); если для `messageId` есть `delete` или `edit` в `queued` — `own` снимается; иначе `own.state = "queued"`, `own.next_attempt_at = now + pause` (уйдёт снова тем же текстом). Любой другой код → `own` (если есть) снимается, эффект `user_error{EDIT_REJECTED}`;
  - `cancel_message` с `client_msg_id`, для которого есть `cancel` в `sending`: `R` → пауза, как у `delete`; `retryable == true` → **неудача операции**; иначе операция снимается, и если в кадре есть целый `messageId` (сообщение сохранено, удалить нельзя): ключ убирается из `cancelled`, снимается `delete` этого `messageId`, запись outbox с ключом и `pending_delete` удаляется с эффектом `load_history{её conversation}` (сообщение вернётся в ленту как обычное), эффект `user_error{DELETE_REJECTED}`;
  - прочие `error` (без `context` — внутренняя ошибка; без поля корреляции — старый сервер, например `INVALID_CLIENT_MSG_ID` или `edit_message`/`delete_message` без `messageId`) модель не меняют: внутренняя ошибка лечится таймаутом и повтором.

**Отказ** записи `e` (кадр `error` или постоянный HTTP-код):
- если `e.pending_delete` — запись удаляется целиком (пользователь её отменил);
- иначе `state = "failed"`, `failure = {reason:"rejected", code: code ?? null, message: message ?? null}`, `maybe_stored = false`, `transport/ack_deadline/next_attempt_at = null`; если был `pending_edit` — он становится `text`, `pending_edit = null`.

**Неудачная попытка** записи `e` (таймаут, временный HTTP-код): `transport/ack_deadline = null`;
- если `e.pending_delete` — `state = "queued"`, `next_attempt_at = null` (запись больше не отправится; выяснится синхронизацией), и если `connection == "online"` и `!sync.running` — начало цепочки;
- иначе `failures += 1`; если `failures ≥ MAX_ATTEMPTS` — `state = "failed"`, `failure = {reason:"max_attempts", code:null, message:null}`, `next_attempt_at = null`; иначе `state = "queued"`, `next_attempt_at = now + backoff(failures)`.

**`ack_timeout`**: только если запись есть, `state == "sending"`, `attempts == event.attempt` и `now ≥ ack_deadline` — неудачная попытка. Иначе — ничего (устаревший будильник).

**`op_timeout`**: только если есть операция — `cancel` с `client_msg_id == event.client_msg_id` (если поле есть в событии), иначе `delete` с `message_id == event.message_id` — в `state == "sending"`, `attempts == event.attempt` и `now ≥ ack_deadline` — **неудача операции**.

**Неудача операции** (`delete`/`cancel`): `failures += 1`, `ack_deadline = null`; если `failures ≥ MAX_ATTEMPTS` — op удаляется, у `delete` — эффект `user_error{DELETE_NOT_CONFIRMED}`, у `cancel` — **без** эффекта (сервер без `cancel_message` молчит, запись решает синхронизация, §7.12); иначе `state = "queued"`, `next_attempt_at = now + backoff(failures)`.

**`http_send_result`**:
- `status` 200/201 → `ingest(body, "http")` (подтверждает по `client_msg_id` в любом состоянии записи, даже если попытка устарела);
- иначе действует, только если запись есть, `state == "sending"`, `transport == "http"`, `attempts == event.attempt`:
  - 409 и прочие 4xx, кроме 401/408/429 → отказ с `code = body.code`, `message = body.error`;
  - 401 → `queued` без паузы и без учёта неудачи (`next_attempt_at = null`): токен обновляет слой авторизации (ws-protocol §6.3);
  - 0, 408, 429, 5xx и прочее → неудачная попытка.

**`sync_page`** (только при `sync.running` и `event.chain == sync.chain`, иначе ничего): `ingest` каждой записи `body.messages` с `source = "sync"`; `sync.cursor = body.next_cursor`; если `has_more` — эффект `sync_request{cursor: next_cursor, limit, chain}`; иначе **завершение цепочки**:
1. `sync.running = false`; эффект `refresh_conversation_lists`;
2. при `sync.bootstrap` и `visible != null` — `load_history{visible}`;
3. отменённые записи (`pending_delete`, не `sending`): если цепочка **не** bootstrap — удалить их из outbox (сервер их не хранит, §7.10) и добавить их ключи в конец `cancelled` (без повторов; сверх `CANCELLED_MAX` — убрать самые старые); если bootstrap — оставить и выдать `load_history` для каждой их переписки (по `seq` первой записи, без повторов и без уже выданной `visible`);
4. `sync.bootstrap = false`; при `visible != null` — `send_ws{mark_read(visible)}`.
Затем насос отправляет `ops` и повторяет outbox.

**`sync_reset_410`** (только при `sync.running` и том же `chain`): `sync.cursor = null`, `messages = {}` (кэш устарел), `sync.bootstrap = true`, эффект `sync_request{cursor: null, limit, chain}` (та же цепочка). **Outbox, `ops` и `unread` сохраняются**; `unread` перезапишет `unread_snapshot`.

**`sync_failed`** (только при `sync.running` и том же `chain`): `sync.running = false`; при `status != 401` — эффект `schedule{at: now + (retry_after_ms ?? SYNC_RETRY_MS), event:{type:"sync_start"}}`. Насос сразу повторяет outbox (повтор без синхронизации безопасен — те же ключи); отменённые записи остаются до следующего завершения цепочки.

**`sync_start`**: при `connection == "online"` и `!sync.running` — начало цепочки; иначе ничего.

**`history_page`**: `ingest` каждой записи с `source = "history"`. Непрочитанное не меняется.

**`unread_snapshot`**: для каждой `k` из `counts` итог `N(k)`: если `last_message_ids` нет или в нём нет ключа `k` — `N = counts[k]` (как раньше); иначе `L = last_message_ids[k] ?? 0`, и `N = counts[k] + |{ m ∈ messages[k] : m.sender_id != me, m.id > L, m.is_deleted == 0 }|`, а для канала, где есть своё сообщение с `id > L`, — `N = |{ чужие m, не надгробия : m.id > max(id своих m с id > L) }|` (надгробие досчёт не увеличивает: читать нечего; своё удалённое сообщение в канале обнуление всё равно даёт — отправка была) (своё сообщение в канале — прочитано до него, §7.8). Затем `unread = { k: N | N > 0 и k != visible }`; если у `visible` `N > 0` и `connection == "online"` — эффект `send_ws{mark_read(visible)}`.

**`conversation_opened`**: `visible = conversation`; `unread[conversation]` удалить; при `online` — `send_ws{mark_read(conversation)}`. **`conversation_closed`**: `visible = null`.

`mark_read(conv)` = `{"type":"mark_read","conversationType":…,"targetId":…}`.

**`edit`** (сначала цель, затем текст; указаны оба id или ни одного — `NOT_EDITABLE`):
- по `client_msg_id`: записи нет, у неё `pending_delete` или `msgType != "text"` → `NOT_EDITABLE`; пустой/длинный текст → `EMPTY_TEXT`/`TEXT_TOO_LONG`; `!maybe_stored` → `text` заменяется на месте; иначе `pending_edit = text`;
- по `message_id`: сообщение должно существовать, быть своим, `is_deleted == 0`, `type == "text"` и не иметь `delete` в `ops`, иначе `NOT_EDITABLE`; текст проверяется так же; в `ops` добавляется `edit`. Локальный текст **не** меняется до `message_updated`.

**`delete`** (`message_id`): своё неудалённое сообщение → в `ops` добавляется `delete` (если уже есть — ничего); иначе `NOT_DELETABLE`. Надгробие — по `message_deleted`/синхронизации.

**`cancel`**: записи нет → ничего; `!maybe_stored` → запись удаляется; иначе `pending_delete = true`, `pending_edit = null`, в `ops` добавляется `cancel(client_msg_id)` (если её нет), и если запись `failed` — `state = "queued"`, `failure = null`, `failures = 0`, `next_attempt_at = null`. Если запись не `sending`, сокет на связи и цепочка не идёт — начало цепочки (выяснить, сохранил ли сервер; сервер без `cancel_message` иначе не ответит). Запись в полёте цепочку не начинает: `cancel_message` уходит насосом сразу.

**`retry`**: только для `failed` (иначе ничего). Если `failure.code ∈ KEY_ERRORS` — нужен новый ключ: `new_client_msg_id` должен подходить под `CLIENT_MSG_ID_RE` и быть неиспользованным — ни в outbox, ни у своего сообщения, ни в `cancelled` (иначе `user_error INVALID_CLIENT_MSG_ID` без изменений), запись получает его и `maybe_stored = false`. Иначе ключ **тот же**. Затем `state = "queued"`, `failures = 0`, `failure = null`, `next_attempt_at = null`, `seq = ++state.seq` (в хвост очереди переписки); `attempts` не сбрасывается.

**`tick`**: только насос.

**`app_restart`**: `connection = "offline"`, `visible = null`, `sync.running = false`, `sync.bootstrap = false`, `messages = {}`, `unread = {}`, `sendLog = []`, `opsLog = []`, `wake_at = null`; записи outbox `sending` → `queued` (`transport/ack_deadline/next_attempt_at = null`; `attempts`, `failures`, `maybe_stored` сохраняются); `op` в `sending` → `queued`. Долговременные части — `me`, `sync.cursor`, `seq`, `outbox`, `ops`, `cancelled`; кэш сообщений и счётчики не входят в контракт долговременности — платформа наполняет их заново событиями `history_page`/`unread_snapshot` (из своего кэша или с сервера). `sync.chain` продолжает расти (сохранять его не обязательно: после перезапуска ни один старый ответ не дойдёт).

### 6.4. Порядок эффектов одного события

`persist` (если нужен) → эффекты обработчика в порядке выдачи → эффекты насоса (`ops` по порядку, каждый `delete` со своим `schedule op_timeout`; затем отправки outbox по `seq`, каждая со своим `schedule ack_timeout`; затем `schedule tick`).

### 6.5. Будильники

Платформа не отменяет будильники. Устаревший `ack_timeout`/`op_timeout` (подтверждено, отказано, удалено, операция `cancel` вытеснена `delete`, ушла новая попытка, или сработал раньше `ack_deadline`) игнорируется; лишний `tick` безвреден; `wake_at` не даёт выдавать одинаковые `tick` подряд. После `app_restart` будильники считаются потерянными (`wake_at = null`), всё `sending` возвращается в `queued`.

## 7. Правила

### 7.1. Генерация `client_msg_id`

Платформа генерирует UUID v4 в каноническом виде без фигурных скобок, в нижнем регистре: `6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b` (36 символов, набор `[0-9a-f-]` ⊂ `[A-Za-z0-9_-]`, длина ≤ 64). Ключ создаётся **один раз** до `enqueue`, хранится в outbox и не меняется ни при каком повторе, переподключении или перезапуске; новый ключ — только при `retry` после ошибки ключа (`KEY_ERRORS`). iOS: `UUID().uuidString.lowercased()`; Android: `UUID.randomUUID().toString()`.

### 7.2. Порядок в переписке и порядок повтора

- В каждой переписке в полёте не больше **одной** записи (stop-and-wait): следующая отправляется только после подтверждения или `failed` головы. Так `id` на сервере идут в порядке `seq`. Сервер с G1 сам обрабатывает кадры сокета по очереди, но stop-and-wait остаётся: он нужен серверу без G1, порядок через **разные** соединения (WS после переподключения, REST из `background_flush`) сервер не гарантирует, а пауза после `RATE_LIMITED` у одной записи не должна пропускать вперёд следующую.
- Разные переписки независимы: их головы уходят одновременно, в порядке `seq`, в пределах `SEND_RATE_MAX` за секунду.
- Повтор после переподключения, перезапуска и 410 — тот же обход: по возрастанию `seq`, с теми же ключами, после завершения цепочки `/api/sync`.
- `failed` и отменённые (`pending_delete`) записи не блокируют очередь; `retry` ставит запись в хвост (новый `seq`).

### 7.3. Повторы, пауза, предел попыток, частота

- Подтверждение ждём `ACK_TIMEOUT_MS` (WS) / `HTTP_ACK_TIMEOUT_MS` (HTTP). Сервер с G2 отвечает на отброшенный пределом частоты кадр `error` `RATE_LIMITED` с `retry_after_ms`: запись возвращается в `queued` с паузой `retry_after_ms` (не больше `RATE_LIMITED_MAX_RETRY_MS`; не неудача — кадр не обработан) и уходит снова **с тем же `client_msg_id`**; так же — `delete`/`cancel` (тем же кадром) и последняя отправленная правка сообщения (тем же текстом, §7.10). Ответ `RATE_LIMITED` не гарантирован (сервер ограничивает и их), а сервер без G2 отбрасывает **молча** — тогда сигнал по-прежнему только таймаут: пауза `backoff(failures)` и повтор тем же ключом.
- `error` с `retryable: true` (G3, `INTERNAL_ERROR`) — неудачная попытка, как таймаут: пауза `backoff`, повтор тем же ключом/кадром.
- Бюджет — `MAX_ATTEMPTS = 5` **неудач** (`failures`): таймаут без ответа или временная ошибка HTTP (0/408/429/5xx). После пятой — `failed (max_attempts)`. Попытки, оборванные **не по вине сервера** — обрыв сокета, перезапуск приложения, HTTP 401, — бюджет не тратят: запись возвращается в `queued` без паузы, `failures` не растёт (`attempts` растёт — это номер кадра). Так мигающая сеть не переводит сообщение в `failed` (вектор 54).
- Повтор пользователем (`retry`) даёт новый бюджет (`failures = 0`).
- **Частота.** У сервера отдельные окна по 10 кадров/с на сокет для `send_message` и для каждого из `edit_message`, `delete_message`, `cancel_message`; сверх — кадр не обрабатывается (сервер с G2 отвечает `RATE_LIMITED`, без G2 — молча). Клиент держит два окна по 8 кадров/с: `sendLog` — для `send_message`, `opsLog` — **общее** для `edit_message` и `delete_message` (проще и строже серверного: 8 на оба типа вместе, а не 10 на каждый). `mark_read` не ограничивается редьюсером (§5).
- **Удаление подтверждается.** `delete_message` ждёт надгробия (`message_deleted` или запись с `is_deleted = 1` из `/api/sync`, истории, эха) `ACK_TIMEOUT_MS`; без него — `op_timeout`, пауза `backoff(failures)` и повтор того же кадра. Повтор безопасен: удаление идемпотентно — сервер с G4 на удаление уже удалённого отвечает тем же надгробием `message_deleted` (без записи, рассылки и сдвига `change_seq`), сервер без G4 — `error` «Сообщение уже удалено» (тоже без записи). Обрыв сокета возвращает `delete` в `queued` без неудачи. Окончательный отказ с `messageId` (G4: окно удаления истекло, чужое, нет сообщения) снимает `delete` сразу — `DELETE_REJECTED`; у сервера без G4 отказ без `messageId` неотличим от потери кадра — после пяти неудач `delete` снимается с `DELETE_NOT_CONFIRMED`. Правка (`edit_message`) по таймауту и после обрыва не повторяется — потерянная правка видна пользователю (текст не изменился) и повторяется им; отказ с `messageId` — `EDIT_REJECTED` сразу, `RATE_LIMITED` — правка ставится снова, **только если она последняя отправленная** для этого сообщения (§7.10).

### 7.4. Композер

Поле ввода очищается **только** эффектом `clear_composer`, который идёт после `persist` с `outbox`: запись уже на диске. Ошибка записи — состояние откатывается, текст остаётся в поле ввода. `user_error` композер не очищает.

### 7.5. Отказы сервера

`error` (`context: "send_message"`, есть `client_msg_id`, не `RATE_LIMITED` и не `retryable: true`), HTTP 409 и постоянные 4xx — `failed (rejected)`, `maybe_stored = false`. У сервера с G3 это **доказательство**: каждый отказ несёт `code` и `retryable: false` и случается только до записи (после записи сервер отвечает эхом сохранённой записи), временные сбои — `retryable: true`/HTTP 503 (неудачная попытка, §7.3). У сервера без G3 (нет `retryable`) это **допущение**: внутренняя ошибка выглядела как отказ, а ошибка после записи давала тот же кадр (§10, G3). `CLIENT_MSG_ID_CONFLICT`/`INVALID_CLIENT_MSG_ID`/`CANCELLED` — ошибка ключа: `retry` получит новый ключ. Прочие отказы повторяются с тем же ключом (если «отказ» на деле был временной ошибкой старого сервера и запись сохранилась, повтор вернёт её, а не копию).

### 7.6. Временный id → серверный id

Временный идентификатор сообщения — `client_msg_id`. Любая запись сервера (`direct_message`/`channel_message`/`new_message`, `message_updated`, страница `/api/sync`, страница истории, ответ `POST` 200/201) с `sender_id == me` и `client_msg_id` записи outbox подтверждает её **в любом состоянии**: запись удаляется из outbox, сообщение входит в `messages` под серверным `id` со статусом из записи. Одна запись outbox не может подтвердиться дважды: второе эхо — уже обычное слияние по `id`.

### 7.7. Дедупликация

Сервер шлёт на каждое сообщение два кадра (`direct_message`/`channel_message` и `new_message`), автору — тоже, а повтор отправки — ещё одно эхо той же записи. Все они сливаются по `id`: второй и последующие кадры ничего не вставляют и не увеличивают непрочитанное. Обрабатывать можно оба типа кадров — результат одинаковый.

### 7.8. Непрочитанное

- Счётчик растёт только от **живых** кадров нового сообщения, впервые увиденного по `id`, не удалённого, **чужого**, в переписке, которая **не открыта** (`visible`).
- В открытой переписке счётчик не растёт; вместо этого — `mark_read` (если сокет на связи).
- Свои сообщения никогда не увеличивают счётчик. Своё сообщение в **канале** (в том числе отправленное с другого устройства) обнуляет счётчик канала — так делает сервер (`last_read_message_id` автора = его сообщение). В личной переписке своё сообщение счётчик не меняет (сервер так же).
- `conversation_opened` обнуляет счётчик и шлёт `mark_read`; `conversation_closed` (и уход в фон) снимает `visible`.
- `/api/sync` и страницы истории счётчики не меняют: после синхронизации редьюсер запрашивает `refresh_conversation_lists`, и `unread_snapshot` с серверными `unread_count` заменяет счётчики целиком (у открытой переписки — 0 и `mark_read`). Удаление сообщения счётчик не уменьшает (сервер тоже считает удалённые). Исключение — досчёт снимка по `last_message_ids` (§6.3): чужое надгробие новее снимка к счётчику **не добавляется** (сообщение удалено раньше, чем его могли прочитать, — показывать бейдж не на что); следующий снимок снова берёт серверный счёт как есть.
- Снимок считается сервером раньше, чем применяется: живое сообщение между ними иначе терялось бы до следующего снимка (G7). Поэтому платформа передаёт в `unread_snapshot` и `last_message_id` каждой переписки из тех же ответов (`last_message_ids`), а редьюсер досчитывает чужие сообщения новее него (§6.3). Нет поля в ответе (канал у сервера без G7) — счётчик берётся как есть.

### 7.9. Слияние записей (upsert по `id`)

Для существующего сообщения `L` и записи `S` с тем же `id`:
1. `S.is_deleted == 1` → содержимое (`text`, `type`, `reply_to_id`, `metadata_json`, `created_at`, `updated_at`, `is_deleted`) берётся из `S` (надгробие);
2. иначе, если `L.is_deleted == 1` → содержимое `L` сохраняется (удаление окончательно);
3. иначе, если `instant(S.updated_at) ≥ instant(L.updated_at)` (`null` — раньше любого момента) → содержимое из `S`; иначе остаётся `L` (запоздавшая страница не откатывает свежую правку);
4. `client_msg_id = L.client_msg_id ?? S.client_msg_id`; у своих `status = max(L.status, статус(S))` по порядку `sent < delivered < read` — **статус никогда не понижается**.

### 7.10. Правка, удаление и отмена неподтверждённого

Признак `maybe_stored` отвечает на вопрос «мог ли сервер уже сохранить это сообщение».

**Правка.**
- `maybe_stored == false` (ещё ни разу не ушло, или сервер отказал): правка меняет `text` прямо в outbox.
- `maybe_stored == true`: менять текст в outbox бессмысленно — повтор с тем же ключом вернёт уже сохранённый старый текст. Правка запоминается в `pending_edit` (на экране — сразу, §3.4); запись продолжает отправляться тем же ключом, а после подтверждения (§7.6) редьюсер ставит `edit` в `ops`. Если вместо подтверждения пришёл отказ — сообщения на сервере нет, `pending_edit` становится текстом.

**Отмена (правило: отменённое сообщение никогда не доставляется позже).**
- `maybe_stored == false`: запись удаляется — сеть не нужна.
- `maybe_stored == true`: `pending_delete = true`, запись скрыта и **больше никогда не отправляется** — ни насосом, ни `background_flush`, ни после переподключения. В `ops` ставится `cancel`: кадр `cancel_message` (G9) просит сервер никогда не сохранять этот ключ, а сохранённое — удалить; он повторяется как `delete` (таймаут, пауза, обрыв сокета) и переживает перезапуск. Ответ `message_cancelled` — доказательство: запись удаляется, ключ забывается. Пока ответа нет (или сервер без G9 молчит — после пяти таймаутов операция снимается без ошибки), действуют прежние пути:
  - пришла запись сервера с этим `client_msg_id` (эхо кадра, бывшего в полёте; страница `/api/sync`; история; ответ `POST`) → сообщение сохранено: в `ops` ставится `delete` по серверному `id`, оно подтверждается надгробием (§7.3);
  - пришёл отказ → сообщения нет, запись удаляется;
  - **завершилась цепочка синхронизации** (не bootstrap), а запись не `sending` → ключа на сервере нет, запись удаляется локально, а её ключ запоминается в `cancelled` (`persist`). Цепочка доказывает почти всё: пока она идёт, клиент ничего не отправляет, поэтому последняя попытка записи была до начала цепочки; `/api/sync` от сохранённого курсора возвращает каждое сообщение, сохранённое после курсора (а сохранённое раньше подтвердило бы запись прошлой синхронизацией). Исключения — кадр, обработанный сервером после чтения `/api/sync` (остаточный риск ниже), и запись, отменённая до 410: курсор новой цепочки взят уже после её сохранения, и история переписки её могла не вернуть;
  - завершилась bootstrap-цепочка (первый запуск, 410) → она ничего не доказывает (без курсора `/api/sync` пуст); запись остаётся скрытой, запрашивается `load_history` её переписки (если сообщение там — уходит `delete`), а решение — на следующем завершении обычной цепочки.
- **Отменённые ключи** (`cancelled`). Ключ записи, удалённой без доказательства, хранится (до `CANCELLED_MAX`, на диске): своя запись сервера с этим ключом, пришедшая **когда угодно позже** (живое эхо, `/api/sync`, история, ответ `POST`), ставит `delete` по её `id` и убирает ключ; до надгробия сообщение скрыто (§3.4). `message_cancelled` и окончательный отказ отзыва тоже убирают ключ. Повторно ключ не используется (`enqueue`, `retry`).
- Чтобы выяснение не ждало случайного переподключения, `cancel` (и таймаут отменённой записи в полёте) при открытом сокете сразу начинает цепочку синхронизации.
- **Остаточный риск и как он закрыт.** Кадр, бывший в полёте (или запрос HTTP), может быть обработан сервером **после** чтения `/api/sync` (сервер медлил дольше `ACK_TIMEOUT_MS`, сокет уже закрыт), а запись, отменённая до 410, — не попасть ни в историю, ни в синхронизацию. С сервером G9 окно закрыто: `cancel_message` отмечает ключ на сервере, и поздняя обработка того же ключа отклоняется (`CANCELLED`), а уже сохранённое сообщение сервер удаляет сам и рассылает `message_deleted` получателям. С сервером без G9 остаётся `cancelled`: сообщение, появившееся у отправителя позже, удаляется автоматически (`delete`), но получатель мог его увидеть до этого; не появившееся у отправителя (не в последней странице истории, до курсора) — остаётся на сервере, это принятое ограничение старого сервера.
- **Предел отменённых ключей на сервере** (`CANCELLED_KEYS_PER_SENDER`, 1000) — принятый остаточный риск: клиент отменённую запись никогда не отправляет повторно (§7.10), так что вытесненный ключ мог бы «ожить» только для запоздавшего кадра, который пробыл в полёте дольше, чем автор успел отменить ещё 1000 других отправок; очередь кадров сокета (G1) делает это практически невозможным.
- Окончательный отказ отзыва с `messageId` (сообщение сохранено, а окно удаления истекло, G9) — запись больше не скрывается: она удаляется из outbox, ключ забывается, `load_history` возвращает сообщение в ленту как обычное своё, пользователю — `DELETE_REJECTED`.

**Правка и удаление подтверждённых сообщений** идут через `ops` и уходят, как только сокет на связи и цепочка синхронизации завершена, в пределах `OPS_RATE_MAX` (§7.3).

**Отправленная правка ждёт подтверждения** (задача 18). Ушедший `edit` не удаляется из `ops`, а остаётся в `sending` (без таймера) — одна на сообщение: новая отправленная правка того же сообщения вытесняет прежнюю. Снимается она подтверждением (своя запись с этим `id` и **тем же текстом**: `message_updated`, `/api/sync`, история), окончательным отказом с `messageId` (`EDIT_REJECTED`), обрывом сокета и перезапуском (правка не повторяется), надгробием. Так `RATE_LIMITED` можно отнести к правке: если кадр относится к отправленной правке с тем же текстом и для сообщения не ждёт более новая правка или удаление — она уходит снова после паузы; если её уже вытеснила более новая — ничего (раньше такой кадр ставил старый текст снова и мог откатить новую правку, вектор 70). Остаток: если более новая правка потерялась **молча** (без ответа), а старая получила `RATE_LIMITED` раньше, чем ушла новая, — уйдёт старая; результат виден пользователю, как любая потерянная правка.

### 7.11. Синхронизация

- Курсор хранится на диске (`persist cursor`) и меняется **только** после применения страницы — сначала данные, затем курсор (одним шагом редьюсера).
- Слияние — upsert по `id` (§7.9): новые вставляются, изменённые обновляются, надгробия (`is_deleted = 1`, `text = ""`) заменяют содержимое и подтверждают удаления, `delivery_status` повышает статус своих.
- Свои записи с `client_msg_id` из outbox подтверждают их до повтора (§7.6) — сообщение, сохранённое до обрыва, не уйдёт второй раз.
- Живые кадры курсор не двигают; пересечение с `/api/sync` поглощается слиянием.
- 410 `SYNC_CURSOR_INVALID` → курсор и кэш сбрасываются, та же цепочка продолжается без курсора; outbox, `ops`, `cancelled` и счётчики сохраняются; по завершении — `refresh_conversation_lists`, `load_history` открытой переписки и переписок отменённых записей, повтор outbox с теми же ключами.
- Каждая цепочка имеет номер `chain`; ответ (страница, 410, ошибка) с другим `chain` или пришедший, когда цепочка уже не идёт, игнорируется (вектор 53). Так страница прерванной цепочки, дошедшая во время новой, не сдвинет курсор назад и не завершит чужую цепочку.

### 7.12. Сервер с новыми сигналами и без них

Версию сервера клиент не спрашивает: каждый новый сигнал распознаётся **по самому кадру**, и для сервера без него действует прежний путь. Векторы покрывают оба варианта.

| Пробел | Сигнал нового сервера | Как распознать | Без него (прежний путь) |
|---|---|---|---|
| G1 | кадры сокета — по очереди | — (не наблюдается) | stop-and-wait по переписке — остаётся всегда (§7.2) |
| G2 | `error` `RATE_LIMITED` + `retry_after_ms` | `code == "RATE_LIMITED"` | таймаут `ACK_TIMEOUT_MS` и `backoff` |
| G3 | `code` + `retryable` у каждого отказа; отказ — только до записи | поле `retryable` | любой `error` с `client_msg_id` — отказ, `maybe_stored = false` как допущение |
| G4 | `messageId` + `code` у ошибок правки/удаления; повтор удаления — надгробие | целое `messageId` в `error` | ошибки правки/удаления игнорируются; `delete` до пяти таймаутов |
| G7 | `last_message_id` в `GET /api/channels` | поле есть в ответе → ключ в `last_message_ids` | счётчик снимка как есть |
| G8 | `updated_at` в `message_deleted` | поле есть в кадре | прежний `updated_at` до следующей синхронизации |
| G9 | `cancel_message` → `message_cancelled`; `CANCELLED` | ответ пришёл | сервер молчит: `cancel` снимается после пяти таймаутов без ошибки; запись решают синхронизация и `cancelled` |

`cancel_message` отправляется всегда (сервер без G9 игнорирует неизвестный кадр — он расходует только окно `opsLog` и пять кадров за ~1 мин на отменённую запись). Неизвестные поля и кадры по-прежнему игнорируются (§4).

## 8. Таблица переходов

`Q` — queued, `S` — sending, `F` — failed (записи outbox); `sent/delivered/read` — статус сообщения в `messages`.

| ID | Триггер | Из | В | Эффекты / примечание |
|---|---|---|---|---|
| T01 | `enqueue` (проверки пройдены) | — | Q | `persist outbox`, `clear_composer`; дальше насос |
| T02 | `enqueue`/`edit`/`delete`/`retry` с недопустимыми данными | — | — | `user_error` (код по §6.3), состояние не меняется |
| T03 | `enqueue` с уже известным `client_msg_id` | любое | без изменений | эффектов нет |
| T04 | насос: голова Q, сокет на связи, синхронизация завершена, пауза истекла | Q | S (ws) | `send_ws send_message`, `schedule ack_timeout` (`attempts+1`, `maybe_stored`) |
| T05 | насос: предел 8 отправок/с исчерпан | Q | Q | `schedule tick` к освобождению окна (один раз) |
| T06 | насос: голова переписки в полёте или ждёт | Q (не голова) | Q | stop-and-wait; другие переписки уходят независимо; F и `pending_delete` не занимают переписку |
| T07 | эхо / запись сервера с `client_msg_id` записи | S | sent | запись удалена из outbox, `persist outbox` |
| T08 | эхо / запись сервера с `client_msg_id` записи | Q, F | sent | так же (эхо до следующей попытки, запоздалое эхо после `failed`) |
| T09 | повторный кадр того же `id` (`new_message` после `direct_message`, эхо повтора) | sent… | без изменений | эффектов нет, непрочитанное не растёт |
| T10 | `message_status_updated` `delivered` | sent | delivered | — |
| T11 | `messages_read` (`byUserId` = собеседник) | sent, delivered | read | только свои сообщения переписки `direct:<byUserId>` |
| T12 | более низкий статус (`delivered` после `read`, `delivery_status` ниже) | read / delivered | без изменений | статус не понижается; свои в канале всегда `sent` |
| T13 | `ack_timeout` (актуальный), `failures+1 < 5` | S | Q | `next_attempt_at = now + backoff(failures)`, `schedule tick` |
| T14 | `ack_timeout` (актуальный), `failures+1 = 5` | S | F (`max_attempts`) | `persist outbox` |
| T15 | устаревший `ack_timeout` или ответ HTTP (другая попытка, нет записи, раньше срока) | любое | без изменений | ничего |
| T16 | `error` `send_message` с `client_msg_id` | Q, S | F (`rejected`) или удалена (`pending_delete`) | `maybe_stored = false`; `pending_edit` → `text` |
| T17 | `http_send_result` 200/201 | любое | sent | как T07/T08 |
| T18 | `http_send_result` 409 / постоянный 4xx | S (http) | F (`rejected`) | как T16 |
| T19 | `http_send_result` 0/408/429/5xx; 401 | S (http) | Q (пауза) / F; Q без паузы | как T13/T14; 401 — без паузы и без неудачи |
| T20 | `ws_disconnected` | S (ws), `delete` в полёте | Q | без паузы, `failures` не растёт |
| T21 | `auth_success` → `/api/sync` → повтор outbox | Q | S | `sync_request`; по завершении — `refresh_conversation_lists` и отправки по `seq` |
| T22 | `app_restart` | S | Q | кэш, счётчики, `visible`, `wake_at`, окна частоты сброшены |
| T23 | `retry` | F | Q (хвост) | тот же ключ; новый — только после `KEY_ERRORS`; `failures = 0` |
| T24 | `cancel` | Q, F (`!maybe_stored`) / Q, S, F (`maybe_stored`) | удалена / `pending_delete` (не отправляется) | во втором случае — `cancel` в `ops`; не в полёте — начать синхронизацию, выяснить |
| T25 | `edit` записи outbox | Q, F / Q, S | текст на месте / `pending_edit` | после подтверждения — `edit` в `ops` |
| T26 | `edit`/`delete` подтверждённого; `pending_*` после подтверждения | sent… | `ops` | уходят, когда на связи |
| T27 | живое чужое новое сообщение | — | `unread+1` / `mark_read` | `mark_read`, если переписка открыта |
| T28 | живое своё сообщение | — | без роста; канал — обнуление | — |
| T29 | `conversation_opened` / `conversation_closed` | — | `unread = 0` / `visible = null` | `mark_read`, если на связи |
| T30 | `unread_snapshot` | — | счётчики заменены | открытая — 0 и `mark_read` |
| T31 | `message_updated` | сообщение | обновлено | только если новее (`updated_at`) и не надгробие |
| T32 | `message_deleted` | сообщение | надгробие | поиск только по `messageId` |
| T33 | `sync_page` | — | слияние, курсор | `persist cursor`; `has_more` → следующий `sync_request` |
| T34 | `sync_reset_410` | — | курсор и кэш сброшены | outbox сохраняется; `sync_request` без курсора; по завершении `load_history` |
| T35 | `sync_failed` / `sync_start` | — | цепочка остановлена / новая цепочка | `schedule sync_start` (кроме 401); outbox повторяется |
| T36 | `history_page` | — | слияние | непрочитанное не меняется |
| T37 | `background_flush` без сокета | Q | S (http) | `send_http`, `schedule ack_timeout` |
| T38 | посторонние кадры, `error` без `client_msg_id`, страница вне синхронизации | — | без изменений | — |
| T39 | насос: `ops` в пределах 8 кадров/с | `op` queued | отправлена (`sending`; `edit` — без таймера, вытесняет прежнюю отправленную правку сообщения) | `send_ws`, для `delete` — `schedule op_timeout`; сверх окна — `schedule tick` |
| T40 | `op_timeout` (актуальный) | `delete` sending | queued с паузой / снята | `failures+1`; на пятой — `user_error DELETE_NOT_CONFIRMED` |
| T41 | надгробие (`message_deleted`, `is_deleted = 1` в любой записи) | `ops` с этим id | сняты | `persist ops` |
| T42 | завершение цепочки при отменённых записях | `pending_delete` (не S) | удалена / ждёт (`load_history`) | обычная цепочка — удалить, ключ в `cancelled`; bootstrap — история переписок |
| T43 | ответ синхронизации чужой или прерванной цепочки | — | без изменений | ничего |
| T44 | `error` `send_message` `RATE_LIMITED` (G2) | S (ws) | Q | пауза `retry_after_ms` (иначе 1000), `failures` не растёт; устаревший — ничего |
| T45 | `error` `send_message` `retryable: true` (G3) | S (ws) | Q (пауза) / F | как T13/T14 |
| T46 | `cancel` записи с `maybe_stored` | Q, S, F | `pending_delete` + `cancel` в `ops` | насос шлёт `cancel_message` (окно `opsLog`), `schedule op_timeout`; запись сервера с ключом заменяет `cancel` на `delete` |
| T47 | `message_cancelled` (G9) | `cancel`, `pending_delete` | сняты | ключ убран из `cancelled`; `messageId` — подтвердить удаление |
| T48 | `cancel`: `op_timeout` / `error cancel_message` | `cancel` sending | queued (пауза) / снята | пятая неудача — снять без ошибки; `RATE_LIMITED` — пауза; окончательный с `messageId` — запись снята, `load_history`, `DELETE_REJECTED` |
| T49 | `error` `delete_message` с `messageId` (G4) | `delete` sending | queued (пауза) / снята | `RATE_LIMITED` — пауза без неудачи; `retryable` — как T40; иначе `DELETE_REJECTED` |
| T50 | `error` `edit_message` с `messageId` (G4) | `edit` sending (тот же текст) | queued (пауза) / снята / без изменений | `RATE_LIMITED` — пауза, если правка последняя отправленная и нет более новой правки/удаления (иначе снята); устаревшая (вытеснена) — ничего; иначе снята и `EDIT_REJECTED` |
| T51 | своя запись сервера с ключом из `cancelled` | `cancelled` | `delete` в `ops` | ключ убран; сообщение скрыто до надгробия (§3.4); `enqueue` с таким ключом — ничего |
| T52 | `message_deleted` с `updated_at` (G8) | сообщение | надгробие с `updated_at` | — |
| T53 | `unread_snapshot` с `last_message_ids` (G7) | — | счётчики досчитаны | чужие новее `last_message_id`, кроме надгробий; своё в канале — обнуление до него |
| T54 | подтверждение отправленной правки / обрыв | `edit` sending | снята | своя запись с тем же `id` и текстом; `ws_disconnected`/`app_restart` — снять без повтора; `persist ops` |

## 9. Соответствие требованиям

| Требование | Где |
|---|---|
| состояния `queued → sending → sent → delivered → read` и `failed` | §3.4, T01–T14 |
| триггеры: enqueue, попытка WS, эхо по `client_msg_id`, `message_status_updated`, `messages_read`, таймаут, молчаливый сброс пределом частоты, 409, постоянный 4xx, повтор при переподключении, повтор и отмена пользователем | T01, T04, T07–T08, T10–T11, T13–T14, T16–T19, T21, T23–T24 |
| генерация `client_msg_id` | §7.1 |
| порядок в переписке и порядок повтора | §7.2 |
| повторы, пауза, предел попыток, частота | §7.3 |
| композер очищается после надёжной записи | §7.4 |
| временный → серверный id | §7.6 |
| дедупликация `new_message` и `direct_message`/`channel_message` | §7.7 |
| непрочитанное | §7.8 |
| слияние синхронизации, надгробия, курсор, 410 | §7.9, §7.11 |
| правка/удаление в очереди; отменённое не доставляется | §7.10 |
| новые сигналы сервера и совместимость со старым | §7.12, T44–T54 |

## 10. Открытые вопросы к серверу (Open server gaps)

Ни один не мешает корректной модели — у каждого есть обход на клиенте, описанный выше. **Задача 16 закрыла на сервере G1–G4 и G7–G9** (дополнительными сигналами, совместимо с настольным клиентом); модель использует их, когда они есть (§7.12), а обходы остаются для сервера без них. Открытыми остаются G5 и G6.

- **G1 (закрыт: кадры сокета обрабатываются по очереди, ws-protocol §2.3). Порядок сохранения кадров одного сокета.** `send_message` обрабатывается асинхронно (`await` при проверке получателя и файла), поэтому два кадра подряд могут получить `id` в обратном порядке. Обход: stop-and-wait по переписке (§7.2). Улучшение: последовательная обработка кадров сокета на сервере.
- **G2 (закрыт: `error` `RATE_LIMITED` с `retry_after_ms`). Молчаливый сброс пределом частоты.** Отброшенный кадр не даёт ответа, клиент узнаёт об этом только через `ACK_TIMEOUT_MS`. Обход: собственные окна 8/с и таймаут с повтором (тем же ключом; удаление — тем же кадром). Улучшение: кадр `error` с `code: "RATE_LIMITED"` и `client_msg_id`/`messageId`.
- **G3 (закрыт: `code` + `retryable`, отказ только до записи). Нет машинного признака «временная ошибка», и отказ не доказывает отсутствие записи.** У `error` `send_message` машинный `code` есть только у ошибок ключа; внутренняя ошибка при записи (не `UNIQUE`) приходит с `context: "send_message"` и выглядит как окончательный отказ. Более того, отказ **не доказывает**, что сообщение не сохранено: ошибка после `INSERT` (например, в `getMessageById`/`attachSenders`) даёт тот же кадр, хотя строка уже есть. Клиент всё равно ставит `maybe_stored = false`: повтор тем же ключом в этом случае вернёт сохранённую запись (вреда нет), но отмена такой записи удалит её только локально — сообщение останется на сервере и придёт отправителю следующей синхронизацией как обычное своё (тот же остаточный риск, что в §7.10). Улучшение: `code`/`retryable` у всех отказов и отказ только до записи.
- **G4 (закрыт: `messageId` + `code`, идемпотентное надгробие). Правка и удаление без корреляции.** Кадры `error` для `edit_message`/`delete_message` не содержат `messageId`, ключа идемпотентности у правки нет. Обход: `delete` подтверждается надгробием и повторяется (идемпотентно, §7.3), после пяти неудач — `DELETE_NOT_CONFIRMED`; `edit` уходит один раз, результат виден по `message_updated`. Отказ удаления (окно истекло, чужое) неотличим от потери кадра и стоит пяти попыток.
- **G5 (закрыт для живых сокетов: `conversation_read`, `multi-device.md` §6). Прочтение на другом своём устройстве.** Сейчас остальные сокеты читателя получают `conversation_read` — платформа обнуляет `unread` этой переписки (как `conversation_opened` без смены `visible`). Без связи — по-прежнему: `messages_read` уходит только автору; другие устройства читателя узнают о прочтении лишь из `delivery_status` в `/api/sync` (личные) и из `unread_count` списков (каналы — позиция прочтения в синхронизацию не входит). Обход: `refresh_conversation_lists` после каждой синхронизации и `unread_snapshot`.
- **G6. Нет квитанций в каналах.** Свои сообщения в канале остаются `sent`.
- **G7 (закрыт: `last_message_id` в `GET /api/channels`, `last_message_ids` в `unread_snapshot`). Гонка снимка счётчиков.** Живое сообщение, пришедшее между расчётом `unread_count` на сервере и применением `unread_snapshot`, может быть не учтено до следующего снимка. Улучшение: `last_message_id` в `GET /api/channels` (в личных уже есть), чтобы клиент мог досчитать.
- **G8 (закрыт). В `message_deleted` нет `updated_at`.** Живое надгробие сохраняет прежний `updated_at` до следующей синхронизации (на отображение не влияет).
- **G9 (закрыт: `cancel_message`/`message_cancelled`, `CANCELLED`; остаток для старого сервера — `cancelled`, §7.10). Нет отзыва по ключу.** Нельзя сказать серверу «если `client_msg_id` придёт — не сохраняй». Поэтому отмена сообщения, кадр которого ещё обрабатывается сервером, оставляет окно (§7.10, принятый остаточный риск). Улучшение: `cancel_message {client_msg_id}`, после которого повтор/запоздалая обработка этого ключа отклоняется.

## 11. Векторы и платформы

- `fixtures/reducers/*.json` — табличные векторы `{ name, description, covers, initialState, events, expectedEffects, expectedState }` (формат — `fixtures/reducers/README.md`). Каждый ID из таблицы §8 покрыт хотя бы одним вектором (проверяется тестом).
- **iOS (XCTest) и Android (JUnit) обязаны прогонять каждый вектор** своим редьюсером, обходя каталог целиком (не по списку), и сверять эффекты каждого события и итоговое состояние. Новый вектор или правка документа — только от Integration, вместе с эталоном.
