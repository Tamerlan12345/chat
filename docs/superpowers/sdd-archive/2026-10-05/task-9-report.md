# Task 9 report — iOS messaging core: contract reducer and durable outbox

Status: **DONE_WITH_CONCERNS**. Lane `m-ios`, branch `mobile/ios`, base 9c14de7. Pushed (no force) for CI.

Commits (9c14de7..4b86f5a, 61 files, +9.4k / −0.7k):
- 6771183 feat(ios): delivery-state reducer passing all contract vectors
- 14dd98c feat(ios): delivery engine — one serial executor behind a persist barrier
- 2e517c1 feat(ios): durable stores, socket link and the attachment queue
- ad8ec90 feat(ios): chats run on the delivery core; the queue belongs to its account
- f2e0a21 feat(ios): delivery states, reply/edit/delete and attachments in the chat
- fbc92c9 fix(ios): sendable history window items; internal attachment entry point; no foreground flush without a network
- 4b86f5a fix(ios): a chat closed right after it opened stops reading; nil never becomes JSON null

The task was done in one pass; no split was needed. 2e517c1 and ad8ec90 do not compile on their own: the
test doubles caught up with the new realtime protocol in ad8ec90. Every pushed head compiles.

## What was built

### Reducer and vectors (`CentyChat/Core/Delivery`)

- `JSONValue` is the contract's JSON. It uses JavaScript reads: `typeof`, `Number.isInteger`, truthiness,
  and integral numbers written without a fraction.
  - It is deliberately not `ExpressibleByNilLiteral`. With that conformance, `cond ? nil : v` silently
    became JSON `null`; CI caught it.
- `DeliveryState` / `OutboxEntry` / `DeliveryOp` / `Msg` are value types with the §3 projection
  (`json`, `init(json:)`). `Msg.record` keeps the whole server record for the screen.
- `DeliveryEffect` covers the §5 effects.
- `DeliveryReducer` is a line-by-line port of `reference/delivery-reducer.mjs`. It mirrors the JS
  semantics, including:
  - the `null` comparisons of `ack_deadline`;
  - a stable sort;
  - the fixed whitespace set;
  - UTF-16 length;
  - `Date.parse` through a small ISO parser.
- `DeliveryReducerVectorsTests` reads `fixtures/reducers/*.json` in place (the folder, not a list). For
  every vector it checks:
  - each event's effects exactly;
  - each `expectedState` key;
  - that the input is not mutated;
  - that every `initialState` projection round-trips.
- **Vectors: 70/70.**

### Engine (`DeliveryEngine`, @MainActor @Observable)

There is one serial command queue for the whole app. Foreground socket frames, user actions, alarms,
HTTP answers and the HTTP flush without a socket all go through it, so there is exactly one sender per
entry.

**Persist barrier.** The `persist` slices are written before the step's state is taken or any other
effect runs. A failed write follows §5:
- user actions are refused, and the composer keeps the text;
- server events restart the socket after a growing pause, so a persistent disk error is not hammered;
- alarms and system events are re-dispatched 1 s later.

**The queue belongs to an account.** `claimFor`:
- `auth_success`, `adopt`, an `enqueue` stamped with its owner, and history loaded by an owner all
  wipe another account's model first, in memory at once and then on disk;
- an empty model is claimed;
- a model with no owner but with data is treated as foreign;
- cache writes store `me`.

**Fail closed.** A store that cannot be read makes the engine blocked `load`:
- it is not ready;
- every user action and frame is refused;
- nothing is persisted;
- the load is retried with backoff.

A wipe that fails is blocked `wipe`: the model is emptied in memory, the wipe is retried, and the
caller is told. A reset while the load is blocked leaves a working empty queue.

**Every command answers its caller,** including on error. Failures are logged through `Log.delivery`.

**Other behaviour:**
- Alarms are deduplicated and run on an injectable `DeliveryClock`.
- `sync_request` chains, `refresh_conversation_lists` → `unread_snapshot` (G7 null ids kept), and
  `load_history` are handled.
- The conversation cache keeps the last 200 per conversation, written in the persist transaction or
  batched after 1 s.
