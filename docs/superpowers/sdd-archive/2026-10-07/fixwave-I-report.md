# Fix wave — lane I report (iOS)

Worktree `m-ios`, branch `mobile/ios` (from b0bd691 = Task 10 merged + `fix/server-contracts`), pushed to origin. Never pushed to master. No production traffic (unit tests use `chat.example.com` and fakes; UI tests use the dev stand on `localhost:8443`).

There is no Mac. Evidence:
- **CI** (`mobile-ios` workflow on the pushed head): the run ids below.
- **Linux** (Docker `swift:6.1-jammy`): the Foundation-only part of the app (~90 files, with small shims for `os.Logger`, `Security` constants and `FoundationNetworking`) plus the new and changed Foundation-level tests, before and after the fixes: `fixwave-I-red-1-linux.log`, `fixwave-I-green-1-linux.log`. This caught real errors before CI (a duplicate `RussianPlural`, two Swift 6 isolation errors in the new tests, and a wrong expectation in an inline reducer vector).

## CI runs (mobile-ios)

| Run | Head | Result |
|---|---|---|
| 37573000203 | b0bd691 (base) | baseline; fixture test known red on this head (lane S runs 37568140926/37568345375 show the same 13 unmapped fixtures) |
| 37574406397 | fc35532 RED | RED evidence (in progress when this report was written; release lock already green) |
| 37576057481 | bd9c0a7 GREEN 1 | **failed at build**: one error, `PersonCardView.swift:103` (HUDCapsule takes LocalizedStringKey) — Debug and Release |
| 37577120462 | ee93ee8 (build fix, includes P10 RED f2df443) | expected: everything green except `NotificationClearingTests` (P10 RED) — **pending** |
| 37577123333 | e4e602e (P10 GREEN, final head) | expected fully green — **pending** at hand-back |

## Commits

| Commit | What |
|---|---|
| fc35532 | **RED**: every new/changed test, with API stubs that keep the old behaviour so the suite compiles |
| 2ba2f66 | I1 Keychain + I2 offline launch + P9 login as typed (Keychain, APIClient, WebSocketClient, SessionStore, LiveRepositories) |
| 7f3c9c3 | M1 cancel during hand-over, M2 upload backoff/budget, `message_deleted` guard, strict vector runner |
| 93f8965 | Canonical copy (AppCopy + CopyRuTests), P5 DM_NOT_ALLOWED lock, P6/P7 blocks, decision Q, 429 holds, M3 sign-out, Task 10 minors |
| 7a504c5 | Push (decision P), BGTask background flush, retry hooks, entitlements template, docs/PUSH-SETUP.md §3 |
| bf6beeb | I3 privacy manifest, M7 Info.plist, M8 RGB icon, M5 release lock |
| bd9c0a7 | P17 neutral example data in the tests |
| f2df443 | RED: P10 notifications cleared at session end; permission fake moved to file scope |
| ee93ee8 | build fix (HUDCapsule LocalizedStringKey) |
| e4e602e | P10: `MessageNotificationsStore.reset()` removes all delivered notifications |

## Items

### Contract fixtures

| Item | Status | Evidence |
|---|---|---|
| `ContractFixtureTests` red on the 13 new http fixtures | **Fixed.** Every new fixture has a case: the registration refusals are decoded *and* mapped through `AccountFailure` (REGISTRATION_DISABLED, EMAIL_NOT_CONFIGURED, CODE_EXPIRED, CODE_INVALID without attemptsLeft, invalid input), `blocks.add/list/remove`, `reports.create` (new `ReportCreatedResponse`), `users.delete-me` (+ INVALID_PASSWORD → wrongPassword), `settings.info` (allow_registration). No skipping. | RED: baseline run on b0bd691 (37573000203) and the RED run; Linux red/green |

### Final review iOS — Important

