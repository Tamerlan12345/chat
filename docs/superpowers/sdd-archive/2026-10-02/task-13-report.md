# Task 13 report: delivery-state contract, reference reducer, shared vectors

**Status:** DONE (with non-blocking concerns, listed below)
**Worktree / branch:** `m-integration` / `mobile/integration`, starting from e3907ad, not pushed.

## Commits

| SHA | Message |
|---|---|
| 78d6719 | docs(contracts): binding client delivery-state contract |
| 519f609 | test(contracts): shared delivery reducer vectors and runner (RED) |
| c58a466 | feat(contracts): reference delivery reducer (GREEN, plus vectors 45-47) |
| f504886 | docs(contracts): point protocol docs at delivery-state |

## State and event model (summary of `mobile/contracts/delivery-state.md`)

**Reducer.** `reduce(state, event) -> { state, effects }`. It is pure: there is no clock, randomness or I/O, and the input state is never mutated (the test deep-freezes it). Each event carries `now` (integer ms). The platform generates `client_msg_id` values and passes them in events.

**State** is plain JSON with these fields:
- `me`
- `connection` (`offline`/`online`)
- `visible` (conversation key)
- `sync { cursor, running, bootstrap }`
- `seq`
- `outbox[]`, ordered by seq
- `ops[]`: pending `edit_message`/`delete_message` frames
- `messages { "direct:3" | "channel:3": [projection sorted by id] }`
- `unread { key: n>0 }`
- `sendLog[]`: throttle window
- `wake_at`: dedupes tick timers

An outbox entry has 16 fixed fields: `client_msg_id`, `conversation`, `seq`, `text`, `msgType`, `reply_to_id`, `metadata`, `state` (`queued`/`sending`/`failed`), `attempts`, `maybe_stored`, `transport`, `ack_deadline`, `next_attempt_at`, `failure {reason, code, message}`, `pending_edit`, `pending_delete`.

A message projection has 11 fields; `status` is `sent`/`delivered`/`read` for own messages and `null` for others.

**Displayed states.** `queued`, `sending` and `failed` come from the outbox entry. `sent`, `delivered` and `read` come from the server message.

**Events.**
- Server events, all in fixture shapes:
  - `ws {frame}`, where frame is `auth_success`, any new-message frame, `message_updated`, `message_deleted`, `message_status_updated`, `messages_read` or `error`. Other frame types are ignored.
  - `sync_page {body}`, `sync_reset_410 {body}`, `sync_failed {status, retry_after_ms?}`
  - `history_page {body}`, `http_send_result {client_msg_id, attempt, status, body}`, `unread_snapshot {counts}`
- Local events: `ws_disconnected`, `enqueue`, `edit` (by `client_msg_id` or `message_id`), `delete`, `cancel`, `retry {new_client_msg_id}`, `ack_timeout {client_msg_id, attempt}`, `tick`, `sync_start`, `background_flush`, `conversation_opened`/`conversation_closed`, `app_restart`.

**Effects.**
- `persist {slices ⊆ [cursor, ops, outbox]}` is always first and acts as a barrier: if the write fails, the platform discards the new state and does not run the remaining effects.
- `clear_composer`
- `send_ws {frame}`, used for `send_message`, `edit_message`, `delete_message` and `mark_read`
- `send_http`
- `schedule {at, event}`. Platforms never cancel timers; stale ones are ignored by attempt/deadline checks.
- `sync_request {cursor, limit: 200}`, `refresh_conversation_lists`, `load_history`, `user_error {code}`

**Pump.** It runs after every event, only when online and not syncing:
- It drains `ops`.
- It sends at most one entry per conversation (stop-and-wait): the head must be `queued`, past its backoff, and its conversation must have no `sending` entry.
- It applies a global throttle of 8 WS sends per 1000 ms, then schedules a `tick`.

**Constants.**
- ACK timeout: 10 s over WS, 30 s over HTTP.
- `MAX_ATTEMPTS` = 5.
- Backoff: 1/2/4/8 s, capped at 30 s.
- `client_msg_id` must match `^[A-Za-z0-9_-]{1,64}$` (UUIDv4, lowercase, no braces).
- Text limit: 16000 UTF-16 code units.

