# Task 6 report — iOS architecture split and correctness fixes

**Status:** DONE_WITH_CONCERNS. Everything in the brief is done except the fixture-decode test, which is blocked (see Concerns #1).
**Branch:** `mobile/ios` (worktree `m-ios`), range `3f7dabe..4ac747a` (15 commits), all pushed.
**Final green run:** https://github.com/Tamerlan12345/chat/actions/runs/36963458438 (HEAD 4ac747a). 78 unit tests and 3 UI tests pass, with no Swift compiler warnings in the log.

## Architecture map

```
CentyChatMobileApp ─ @State AppContainer.live() ─ RootView().appEnvironment(container)

AppContainer (@Observable @MainActor, composition root; implements SessionLifecycleDelegate)
 ├─ SessionStore        phase: launching | serverSetup | signedOut | passwordChangeRequired | authenticated
 │                      bootstrap/login/knock/changePassword/logout/revalidate; starts/stops RealtimeStore
 ├─ RealtimeStore       the single event pump; start()/stop()/reconnect(); connectionState;
 │                      dedupes new_message by id (RecentIDs, 1024); fans out to registered stores; audioSink → CallStore
 ├─ ConversationsStore  dialogs, channels, users, typing; per-list LoadState (directState/channelsState/usersState)
 ├─ ChatRegistry → ChatStore (one per ConversationKey, cached for the session)
 │                      load (merges with realtime), send (negative pending ids, replaced by server echo),
 │                      edit, delete, image upload; applies new/updated/deleted/status/read events
 ├─ AnnouncementsStore  list + loadState, acknowledge, realtime announcements
 ├─ CallStore           call state machine and audio relay (ported unchanged from AppState)
 └─ ProfileStore        presence, wake buzzer and cooldown, incoming wake alert

Repositories (Core/Repositories): protocols ServerRepository, AuthRepository, ChatRepository,
AnnouncementsRepository, RealtimeRepository. The Live* structs wrap APIClient / KeychainManager /
WebSocketClient. Only AppContainer.live() references the singletons. No view references
APIClient.shared, WebSocketClient.shared or KeychainManager.shared.

WebSocketClient: injectable WebSocketTransport (URLSessionWebSocketTransport in production),
sleep, jitter and heartbeat interval; exposes connectionState plus a state stream; ReconnectBackoff.
Environment: `.appEnvironment(container)` injects the container and every store; views use `@Environment(XStore.self)`.
Logging: `Log` (os.Logger categories). There are no `print` calls left.
Localization: `CentyChat/Resources/Localizable.xcstrings` (source ru, 178 keys) and `scripts/generate-string-catalog.py`.
```

## Defects → fix → covering test

| Defect (audit) | Fix commit | Test(s) |
|---|---|---|
| `new_message` and `direct_message`/`channel_message` both counted → double unread | fa99a2f | `RealtimeChatTests.testDirectMessageAndNewMessageForTheSameIdCountAsOneUnread`, `…ChannelMessage…`, `testIncomingMessageAppearsOnceInTheOpenChat` |
| Open chat ignored realtime events (AppState stubs); incoming messages never appeared; optimistic message duplicated by the echo | fa99a2f | `testIncomingMessageAppearsOnceInTheOpenChat`, `testOwnEchoReplacesTheOptimisticMessage`, `testRealtimeEditUpdatesTheOpenChat`, `testRealtimeDeletionMarksTheMessageDeletedInTheOpenChat` (matched by messageId, per the contract fact), `testDeliveryStatusUpdateReachesTheOpenChat`, `testPeerReadReceiptMarksOwnMessagesReadWithoutTouchingMyUnreadCount` |
| `messages_read` reset *my* unread count; direct typing keyed by recipient (never shown) | fa99a2f | `testPeerReadReceipt…`, `testDirectTypingIsShownInTheDialogWithTheTypist` |
| WS listening only at the end of `initialize()` (early return on first run or unhealthy server); login never started listening; audio listener cancelled on logout and never re-armed | be1c2f1 | `SessionLifecycleTests.testFirstRunServerSetupThenLoginListensToRealtime`, `testLoginAfterUnhealthyLaunchListensToRealtime`, `testLogoutStopsRealtimeAndReloginRearmsEventsAndCallAudio`, `testRestoredSessionListensToRealtime` (guard) |
| `server_disconnect` (sent after any password change) logged the user out | be1c2f1 | `testServerDisconnectWithAValidTokenKeepsTheSessionAndReconnects`, `testServerDisconnectWithARevokedTokenSignsOut` (guard) |
| `mustChangePassword` sheet shown twice and session never authenticated | be1c2f1 (root-screen phase, sheets removed, sign-out button) | `PasswordChangeFlowTests.testMandatoryChangeAfterLoginThenAuthenticates`, `testRestoredSessionThatMustChangePasswordWaitsForTheChange`, `testVoluntaryChangeReconnectsRealtimeWithTheNewToken` |
| Backoff reset on every `connect()` (and attempt 1 waited 2 s instead of 1 s) | 161c2ed | `ReconnectBackoffTests.testReconnectDelaysGrowExponentiallyAcrossFailedAttempts` [1,2,4,8,16,30], `testBackoffStartsOverAfterASuccessfulConnection`, `testConnectionStateReportsTheScheduledReconnect`, `testFirstFrameAfterConnectIsAuthentication` (guard) |
| `loadAllData` all-or-nothing | 210038e | `PartialLoadTests.testFailedChannelsRequestKeepsConversationsUsersAndAnnouncements` (data plus per-list LoadState) |
| `call_end` without `targetUserId` dropped (controller contract fact) | 7abcce8 | `testCallEndWithoutTargetAfterConnectionLossIsParsed` |
| 13 `print` calls | 44b33d6 (os.Logger) | n/a (grep-verified: none left) |
| No String Catalog; English copy (Wake alert, Dismiss, Error, call errors, KeychainManagerError, APIError.insecureTransport, APIClient fallbacks) | 776f5d1 (call/alert strings already translated in 44b33d6) | `LocalizationTests` (catalog compiled to ru.lproj with key checks; Keychain, network, status and call labels are Cyrillic), `CallLocalizationTests` |

Additional behaviour from the brief and the contract:
- An expired token is never "refreshed". On 401, `INVALID_TOKEN` or `server_disconnect`, the session revalidates over REST. A valid or refreshable token reconnects. A revoked one is cleared, then the client tries `/auth/knock` with the device secret, and otherwise signs out.
- Health is advisory.
- After a realtime reconnect, `auth_success` reloads the lists and the open chats.

Preserved invariants: `ServerEndpointPolicy` HTTPS/WSS checks still run in `WebSocketClient.connect` and `APIClient`. Keychain stays `ThisDeviceOnly` and fails closed; the logout test now goes through `SessionStore` and the live repository. `TokenRefreshCoordinator` is untouched. The terminal-401 tests pass. The nonisolated AVFoundation callback factories in `AudioCallRelay.swift` are untouched.

## CI runs

| Run | Commit | Result |
|---|---|---|
| [36960907159](https://github.com/Tamerlan12345/chat/actions/runs/36960907159) | 300d9b9 synced test folder and screenshot publishing | GREEN; first publish to `ci/ios-screenshots/300d9b9` |
| [36961769830](https://github.com/Tamerlan12345/chat/actions/runs/36961769830), [36962034739](https://github.com/Tamerlan12345/chat/actions/runs/36962034739), [36962151428](https://github.com/Tamerlan12345/chat/actions/runs/36962151428) | 44b33d6 / 78a91dd / 7106fad | compile failures in test helpers only (rethrows; sending `self`); the app target compiled |
| [36962175204](https://github.com/Tamerlan12345/chat/actions/runs/36962175204) | 07b4b2a (refactor plus failing tests) | **RED** as intended: 23 targeted tests fail, existing 49 and the guards pass |
| [36962520532](https://github.com/Tamerlan12345/chat/actions/runs/36962520532) | 210038e (fixes) | **GREEN** 73 unit + 3 UI |
| [36962801573](https://github.com/Tamerlan12345/chat/actions/runs/36962801573) | a15acf7 (localization tests) | **RED** as intended (catalog missing, English Keychain and insecureTransport) |
| [36963131685](https://github.com/Tamerlan12345/chat/actions/runs/36963131685) | 776f5d1 | **GREEN** 78 unit + 3 UI |
| [36963458438](https://github.com/Tamerlan12345/chat/actions/runs/36963458438) | 4ac747a (README) | **GREEN** final |

Note: the pure-port commit 44b33d6 itself was never green on its own because of the test-helper compile errors fixed in 483f9b3 and 07b4b2a. Commit 07b4b2a is the first "port plus RED tests" point that compiles.

## Screenshot branch

The `publish-ios-screenshots` job (ubuntu, the only job with `contents: write`, concurrency group `ios-screenshots-publish`) runs on push events. It commits the PNGs exported by `mobile/ios/scripts/export-xcresult-screenshots.py` (`xcresulttool export attachments`, with a legacy `get` fallback) to the orphan branch `ci/ios-screenshots` under `<short-sha>/`. Files are named `<TestClass>-<testMethod>--<attachment>.png`; the attachment names carry the light/dark suffix.
List them with: `gh api "repos/Tamerlan12345/chat/contents/4ac747a?ref=ci/ios-screenshots"` (also `776f5d1/`, `210038e/`, `300d9b9/`). Raw image: add `-H "Accept: application/vnd.github.raw"` and the file path.

## Files changed (3f7dabe..4ac747a; 57 files, +6077/−1528)

- **New:** `App/AppContainer.swift`, `App/RootView.swift`, `App/Stores/{Session,Realtime,Conversations,Chat,Announcements,Call,Profile}Store.swift`, `App/Stores/StoreSupport.swift`, `Core/Repositories/{Repositories,LiveRepositories}.swift`, `Core/WebSocket/WebSocketTransport.swift`, `Core/Logging/Log.swift`, `Resources/Localizable.xcstrings`, `UI/DesignSystem/Components/ListLoadStateView.swift`, `scripts/export-xcresult-screenshots.py`, `scripts/generate-string-catalog.py`, and the tests `Support/TestDoubles.swift`, `RealtimeChatTests`, `SessionLifecycleTests` (with `PasswordChangeFlowTests` and `PartialLoadTests`), `ReconnectBackoffTests`, `LocalizationTests`.
- **Deleted:** `App/AppState.swift`.
- **Modified:** all feature views, `WebSocketClient`, `APIClient`, `APIError`, `KeychainManager` (strings only), models (`String(localized:)`, `call_end`), `CentyButton`/`CentyTextField` (`LocalizedStringKey`), the app entry point, `project.pbxproj` (synchronized `CentyChatTests` group; `SWIFT_EMIT_LOC_STRINGS`, `LOCALIZATION_PREFERS_STRING_CATALOGS`), `.github/workflows/mobile-ios.yml`, and the README.

## Concerns / remaining

1. **Fixture-decode test not done (blocked).** The controller asked me to `git merge mobile-release-parity-impl` (d90418b). The Claude Code permission classifier denied that merge ("Modify Shared Resources"), so I did not merge, copy or read the fixtures. To finish: once a user or controller merges `mobile-release-parity-impl` into `mobile/ios` (or authorizes the merge), add a folder reference to `../contracts/fixtures` in the CentyChatTests resources and a test that iterates `manifest.json`, decoding each HTTP file into its DTO and each WS file with `WSServerEvent.parse`, asserting the result is not `.unknown`. The DTOs already tolerate unknown fields (keyed containers), so the extra `user` fields should decode. `call_end` without `targetUserId` is already handled. Estimated as one small commit.
2. The "dark" screenshots in `ScreenshotTourTests` are rendered in light appearance; `XCUIDevice.appearance` does not seem to take effect. This predates Task 6 (Task 1 test) and is worth fixing in Task 7.
3. Commit 44b33d6 does not build its tests alone (see the CI note). The fixes came after the RED commit as planned; no history rewrite or force push was done on `mobile/ios`.
4. `ChatStore` instances are cached per conversation for the whole session and cleared on logout. That is fine for corporate volumes, but there is no LRU yet.
5. Behaviour changes to note for review:
   - A launch with a stored server now shows a brief `ProgressView` (`.launching`) instead of flashing the server-setup or login screen.
   - The mandatory password change is a root screen with a «Выйти» button.
   - Empty lists show a spinner, or an error with «Повторить».
   - Health check failures no longer block session restore.
6. The UI tests still only reach server setup. Login, chat and call screens need the Task 11 fixed server or stubs for screenshots.

---

# Fix round 1/5

**Status:** both Important issues and the Minor items are fixed, and the final CI run is green.
**Range:** `4ac747a..c65d4d0` (7 commits), pushed to `mobile/ios`.
**Final green run:** https://github.com/Tamerlan12345/chat/actions/runs/36965070363 (HEAD c65d4d0). 84 unit tests and 3 UI tests pass, and 6 screenshots were published to `ci/ios-screenshots/c65d4d0/`.

## Changes

| # | Issue | Fix commit | What changed |
|---|---|---|---|
| 1 | The open chat raised unread and never sent `mark_read` | e13f1f6 | `ChatDetailContent` calls `store.setVisible(true/false)` in `onAppear`/`onDisappear`. `ChatStore.setVisible` reports the on-screen `ConversationKey` to `ConversationsStore.setConversation(_:visible:)`, and `reset()` clears it. `handleIncomingMessage` (direct and channel) skips the unread increment for that key. While visible, `ChatStore` handles each new incoming message (not an echo or update) by calling `markConversationRead` and sending `.markRead`. |
| 2 | Backoff reset on any first frame, including `auth_error` | 296742c | `WebSocketClient` stays `.connecting` until a parsed `auth_success`; only then does it move to `.connected` and reset the backoff. On `auth_error` it closes the socket right away instead of waiting for the server's 10 s auth timeout and schedules a growing retry. Each error code is reported once per failure streak; the streak resets on `auth_success` or an intentional `disconnect()`. Jitter is clamped so the delay is at most 30 s. |
| Minor | English copy | 6b9b5dd | "OK" → «ОК», "Email" → «Эл. почта», "UIN" → «Идентификатор (UIN)» (desktop also says "UIN"). The catalog was regenerated, the Latin `EXTRA_KEYS` were dropped, and `LocalizationTests` now checks «ОК» and «Эл. почта». |
| Minor | Screenshot publishing | ed6a28b | `git ls-remote --exit-code --heads` tells an absent branch (exit 2) from an error (job fails). The push no longer uses `--force`. `upload-artifact` is pinned to `ea165f8…` (v4.6.2) and `download-artifact` to `d3f86a1…` (v4.3.0). The publish into the existing branch was verified in run 36965070363. |
| — | UI tour flake | c65d4d0 | `ScreenshotTourTests` waits for the keyboard, retrying the tap up to 3 times, before `typeText`. Run 36964517524 had failed with "Neither element nor any descendant has keyboard focus" and passed on rerun. |

## Covering tests (RED commit 53f086c)

- `RealtimeChatTests.testIncomingMessageInTheVisibleChatStaysReadAndIsMarkedRead`: with the chat on screen, a `direct_message` + `new_message` pair leaves unread at 0 and sends `mark_read`.
- `RealtimeChatTests.testIncomingPairForADialogThatIsNotOnScreenRaisesUnreadByExactlyOne`: a dialog that is open but no longer visible gets exactly +1 unread and no `mark_read`. This test passed before the fix and now guards the behaviour.
- `ReconnectBackoffTests`:
  - `testBackoffStartsOverAfterASuccessfulConnection` now uses `auth_success`.
  - New: `testFramesBeforeAuthSuccessDoNotResetTheBackoff` (a `wake_state` frame gives [1, 2, 4, 8]).
  - New: `testAuthErrorClosesTheSocketWithoutResettingTheBackoff` (`RATE_LIMITED` on a socket the server keeps open gives [1, 2, 4, 8]).
  - New: `testRepeatedAuthErrorIsReportedOnce`.
  - New: `testJitterNeverPushesTheDelayAboveTheCap`.

## CI runs

| Run | Commit | Result |
|---|---|---|
| [36964415709](https://github.com/Tamerlan12345/chat/actions/runs/36964415709) | 53f086c | **RED** as intended: exactly 5 new tests fail; 79 other unit tests and the UI tests pass |
| [36964517524](https://github.com/Tamerlan12345/chat/actions/runs/36964517524) | ed6a28b | 84/84 unit tests pass; the UI dark tour hit the focus flake; **GREEN** on rerun of the failed job |
| [36965070363](https://github.com/Tamerlan12345/chat/actions/runs/36965070363) | c65d4d0 | **GREEN** final: 84 unit + 3 UI; screenshots published without `--force` |

## Notes

- The fixture-decode test was not done, per the ruling: it moves to Task 11 after the controller merges this branch.
- `setVisible` stays true while the app is in the background with a chat open. Tying it to `scenePhase` would be a small follow-up if wanted.

---

# Fix round 2/5

**Status:** fixed; CI green. Range `c65d4d0..9434f51` (2 commits), pushed to `mobile/ios`.
**Final green run:** https://github.com/Tamerlan12345/chat/actions/runs/36965575415 (HEAD 9434f51). 89 unit tests and 3 UI tests pass, and 6 screenshots were published to `ci/ios-screenshots/9434f51/`.

## Changes

- **False read receipts in the background (Important).**
  - `ChatDetailContent` reads `@Environment(\.scenePhase)` and reports to the store from three places: `onAppear` calls `store.screenDidAppear(sceneIsActive: scenePhase == .active)`, `onDisappear` calls `store.screenDidDisappear()`, and `onChange(of: scenePhase)` calls `store.sceneActivityChanged(isActive:)`.
  - The rule lives in the testable value type `ChatScreenPresence` (`isVisible = appeared && sceneIsActive`) inside `ChatStore.swift`. `ChatStore` derives `isVisible` from it and reports it to `ConversationsStore`.
  - When the chat becomes visible again because the scene returned to `.active`, the store awaits `markAsRead()`. This sends `mark_read` and resets the local unread count, catching up on messages that arrived while the app was away.
  - The public `setVisible` is gone; the behaviour change itself is in 9434f51.
- **auth_error paths end in `disconnect()` (Minor check).** Confirmed: `MUST_CHANGE_PASSWORD` goes through `requirePasswordChange()`, which calls `realtime.stop()` and then `disconnect()`. That cancels the reconnect the socket client scheduled when it closed after the `auth_error`. `INVALID_TOKEN` goes through `revalidate`; when the token can't be recovered, it calls `realtime.stop()` and then `endSession()`. Covered by two new assertions, which passed in the RED run and act as guards. The only path that keeps retrying is the deliberate offline case: `revalidate` couldn't reach REST, so the session is kept and the socket retries with backoff.

## Covering tests (RED commit 0176875)

- `RealtimeChatTests.testChatOpenWhileTheAppIsInTheBackgroundStaysUnreadUntilTheUserReturns`: with the scene inactive, a `direct_message` + `new_message` pair gives +1 unread and no `mark_read`. Returning to active sends `mark_read` and resets unread to 0.
- `RealtimeChatTests.testChatAppearingWhileTheSceneIsInactiveIsNotVisible`
- `RealtimeChatTests.testChatScreenPresenceIsVisibleOnlyWhenShownInTheForeground`: the full truth table of the model.
- `SessionLifecycleTests.testRealtimeMustChangePasswordStopsTheSocket` and `testRealtimeInvalidTokenThatCannotBeRevalidatedStopsTheSocket` (guards).
- The existing visible-chat tests now use the new presence API.

## CI runs

| Run | Commit | Result |
|---|---|---|
| [36965559244](https://github.com/Tamerlan12345/chat/actions/runs/36965559244) | 0176875 | **RED** as intended: the 3 new presence tests fail (5 assertions); the 2 socket guards and the other 84 tests pass |
| [36965575415](https://github.com/Tamerlan12345/chat/actions/runs/36965575415) | 9434f51 | **GREEN**: 89 unit + 3 UI |
