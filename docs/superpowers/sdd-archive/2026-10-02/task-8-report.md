# Task 8 report: Android toolchain, Navigation 3, Hilt, realtime/lifecycle fixes

**Status: DONE_WITH_CONCERNS.** All acceptance commands are green. The concerns are listed at the end: the compileSdk 36 pin limits library versions, authenticated end-to-end testing against a live server isn't possible over debug HTTP, and two side effects outside the worktree.

- Worktree: `.claude/worktrees/m-android`, branch `mobile/android`, base `e8f3dba`. Not pushed.
- Only `mobile/android/**` and `.github/workflows/mobile-android.yml` were edited.

## Commits (e8f3dba..b3f7540)

| SHA | Message |
|---|---|
| a03578a | build(android): upgrade to Gradle 9.8, AGP 9.4 and Kotlin 2.4 with compileSdk 36 |
| c562894 | refactor(android): inject dependencies with Hilt behind repositories |
| 9fbd2d7 | feat(android): migrate navigation to Navigation 3 with per-tab back stacks |
| d08963a | fix(android): correct realtime events, unread counts and call lifecycle |
| 4dc3b90 | test(android): add Hilt instrumented tests for onboarding and entry scoping |
| b3f7540 | test(android): cover signed-in tabs, back and logout on a device |

65 files changed, +3555 / −1059.

## Versions chosen

Every version below was verified by building, not assumed.

| Component | Before | After | Note |
|---|---|---|---|
| Gradle | 8.10.2 | **9.8.0** | Current release; wrapper regenerated. |
| AGP | 8.7.0 | **9.4.1** | Latest stable. Uses built-in Kotlin, so the `kotlin-android` plugin is gone and `kotlinOptions` became `kotlin { compilerOptions }`. |
| Kotlin (compose + serialization plugins) | 2.0.21 | **2.4.20** | |
| KSP | – | **2.3.12** | |
| Hilt | – | **2.60.1** | Plus `androidx.hilt:hilt-lifecycle-viewmodel-compose` **1.3.0**; 1.4.0 pulls lifecycle 2.11, which needs compileSdk 37. |
| compileSdk / targetSdk | 35 / 35 | **36 / 36** | As the brief requires. |
| Compose BOM | 2024.10.01 | **2026.06.01** | Compose 1.11.4, material3 1.4.0, navigation-suite 1.4.0. |
| Navigation 3 runtime/ui | – | **1.1.7** | |
| lifecycle (incl. `lifecycle-viewmodel-navigation3`) | 2.8.7 | **2.10.0** | |
| core-ktx | 1.15.0 | **1.18.0** | |
| activity-compose | 1.9.3 | **1.13.0** | |
| kotlinx-serialization | 1.7.3 | **1.11.0** | |
| kotlinx-coroutines | 1.9.0 | **1.11.0** | |
| androidx.test | – | runner 1.7.0, rules 1.7.0, ext-junit 1.3.0, espresso 3.7.0 | |
| `navigation-compose` | 2.8.3 (unused) | **removed** | |

OkHttp 4.12.0 and security-crypto 1.1.0-alpha06 were deliberately left unchanged, so the security layer isn't touched.

**Why not the newest libraries.** I checked the AAR metadata (`minCompileSdk`) of each newer release:

- Compose BOM 2026.08.00 and later require compileSdk 37.
- Navigation 3 1.2.0, including its beta and rc builds, requires 37.
- lifecycle 2.11 requires 37.
- core 1.19 requires 37.
- `adaptive-navigation3` requires 37. Every release of it does, including 1.3.0, the only stable one.

Because the brief pins compileSdk 36, I used the newest releases that compile against 36. The Material `ListDetailSceneStrategy` lives in `adaptive-navigation3`, so I replaced it with a custom list-detail `Scene`, written as in the nav3 `scenes-listdetail` recipe.

## Architecture changes

**Dependency injection (Hilt)**
- `CentyChatApp` is `@HiltAndroidApp`; `MainActivity` is `@AndroidEntryPoint`.
- Modules:
  - `SessionModule` provides `SessionManager`. Tests replace it via `@TestInstallIn`.
  - `AppModule` provides the application scope, `ApiClient`, `WebSocketClient`, `CallAudio`/`AudioEngine` and `SessionVerifier`.
  - `RepositoryModule` holds the `@Binds` declarations.
