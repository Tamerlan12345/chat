# Task 5 report — Android messaging core: contract reducer and durable outbox

Status: **DONE_WITH_CONCERNS**. Lane `m-android`, branch `mobile/android`, base 06bc8ee. Not pushed.

Commits (06bc8ee..fe4e85b, 64 files, +5414 / −661):
- b3bcc79 fix(android): guard the session cache wipe, check 206 ranges, cancel stalled downloads
- 9a18b9a feat(android): delivery-state reducer passing all contract vectors
- 02ef3d2 feat(android): show a stalled queued/sending bubble's state inside its group
- 7bf001b feat(android): durable delivery core — Room outbox, effects executor, WorkManager flush
- fe4e85b feat(android): load the older page (beforeId) when the reader reaches the oldest messages

## What was built

- **Reducer** (`data/delivery/DeliveryReducer.kt`, `DeliveryState.kt`, `DeliveryEffect.kt`). A line-by-line Kotlin port of `reference/delivery-reducer.mjs`.
  - State is typed and mutable inside one step only: `reduce` deep-copies its input.
  - Events and server frames are read as contract JSON, using JavaScript semantics for `typeof` string checks, `Number.isInteger`, truthiness and `Date.parse`.
  - `toJson()`/`fromJson()` produce the exact §3 projection.
  - `Msg.record` carries the whole server record for the screen. It is not part of the projection.
- **Vector test** (`contract/DeliveryReducerVectorsTest.kt`). It walks `fixtures/reducers/*.json` in place, the same way `ContractFixturesTest` loads fixtures (Parameterized: one test per vector). For every vector it checks:
  - each event's effects exactly;
  - each named `expectedState` key;
  - that the input state is never mutated.
  - **Result: 70/70.**
- **Effects executor** (`DeliveryEngine.kt`). This is the single process-wide sender: one serial command queue.
  - **Persist barrier first:** a Room transaction. If it fails, the step's state is thrown away and §5 decides what happens next:
    - user actions report back so the composer keeps the text;
    - server events restart the socket;
    - alarms and system events are re-dispatched after 1 s.
  - **Order of the remaining effects:** `send_ws` (a refused write counts as `ws_disconnected`), `send_http`, `schedule` (deduplicated alarms on the injected clock), `sync_request` chains (page / 410 / failure carry the same `chain`), `refresh_conversation_lists` → `unread_snapshot`, `load_history`, `user_error` → snackbar text.
  - **Startup:** on `start()` it subscribes to frames first, then restores from the store, applies `app_restart` and refills the conversation cache through `history_page`.
  - **Sign-out:** `reset()` wipes the model and the storage, and drops late answers using an epoch counter.
  - **Platform extras (not contract events):** `replaceHistory` (the latest page replaces stale cached ids) and `historyPage`, used for paging.
- **Link and backend.**
  - `WebSocketClient.deliveryFrames` emits every raw frame in order, with no dedupe, plus a synthetic `socket_closed`. It also gained `sendFrame` and `restart()`.
  - `RealtimeRepository` lost `sendMessage` / `sendAttachment` / `cancelMessage` / `editMessage` / `deleteMessage` / `markRead`, so only the engine writes message frames.
  - `ApiClient.raw()` reads statuses as they are; a 401 still ends the session.
  - `HttpDeliveryBackend` covers `/api/sync?limit&since`, history pages, both lists, and `POST /api/messages/{direct|channels}/{id}`.
- **Room** (`data/delivery/store/`). Database `delivery.db`, version 1, schema exported to `app/schemas/.../1.json`.
  - Tables: `outbox` (real columns), `ops`, `cancelled_keys`, `delivery_meta` (me/cursor/seq), `message_cache` (last 200 per conversation, written in the same transaction as a cursor persist, otherwise batched after 1 s) and `pending_uploads`.
  - There is deliberately no `fallbackToDestructiveMigration`.
  - The database is excluded from backup and device transfer.
- **WorkManager** (`DeliveryFlushWorker`, `WorkManagerFlushScheduler`, `DeliveryRuntime`).
  - Unique work `delivery-flush` with KEEP, a CONNECTED network constraint and exponential backoff.
  - Scheduled whenever something is waiting and there is no socket.
  - The worker uses the same engine through a Hilt `@EntryPoint`, uploads waiting files first, then runs `background_flush` rounds while they make progress. It returns `retry()` if anything sendable is left, and does nothing while the socket is up.
- **Attachments** (`features/chat/AttachmentSends.kt` — upload orchestration moved out of `ChatViewModel`). The queue for files that are not in the outbox yet:
  - a private copy plus a stored row, then the upload;
  - then `enqueue` as `file`/`image` with the same `client_msg_id` and metadata.
  - A transport failure (`statusCode == 0`) stays QUEUED and retries after 15 s while connected. A server refusal is FAILED with the server's reason.
  - The local copy is kept until the outbox entry is confirmed, so the bubble does not flash. Orphan copies are pruned at start.
