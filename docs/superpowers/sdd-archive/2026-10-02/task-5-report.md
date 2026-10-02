# Task 5 report: reliable mobile delivery on the server (S1–S3)

Status: **DONE**. Worktree `m-integration`, branch `mobile/integration`, based on d90418b. Not pushed.

## Commits

| SHA | Message |
|---|---|
| 607e13a | feat(server): migrate messages for client_msg_id and change sequence |
| 8c3f9ec | feat(server): idempotent send, delta sync and delivered-on-reconnect |
| 246a83e | test(contracts): capture reliable-delivery fixtures and fix timestamp regex |
| 247a238 | docs(contracts): document client_msg_id, /sync cursor and reconnect algorithm |

## 1. Schema migration (`server/src/db/index.js`)

- `messages` gets two new nullable columns: `client_msg_id TEXT` and `change_seq INTEGER`. They are in the `TABLES` DDL for fresh installs, and `migrateMessages()` runs `ALTER TABLE ... ADD COLUMN` on existing databases. It runs in `initSchema` on every open and does nothing if the columns already exist.
- Indexes:
  - `idx_messages_client_msg`: `UNIQUE (sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL`. This is a partial index scoped per sender.
  - `idx_messages_change_seq`: `UNIQUE (change_seq)`.
  - Both are created after the migration. `finalizeIdentitySplit` re-runs `INDEXES` after it rebuilds the table, so the legacy upgrade path keeps them. The migration test exercises exactly that path.
- Backfill: rows with `change_seq IS NULL` get `id + max(change_seq)`, where the max is read in JS first. On a first migration that gives `change_seq = id`. If a backup made with old code is restored, or rows are inserted outside the service, those rows get numbers above every number already issued, so the sync cursor still sees them.
- **Deviation from the controller's note on `updated_at`.** I did not backfill `updated_at` on purpose. The desktop client renders "Изменено" whenever `m.updated_at` is non-null (`desktop/src/renderer/src/components/ChatView.jsx:622`), so a backfill would mark every historical message as edited. That breaks backward compatibility.
  - The ordering field that needed a sensible backfill is `change_seq`, and that one is backfilled.
  - `updated_at` keeps its old meaning: null until the first edit or delete. Edit and delete still maintain it, plus they now bump `change_seq`.

## 2. API and contract changes (exact shapes)

### Message shape (every form: REST responses, history pages, `/sync`, WS frames)

- Additive key `client_msg_id`: either a `string` or `null`. It sits right after `is_deleted`.
- `change_seq` is removed in `attachSenders` and is never serialized.

### S1: idempotent send

- **Input.**
  - WS: `send_message` / `direct_message` / `channel_message` take `client_msg_id` at the top level of the frame.
  - REST: `POST /api/messages/direct/{id}` and `POST /api/messages/channels/{id}` take `client_msg_id` in the body.
  - The name is snake_case in both transports.
- **Validation.** The value must be a string matching `^[A-Za-z0-9_-]{1,64}$`. `undefined` or `null` means the field is absent, which is the desktop behaviour.
- **Duplicate lookup.** It runs before the other checks, and only among the sender's own rows.
  - Same sender, same conversation:
    - nothing is written;
    - REST returns **200** with the saved record (same `id`, current state, which is a tombstone if the message was deleted);
    - WS echoes `direct_message`|`channel_message` + `new_message` **only to the sender's sockets**;
    - recipients get no second frame and no second "delivered".
  - Same sender, different conversation: `CLIENT_MSG_ID_CONFLICT`. REST returns 409 `{error, code}`; WS returns an `error` frame with `code` and an echoed `client_msg_id`. Nothing is written.
  - Invalid key: `INVALID_CLIENT_MSG_ID`. REST returns 400 `{error, code}`; WS returns an `error` frame with `code` and no `client_msg_id` echo.
- **WS `error` for `send_message`.** It now carries `client_msg_id` whenever the supplied key was valid, so the client can map the error to its outbox. `code` appears only for the two key errors; every other error frame is unchanged.
- **Race safety.** The second lookup runs synchronously right before the INSERT with no `await` in between. On top of that, a UNIQUE violation is caught and turned into a duplicate response.
- **Implementation.** `MessageService.sendMessageIdempotent()` returns `{message, duplicate}`. `sendMessage()` keeps its old return value for every other caller. One broadcast path, `wsServer.publishNewMessage(message, {duplicate})`, serves both WS and REST.

