# Task 11 — final whole-branch review: Android (`mobile/android/**`)

Range `master..mobile-release-parity-impl` (HEAD 07420d0), 337 files, +41 283 / −3 662. I reviewed the code only: no Gradle build and no emulator, as the brief asked.
Paths below are relative to `mobile/android/app/src/main/java/com/openmychat/mobile/` unless they say otherwise.

## CI status

- `mobile-release-parity-impl`: the latest PR runs are green: mobile-android 37460358916, security-checks 37460359012 and mobile-ios 37460358932.
- `mobile/android` lane: mobile-android is green on 7bf6827 (run 37433478839). security-checks is red on the same push (37433478863), but the cause is `npm audit` in `server/` (proxy-addr, critical), not Android. The same job is green on the integration branch.

## What holds (verified in code)

- **Persist before the barrier.** `DeliveryEngine.process` (`data/delivery/DeliveryEngine.kt:520-547`) writes the slices in one Room transaction (`DeliveryDao.persist`, `store/DeliveryDatabase.kt:168-190`) before it publishes the state or runs any effect. A failed persist follows §5 for each event kind (`:550-563`).
  - The composer clears only when `outcome.persisted` is true and there is no `user_error` (`features/chat/ChatViewModel.kt:441-449`).
- **A failed load fails closed.** `restore()` sets `blocked = "load"` and retries with backoff (`:471-482`). Commands that arrive meanwhile are refused, not persisted (`:303-308`).
- **The outbox is owned by an account.**
  - `claimFor` wipes first, writes `setOwner` to disk, and only then sets `me` (`:379-400`).
  - Ownerless or foreign content is wiped, never claimed (`:489-492`).
  - An `enqueue` that states an owner is taken only when both `current.me` and `ownerStored` match (`:281-290`).
  - The cache is written only under its owner (`:367`, `:531`).
- **Exactly one sender.** The socket pump, the WorkManager flush (`work/DeliveryFlushWorker.kt`, `DeliveryRuntime.flushInBackground`) and the uploads all go through one serial engine queue and one `AttachmentSends.jobs` map. The flush stops as soon as the socket is online (`DeliveryRuntime.kt:118`).
- **An involuntary 401 keeps the outbox.**
  - The session ends only when a refresh gets 401/403 (`core/network/RefreshFailurePolicy.kt`, `ApiClient.kt:65-96`). An unreachable refresh fails the request as a network error (`SessionAuthenticator.kt:63-65`).
  - The runtime wipes the queue only on an explicit sign-out or when another account adopts it (`DeliveryRuntime.kt:89-94`).
- **Sign-out asks first.** It has a single path: a confirmation that states the unsent count (`features/profile/ProfileScreen.kt:297-307`). Next it calls `discardForSignOut`, which fails loudly and aborts the sign-out (`ProfileViewModel.kt:220-244`). Deleting the account states the unsent count as well.
- **showsMeta and FIFO** are as Task 5 reported (`features/chat/ChatPresentation.kt:119`). The reducer vectors are 70/70 green in CI.
- **Attachments.**
  - The open type is the extension, filtered through an exact mirror of the server's `SAFE_DOWNLOAD_TYPES` (`features/attachments/AttachmentIntents.kt:19-56`, compared with `server/src/api/index.js:2086-2099`).
  - FileProvider: `exported=false`, `grantUriPermissions`, and only `cache/attachments/` is shared.
  - Range and If-Range resume checks the 206 `Content-Range` start, and handles 416 and 304 (`AttachmentDownloader.kt`).
  - An upload streams from a private copy in `noBackupFilesDir` (`FileTransferClient.StreamBody`).
- **Security.**
  - The release build is fixed to `https://centychat-production.up.railway.app`, twice: once in `build.gradle.kts` and once in `ServerConfig.resolve`. The connect-to-server screen is deleted.
  - Dev-CA trust and the localhost cleartext exception live only in `src/debug`. The debug-only activities are exported only in the debug manifest.
  - Tokens are in EncryptedSharedPreferences on Keystore and fail closed (`SessionManager`), and they are excluded from backup together with `delivery.db`.
  - The only log call is `Log.w("Delivery", message, error)`, which logs no tokens or passwords.
  - The push parser accepts ids only. The production host appears in tests only as a string assertion.