| Item | Status | Evidence |
|---|---|---|
| **I1** locked device signs out | **Fixed.** Items are `AfterFirstUnlockThisDeviceOnly`; older items move at launch (`upgradeItemProtection`, a query on the old class, values untouched). A read other than success/not-found throws `.unavailable`: `APIClient` treats it as a wait (`noConnection`, raw status 0) and clears nothing; refresh/renew paths too; the socket defers its connect with the usual backoff while the token is unreadable; `bootstrap` keeps `.launching` and retries on `protectedDataDidBecomeAvailable`, foreground and network; `deviceID()` never replaces an unreadable id. | `KeychainAvailabilityTests` (8), `ReconnectBackoffTests.testNoSocketOpensWhileTheStoredSessionCannotBeRead`, `SessionResilienceTests.testALockedKeychainAtLaunchWaitsInsteadOfWipingTheSession` |
| **I2** offline cold launch → login | **Fixed.** The signed-in user is kept in the Keychain (written at every sign-in and `auth_success`, deleted with the session). A launch whose `/auth/me` gets no answer or a 5xx enters with it (queue and cached chats reachable, socket retrying, lists reloaded on the first `auth_success`); without one it stays `.launching` and retries. Only a refused refresh (401/403) or `mustChangePassword` changes that. | `SessionResilienceTests` (offline, 5xx, no snapshot, revoked token after an offline start) |
| **I3** PrivacyInfo | **Fixed.** `NSPrivacyAccessedAPICategoryUserDefaults` CA92.1 and `NSPrivacyAccessedAPICategoryFileTimestamp` C617.1 (`attributesOfItem` for sizes). The repo's privacy-manifest check still passes (both APIs are used). | `BundleMetadataTests.testPrivacyManifestDeclaresUserDefaultsAndFileTimestamps` |
| **I4 / decision P** push | **Fixed (keys later).** See "Push" below. | `PushEnvironmentTests`, `NotificationRequestTests`, `BundleMetadataTests` |

### Final review iOS — Minor

| Item | Status | Evidence |
|---|---|---|
| **M1** cancel during hand-over still sends | **Fixed.** `cancel` marks a file whose enqueue is being written; when the write returns, the entry is withdrawn with `engine.cancel` before anything sends it, and the copy and row go. | `AttachmentUploadsTests.testAFileCancelledDuringItsHandOverIsNeverSent` (gated engine disk; asserts no send after the socket comes up) |
| **M2** uploads retry forever | **Fixed.** Pauses double 15 s → 10 min; the server's Retry-After still wins; 5 server failures (5xx/507) in a row fail the file with the server's reason («Повторить» starts over); a connection that comes back ends the pause and restarts the backoff. | 4 tests in `AttachmentUploadsTests` |
| **M3** sign-out confirm | **Fixed.** Always asked with the canonical title/body; the unsent line first; if the count grew while the alert was open it asks again with the new count. UI test now requires the alert. | `SignOutPromptTests`, `CopyRuTests.testTheSignOutQuestionUsesTheCanonicalLines`, `UserPathQATests` |
| **M4** local wipe failure after server deletion | **Fixed.** After a 2xx the Keychain wipe is best effort (logged); `finishAccountDeletion` always runs. | `RegistrationAPITests.testADeletedAccountIsReportedDeletedEvenWhenTheLocalWipeFails` |
| **M5** release lock hooks | **Fixed.** Also forbids `-centychat-stub-account`, `CENTYCHAT_STUB_SIGNIN`, `-allow-insecure-loopback`, `UITestAccountRepository`, `-centychat-ui-gallery`. | `BundleMetadataTests.testTheReleaseLockScriptChecksEveryTestHook`; `ios-release-server-lock` job |
| **M6** downloads/thumbnails 401 refresh, byte loop | **Accepted** (review ruling: v1, hardening). | — |
| **M7** Info.plist | **Fixed.** `ITSAppUsesNonExemptEncryption=false`; camera and photo-library-read strings removed (unused: PhotosPicker needs none); the photo-library-*add* string stays with an accurate text because the share sheet / Quick Look offer «Сохранить» (removing it would crash that path); `CFBundleVersion=$(CURRENT_PROJECT_VERSION)`, `CFBundleShortVersionString=$(MARKETING_VERSION)`. | `BundleMetadataTests` (bundled and source plists) |
| **M8** icon alpha | **Fixed.** Re-exported RGB (every pixel was opaque; pixels identical). | `BundleMetadataTests.testTheAppIconHasNoAlphaChannel` (PNG colour type 2) |
| **M9** offline sign-out leaves push registration | **Accepted** (review ruling). The server drops the token on `/auth/logout` with `device_id` and on a newer token of the device. | — |
| **M10** public logs with file names | **Accepted** (review ruling: v1). | — |
| **M11** undecodable upload row dropped | **Accepted** (review ruling: before the first schema change). | — |
| **M12** tap does not open the chat | **Fixed** with decision P (see Push). | `PushEnvironmentTests.testOnlyAMessageNotificationOpensAChat`, `NotificationRequestTests` |

