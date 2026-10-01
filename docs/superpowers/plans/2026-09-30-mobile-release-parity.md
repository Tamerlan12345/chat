# Mobile Release Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver secure, reproducibly buildable iOS and Android clients whose documented messaging, files and call behaviours are equivalent.

**Architecture:** Retain native SwiftUI and Jetpack Compose clients, but make their configuration, authentication, message lifecycle and contract fixtures explicit and testable. Platform-specific durable stores and audio engines sit behind narrow services; `mobile/contracts` defines request, event and delivery-state invariants. CI builds Android on Linux and iOS on macOS, with unsigned simulator testing before signing is added.

**Tech Stack:** Swift 6/SwiftUI/XCTest/Xcode, Kotlin 2/Jetpack Compose/Material 3/JUnit, Gradle, GitHub Actions, URLSession, OkHttp, Keychain, Android Keystore.

**Spec:** `docs/superpowers/specs/2026-09-30-mobile-release-parity-design.md`

## Global Constraints

- Release builds only send credentials, chat content and audio over HTTPS/WSS; local endpoints are debug-only build configuration.
- Tokens and device secrets fail closed if secure storage is unavailable and never enter Android backup/device transfer.
- Persist a server endpoint only after URL validation and successful connectivity verification.
- Clear a composer only after durable queueing or accepted delivery; reconnect never silently discards a message.
- `mobile/contracts/openapi.yaml` and `mobile/contracts/ws-protocol.md` remain the source of truth for observable behaviour.
- SwiftUI uses HIG, semantic colours, Dynamic Type, 44pt targets and permission recovery. Compose uses Material 3, 48dp targets, adaptive navigation and edge-to-edge/IME-safe content.
- Do not push, publish, configure signing secrets or create a paid device-farm account.

## Review Focus

- A malicious or mistyped endpoint must never receive an Authorization header, WebSocket auth frame, message content or audio; task 4 tests release validation and task 5 tests iOS validation.
- An encrypted-storage initialization failure must terminate authenticated Android startup safely, not retain plaintext credentials; task 6 tests this outcome.
- Concurrent 401 responses must share one refresh and keep a valid session; task 5 tests the re-entrant iOS path and task 4 tests Android parity.
- A send during a disconnect must appear as queued/failed and survive restart/reconnect exactly once; task 8 tests outbox ordering and replay.
- Large text, keyboard, rotation and screen-reader interaction must retain a reachable primary action; task 7 adds Compose and SwiftUI UI-test fixtures for those states.

---

### Task 1: Reproducible Android build and baseline test command

**Files:**
- Create: `mobile/android/gradlew`, `mobile/android/gradlew.bat`, `mobile/android/gradle/wrapper/gradle-wrapper.jar`
- Modify: `mobile/android/gradle/wrapper/gradle-wrapper.properties`, `mobile/android/app/build.gradle.kts`, `mobile/android/app/proguard-rules.pro`
- Test: `mobile/android/app/src/test/java/com/openmychat/mobile/build/ReleaseConfigurationTest.kt`

**Interfaces:**
- Consumes: Android SDK 35 and JDK 17.
- Produces: `./gradlew testDebugUnitTest lint assembleDebug assembleRelease` as the canonical Android verification command.

- [ ] **Step 1: Write failing release-configuration tests**
  Assert the release variant enables shrinking and that a debug variant may be identified without changing release transport policy.
- [ ] **Step 2: Run the test to verify it fails**
  Run: `cd mobile/android && .\gradlew.bat testDebugUnitTest --tests '*ReleaseConfigurationTest'`
  Expected: FAIL because the wrapper/configuration is absent or release shrinking is disabled.
- [ ] **Step 3: Commit the Gradle Wrapper and make release configuration explicit**
  Use the installed Gradle only to generate the project wrapper. Set release `isMinifyEnabled = true`; add focused R8 keep rules only for serializers or reflection proved by a release build.
- [ ] **Step 4: Run Android unit tests, lint and both builds**
  Run: `cd mobile/android && .\gradlew.bat testDebugUnitTest lint assembleDebug assembleRelease`
  Expected: PASS with debug APK and release APK generated.
- [ ] **Step 5: Commit**
  `git commit -m "build(android): add reproducible release verification"`

### Task 2: Create a buildable iOS application target and test scheme

