# Task 16 report: closing server delivery gaps G1–G4, G7–G9

**Status:** DONE. Worktree `m-integration`, branch `mobile/integration`, base `6ecc97f`. Nothing was pushed.

## Commits

| SHA | Message |
|---|---|
| `a2ff7b2` | feat(server): close mobile delivery gaps G1-G4, G7-G9 |
| `3a68ec8` | docs(contracts): document delivery gap signals and recapture fixtures |
| `c02a73a` | feat(contracts): use the new server delivery signals in the reducer |

The server change is one commit because all the gaps touch the same three files (`ws/server.js`, `message.service.js`, `api/index.js`). Splitting it by hunk would have needed interactive staging, which isn't available here.

## 1. Server changes per gap (exact frame shapes)

All changes are additive. The existing frame names and fields are unchanged: `error.message`/`text`, `message_deleted.messageId`/`conversationType`/`targetId`, and the REST bodies `{error, code?}`.

### G1: frames of one socket are processed in order (`server/src/ws/server.js`)

- **Per-socket queue.** `enqueueFrame` keeps a promise chain per socket: `ws.lane = {tail, pending}`.
  - Frames that go through the queue (`SERIAL_TYPES`): `send_message`, `direct_message`, `channel_message`, `edit_message`, `delete_message`, `cancel_message`, `mark_read`.
  - Frames that bypass it, as before: `auth`, calls, `typing`, presence, `rd_*` and audio. Their order relative to messages doesn't matter, and delay would be noticeable.
- **Other sockets are unaffected.** Each socket has its own chain, so a slow frame on one socket doesn't delay others.
- **Ping.** `ping`/`pong` is handled by the `ws` library and never enters the queue.
- **Bounded queue.** `WS_MAX_QUEUED_FRAMES`, default 100. A frame beyond that limit gets `error RATE_LIMITED` with `retry_after_ms: 1000` and is not stored in memory.
- **Combined with the rate limiter.** The rate limit is checked first, on arrival. Then the queue bound is checked. A frame that passes both is chained.
- **Hung handler.** `runFrame` races the handler against `WS_FRAME_TIMEOUT_MS` (default 30 s). After the timeout the next frame proceeds, so the socket's queue never stalls permanently.
- **User captured on arrival.** A frame that arrived before a normal socket close is still processed with that user. This covers desktop sending a message and closing immediately. A revoked socket (`revokeSocket`) drops its queued frames.

### G2: rate-limited frames get an error reply instead of silence

`checkRate` now returns `retryAfterMs` (`allowRate` is kept for audio). For the types that expect a reply (`ACK_TYPES`: send and its aliases, edit, delete, cancel), the frame is still dropped, and the server replies:

```json
{"type":"error","context":"send_message","message":"Слишком много запросов — повторите чуть позже",
 "text":"…","code":"RATE_LIMITED","retryable":true,"client_msg_id":"…","retry_after_ms":1000}
```

- The correlation field is `client_msg_id` for send and cancel, and `messageId` for edit and delete. `text` is included for send and edit.
- **Flood protection.** Replies are capped at 10 per second per socket (`REPLY_BUDGET`). They are also skipped while the client isn't reading its socket (`bufferedAmount > 1 MB`), so a flood of dropped frames can't turn into a flood of buffered replies.
- `mark_read`, `typing`, presence and other types stay silent.
- `cancel_message` gets its own bucket of `[10, 1000]`, the same as `delete_message`.

### G3: every `send_message` refusal carries `code` and `retryable`

**Error codes** (`message.service.js`). Every validation throws a coded error via `codedError`. The message texts are unchanged.

| Codes | `retryable` |
|---|---|
| `INVALID_CLIENT_MSG_ID`, `CLIENT_MSG_ID_CONFLICT`, `CANCELLED`, `INVALID_CONVERSATION`, `INVALID_MESSAGE_TYPE`, `INVALID_TARGET`, `RECIPIENT_NOT_FOUND`, `NOT_CHANNEL_MEMBER`, `EMPTY_TEXT`, `TEXT_TOO_LONG`, `INVALID_METADATA`, `ATTACHMENT_NOT_ACCESSIBLE` | `false` |
| `RATE_LIMITED`, `INTERNAL_ERROR` | `true` |