**Decisions to review (the brief left these open).**
1. **No separate `send_attempt` event.** The reducer records the attempt (queued to sending, `attempts+1`, `maybe_stored=true`) in the same step that emits `send_ws`. The "echo before the send attempt is recorded" edge case is modelled as an echo that confirms an entry in any state: `queued` during backoff before the next attempt (vector 09), or `failed` (vectors 40, 41).
2. **`maybe_stored` decides edit/delete/cancel of unconfirmed messages.**
   - If false, the change is made locally.
   - If true, the change goes into `pending_edit`/`pending_delete`. The entry is resolved with the same key, then an `edit_message`/`delete_message` op is sent using the server id.
3. **Failed entries stay in the outbox**, so they survive restarts and can be retried. `retry` keeps the same key unless `failure.code` is `CLIENT_MSG_ID_CONFLICT` or `INVALID_CLIENT_MSG_ID`. `ws-protocol.md` previously said "remove from outbox; new key on user retry"; I aligned that text.
4. **Unread counters change only from live frames.** They increase only for a first-seen, non-deleted, foreign message in a conversation that is not visible. Own messages never count, and an own message in a channel resets that channel to 0, matching the server's `last_read_message_id`. Sync and history never touch counters; after each sync the reducer requests the lists, and `unread_snapshot` replaces the counters.
5. **Merge is monotonic.** A tombstone is final. Content is applied only if `updated_at` is not older than the local copy. Status only goes up (`sent < delivered < read`). `message_status_updated` and `messages_read` apply only to own direct messages; `messages_read` is limited to the `direct:<byUserId>` conversation.
6. **`app_restart` keeps only the durable slices**: `me`, cursor, `seq`, outbox, ops. Entries in `sending` go back to `queued` with `attempts` kept. The message cache and counters are refilled by `history_page`/`unread_snapshot`.

## Transition table (`delivery-state.md` §8)

| ID | Trigger, then result |
|---|---|
| T01 | `enqueue` with valid input creates a `queued` entry; effects: persist, then `clear_composer` |
| T02 | Invalid `enqueue`/`edit`/`retry` input gives `user_error` with no state change |
| T03 | `enqueue` with a known `client_msg_id` is a no-op |
| T04 | Pump: an eligible `queued` head becomes `sending` (ws) with `send_ws` and an `ack_timeout` schedule |
| T05 | Throttle reached (8/s): the entry waits and one `tick` is scheduled |
| T06 | Stop-and-wait: a non-head entry, or one in a conversation with something `sending`, waits |
| T07 | Echo or server record with a matching `client_msg_id` confirms a `sending` entry as `sent` |
| T08 | The same confirmation from `queued` or `failed` |
| T09 | A duplicate frame for a known id has no effect and does not count as unread |
| T10 | `message_status_updated` moves `sent` to `delivered` |
| T11 | `messages_read` moves `sent`/`delivered` to `read` |
| T12 | A lower status is never applied; own channel messages stay `sent` |
| T13 | Current `ack_timeout` with `attempts < 5`: back to `queued` with backoff and a `tick` |
| T14 | Current `ack_timeout` with `attempts ≥ 5`: `failed` (`max_attempts`) |
| T15 | Stale `ack_timeout` or HTTP result (other attempt, entry gone, early) is ignored |
| T16 | WS `error` for `send_message` with `client_msg_id`: `failed` (`rejected`), or removed if `pending_delete` |
| T17 | HTTP 200/201 confirms the entry as `sent` |
| T18 | HTTP 409 or another permanent 4xx: `failed` (`rejected`) |
| T19 | HTTP 0/408/429/5xx is treated like a timeout; 401 returns to `queued` without backoff |
| T20 | `ws_disconnected`: WS `sending` entries return to `queued`; HTTP sends are untouched |
| T21 | `auth_success` starts sync; when sync finishes, the outbox is replayed in seq order |
| T22 | `app_restart`: `sending` entries return to `queued`; transient state is cleared |
| T23 | `retry`: `failed` returns to `queued` at the tail, with the same key or a new one after a key error |
| T24 | `cancel`: removes the entry if `!maybe_stored`, otherwise sets `pending_delete` |
| T25 | `edit` of an outbox entry: in place if `!maybe_stored`, otherwise `pending_edit` |
| T26 | `edit`/`delete` of a confirmed message, or `pending_*` after confirmation, becomes an op sent as `send_ws` |
| T27 | Live incoming message: unread +1, or `mark_read` if the conversation is open |
| T28 | Live own message: no unread change; in a channel the counter resets |
| T29 | `conversation_opened` sets unread to 0 and sends `mark_read`; `conversation_closed` clears `visible` |
| T30 | `unread_snapshot` replaces the counters (the visible conversation gets 0 and `mark_read`) |
| T31 | `message_updated` is applied if newer and not a tombstone |
| T32 | `message_deleted` creates a tombstone, looked up by `messageId` only |
| T33 | `sync_page`: upsert, cursor saved after the page, `has_more` triggers the next request |
| T34 | `sync_reset_410`: cursor and cache reset, outbox/ops/unread kept, bootstrap sync, `load_history` on completion |
| T35 | `sync_failed` schedules `sync_start` (except on 401); `sync_start` restarts sync |
| T36 | `history_page` upserts and does not change unread |
| T37 | `background_flush` while offline sends the heads via `send_http` |
| T38 | Unrelated frames, foreign errors and late pages are ignored |