- **ChatViewModel** (rewritten).
  - It projects the model with `ChatProjection`: messages without delete-op ids, then outbox entries without `pending_delete` (text is `pending_edit ?: text`), then uploads, de-duplicated by key. Reply quotes are filled from `reply_to_id`, as on desktop.
  - `send(text, replyTo, onAccepted)`: the **composer clears only from `onAccepted` after a successful persist** (`ChatActions.onSubmit`). A double tap is guarded.
  - «Ответить» sends `reply_to_id` for both text and files.
  - Edit and delete go through ops, behind the existing confirmation dialog. An unsent message (queued, sending or failed) gets «Удалить» with its own confirmation text and becomes `cancel`.
  - `conversation_opened` / `closed` replace the direct `mark_read`.
  - Older pages load by `beforeId` (`loadOlder`, triggered by `MessageList` near the oldest rows).
  - `DM_NOT_ALLOWED` is derived from the failed entry's `failure.code`.
  - `ChatHistoryCache` is removed: the engine's cache replaces it.
- **showsMeta.** A QUEUED/SENDING bubble shows its state when its group ends further along (queued < sending < failed < sent < delivered < read). Delivered/read changes never reflow.
- **Carry-over minors, all fixed:**
  - status 0 → QUEUED;
  - the 206 `Content-Range` start is checked before appending;
  - interruptible download with call cancel (`FileTransferClient.get` and `runInterruptible`);
  - `SessionCacheWiper` steps run in `runCatching`;
  - upload orchestration moved out of the view model;
  - `reply_to_id` is sent.

### Attachment durability choice

I chose a **private copy in `noBackupFilesDir/outbox/<client_msg_id>`**, not a persisted URI grant:
- Photo Picker / `GetContent` grants are not reliably persistable across process death on every API level.
- The source can be edited or deleted by its owner before upload.
- A copy is under our control, excluded from backup, deleted once confirmed or cancelled, and wiped on sign-out.

Cost: temporary storage up to the 100 MB upload limit per waiting file.

## Tests

- **Unit (`testDebugUnitTest`):** 627/627 green, 0 failures. Baseline was 525. New tests:
  - 70 vectors;
  - 14 `DeliveryEngineTest`;
  - 12 `ChatViewModelOutboxTest`;
  - 3 carry-over tests;
  - 1 showsMeta, 1 menu policy, 1 WebSocket `deliveryFrames` test.
- **Lint:** 0 errors (40 warnings, none introduced in new code except the pre-existing `VisibleForTests` on the `SavedStateHandle()` default).
- **`assembleDebug`:** OK.
- **`connectedDebugAndroidTest` on Pixel_8:** 82/82 green, including the new `RoomDeliveryStoreTest` (4) and `ChatUiV2Test.reachingTheOldestMessagesAsksForTheOlderPage`.

Existing QA queue tests (4d08e46/6ce510f/d69a809) are kept. They were moved onto the core: a shared `DeliveryHarness` replaces `historyCache`. Where **the contract changes behaviour**, the assertions follow the contract and say so inline:
- `noEchoWithinTheAckTimeoutMarksTheMessageFailed`: §7.3 — the same key is resent with 1/2/4/8 s backoff, and FAILED comes after 5 unanswered attempts (65 s). Previously it failed at 10 s.
- `discardingAFailedMessage…` now waits 66 s for the fail.
- `peerDeletingTheirMessage…` / `deletingMyOwnMessage…`: a tombstone stays («Сообщение удалено», §3.4) instead of the message being removed.
- `aChannelDeletionNeverRemovesADirectMessage` became `aDeletionIsFoundByItsMessageIdAlone…`: §6.3 looks the message up by `messageId` only.
- `aFileLeftUploadingComesBackQueuedWithoutAStaleRing`: uploads now belong to the app. A reopened chat shows the live upload, and after a simulated process restart the stored file is QUEUED with no ring.
- `ChatHistoryCacheTest`: the same four behaviours, checked against the engine cache and the store wipe.

## TDD evidence

RED/GREEN logs:
- `task-5-red-carryover.log` (3 failing) → `task-5-green-carryover.log`;
- `task-5-red-vectors.log` (stub reducer: 69/70 failing) → `task-5-green-vectors.log` (70/70);
- `task-5-red-showsmeta.log` (1 failing) → green in `task-5-final-gradle.log`.

The menu-policy test was written together with the code. The engine and `ChatViewModel` migration were written before their new tests. The existing QA and VM tests were the safety net, and they passed on the first run after migration.