- `conversationClosed(_:)` is decided when it is processed. A screen closed right after it opened no
  longer keeps reading, and closing a chat that is no longer visible does not clear the chat that
  opened.

### Storage

`SwiftDataDeliveryStore` keeps `Application Support/Delivery/delivery.store`:
- The folder is excluded from backup.
- The schema is versioned (`DeliverySchemaV1`) with a migration plan, and nothing is ever deleted to
  repair it. A container that cannot be opened makes `load` throw, so the engine fails closed.
- It holds: meta (`me`, cursor, `seq`, cancelled), outbox rows (the contract JSON, unique by key),
  ops in order, the conversation cache, and waiting files.
- Each persist is one `save()`, rolled back on error.
- `-reset-secure-state` (UI tests) also deletes the store and the outbox copies.

### Link and HTTP

- `WebSocketClient` emits every raw frame in order plus `closed` whenever a socket goes away.
  - `sendFrame` writes only on an authenticated socket; `false` makes the engine treat the socket as
    gone.
  - It adds `restart`, `reconnectNow` and `authenticatedUserId`.
  - `RealtimeStore` forwards frames in order, and emits `closed` on stop.
- `APIClient.raw` returns statuses as they are. Only a refresh the server refuses (401/403) ends the
  stored session. A refresh that gets no answer is status 0 and never signs the user out.
- `HTTPDeliveryBackend` covers `/sync` (410, Retry-After), history, both lists, and `POST /messages`.
- `WSClientMessage` lost `sendMessage`, `editMessage` and `markRead`, so only the engine writes message
  frames. `deleteMessage` remains only for an administrator deleting someone else's message, which the
  contract does not cover.

### Runtime and session

`DeliveryRuntime` handles:
- adopting the signed-in account (`sessionDidAuthenticate`);
- `unsentCount` (own account only, cancelled excluded, files included);
- `discardForSignOut`;
- `flushInBackground`: wait for ready (bounded), adopt, upload waiting files, then `background_flush`
  rounds until no HTTP entry is in flight, stopping as soon as the socket is up.

There is no BGTask. The flush runs:
- on foreground, skipped when `NWPathMonitor` reports no path, because an HTTP attempt would only spend
  the budget;
- on a network-path transition to satisfied, which also triggers `reconnectNow`;
- after sign-in.

Session rules:
- **Explicit sign-out** asks first when unsent items exist, with the Russian plural «N неотправленных
  сообщений будут удалены» (1 / 2–4 / 5+ forms). It then deletes them. A failed delete cancels the
  sign-out with «Не удалось удалить неотправленные сообщения — выход отменён».
- **Account deletion** and another server's credentials discard them, best effort. The delete
  confirmation shows the same line.
- **An involuntary end** (revalidate → unauthorized) keeps them.
- **Another account signing in** wipes them.

### Chat (`ChatStore`, `ChatProjection`, `ChatTimeline`, views)

**Projection (§3.4):**
- server messages without delete-op ids;
- then the outbox by seq without `pending_delete`, with text `pending_edit ?? text`;
- then files still going up;
- another account's model is never shown;
- rows keep their identity by `client_msg_id`;
- reply quotes are filled from the loaded original, as on desktop.

**Loading:**
- `load()` replaces the newest page; stale ids are dropped only inside that page's range.
- The Task 7 continuous window (`loadAround`) is kept. `HistoryWindow` is now generic over records.
- `loadOlder()` uses `beforeId`, triggered at the top of the list.

**Composer:** cleared only when `enqueue` reached disk (`composerCleared`). A double tap is guarded.

**States and `showsMeta`:**
- queued (clock), sending, failed (reason plus «Повторить» / «Удалить»), sent, delivered (two checks)
  and read.
- Grouping follows desktop (sender, day, 5 min). Meta shows on the group's last bubble, on an edited
  bubble, or on a queued/sending bubble whose group ends further along.

**Long-press menu** (`MessageMenuPolicy`):
- «Ответить» sends `reply_to_id`.
- «Копировать».
- «Редактировать» for own text, within the server's edit window.
- «Удалить» behind a confirmation dialog. An unsent message becomes `cancel` with its own wording and
  is never sent later.
- «Повторить», «Пожаловаться», «Заблокировать автора».