### S2: forward paging and delta sync

- **`afterId`.** Added to `GET /api/messages?conversationType&targetId&afterId&limit` and also to `/messages/direct/{id}` and `/messages/channels/{id}`.
  - Returns the first `limit` messages with `id > afterId`, ascending. The limit is capped at 200, as before.
  - Validated as `^\d{1,15}$`; anything else is 400. It can be combined with `beforeId`.
  - Channel membership is still enforced (403).
- **`GET /api/sync?since=<cursor>&limit=<n>`** returns `{ "messages": Message[], "next_cursor": "<digits>", "has_more": bool }`.
  - **Rows.** Each row is the message shape plus `delivery_status` on every row: `delivered`|`read`|null for direct messages, always null for channel messages. Rows are ordered by `change_seq` ascending, and each message appears at most once, in its current state.
  - **What counts as a change:** create, edit, delete (as a tombstone: `is_deleted=1`, `text=""`, `metadata_json=null`, `file_original_name=null`) and a delivery/read status change on a direct message.
  - **Cursor semantics.** The cursor is the global monotonic `change_seq`.
    - Every change gets `(SELECT COALESCE(MAX(change_seq),0)+1 FROM messages)` inside the same statement. node:sqlite is synchronous, and the unique index backs this up.
    - The cursor is independent of timestamps, so changes with equal timestamps page correctly. A test rewrites all `created_at`/`updated_at` to one value and pages with `limit=3` without gaps or duplicates.
    - The query fetches `limit+1` rows:
      - `has_more=true` means `next_cursor` is the last row's seq;
      - otherwise `next_cursor = max(since, head)`.
    - The head is read synchronously in the same tick as the page query, so it never skips anything.
    - The cursor is opaque to clients (a string), and realtime frames do not advance it.
  - **No `since`:** returns `{messages: [], next_cursor: head, has_more: false}` as the bootstrap point. `since=0` replays the full visible history, page by page.
  - **Errors.**
    - Invalid `since` (non-digits, empty, more than 15 digits) or invalid `limit` (not an integer, or less than 1): 400.
    - `limit > 200` is silently capped.
    - `since > head`: **410** `{error, code: "SYNC_CURSOR_INVALID"}`. That means the database was restored from a backup, so the client must re-bootstrap.
    - More than 60 requests per minute per user: 429 with `Retry-After: 60`, through the existing `checkRateLimit`, the same pattern as `/messages/search`.
- **Out of sync scope (documented):**
  - hard-deleted channels (refresh `GET /channels`);
  - channel read state;
  - history of a channel the user joined after the cursor (load that through `/messages/channels/{id}`).

### S3: delivered after reconnect

- **On every successful WS `auth`.** `MessageService.markPendingDelivered(userId)` takes the user's last 1000 incoming direct messages and selects those that:
  - were not sent by the user;
  - are not deleted;
  - have **neither** a `delivered` nor a `read` status. Read messages are never downgraded, because `delivery_status` picks the latest timestamp.

  It inserts a `delivered` status for each, bumps their `change_seq`, and then sends each sender who is online one `message_status_updated {messageId, status:"delivered", userId, timestamp}` per message. That is the existing shape, which the desktop already handles. A second login produces nothing new.
- **REST direct send.** It now marks delivered and notifies the sender when the recipient is online, through the same `markDeliveredIfOnline` as WS.
- **Offline senders.** Status changes bump `change_seq`, so a sender who was offline sees `delivery_status` in their next `/sync`.

### Contract files

- **`openapi.yaml`:**
  - `client_msg_id` on `SendMessageRequest` and on `Message`;
  - 200, 400 (with code) and 409 on both send endpoints;
  - `afterId` on all three GETs;
  - the new `/sync` path with a `SyncResponse` schema, cursor semantics, bootstrap, paging, out-of-scope items, and the 400/401/410/429 responses;
  - a note on `delivery_status`.
  - It also fixes **two pre-existing YAML errors** from Task 4: unquoted `description:` scalars containing `": "` at the old line 1537 and in `SendMessageRequest.metadata`. The file now parses with PyYAML; it did not parse at HEAD before this task.