To show the new tests are not vacuous, I ran mutations, each of which turns tests RED:
- `task-5-mutation-engine.log`: skipping the persist-failure return → 2 failing; HTTP flush not marking the entry `sending` → the double-send test fails.
- `task-5-mutation-vm.log`: dropping `reply_to_id`, classifying status 0 as failed, removing showsMeta, clearing the composer before persist → 5 failing.

A further reducer mutation (ACK 10001 ms) failed 36 vectors.

## Emulator evidence

Pixel_8 emulator, dev stand on `SERVER_PORT=2014` (never 2004 or production). Details are in `task-5-evidence-emulator.md` with `task-5-evidence-1-airplane-queued.png` and `task-5-evidence-2-relaunched-sent.png`.
1. alice: airplane mode on, sent `T5-airplane-124657`. The bubble showed «Ожидает отправки», the banner «Нет сети», and the composer cleared.
2. `am force-stop`. `delivery.db` pulled with `run-as` holds the outbox row: queued, attempts 0, cursor and me persisted.
3. bob's API session before relaunch: 0 matching messages.
4. Airplane mode off, relaunched. bob sees **exactly 1** message (id 159, same `client_msg_id`). The server DB has exactly one row with that key.
5. The app shows it as «Отправлено». The outbox is empty, and the cache has id 159.

The stand and emulator I started were stopped afterwards.

## Contract disagreements

None found between the prose and the vectors/reference. Coverage gap: no vector exceeds `CANCELLED_MAX`. Mutating it to 3 still passes 70/70, so trimming is untested by the contract set. Integration may want a vector for it.

## Self-review and concerns

1. **Sign-out wipes unsent messages** (outbox, files, cache). I chose privacy over delivery, consistent with the old history cache and the attachment wiper. A 401 after a failed refresh therefore also drops the queue.
2. The bubble time of an unsent message is when it was first shown in this process (`LocalSendTimes`). The contract outbox has no timestamp, so after a restart it shows the relaunch time until confirmed.
3. An administrator deleting **someone else's** message still sends `delete_message` directly. The contract `delete` event covers own messages only.
4. The engine computes `unread` (snapshots and mark_read), but `ConversationsViewModel` still uses its own unread logic. Moving the list onto it is left for a later task. `refresh_conversation_lists` costs two GETs per completed sync.
5. A text typed while a file is still uploading can overtake the file, because files enter the outbox only after upload. Stop-and-wait FIFO holds for the outbox itself.
6. The in-memory model keeps every conversation's messages for the process lifetime. Room keeps the last 200 per conversation.
7. `now` is wall-clock (monotonic within a run). A backward clock jump can delay a persisted `next_attempt_at`.
8. The WorkManager path is covered by unit tests (`DeliveryRuntime.flushInBackground` with the engine) but was not exercised on the device.
9. Commit granularity: the core and view-model migration is one large commit (7bf001b), because the pieces do not compile apart.

---

## Fix round 1 (review items 1–5)

Commits (fe4e85b..1b64270):
- 8f401f3 fix(android): an unreachable token refresh no longer ends the session
- 1b64270 fix(android): unsent messages belong to the account; the delivery store fails closed

### Changes

1. **The outbox is no longer wiped on an involuntary session end.**
   - **(a) Refresh failures.** The authenticator moved to `core/network/SessionAuthenticator.kt`. `RefreshFailurePolicy.classify` maps the refresh answer to an outcome:
     - only 401/403 count as `Rejected`, which ends the session;
     - no answer, a timeout, a 5xx, 429, or an unreadable 200 count as `Unreachable`.
     - On `Unreachable` the request fails with `RefreshUnreachableException`, an IOException. Callers see a network error: `raw()` returns status 0, other calls raise `ApiException(0)`. Nothing signs out.
   - **(b) The queue belongs to an account.** `DeliveryRuntime` no longer wipes when `token` becomes null. It calls `engine.adopt(session user)`:
     - a different stored `me` is wiped first;
     - a null `me` is claimed by the signed-in account.
     - `adopt` is also checked on every `auth_success` frame (before it is processed) and before any background flush.
     - `AttachmentSends` uploads only when the queue's owner is signed in, and forgets its files when the engine announces a wipe (`wiped`).
   - **(c) Explicit sign-out asks first.** `OutgoingQueue` (implemented by `DeliveryRuntime`, bound in Hilt) provides `unsentCount` and `discardForSignOut()`.
     - The logout dialog adds «N неотправленных сообщений будут удалены» (Russian plurals).
     - `ProfileViewModel.logout` deletes the unsent messages first. If that fails, it shows «Не удалось удалить неотправленные сообщения — выход отменён» and does not sign out.