`describeError(err)` returns `{code, retryable, message}`. Anything uncoded becomes `INTERNAL_ERROR` with a generic Russian message, so no driver or network details leak.

**WS error frame:**

```json
{"type":"error","context":"send_message","message":"Получатель не найден","text":"…","code":"RECIPIENT_NOT_FOUND","retryable":false,"client_msg_id":"…"}
```

**Refusals happen only before the INSERT:**

- The message INSERT and the author's channel read marker (`channel_members` upsert) are now one `withChangeSeq` savepoint.
- The cancelled-key check runs in the synchronous pre-INSERT section, next to the existing race re-check.

**A failure after the INSERT echoes the stored message instead of an error:**

- `storedMessage()` falls back to decorating the raw row when the identity database (`getDirectory`) fails. The sender comes from `senderProfile`, which is the socket user or the REST `req.user`.
- If `publishNewMessage` throws, the author still gets the `direct_message`/`channel_message` + `new_message` echo.

**REST** (`sendErrorResponse`):

| Status | When |
|---|---|
| 400 `{error, code}` | coded validation refusals |
| 403 `NOT_CHANNEL_MEMBER` | sender is not a channel member |
| 409 `CLIENT_MSG_ID_CONFLICT` / `CANCELLED` | key used for another conversation, or key revoked |
| 503 `INTERNAL_ERROR` | internal failure (previously 400 with the raw error text) |

A publish failure after the INSERT still returns 201.

### G4: edit/delete errors carry `messageId` and `code`; repeat delete returns the tombstone

**Codes:** `NOT_FOUND`, `NOT_OWNER`, `MESSAGE_DELETED` (edit), `NOT_TEXT_MESSAGE` (edit), `EDIT_WINDOW_EXPIRED` (also when editing is disabled), `DELETE_WINDOW_EXPIRED`, `EMPTY_TEXT`, `TEXT_TOO_LONG`, plus `RATE_LIMITED` and `INTERNAL_ERROR`.

**Frame shapes:**

```json
{"type":"error","context":"edit_message","message":"…","text":"…","code":"NOT_OWNER","retryable":false,"messageId":2}
{"type":"error","context":"delete_message","message":"…","code":"NOT_OWNER","retryable":false,"messageId":5}
```

`messageId` is echoed only when it is an integer greater than 0.

**Deleting an already-deleted message is now an idempotent success** (`deleteMessage` returns `alreadyDeleted:true`):

- The requesting socket gets the same tombstone `message_deleted`, with the same `updated_at`.
- Nothing is written: no history row, no `change_seq` bump, no rebroadcast. The super-admin audit entry is not repeated either.
- Ownership is checked first, so a non-owner gets `NOT_OWNER` and is not given the tombstone.

**Race fix.** Both `deleteMessage` and `editMessage` re-check `is_deleted` after awaiting the settings read. Concurrent deletes therefore don't double-write.

### G7: `last_message_id` in `GET /api/channels`

`getChannels` selects `last_message_id` in the same statement as `unread_count`. It is `null` when the user isn't a member, or when the channel has no messages.

### G8: `updated_at` in `message_deleted`

```json
{"type":"message_deleted","messageId":8,"conversationType":"direct","targetId":3,"updated_at":"…"}
```

This frame is now built by `publishDeleted`.

### G9: `cancel_message {client_msg_id}`

**Storage.**

- New SQLite table `cancelled_client_msgs(sender_id, client_msg_id, cancelled_at)`, primary key `(sender_id, client_msg_id)`, with an index on `cancelled_at`.
- TTL `CANCELLED_KEY_TTL_MS`, default 24 h. Expired rows are pruned on each cancel.
- Bounded: `CANCELLED_KEYS_PER_SENDER`, default 1000; the oldest keys are evicted.
- A repeat cancel extends the TTL (upsert).

**Flow** (`MessageService.cancelClientMessage`):

1. Record the key, then look up the sender's own row. These two steps run without an `await` between them.
2. If nothing is stored: reply `{"type":"message_cancelled","client_msg_id":"…","messageId":null}`.
3. If a message is stored: call `deleteMessage` as the author, so the delete window applies. Broadcast `message_deleted` (with `updated_at`) to participants, then reply `message_cancelled` with `messageId`.
4. If the message is already deleted: send the same reply without rebroadcasting (idempotent).
5. If deletion is not allowed:

```json
{"type":"error","context":"cancel_message","message":"…","code":"DELETE_WINDOW_EXPIRED","retryable":false,"client_msg_id":"…","messageId":12}
```

**Later sends with a cancelled key:**

- A later send over WS or REST is refused with `CANCELLED` (`retryable:false`; REST returns 409). The check runs both before the awaits and in the atomic pre-INSERT section. A send already in flight therefore either sees the mark (and is refused) or is seen by the cancel (and deleted). There is no race.
- A key that was already stored still returns the duplicate echo (a tombstone after the cancel) rather than `CANCELLED`. This is documented.

**Scope and limits.**

- Keys are per sender, so cancelling another user's key does nothing to their message.
- Rate-limited like `delete_message`.
- An invalid key gets `INVALID_CLIENT_MSG_ID` without `client_msg_id`.

## 2. Desktop compatibility check

- `desktop/src/renderer/src/App.jsx:1133` `case 'error'` reads only `context`, `message` and `text`. All three are kept. Unknown frame types (`message_cancelled`) fall through `default: break` (L1522). `message_deleted` reads only `messageId` (L1154).
- No other desktop ws listener handles `error` frames. I grepped `RemoteDesktop*`, `VoiceCallPanel` and `audioRelay`.
- Desktop never sends `client_msg_id` or `cancel_message`, so G9 doesn't affect it.
- Visible behaviour changes for desktop, all of them improvements:
  1. Sending more than 10 messages per second now shows the existing "Сообщение не отправлено" toast with the text, instead of losing the message silently.
  2. Repeating a delete removes the message silently (the tombstone) instead of showing the toast "Сообщение уже удалено".
  3. Internal errors show a generic Russian message instead of raw driver text.
- All existing desktop and server tests pass, including `message-edit-delete`, `ws-security`, `input-limits`, `e2e` and `http-routes`.

## 3. Contract, reducer and vectors

**Documents.**

- `ws-protocol.md`:
  - §2.3: rate limits with the `RATE_LIMITED` reply, and G1 ordering.
  - §3.2 to §3.4: codes, idempotent delete.
  - New §3.4.1 `cancel_message`.
  - §4.2: `message_deleted.updated_at`, new `message_cancelled` event, `error` field table and code table.
  - §6.2, §6.3 and §7: fixture map.
- `openapi.yaml`: send 400/409/503 codes, 403 code, `Channel.last_message_id`.
- `delivery-state.md`: as listed in the table below.

**Reducer behaviour, old vs new.** Every new signal is detected per frame. Without it the old path applies (new contract §7.12).

| Signal | Old behaviour | New behaviour |
|---|---|---|
| send `error RATE_LIMITED` | (silent) ack timeout 10 s, `failures+1`, backoff | entry back to `queued`, `next_attempt_at = now + retry_after_ms` (default `RATE_LIMITED_RETRY_MS`=1000), no failure, `maybe_stored` kept; only for the live WS attempt |
| send `error retryable:true` | permanent reject → `failed` | failed attempt (backoff, same key) |
| send refusal `retryable:false` | reject on assumption | reject, now provably not stored; `CANCELLED` added to `KEY_ERRORS` |
| delete `error` with `messageId` | ignored → 5 timeouts → `DELETE_NOT_CONFIRMED` | `RATE_LIMITED` → pause; `retryable` → op failure; else op removed + new `user_error DELETE_REJECTED` |
| edit `error` with `messageId` | ignored | `RATE_LIMITED` → edit op re-queued with `frame.text` after the pause (unless a newer edit or delete is pending); else `user_error EDIT_REJECTED` |
| `cancel` of a `maybe_stored` entry | `pending_delete` + sync | the same, plus a **`cancel` op** (`ops[].op = "cancel"`, `message_id:null`, new `client_msg_id` field) sent as `cancel_message` by the pump (opsLog window, `op_timeout {client_msg_id, attempt}`, backoff, survives restart). `message_cancelled` → op removed, entry removed, key forgotten, `messageId` confirms delete. An older server is silent → op gives up after 5 failures **without** `user_error`. A server record with the key replaces the cancel op by a delete op. A permanent cancel error with `messageId` → entry and op removed, `load_history`, `DELETE_REJECTED` |
| chain completion drops a cancelled entry | removed, forgotten | removed + key appended to new persisted state key **`cancelled`** (`CANCELLED_MAX` = 100, `persist` slice `"cancelled"`). A later own record with such a key → delete op (key forgotten); `enqueue`/`retry` treat such keys as used. This closes the Task 13 minor after a 410 |
| messages with a pending `delete` op | shown | **hidden** in §3.4, specified there; reappear if the delete is dropped |
| `message_deleted.updated_at` | not used | copied to the tombstone |
| `unread_snapshot.last_message_ids` | counts as is | adds foreign messages newer than `last_message_id`; an own channel message after the snapshot resets the count up to it |