- **`ws-protocol.md`:**
  - §3.2: idempotency rules;
  - §4.2: the `client_msg_id` echo and how to match it; the examples are updated to match the fixtures;
  - `message_status_updated` now covers the REST path and reconnect;
  - `message_deleted`: the sentence that `targetId` is the stored `target_id`, so clients match by `messageId`;
  - `error` codes;
  - §6.2: sequence diagram including the replay;
  - §6.3: the "Курсор синхронизации" and "Алгоритм переподключения клиента" sections (on reconnect, sync with the stored cursor, apply upserts and tombstones, drop outbox entries already confirmed, replay the outbox with the same `client_msg_id`, refresh `/channels`, plus 410/429/401 handling and outbox error semantics);
  - §7: fixture table.
- **`parity-matrix.md`:** D1/D4 notes and the checklist are updated.
- **`fixtures/README.md`:** decoder rules for `client_msg_id` and `next_cursor`, the scenario list, and a corrected capture-time note with measured values (CLI 15–20 s, 16 s measured; drift test 7–10 s).

### Deferred Task 4 items (all done)

- **Regex fix.** `mobile/dev/capture-fixtures.mjs:86` now uses `/\.\d+/` in both places. The regenerated fixtures did not change from this, because every captured ISO timestamp already carried milliseconds.
- **`message_deleted.targetId` sentence:** added to `ws-protocol.md`.
- **README capture-time note:** fixed.
- **Fixtures regenerated with `--write` and the scenario extended.** There are now 77 fixtures, up from 66. The 11 new ones:
  - `http/messages.send-direct-idempotent` (201) and `http/messages.send-direct-duplicate` (200);
  - `http/messages.send-client-msg-id-invalid` (400) and `http/messages.send-client-msg-id-conflict` (409);
  - `http/messages.after-page`;
  - `http/sync.bootstrap`, `http/sync.page` (with an edit, tombstones, status changes, a channel row and an idempotent row) and `http/sync.cursor-invalid` (410);
  - `ws/error.invalid_client_msg_id` and `ws/error.client_msg_id_conflict`;
  - `ws/message_status_updated.reconnect`.

  The existing message fixtures gained `client_msg_id`. The main WS direct send now carries a key, so `direct_message`/`new_message.direct`/`message_updated` hold a string, while the channel ones hold null. `REQUIRED_HTTP` in the drift test lists the 8 new HTTP fixtures, and `--check` reports "fixtures match the server".

## 3. Security decisions

- **Key validation.** `client_msg_id` must be a string with a strict charset and a maximum of 64 characters. Numbers, objects, arrays, booleans, the empty string, Cyrillic, spaces, `../`, `;` and 65 characters are all rejected, and tests cover all of them. An invalid value is never reflected back.
- **Scoping.** Idempotency is per sender at both the index and the lookup level (`WHERE sender_id = ? AND client_msg_id = ?`). Guessing another user's key creates your own new message and never returns theirs. A test checks that the response contains none of the other user's text.
- **Conflict response.** A conflict does not return the other conversation's record; only the error is sent.
- **Duplicates.** A duplicate is acknowledged only to the sender's own sockets. That prevents a replay amplifying notifications to recipients; the desktop would otherwise toast twice.
- **Visibility in `/sync`.** `/sync` reuses the visibility rule. I extracted it into `VISIBLE_TO_USER_SQL` and `searchMessages` now uses it too, with no behaviour change:
  - channel messages only where the user is in `channel_members`, matching `assertChannelMember` in history;
  - direct messages only where the user is sender or target.

  Tests cover a foreign direct conversation and a private channel without membership.
- **Tombstones.** Deleted messages come back as tombstones; text and metadata were already nulled in the row itself.
- **Limits.** `/sync` is capped at 200 rows per page and rate-limited to 60/min per user with 429 and `Retry-After`. Its parameters are validated strictly instead of being coerced.
- **Pending-delivery scan.** It is bounded to the last 1000 incoming messages, so a reconnect storm after a server restart cannot trigger full-history scans.
- **`change_seq` stays internal.** It is not exposed; only the opaque `next_cursor` is.