### Task 10 minors (progress.md)

| Item | Status | Evidence |
|---|---|---|
| `ChatScrollEnd.isAtEnd` subtracts `contentInsets.bottom` | **Fixed.** Confirmed against the CI probe of run 37567132661 (iPad: content 2319, visibleMaxY 2404, bottom inset 85 → exactly the end). | `ChatScrollEndTests.testTheBottomInsetIsNotOnScreen` |
| `EndPinning` unpins only on `.interacting` | **Fixed.** Also unpins when the end check turns false while the end itself did not move (status-bar tap, VoiceOver scroll); a new message or a taller row (the end moved) keeps following. | `ChatScrollEndTests.testLeavingTheEndStopsFollowingButANewMessageDoesNot` |
| Probe overlay not `#if DEBUG` | **Fixed.** The probe and its geometry observer live in a `ScrollProbe` modifier compiled out of Release. | Release lock job builds Release |

### Parity (final-review-parity.md, iOS side)

| Item | Status | Evidence |
|---|---|---|
| **P5** DM_NOT_ALLOWED composer lock | **Fixed.** Port of Android's `RefusedDelivery`: a send refused with `DM_NOT_ALLOWED` closes the composer of that direct chat (banner `chat.dm_not_allowed.banner`, placeholder «Отправка недоступна», empty state «Сообщений нет»); a fresh history, an unblock or a newer message from the peer reopens it. My own block locks too (banner `chat.blocked_by_me.banner`). `DeliveryNotices` has the code. | `ComposerLockTests` (5) |
| **P6** blocked people hidden in channels | **Fixed.** Only direct messages are hidden; channels untouched. | `ComposerLockTests.testABlockHidesOnlyDirectMessages` |
| **P7** block / delete warnings | **Fixed.** Canonical `block.confirm.body`, `delete.warning` («Удалённый сотрудник»), blocked-list footer/empty texts, block/unblock notices. | `CopyRuTests` |
| **P9** login lowercased | **Fixed.** Trimmed only. | `SessionResilienceTests.testTheLoginNameIsSentAsTypedOnlyTrimmed` |
| **P12 / §4.2** no background flush | **Fixed.** `BGAppRefreshTask` `kz.centras.centychat.delivery-flush` (Info.plist `fetch` + permitted id), scheduled when the app goes to the background while something is unsent; runs `DeliveryRuntime.flushInBackground`, reschedules on `retryLater`, completes once on expiry. | `BundleMetadataTests.testBackgroundModesCoverPushesAndTheBackgroundFlush` |
| 429 waits (registration verify/resend, report, block) | **Fixed.** `canVerify`/`canResend` respect the server wait; `AccountStore` holds reports and blocks/unblocks (one server limit) until Retry-After, sending nothing. | `RegistrationFlowTests` (2), `AccountStoreTests` (2) |
| `message_deleted` without an integer id | **Fixed.** Nothing is confirmed; pending cancels stay. | `DeliveryReducerVectorsTests.testADeletedFrameWithoutAnIdKeepsPendingCancels` |
| Vector runner weaker than Android's | **Fixed.** Name = file, one effect list per event, a missing state key is a failure. All 71 vectors pass. | 3 runner tests + `testEveryReducerVectorPasses` |
| REGISTRATION_DISABLED (decision Q) | **Fixed.** Own state with `reg.disabled` at request and verify (the code is not spent or cleared); «Зарегистрироваться» hidden when `/settings/info` says `allow_registration: false`, kept when unknown. | `RegistrationFlowTests`, `RegistrationAPITests`, `SessionResilienceTests.testRegistrationIsOfferedOnlyWhileTheServerTakesIt`, fixtures |
| Copy per copy-ru.md | **Fixed** for every state iOS has, through `AppCopy` (keys in comments) and checked by `CopyRuTests` against `mobile/contracts/copy/ru.json` (read from the checkout). Includes BUSY as `reg.busy` (not «Слишком много попыток»), `{wait}` format, delivery codes and reasons, `delete.*`, `blocked.*`, `reg.*`, `login.*`, `upload.*`, `download.*`, `conn.signed_out`, pending title. Not adopted (no such iOS state): `conn.refused`, `upload.waiting_slot`, `upload.disk_full` (server text shown), `upload.name_invalid` pre-check (parity minor), `open.no_app`, `login.*.title` (iOS shows one text box), `login.busy_retrying` (desktop). | `CopyRuTests` (10) |
| P17 real-looking data in tests | **Fixed** for iOS tests (names, `@example.com`/`.example` hosts, `+7 700` phones; credential binding tests bind to the test server). `AvatarTests` keeps «Данияр Ахметов» because its expected colour is a hash of that exact name (a name alone, no contact data). | Linux green incl. PeopleSearchTests, PersonCardTests, DTOParsingTests |
| P10 notifications left after sign-out | **Fixed.** Session end removes all delivered notifications. | `NotificationClearingTests` (RED f2df443 → GREEN e4e602e) |

