# Task 11 report: iOS fixed production server and branded login

**Status:** DONE_WITH_CONCERNS. Everything in the brief and the shared requirements is implemented and tested. The test job and the Release-lock job are green on the final head. Concerns, below, are mostly about CI: the screenshot publishing job could not run because of a GitHub billing block, and the first commit of the range does not build on its own.

- **Branch:** `mobile/ios` (worktree `m-ios`), range `e52d829..b659f4c` (14 commits), all pushed.
- **Final run:** https://github.com/Tamerlan12345/chat/actions/runs/36970343746 (HEAD `b659f4c`).
  - `ios-simulator-tests`: success. 133 unit tests and 5 UI tests (login tours and the signed-in inbox run against the dev stand).
  - `ios-release-server-lock`: success.
  - `publish-ios-screenshots`: not started. GitHub said: "recent account payments have failed or your spending limit needs to be increased". A rerun hit the same block. The overall run is therefore marked failed. See Concern 1.
- **Swift warnings:** none in the full log of run 36969741294; that is the last run whose log I could download (Concern 2).

## Server configuration (Release vs Debug)

The code is in `CentyChat/Core/Network/ServerEnvironment.swift`.

- **Value type.** `ServerEnvironment` holds `serverURL` (an origin only), `apiBaseURL` (`…/api`), `webSocketURL` (`wss://host[:port]/ws`) and `origin` (lower-case `scheme://host[:port]`, default port dropped).
  - `init?(validating:)` accepts only an `https` origin. It rejects credentials, any path other than `/`, query and fragment.
  - `production` is `https://centychat-production.up.railway.app`.
- **Release.** `ServerEnvironment.current` is `#if DEBUG … #else return .production #endif`.
  - `resolve(.release, …)` returns `.production` and ignores every input.
  - The override code (`DebugOverride`: Info.plist key, launch argument, UI-test flag) sits inside `#if DEBUG`, so it is not compiled into Release.
  - **CI proof:** the job `ios-release-server-lock` builds Release with `CENTYCHAT_SERVER_URL=https://override.invalid`. `scripts/verify-release-server-lock.sh` then checks the binary. It must contain the production URL. It must not contain `override.invalid`, `-centychat-server-url`, `CentyChatServerURL`, `CENTYCHAT_UI_TESTING`, `-reset-secure-state` or `-centychat-color-scheme`. The job passes.
- **Debug.**
  - **Build setting:** `CENTYCHAT_SERVER_URL` is a target build setting (default production) that reaches Info.plist as `CentyChatServerURL = $(CENTYCHAT_SERVER_URL)`. Example: `xcodebuild … CENTYCHAT_SERVER_URL=https://localhost:8443`.
  - **UI tests:** they can also pass `-centychat-server-url <url>`. It is honoured only when `CENTYCHAT_UI_TESTING=1`.
  - **Validation:** non-https or malformed values fall back to production.
  - **No runtime switch:** there is no UI to change the server in any build.
- **Release Info.plist.** Release also sets `CENTYCHAT_SERVER_URL` to production, so the plist value is consistent. Release code never reads it.
- **Where the environment is injected.**
  - `APIClient(environment:)` replaces the stored keychain URL.
  - `SessionStore(environment:)` uses it, for example for `attachmentURL`, which now accepts only server-relative paths.
  - `AppContainer(environment:)` passes it through.
  - The `WebSocketClient` default credentials use it.
  - The repository and `APIClient` "probe another server" APIs were removed.
- **Server setup removed.** `Features/ServerConnect/ServerConnectView.swift` is deleted, along with `SessionPhase.serverSetup`, `probeServer`, `configureServer`, `returnToServerSetup` and `serverAddress`. The login screen no longer has the «Сервер» toolbar button or the server and device lines.
- **CI never talks to production.**
  - The Debug test build is compiled with `CENTYCHAT_SERVER_URL=https://localhost:8443`.
  - UI tests pass the stand URL, or the unreachable `https://127.0.0.1:9`.
  - The unit-test host app renders `Color.clear` and never bootstraps (`LaunchTestFixture.isUnitTestHost`, DEBUG only).

## Migration of stale stored URLs and credentials

The code is `KeychainManager.bindCredentials(toOrigin:)`, called first thing in `SessionStore.bootstrap()` through `AuthRepository.bindStoredCredentials(to:)`.

- **Issuer binding.** A new Keychain item `credential_origin` records the server the token and device secret belong to.
  - If it is missing, the issuer is read from the legacy `server_url` item that older versions wrote from the user-typed address.
  - Token or secret with issuer = this build's origin: kept.
  - Token or secret with a foreign or unknown issuer: `clearAllAuthData()` wipes them before any request is sent. This includes an `http://` legacy URL and an install that switched Debug server.