- **Registration, deletion, reports and blocks** follow `registration.md`. Errors are mapped from the `code`. Retry-After is honoured for register, verify, delete and block. On deletion the server goes first, then the session and the device secret are wiped, then the queue is discarded.
- **R8.** Release minification is on and CI runs `assembleRelease`. The rules are deliberately empty: kotlinx-serialization 1.11, Room 2.8, WorkManager and Hilt ship their own consumer rules, and Task 6 ran an R8 build on the emulator.

## Critical

None.

## Important

### I1. Sign-out does not revoke the device secret, so on an admin-paired device the user is signed back in without a password

Where:
- `data/repository/AuthRepository.kt:106-114`
- `core/network/ApiClient.kt:264-276`
- `core/session/SessionManager.kt:351-361`
- `features/auth/LoginViewModel.kt:126-137` and `features/auth/LoginScreen.kt:131`

The defect:
- `apiClient.logout()` posts `{}` with no `device_id`, so the server does not unbind the secret (`server/src/api/index.js:742-746`).
- `clearSession()` removes the token, the user and `must_change_password`, but not `KEY_DEVICE_SECRET`.
- Since b9e5f1a, the login screen knocks with the stored secret every time it is shown.

Scenario:
1. B signs in on a phone the administrator has paired to B. The claim succeeds and the secret is stored.
2. B taps «Выйти» and confirms. Unsent messages are deleted.
3. The next time the login screen knocks, the server answers `paired` and the app enters as B, with no password. This happens at the latest after a process restart, or at once if the login entry has a fresh view model.

The server comment at `index.js:415-419` (audit finding №9) says the secret must not outlive a sign-out. iOS gets this right: `APIClient.swift:470-474` sends `device_id` and `clearAllAuthData()` deletes the secret.

Fix:
- Send `{"device_id": deviceId}` in `/auth/logout`, or call `/auth/device/unbind` while the token is still valid.
- Clear `deviceSecret` locally and fail closed: `clearSession` returns false if the delete fails.
- Optionally match iOS and knock only when a stored session or secret existed at launch.
- Test: sign out, then show the login screen, and assert that no knock is sent and the secret is gone.

### I2. Uploads ignore the server's limit of two at a time and its temporary refusals, so files the user queued turn into «не отправлено»

Where: `features/chat/AttachmentSends.kt:100`, `:117`, `:209`, `:271-284`, `:327-341`.

The defect:
- When the app comes back online, and in `flush()`, `pendingKeys().forEach(::launchUpload)` starts every waiting file at once.
- The server allows two parallel uploads per user (`MAX_PARALLEL_UPLOADS = 2`). Beyond that it answers 429 «Дождитесь окончания текущих загрузок» (`index.js:2148`, `:2192`).
- Every status other than 0 is treated as a refusal: the file is marked `failed` and a snackbar is shown. This includes 429 with Retry-After (the hourly quota), 503, 507 with Retry-After (low disk), other 5xx, and an involuntary 401 (see M2).

Scenario: the user queues three photos offline and the network comes back. Two upload; the third fails with «Дождитесь окончания текущих загрузок» and waits for a manual «Повторить». The same happens with a background flush and with a brief 503.

iOS handles this: `AttachmentUploads.maxConcurrent = 2`, and 429 is treated as a wait.

Fix:
- Limit uploads to two at a time, as a FIFO by `createdAt` behind a `Semaphore(2)`.
- Treat 0, 408, 429 and 5xx/507 as temporary: keep the file queued and retry after `max(Retry-After, retryDelayMs)`, with a cap such as the delivery `MAX_ATTEMPTS` before `failed`.
- Treat a 401 as queued.
- Keep 4xx refusals (413, 400, and 403 from policy) as `failed`.
- Tests: a third file waits for a free slot; a 429 with Retry-After keeps the file queued.

### I3. A notification-tap intent is trusted from any app: another app can open a chat with a fake title

Where:
- `MainActivity.kt:64-76` (the exported launcher activity)
- `data/notifications/SystemNotificationSink.kt:36-40`
- `ui/navigation/CentyNavigation.kt:475`, `:484`

The defect: `chatFromNotification` turns `conversationType`, `targetId` and `title` extras from any `Intent` into `NavKey.Chat`. The title is shown unchecked in the top bar, in the avatar initials and on the person card.

Scenario: a malicious app on the device starts `com.openmychat.mobile/.MainActivity` with `targetId=<the attacker's own user id>` and `title="Иванов И.И. (Генеральный директор)"`. The signed-in user sees a chat with "the director" and writes confidential information to the attacker.