2. **A failed load fails closed.** `restore()` no longer falls back to an empty model.
   - On a load failure the engine is `blocked = "load"`: `ready` stays false, and every user action or frame is refused (`persisted = false`, so the composer keeps the text). No persist runs, so the stored outbox is never overwritten.
   - The load is retried with backoff (1 s, 2 s … 30 s).
   - Frames dropped in the meantime are re-read by the next sync, because the cursor never moved. Once the load succeeds, an already authenticated socket is picked up.
3. **No waiter is left suspended.** When a command throws, the command loop logs it (`log`, which is Logcat in the app) and completes every waiter:
   - `Dispatch` gets `Outcome(false)`;
   - `ReplaceHistory`, `Reset` and `Adopt` complete exceptionally.
   - `replaceHistory` while the engine is blocked fails, so the screen shows «Не удалось обновить».
4. **A failed wipe is loud.** On a wipe the model is first emptied in memory, so nothing of the old account can be sent. If `store.clear()` then fails, the engine is `blocked = "wipe"` (nothing accepted or sent), the wipe is retried with backoff, and the exception reaches `discardForSignOut()` and the sign-out UI.
5. **The worker retries while work is left.**
   - `flushInBackground` returns `retry()` while non-failed uploads remain, as well as for sendable outbox entries.
   - It waits at most 60 s for the store to become ready (otherwise `retry()`).
   - It adopts the session user before flushing.

### TDD

