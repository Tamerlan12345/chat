# Task 11 fix wave — lane A (Android) report

Branch `mobile/android` (worktree `m-android`), base `07420d0`, head **`ae3c7dd`** (pushed). It includes a `--no-ff` merge of `origin/fix/server-contracts` (9152033).

Logs: `fixwave-A-red-*.log` and `fixwave-A-green-*.log` in this folder. Every behaviour change was red first. The suite has 698 unit tests at baseline and **773** at the head, with no test removed. Where old assertions pinned copy that the canonical table replaces (countdown «1:00», BUSY→Throttled, old upload/download texts, one instrumented text), they were changed to the new canonical value, not loosened.

## Commits
| Commit | Content |
|---|---|
| 255c902 | I4 request binding, I1 logout, P8 claim, Retry-After, P11 disk backoff |
| efc03be | I2/M2 uploads, P1–P3, M1, M4 |
| fe8fecc | I3 notification taps, M3 clear notifications, M5 cleartext, P4 text as typed |
| bf50801 | Decision Q, registration switch |
| 79c734f | Decision P push (FCM) and copy-ru |
| a56607c | P17 neutral test data |
| 7b32235 | docs/PUSH-SETUP-android.md |
| 0503366 | instrumented countdown text |
| (merge) | origin/fix/server-contracts |
| ae3c7dd | new contract fixtures decoded; CopyRuTest reads contracts/copy/ru.json |