**Files:**
- Create: `mobile/ios/CentyChat.xcodeproj/project.pbxproj`, `mobile/ios/CentyChat.xcodeproj/xcshareddata/xcschemes/CentyChat.xcscheme`, `mobile/ios/CentyChat/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json`, `mobile/ios/CentyChatTests/AppLaunchTests.swift`
- Modify: `mobile/ios/Package.swift`, `mobile/ios/CentyChat/App/CentyChatApp.swift`, `mobile/ios/CentyChat/Resources/Info.plist`, `mobile/ios/README.md`
- Test: `mobile/ios/CentyChatTests/AppLaunchTests.swift`

**Interfaces:**
- Consumes: existing `CentyChat` source and XCTest files.
- Produces: shared `CentyChat` iOS app scheme with `xcodebuild -scheme CentyChat -destination 'platform=iOS Simulator,name=iPhone 16' test`.

- [ ] **Step 1: Write a failing app-launch XCTest**
  Assert `XCUIApplication().launch()` exposes the server-setup accessibility identifier on a fresh install.
- [ ] **Step 2: Run it on macOS CI to verify it fails**
  Run: `xcodebuild -project CentyChat.xcodeproj -scheme CentyChat -destination 'platform=iOS Simulator,name=iPhone 16' test`
  Expected: FAIL because no app target/scheme exists.
- [ ] **Step 3: Add an iOS-only executable target**
  Create an iOS 17 app target, assets, `Info.plist` build setting, test target and shared scheme. Move the sole `@main` entry point into the app target; retain testable shared source without declaring unsupported macOS availability.
- [ ] **Step 4: Run the simulator suite**
  Run: same `xcodebuild` command from Step 2.
  Expected: PASS, including the existing DTO/audio/edit-window tests.
- [ ] **Step 5: Commit**
  `git commit -m "build(ios): add application target and simulator scheme"`

### Task 3: CI evidence for both native clients

**Files:**
- Create: `.github/workflows/mobile-android.yml`, `.github/workflows/mobile-ios.yml`
- Modify: `mobile/ios/README.md`, `mobile/android/README.md` (create if absent), `mobile/qa/reports/release-signoff.md`
- Test: workflow commands from Tasks 1 and 2.

**Interfaces:**
- Consumes: canonical Android and iOS test commands.
- Produces: named CI jobs `android-verify` and `ios-simulator-tests` with uploaded test results/logs.

- [ ] **Step 1: Write failing workflow contract checks**
  Add repository tests/scripts that assert each workflow invokes the canonical command and uploads its result directory.
- [ ] **Step 2: Run contract checks to verify they fail**
  Run: project-specific script added in this task.
  Expected: FAIL because workflows are absent.
- [ ] **Step 3: Add minimal GitHub Actions workflows**
  Android uses JDK 17 and `mobile/android/gradlew`; iOS uses a macOS runner, the shared Xcode scheme and an iPhone 16 simulator. Neither workflow reads signing secrets.
- [ ] **Step 4: Run workflow contract checks**
  Run: same command as Step 2.
  Expected: PASS; trigger CI after the branch is pushed by the repository owner.
- [ ] **Step 5: Commit**
  `git commit -m "ci: verify native mobile builds"`

### Task 4: Enforce Android release endpoint and TLS policy

**Files:**
- Create: `mobile/android/app/src/main/java/com/openmychat/mobile/core/network/ServerEndpointPolicy.kt`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`, `mobile/android/app/src/main/java/com/openmychat/mobile/core/session/SessionManager.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/features/connect/ServerConnectViewModel.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/core/network/ApiClient.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/core/network/WebSocketClient.kt`
- Test: `mobile/android/app/src/test/java/com/openmychat/mobile/core/network/ServerEndpointPolicyTest.kt`, `mobile/android/app/src/test/java/com/openmychat/mobile/core/network/RefreshCoordinatorTest.kt`

**Interfaces:**
- Produces: `ServerEndpointPolicy.validate(raw: String, allowInsecureDebug: Boolean): Result<ValidatedEndpoint>` and a release-only HTTPS/WSS invariant.
- Consumes: endpoint persistence and WebSocket URL construction from `SessionManager`.

- [ ] **Step 1: Write failing policy and concurrent-refresh tests**
  Cover HTTPS acceptance, HTTP/FTP rejection in release, `/api` normalization, `wss://` derivation, and two simultaneous refresh callers sharing one result.
- [ ] **Step 2: Run the targeted tests to verify they fail**
  Run: `cd mobile/android && .\gradlew.bat testDebugUnitTest --tests '*ServerEndpointPolicyTest' --tests '*RefreshCoordinatorTest'`
  Expected: FAIL because insecure endpoints are accepted and refresh coordination is not isolated.
- [ ] **Step 3: Implement endpoint policy and refresh coordination**
  Remove `usesCleartextTraffic`, make debug HTTP an explicit BuildConfig-only exception, store only a validated/verified endpoint, derive WSS from HTTPS and centralize refresh single-flight behaviour.