## Vector inventory (47 files in `mobile/contracts/fixtures/reducers/`)

| Vector | Events | Covers |
|---|---|---|
| 01-enqueue-send-echo | 3 | T01, T04, T07, T09 |
| 02-enqueue-offline-stays-queued | 2 | T01 |
| 03-enqueue-validation | 8 | T02, T01 |
| 04-enqueue-duplicate-noop | 3 | T03 |
| 05-offline-send-restart-replay-once | 9 | T01, T22, T21, T04, T07, T09, T20, T33 |
| 06-sync-confirms-outbox-before-replay | 2 | T21, T33, T08 |
| 07-double-frame-dedupe-incoming | 3 | T09, T27 |
| 08-own-echo-duplicates-after-retry | 5 | T07, T09, T15 |
| 09-echo-while-queued-before-next-attempt | 5 | T13, T08, T15 |
| 10-rate-limit-drop-retry-same-id | 6 | T04, T13, T07, T15 |
| 11-max-attempts-failed-then-user-retry | 5 | T13, T14, T23, T04, T07 |
| 12-max-attempts-failed-state | 1 | T14, T06 |
| 13-ws-conflict-failed-retry-new-key | 6 | T16, T23, T15, T07 |
| 14-http-409-and-permanent-4xx | 6 | T37, T18, T15 |
| 15-http-transient-backoff-then-success | 5 | T19, T37, T17 |
| 16-http-401-timeout-late-success | 6 | T19, T13, T17, T15 |
| 17-http-401-and-timeout-states | 3 | T19, T13 |
| 18-ordering-two-conversations | 8 | T06, T04, T07, T28 |
| 19-reconnect-replay-order | 7 | T20, T21, T06, T15 |
| 20-throttle-eight-per-second | 4 | T05, T21, T04 |
| 21-cancel-queued-never-sent | 2 | T24 |
| 22-cancel-maybe-stored-resolve-then-delete | 4 | T24, T26, T32, T07 |
| 23-cancel-failed-max-attempts-requeues | 4 | T24, T06, T08, T26 |
| 24-edit-and-cancel-queued-offline | 6 | T25, T24, T02, T21 |
| 25-edit-while-sending-applied-after-echo | 3 | T25, T26, T31, T07 |
| 26-edit-delete-sent-messages-ops | 10 | T26, T02, T21 |
| 27-unread-open-chat-and-own | 9 | T27, T28, T29, T09 |
| 28-unread-offline-open-and-snapshot | 6 | T29, T30, T33 |
| 29-status-upgrade-never-downgrade | 5 | T10, T11, T12, T36 |
| 30-channel-own-stays-sent | 5 | T12, T28, T07 |
| 31-sync-page-fixture-tombstones (uses `http/sync.page.json` verbatim) | 1 | T33, T08, T32, T12 |
| 32-sync-has-more-paging | 2 | T33, T21 |
| 33-sync-410-full-resync-keeps-outbox | 3 | T34, T21, T36 |
| 34-sync-failed-retry | 8 | T35, T20, T38 |
| 35-disconnect-mid-sync-ignores-late-page | 3 | T20, T38 |
| 36-app-restart-resets-transient | 1 | T22 |
| 37-ws-rejection-pending-ops-and-foreign-errors | 6 | T16, T24, T38 |
| 38-cancel-rejected-removes | 1 | T24 |
| 39-message-updated-and-deleted-live | 7 | T31, T32, T38 |
| 40-history-confirms-failed-entry | 2 | T08, T36 |
| 41-late-echo-after-failed | 2 | T08 |
| 42-first-launch-bootstrap | 5 | T21, T33, T35, T36 |
| 43-retry-guards | 4 | T23, T02 |
| 44-unrelated-frames-ignored | 6 | T38 |
| 45-stale-ack-timeout-for-live-attempt | 3 | T15, T13 |
| 46-http-inflight-survives-ws-flap | 5 | T37, T06, T20, T17 |
| 47-http-stale-results-and-flush-online | 4 | T15, T19, T18, T37, T04 |

