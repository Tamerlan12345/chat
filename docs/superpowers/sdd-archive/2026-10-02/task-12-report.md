# Task 12 report: Android — fixed production server and branded login

**Status: DONE_WITH_CONCERNS.** Every acceptance command is green, and a real sign-in as `alice` against the HTTPS dev stand was proven on `emulator-5554`. The concerns are listed at the end.

- Worktree: `.claude/worktrees/m-android`, branch `mobile/android`, base `8ea22d7`. Not pushed.
- Only `mobile/android/**` was edited.

## Commits (8ea22d7..51c101b)

| SHA | Message |
|---|---|
| 9ac1352 | test(android): decode every contract fixture with the client DTOs and WS parser |
| b9e5f1a | feat(android): fix the production server at build time and drop server setup |
| 9dd607b | feat(android): secure login behaviour: generic errors, throttling, no double submit |
| 4d201d7 | feat(android): branded login screen |
| 51c101b | build(android): trust the local dev stand CA in debug builds only |

67 files changed, +2612 / −969.

## Server configuration (release vs debug)

**`app/build.gradle.kts`**
- `val productionServerUrl = "https://centychat-production.up.railway.app"`. `buildConfig = true`.
- **release:** `buildConfigField("String", "SERVER_URL", "\"$productionServerUrl\"")`. It never reads a property.
- **debug:** `SERVER_URL` comes from the Gradle property `centychat.serverUrl` (`providers.gradleProperty`), defaulting to production. Configuration fails unless the value matches `https?://host[:port]`, so no quotes or paths can be injected into BuildConfig.

**`core/config/ServerConfig`** (object, no mutable state)
- `endpoint = resolve(BuildConfig.DEBUG, BuildConfig.SERVER_URL)`.
- `resolve(isDebugBuild = false, …)` ignores the configured value and returns the production constant. This is a second guard in case a release BuildConfig were ever mis-generated.
- In debug the URL is validated by `ServerEndpointPolicy`: HTTPS, or HTTP only to loopback and emulator hosts. A bad value throws at start.

**`SessionManager`**
- It now *receives* the endpoint: `serverEndpoint` is a constructor `val`, and `serverUrl` / `wsUrl` derive from it.
- Removed:
  - `var serverUrl` setter
  - `validateServerEndpoint`
  - `useServerEndpointForVerification`
  - `commitVerifiedServerEndpoint`
  - `restorePersistedServerEndpoint`
  - `serverUrlFlow`
  - `isDebuggableBuild`
- `ApiClient`: `checkHealthAt`, `knockAt` and the separate verification client are gone. Bearer credentials go only to the fixed HTTPS endpoint, as before.
- `WebSocketClient` uses `sessionManager.serverEndpoint` (WSS only).

**Server setup removed**
- `NavKey.ServerConnect`, `ServerConnectScreen`, `ServerConnectViewModel` and its test are deleted.
- `AuthRepository.connect()` / `ServerConnectResult` and `SessionRepository.hasConfiguredServer` are gone.
- `AppNavigationState.signedOut()` and `AppNavigator.onLoggedOut()` always land on `Login`.
- The «Сменить адрес сервера» button is gone.
- **No runtime override exists:**
  - `MainActivity` reads no intent extras or data, and there is no deep link.
  - The stored value is never used to choose the endpoint (see migration).
  - `ServerConfigTest.noRuntimePathCanChangeTheServer` asserts this by reflection: no setter or connect methods on `SessionManager`, `AuthRepository` or `SessionRepository`; no `Server*` NavKey; no mutable fields in `ServerConfig`.

**Device announcement**
- `/auth/knock` used to run inside server setup. It now runs once when the login screen is shown (`LoginViewModel.onScreenShown()`).
- If the server answers `paired` with a session, the user is signed in without a password.
- Device claim after a password login is untouched.

## Migration of stale stored URLs and credentials

`SessionManager.discardCredentialsIssuedByAnotherServer()` runs on start while storage is available.

**What `server_url` means now**
- The stored `server_url` (the key older installs used for the typed address) is reinterpreted as "the server that issued the stored credentials". It is never used to pick the endpoint.

**When the wipe happens**
- If the stored value normalises to a different API base than the build's server, or credentials (token, user or device secret) exist without any stored server, one encrypted commit:
  - removes the token, user, must-change flag, device secret and the server-derived edit/delete windows;
  - writes `server_url` = current server.