- [ ] **Step 4: Run targeted and full Android tests**
  Run: `cd mobile/android && .\gradlew.bat testDebugUnitTest`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "fix(android): enforce secure server endpoints"`

### Task 5: Enforce iOS endpoint, Keychain and refresh invariants

**Files:**
- Create: `mobile/ios/CentyChat/Core/Network/ServerEndpointPolicy.swift`, `mobile/ios/CentyChatTests/ServerEndpointPolicyTests.swift`, `mobile/ios/CentyChatTests/TokenRefreshCoordinatorTests.swift`
- Modify: `mobile/ios/CentyChat/Core/Storage/KeychainManager.swift`, `mobile/ios/CentyChat/Core/Network/APIClient.swift`, `mobile/ios/CentyChat/Core/WebSocket/WebSocketClient.swift`, `mobile/ios/CentyChat/Features/ServerConnect/ServerConnectView.swift`, `mobile/ios/CentyChat/App/AppState.swift`, `mobile/ios/CentyChat/Resources/Info.plist`

**Interfaces:**
- Produces: `ServerEndpointPolicy.validatedURL(_:) throws -> URL` and an actor/single-flight token refresh coordinator.
- Consumes: Task 2 executable app test target.

- [ ] **Step 1: Write failing XCTest cases**
  Assert release accepts only HTTPS, WebSocket derives WSS, invalid/unverified endpoints do not overwrite prior state, Keychain uses a ThisDeviceOnly protection class, and parallel 401s invoke refresh once without clearing a valid token.
- [ ] **Step 2: Run the tests to verify they fail**
  Run: `xcodebuild -project CentyChat.xcodeproj -scheme CentyChat -destination 'platform=iOS Simulator,name=iPhone 16' test -only-testing:CentyChatTests/ServerEndpointPolicyTests -only-testing:CentyChatTests/TokenRefreshCoordinatorTests`
  Expected: FAIL because HTTP/default endpoints and re-entrant refresh are currently allowed.
- [ ] **Step 3: Implement the smallest secure boundaries**
  Remove the production localhost default, persist endpoint only after successful health verification, route request/WS URL creation through the policy, use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` only when required by background operations, and serialize refresh retries.
- [ ] **Step 4: Run the iOS simulator suite**
  Run: canonical Task 2 command.
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "fix(ios): secure endpoint and token refresh"`

### Task 6: Fail-closed Android credentials and backup policy

**Files:**
- Modify: `mobile/android/app/src/main/java/com/openmychat/mobile/core/session/SessionManager.kt`, `mobile/android/app/src/main/AndroidManifest.xml`, `mobile/android/app/src/main/res/xml/backup_rules.xml`, `mobile/android/app/src/main/res/xml/data_extraction_rules.xml`
- Test: `mobile/android/app/src/test/java/com/openmychat/mobile/core/session/SessionManagerSecurityTest.kt`

**Interfaces:**
- Produces: an authenticated-session result that distinguishes secure-store failure from an empty session.
- Consumes: secure endpoint policy from Task 4.

- [ ] **Step 1: Write failing security tests**
  Assert encrypted-store initialization failure does not create/read a plaintext preference, and backup XML excludes `centychat_secure_session.xml` and `centychat_fallback_session.xml` if migration cleanup retains the latter name.
- [ ] **Step 2: Run tests to verify they fail**
  Run: `cd mobile/android && .\gradlew.bat testDebugUnitTest --tests '*SessionManagerSecurityTest'`
  Expected: FAIL because the plaintext fallback is used and current exclusion names do not match.
- [ ] **Step 3: Make storage fail closed and correct transfer exclusions**
  Delete the plaintext fallback path, expose a recoverable secure-storage error to onboarding, exclude actual old/new preference file names, and retain backups only for non-sensitive application data.
- [ ] **Step 4: Run full Android verification**
  Run: canonical Task 1 command.
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "fix(android): protect session storage and backups"`

### Task 7: Lifecycle, state and accessible navigation repairs

**Files:**
- Modify: `mobile/android/app/src/main/java/com/openmychat/mobile/ui/navigation/NavHost.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/ui/navigation/NavBackStack.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/features/auth/LoginScreen.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/features/connect/ServerConnectScreen.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/features/chat/ChatScreen.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/features/announcements/AnnouncementsScreen.kt`, `mobile/android/app/src/main/java/com/openmychat/mobile/features/call/CallScreen.kt`
- Modify: `mobile/ios/CentyChat/Features/ChatList/ChatListView.swift`, `mobile/ios/CentyChat/Features/ChatDetail/ChatDetailView.swift`, `mobile/ios/CentyChat/Features/Call/CallView.swift`, `mobile/ios/CentyChat/App/AppState.swift`, `mobile/ios/CentyChat/Core/Audio/AudioSessionManager.swift`, `mobile/ios/CentyChat/Resources/Info.plist`
- Test: Android Compose UI tests under `mobile/android/app/src/androidTest/`; iOS UI tests under `mobile/ios/CentyChatUITests/`