## 4. RED / GREEN evidence

- **RED, migration** (db change set aside with `git checkout`, then reapplied):
  ```
  ✖ новые колонки добавлены, change_seq старых строк заполнен по id, updated_at не тронут
  ✖ индексы идемпотентности и курсора на месте и уникальны (после перестроения таблицы тоже)
  ✖ новая отправка получает следующий номер изменения; повторное открытие базы ничего не ломает
  ✖ строки без change_seq (...) получают номера ВЫШЕ текущего максимума
  ℹ pass 0  ℹ fail 4
  ```
- **RED, S1–S3** (migration present, service, WS and API not yet changed): `ℹ tests 19 ℹ pass 1 ℹ fail 18`. All S1, S2 and S3 tests failed, including the authorization and abuse cases. The one pass was `S3: прочитанное не откатывается…`, a negative guard that holds vacuously before the feature exists.
- **GREEN, first run:** 21 of 23. The 2 failures were bugs in my tests, not the server: a wrong `targetId` in the `afterId` from-zero check, and a `connect()` helper that leaked the previous socket so the user stayed online. After fixing the tests: **23 of 23 pass**.

New tests (`server/test/mobile-delivery.test.js`, 19; `server/test/mobile-delivery-migration.test.js`, 4):

- **S1:**
  - WS duplicate direct gives one row, the same id in the echo, and nothing new for the recipient;
  - WS duplicate in a channel;
  - REST direct 201 then 200;
  - REST channel 201 then 200;
  - the same key from different senders gives distinct messages and no leak;
  - invalid keys get 400 or a WS error code, and exactly 64 characters is allowed;
  - a cross-conversation conflict gets 409 (REST, both endpoints) or a WS code;
  - without a key the behaviour is as before, including the exact desktop WS frame and `change_seq` not exposed;
  - a retry after delete returns the tombstone.
- **S2:**
  - `afterId` paging, from zero, and its validation, including a non-member channel getting 403;
  - sync bootstrap, then new + edit + delete, each once in its latest state;
  - paging with equal timestamps;
  - another user's direct conversation and a non-member private channel are excluded;
  - `since`/`limit` validation, 401, `limit` capping and 410;
  - a read status change brings the message back with `delivery_status: read`;
  - the 429 rate limit with `Retry-After: 60`.
- **S3:**
  - delivered on reconnect for WS and REST messages sent while offline, with no repeat on re-login;
  - read is not downgraded and deleted is skipped;
  - REST send while online marks delivered, and while offline it does not.

## 5. Full test summary

- Baseline before the change (`cd server && npm test`): tests 487, pass 486, fail 0, skipped 1.
- After the change: **tests 510, pass 509, fail 0, skipped 1** (duration about 265 s). That includes the desktop-related server tests and the fixture drift test against the regenerated fixtures.
- `node mobile/dev/capture-fixtures.mjs --check` reports "fixtures match the server".

## 6. Files changed

- `server/src/db/index.js`: columns, indexes, `migrateMessages`.
- `server/src/services/message.service.js`:
  - `sendMessageIdempotent`, `findClientDuplicate` and `normalizeClientMsgId`;
  - `touchMessages`, `markPendingDelivered`, `syncHead` and `syncSince`;
  - `afterId` in `getMessages`;
  - `change_seq` bumps on edit, delete, delivered and read;
  - the `VISIBLE_TO_USER_SQL` constant, with `change_seq` stripped in `attachSenders`.
- `server/src/ws/server.js`: `client_msg_id` on send, error `code`/`client_msg_id`, `publishNewMessage`, `markDeliveredIfOnline`, and `announcePendingDeliveries` on auth.
- `server/src/api/index.js`: `afterId` on three GETs, `sendViaRest` (201/200/400/409), and `GET /sync` (rate limit, validation, 410).
- `server/test/mobile-delivery.test.js` (new) and `server/test/mobile-delivery-migration.test.js` (new).
- `server/package.json`: both new test files added to the explicit `test` list.
- `server/test/mobile-contract-fixtures.test.js`: `REQUIRED_HTTP` extended.
- `mobile/dev/capture-fixtures.mjs`: regex fix and new scenario steps.
- `mobile/contracts/fixtures/**`: 9 modified, 11 new, plus `manifest.json` and `README.md`.
- `mobile/contracts/openapi.yaml`, `mobile/contracts/ws-protocol.md`, `mobile/contracts/parity-matrix.md`.