### Push (decision P)

- **Permission** is asked once, after sign-in (`NotificationPermission` from `sessionDidAuthenticate`); a refusal is not asked again; UI tests never see the question (`suppressesNotificationPrompt`, DEBUG-only).
- **Token**: `registerForRemoteNotifications` at launch and after every sign-in while allowed; the existing `PushTokenRegistrar` sends it to `POST /api/devices/push-token`.
- **Environment** from the signing (`embedded.mobileprovision` → `aps-environment`; no profile = App Store/TestFlight = production; simulator = sandbox), not from Debug/Release.
- **Background mode** `remote-notification` (and `fetch`, `audio`).
- **Tap** on a message notification opens its chat from the chat list (ids only, parsed by `PushPayload`; read/call/other payloads open nothing).
- **Entitlements template** `mobile/ios/Signing/CentyChat.entitlements` (`aps-environment` only), not referenced by the project: CI and simulator builds need no Apple account.
- **Docs**: `docs/PUSH-SETUP.md` §3 (iOS) — what the code does, the owner's steps (App ID capability, signing, CODE_SIGN_ENTITLEMENTS or the Push capability, environment rewrite on export, build numbers), and what is deliberately missing (PushKit/CallKit).

## Notes for the coordinator

1. `docs/PUSH-SETUP.md` §3 is edited in place (lane A wrote `docs/PUSH-SETUP-android.md` instead); no conflict with §2.
2. Process: the RED commit compiles with stubs so the RED run shows assertion failures, not a build error. Two expectations changed with the canonical copy (documented in the commits): BUSY maps to the new `serverBusy` state, and the local code expiry to `codeExpiredLocally`; the UI tests now look for «Заявка на рассмотрении» and require the sign-out alert.

## Fix round 1 (Ruling V)