**Interfaces:**
- Consumes: secure onboarding from Tasks 4-6.
- Produces: destination-scoped call/chat state, non-duplicating top-level tab behaviour, explicit loading/error/retry states, and permission-denial recovery.

- [ ] **Step 1: Write failing platform UI tests**
  Cover repeated tab selection/back, re-opening a call to the same peer, a chat load failure and retry, an announcement error, keyboard/large-text reachable controls, and microphone denial with settings recovery.
- [ ] **Step 2: Run targeted UI tests to verify they fail**
  Run Android connected test and iOS simulator test commands for the cases from Step 1.
  Expected: FAIL because current state is retained incorrectly or hidden from the user.
- [ ] **Step 3: Implement native state and layout fixes**
  Give Android top-level destinations independent saved stacks and destination-scoped ViewModels; use Material adaptive navigation and Scaffold/inset/IME patterns. Use SwiftUI `NavigationStack`/sheets without nested controls, `ContentUnavailableView` for error/empty states, 44pt controls and explicit microphone authorization. Remove unsupported background modes.
- [ ] **Step 4: Run both platform UI suites**
  Run: Android `connectedDebugAndroidTest` and iOS canonical simulator suite.
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "fix(mobile): repair navigation state and recovery UI"`

### Task 8: Durable outbox, cache and realtime message state

**Files:**
- Create: `mobile/contracts/delivery-state.md`, iOS `Core/Storage/MessageOutbox.swift`, Android `core/storage/MessageOutbox.kt`
- Modify: iOS `App/AppState.swift`, `Core/WebSocket/WebSocketClient.swift`, `Features/ChatDetail/ChatDetailView.swift`; Android `core/network/WebSocketClient.kt`, `features/chat/ChatViewModel.kt`, `features/chat/ChatScreen.kt`
- Test: iOS `CentyChatTests/MessageOutboxTests.swift`; Android `app/src/test/.../MessageOutboxTest.kt`; contract fixtures in `mobile/contracts/fixtures/`

**Interfaces:**
- Produces: `DeliveryState { queued, sending, sent, delivered, read, failed }`, durable `enqueue`, `replay`, `markDelivered`, and idempotency key semantics.
- Consumes: secure session from Tasks 4-6 and WS events from `ws-protocol.md`.

- [ ] **Step 1: Define the idempotency and delivery-state contract, then write failing fixtures/tests**
  Specify operation identifier, ordering per conversation and replay duplicate handling. Test disconnected send, restart/replay, retry and edit/delete/delivery WS events.
- [ ] **Step 2: Run each platform's outbox test to verify it fails**
  Run Android `testDebugUnitTest --tests '*MessageOutboxTest'` and iOS focused XCTest.
  Expected: FAIL because no durable queue/realtime state reducer exists.
- [ ] **Step 3: Implement platform-local outbox/cache adapters and state reducers**
  Do not clear the composer until enqueue succeeds. Reconnect replays persisted operations in conversation order; surface failed operations. Map all documented message status/update/delete events into visible state.
- [ ] **Step 4: Run contract fixtures and full platform suites**
  Run: canonical Android and iOS test commands.
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "feat(mobile): add durable message delivery state"`

### Task 9: Complete conversations and file-policy parity

**Files:**
- Modify: Android `core/network/ApiClient.kt`, `features/conversations/ConversationsScreen.kt`, `features/conversations/ConversationsViewModel.kt`, `features/chat/ChatScreen.kt`, `features/chat/ChatViewModel.kt`; iOS `Features/ChatDetail/ChatDetailView.swift`, `Features/ChatDetail/MessageBubbleView.swift`, `Core/Network/APIClient.swift`
- Test: Android feature tests and iOS `CentyChatTests/FilePolicyTests.swift`, `CentyChatTests/ConversationCreationTests.swift`

**Interfaces:**
- Consumes: `GET /api/files/policy`, upload/download endpoints and outbox delivery state.
- Produces: equivalent direct-chat/channel creation, policy-gated selection, upload progress and supported image/PDF rendering.