**Attachments** (parity with Android Task 4):
- **Sending:**
  - PhotosPicker: HEIC is converted to JPEG, and the name is `IMG_yyyyMMdd_HHmmss.ext`.
  - `.fileImporter` (document picker, security-scoped), with no broad permissions.
  - The policy is checked with the server's wording before anything happens.
  - A private copy (`Application Support/Outbox/<key>`, excluded from backup) and a stored row are made
    first. Then the upload; then `enqueue` as `file`/`image` with the same `client_msg_id`, the
    desktop metadata shape, and `text = file name`.
  - A network failure (or 401) stays queued and is retried after 15 s. A refusal fails with the
    server's Russian reason.
  - Files go up only under the account that picked them.
- **Opening:**
  - An image opens in the in-app viewer: the thumbnail first, the full picture underneath, pinch and
    double-tap zoom, «Повторить».
  - A file downloads with a progress tile, then opens in Quick Look only when the type of its extension
    is on an exact mirror of `safeDownloadType` (tested against the server's list). Otherwise it goes to
    the share sheet. The sender's `mimeType` never decides.
- **Downloads:** Bearer only to the configured HTTPS origin, redirects refused, into
  `Caches/Attachments` with `Range`/`If-Range` resume, `If-None-Match`, a 206 start check, and 416
  handling. Thumbnails come from `/files/thumb/{id}?size=m&format=jpeg`.
- **Wipes:** downloads, thumbnails and avatars are wiped when the session ends.

## Tests and CI

- **Linux (Docker `swift:6.1-jammy`)** ran every Foundation-only suite locally before each push:
  reducer, vectors, engine, runtime, uploads, rules, downloader, opener, model/menu, and
  projection/timeline. **87/87 green.**
- **CI runs:**

| Run | Head | Result |
|---|---|---|
| 37295421206 | f2e0a21 | Release compile errors (Sendable generic, a public method with an internal type); cancelled |
| 37295638669 | fbc92c9 | Build green, Release lock green. Unit **415/418**, UI **15/15** (incl. the new offline UI test). The 3 failures are RED evidence of two real bugs, fixed in 4b86f5a |
| 37299354417 | 4b86f5a | **GREEN**: build, Release lock, unit **420/420**, UI **15/15**, screenshots published |

### TDD evidence

All files are in this folder.

- `task-9-red-vectors.log`: a stub reducer passes 1/70 vectors, with 416 assertion failures.
  `task-9-green-vectors.log`: 70/70. `task-9-mutation-vectors.log`: setting ACK to 10001 ms gives
  34/70 (36 vectors fail).
- `task-9-red-attachment-rules.log`: the stub API produces 22 assertion failures; then GREEN.
- **Engine:** the tests were written right after the code. The first run was RED on a real bug: an
  optional-chained `continuation?.resume(returning: await dispatchNow(...))` skipped every posted event,
  giving 21 failures. That run is reproduced as M1 in `task-9-mutation-engine.log`. The log also holds
  three mutations, each turning tests RED:
  - state applied before persist;
  - no owner check on `auth_success`;
  - a failed load falls back to an empty model.
- `task-9-mutation-downloader.log`, `task-9-mutation-uploads.log` and `task-9-mutation-projection.log`
  hold mutations that turn the tests RED:
  - a 206 appended without its start check;
  - no `If-Range`;
  - no offline copy;
  - no owner check on uploads;
  - a network failure treated as a refusal;
  - a file not recorded before upload;
  - a wipe that does not forget files;
  - no stalled-bubble clock;
  - another account shown;
  - a cancelled entry shown.
- **CI RED (assertions), run 37295638669:**
  - `RealtimeChatTests` lines 78/112: a `mark_read` went out for a chat already off screen (the
    open/close race);
  - `SwiftDataDeliveryStoreTests`: an entry with nil metadata came back as `null`.
  - Both are fixed in 4b86f5a, with new engine tests for the close race.
- **Process deviation (as on Android):** the engine, runtime, projection and opener tests were written
  just after their code, not before. The mutation logs show they have teeth.

### Existing tests kept

`RealtimeChatTests` and `ChatJumpTests` now run through the engine (`TestApp.deliver` sends the raw frame
to the engine and the parsed event to the stores; `goOnline`). Where the contract changes behaviour, the
test says so inline:
- an own echo is matched by `client_msg_id`, not by text;
- opening a chat sends `mark_read` (`conversation_opened`), so the "not on screen" tests clear the sent
  frames after closing.

### UI test

`OfflineQueueUITests.testAMessageWrittenOfflineIsDeliveredOnceAfterARelaunch` runs against the CI dev
stand. The transport is downed only through the app-level hook `-centychat-ui-delivery-offline`: the
socket points at `127.0.0.1:9` and delivery HTTP returns status 0. The stand is never changed. Steps:
1. Sign in as Alice and open the chat with Bob.
2. Send. The bubble shows «Ожидает отправки», the composer is empty, and Bob has 0 copies.
3. Terminate the app.
4. Relaunch without the flag. The session is restored and the chat opened.
5. The bubble is confirmed (no queued or sending mark left), and Bob's REST view has exactly one copy.

The Release lock script now also forbids `-centychat-ui-delivery-offline` in the binary.

### Screenshots

Branch `ci/ios-screenshots`, folder `fbc92c9/`:
- `OfflineQueueUITests-…--20-offline-queued.png`: the clock on «Офлайн …», composer cleared.
- `OfflineQueueUITests-…--21-reconnected-sent.png`: the same bubble with a check after the relaunch.

Folder `4b86f5a/` holds the same pair from the final run.

## Contract disagreements

None between the prose, the vectors and the reference. Coverage gaps, as Android noted:
- no vector exceeds `CANCELLED_MAX`;
- no vector ingests a record without `created_at`. The Swift projection omits the key, as JSON does with
  `undefined`.

## Self-review

- **Swift 6 strict concurrency:** no `@unchecked Sendable` or `nonisolated(unsafe)` in production code.
  - `RedirectRefusal` is a final `NSObject` with no state.
  - The download transport keeps `URLSession.AsyncBytes` inside one Task, with the head delivered
    through a continuation, so nothing non-Sendable crosses actors.
  - The engine, uploads, runtime, opener and stores are `@MainActor`.
  - The SwiftData context lives only in a `@ModelActor`.
  - Test doubles use `@unchecked Sendable` with locks, which is test-only.
- **Every engine command resumes its continuation on every path:**
  - dispatch is refused with `persisted=false`;
  - `replaceHistory` throws while blocked;
  - `adopt`/`reset` throw a wipe failure.
- **Nothing of user X reaches user Y:**
  - the engine claims on `auth_success`, `adopt`, `enqueue`, history and restore (signed-in account and
    socket account);
  - uploads check the picker's owner against the signed-in user;
  - the projection hides a foreign `me`;
  - the runtime flush adopts before sending.

## Concerns

1. Unread counts in the chat list still come from `ConversationsStore`. The engine computes contract
   `unread` but the list does not use it yet (Android has the same limitation). `refresh_conversation_lists`
   costs two GETs per completed sync.
2. An administrator deleting someone else's message sends `delete_message` directly; the contract `delete`
   covers own messages only.
3. **Background:** there is no BGTask or push wake (no Apple account). A message queued and then left with
   the app in the background goes out on the next foreground or reconnect.
4. **Time of an unsent message:** the bubble shows when this process first showed it
   (`LocalSendTimes`), because the outbox keeps no timestamp.
5. **Upload size:** the file is read into memory for the multipart body (as before, max 100 MB). Upload
   progress is 0 → 1 only. A streaming upload task would give real progress.
6. **Pre-existing visual issues (for Task 10):** an incoming bubble (`receiverBubble` =
   `secondarySystemBackground`) is nearly invisible on `systemGroupedBackground` in light mode (visible in
   screenshot 21). The tab bar stays visible inside a pushed chat.
7. **HTTP retries count against the budget:** a foreground HTTP flush that gets status 0 counts toward
   `MAX_ATTEMPTS`, as the contract says. That is why it is skipped when `NWPathMonitor` reports no path.
8. **Edit of an unsent message:** the menu offers «Редактировать» only for settled messages (Android
   parity). `ChatStore.edit` supports unsent text through `edit` by `client_msg_id`, but the UI does not
   offer it.

---

## Fix round 1 — Stopped at 16:52 (controller's stop)

Commits (4b86f5a..503d2e4, pushed without force; working tree clean):
- 834aa27 fix(ios): a cancelled sign-out deletes nothing; stale owners and the signed-out socket are refused
- 503d2e4 fix(ios): owner-bound chats and uploads, two uploads at a time, streamed from disk

**Done (items 1–10):**
1. `reset()` clears the disk first. If that fails, the model, owner and queue are untouched, nothing is blocked and no retry wipe runs; the user stays signed in and the message still goes. The account-switch wipe stays memory-first, with retries.
2. ChatStore captures the owner before each request. The engine refuses (never claims for) an enqueue or page whose stated owner is not the signed-in account. Refused sends show a notice.
3. Sign-out stops the socket before the wipe. A `signedOut` flag drops `ws` frames and refuses actions and pages until `adopt`; an adopted account then picks up a socket that is already authenticated. A cancelled sign-out re-adopts and restarts the socket.
4. The projection shows only `state.me == me`, so an ownerless model shows nothing. Uploads are filtered by `owner == me`. `AttachmentUploads.restore()` waits for the engine to be ready and deletes another account's rows without loading them.
5. Uploads:
   - at most 2 at once, enqueued in the order they were picked (per conversation);
   - 429, 5xx, 507 and 408 retry, using `Retry-After` when given;
   - the multipart body is written to a temporary file and sent with `URLSession.upload(fromFile:)`, with real progress and redirects refused.
6. The composer keeps text typed while a message was being stored (`ComposerText.afterSend`).
7. No platform trimming: §6.1 decides whether text is empty, and the send button uses `DeliveryReducer.isBlank`.
8. `restore()` deletes another account's stored model before anything of it is published.
9. `unsentCount` is nil while the store cannot be read; the sign-out dialog then says «Не удалось проверить неотправленные сообщения — если они есть, они будут удалены».
10. The downloader shares one transfer per file id and guards with a generation counter, so a download that finishes after `removeAll()` leaves no file and fails.

**Tests:**
- **RED** (assertion failures, logged in this folder):
  - `task-9-fix1-red-engine.log`: 6 engine tests, 21 failures.
  - `task-9-fix1-red-rest.log`: uploads (FIFO/2-at-once, Retry-After, 5xx/507, owner-gated restore), projection ownership, composer, multipart writer, retry policy, unknown unsent count, shared download.
  - The generation-guard test already passed against the old code, for the wrong reason: the Linux rename failed on the deleted folder.
- **GREEN on Linux:** `task-9-fix1-green-linux.log`, 105/105.
- **CI-only tests added to ChatOutboxTests**, not yet confirmed by CI:
  - «Останусь» stays visible, is stored, and is sent;
  - frames after sign-out are not stored, and the socket is closed;
  - a late page of the previous account is dropped while the next account's queue stays;
  - a stale owner's send is refused with a notice;
  - U+0085 is accepted and blank text is refused.
  - `testAWipeThatFailsIsLoudAndSendsNothing` was split into `testASignOutWhoseWipeFailsKeepsTheQueueAndItStillGoes` and `testAnAccountSwitchWhoseWipeFailsSendsNothingOfThePreviousAccount`.

**Not done:** nothing outside the 10 items was started. The CI-only tests have no CI result yet.

**CI:** run 37304787048 on 503d2e4 was **in progress** at the stop:
- Release lock: success (the app compiles with the new code).
- Simulator job: build for testing succeeded (the tests compile); unit and UI tests had not finished.

**Next step:** read run 37304787048 (`gh run view 37304787048`, failure annotations from the `ios-simulator-tests` check run). If it is green, round 1 is closed. If not, fix the failures, especially in the CI-only ChatOutboxTests and SessionLifecycleTests, which are sensitive to the new logout order (socket stopped before the wipe).

**Update after the stop (no new work, no new run):** CI run 37304787048 on 503d2e4 finished **green**:
- Release lock: passed.
- Unit tests: **442/442**, including the CI-only ChatOutboxTests of round 1.
- UI tests: **15/15**.
- Screenshots: published.

Fix round 1 is closed.