| # | Item | Status | Test |
|---|---|---|---|
| 1 | M1 with the socket up | **Fixed.** `DeliveryEngine.withdraw(clientMsgId:)`: after the enqueue's persist, a withdrawn key has that step's send effects suppressed and a `cancel` processed right after (server refuses the key; entry pendingDelete, never resent). `AttachmentUploads.cancel` withdraws during hand-over. | `AttachmentUploadsTests.testAFileCancelledDuringItsHandOverIsNeverSentWithTheSocketUp` (Linux RED: 1 send_message; GREEN: 0) |
| 2 | Tap not tied to an account | **Fixed.** Route records `currentUser.id` (nil while restoring); `take(signedIn:)` drops another account's; `sessionDidEnd` clears; signed out → ignored. | `NotificationRequestTests.testATappedNotificationOpensOnlyForItsAccount` |
| 3 | No token while authenticated | **Fixed.** Socket never connects tokenless; emits local `auth_error TOKEN_MISSING` once per streak; SessionStore revalidates (ends only on refusal). | `ReconnectBackoffTests.testATokenlessSocketIsNeverOpenedAndTheSessionChecksItself` (Linux RED/GREEN), `SessionResilienceTests.testAMissingTokenMakesTheSessionCheckItself` |
| 4 | Blank first launch on 5xx/offline | **Fixed.** `launchProblem` (`login.offline` / `reg.unavailable`) shown with «Повторить»; auto-retry 2, 4, 8 … 60 s. | `testALaunchWithoutTheServerShowsWhyAndCanBeRetried`, `testTheRetryPauseGrowsAndIsCapped` |
| 5 | APNs unregister on sign-out | **Fixed.** `sessionDidSignOut` → `unregisterForRemoteNotifications()`; involuntary end keeps it. | `testAnExplicitSignOutUnregistersFromAPNs` |

Commits: d7d4338 (RED), 18e7834 (GREEN). Linux logs: `fixwave-I-r1-red-linux.log`, `fixwave-I-r1-green-linux.log`.

CI at hand-back: release lock green on 37577120462 and 37577123333 (the earlier build error is fixed); simulator jobs of 37574406397 (RED), 37577120462, 37577123333 (P10 green), 37578084310 (round-1 RED) and **37578279816 (final head 18e7834)** were still running/queued.

## CI hardening (UI tests)

Run 37587863344 (head 1947ff7, the coordinator's copy-expectation fix) failed two *different* UI tests across attempts, with the app code unchanged since 18e7834 (green in 37578279816):

- **PeopleSearchUITests.testPeopleScreensForReview (attempt 2, ax-xxxl): test defect, not an app defect.** At accessibility text sizes the first «Сотрудники» row (Администратор системы) is taller than the space above the tab bar (screenshot `10-people-ax-xxxl` on `ci/ios-screenshots/1947ff7`). `tapCentre` tapped the frame centre, which lay under the tab bar, so no card opened. The lane I change to `PersonCardView` (the `HUDCapsule` LocalizedStringKey) only affects the copy HUD and is not involved.
- **UserPathQATests.testUserPathEndToEnd (attempt 1): flaky query.** The header renders «Алиса Тестова» (screenshot `15-profile-light`), but it is one combined accessibility element, so the exact `staticTexts["Алиса Тестова"]` match depends on how XCTest exposes it.

Fix (7b610a6, test code only, assertions unchanged):
- New shared helpers on `XCUIApplication` (in `RegistrationFlowUITests.swift`): `tapVisiblePart(of:)` taps just below the visible top of the element, after scrolling it up if its top is too low (above the tab bar). `element(labelContaining:)` matches any element whose label contains the text.
- PeopleSearchUITests: row taps use `tapVisiblePart`. The person card is opened by `openCard(from:in:_:)`: one retry if the card did not open within 8 s, `dumpForDiagnosis()` on failure, same final assertion.
- UserPathQATests: waits for `profile-list`, then `element(labelContaining: "Алиса Тестова")`, with a dump on failure. Its row-tap helper uses `tapVisiblePart`.
- Same tap pattern also fixed in ScreenshotTourTests (iPad chat row, person row, department, announcement) and OfflineQueueUITests (`tapRow`).

CI: run **37602081015** on head **7b610a6**: **green** (simulator unit + UI + iPad, release lock, screenshots published).