- The service locator is gone.

**Repositories** (in `data/repository`)
- `SessionRepository`, `AuthRepository`, `ChatRepository`, `AnnouncementsRepository`, `ProfileRepository` and `RealtimeRepository`, each an interface with a default implementation.
- ViewModels no longer touch `ApiClient` or `WebSocketClient`.
- `CallAudio` is an interface over `AudioEngine`, so call logic can be tested on the JVM.

**One `UiState` sealed type per screen**
- Existing: `ServerConnectUiState`, `LoginUiState`.
- New: `ConversationsUiState` (Loading/Error/Content), `ChatUiState` (Loading/Error/Content), `AnnouncementsUiState`, `ProfileUiState` (Loading/Content), `CallUiState` (Incoming/Outgoing/Active/Ended).
- Activity-level: `PasswordChangeUiState` in `AppViewModel`.
- Some input or "chrome" state is kept as separate small flows rather than inside the sealed type:
  - Conversations: tab, search.
  - Chat: typing, editing, wake cooldown.
  - Profile: the one-off `logoutError` and `storageError` messages.
- ViewModels for Chat and Call get their navigation arguments through assisted injection.

**Realtime connection lifecycle**
- A new `RealtimeConnectionManager` runs in the application scope. It connects and disconnects with the session, and recreating the activity no longer drops the socket.
- `MainActivity.onDestroy` disconnects only when `isFinishing`.

**Navigation 3** (in `ui/navigation`)
- **`AppNavigationState`**:
  - The sign-in stack (`authBackStack`), plus one `NavBackStack` per tab: Conversations, Announcements, Profile.
  - The current tab is persisted with `rememberSerializable` and `NavBackStackSerializer(NavKey.serializer())`. This is reflection-free, so it is safe under R8.
  - Each stack is decorated with `rememberSaveableStateHolderNavEntryDecorator()` and `rememberViewModelStoreNavEntryDecorator()`. Each ViewModel belongs to its entry and is cleared when the entry is popped.
- **`AppNavigator`** owns the navigation rules:
  - Tabs never stack duplicates; reselecting a tab pops to its root.
  - Back exits through Conversations.
  - Chats replace each other.
  - A second incoming call is rejected as busy (`AppViewModel.rejectBusy`).
  - Logout clears every stack, including the tab roots, so no ViewModel leaks into the next session, and shows Login (or ServerConnect when no server is configured).
  - `syncWithSession` re-checks a restored stack against the session before it renders.
- **`NavKey`** implements nav3's `NavKey`. `NavKey.Call` carries a `callId`, so every call attempt is a distinct entry with its own ViewModel.
- **`CentyNavigation`** wraps `NavDisplay` in a `NavigationSuiteScaffold`:
  - It shows a bottom bar or a rail depending on the adaptive window info. The bar is hidden in a chat on compact widths and during calls.
  - From medium width, the `ListDetailScene` shows the Conversations list next to the open Chat, without a back arrow (`LocalBackButtonVisibility`).
  - The per-screen bottom bars were removed. The bar keeps the old Conversations colours.
- **Session guard:** it decides from the synchronous session snapshot. The collected flow lags one emission behind a sign-in. I found this on the emulator: after a successful login the guard bounced straight back to Login.
- `NavBackStack.kt` and `NavHost.kt` (custom) were deleted.

**Edge-to-edge:** the existing per-screen `Scaffold`/`TopAppBar` insets were kept, and `NavigationSuiteScaffold` manages its own bar insets, as the edge-to-edge skill describes. Screenshots on the Pixel 8 look correct.

**Windows build:** the redirected build directory is now `%TEMP%\centychat-android-build\CentyChat-<hash of checkout path>\app`. Previously, parallel worktrees shared it and another session's Gradle daemon locked its lint jars. The README is updated.

## Defects fixed and the tests that cover them (TDD)

For every behaviour fix I first added the API as inert stubs, so the new tests compiled and failed on their assertions (RED). Then I implemented the fix (GREEN).