- The user lands on Login.

**What is kept, and how failures behave**
- The device id is not a credential and is kept.
- A failed commit goes through the existing fail-closed path: storage becomes `UNAVAILABLE` and the session is persistently invalidated.

**Binding new sessions**
- Every new session (`persistAuthenticatedSession`, and recovery after persistent invalidation) writes `server_url` in the same commit.
- So a debug build switched between the dev stand and production signs out instead of sending a token to the other host.
- Recovery after persistent invalidation no longer needs a "verified endpoint": the fixed endpoint is written in the single recovery commit, before the markers are cleared.

## Security decisions mapped to the threat model

| Threat | Decision / control | Evidence |
|---|---|---|
| Spoofing / phishing to a look-alike server | No server field, setup screen, override or stored URL; release URL is a compile-time constant with a runtime guard | `ServerConfigTest` (5), `ReleaseConfigurationTest.releaseBuildHardCodesTheProductionServer`, `OnboardingTest` (no "сервер"/"Подключ" text on first launch); release APK dex contains the production host and not `10.0.2.2:8443` |
| Token sent to a foreign host | Credentials bound to the issuing server and wiped on mismatch; bearer only over HTTPS to that host (unchanged `ServerEndpointPolicy.canSendBearerCredentials`) | `SessionManagerServerBindingTest` (5) |
| MITM | System TLS plus hostname check, HTTPS/WSS only; release has no network security config. Pinning not added (Railway wildcard, Let's Encrypt rotation): ruling, follow-up once a company domain exists. A TLS failure shows its own message (`TLS_ERROR`), not "offline" | `ApiClientLoginErrorTest.certificateFailures…`, `DebugOnlyTrustTest.releaseHasNoNetworkSecurityOverride`, aapt2 dump of the release manifest (no `networkSecurityConfig`) |
| Dev CA leaking into release or git | Trusted only through a generated debug-variant overlay, for local hosts only; never copied into `src/`; a PEM containing `PRIVATE KEY` is refused; user CAs never trusted | `DebugOnlyTrustTest` (3); release APK has no `dev_ca` / NSC entries; debug APK `trust-anchors` = system + `@raw/centychat_dev_ca` |
| Password disclosure: logs | OkHttp logging-interceptor dependency removed (unused); no `Log`/`println` in auth, network or session code | `CredentialHygieneTest` (3) |
| Password disclosure: persistence | Password is held only in ViewModel memory and plain `remember` (not `rememberSaveable` / `SavedStateHandle`), cleared after success. Tokens and the device secret stay in the encrypted, fail-closed store. Only the login name goes to `centychat_login` prefs, after success only, max 256 chars | `LoginViewModelTest.theLastLoginNameIsRemembered…`, `aFailedSignInDoesNotRememberTheName`, `LoginTextTest.onlyTheLoginNameIsStored…`, `CredentialHygieneTest.thePasswordFieldIsNeverSaved…` |
| Password field exposure | `KeyboardType.Password`, autocorrect off, masked by `PasswordVisualTransformation` (Compose disables copy/cut for it; semantics show no `CopyText` action), show/hide toggle | `LoginScreenTest.thePasswordIsMaskedUntilRevealed` (checks the laid-out text: `••••••••` → `Secret-1`) |
| Account enumeration | 400 / 401 / 403 → «Неверный логин или пароль»; the server's text is never shown | `LoginViewModelTest.wrongPasswordAndUnknownLoginLookTheSame`, `LoginScreenTest.wrongCredentialsShowOneGenericMessage`; seen live with a real 400 from the stand |
| Untrusted `company_name` | Plain Compose `Text` only. Control, format and bidi-override characters stripped; collapsed to one line; capped at 80 chars with "…"; blank → fallback | `LoginTextTest.companyNameIsPlainSingleLineText…`, `LoginViewModelTest.theCompanyName…` |
| DoS / abuse: double submit | `Loading` is set synchronously and `login()` returns early while loading or throttled. Before the fix, three taps sent **3** requests | `LoginViewModelTest.aSecondSubmitWhileSigningInSendsNoSecondRequest`, `LoginScreenTest.aSecondTap…` |
| DoS / abuse: throttling | 429 → countdown from `Retry-After` (default 60 s, cap 3600 s); 503 `LOGIN_BUSY` → countdown (default 5 s). Submit disabled until it ends; no automatic retry | `ApiClientLoginErrorTest` (5), `LoginViewModelTest` (throttling, busy), `LoginScreenTest` |
| Convenience without weakening | Autofill hints (`ContentType.Username` / `Password`), IME Next/Go, remembered login name, show/hide toggle, knock/claim kept | Screenshots; `LoginScreenTest` |

## Contract fixture parity (requested)

**What `ContractFixturesTest` checks** (4 tests). It walks `mobile/contracts/fixtures/manifest.json`, so a new fixture is covered as soon as it lands.
- Every file on disk is listed in the manifest, and the reverse.
- Every HTTP fixture decodes:
  - success responses with the client DTO for that route;
  - error statuses as `ApiErrorBody`.
- Every WS frame goes through the new pure `WsEventParser`:
  - it must map to the expected `WsEvent`, or to an explicitly ignored type (`ice_candidate`, `user_created`, `user_updated`);
  - an unknown type fails the test.
- Key values are checked against the contract: `client_msg_id`, `announcementId` as a string, epoch ms in wake events, message and target ids, `connection_lost`, `MUST_CHANGE_PASSWORD`.
- The real `ApiClient` methods are run against the recorded bodies.

**Real bugs it found (now fixed)**
- `GET /api/auth/me` returns `{ user }`, but `getMe()` decoded a bare `User`. Every session re-verification after a refused WebSocket token therefore failed with `SERIALIZATION_ERROR`.
- `POST /api/auth/refresh` returns `{ token }`, but the client required `user`, so token refresh never worked.
- JSON `null` in `customStatus` / `reason` became the string `"null"`.

**DTOs added for contract parity:** `MeResponse`, `RefreshResponse`, `LogoutResponse`, `ApiErrorBody`, `SyncPage`, `Message.clientMsgId`.

**Build wiring:** Gradle registers the fixtures directory as a test input, so the tests re-run when fixtures change.

## RED → GREEN evidence

**1. Contract** (stub parser that returns `Unknown`): 3 of 4 failed.
- Every `ws/*` fixture was reported as unknown to the parser.
- `getMe: … Fields [id, username, full_name] are required … missing`
- `refreshToken: … Field 'user' is required …`
- GREEN: 113 tests, 0 failures.

**2. Fixed server** (inert stubs: endpoint parameter ignored, `resolve` honoured any URL): 10 of 29 selected tests failed.
- `expected https://[centychat-production.up.railway.app]/api but was https://[attacker.example]/api`
- `SessionManager exposes a server override expected:<[]> but was:<[setServerUrl, commitVerifiedServerEndpoint, restorePersistedServerEndpoint, useServerEndpointForVerification]>`
- All 5 binding tests failed.
- `firstLaunchGoesStraightToLogin`: `expected [Login] but was [ServerConnect]`.
- The release build-script check failed.
- Knock tests: RED with a no-op `announceDevice()` (2 of 2), then GREEN.
- GREEN: 125 tests, 0 failures.

**3. Login behaviour** (skeleton with old behaviour): 16 failures.
- `Error(Unexpected)` instead of `InvalidCredentials` / `Throttled` / `ServerBusy` / `Offline`.
- Double submit: `expected:<1> but was:<3>`.
- `Retry-After` was null (`expected:<42>`).
- `[TLS]_ERROR` vs `[NETWORK]_ERROR`.
- The logging-dependency guard, sanitising, countdown format and preferences all failed.
- GREEN: 145 tests, 0 failures.

**4. Login UI** (`LoginScreenTest` run on the device against the previous, pre-branding `LoginScreen.kt`): 7 of 8 failed.
- Most failures are because the old screen has no «Логин» label or lockup. The fallback-subtitle test passed only because the old screen hard-coded «Корпоративный мессенджер».
- Honest note: this RED is weaker than the unit REDs, because the behaviours were already TDD'd at ViewModel level.
- Two of my own test mistakes were fixed on the way:
  - Compose semantics expose the raw password text even when it is masked.
  - `KeyboardType.Password` keeps the `Password` flag even when the password is revealed.
  - The test now asserts the laid-out text instead.
- GREEN: 14 of 14 on the device.

**5. Debug-only trust:** `DebugOnlyTrustTest` was written as guard tests. It passed on its first run, so there is no RED.

## Command outputs (final, from clean)

1. `./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache clean testDebugUnitTest lint assembleDebug assembleRelease assembleDebugAndroidTest`
   - **BUILD SUCCESSFUL in 2m 43s.**
   - Unit tests: **36 suites, 148 tests, 0 failures** (109 before this task).
   - Lint: **0 errors, 62 warnings** (67 before; the remaining ones are pre-existing kinds such as unused strings, OldTargetApi and GradleDependency).
   - R8 release build OK.
2. `verify-release-configuration.ps1` → `Release configuration check passed: minification is enabled.`
3. Release APK checks:
   - `aapt2 dump xmltree AndroidManifest.xml` shows no `networkSecurityConfig`.
   - 0 `dev_ca` / NSC entries.
   - The dex contains `centychat-production.up.railway.app` and does not contain `10.0.2.2:8443`.
4. `ANDROID_SERIAL=emulator-5554 ./gradlew.bat … connectedDebugAndroidTest` → **BUILD SUCCESSFUL, 14 tests, 0 failures**:
   - `LoginScreenTest` 8
   - `OnboardingTest` 1
   - `EntryScopedViewModelTest` 4
   - `MainNavigationTest` 1
   - Instrumented tests are hermetic: `TestSessionModule` fixes an unreachable `https://127.0.0.1:9`, `TestLoginModule` uses in-memory login preferences, and `LoginScreenTest` scripts `AuthRepository`. Tests never touch production.
5. Debug APK for the stand: `assembleDebug -Pcentychat.serverUrl=https://10.0.2.2:8443` → BUILD SUCCESSFUL. `aapt2` shows `trust-anchors` (system + `@raw/centychat_dev_ca`) and `res/raw/centychat_dev_ca.pem` in the debug APK.
6. Live run against the stand (`SERVER_PORT=2014 node mobile/dev/stand.mjs`; 2004 belongs to the owner's server, which was never touched). The stand log shows:

   ```
   GET /api/settings/info, POST /api/auth/knock
   POST /api/auth/login (wrong password → generic error)
   POST /api/auth/login, POST /api/auth/device/claim
   GET /api/conversations/direct, GET /api/channels
   [WS] User connected: Алиса Тестова (#2)
   ```

   So the login went over HTTPS and the socket over WSS, both through the dev CA. The stand was stopped afterwards.

## Screenshots (emulator evidence, Pixel_8 API 37, `mobile/android/build-evidence/`, git-ignored)

- `12-login-light.png`:
  - The gradient C mark (72dp) and the «**Centy**Chat» wordmark.
  - The company name from the stand (`АО "Страховая компания "Сентрас Иншуранс"`).
  - One white card with a hairline, holding the «Логин» and «Пароль» fields (eye toggle) and a disabled full-width «Войти».
  - No app bar or duplicate title; content sits in the upper third.
- `12-login-dark.png`: the same in dark — graphite canvas `#24242a`, card `#2b2b32`, the mark unchanged, the wordmark light.
- `12-login-fontscale2.png`: font_scale 2.0. The company name wraps to two lines and the fields and button grow; nothing is clipped and «Войти» stays reachable.
- `12-login-error-light.png`: after a real wrong-password attempt — the danger-soft error box «Неверный логин или пароль» above the fields, the login kept, the password masked, «Войти» enabled.
- `12-inbox-alice-devstand.png`: signed in as alice against the dev stand.
  - The Conversations inbox shows «Боб Тестов» with the seeded message and unread badge 1.
  - The tabs show «Личные 1» / «Каналы 3»; the bottom bar shows Сообщения / Объявления / Профиль.
  - There is no "Подключение…" hint (the socket is connected).

The emulator was restored afterwards to `font_scale 1.0` and night mode off (its original values).

## Files changed

**New**
- `core/config/ServerConfig.kt`
- `core/network/WsEventParser.kt`
- `di/AuthModule.kt`, `di/LoginModule.kt`
- `features/auth/LoginPreferences.kt`, `features/auth/LoginText.kt`
- `ui/theme/Tokens.kt`
- `res/drawable/ic_brand_mark.xml`

**Modified**
- `app/build.gradle.kts`: `SERVER_URL`, dev-CA task, fixtures test input, logging dependency removed
- `gradle/libs.versions.toml`
- `README.md`
- `src/debug/res/xml/debug_network_security_config.xml`
- `AppViewModel`, `MainActivity`
- `core/network/{ApiClient, ApiException, WebSocketClient}`
- `core/session/SessionManager`
- `data/model/{AuthModels, Message, ServerInfo}`
- `data/repository/{AuthRepository, SessionRepository}`
- `di/RepositoryModule`
- `features/auth/{LoginScreen, LoginViewModel}`
- `ui/navigation/{AppNavigationState, AppNavigator, CentyNavigation, NavKey, SessionRouteGuard}`
- `ui/theme/Theme.kt`
- `res/values/strings.xml`

**Deleted**
- `features/connect/{ServerConnectScreen, ServerConnectViewModel}.kt`
- `test/.../features/connect/ServerConnectViewModelStorageTest.kt`

**Tests: new**
- Unit: `contract/ContractFixturesTest`, `core/config/ServerConfigTest`, `core/session/SessionManagerServerBindingTest`, `core/network/ApiClientLoginErrorTest`, `features/auth/{LoginViewModelTest, LoginViewModelKnockTest, LoginTextTest}`, `build/{CredentialHygieneTest, DebugOnlyTrustTest}`, `testing/TestSessions`
- Instrumented: `LoginScreenTest`, `TestLoginModule`

**Tests: updated**
- Constructor and API changes only: ApiClient*, WebSocketClient*, RealtimeConnectionManager, SessionManagerStorage, LoginViewModelStorage, ProfileViewModelLogoutStorage, AppNavigator, SessionRouteGuard, `Fakes`, `TestSessionModule`, `MainNavigationTest`, `EntryScopedViewModelTest`.
- `OnboardingTest` was rewritten: first launch → Login.
- `SessionManagerPersistentInvalidationTest`: the onboarding-recovery test now recovers through a fresh login, and the server-switch test was removed (replaced by the binding tests).

## Concerns

1. **Passwordless re-entry was already non-functional on Android.**
   - The client has always sent `knock` with `device_secret = null` (see the old `connect()`). The server only answers `paired` to a matching secret, so a knock never signs anyone in; it only registers or refreshes the device.
   - I kept this behaviour ("untouched"). It now runs once per login screen instead of once per server setup.
   - Each knock that does not return `paired` counts toward the server's per-IP `knock-fail` limit (60 per minute). That is fine for one device, but worth knowing for an office behind NAT.
   - Sending the stored secret would also require the logout path to clear or unbind it, which it doesn't today. That is a separate decision.
2. **Theme gap left for Task 9.** The dark `colorScheme.primary` is still `#A9A2FF` with dark text, not the brief's `#6457ee` with white text. The login uses the Material primary, so the dark «Войти» button (enabled) will change when Task 9 aligns the theme. Brand tokens for card, border and danger were added in `ui/theme/Tokens.kt`.
3. **The debug-CA overlay relies on AGP generated-resource precedence** over `src/debug/res`. This was verified by building and dumping the APK; AGP 9.4.1 reports no duplicate-resource error. If a future AGP rejects duplicates, the fallback is to generate the XML in both cases.
4. **CI never exercises the stand path.** Without `mobile/dev/certs/dev-ca.crt` nothing is generated. The overlay was verified locally only.
5. **The cleartext-HTTP allowance for local hosts stays in the debug network config** (pre-existing). It is harmless, because bearer tokens are never sent over HTTP, but it could be dropped now that the stand is HTTPS.
6. **`company_name` from production** was not exercised in this task: the debug build used for screenshots pointed at the stand, deliberately, to avoid a debug `knock` registering a device on production.
7. **Not checked visually:** the throttling countdown. It is covered by unit tests and on-device UI tests, but no screenshot was taken.
8. **Side effects on this machine, outside git:**
   - `server/node_modules` installed in the m-android worktree.
   - `mobile/dev/certs` and `mobile/dev/data` created by the stand (all git-ignored).
   - The stand made 1 failed and 1 successful `alice` login against its own throwaway data. Nothing touched `:2004` or `chat/server/data`.