- **RED** — `task-5-fix1-red.log`: 45 tests run, 12 failing.
  - `SessionAuthenticatorTest` ×2 (unreachable refresh, classify);
  - `DeliveryEngineTest` ×7 (explicit sign-out count and wipe; involuntary end keeps the outbox; another account's background flush; a wipe that fails; an unreadable store not overwritten; the worker not waiting forever; the worker retrying while a file waits);
  - `ChatHistoryCacheTest.signingOutClearsTheCache` (a lost session keeps the cache, an explicit sign-out clears it);
  - `ProfileViewModelUnsentTest` ×2.
- **Two tests passed in RED for the wrong reason:** `anotherAccountSigningInNeverSendsThePreviousAccountsText` and `aPreviousAccountsFileNeverGoesUpForAnotherAccount` (the old code wiped on any token loss). `task-5-fix1-mutation.log` shows them failing once the owner checks are mutated away (3 failing).
- **GREEN** — `task-5-fix1-green.log`, covering suites:

  | Suite | Tests |
  |---|---|
  | `SessionAuthenticatorTest` | 4 |
  | `DeliveryEngineTest` | 21 |
  | `ChatHistoryCacheTest` | 4 |
  | `ChatViewModelOutboxTest` | 13 |
  | `ProfileViewModelUnsentTest` | 3 |
  | `RefreshFailurePolicyTest` | 1 |

- **Full run** — `cleanTestDebugUnitTest testDebugUnitTest lint assembleDebug compileDebugAndroidTestKotlin`, in `task-5-fix1-full-gradle.log`: `> Task :app:testDebugUnitTest` executed (not UP-TO-DATE). **642/642** unit tests in 101 suites, 0 failures. Lint 0 errors. `assembleDebug` OK.

### Remaining notes

- After an involuntary session end, the account's message cache stays on disk until the same account returns, an explicit sign-out, or another account signs in.
- `deleteAccount` does not ask about unsent messages. The next account to sign in wipes them via `adopt`.
- The emulator scenario was not re-run for this round. The unchanged happy path (same account, socket up) is covered by the unit suites.

---

## Fix round 2 (B1, B2, B3, residual ii)

Commit 0069c7a — fix(android): the queue always names its account; no other account inherits it.

### Changes

**B1 — another account can never send or sync the previous account's queue.**
- `DeliveryEngine.claimFor(user)` is now the single owner rule. A stored owner that differs from `user` causes a wipe. So does a model with no owner that still holds outbox entries, ops or cancelled keys. An empty model is claimed for `user`.
- The rule runs:
  - on every live `auth_success` (`Dispatch`);
  - in `restore()` after a successful load (`:365` before) — first for the remembered signed-in account, then for the socket's account. The engine is marked ready, and the socket's `auth_success` is processed, only after that check;
  - on `Adopt`;
  - after a retried wipe succeeds. In that case an already-authenticated socket is also picked up for its own account.
- **Remembered account.** `signedIn` holds the last adopted account; an explicit sign-out (`Reset`) clears it. `Adopt` during a blocked load records the account, and the load applies it once it succeeds.
- **Every entry names its account.** An `enqueue` into a model with no owner claims `signedIn` first. Without a signed-in account the enqueue is refused, never stored unowned.
- **A failed wipe inside `Adopt` is loud.** `Adopt` now completes exceptionally, so the runtime logs it. The model is already emptied in memory, so nothing of the old account can be sent while the wipe is retried.

**B2 — signing out while the store load is blocked no longer leaves the engine stuck.** A successful `store.clear()` now sets `ready = true`, because the store is empty and readable.

**B3 — adopt failures are no longer swallowed.** `DeliveryRuntime.adopt` replaces `runCatching`: it rethrows `CancellationException`, logs any other failure (Logcat via the DI `log`), and makes the worker return `retry()`.

**(ii) — deleting the account also deletes its unsent messages.**
- After the server confirms the deletion, `DeleteAccountViewModel` calls `discardForSignOut()`, which deletes the outbox, ops, cache, file rows and kept copies.
- It is best effort: a failed local wipe is retried by the engine and logged, and the account counts as deleted either way.
- The confirmation dialog prepends the same plural line («N неотправленных сообщений будут удалены»).

### TDD

- **RED** — `task-5-fix2-red.log`: 35 tests run, 6 failing:
  - `aStoreReadLateWhileAnotherAccountIsConnectedIsWipedNotSent` (the load fails twice, then succeeds while Кэрол's socket is already up);
  - `aQueueWrittenRightAfterAFailedWipeStillBelongsToItsAccount` (the B→C offline scenario after a failed and retried wipe);
  - `signingOutWhileTheStoreCannotBeReadLeavesAWorkingEmptyQueue`;
  - `aFailedAdoptionIsLoggedByTheRuntime`;
  - `DeleteAccountUnsentTest` ×2.
- **GREEN** — `task-5-fix2-green.log`:

  | Suite | Tests |
  |---|---|
  | `DeliveryEngineTest` | 25 |
  | `DeleteAccountUnsentTest` | 4 |
  | `AccountSafetyViewModelsTest` | 6 |
  | `ChatViewModelOutboxTest` | 13 |
  | `ChatHistoryCacheTest` | 4 |
  | `ProfileViewModelUnsentTest` | 3 |

- **Full run** — `cleanTestDebugUnitTest testDebugUnitTest lint assembleDebug compileDebugAndroidTestKotlin`, in `task-5-fix2-full-gradle.log`: `testDebugUnitTest` executed, **650/650** tests in 102 suites, 0 failures. Lint 0 errors. Build OK.

---

## Fix round 3 (owner on disk; restore ordering; account deletion)

Commits:
- 0abe96b test(android): no real network in the logout storage test
- 59f4ce7 fix(android): nothing of an account reaches disk or screen without its name

### Changes

**Important — the owner is written to disk before anything of that account can be.**

The store now records its owner explicitly:
- `DeliveryStore.setOwner(me)` is new; on Room it writes `delivery_meta.me`.
- `DeliveryEngine.ownerOnDisk` tracks the owner on disk. It is set by load, `setOwner` and persist, and cleared by a wipe.

`claimFor(user)` does nothing only when the model is already `user`'s both in memory and on disk. Otherwise it:
- wipes everything not provably `user`'s — another account's data, or anything written while no account was named (outbox, ops, cancelled keys, message cache, upload rows; Room clears `pending_uploads` in the same transaction);
- writes the owner;
- then claims the empty model.

The stale comment that said "nothing of this account is on disk anyway" is removed.

Writes now require the owner on disk:
- The cache is written only when the owner on disk is the model's `me`. The batched flush checks this, and `persist` sends the cache only with a non-null `me`.
- `AttachmentSends.add` writes a file row only when `engine.ownerOnDisk` is the signed-in account. Otherwise it returns false and the screen shows «Не удалось сохранить файл для отправки».
- `AttachmentSends.restore` loads rows only after `engine.awaitReady()`. By then the engine has checked the owner, so another account's rows are already gone.

No account, no input:
- After an explicit sign-out (`Reset` → `signedOut`), every frame of the still-open old socket is ignored, including `auth_success`, until the next `adopt`.
- While no account is known (`me == null && signedIn == null`), server answers and pages are dropped. `replaceHistory` is refused.

**Minor — a restore never shows another account's messages, even briefly.**
- `restore()` decides the owner first: the account signed in at launch (`engine.start(signedInAs)`, passed by the runtime from the session), otherwise the socket's account.
- If the stored owner differs, the stored model is never built, replayed or emitted; the store is wiped and claimed instead.
- An already-connected socket's `auth_success` is processed only after that owner check.

**Minor — deleting the account always deletes its unsent messages.**
- `AccountRepository.deleteAccount(password, afterServerDeletion)` runs the callback right after the server deletion succeeds, before the local session clear that may throw `SecureStorageUnavailableException`.
- `DeleteAccountViewModel` passes the discard as that callback (best effort; the engine retries a failed wipe).

**Test hygiene.** `ProfileViewModelLogoutStorageTest` used the real network. Its view model's profile refresh resolved a real host and resumed on `Dispatchers.Main` after the test reset it. That intermittently failed `UniversalSearchViewModelTest.rateLimitIsReportedApart` with `UncaughtExceptionsBeforeTest` (seen in 2 of 6 full runs). The test now uses an offline client, and its assertion is unchanged. 5 consecutive clean full runs followed.

### TDD

- **RED** — `task-5-fix3-red.log`: 41 tests run, 5 failing:

  | Test | Scenario |
  |---|---|
  | `DeliveryEngineTest.aFileQueuedByOneAccountNeverGoesUpForTheNextAfterARestart` | The attachment path: B attaches on a fresh store, the process dies, C signs in on the same disk |
  | `DeliveryEngineTest.framesOfTheSignedOutAccountNeverReachTheNextOne` | The cache path: after `discardForSignOut`, the old socket's `new_message` arrives before the next account signs in |
  | `DeliveryEngineTest.aRestoreNeverShowsAnotherAccountsMessagesEvenForAMoment` | The published model is sampled at every step (clock and link probes) |
  | `AccountRepositoryTest.whatFollowsTheServersDeletionRunsBeforeTheLocalClearCanFail` | Callback order around the local clear |
  | `DeleteAccountUnsentTest.aLocalSessionClearThatFailsStillDeletesTheUnsentMessages` | The local clear throws after the server deletion |

- **GREEN and full run** — `task-5-fix3-full-gradle.log` (`cleanTestDebugUnitTest testDebugUnitTest lint assembleDebug compileDebugAndroidTestKotlin`): `testDebugUnitTest` executed, **655/655** tests in 102 suites, 0 failures.

  | Suite | Tests |
  |---|---|
  | `DeliveryEngineTest` | 28 |
  | `DeleteAccountUnsentTest` | 5 |
  | `AccountRepositoryTest` | 8 |
  | `ChatViewModelAttachmentTest` | 15 |

  Lint 0 errors. `assembleDebug` OK.
- **One harness change:** `aFileLeftUploadingComesBackQueuedWithoutAStaleRing` now restarts over the same delivery store, not only the same upload store. In the app both live in one database.

The RetryWipe ordering note was left as is, as instructed.

---

## Fix round 4 (production start path; aborted sign-out; inverted claim; upload owner)

Commit debeba9 — fix(android): the core starts once as the signed-in account; aborted sign-out and failed claims recover.

### Changes

1. **Restore uses the signed-in account in the real wiring.**
   - The DI wiring moved into `DeliveryRuntime.create(...)`. `DeliveryModule` and the unit-test `DeliveryHarness` both use it, so the tests run the app's wiring.
   - Nothing starts inside `create`. `DeliveryRuntime.start()` is the single idempotent start for the engine and `AttachmentSends`. The DI providers for `DeliveryEngine` and `AttachmentSends` derive from the runtime and call `runtime.start()`, so whoever asks first gets a running core.
   - `DeliveryEngine.start()` no longer takes an account. The engine gets `signedInNow = { session.currentUserId }` and reads it inside `restore()`: `owner = signedIn ?: signedInNow() ?: socket`. A start by anyone, including a double start, checks the stored owner against the session before anything is replayed or emitted.
2. **An aborted sign-out leaves the account working.**
   - `OutgoingQueue.signOutAborted()` is new; `DeliveryRuntime` re-adopts `session.currentUserId`. `ProfileViewModel.logout` calls it on both abort paths: the delete failed, or `logout()` threw `SecureStorageUnavailableException`.
   - `Adopt` after a sign-out whose delete never reached the disk (`signedOut && blocked == "wipe"`) drops the pending retry and reads the store again through `restore()` under the owner rule:
     - for the same account, the unsent messages come back and are sent. The screen had said «Не удалось удалить неотправленные сообщения — выход отменён»;
     - for another account, the queue is wiped as before.
   - After a successful delete, `Adopt` claims the empty model. `pickUpSocket` then processes `auth_success` for an already-open socket of that account, so sends and incoming frames resume without a reconnect.
3. **The claim logic is fixed.**
   - An `enqueue` while the queue names no account (`blocked == "owner"`, or `me == null`) tries `claimFor(signedIn)` right away. On success it proceeds; on failure or with no account it is refused (`Outcome(false)`: the composer keeps the text and the screen shows `NOT_SAVED`).
   - A failed `setOwner` inside `claimFor` now sets `blocked = "owner"` and schedules `RetryClaim` with backoff. While blocked, nothing is taken. When the retry succeeds, the open socket is picked up.
   - An entry with `me == null` can no longer be persisted.
4. **Upload owner check.** `AttachmentSends.ownerSignedIn()` now requires `ready && state.me == user && engine.ownerOnDisk == user`.
   - Related change: `forget()` (on `wiped`) clears memory and marks the list for reload. It prunes kept copies **against the rows still stored**, so a delete that failed no longer destroys the files of a queue that comes back.
   - When an account takes the queue again (`me != null && !restored`), the stored rows are listed again and, when online, uploaded.

### TDD

- **RED** — `task-5-fix4-red.log`: covering suites, 74 tests, 6 failing, with the failure messages appended from the JUnit XML:

  | Test | Failure |
  |---|---|
  | `DeliveryEngineTest.aColdStartSignedInAsAnotherAccountNeverShowsThePreviousAccountsQueue` | "nothing of Боб was ever emitted: [k0, 400]". This test uses the DI wiring (`create` + `engine.start()` + `runtime.start()`). |
  | `DeliveryEngineTest.anEnqueueThatNamesItsAccountAfterAnOwnerWriteFailedIsTaken` | A successful claim refused the enqueue. |
  | `DeliveryEngineTest.anEnqueueWhoseAccountCannotBeWrittenIsRefusedAndRetriedNeverStoredUnowned` | A failed claim let the enqueue through. |
  | `DeliveryEngineTest.aFileIsNeverUploadedWhileTheQueueNamesNoAccount` | The file was uploaded under Кэрол with `me == null`. |
  | `ProfileViewModelUnsentTest.aSignOutTheSessionRefusedLeavesTheAccountWorking` | "an enqueue is taken again" |
  | `ProfileViewModelUnsentTest.aSignOutWhoseDeleteFailedLeavesTheAccountWorkingWithItsMessages` | `k1` lost after the abort |

  The RED run used `DeliveryRuntime.create` written to mirror the old DI exactly (engine started inside without an account). All existing tests passed through it.
- **GREEN** — `task-5-fix4-green.log`:

  | Suite | Tests |
  |---|---|
  | `DeliveryEngineTest` | 32 |
  | `ProfileViewModelUnsentTest` | 5 |
  | `ChatViewModelAttachmentTest` | 15 |
  | `ChatViewModelOutboxTest` | 13 |
  | `ChatHistoryCacheTest` | 4 |
  | `DeleteAccountUnsentTest` | 5 |

  0 failures.
- **One test setup correction (no assertion weakened).** In the delete-failed test the store's `clear()` failure is armed just before sign-out. It was first armed at construction, where the startup claim consumed it.
- **Full run** — `task-5-fix4-full-gradle.log`. Command:

  ```
  gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache --max-workers=2 -Dorg.gradle.jvmargs=-Xmx2g cleanTestDebugUnitTest testDebugUnitTest lint assembleDebug compileDebugAndroidTestKotlin
  ```

  - `:app:cleanTestDebugUnitTest` and `:app:testDebugUnitTest` executed. The JUnit XML summary is appended: **suites=102 tests=661 failures=0 errors=0**.
  - Lint: 0 errors, 40 warnings.
  - `assembleDebug` OK (APK 14:45:18).
  - BUILD SUCCESSFUL.

### Emulator evidence

`task-5-fix4-evidence-emulator.md`, `task-5-fix4-1-airplane-queued.png`, `task-5-fix4-2-relaunched-sent.png`, `task-5-fix4-3-signout-confirmation.png`. Setup: Pixel_8, debug APK from debeba9, stand on `SERVER_PORT=2014`.

1. alice turned airplane mode on and sent `T5F4-airplane-144744`. The bubble showed «Ожидает отправки».
2. `am force-stop`. The stored outbox row was queued, with `me=2`.
3. bob saw 0 messages before the relaunch.
4. Airplane mode off, relaunch. bob saw **exactly 1** message (id 160, same `client_msg_id`), and the server DB has exactly 1 row. The app showed «Отправлено» and an empty outbox.
5. Sign-out with an unsent message: the dialog showed «1 неотправленное сообщение будет удалено.». After «Отмена» and going online, the message reached bob exactly once (id 161).

The emulator and stand I started were stopped afterwards.

### Remaining notes

- A second `auth_success` can reach the reducer if a socket's own frame lands right after `Adopt`'s `pickUpSocket`. At worst the head entry is sent again with the same key, which the server de-duplicates.
- An in-flight upload of the previous account that finishes after an `Adopt(C)` claim could still enqueue under C if `forget()` has not run yet. This is a ms-scale race; uploads no longer *start* in that window.

---

## Fix round 5 (in-flight work of the previous account; prune race; cold-start claim retry)

Commit 2337c48 — fix(android): a file or text of one account never enters or uploads under the next.

### Changes

- **(b) An enqueue states its account, and the engine checks it in its single command loop.**
  - `DeliveryEngine.enqueue(..., owner, ownerStated)` adds an `owner` field. This is not a contract field; it is removed before the reducer.
  - In `run(Dispatch)`, **before** the claim branch, an enqueue with a stated owner is processed only when all of these hold: `stated != null`, not blocked, not signed out, `current.me == stated`, `ownerOnDisk == stated`.
  - Otherwise it is refused (`Outcome(false)`, the composer keeps the text), and nothing is ever claimed on its behalf.
  - Because the check runs in FIFO order, an `Adopt(C)` queued earlier always decides first.
  - Who states the owner:
    - `AttachmentSends.upload` states the file's account, captured when the upload was launched;
    - `ChatViewModel.send` states `screenAccount`, the session account captured when the screen was created.
- **(b) Upload jobs carry their owner.**
  - `AttachmentSends` keeps `owners[clientMsgId]`. It is set from `engine.ownerOnDisk` when rows are read after `awaitReady`, and from the adding account in `add`. It is cleared by `forget`, `reset`, `cancel` and handover.
  - `launchUpload` needs that owner and passes it to the job.
  - `ownedBy(account)` requires that the engine is ready, `owner() == account`, `me == account` and `ownerOnDisk == account`. It is checked twice:
    - at launch;
    - again when the job starts, with no suspension between that check and `files.upload(...)`, where the token is attached.
  - The enqueue after the upload also states the account, so a switch while the upload is in flight is caught by the engine.
- **Minor — kept-copy prune race.** `forget()` now reads `store.all()` and runs `pruneKept` under the `loaded` lock. `add()` now writes `keep` and `put` under the same lock (new `keep(...)` helper).
- **Minor — cold-start claim retry.** `RetryClaim` claims for `signedIn ?: signedInNow()`.
- **Left as is (documented, per ruling):**
  - the duplicate `auth_success` resend (the server de-duplicates);
  - the `logout()`-threw hook is a no-op in production (the session is already cleared in memory);
  - the handed-over copy is pruned when a sign-out's delete fails.

### TDD

- **RED** — `task-5-fix5-red.log`: covering suites, 79 tests, 5 failing, with failure messages from the JUnit XML. The Cyrillic in those messages is mis-decoded by the console; the assertions are in the test files.

  | Test | Before the fix |
  |---|---|
  | `AccountSwitchUploadTest.anUploadThatFinishesAfterTheSwitchNeverEntersTheNextAccountsQueue` | Боб's file was in Кэрол's outbox. |
  | `AccountSwitchUploadTest.anUploadDispatchedBeforeTheSwitchNeverStartsUnderTheNextAccount` | Боб's file was uploaded under Кэрол's session. |
  | `AccountSwitchUploadTest.aFileAddedWhileTheOldCopiesArePrunedKeepsItsCopy` | The new copy was pruned (`kept=[]`). |
  | `DeliveryEngineTest.aClaimThatFailedAtAColdStartIsRetriedForTheSessionsAccount` | `me` stayed null. |
  | `ChatViewModelOutboxTest.aMessageWrittenOnTheScreenOfAnAccountThatIsNoLongerSignedInIsNotTakenIntoTheNext` | The composer cleared: the text was taken into the next account's queue. |

  - `AccountSwitchUploadTest` runs the engine unconfined and the file queue on its own queued dispatcher (same scheduler), so the test fixes what has run at the moment of the switch.
  - After RED, the composer test was changed to give the screen the harness's own session, so the switch happens on the same session instance as in the app. The assertions are unchanged. That made the production fix capture the screen's account (`screenAccount`) instead of reading the live session.
  - The fake `FakeAttachmentRepository` now tracks live copies (`keptNow`, pruned by `pruneKept`).
- **Mutation** — `task-5-fix5-mutation.log`. With the job-start `ownedBy` check removed and the engine's stated-owner check reduced to `stated == null || blocked || signedOut`, 3 tests fail. Both changes were reverted.
- **GREEN** — `task-5-fix5-green.log` (clean, then covering suites), 0 failures:

  | Suite | Tests |
  |---|---|
  | `AccountSwitchUploadTest` | 3 |
  | `DeliveryEngineTest` | 33 |
  | `ChatViewModelOutboxTest` | 14 |
  | `ChatViewModelAttachmentTest` | 15 |
  | `ChatHistoryCacheTest` | 4 |
  | `DeleteAccountUnsentTest` | 5 |
  | `ProfileViewModelUnsentTest` | 5 |

- **Full run** — `task-5-fix5-full-gradle.log` (`cleanTestDebugUnitTest testDebugUnitTest lint assembleDebug compileDebugAndroidTestKotlin`, `--max-workers=2`):
  - `cleanTestDebugUnitTest` and `testDebugUnitTest` executed: **suites=103 tests=666 failures=0 errors=0**;
  - lint 0 errors, 40 warnings;
  - `assembleDebug` OK (APK 15:08:21);
  - BUILD SUCCESSFUL.

### Emulator

Not re-run, per instruction. The send-path change is the stated-owner check, which the unit tests cover. The owner on disk comes from the same `delivery_meta.me` that `load()` reads, and round 4 exercised that on the device.