## 7. Concerns

1. **`updated_at` backfill skipped on purpose** (see §1). If the controller really wants it, the desktop "Изменено" logic would have to change first, and that is outside the integration scope.
2. **Global cursor side channel.** `next_cursor` is global, so the gap between two cursors reveals the server-wide change volume. That is the same class of information autoincrement message ids already leak. I judged it acceptable.
3. **`/sync` scan cost.** The query walks `change_seq` from the cursor and filters by visibility. For a user with a stale cursor on a busy server, a page can scan many invisible rows; `since=0` on a large database is a full scan. It is bounded by the page size and the 60/min limit, but there is no per-user change index. Revisit if the database grows large.
4. **Pending-delivery window.** Only the last 1000 incoming messages are considered. Older undelivered messages, for example pre-upgrade history, stay without status. That matches the previous behaviour (it was null before), and the window is documented in ws-protocol.
5. **One frame per message on reconnect.** `message_status_updated` is sent per message, which can be up to 1000 frames to online senders in the worst case. I kept the existing shape for desktop compatibility rather than adding a batch event.
6. **Out-of-band inserts.** Rows inserted outside `MessageService`, such as through the admin DB studio's raw SQL, get `change_seq = NULL` and stay invisible to `/sync` until the next database open, when the migration assigns them numbers. Hard channel deletion is not represented in sync; this is documented.
7. **Rate-limited WS sends are dropped silently** (existing behaviour, 10/s per socket). The documented outbox algorithm therefore requires a timeout-and-retry with the same key. Wave 2 clients must implement that.
8. **Line endings.** Git warns that fixtures will be converted LF to CRLF. That predates this task (repo autocrlf); content and shape checks are unaffected.

---

# Fix round 1: monotonic sync counter and epoch-scoped cursor

**Finding:** `NEXT_CHANGE_SEQ_SQL = MAX(change_seq)+1` over live rows. A hard delete of the rows holding the highest numbers (`DELETE /admin/channels/:id`, DB studio) moved the head backwards and re-issued numbers clients already held, so those changes were silently missing from `/sync`.

## Commits
| SHA | Message |
|---|---|
| 546ec81 | fix(server): monotonic sync counter and epoch-scoped cursor |
| 37ee893 | docs(contracts): epoch-scoped sync cursor, restore behaviour, fixtures |

## Changes

1. **Counter independent of live rows.** A new single-row table holds the counter: `sync_state(id INTEGER PRIMARY KEY CHECK (id = 1), last_seq INTEGER NOT NULL, epoch TEXT NOT NULL)`. It is in `TABLES`, so fresh installs get the same DDL.
   - `withChangeSeq(db, write)` opens `SAVEPOINT change_seq` and runs `UPDATE sync_state SET last_seq = last_seq + 1 WHERE id = 1 RETURNING last_seq`. The write then runs inside the same savepoint with that number, and the savepoint is released.
   - If the write fails, `ROLLBACK TO` undoes the bump, so no number is spent on a failed write.
   - Every writer goes through it: INSERT on send, edit, delete, and `touchMessages` (delivered and read).
   - `NEXT_CHANGE_SEQ_SQL` is removed.
2. **Idempotent migration.**
   - On first open, `INSERT OR IGNORE` seeds the row with `last_seq = MAX(change_seq)` and a random 16-hex `epoch`.
   - Every open raises the counter to at least `MAX(change_seq)`.
   - The NULL-row backfill now uses `id + last_seq` and then raises the counter again.
   - Reopening keeps the same epoch and `last_seq`, and there is only ever one row. A test checks this.
3. **Head and the 410 check read the counter.** `syncHead()`, `syncHeadCursor()` and `parseSyncCursor()` all read `sync_state`.
4. **Epoch in the cursor.**
   - The cursor is now `<epoch>.<seq>`, for example `5e7a1c0d9b3f4a62.23`.
   - The `since` request parameter must match `^[A-Za-z0-9._-]{1,64}$`; anything else gets 400.
   - A cursor that does match is rejected with 410 `SYNC_CURSOR_INVALID` when any of these holds:
     - it does not have the `^[0-9a-f]{16}\.\d{1,15}$` form (old all-digit cursors, garbage);
     - its epoch is not this database's;
     - its seq is ahead of the head.