Where each required edge case is covered:

| Edge case | Vector(s) |
|---|---|
| Offline send, restart, replay exactly once | 05 |
| Double echo dedupe | 07, 08 |
| Echo before the next recorded attempt | 09 |
| Rate-limit drop, timeout, retry with the same id | 10 |
| 409 conflict leads to `failed` | 13 (WS), 14 (HTTP) |
| Max attempts, `failed`, then user retry | 11, 12 |
| Cancel a queued message | 21, 22, 23, 38 |
| Edit/delete while queued | 22, 24, 25, 37 |
| Ordering across two conversations | 18, 19 |
| Unread for the open chat and own messages | 27, 28 |
| `messages_read` upgrades but never downgrades | 29, 30 |
| Sync page with a tombstone | 31 |
| 410 full resync keeping the outbox | 33 |

**Vector format:** `{ name, description, covers, initialState (complete), events, expectedEffects (one list per event, exact), expectedState (subset of top-level keys, deep-equal) }`.

## RED / GREEN evidence

- **RED** (commit 519f609, the reducer did not exist): `node --test test/mobile-delivery-reducer.test.js` reported `tests 47, pass 3, fail 44`. The 3 passing tests were structure, transition coverage and fixture-shape checks. Each of the 44 vectors failed with `ERR_MODULE_NOT_FOUND ... reference/delivery-reducer.mjs`. During RED I fixed one runner bug: the shape check was treating the string `error.message` as a message object.
- **GREEN** (c58a466): `tests 47, pass 47, fail 0` on the first reducer run. With vectors 45-47 added: `tests 50, pass 50`.
- **Mutation checks.** Because the vectors and the reducer both came from my reading of the spec, I injected 27 single-line mutations into the reducer, for example:
  - max attempts 4, rate limit 10, no stop-and-wait, no busy set
  - status downgrade allowed, own/sync messages counted as unread, no `updated_at` guard
  - cancel always removes, retry always uses a new key, retry keeps its seq, 410 drops the outbox
  - persist emitted last, no backoff, only live frames confirm, no wake dedupe

  The first pass left 2 survivors (stale or early `ack_timeout` while still `sending`; `ws_disconnected` resetting an HTTP send). I added vectors 45 and 46 for those. A second pass left 2 more (stale non-2xx HTTP result applied; `background_flush` while online), so I added vector 47. Every mutation except one is now caught. The remaining one ignores the error `context`; it is harmless because the server only puts `client_msg_id` on `send_message` errors.

## Test summary

`cd server && npm test`: **tests 564, pass 563, fail 0, skipped 1, exit 0**. The skip is the existing Postgres-only test, which needs `TEST_DATABASE_URL`. The fixture drift test still passes. `node mobile/dev/capture-fixtures.mjs --write` leaves `reducers/` untouched, and the working tree stays clean afterwards.

## Files changed