## Items
| Item | Status | Evidence |
|---|---|---|
| **I1** logout sends `device_id`, wipes device secret | **Fixed.** `/auth/logout` body `{device_id}`; `SessionManager.clearSessionForSignOut()` removes token+user+secret in one commit, fail closed (logout throws). Account deletion uses the same wipe. | `ApiClientLogoutDeviceTest` (no knock after sign-out, nothing sent; failed commit fails sign-out). red-1/green-1 |
| **I2** uploads ≤2 + transient statuses + pick order (also **M2**, parity **P1/P2/P3**) | **Fixed.** `Semaphore(2)` FIFO in pick order; 0/401 wait; 408/429/5xx/507 wait `max(Retry-After≤30 s, 15 s)`, failed after 5 in a row; 4xx refusals fail. Hand-over to the outbox in pick order per conversation; a refused file does not block (port of iOS `enqueueUploaded`). | `UploadQueueTest` (6 tests). red-3/green-3 |
| **I3** notification-tap intents | **Fixed.** PendingIntent → non-exported `NotificationOpenActivity` (Theme.NoDisplay), tap handed in memory (`NotificationTaps`); MainActivity (exported) reads no extras; a tap opens only for the account it was shown for. | `NotificationTapTest`, `ManifestHardeningTest`; on API 34 `am start` of the trampoline → `SecurityException … not exported`; MainActivity with forged extras opens nothing. |
| **I4** HTTP bound to account (parked 1, line 99) | **Fixed.** Every request carries `BoundCredentials` (token at build time); engine HTTP effects and uploads run in `RequestOwner(me)` and are not sent when the session is another account's; interceptor sends a bound request only as its account (JWT `userId` claim), else `AccountChangedException`; authenticator never replays a tokenless request or another account's; a 401 / refused refresh ends the session only if it refused the **current** token. | `RequestBindingTest` (10), `SessionAuthenticatorTest` (+3), `DeliveryEngineTest.everyRequestOfTheEngineIsMadeFor…`. red-1/2, green-1/2 |
| **M1** cancel after upload never sends | **Fixed.** `enqueue(stillWanted=…)` is checked in the engine's command loop right before the entry is taken; cancelled after taking → `engine.cancel`. | `UploadCancelRaceTest` (reproduced the send first). red-3/green-3 |
| **M3** clear notifications on switch (parity **P10**) | **Fixed.** `MessageNotifier` cancels all on sign-out / other account. | `MessageNotifierTest` (+3) |
| **M4** parked 2, screenAccount into add | **Fixed.** `sends.add(…, screenAccount)` refuses a mismatch. | `UploadQueueTest`, `ChatViewModelAttachmentTest.aScreenOfThePreviousAccount…` |
| **M5** usesCleartextTraffic=false | **Fixed.** On `<application>` in main; the debug network config still allows localhost. | `ManifestHardeningTest` |
| **P4** no trimming | **Fixed.** Text and edits go as typed; the reducer's WHITESPACE set yields EMPTY_TEXT (the composer button stays disabled for blank input, as before). | `ChatViewModelOutboxTest.theTextGoesExactlyAsTyped…` |
| **P8 / M10** claimDevice after registration | **Fixed.** Shared `claimThisDevice()`. | `AccountRepositoryTest` (+2) |
| **P11 / M7** disk-failure restart loop | **Fixed.** First failure restarts at once, then 1 s, 2 s … 30 s; one restart covers frames that failed meanwhile; reset on a stored event and on session drop. | `DeliveryEngineTest.aDiskThatKeepsFailing…` |
| Retry-After cap 30 s | **Fixed.** `RetryAfter` parses delta-seconds and HTTP-date; automatic waits (sync, uploads) capped at 30 s. Login/registration countdowns keep the server's wait (capping would only produce repeat 429s). | `RetryAfterTest`, `HttpDeliveryBackendTest` |
| **Q** REGISTRATION_DISABLED + hide entry | **Fixed.** Entry hidden when `/settings/info.allow_registration=false` (unknown/offline keeps it); 403 `REGISTRATION_DISABLED` at request **and** verify → own state with `reg.disabled`. Matches the merged registration.md (both steps, 403). `EMAIL_NOT_CONFIGURED` / code-less 503 → mail-not-configured. | `AccountFailureTest`, `LoginViewModelTest`, `AuthRepositoryKnockTest`. red-5/green-5 |
| **P** push | **Fixed** (see below). | `PushTest` (10), `PushBuildConfigurationTest`; red-6/green-6; on emulator with no json: «FirebaseApp initialization unsuccessful», no crash |
| copy per copy-ru.md | **Fixed** for every Android-mapped key. `CopyRuTest` checks ~70 resources/constants against `mobile/contracts/copy/ru.json`. New states: `reg.busy` (Throttled.busy), `signout.unsent_unknown` (until the store is read), `delivery.failed_with_reason` («Не отправлено: сервер не ответил»), `{wait}` «2 мин 30 с». | red-7/green-7 |
| Contract fixtures after merge | **Fixed.** settings/info, blocks ×3, reports, users/me decoded. | red-9 / green-9 |
| **P17** real-looking data in tests | **Fixed** (names, @example.test, +7 700 …, no .kz hosts). **Accepted:** production host stays in `ServerConfigTest`/`SessionManagerServerBindingTest`: these are release-pinning string assertions, with no traffic. | a56607c |
| M6 SecureStorage exception in interceptor | **Accepted** (review ruling: harden next). |
| M8 cache after block | **Accepted** (review ruling). |
| M9 security-crypto alpha | **Accepted** (review ruling). |
| Socket reconnect jitter up to 36 s | **Accepted**: cosmetic. Refusal backoff is deliberately longer. |
| `upload.waiting_slot` label | **Accepted**: a waiting file shows the normal «queued» state. No separate label. |
| `conversation_read` bus, notification tag/id, notify vectors | **Accepted** (as ruled in the parity review). |

## Push (decision P)
- `firebase-bom 34.19.0` + `firebase-messaging` are always compiled in. `com.google.gms.google-services 4.5.0` is declared `apply false` and applied in app **only if `app/google-services.json` exists**. That file is git-ignored in `mobile/android/.gitignore`.
- Without the file, no FirebaseApp exists: `FirebasePushTokenSource` returns null and nothing is registered. Build, tests, lint, R8 release and CI all pass without it.
- `PushRegistrar` → `POST /api/devices/push-token {platform:"android", token, app_version, device_id}`. It runs after every sign-in, at start with a session, and on `onNewToken`/`onRegistered`. Logout's `device_id` removes the token on the server.
- `CentyMessagingService` (exported=false) → `PushMessageHandler`, which uses ids only:
  - **message:** fetch with `afterId=id-1` and show sender and text. A failed fetch shows «Новое сообщение»; a deleted message shows nothing; a message already received over the socket, DND, or an open chat shows nothing.
  - **read:** dismiss.
  - **call:** «Входящий звонок» in the «Звонки» channel for 30 s; tapping opens the app.