Fix: choose one.
- Route notification taps through a non-exported trampoline activity, or through an activity-alias with `exported=false` that the PendingIntent targets explicitly. MainActivity then ignores these extras on its exported entry.
- Keep the title out of the intent and resolve the name from the people directory or the conversation list.

Test: an intent without the trampoline marker opens no chat.

### I4. HTTP requests are not bound to the account they were made for, so a late request can run as the next account or end its session

Where:
- `core/network/RefreshCoordinator.kt:14-16` and `SessionAuthenticator.kt:46-67`
- `BearerCredentialsInterceptor.kt:149-166`, where the token is read at dispatch
- `ApiClient.kt:474` and `:544-548`
- `data/delivery/DeliveryAdapters.kt:77-80`

There are two defects.

First, when a request's token differs from the current one, the authenticator replays the request with the current token without checking that it belongs to the same account. A request sent with no token gets the current account's freshly refreshed token.

Second, any 401 that reaches `raw()` or `handleErrorResponse` calls `clearSession()`, whichever account's token was refused.

Scenarios:
- B's session is rejected while a background-flush POST `/messages/direct/7` or an upload of B's file is in flight; the worker keeps looping for up to 20 rounds. C signs in.
  - The late 401 is replayed with C's token. B's text is posted from C's account to B's contact, or B's file is stored in C's account.
  - The engine's epoch check drops only the result, after the request has already been sent.
- Conversely, once the replay is suppressed, B's late 401 would sign C out.

This covers the parked item «upload Authorization read at OkHttp dispatch time» and the Task 5 deferred minor «HttpDeliveryBackend/RealtimeDeliveryLink use current session token». The window is narrow, but the result is a cross-account send in a corporate messenger.

Fix:
- Tag every request made for an account with its owner (an OkHttp `tag(Owner(userId))` from `HttpDeliveryBackend.post`, the uploads and the downloads). The interceptor attaches a token only while `currentUserId == owner`.
- In the authenticator, never replay a request that had no token, or whose token's `userId` claim differs from the current one (the JWT payload carries `userId`).
- Clear the session on a 401 only if the refused token is the current token.
- Tests: an owner mismatch is never sent; a late 401 with an old token leaves the new session alone.

## Minor

| # | Where | Scenario | Fix | Ruling |
|---|---|---|---|---|
| M1 | `features/chat/AttachmentSends.kt:192-204`, `:302-311` | The upload has returned, and «Отменить» is tapped while `engine.enqueue` is queued: `job.cancel()` cancels only the await, so the Dispatch still runs and the file message is **sent**. This breaks principle 6, «отменённое не доставляется». | Record the cancelled keys. After the enqueue, if the key was cancelled, call `engine.cancel(key)`, or check under the engine lock before the enqueue. | **Fix before release** (about 10 lines, explicit contract principle) |
| M2 | `AttachmentSends.kt:330-341` | When the session expires during an upload, the 401 marks the file `failed` with the server's text, where a text message would go back to `queued` (§7.3). | Classify 401 as queued (part of I2). | Fix with I2 |
| M3 | `data/notifications/MessageNotifier.kt:104-108`, `SystemNotificationSink` | After B signs out, or C signs in, B's notifications with message text stay in the shade. Tapping one opens `direct:X` in C's session. | `sink.cancelAll()` when the token goes null or the account changes. | Fix before release (privacy, cheap) |
| M4 | `ChatViewModel.kt:469`, `AttachmentSends.kt:141-144` (parked item 2) | A stale screen of B (a race during an account switch) adds a file under the live owner C, into B's conversation key. | Pass `screenAccount` into `add` and refuse when `owner() != account`. | **Fix before release** (one line) |
| M5 | `src/main/AndroidManifest.xml:23`, `build.gradle.kts:45` (minSdk 26) | The release build has no network security config. On API 26–27, cleartext is allowed by default, so an `http://` avatar URL from the server would be fetched in clear text. | `android:usesCleartextTraffic="false"` on `<application>` in main; the debug config overrides it for localhost. | Fix before release (one attribute) |
| M6 | `ApiClient.kt:46`, `:53`, `:115` | The setters `sessionManager.token` and `mustChangePassword` throw `SecureStorageUnavailableException` (a RuntimeException) inside an OkHttp interceptor or authenticator. On async calls (uploads, downloads), OkHttp 4 rethrows it on the dispatcher thread and the process crashes. | Catch the exception in the lambdas, convert it to an `IOException`, and mark the storage unavailable. | Accept for release; harden next |
| M7 | `DeliveryEngine.kt:553` | A persistent disk error on a server event makes `link.restart()` reconnect immediately each time: a tight loop of reconnect and sync (Task 5 deferred). | Back off the restart by consecutive persist failures. | Accept (disk full is rare); hardening |
| M8 | `features/account/BlockController.kt`, `AccountRepository.block` | After a block, the blocked DM's cached messages stay in `delivery.db` until the next history load. `registration.md` §4 recommends clearing the cache. | Call `engine.replaceHistory(conv, [], stale = all)` on a successful block. | Accept |
| M9 | `gradle/libs.versions.toml` (`securityCrypto = 1.1.0-alpha06`) | EncryptedSharedPreferences is an alpha that is deprecated upstream. | Plan a migration to a Keystore-wrapped DataStore. | Accept |
| M10 | Registration sign-in (Task 3 ledger) | Android skips `claimDevice` after verify-200; iOS claims. | Claim after `RegistrationOutcome.SignedIn`, once I1 is fixed. | Accept (parity, not security) |