- `mobile/contracts/delivery-state.md` (new; the binding contract)
- `mobile/contracts/reference/delivery-reducer.mjs` (new; reference reducer, exports `reduce`, `initialState`, constants)
- `mobile/contracts/fixtures/reducers/*.json` (47 new vectors) and `fixtures/reducers/README.md` (format and the rule that platforms must run all vectors)
- `server/test/mobile-delivery-reducer.test.js` (new; added to the explicit list in `server/package.json`)
- `server/test/mobile-contract-fixtures.test.js` and `mobile/dev/capture-fixtures.mjs`: skip `reducers/` (vectors are hand-written; without this, `--write` would delete them and the manifest test would fail)
- `mobile/contracts/ws-protocol.md`: reconnect algorithm points to `delivery-state.md`; the rejected-send wording is aligned
- `mobile/contracts/fixtures/README.md`, `mobile/contracts/parity-matrix.md`: pointers

No server behaviour changes.

## Concerns

1. **Open server gaps** (documented in `delivery-state.md` §10). None block a correct client model; each has a client-side workaround.
   - **G1.** `send_message` is processed asynchronously (awaits inside `sendMessageIdempotent`), so two frames on one socket can be stored out of order. Workaround: per-conversation stop-and-wait. This costs throughput when replaying a long queue in one conversation (one round-trip per message).
   - **G2.** The rate limiter drops frames silently. A `RATE_LIMITED` error carrying `client_msg_id` would let clients skip the 10 s wait.
   - **G3.** Apart from key errors, `send_message` errors carry no machine `code` or retryable flag. An internal DB error looks like a permanent rejection; the user retries with the same key, which is safe.
   - **G4.** `edit_message`/`delete_message` errors carry no `messageId` and are not idempotent, so ops are fire-and-forget.
   - **G5.** Reading on another of the user's own devices reaches the client only through sync `delivery_status` (direct) and list `unread_count`.
   - **G6.** Channels have no delivery receipts.
   - **G7.** A small race in the unread snapshot. Adding `last_message_id` to `GET /api/channels` would fix it.
   - **G8.** `message_deleted` has no `updated_at`.
2. **Design choices for the reviewer to confirm:** no separate `send_attempt` event; a wrapped `ws {frame}` event; extra events beyond the brief's examples (`background_flush`, `http_send_result`, `unread_snapshot`, `history_page`, `sync_failed`/`sync_start`, `tick`, `edit`/`delete`, `ws_disconnected`); `failed` entries kept in the outbox; same-key retry; unread driven by snapshots.
3. **Platform tests.** Any iOS/Android test that walks `fixtures/**/*.json` to decode server fixtures must skip `reducers/`, which the READMEs now state. Platforms also need a stable ISO-8601 parse for the `updated_at` comparison, and must use UTF-16 length (Swift `utf16.count`) and ECMAScript `trim` semantics. The vectors only use ASCII whitespace, plus an emoji length case.
4. **Vector size** is about 420 KB, mostly the verbatim `auth_success` frames and the 16000-character boundary text. It is fine for unit tests, but platforms should load the files from the shared directory rather than copying them.


---

# Fix round 1/5

**Status:** DONE. Two Important issues and the controller ruling are fixed, along with M1 to M5. No server behaviour changes.

## Commits

| SHA | Message |
|---|---|
| 5d8b286 | test(contracts): delivery fix round 1 contract and vectors (RED) |
| e79401a | fix(contracts): reducer for delivery fix round 1 (GREEN, plus vectors 56-57 and an extended 55) |

## Changes

**1. Edit/delete ops: throttled, and deletes confirmed and retried**
- *Throttle.* Ops now have their own rate window, `opsLog`: at most 8 frames per 1000 ms, shared by `edit_message` and `delete_message`.
  - §7.3 documents why. The server has separate fixed-window buckets of 10/s per frame type (`ws/server.js` `RATE_LIMITS`, `allowRate`). A shared 8/s window is simpler and stricter.
  - Throttled ops schedule one `tick`, deduplicated through `wake_at`.
- *Op records.* An op is now a record: `{op, message_id, text, state, attempts, failures, ack_deadline, next_attempt_at}` (§3.2).
  - An `edit` is sent once and then removed (G4).
  - A `delete` moves to `sending` and schedules `op_timeout {message_id, attempt}` after 10 s.