- `getToken()`/`onNewToken` are deprecated in messaging 25; both the old and the new (`onRegistered`) callbacks are handled.
- Docs: `docs/PUSH-SETUP-android.md`, to be pasted into section 2 of lane S's `docs/PUSH-SETUP.md`. Not done: full-screen CallStyle and a microphone foreground service.

## Verification
- Head ae3c7dd: `testDebugUnitTest lint assembleDebug assembleRelease assembleDebugAndroidTest` all succeed with `--max-workers=2 -Xmx1536m` and the emulator closed. That is 773 unit tests, 0 failures. Lint shows 0 errors and 40 pre-existing warnings (green-9).
- Full instrumented suite on AVD **Api34** (API 34), with the APKs built by Gradle while the emulator was closed and run with `am instrument`: **86/86 OK**, before and after the merge (green-8, green-10). The first run caught the countdown text change (red-8).
- CI `mobile-android`:
  - 0503366: run 37570528746 **success**, including android-emulator-tests.
  - Final head ae3c7dd: run 37572192448 **success**: android-verify and android-emulator-tests both green.
  - 7b32235 failed only on the countdown instrumented test, which 0503366 fixed.
- Dev stand: not needed. Unit and instrumented tests use fakes or the unreachable `127.0.0.1:9`. No traffic went to production or to port 2004.

## Fix round 1 (Ruling U, three Minors)

Commit **4b78f27**. Logs: `fixwave-A-red-r1-stale-token-push-signout.log` (8 red) and `fixwave-A-green-r1-stale-token-push-signout.log`. Unit tests: 782 pass, 0 failures. Lint: 0 errors.

| Minor | Status | Fix | Tests |
|---|---|---|---|
| 1. Stale token from refresh | **Fixed** | A new method, `SessionManager.replaceTokenIfCurrent(old, new)`, stores a renewed token only while `old` is still the session's token. It is `@Synchronized` on the same monitor as `clearSessionIfCurrent`, `clearSession`, `clearSessionForSignOut` and `persistAuthenticatedSession`.<br>It throws on a refused write, as the old setter did.<br>The authenticator refresh, the proactive refresh and the explicit `refreshToken()` all store through it; the ApiClient `updateToken` callbacks are now no-ops.<br>A renewal whose session was signed out or replaced in the meantime returns `RefreshOutcome.Superseded`: nothing is stored and nothing is replayed. | `SessionTokenReplaceTest` (5)<br>`SessionAuthenticatorTest.aRefreshWhoseSessionWasReplaced…` |
| 2. Push token survives an offline sign-out | **Fixed** | `PushTokenSource.delete()`: in the Firebase implementation it calls `FirebaseMessaging.deleteToken()` (5 s timeout) only when Firebase is configured; otherwise it does nothing.<br>`DefaultAuthRepository.logout()` calls it after the local clear, even when `/auth/logout` failed offline.<br>It is not called if the session could not be cleared. | `AuthRepositoryPushTest` (2) |
| 3. Sign-out failure message | **Fixed** (no new copy key) | When the secure store refuses the wipe, `clearSessionForSignOut` has already removed the session from memory and marked the store unusable, so the device is signed out.<br>`ProfileViewModel` now treats that as a sign-out: it navigates to login, never shows «выход отменён», and does not call `signOutAborted`.<br>The login screen shows the existing canonical `reg.storage` text («Защищённое хранилище устройства недоступно…», `login_error_storage`) while the store is unavailable.<br>If the session still exists, the old abort path stays. | `ProfileViewModelLogoutStorageTest` (rewritten)<br>`LoginViewModelTest.theLoginScreenSaysWhenTheSecureStorageIsUnavailable` |

Test changes:
- `ProfileViewModelLogoutStorageTest`: the old test asserted the untruthful «stay on profile» outcome. It is replaced by an assertion of the truthful one: the device navigates to login, the token is null, the storage is UNAVAILABLE, and there is no cancel message.
- The fake in `ProfileViewModelUnsentTest.aSignOutTheSessionRefusedLeavesTheAccountWorking` now reports that its session still exists, which is that test's scenario. Its assertions are unchanged.

CI `mobile-android` on 4b78f27: run 37574080040 **success** (android-verify, android-emulator-tests).
