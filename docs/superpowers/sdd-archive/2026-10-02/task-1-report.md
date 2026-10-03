# Task 1 report: iOS compiles, CI green, store-blocker metadata, screenshot evidence

**Status:** DONE_WITH_CONCERNS (the concerns are minor and listed below)
**Branch:** `mobile/ios` (worktree `m-ios`). Pushed to `origin/mobile/ios`. Head: `2e426ec`.
**Final green run:** https://github.com/Tamerlan12345/chat/actions/runs/36959971688. It ran 49 unit tests and 3 UI tests with 0 failures, and the privacy-manifest QA step passed.

## What changed

1. **Swift 6 compile fixes**
   - `KeychainManager`: computed properties called a private `get(key:)` helper. Inside `{ ... }` Swift parsed `get` as an accessor and failed with "expected '{' to start getter definition". I renamed the helper to `value(forKey:)`.
   - `AppState`: the default argument for `init(audioRelayFactory:)` built a `@MainActor` `AVAudioEngineBackend` and also called the `WebSocketClient` actor. The compiler rejected this with "default argument cannot be both main actor-isolated and actor-isolated". I replaced it with a `public convenience init()` that calls an internal `init(audioRelayFactory: @escaping @MainActor (Int64) -> AudioCallRelay)` and passes a `private static makeProductionAudioRelay`. Tests still inject their fake through the internal init.
2. **Swift 6 isolation in `AudioCallRelay.swift` (`AVAudioEngineBackend`)**
   - The input-tap closure and the `scheduleBuffer` completion closure are now built by `nonisolated static` factories: `makeCaptureTapBlock(deliver:)` and `makePlaybackCompletionHandler(generation:onFinished:)`.
     - Both return `@Sendable` handlers.
     - PCM mono-mixing and resampling run on the AVFoundation thread.
     - Only `deliver` / `onFinished` hop to the main actor. Both are `@MainActor @Sendable` and use `Task { @MainActor in ... }`.
   - Microphone permission now uses the iOS 17 `AVAudioApplication.shared.recordPermission` and `await AVAudioApplication.requestRecordPermission()`. This removes the completion closure that inherited main-actor isolation while the system called it off-main. It also clears the two iOS 17 deprecation warnings.
3. **Privacy manifest:** added `NSPrivacyAccessedAPICategorySystemBootTime` with reason `35F9.1`.
   - Playback host-time scheduling now uses `ProcessInfo.processInfo.systemUptime + delay` instead of the raw `mach_absolute_time()`. Both read the same clock and fall in the same required-reason category.
   - Reason for the switch: the QA-owned contract `mobile/qa/verify-ios-privacy-manifest.ps1` only recognises SystemBootTime usage through the regex `systemUptime`. With `mach_absolute_time` alone, declaring the category would fail that CI step, and I am not allowed to edit the script.
4. **Info.plist**
   - Removed `UIRequiredDeviceCapabilities=armv7`.
   - Added `UISupportedInterfaceOrientations~ipad` with all four orientations.
   - Did not add `UIRequiresFullScreen`. The iPhone orientation list is unchanged.
5. **Dead entry point:** deleted `CentyChat/App/CentyChatApp.swift`.
   - Removed it from the pbxproj `membershipExceptions` and from the `exclude` list in `Package.swift`.
   - Updated the README tree; the real `@main` is `CentyChatMobileApp/CentyChatMobileApp.swift`.
6. **Screenshot evidence:** added `CentyChatUITests/ScreenshotTourTests.swift`.
   - It uses the existing `LaunchTestFixture` flags (`CENTYCHAT_UI_TESTING=1`, `-reset-secure-state`) and runs in light and dark appearance (`XCUIDevice.shared.appearance`).
   - Each `XCTAttachment(screenshot:)` uses `.keepAlways`.
   - Without a server, three screens are reachable, so there are six screenshots: `01-server-setup`, `02-server-setup-insecure-url` (http rejected) and `03-server-setup-unreachable` (`https://127.0.0.1:9` connection error), each in `-light` and `-dark`.
   - The CI log of the green run confirms "Added attachment named ..." for all six. The xcresult artifact is 1.27 MB (artifact id 11207746279).
