# Task 11 final review: iOS (`mobile/ios`, excluding Task 10)

Reviewer: Opus, read-only. Range `master..mobile-release-parity-impl` (head 07420d0). Task 10 (`origin/mobile/ios`) is not reviewed here. Where it touches the same files, that is noted as a conflict risk.

## Verdict: **Ready after fixes**

I found no Critical issues. The delivery core matches `delivery-state.md` and its ownership rules hold up. Four Important items remain:
- three are code fixes (I1, I2, I3);
- one is a release-configuration step that is blocked on the Apple developer account (I4).

## CI evidence (no Mac available)

`mobile-ios` run 37460358932 (PR, head 07420d0) passed:
- `ios-simulator-tests`:
  - 456 unit tests, 0 failures.
  - `DeliveryReducerVectorsTests.testEveryReducerVectorPasses` passed. It loads the whole `contracts/fixtures/reducers` folder (70 files; the test asserts ≥70 and that every file passes) and checks exact effects, the state keys, and that the input state is never changed. `testTheStateProjectionRoundTripsEveryInitialState` also passed.
  - 15 UI tests passed.
- `ios-release-server-lock`: Release built with `CENTYCHAT_SERVER_URL=https://override.invalid`. The production URL is compiled in, and none of the checked Debug override strings are present.

Build warnings: no Swift concurrency or Sendable warnings. There are only 4 deprecation warnings (`updatePresence`), which were already there. All targets build in Swift 6 language mode (`SWIFT_VERSION = 6.0`), so data-race safety is checked when the code compiles.

## What was verified OK

**Delivery core (`DeliveryEngine.swift`)**
- **One serial queue** (`submit`/`drain`, MainActor). Every entry point goes through it: frames, enqueue, history, adopt, reset, discard, and the background flush. As a result there is exactly one sender. The socket pump and `flushInBackground` share the queue, and `flushInBackground` returns as soon as `connection == online`.
- **Persist barrier.** In `process`, `persist` is executed before `setState` and before any other effect. If the persist fails, the state is dropped, and recovery depends on where the event came from: user events are refused (the composer keeps its text), server events trigger a socket restart with backoff, and other events are retried.
- **Failed load fails closed.** `restore` sets `blocked="load"`. While blocked, everything is refused and repair is retried with backoff. Nothing is ever deleted to "repair" the store (there is no destructive migration).
- **Account-owned outbox.**
  - `claimFor` wipes a foreign or ownerless model before claiming it.
  - `restore` deletes another account's stored model, or an ownerless one that holds data, without loading it, when an account is known.
  - Every on-disk write carries `me`: `persist` and `writeCache` write `meta.me`, and upload rows carry `owner`. The owner is not written at the moment of claim, but an ownerless store is never claimed later, so the effect is the same.
- **Owner checks inside the serial loop:** `dispatchNow` (`ownerMatches`, the `takenOnlyForAnAccount` set after sign-out), `replaceHistory`, and `historyPage(owner:)`. An `auth_success` from another user wipes the model. Uploads are owner-gated by `mayUpload` and the `restore` filter.
- **Involuntary 401 keeps the outbox.** `sessionDidEnd` wipes caches only. `raw()` and the streaming upload treat a refresh that got no answer as a network failure (status 0). Credentials are cleared only on a refresh answered 401/403.
- **Password-change chain.** `remember(new, replacing: old)` lets requests holding the old token follow the chain.
- **Explicit sign-out and account deletion** show the unsent count through `UnsentNotice`. An unreadable store gives "count unknown". The discard is all-or-nothing, and an aborted sign-out re-adopts the queue.
- **Composer.** It clears only on `composerCleared` (the enqueue reached disk). Text typed while the message was being stored is kept (`ComposerText.afterSend`).