- **Stale URL cleanup.** The legacy `server_url` item is always deleted and never read as a server. `KeychainManager.serverUrl` and `saveServerURL` no longer exist.
- **Fail closed.** If the wipe fails, `bindCredentials` throws and `credential_origin` is not written. SessionStore then goes to `.signedOut` without restoring the session or sending a knock.
- **What is kept.** `device_id` (an identifier, not a credential) and `saved_username` (the login name) survive.
- **First launch.** A fresh install (no token, no device secret) starts in `.signedOut`, with no spinner and no setup step. A launch with credentials starts in `.launching`.
- **Late knock.** The launch-time knock no longer overrides a login the user has started or finished in the meantime.

## Security decisions mapped to the threat model

| Threat (shared requirements) | Decision / control | Test |
|---|---|---|
| Spoofing / phishing via an editable server | Server field and setup screen removed; Release constant; overrides only in DEBUG; Release binary checked in CI | `ServerEnvironmentTests` (7), CI `ios-release-server-lock`, `AppLaunchTests` (no server control, no https field) |
| Credentials presented to the wrong server | Issuer binding plus wipe before the first request; fail closed | `CredentialBindingTests` (7), `LegacyInstallMigrationTests.testForeignSessionIsWipedAndNeverSent` (records every request: only the fixed host is contacted; no `Authorization`; the foreign secret is never in a body), `SessionLoginTests.testForeignHostSession…`, `…WipeFailureFailsClosed` |
| Transport | HTTPS/WSS only (`ServerEndpointPolicy` checks unchanged, `wss` derived from the https origin); system TLS and hostname validation; no custom trust delegate. **No pinning** (Railway wildcard cert, Let's Encrypt root rotation); follow-up once a company domain exists | existing `EndpointSecurityTests` |
| Info disclosure: password | Password lives only in `LoginFormModel.password` (memory) and goes straight into `LoginRequest`. It is cleared after success, never logged (grep: no `Log` call touches password, token or secret; no `print`) and never persisted. `SecureField` plus `.privacySensitive()`; the visible field has autocorrect off and `.textContentType(.password)` | `LoginFormModelTests.testSuccessForgetsThePassword…` |
| Info disclosure: account existence and server internals | Fixed client copy. 400/401/403/404 and `.unauthorized` give «Неверный логин или пароль»; other HTTP codes give a generic message; server `error` text is never shown. `APIClient` no longer turns a raw non-JSON body into the error message | `LoginErrorMappingTests` (8) |
| Info disclosure: `company_name` | Plain `Text(String)`. `BrandCopy.companyLine` strips control, format (bidi override) and line-separator characters, collapses whitespace, caps at 80 characters with «…» and falls back to «Корпоративный мессенджер» | `testCompanyNameIsPlainCappedText`, `testCompanyNameComesFromTheServer` |
| DoS / abuse: double submit | `LoginFormModel.submit` ignores calls while one is in flight; `SessionStore.login` throws `loginInProgress`; the button is disabled while submitting | `testSecondSubmitWhileSigningInIsIgnored`, `testConcurrentLoginIsSentOnce` |
| DoS / abuse: 429 and 503 | `APIError.httpError` carries `retryAfter` (`RetryAfter` parses seconds or an HTTP date, capped at 24 h). 429 counts down (default 60 s); 503 `LOGIN_BUSY`/`PASSWORD_HASH_BUSY` counts down (default 5 s). Submit is blocked until the deadline, with no retry loop | `testThrottling…` (3), `testBusyServerCountsDown`, `RetryAfterTests` (2, one through `APIClient` with a 429 plus a `Retry-After` header) |
| Convenience without weakening security | Autofill (`.username`/`.password`), next/go keys, show/hide toggle (44 pt), last successful login prefilled, passwordless knock/claim untouched | `testLastLoginNameIsPrefilledOnce` |

Notes on these decisions:
- **Login name storage.** The last login name stays in the Keychain (`saved_username`, `ThisDeviceOnly`) rather than in UserDefaults. That is stricter than the "non-secret prefs" wording and needs no migration. It is now saved only after a *successful* login; before, it was saved before the request.

## Branded login (design brief)

- **Mark.** `UI/DesignSystem/Components/BrandMark.swift`. `BrandCShape` is an exact port of `BRAND_C_PATH`: each SVG quarter-arc becomes the same tangent arc. The gradient fill uses the 5 stops at 135° on an `rx 205/880` square, with the light rim. No SF Symbol is used.
  - `BrandMarkTests` pins the glyph bounds to (329.8, 190)–(619.8, 690) and checks its fill and holes.
- **Tokens.** New tokens in `CentyColors` follow the brief: canvas, card, border, text, danger-text/soft/line, gradient.
- **Screen.** `Features/Auth/LoginView.swift`:
  - **Top:** mark at 72 pt (scaled, capped at 120), the «Centy**Chat**» wordmark (`.largeTitle`, header trait) and the company line.
  - **Card:** labelled «Логин» and «Пароль» fields (48 pt), the eye toggle and a full-width «Войти» button.
  - **«Войти» button:** disabled until both fields are filled; in-place progress «Вход…»; press scale 0.97 (off with Reduce Motion).
  - **Error box:** like the desktop `.login-error-box`, with a live countdown (`TimelineView`, numeric content transition) and a VoiceOver announcement.
  - **Layout and motion:** content in the upper third and keyboard-safe (ScrollView, interactive dismiss); hint «Забыли пароль? Обратитесь к администратору.»; mark fades and scales in once per launch, skipped with Reduce Motion.
- **Simulator screenshots** for `b698278`, published under `ci/ios-screenshots/b698278/`:
  - `01-login-{light,dark,ax-xxxl}` and `02-login-error-{light,dark,ax-xxxl}`.
  - The company name comes from the stand. The error state is the generic message from the stand's 400.
  - The **dark tour now really renders dark.** UI tests pass `-centychat-color-scheme dark`, honoured only in DEBUG with `CENTYCHAT_UI_TESTING=1` through `.preferredColorScheme`, in addition to `XCUIDevice.shared.appearance`.
  - In these shots the password field looks empty after a failed attempt even though «Войти» is enabled. That is how iOS treats screen capture of secure text entry; the model still holds the password.
- **Final-head shots.** The tour at `b659f4c` also captures `03-inbox-alice-{light,dark}`, and the AX company line is no longer clipped (it was cut at 3 lines in `b698278`). These are in the run artifact `ios-screenshots` of run 36970343746. They were not published to the branch (Concern 1).

## Fixture decode test (deferred from Task 6)

- **Bundling.** `mobile/contracts/fixtures` is a folder reference (`../contracts/fixtures`, SOURCE_ROOT) in the CentyChatTests Resources phase. No files are copied.
- **`testEveryManifestFixtureDecodes`.**
  - It iterates `manifest.json` (77 entries).
  - Each `http/*` fixture is decoded into its DTO and key fields are checked. An unmapped fixture fails with "no DTO is mapped".
  - Each `ws/*` frame goes through `WSServerEvent.parse`. It fails on nil or `.unknown`, and checks that the parsed case matches the manifest `event`.
- **`testEveryFixtureFileIsListedInTheManifest`** catches files that are missing from the manifest.
- **Model changes:** new DTOs `SyncResponse`, `DeviceClaimResponse`, `SuccessResponse` and `CurrentUserResponse` (`APIClient` now uses them instead of private structs). `WSServerEvent.iceCandidate` is parsed and then ignored, because calls use the audio relay.
- **Result:** only `ice_candidate` failed in RED; every other fixture already decoded.

## TDD: RED / GREEN runs

| Run | Commit | Result |
|---|---|---|
| [36967314848](https://github.com/Tamerlan12345/chat/actions/runs/36967314848) | 68269cc (tests plus compile scaffolding with stub bodies) | **cancelled.** It hung because, with the guard missing, `testConcurrentLoginIsSentOnce` deadlocked on its own gate. The stand started and the CA was trusted on the runner. |
| [36969302952](https://github.com/Tamerlan12345/chat/actions/runs/36969302952) | 148f00f (deadlock-free test) | **RED as intended.** 130 unit tests with 81 failures, all in the new tests (ServerEnvironment, CredentialBinding, LegacyInstallMigration, LoginErrorMapping, LoginFormModel, SessionLogin, RetryAfter, fixtures: `ice_candidate`), plus 5/5 UI tests failing. All earlier tests pass. |
| [36969741294](https://github.com/Tamerlan12345/chat/actions/runs/36969741294) | b698278 (implementation) | 133/133 unit tests pass; Release lock passes; 4/5 UI tests pass. The signed-in tour failed because `CODE_SIGNING_ALLOWED=NO` gave the app no entitlements, so the Keychain save of the token failed (`errSecMissingEntitlement`) and the app correctly stayed on login, failing closed. Screenshots were published to `ci/ios-screenshots/b698278/`. |
| [36970343746](https://github.com/Tamerlan12345/chat/actions/runs/36970343746) | b659f4c (ad-hoc signing, AX unclip) | **GREEN** tests: 133 unit tests and 5 UI tests, plus the Release lock. The publish job was blocked by billing. |

## Screenshot branch path

- `ci/ios-screenshots/b698278/`: the 6 login shots (light, dark, AX XXXL × empty and error).
- The final head `b659f4c` (including `03-inbox-alice-{light,dark}`) is only in the run artifact `ios-screenshots` of run 36970343746, because publishing was blocked by billing.

## Files changed (`e52d829..b659f4c`: 40 files, +2441/−484)

- **New, app:**
  - `Core/Network/ServerEnvironment.swift`, `Core/Network/RetryAfter.swift`
  - `Features/Auth/LoginFormModel.swift` (`LoginFailure`, `LoginFormModel`, `BrandCopy`)
  - `UI/DesignSystem/Components/BrandMark.swift`
  - `Models/SyncResponse.swift`
- **New, tests:**
  - `ServerEnvironmentTests`, `CredentialBindingTests` (plus `LegacyInstallMigrationTests`), `LoginFlowTests` (`LoginErrorMapping`, `RetryAfter`, `LoginFormModel`, `SessionLogin`), `ContractFixtureTests`, `BrandMarkTests`
  - `Support/TestSupport.swift` (`ServerEnvironment.test`, `TestGate`, seeded in-memory Keychain), `Support/RecordingURLProtocol.swift`
- **New, scripts:** `scripts/pick-simulator.py`, `scripts/verify-release-server-lock.sh`.
- **Deleted:** `Features/ServerConnect/ServerConnectView.swift`.
- **Modified:**
  - Session and wiring: `SessionStore`, `AppContainer`, `RootView`, `CentyChatMobileApp`, `LaunchTestFixture`
  - Network and storage: `APIClient`, `APIError`, `KeychainManager`, `WebSocketClient`, `Repositories`, `LiveRepositories`
  - UI and resources: `LoginView` (rewritten), `CentyColors`, `Localizable.xcstrings` (+13 keys via the generator), `Info.plist`
  - Models: `AuthResponses`, `WebSocketEvents`
  - Project: `project.pbxproj` (fixtures folder reference, `CENTYCHAT_SERVER_URL`)
  - Tests: `DTOParsingTests`, `SessionLifecycleTests`, `TestDoubles`, `AppLaunchTests`, `ScreenshotTourTests`
  - Docs: `README.md`
- **Workflow:** `.github/workflows/mobile-ios.yml`
  - New steps: setup-node (pinned v4.4.0), start the dev stand and wait for `/api/health`, boot the simulator and run `simctl keychain add-root-cert` (simulator only).
  - Test run: tests by simulator id, ad-hoc signing, `TEST_RUNNER_CENTYCHAT_DEV_STAND_URL`, stand log on failure.
  - New `ios-release-server-lock` job.
  - Path triggers for `mobile/contracts/fixtures/**` and `mobile/dev/**`.
  - Timeout raised to 45 minutes.

## Concerns

1. **GitHub billing / spending limit is blocking jobs.** `publish-ios-screenshots` did not start ("recent account payments have failed or your spending limit needs to be increased"), and a rerun hit the same block. As a result:
   - Run 36970343746 is marked failed even though both test jobs are green.
   - The final-head screenshots, including the alice inbox, exist only as the run artifact.
   - Further CI runs may not start until billing is fixed. After that, rerun the publish job of 36970343746, or push again.
2. **I could not look at the final artifact or log myself.** From this machine, connections to `productionresultssa6.blob.core.windows.net` were reset after about 05:50 (earlier downloads worked). So:
   - I have not visually inspected `03-inbox-alice-*` or the unclipped AX shot.
   - The inbox test only passes by reaching the tab bar and the seeded «Боб Тестов» row against the stand, so the green job is evidence that sign-in works end to end. The screenshot still needs a human look.
3. **The first commit in the range does not build on its own.** `ServerConnectView.swift` was already staged and landed in `fc452ee` (the CI commit) instead of `68269cc`. I did not rewrite pushed history.
4. **The RED commit contains scaffolding.** To keep RED a runtime failure rather than a compile failure, `68269cc` includes the plumbing: environment injection, removal of server setup, and stub bodies (`productionURLString = "https://server.invalid"`, `resolve` always production, `bindCredentials` a no-op, no login guard, `LoginFailure` always `.unavailable`). The real bodies follow in `60df3cb..1e9686d`.
5. **CI now ad-hoc signs simulator builds** (`CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=-`). That is required for any test that uses the real Keychain. No team or secrets are needed.
6. **Behaviour notes for review.**
   - A fresh install still sends `/auth/knock` in the background (unchanged behaviour: the device is queued as pending for the admin).
   - After a wrong password, the password is kept so a typo can be fixed, and «Войти» stays enabled.
   - Old ServerConnect strings remain in the String Catalog: the generator never removes keys, and they are unused.
   - The login name is kept in the Keychain, not UserDefaults (see the security section).
7. **Certificate pinning is not added**, per the threat model. Follow-up: pin to the company domain's key once one exists.