7. **Extra fix (memory safety):** `AudioRelayEngine.encodeFrame` appended `UnsafeBufferPointer(start: &value, count: 1)`, which is a dangling pointer and the compiler warned about it. It now uses `withUnsafeBytes(of:)`. The frame layout is unchanged and the existing `AudioRelayTests` encode/decode tests still pass.
8. **Project structure:** the test targets in this pbxproj are **not** file-system-synchronized. Only the app's `CentyChat/` root group is. So every new test file needed explicit `PBXFileReference`/`PBXBuildFile` entries.
   - I added a `CentyChatUITests` group and moved `AppLaunchTests.swift` into a new `CentyChatUITests/` folder, so UI tests no longer sit inside the unit-test folder. Its build membership (UI test target) is unchanged.
   - New unit tests: `BundleMetadataTests.swift` and `AudioEngineCallbackIsolationTests.swift`.

## CI runs

| # | Run | Head | Result | What it showed / what I did |
|---|-----|------|--------|-----------------------------|
| 1 | [36958770486](https://github.com/Tamerlan12345/chat/actions/runs/36958770486) | d031d6a (baseline) | failure | `KeychainManager.swift:80/102/130: expected '{' to start getter definition`; `AppState.swift:49: default argument cannot be both main actor-isolated and actor-isolated`. Fixed in 3499750. |
| 2 | [36959162633](https://github.com/Tamerlan12345/chat/actions/runs/36959162633) | cb80776 | failure (**RED**, expected) | App and tests compiled. 47 unit tests: 3 failures, all expected RED: `testPrivacyManifestDeclaresSystemBootTimeWithElapsedTimeReason` (no SystemBootTime entry), `testInfoPlistDoesNotRequire32BitArchitecture` (armv7 present), `testInfoPlistSupportsEveryIPadOrientationForMultitasking` (no `~ipad` list). UI tests passed: AppLaunch plus ScreenshotTour light and dark. |
| 3 | [36959552810](https://github.com/Tamerlan12345/chat/actions/runs/36959552810) | 917dd03 | failure (same 3 metadata REDs) | First attempt at the audio RED. The factories had the original main-actor isolation. The test built them on the main actor and called them from `DispatchQueue.global`. It only produced Swift 6 **warnings** (`capture of 'tap' with non-sendable type 'AVAudioNodeTapBlock' in a '@Sendable' closure`, same for `AVAudioNodeCompletionHandler`), and a direct Swift call did not trip a runtime isolation check, so both tests passed. That is not a real RED, so I made the test stricter. |
| 4 | [36959878941](https://github.com/Tamerlan12345/chat/actions/runs/36959878941) | 2a3c023 | failure (**RED**, expected) | The test now builds and calls the handlers entirely on a background queue. Compile errors: `AudioEngineCallbackIsolationTests.swift:16: call to main actor-isolated static method 'makeCaptureTapBlock(deliver:)' in a synchronous nonisolated context` and `:43 ... 'makePlaybackCompletionHandler(generation:onFinished:)'`. |
| 5 | [36959971688](https://github.com/Tamerlan12345/chat/actions/runs/36959971688) | 2e426ec | **success (GREEN)** | `iOS privacy manifest contract passed.` 49 unit tests and 3 UI tests, 0 failures, `** TEST SUCCEEDED **`. All 4 `BundleMetadataTests` pass. Both `AudioEngineCallbackIsolationTests` pass: samples are delivered on the main thread, 960 stereo frames at 48 kHz become 320 mono frames at 16 kHz with value 0.25, and the completion carries generation 7. Both ScreenshotTour tests pass. |

## TDD evidence
- **Privacy manifest and Info.plist (`BundleMetadataTests`):** the tests parse the files actually bundled in the built app (`Bundle(for: AppState.self)`). RED in run 2 (and again in run 3), GREEN in run 5 after commits 8992304 and a3fb316.
- **Audio callbacks (`AudioEngineCallbackIsolationTests`):** RED in run 4 (Swift 6 compile errors: handlers were main-actor isolated, so they cannot be built or called off-main). GREEN in run 5 after c4daff5. The tests invoke the tap handler and the playback completion from `DispatchQueue.global` without crashing, assert they are off the main thread there, and assert delivery happens on the main thread.
- No existing test was weakened or deleted. `AppLaunchTests` was moved to another folder only, and its content is unchanged.

## Commits (on top of d031d6a)
- 3499750 fix(ios): restore Swift 6 compilation of keychain and app state
- cb80776 chore(ios): drop legacy entry point and add bundle metadata and screenshot tests
- 917dd03 test(ios): cover AVAudioEngine callbacks invoked off the main thread
- 2a3c023 test(ios): build audio callbacks off the main actor in isolation tests
- c4daff5 fix(ios): keep AVAudioEngine callbacks off the main actor under Swift 6
- 8992304 fix(ios): declare SystemBootTime required-reason API in privacy manifest
- a3fb316 fix(ios): drop armv7 requirement and support iPad multitasking orientations
- 2e426ec fix(ios): stop appending dangling pointers when encoding audio frames

## Files changed
- `mobile/ios/CentyChat.xcodeproj/project.pbxproj`: exception set, new test file refs, `CentyChatUITests` group.
- `mobile/ios/CentyChat/App/AppState.swift`
- `mobile/ios/CentyChat/App/CentyChatApp.swift` (deleted)
- `mobile/ios/CentyChat/Core/Audio/AudioCallRelay.swift`
- `mobile/ios/CentyChat/Core/Storage/KeychainManager.swift`
- `mobile/ios/CentyChat/Core/WebSocket/AudioRelayEngine.swift`
- `mobile/ios/CentyChat/Resources/Info.plist`
- `mobile/ios/CentyChat/Resources/PrivacyInfo.xcprivacy`
- `mobile/ios/CentyChatTests/AudioEngineCallbackIsolationTests.swift` (new)
- `mobile/ios/CentyChatTests/BundleMetadataTests.swift` (new)
- `mobile/ios/CentyChatUITests/AppLaunchTests.swift` (moved from `CentyChatTests/`)
- `mobile/ios/CentyChatUITests/ScreenshotTourTests.swift` (new)
- `mobile/ios/Package.swift`
- `mobile/ios/README.md`
- `.github/workflows/mobile-ios.yml`: not changed. CI already uploads the xcresult.

## Self-review
- Isolation: the only code that now runs off-main is pure. It uses the `nonisolated` `monoSamples` and `AudioCaptureNormalizer.normalize` and captures no state. All backend state (`captureHandler`, `playbackGeneration`, the queue) is still reached only through main-actor closures.
- `[weak self]` is kept in the main-actor delivery closures, so taps and completions do not keep the backend alive.
- `ProcessInfo.systemUptime` and `CACurrentMediaTime()` both read the mach host clock, so computing `delay` against `CACurrentMediaTime` stays consistent.
- The `AppState()` public API is unchanged for the app. The factory init is internal, and its only caller is the existing `@testable` test.
- The only warnings left from the app target are the existing ones in `AppState.handleWebSocketEvent` (unused `let` patterns). They are out of scope and I did not touch them.

## Concerns
1. **QA regex gap:** `mobile/qa/verify-ios-privacy-manifest.ps1` maps SystemBootTime only to `systemUptime`. Using `mach_absolute_time()` would be legitimate but would fail the gate. QA may want to extend the pattern to `systemUptime|mach_absolute_time`.
2. **Screenshot coverage:** only the server-setup states are reachable with the existing fixture flags; CI has no server. Login, inbox, chat, profile and call screens need a fixture server or stubbed `AppState`. The plan's later task already extends `ScreenshotTourTests`.
3. **History:** commit 3499750 accidentally also carries the staged `CentyChatApp.swift` deletion and the `AppLaunchTests` move, while the matching pbxproj update is in cb80776. Each pushed head was compiled by CI (run 2 at cb80776), but 3499750 on its own is not a buildable state. I did not rewrite history because the branch was already pushed and force-push was not authorised.
4. **Screenshots not inspected:** I could not download the xcresult locally (the Azure blob connection is reset from this network). The attachments are confirmed only by the CI log lines and the artifact size, not by looking at the images.