**Attachments**
- **Open type** comes from the file extension via `UTType`, filtered by `safeOpenTypes`. That list is an exact copy of the server's `SAFE_DOWNLOAD_TYPES` (`server/src/api/index.js:2086`). Safe types open in Quick Look; anything else goes to the share sheet. The sender's `mimeType` is never used.
- **Resume:** Range + If-Range. A 206 is checked against the `Content-Range` start, a 416 drops the partial and asks again, and a finished copy is revalidated with If-None-Match.
- **Downloader:** generation guard with deduplication of in-flight downloads.
- **Uploads:** at most 2 at once, `Retry-After` honoured, and the multipart body is streamed from a temporary file (`upload(fromFile:)`).

**Security**
- **Server pinning.** Release is pinned to `https://centychat-production.up.railway.app` with HTTPS/WSS only. Every override is inside `#if DEBUG`, and the connect-to-server screen has been deleted.
- **ATS:** no exceptions in Info.plist.
- **Test flags.** `-centychat-stub-account`, `UITestAccountRepository` and `-allow-insecure-loopback` are compiled out of Release. They also require `CENTYCHAT_UI_TESTING=1`.
- **Token handling.** The Bearer token is sent only to the configured origin, and redirects are refused for avatars, downloads and uploads.
- **Logging.** Nothing logs a token or password (no `print`). All logging goes through `os.Logger`.
- **Push payloads** carry ids only.
- **Tests** never reach the production host. CI builds with `CENTYCHAT_SERVER_URL=https://localhost:8443`, and every UI test passes `-centychat-server-url`.
- **Commit e2a620c (controller CI fix).** The `passwordContent` switch to `.oneTimeCode` is gated by `LaunchTestFixture.suppressesPasswordAutofill`, which is the constant `false` in Release. It is correct.