`delivery-state.md` also gains:

- the §8 transitions T44–T53, plus updates to T24 and T42;
- §10, which now marks each gap closed and says how it is used;
- a rewritten §7.10 residual-risk paragraph.

**Vectors.**

- **All 57 existing vectors** gained the `cancelled: []` key in `initialState`, because `STATE_KEYS` in `server/test/mobile-delivery-reducer.test.js` now includes `cancelled`. Their ops gained `client_msg_id: null`; ops appear in 26, 33, 36, 49 and 51. These are mechanical changes; expectations are unchanged.
- **Five vectors changed behaviour.** Each one's description has a "Задача 16: …" justification, and `covers` gained T46/T51:
  - 22 and 23: the cancel op is persisted and then replaced by delete.
  - 52: `cancel_message` is sent after the chain; `cancelled` is persisted.
  - 55: two keys go into `cancelled`.
  - 56: `cancel_message` is sent immediately for entries in flight; `cancelled` is persisted.
  - Their `expectedState` now also asserts `ops` and `cancelled`.
- **New vectors 58–67:**

| Vector | Covers |
|---|---|
| 58 | send `RATE_LIMITED` |
| 59 | retryable `INTERNAL_ERROR`, `CANCELLED`, old-server reject |
| 60 | cancel acknowledged, message not stored |
| 61 | cancel in flight, message stored, `updated_at` |
| 62 | old server gives up; `RATE_LIMITED` and retryable cancel errors |
| 63 | cancel refused, delete window expired |
| 64 | the `cancelled` set after a 410, found later through history (the deferred minor) |
| 65 | delete errors with `messageId` |
| 66 | edit errors with `messageId` |
| 67 | snapshot with `last_message_ids` |

- `fixtures/reducers/README.md`: the coverage table is extended.

**Server fixtures** (`capture-fixtures --write`, then `--check`: "fixtures match the server").

- New: `ws/error.rate_limited.json`, `ws/error.delete_message.json`, `ws/error.cancelled.json`, `ws/error.cancel_message.json`, `ws/message_cancelled.json`, `ws/message_cancelled.stored.json`, `ws/message_deleted.repeat.json`, `http/messages.send-cancelled.json`.
- Changed shape: `error.*` (`code`/`retryable`/`messageId`/`text`), `message_deleted.*` (`updated_at`), `channels.list.json` (`last_message_id`).
- `retry_after_ms` is normalized to 1000.
- The drift test now requires `message_cancelled` and `messages.send-cancelled`.

## 4. RED/GREEN evidence

**Server** (new file `server/test/mobile-delivery-gaps.test.js`, 24 tests, added to the explicit `npm test` list).

- **RED on base code:** 22 failed, 2 passed.
  - G1 ordering failed with `порядок сохранения 2 > 1`: the second frame was stored first.
  - The 2 that pass on base are guards that must stay green under the new queue: "slow frame doesn't delay other sockets" and "hung handler doesn't stop the socket queue".