- *Confirmation.* A delete is confirmed by any tombstone: a `message_deleted` frame, or a record with `is_deleted = 1` from sync, history, update or echo. The confirmation removes every op for that id.
- *Retry and give-up.* On timeout the delete retries with backoff. After 5 failures it is dropped with `user_error DELETE_NOT_CONFIRMED`. A disconnect or restart puts an in-flight delete back to `queued` without counting a failure.
- *Server idempotency, verified in `server/src`.* `MessageService.deleteMessage` checks `is_deleted` before writing and throws `Сообщение уже удалено`. That means no write, no broadcast and no `change_seq` bump, so a repeated delete is safe. This is stated in §7.3.

**2. Ruling: a cancelled message is never delivered later**
- `eligibleHeads` (pump and `background_flush`) skips `pending_delete` entries. They are never sent and do not occupy their conversation.
- `cancel` of a possibly-stored entry that is not in flight starts a sync chain right away when online. A timeout or transient HTTP error on a cancelled in-flight entry does the same, and does not count against the budget.
- On sync chain completion, unresolved `pending_delete` entries that are not `sending` are handled as follows:
  - **Non-bootstrap chain:** the entry is dropped locally (`persist outbox`). This is valid proof the server lacks the key: nothing is sent while a chain runs, so the last attempt came before the chain started, and `/api/sync` from the saved cursor returns everything stored since.
  - **Bootstrap chain** (first launch or 410), which proves nothing: the entry is kept, and `load_history` is issued once for each of its conversations. If the record turns up there, a `delete_message` op is sent. Otherwise the next normal chain drops it.
- If sync, history or an echo returns the key, the existing reconcile step adds a `delete_message` op for the stored id.
- The accepted residual risk (a frame processed by the server after the sync read) is documented in §7.10 and as **G9** (no server-side cancel-by-key).
- Vector 23 is reworked (`23-cancel-failed-max-attempts-never-resent`): no `send_message` is ever emitted for K43; sync finds id 69 and `delete_message 69` is sent. Vector 22 is reworked (`22-cancel-online-sync-has-key-sends-delete`). Vectors 52 and 55 are new.

**M1.** A new `failures` counter now drives `MAX_ATTEMPTS` and `backoff(failures)`.
- Ack timeouts and transient HTTP errors count; disconnect, restart and 401 do not.
- `attempts` is now just the frame number and never resets; `retry` resets only `failures`.
- Vector 54 has 4 socket flaps followed by 1 timeout, giving `failures = 1` and a 1 s backoff instead of `failed`. Vector 57 shows `retry` gives a fresh budget.

**M2.** §5 now says what to do when `persist` fails, by event kind:
- **User actions:** show an error; the composer keeps its text.
- **Server events:** force-close the socket, which leads to `ws_disconnected`, a reconnect and a new sync chain that returns the same data because the cursor did not move. An HTTP result needs no replay, because the entry is still `sending` with a live ack timer.
- **Timers and system events:** re-dispatch the same event after 1 s.

**M3.** G3 and §7.5 now state that a rejection does not prove the message wasn't stored (an error after `INSERT`, e.g. in `getMessageById`). They give the consequence: same-key retry stays harmless, while cancel removes the entry only locally (same residual risk as G9).

**M4.**
- `sync.chain` is incremented by each `startSync`.
- `sync_request` and `sync_page`/`sync_reset_410`/`sync_failed` all carry `chain`. A result is ignored unless the chain is still running and its `chain` matches.
- A 410 continues within the same chain.
- Vector 53: a page, an error and a 410 from chain 1, arriving during chain 2, are all ignored.

**M5.**
- §3.4: the display text of an outbox entry is `pending_edit ?? text`, and entries with `pending_delete` are hidden.
- §3.3: `messages` never contains an empty list.
- §6.1 pins `WHITESPACE` to exactly the ECMAScript WhiteSpace + LineTerminator set (U+0009–000D, 0020, 00A0, 1680, 2000–200A, 2028, 2029, 202F, 205F, 3000, FEFF). It notes the Kotlin `isWhitespace` difference (U+00A0 not included) and the Swift `whitespacesAndNewlines` difference (U+FEFF missing, U+0085 included). The reducer uses an explicit regex.
- Vector 48: NBSP, FEFF, U+3000, U+2028, U+1680, U+202F, U+205F, U+2000–200A, `\v`, `\f` and U+2029 all count as blank; U+200B and U+0085 do not.