**Accounts, people and push-token calls**
- **Registration:** 503 BUSY is treated as a wait (Ruling D), and `completeRegistration` calls `claimDevice` (closes Task 3's parity question).
- **Delete account** asks for the password and shows the unsent count.
- **Reports and blocks** work as specified.
- **Push token** is registered after each sign-in and launch, and again whenever the token changes.
- **Contact links** are built with URLComponents, so a `mailto:` cannot carry `?`/`&`.
- **People cache** belongs to its owner and is wiped on sign-out.
- **Avatars** load only from the own-origin avatar path.

## Critical

None.

## Important

### I1. A locked device makes the stored token look absent, and the session ends with no refresh rejection

**Where:**
- `CentyChat/Core/Storage/KeychainManager.swift:203` (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).
- `KeychainManager.swift:222-235`: `value(forKey:)` maps every status other than success, including `errSecInteractionNotAllowed`, to `nil`.
- `CentyChat/Core/Network/APIClient.swift:100-102` and `:231-233`: a nil token becomes `.unauthorized` or 401 without any request being sent.
- `CentyChat/App/Stores/SessionStore.swift:356-364`: `revalidate` treats that as a definitive rejection.

**Failure scenario:**
1. The user is on a call (`UIBackgroundModes: audio` keeps the app running) and presses the lock button.
2. About 10 seconds later, WhenUnlocked items can no longer be read.
3. The socket drops (network change, or the server restarts), and `connect()` reads a nil token (`WebSocketClient.swift:86`).
4. The resulting `server_disconnect` or `auth_error` leads to `revalidate`. `auth.currentUser()` throws `.unauthorized` without contacting the server.
5. `clearStoredCredentials` runs. The knock then fails too: `deviceID()` cannot read the id, and saving a new one also fails.
6. `endSession` runs, `sessionDidEnd` stops the call (`AppContainer.swift:309`) and wipes caches, and the user lands on the login screen.

This breaks "the session ends only on a definitive refresh rejection". The outbox survives because it is owned on disk.

**Fix:**
- Use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Existing items get the new class on the next save, since `save` passes `kSecAttrAccessible` to `SecItemUpdate`. Also add a one-time re-save at launch.
- Make reads distinguish "not found" from "unavailable": throw `.unavailable(status)` for anything other than `errSecSuccess` or `errSecItemNotFound`.
- Map "unavailable" to a transient error (like `.noConnection`) in `APIClient`.
- In `connect()`, skip connecting while the token cannot be read.
- Add a test that uses a fake item store returning `errSecInteractionNotAllowed`.

### I2. A cold launch while offline (or while the server returns 5xx) drops a valid session to the login screen

**Where:** `SessionStore.swift:163-177`. In `restoreStoredSession`, the catch-all at :172-175 sets `phase = .signedOut`. `RootView.swift:22` then shows `LoginView`, and nothing retries the restore.

**Failure scenario:**
1. The user queues messages while in airplane mode (or the app is killed), then launches the app with no network, or while Railway is redeploying.
2. `/auth/me` fails, an "Ошибка" alert appears, and the login screen is shown.
3. The queued messages and cached chats cannot be reached, and nothing new can be composed offline, even though the durable outbox exists for exactly this case.
4. Recovery requires typing the password while online, or killing and relaunching the app.

Android goes straight to the authenticated route from the stored token. This behaviour was already on master (`AppState.swift:87-89`), but the branch's offline-queue promise (Task 9 acceptance) makes it a regression in practice. `OfflineQueueUITests` misses it because `-centychat-ui-delivery-offline` keeps sign-in and history online.

**Fix:**
- Store a minimal snapshot of the signed-in user, either in the delivery `Meta` row next to `me` or in the Keychain, at every `enter`.
- On a non-auth error with a stored token, `enter(snapshot)` in an offline-authenticated phase: the realtime client keeps retrying with backoff.
- Revalidate on the first `auth_success` or on `networkBecameAvailable`. Only `.unauthorized` (a refresh refused) or `mustChangePassword` should leave that phase.
- At the very least, keep `.launching` and retry `bootstrap` on `networkBecameAvailable` instead of showing the login screen.
- Add a unit test: stored token, `currentUser` throws `noConnection`, phase is not `.signedOut`.
- Conflict risk: Task 10 makes a small edit to `SessionStore.swift`. Apply this fix after the Task 10 merge.

### I3. The privacy manifest does not declare UserDefaults, so an App Store / ABM upload will be rejected

**Where:** `CentyChat/Resources/PrivacyInfo.xcprivacy:113-123` declares only `SystemBootTime`. The app writes `UserDefaults.standard`: `AppContainer.swift:215` → `SearchRecents.swift:51`.

**Failure scenario:** App Store Connect has required this declaration since 2024-05-01. The first TestFlight, App Store or Apple Business Manager custom-app upload fails processing with ITMS-91053 ("Missing API declaration: NSPrivacyAccessedAPICategoryUserDefaults").

**Fix:**
- Add `NSPrivacyAccessedAPICategoryUserDefaults` with reason `CA92.1`.
- Run Xcode's "Generate Privacy Report" on the archive to check the other categories. In particular, check file timestamps (`attributesOfItem` is used for sizes in `AttachmentUploads.swift:50` and `AttachmentDownloader.swift:102`; add `C617.1` if Xcode flags it).

### I4. Push cannot work in this build: no entitlements and no remote-notification background mode

**Where:**
- No `.entitlements` file exists, and `CODE_SIGN_ENTITLEMENTS` is not set in `project.pbxproj:174-175`.
- `Info.plist:40-43` lists only `audio` in `UIBackgroundModes`.
- `PushRouting.swift:28` registers for remote notifications anyway.

**Failure scenario:**
- In any Release build, `registerForRemoteNotifications` always fails because there is no `aps-environment`, so the server never gets a token and nobody receives message pushes.
- Even after the entitlement is added, the silent `read` pushes (`multi-device.md` §10, `didReceiveRemoteNotification`) will not wake a suspended app without `remote-notification` in `UIBackgroundModes`.
- `PushTokenRegistration.Environment` is chosen by build configuration (`PushTokenRegistrar.swift:83-89`), so a development-signed Release build would report `production` for a sandbox token (Task 8 concern 4).

This is a known, intentional deferral (plan Task 8: "inactive without an account"), but it blocks release: a messenger without pushes, and without a BGTask, delivers nothing while the app is closed.

**Fix (at signing time):**
- Add `CentyChat.entitlements` with `aps-environment`, and set `CODE_SIGN_ENTITLEMENTS`.
- Add `remote-notification` to `UIBackgroundModes`.
- Derive the push environment from the provisioning profile (`embedded.mobileprovision` → `Entitlements.aps-environment`) or from a build setting, not from `DEBUG`.
- Verify end to end on a device with the APNs key on the server.

**Ruling:** this must be done before an external release. If the owner chooses to ship v1 without pushes, record that explicitly in the release notes.

## Minor

**M1. A file cancelled while it is being handed over is still sent** (`AttachmentUploads.swift:301-317` and `:545-578`). The upload finishes and `handOver` is waiting in `engine.enqueue`; the user taps «Удалить» at that moment. `cancel()` removes the item, but cancelling the `running` task does not stop the enqueue (a checked continuation ignores cancellation), and `cancel` does not change `epoch`. The entry lands in the outbox and is sent. The bubble disappears, then reappears and goes out. This breaks "cancelled messages are never sent" (the Android ledger has the same race). **Fix:** keep a `cancelledKeys` set. After `engine.enqueue` returns `persisted`, if the key was cancelled or is no longer in `items`, call `await engine.cancel(clientMsgId: key)` and discard the copy. Add a test using a gated engine store. **Ruling: fix before release** (cheap, and it protects a contract invariant).

**M2. Uploads retry forever, every 15 s, from byte 0** (`AttachmentRules.swift:78-84`, `AttachmentUploads.swift:139`). A server that keeps answering 5xx after receiving the body (storage error), or a flaky cellular link, makes the app re-send up to 100 MB every 15 s with no cap. That can mean gigabytes of mobile data per hour. **Fix:** exponential backoff (15 s → 10 min) on 5xx and transport failures, a 5xx budget after which the file is marked failed with «Повторить», and a reset on success or on network change. **Ruling: fix before release** (ledger Task 9 item "uploads retry forever on 5xx").

**M3. Sign-out asks only when something is unsent** (`Features/Profile/ProfileView.swift:126-131`). With an empty queue the tap signs out immediately; Android always shows a confirmation dialog. The count is also read at tap time, so a message queued while the alert is open is deleted without being counted. **Fix:** always confirm, and recompute the count when the user confirms. **Ruling: fix after the Task 10 merge** (Task 10 rewrites `ProfileView`, so there is a conflict risk).

**M4. Account deletion: the server deletes the account, then the local Keychain wipe fails, and the user is told it failed** (`APIClient.swift:427-433`, `AccountStore.swift:117-122`). `clearAllUserData()` throws after `DELETE /users/me` returned 2xx. `finishAccountDeletion` is skipped, so the gone account's unsent messages are never discarded and the UI says deletion failed. Android fixed this in Task 5 round 3. **Fix:** clear the Keychain on a best-effort basis after the server succeeds (log any failure), and always call `session.finishAccountDeletion()`. **Ruling: fix** (one-liner, parity).

**M5. The release-lock CI guard does not cover every test hook** (`scripts/verify-release-server-lock.sh:29`). The forbidden list lacks `-centychat-stub-account`, `CENTYCHAT_STUB_SIGNIN`, `-allow-insecure-loopback` and `UITestAccountRepository`. They are compiled out today, but nothing would catch a regression. **Fix:** add these four strings. **Ruling: fix** (trivial).

**M6. Attachment downloads, thumbnails and avatars do not refresh the token on 401**, and the download stream is read byte by byte.
- `AttachmentTransport.swift:318-350` (also `AttachmentThumbnails`, and avatars per Task 8 concern 7): after the token expires, a tap shows the server's refusal until some other request happens to refresh it.
- `AttachmentTransport.swift:365` iterates `URLSession.AsyncBytes` one byte at a time. For a 100 MB file that costs a lot of CPU and is slower than fast Wi-Fi.

**Fix:** on 401, call a refresh hook on `APIClient` (the same chain rule) and retry once. Use a `URLSessionDataDelegate` `didReceive data` stream, or a download task with resume data. **Ruling: accept for v1**, fix in hardening.

**M7. Info.plist hygiene for App Review** (`Info.plist:21`, `:32-37`).
- Camera, photo-library read and photo-library add usage strings are declared, but the app uses none of these APIs (PhotosPicker needs no permission, and nothing is saved to Photos). The camera string promises an avatar update that does not exist.
- `ITSAppUsesNonExemptEncryption=false` is missing, so every upload asks the export-compliance question.
- `CFBundleVersion` is the literal `1` instead of `$(CURRENT_PROJECT_VERSION)`, so build numbers cannot be bumped from build settings.

**Ruling: fix at release prep.**

**M8. The app icon has an alpha channel** (`Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`). It is RGBA, though every pixel is opaque (minimum alpha 255). App Store Connect can reject an icon with an alpha channel (ITMS-90717). **Fix:** re-export as RGB. **Ruling: fix at release prep.**

**M9. Offline sign-out leaves the server-side push and device registration in place** (`APIClient.swift:470-475` calls `/auth/logout` with `try?`). Once pushes are enabled, a phone signed out while offline keeps receiving the old account's id-only pushes. **Ruling: accept now.** Revisit with I4: queue the logout call and retry it on the next network, or call `DELETE /devices/push-token` at the next launch.

**M10. Public logs can contain user file names** (`AppContainer.swift:94` logs every engine and upload line with `privacy: .public`; for example `AttachmentUploads.swift:258` logs a `CocoaError` whose description includes the copy's path and file name). **Fix:** log `.private` or log only error codes. **Ruling: accept for v1** (only logged when a write fails), fix in hardening.

**M11. A waiting file whose row cannot be decoded is dropped silently, and its copy is deleted** (`SwiftDataDeliveryStore.swift:261-263` `compactMap { try? decode }` → `AttachmentUploads.restore` → `files.prune`). This does not happen today, but a future `PendingUpload` field added without a default would lose every queued file without a trace, against the store's own "no destructive migration" rule. **Fix:** fail closed (throw, and keep rows and copies), or decode with defaults; add a test. **Ruling: fix before the first schema change.** Accept for v1.

**M12. Tapping a notification does not open its conversation.** No `userNotificationCenter(_:didReceive:)` handler exists. This is not in the contracts, so it is noted as a UX gap. **Ruling: accept for v1**, and pair it with I4.

## Rulings on the iOS deferred minors in the ledger

| Ledger item | Ruling |
|---|---|
| T7: realtime edit or delete during a window load overwritten by the snapshot | Accept. It heals on the next sync or reload; Android behaves the same. |
| T7: `DateFormatter` per row | Accept. It is Task 10 territory. |
| T7: reconnect `load()` after a long offline period can leave a gap | Accept. Since Task 9, the sync chain plus `replaceHistory(stale:)` covers it. |
| T7 → T10 items (list style, header-avatar card, HUD, highlight, stagger, banner) | Out of scope; owned by the Task 10 review. The SceneStorage filters and the `dismissSystemPrompts` helper were fixed in Task 8 (Ruling D/G). |
| T7: timing-based `UniversalSearchTests` may flake | Accept. They were green across the last 8 CI runs. |
| T8: PushKit VoIP token not registered | Accept for v1, since there is no CallKit and calls are foreground only. It must be done in the CallKit task. |
| T8: old avatar versions never pruned | Accept. Small files in Caches, which iOS can purge. |
| T8: initials flash; inline base64 decode | Accept. Task 10 has `AvatarImageMemo`. |
| T8: test-quality items (sandbox `#if` mirror, `@unchecked` fake, RED at compilation, dead unregister scaffolding) | Accept. |
| T8: initials differ for surrogate pairs and titlecase | Accept. Cosmetic; the colour matches. |
| T8: `SessionStore.swift:199` `isSigningIn` early return skips the launch wipe | Accept. B's `adopt` still wipes the queue; what is left is colleague photos and downloads, which are revalidated with `If-None-Match` on open. |
| T8: an offline knock failure with only a device secret wipes caches | Accept. Over-eager but harmless. |
| T8: `PeopleFilters` SceneStorage wiring untested | Accept. |
| T9: `raw()` clears credentials when the retried request gets 401 after a successful refresh | Accept. A 401 on a token that was just issued is a definitive rejection. |
| T9: `LocalSendTimes` kept in memory only | Accept. |
| T9: list unread taken from `ConversationsStore` | Accept. Android has the same. |
| T9: admin delete goes direct (silently dropped with no socket) | Accept. It is outside the contract's `delete`. |
| T9: no BGTask | Accept for v1, documented. It depends on I4 (push) for background delivery. |
| T9: tests written after the code | Accept. The mutation logs show the tests have teeth. |
| T9: uploads retry forever on 5xx | **Fix before release** (M2). |
| T9: forget/add race after an account switch; `add()` race while the queue has no owner | Accept. The outcome is visible to the user ("Файл недоступен — удалите его и выберите снова"), not a silent loss. |
| T9: cold-launch publish before adopt | Accept. Consumers check `me`. |
| T9: the generation test filters dot-files; the discard-rows retry test is weak; `settle()` uses fixed waits | Accept (test quality). |
| T9: `changePassword` records the pair from the Keychain token | Accept. |
| T9: a revoked-T1 401 before the `changePassword` response clears credentials | Accept. Rare, and it self-heals: `changePassword` → `enter(response.user)`. The device secret is then lost until the next `claimDevice`. Optional fix: hold off `revalidate` while a password change is in flight. |
| T9: a deleted account's rows after a kill are removed only on the next claim | Accept. They are never claimed or sent. |
| Android parked items (Task 5) applied to iOS: upload token not bound to the job owner; `sendAttachment` from a stale screen | Not reproducible on iOS. No upload starts without `owner() == pending.owner`, a retry refuses another session's token (`renewedToken` → nil), and `ChatRegistry.reset()` on session end removes stale screens. Accept. |
| Controller CI fix e2a620c | Reviewed above. Correct; compiled out of Release. |

## Swift 6 concurrency

- **The engine is safe by construction.** `DeliveryEngine`, `DeliveryRuntime`, `AttachmentUploads` and the stores are `@MainActor`. `SwiftDataDeliveryStore` and `DeliveryModelWorker` (`@ModelActor`), `AttachmentDownloader`, `AttachmentThumbnails`, `AvatarImageLoader` and `WebSocketClient` are actors. Re-entrancy at `await store.persist` cannot reorder commands, because `drain` holds the queue.
- **Every `@unchecked Sendable` is backed by a lock or is immutable:** `KeychainManager` (NSLock), `RealtimeHandshakeState` (NSLock), `URLSessionWebSocketTransport` (immutable), `AudioSessionManager` (NSLock), and the notification delegate (stateless).
- **Audio callbacks** cross over through `nonisolated static` factories and `Task { @MainActor }`. They are covered by `AudioEngineCallbackIsolationTests`.
- **No data races found.** The only observation is a performance one: the reducer and `trackCache` run on the main actor for every frame. Measure this on a device with many conversations.

## Conflict risk with `origin/mobile/ios` (Task 10)

Task 10 edits `ProfileView.swift` heavily, plus `AppContainer.swift`, `SessionStore.swift` (small) and `AccountSafetyViews.swift`. I2 and M3 touch the same files, so apply them after the Task 10 merge.

The other fixes do not overlap with Task 10: I1 (`KeychainManager`, `APIClient`, `WebSocketClient`), I3 (`PrivacyInfo`), I4 (`Info.plist`, entitlements, `pbxproj`), M1/M2 (`AttachmentUploads`/`AttachmentRules`), M4 (`APIClient`/`AccountStore`) and M5 (script).