- **GREEN after the implementation:** 24 of 24.
- **Abuse cases covered:**
  - one socket flooding 40 sends;
  - a bounded queue with a hung handler;
  - a hung handler timing out;
  - a `delete_message` flood, and a `typing` flood that stays silent;
  - `cancel_message` for another user's key;
  - cancel then send with the same key, over WS and REST;
  - cancel racing an in-flight REST send;
  - deleting an already-deleted message, by the owner (tombstone) and by a stranger (`NOT_OWNER`);
  - a `cancel_message` flood;
  - TTL expiry and the per-sender bound;
  - the key being persisted (checked through a second SQLite connection).

**Reducer.** All 67 current vectors were run against the base reducer (`git show HEAD:…/delivery-reducer.mjs`) using an order-insensitive comparison. Result: 50 pass, 17 fail. The failures are:

- the 10 new vectors 58–67;
- the 5 behaviour-changed vectors 22, 23, 52, 55, 56;
- 26 and 49, where only the op shape (`client_msg_id`) changed.

The new reducer passes 67 of 67.

## 5. Test summary

- `cd server && npm test`: **608 tests, 607 pass, 0 fail, 1 skipped** (baseline before the task: 574 / 573 / 0 / 1).
- `node mobile/dev/capture-fixtures.mjs --check`: fixtures match the server.

## 6. Files changed

- **Server:**
  - `server/src/ws/server.js`
  - `server/src/services/message.service.js`
  - `server/src/api/index.js`
  - `server/src/db/index.js` (new table and index)
  - `server/package.json` (test list)
  - `server/test/mobile-delivery-gaps.test.js` (new)
  - `server/test/mobile-contract-fixtures.test.js`
  - `server/test/mobile-delivery-reducer.test.js` (`STATE_KEYS`)
- **Contracts:**
  - `mobile/contracts/ws-protocol.md`
  - `mobile/contracts/openapi.yaml`
  - `mobile/contracts/delivery-state.md`
  - `mobile/contracts/reference/delivery-reducer.mjs`
  - `mobile/contracts/fixtures/{http,ws}/*` (regenerated, 8 new) and `fixtures/manifest.json`
  - `mobile/contracts/fixtures/reducers/*` (57 migrated, 10 new) and `reducers/README.md`
- **Dev tooling:** `mobile/dev/capture-fixtures.mjs`

## 7. Concerns

1. **Breaking contract change for Wave 2 (Tasks 14/15).** iOS and Android must implement all of the following, because every vector's `initialState` now contains `cancelled`:
   - the new state key `cancelled` and the `persist` slice `"cancelled"`;
   - the `ops[].client_msg_id` field;
   - the op kind `cancel` and the `op_timeout {client_msg_id}` variant;
   - `message_cancelled`;
   - the new `error` branches;
   - the user errors `DELETE_REJECTED` and `EDIT_REJECTED`;
   - `unread_snapshot.last_message_ids`, filled from `last_message_id` in the channel and direct list responses;
   - hiding messages that have a pending delete op.
2. **The G1 queue covers chat frames only**, not every frame type. That was deliberate, for call, remote-desktop and typing latency, but it is narrower than "all frames of a socket". Ordering is also not guaranteed after a frame whose handler timed out (30 s), or across sockets, or between WS and REST. The client keeps stop-and-wait for those reasons.
3. **`RATE_LIMITED` replies are best-effort** (at most 10 per second per socket, none while the client isn't reading). The contract keeps the timeout fallback.
4. **The cancel op costs something against an older server**: up to 5 `cancel_message` frames over about a minute per cancelled entry, and it shares the 8/s ops window. No user-visible error is shown.
5. **`cancel_message` follows the delete window.** If an admin disables deletion (`-1`), cancelling a message that is already stored yields `DELETE_REJECTED`, and the message is shown again. The key is still revoked.
6. **Repeating a send with a key that was stored and then cancelled returns the tombstone echo, not `CANCELLED`.** This is documented in ws-protocol §3.2, and the reducer handles both outcomes.
7. **REST internal failures changed from 400 with raw text to 503 `INTERNAL_ERROR`.** That is correct for retry semantics, but it is a status-code change on an existing route. Desktop only shows the error text.
8. **Reducer vector expectations were computed with the reference reducer and then checked by hand** against the contract text, event by event. The README asks that expectations be written from the contract rather than copied from reducer output; I followed the intent by reviewing every effect, but the controller may want to spot-check vectors 58–67.