- [ ] **Step 1: Write failing parity tests**
  Assert Android can create a channel/direct conversation, rejects a disallowed attachment before upload, exposes progress/failure/retry, and both platforms render a supported uploaded attachment from the same fixture.
- [ ] **Step 2: Run targeted tests to verify they fail**
  Run focused Android and iOS tests.
  Expected: FAIL because Android lacks these flows and uploads are not policy-gated.
- [ ] **Step 3: Implement the minimal contract-backed flows**
  Query policy before picker/upload, use server-provided type/size limits, model upload progress and route completed attachment messages through Task 8 delivery state. Preserve each platform's native picker/open experience.
- [ ] **Step 4: Run full suites and contract fixture checks**
  Run canonical Android and iOS commands.
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "feat(mobile): complete conversations and attachment parity"`

### Task 10: iOS audio relay and call lifecycle parity

**Files:**
- Create: `mobile/ios/CentyChat/Core/Audio/AudioRelayEngine.swift`, `mobile/ios/CentyChatTests/AudioRelayEngineTests.swift`
- Modify: `mobile/ios/CentyChat/Core/Audio/AudioSessionManager.swift`, `mobile/ios/CentyChat/Core/WebSocket/WebSocketClient.swift`, `mobile/ios/CentyChat/App/AppState.swift`, `mobile/ios/CentyChat/Features/Call/CallView.swift`, `mobile/ios/CentyChat/Resources/Info.plist`

**Interfaces:**
- Produces: `AudioRelayEngine.start(session:) async throws`, `stop()`, 16 kHz mono PCM capture/send, jitter-buffered playback and recoverable microphone state.
- Consumes: documented binary WS audio frame shape and call state events.

- [ ] **Step 1: Write failing deterministic audio tests**
  Assert a 16 kHz PCM frame has the documented byte size, silence gating/jitter buffering retain bounded latency, permission denial does not transition a call to active, and stop tears down capture/playback.
- [ ] **Step 2: Run focused XCTest to verify it fails**
  Run: iOS canonical test command restricted to `AudioRelayEngineTests`.
  Expected: FAIL because no capture/playback implementation or permission gate exists.
- [ ] **Step 3: Implement AVAudioEngine relay with explicit lifecycle boundaries**
  Configure audio session only after permission grant, install/remove input tap safely, send binary frames through existing WebSocket abstraction, schedule playback from jitter buffer, and stop on hangup/background/error.
- [ ] **Step 4: Run full iOS simulator suite and document physical-device evidence needed**
  Run: canonical iOS test command.
  Expected: PASS; mark actual microphone/hardware latency as a physical-device acceptance check, not simulated proof.
- [ ] **Step 5: Commit**
  `git commit -m "feat(ios): implement voice audio relay"`

### Task 11: Release evidence, device-farm handoff and final review

**Files:**
- Create: `mobile/qa/device-farm/browserstack-app-automate.md`
- Modify: `mobile/qa/test-scenarios/e2e-matrix.md`, `mobile/qa/reports/release-signoff.md`, `mobile/qa/reports/parity-audit-report.md`, `mobile/qa/reports/store-readiness-report.md`
- Test: CI workflow contract test plus final Android/iOS commands.

**Interfaces:**
- Consumes: CI artifacts from Task 3 and unsigned simulator/release verification from Tasks 1-10.
- Produces: evidence-labelled release report that never marks physical-device criteria passed without real-device output.

- [ ] **Step 1: Write failing report-consistency checks**
  Assert release reports cannot label a device-only scenario PASSED unless a linked CI/device-farm artifact and date are present.
- [ ] **Step 2: Run checks to verify they fail**
  Run: report-consistency command created in this task.
  Expected: FAIL because current reports claim release approval without the required evidence.
- [ ] **Step 3: Replace claims with evidence-based status and document BrowserStack handoff**
  Include IPA signing prerequisite, upload command placeholders, Appium/XCUITest test selection, required matrix (iOS versions, microphone, reconnect, Dynamic Type), and a clear distinction between CI simulator and physical-device proof.
- [ ] **Step 4: Run final local verification and CI after owner push**
  Run: canonical Android command; canonical iOS command on macOS CI; report-consistency command.
  Expected: all available checks PASS, with missing hardware evidence labelled pending.
- [ ] **Step 5: Commit**
  `git commit -m "docs: record mobile release evidence and device-farm handoff"`

## Final Review Gate

Use `superpowers:requesting-code-review` after Task 11. Review transport configuration, token persistence, backup contents, refresh races, offline replay idempotency, lifecycle cleanup and all contract deviations. Important findings receive one TDD fix pass; device-only evidence stays explicitly pending rather than being inferred from tests.