## Rulings on the parked items and the Android deferred minors

- **Parked 1** (the upload Authorization header is read at dispatch, not bound to the job's owner): **fix before release** as part of I4. The authenticator's token substitution widens it beyond uploads.
- **Parked 2** (a stale screen's `sendAttachment` uses the live owner): **fix before release** (M4, one line).
- **Task 3:**
  - Registration skips `claimDevice`: accept (M10).
  - `ConversationsViewModel.loadData` is not serialised; a slow `refreshBlocked` can overwrite a block made meanwhile; a WS message from a blocked person can re-add the DM: **accept**. Each heals on the next reload, and the server does not deliver frames from blocked people.
- **Task 4:**
  - The «Файл пустой» wording; the Photo Picker name as the caption (desktop parity); the tile kind taken from the sender's mimeType (display only); an in-flight thumbnail repopulating the cache after a wipe (the same URL needs the same access): **accept**.
  - The ~30 s WS reconnect after the picker or viewer (pre-existing): **accept**. With I2, note that uploads also wait for `online`.
  - The size of `ChatViewModel`: accept.
- **Task 5 (line 75):**
  - The tight reconnect loop: accept (M7).
  - The upload cancel race: **fix** (M1).
  - The admin delete ignoring a `sendFrame` false: accept. It is a silent no-op while offline; a notice is a cheap follow-up.
  - Text overtaking a file being uploaded: accept (documented).
  - The list's own unread count and two GETs per sync, the missing `CANCELLED_MAX` vector, the weak persist-ordering assertion (I verified the order in the code), and `LocalSendTimes` never pruned: accept.
  - «Background flush not run on device»: **a release checklist item, not code**. Run the airplane-mode → background → WorkManager scenario once on the stand.
- **Task 5 (lines 85, 94, 103, 108):** accept them all. The emulator scenario (the real authenticator, the logout dialog, a forced 401) belongs on the release checklist.
- **Task 5 (line 99), current-token adapters:** **fix** with I4.
- **Task 6 (line 139):**
  - The NotificationPermissionPrompt sheet and the R8 frame drops: **release checklist**. Check them on a physical device before the store build.
  - The rest (screenshot pairing, tick state, bubble width step, the PriorityBadge rename): accept.

## Release-readiness notes (not findings)

- There is no `signingConfig` for release and `versionCode = 1`: signing is left to the release process.
- Android has no FCM integration yet (parity-matrix D10). Messages arrive only while the process holds a socket; the WorkManager flush covers sending only.
- Calls use `RECORD_AUDIO` without a microphone foreground service, so calls in the background on API 34+ lose the microphone. This is pre-existing and out of scope here.
- `delivery.db` (the outbox and cached message text) is stored in app-private storage without encryption, protected by file-based encryption and excluded from backup. Acceptable, but worth recording.

## Verdict

**Ready after fixes.** Fix I1–I4 and the cheap minors M1, M3, M4 and M5. Then re-run `testDebugUnitTest lint assembleRelease` in CI and the on-device release checklist above: the background flush, the forced 401, sign-out with an unsent message, and the R8 frame check.