| Defect | Fix | Test(s) | RED → GREEN |
|---|---|---|---|
| Tabs appended duplicate entries; logout navigated instead of clearing; no per-tab stacks | `AppNavigator` and `AppNavigationState` | `AppNavigatorTest` (14 tests) | RED was a compile failure (types didn't exist) → 14/14 |
| ViewModels were Activity-scoped, so a repeated call to the same peer reused the ENDED `CallViewModel` and closed instantly | nav3 ViewModel-store decorator per stack, plus a unique `callId` | `AppNavigatorTest.repeatedCallsToTheSamePeerGetDistinctEntries`; device test `EntryScopedViewModelTest` (4 tests) | Mutation check: without the decorator, 3 of 4 device tests fail with `ComposeTimeoutException` (the tab-retention control passes) → 4/4 |
| Back during a call didn't end it (the peer stayed in the call) | `CallViewModel.leave()` plus `BackHandler` in `CallScreen`; `onCleared` sends `call_end` (or `call_rejected` while ringing) if the call is unfinished | `CallViewModelLifecycleTest` (6 tests) | 5/6 RED (`expected:<[call_offer 7, call_end 7]> but was:<[call_offer 7]>`) → 6/6 |
| Chat events and audio frames shared one 64-slot `SharedFlow`, so `tryEmit` could drop chat or signalling events | Separate `audioFrames` flow (DROP_OLDEST); chat buffer raised to 256 | `WebSocketClientRealtimeTest.audioFramesTravelOnTheirOwnFlow…` | RED → GREEN |
| `new_message` and `direct_message`/`channel_message` for the same message were each processed (double unread) | Dedupe by message id in `WebSocketClient` (last 512 ids) | `…theSameMessageDeliveredAsNewMessageAndDirectMessageIsEmittedOnce` | RED → GREEN |
| No `connectionState` | `ConnectionState` (Disconnected/Connecting/Connected/Unauthorized), exposed through `RealtimeRepository`; Conversations header shows "Подключение…" when not connected | `…connectionStateFollowsTheSocketAndAuthentication` | RED → GREEN |
| `auth_error` was ignored (endless reconnect loop with a bad token) | `INVALID_TOKEN`/`MUST_CHANGE_PASSWORD`: close the socket and stop until the token changes. Other codes: back off and retry. `RealtimeConnectionManager` re-checks a refused token over HTTP via `SessionVerifier` (`getMe()`), which refreshes the token, or clears the session on 401 and the guard shows Login | `…rejectedTokenClosesTheSocketAndStopsReconnecting`, `…aNewTokenAfterRejectionCanConnectAgain`, `…transientAuthRefusalsAreRetriedWithBackoff`; `RealtimeConnectionManagerTest` (3 tests) | 6/6 WS tests RED → GREEN; manager 1/3 RED (the 2 controls passed) → 3/3 |
| Unread was incremented for the open chat and for my own channel messages | `ActiveConversationRegistry` (the chat registers while resumed via `LifecycleResumeEffect`); own and open-conversation messages are not counted; opening a chat zeroes its badge; a message from a peer missing in the list triggers a silent reload | `ConversationsViewModelRealtimeTest` (6 tests) | 4 RED (2 controls passed) → 6/6 |
| Direct `message_deleted` only matched `targetId == peer`, but the server sends the message's `target_id`, i.e. the recipient (`server/src/ws/server.js:671-677`) | Match `targetId == peer` or `targetId == me` (removal is by unique id) | `ChatViewModelRealtimeTest.peerDeletingTheirMessage…` (4 tests in total) | RED → GREEN |
| A chat in the back stack marked messages read | `markRead` only while the chat is visible (resumed) | `ChatViewModelRealtimeTest.onlyAVisibleChatMarksMessagesRead…` | RED → GREEN |
| `server_disconnect` forced the Login screen while the session was kept | Show a toast only. The reconnect then either succeeds (for example after a role change) or comes back as `auth_error` and goes through the HTTP verification above | Covered by the `auth_error` and manager tests | – |

Existing tests were changed only to swap constructors for repository implementations (`DefaultAuthRepository(...)`, etc.). No assertion was changed. Affected files: `LoginViewModelStorageTest`, `ServerConnectViewModelStorageTest`, `ProfileViewModelLogoutStorageTest`, `SessionManagerPersistentInvalidationTest`.

**Security invariants preserved**
- `ServerEndpointPolicy`: HTTPS only, bearer tokens only over HTTPS.
- Fail-closed `SessionManager` and `SessionInvalidationStore`.
- `RefreshCoordinator`, untouched.
- Backup exclusions, untouched.
- Release minification still on: `verify-release-configuration.ps1` passes and `ReleaseConfigurationTest` is green.

## Command output summary (final run)

1. `JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache clean testDebugUnitTest lint assembleDebug`
   - **BUILD SUCCESSFUL.** Unit tests: 26 suites, **102 tests, 0 failures, 0 errors** (63 before this task).
   - Lint: **0 errors**, 67 warnings. All warnings are pre-existing (unused string resources, UseKtx, ConstantLocale, etc.).
2. `./gradlew.bat … assembleRelease assembleDebugAndroidTest`
   - **BUILD SUCCESSFUL**; R8 `minifyReleaseWithR8` passed.
   - `verify-release-configuration.ps1` passed.
3. `ANDROID_SERIAL=emulator-5554 ./gradlew.bat … connectedDebugAndroidTest` on Pixel_8 (API 37 image)
   - **BUILD SUCCESSFUL.** **6 tests, 0 failures.**
   - `OnboardingTest` (1): first launch shows server setup, and plain HTTP to a public host is refused in Russian without navigating.
   - `EntryScopedViewModelTest` (4): see the table above.
   - `MainNavigationTest` (1): signed-in tab switching with correct selection, back from a secondary tab returns to Conversations, and logout clears the session and shows Login. Screenshots were checked visually: edge-to-edge top bar, bottom navigation bar, the "Подключение…" hint while offline.
4. CI workflow (`.github/workflows/mobile-android.yml`) now also runs `assembleDebugAndroidTest`, so the instrumented tests compile in CI. CI still uses JDK 17, which AGP 9.4 needs.

## Concerns / remaining items

1. **compileSdk 36 vs latest libraries.** The newest Compose BOM (2026.09.00), Navigation 3 1.2.0, lifecycle 2.11, core 1.19, hilt-lifecycle-viewmodel-compose 1.4.0 and `adaptive-navigation3` (Material `ListDetailSceneStrategy`) all require compileSdk 37. If the controller allows compileSdk 37 (targetSdk can stay 36), these can be bumped and the custom `ListDetailScene` swapped for the Material strategy. The android-37.0 platform is already installed locally.
2. **No authenticated end-to-end run against a real server.**
   - Debug builds allow HTTP to `10.0.2.2`, but `ServerEndpointPolicy.canSendBearerCredentials` (correctly) sends bearer tokens only over HTTPS. So on a debug HTTP endpoint, `/auth/device/claim` returns 401, `ApiClient` clears the session, and the user lands back on Login with no error message. This is the existing security invariant, not a regression.
   - Real end-to-end needs the dev-stand CA (`https://10.0.2.2:8443`) trusted in debug builds, which is Integration's or a follow-up's call.
   - Authenticated UI was instead verified on the device with an unreachable HTTPS endpoint (`MainNavigationTest`).
   - The list-detail / rail layout on a tablet-width window was not checked on a device. It is covered only by logic and compilation.
3. **Side effects outside my worktree (please review).**
   - While trying to start a private seeded server, I first launched the **main checkout's** `chat/server`. That version ignores `DATA_DIR`, so it ran against the shared `chat/server/data` used by the dev server on :2004. Seeding stopped at the first step, after **3 failed `admin` login attempts** (the server may temporarily rate-limit or lock `admin` login). No data was created.
   - Earlier I made **1 failed `alice` login** against :2004 with curl.
   - I then ran the `m-integration` server code (read-only use) with `DATA_DIR` in my scratchpad on :2005, and stopped it at the end.
4. **The emulator `emulator-5554` disappeared mid-session** (no process left). I restarted `Pixel_8` on port 5554 with `-no-snapshot-save`; it is still running.
5. **Windows-only, outside git:**
   - Lint 9.x rejects an unescaped `local.properties` (`PropertyEscape`). I changed my git-ignored `local.properties` to `sdk.dir=C\:/…`; other checkouts need the same. The README documents it.
   - The redirected build directory name changed (`CentyChat-<hash>`). The README and the install command are updated.
6. **For Task 9 to verify:**
   - Bottom-inset handling of the screens' own `Scaffold`s inside `NavigationSuiteScaffold` at the very end of scrolled content. It looks fine on the phone screenshots.
   - The rail and list-detail layout on tablets.
   - Loading/error states were added to Chat and Announcements with plain M3 components. Task 9 should style them.
7. The release APK is unsigned, so it was built and shrunk but not installed or run.

## Files changed

- **Build:** `mobile/android/{build.gradle.kts, app/build.gradle.kts, gradle/libs.versions.toml, gradle/wrapper/*, gradlew, gradlew.bat, README.md}`, `.github/workflows/mobile-android.yml`.
- **New main sources:**
  - `AppViewModel.kt`
  - `core/audio/CallAudio.kt`
  - `core/network/ConnectionState.kt`
  - `data/realtime/{ActiveConversationRegistry,RealtimeConnectionManager}.kt`
  - `data/repository/{Session,Auth,Chat,Announcements,Profile,Realtime}Repository.kt`
  - `di/{AppModule,ApplicationScope,RepositoryModule,SessionModule}.kt`
  - `ui/navigation/{AppNavigationState,AppNavigator,CentyNavigation,ListDetailScene}.kt`
- **Modified main sources:**
  - `CentyChatApp.kt`, `MainActivity.kt`
  - `core/audio/AudioEngine.kt`, `core/network/WebSocketClient.kt`
  - all `features/**` ViewModels and Screens (Announcements, Login, Call, Chat, ServerConnect, Conversations, Profile)
  - `ui/navigation/NavKey.kt`
- **Deleted:** `ui/navigation/{NavBackStack,NavHost}.kt`.
- **Unit tests (new):**
  - `core/network/WebSocketClientRealtimeTest`
  - `data/realtime/RealtimeConnectionManagerTest`
  - `features/{call/CallViewModelLifecycleTest, chat/ChatViewModelRealtimeTest, conversations/ConversationsViewModelRealtimeTest}`
  - `ui/navigation/AppNavigatorTest`
  - `testing/{Fakes, InMemorySharedPreferences, MainDispatcherRule}`
- **Unit tests (constructor-only changes):** Login, ServerConnect, Profile and SessionManagerPersistentInvalidation tests.
- **Instrumented tests (new):** `androidTest/{HiltTestRunner, TestSessionModule, OnboardingTest, navigation/EntryScopedViewModelTest, navigation/MainNavigationTest}`.

---

## Fix round 1

**Status: DONE.** New commits on `mobile/android`, not pushed:

| SHA | Message |
|---|---|
| c792041 | fix(android): back off on repeated WebSocket session refusals |
| 08b22a0 | fix(android): split conversations and chat only on expanded widths |
| 9974a0e | fix(android): keep a finished call from disturbing the next one |

### 1. Important: transient `auth_error` reconnect loop at ~1 Hz (c792041)

**Changes**
- `WebSocketClient`: `reconnectAttempts` is no longer reset in `onOpen`. It is reset only on `auth_success`.
- `scheduleReconnect(minDelayMs, maxDelayMs)`: refusals back off exponentially (x2 per attempt, ±20% jitter):
  - TOO_MANY_SESSIONS starts at 10 s.
  - RATE_LIMITED and unknown codes start at 2 s.
  - The cap is 60 s.
  - Network loss keeps the previous 1 s → 30 s backoff.
- **Shown to the user once:**
  - New state `ConnectionState.Retrying(code, message)`. It persists for the whole refusal streak; a new socket does not flip it back to `Connecting`.
  - `WsEvent.AuthError` is emitted once per streak.
  - The Conversations header shows the reason (one line, ellipsized) instead of "Подключение…". There are no repeated toasts.

**Tests (TDD).** New `WebSocketClientBackoffTest` runs the full open → `auth_error` cycle on each new socket with a virtual clock.

| Test | What it checks |
|---|---|
| `repeatedSessionLimitRefusalsBackOffInsteadOfLoopingEverySecond` | 3 cycles; the first gap is at least 5 s and gaps grow strictly |
| `noFourthSocketWithinThreeSecondsOfRateLimiting` | 3 refusals; no 4th socket within 3 s |
| `anAcceptedSessionResetsTheBackoff` | after `auth_success`, the next delay is shorter than the grown one |
| `theRefusalIsReportedOnceNotOnEveryRetry` | exactly 1 `AuthError` event; state is `Retrying` |

- RED, all 4 failing:
  - `first retry waits well over a second, was [1183, 1034, 1047]`
  - `expected:<3> but was:<4>`
  - `reset delay 943 must be shorter than grown delay 851`
  - `expected:<1> but was:<2>`
- GREEN: 4/4. Existing `WebSocketClientRealtimeTest` (6), `WebSocketClientLifecycleTest` (1) and `RealtimeConnectionManagerTest` (3) still pass.
- One test-setup fix along the way: the event collector needed `runCurrent()` before the first refusal.

### 2. Spec deviation: list-detail split only at expanded width (08b22a0)

- `usesListDetailPanes(windowSizeClass)` now requires `WIDTH_DP_EXPANDED_LOWER_BOUND` (840dp). Compact and medium windows are single-pane.
- `NavigationSuiteScaffold`:
  - Medium widths keep the rail, even while a chat is open.
  - Compact widths still hide the bar in a chat.
  - Calls hide it at every width.
- Removed the no-op `@Suppress("UNUSED_EXPRESSION") session`. The parameter still triggers recomposition; the decision uses the synchronous snapshot.
- Test: `ListDetailBreakpointTest`. Compact 411dp → single pane; medium 700dp → single pane; expanded 840dp → two panes.
  - RED: I first extracted the existing 600dp logic unchanged, and the test failed with `medium (e.g. 600-839dp) stays single-pane`.
  - GREEN after the change.

### 3. Minor items: call bugs (9974a0e)

- **Shared audio:** `CallViewModel` keeps its own `frameCallback`. `onCleared` detaches and stops the shared `CallAudio` only if `callAudio.onFrameRecorded === frameCallback`.
- **Found while testing this: a finished call is now terminal.**
  - Without this, an ENDED ViewModel still waiting for disposal reacted to the next call's `call_answer` from the same peer: it re-activated, then sent `call_end` for the *new* call when cleared.
  - `startActiveCall`/`endCall` now ignore a finished call, and `startActiveCall` ignores an already active one.
- **Restored calls:** `AppNavigator.syncWithSession` removes `NavKey.Call` entries from restored stacks, so there is no repeated `call_offer` and no phantom ringing screen.
- **Tests:**
  - `CallViewModelLifecycleTest.clearingAnOldCallDoesNotTearDownTheNextCallsAudio`
    - RED: `the shared engine must keep feeding the new call expected same…`.
    - After the ownership fix it still failed: `the finished call must not hang up the new one expected:<0> but was:<1>`, which led to the terminal-state guard.
    - GREEN after both.
  - `AppNavigatorTest.callsRestoredAfterProcessDeathAreDropped`: RED (`AssertionError`), then GREEN.

### Commands and output

- `JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache testDebugUnitTest lint assembleDebug`
  - **BUILD SUCCESSFUL.** 28 suites, **109 tests, 0 failures, 0 errors**.
  - Lint: 0 errors, 67 warnings (pre-existing).
- `ANDROID_SERIAL=emulator-5554 ./gradlew.bat … connectedDebugAndroidTest assembleRelease`
  - **BUILD SUCCESSFUL.**
  - `OnboardingTest` 1/1, `EntryScopedViewModelTest` 4/4, `MainNavigationTest` 1/1; R8 `minifyReleaseWithR8` passed.

### Files changed in this round

- **Main:**
  - `core/network/{WebSocketClient,ConnectionState}.kt`
  - `features/conversations/ConversationsScreen.kt`
  - `ui/navigation/{CentyNavigation,AppNavigator}.kt`
  - `features/call/CallViewModel.kt`
- **Tests:**
  - New: `core/network/WebSocketClientBackoffTest.kt`, `ui/navigation/ListDetailBreakpointTest.kt`.
  - Extended: `ui/navigation/AppNavigatorTest.kt`, `features/call/CallViewModelLifecycleTest.kt`.

### Concerns

The medium-width rail and the expanded-width two-pane layout are covered by unit tests and compilation only. They have not been checked on a tablet-size device.