**Doc.** `delivery-state.md` was rewritten coherently:
- state, ops, chain and `opsLog`;
- the events `op_timeout` and `chain`;
- the new `user_error` code;
- pump pseudocode;
- handlers;
- §7.3, §7.10 and §7.11;
- table rows T13, T14, T19, T20, T23 and T24 updated;
- new rows T39 (ops throttle and send), T40 (`op_timeout`), T41 (tombstone confirms), T42 (cancelled-entry resolution) and T43 (stale chain);
- gap G9 added, G2, G3 and G4 updated.

## Vectors

The suite now has 57 vectors (it had 47).
- **Reworked:** 22, 23.
- **Updated for `chain`, `failures` and the ops shape:** 05, 06, 08, 11, 12, 13, 17, 19, 20, 24, 25, 26, 28, 31–36, 42, 43, 45, 46, 47.
- **Added:**

| Vector | Purpose |
|---|---|
| 48-trim-set-pinned | M5 trim set |
| 49-ops-throttle-shared-window | 12 ops in one millisecond: 8 sent, 4 more by `tick` after 1 s; a tombstone confirms one |
| 50-delete-op-lost-retried-confirmed-by-sync | a lost delete is retried, the socket drops, and a sync tombstone confirms it |
| 51-delete-op-gives-up | duplicate delete is a no-op, editing a message being deleted is rejected, give-up after 5 failures |
| 52-cancel-reconnect-empty-sync-dropped | cancel, reconnect, empty sync: entry dropped with no `send_message`; the next entry is not blocked |
| 53-stale-sync-chain-ignored | M4 |
| 54-socket-flaps-do-not-spend-budget | M1 |
| 55-cancelled-entries-after-410 | bootstrap keeps cancelled entries and loads history once per conversation; history finds one, the next normal chain drops the rest |
| 56-cancel-in-flight-entries | in-flight cancels do not block the conversation; a timeout starts sync; completion keeps in-flight entries; a 503 on a cancelled REST send starts a new chain |
| 57-retry-gives-fresh-budget | M1 retry |

## Commands and output

- **RED** (5d8b286, old reducer): `node --test --test-concurrency=1 --test-reporter=spec test/mobile-delivery-reducer.test.js` reported `tests 58, pass 25, fail 33`. The failures were vectors 02-06, 11-13, 17, 19, 20, 22-26, 28, 32-34, 36, 42, 43, 45, 46 and 48-55. The structure, coverage and fixture-shape checks passed.
- **GREEN** (new reducer): `tests 58, pass 58`. After adding 56/57 and extending 55: `tests 60, pass 60, fail 0`. One expectation in my first draft of vector 57 was wrong (`attempts` must be 6, not 5); I fixed the vector, not the reducer.
- **Mutation checks.**
  - **First pass, 25 mutations of the new rules.** Five survived: a cancelled `sending` entry blocking its conversation; dropping in-flight cancelled entries; no sync after the timeout of a cancelled entry; retry keeping `failures`; duplicate `load_history`. Vectors 55-57 now catch all five.
  - **Also re-run:** 8 key mutations from the first round, all caught except one.
  - **Equivalent survivors:** "no busy set" is unreachable now, because `sending` entries are always heads; the check is kept as a defensive invariant. "JS `\s` instead of the explicit set" is identical in ECMAScript.
- **Full suite.** `cd server && npm test`: **exit 0; tests 574, pass 573, fail 0, skipped 1** (the existing Postgres-only test). The fixture drift test passes.

## Concerns after the fix round

- **Residual cancel race (G9):** a frame the server processes after the sync read is not deleted automatically; it shows up later as an ordinary own message.
- **No delete after a failed REST-only flush.** Cancellation needs an online sync to resolve, and ops have no REST path (as before). Pending deletes and cancels wait for the socket.
- **Delete rejections look like lost frames.** A delete the server rejects (window expired, G4) costs 5 timeouts, about 65 s, before `DELETE_NOT_CONFIRMED`, because rejections carry no `messageId`.
- **Vector set size:** about 0.5 MB across 57 files.