5. **Survives backup restore.** The app has no restore code path; a restore is a manual file replacement. So the epoch is rotated **in the backup copy** right after `VACUUM INTO`, in both `BackupService.createBackup` and `DbStudioService.backupDatabase` (`rotateSyncEpoch(file)`).
   - A database restored from any server-made backup has an epoch no client has ever seen, so every outstanding cursor gets 410 and the client does a full resync.
   - The live database's epoch never changes.
6. **Contracts.**
   - `openapi.yaml`: the `since` and `next_cursor` patterns are relaxed to the opaque `^[A-Za-z0-9._-]{1,64}$`; the example is `5e7a1c0d9b3f4a62.23`; the docs now describe the monotonic counter, the epoch and backups, and when to return 400 versus 410.
   - `ws-protocol.md`: a new "Эпоха и восстановление из резервной копии" paragraph; the reconnect algorithm step 4 now says 410 means a full resync and that the outbox is replayed after it with the same keys.
   - `fixtures/README.md`: a normalization row for the epoch.
   - `capture-fixtures.mjs`: normalizes the random epoch to `5e7a1c0d9b3f4a62` (two consecutive `--write` runs give identical output). `sync.cursor-invalid` is now captured with a cursor from another epoch.
   - Fixtures regenerated: only values changed (`next_cursor`, manifest descriptions); shapes did not.

## Tests (RED, then GREEN)

New and updated tests:
- **`mobile-delivery.test.js`:**
  - **Regression:** K=4 posts in a channel, then `/sync` for the cursor, then `DELETE /api/admin/channels/:id` as admin, then K+1 direct messages, then `/sync?since=<old cursor>` must contain all of them.
  - The cursor test now covers:
    - 400 for `''`, `'a b'`, `'<x>'` and 65 characters;
    - 410 for `123`, `abc`, `1.5`, another epoch (with the current seq and with seq 0), the current epoch with seq ahead of the head, and `<epoch>.x`.
- **`mobile-delivery-migration.test.js`:**
  - the `sync_state` row exists, `last_seq = MAX(change_seq)`, and the epoch is stable across reopens;
  - after a hard delete of the top row, the next number is still greater than the deleted one;
  - backup copies from both `BackupService` and `DbStudioService` carry a different epoch, while the live epoch is untouched.

RED (before the fix): 27 tests, 21 pass, 6 fail. The regression failed with the exact bug:
```
✖ S2 sync: удаление канала с самыми свежими изменениями не откатывает курсор — ничего не теряется
  AssertionError: сообщение 34 после удаления канала потеряно синхронизацией
✖ счётчик изменений: sync_state заведён … ✖ физическое удаление строк … ✖ резервная копия базы получает новую эпоху …
✖ S2 sync: без since … (cursor format) ✖ S2 sync: проверка курсора … 410
```
GREEN: `node --test test/mobile-delivery-migration.test.js test/mobile-delivery.test.js` gives 27 tests, 27 pass, 0 fail.

## Commands and output
- `cd server && npm test`: **tests 514, pass 513, fail 0, skipped 1** (about 345 s).
- `node mobile/dev/capture-fixtures.mjs --write` (run twice, identical output), then `--check`: **fixtures match the server**.
- `python -c "yaml.safe_load(openapi.yaml)"`: parses.

## Residual notes
- A restore from a raw file copy made **outside** the server (OS-level copy of `mychat.db`) keeps the live epoch.
  - It is still caught when a client's cursor is ahead of the restored head.
  - It is not caught if new writes push the head past the cursor before the client reconnects.
  - The way to close this: restore only from server-made backups, or rotate the epoch on purpose with `rotateSyncEpoch`. A one-line runbook note is worth adding to the admin docs.
- Hard-deleting messages that other rows reference through `reply_to_id` (`ON DELETE SET NULL`) changes those rows without bumping their seq, so clients keep a stale `reply_to_id` until the row's next change. This existed before the fix and the impact is cosmetic.
