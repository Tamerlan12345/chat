# Task 3 report — Android: self-registration, pending state, account deletion, report and block

Worktree `m-android`, branch `mobile/android` (not pushed). Only `mobile/android/**` changed.
56 files, +4614 / −36 across 7 commits on top of `2dd1853`.

## Commits

| SHA | Subject |
|---|---|
| 7dd8d66 | feat(android): account API, repository and failure mapping |
| c4a3ee1 | feat(android): self-registration, pending/rejected screens, account deletion |
| 95f9cdf | feat(android): report and block from the person card and chats |
| 22e1d9e | test(android): registration flow UI tests and a debug-only preview |
| c2b7185 | fix(android): keep two-line report reasons apart at large font sizes |
| 105c9f2 | fix(android): stack the chat block banner so it reads at large font sizes |
| 4f35076 | fix(android): keep snackbars above the chat block banner |

## What was implemented

**Data and network** (contract `mobile/contracts/registration.md` §1, §3, §4)
- `data/model/AccountModels.kt`: request/response models; `RegistrationOutcome` (`SignedIn(user)` / `Pending`); `AccountStateCode`; `BlockedUser.from()` tolerant parser (same key set as iOS).
- `ApiClient`: `requestRegistration`, `verifyRegistration` (200 stores the session exactly as `/auth/login` does; 202 → `Pending`), `deleteAccount` (`DELETE /users/me` with the password in the body), `report`, `blockUser`, `unblockUser`, `blockedUsers` (`{ blocks: [...] }` or a bare array). `ApiException` now carries `attemptsLeft` (`400 CODE_INVALID`).
- `data/repository/AccountRepository.kt` + `di/AccountModule.kt` (own Hilt module so UI tests can replace it):
  - shared `blocked: StateFlow<List<BlockedUser>>`, emptied when the session token goes away;
  - `verifyRegistration` remembers the login name on a sign-in;
  - `deleteAccount`: server first; on success wipes the Keystore-backed session (`clearSession`), the device secret and the remembered login. The people cache, chat history cache and recents already wipe themselves when the token becomes null, so they go too. A failed local wipe throws `SecureStorageUnavailableException`. A server failure leaves everything as it was.
  - `UnavailableAccountRepository` (like iOS) is the default for ViewModels in tests of other features.
- `WsEvent.GenericError` now carries the server's `code` (`DM_NOT_ALLOWED`, …).

**Error mapping** — `features/account/AccountFailure.kt`. A pure function `AccountFailure.from(error, context, nowMillis)` covers the same cases and contexts as iOS `AccountFailure` (offline, mail not configured, throttled with `Retry-After` or a 60 s default, invalid input, conflict USERNAME/EMAIL/other, wrong code + attemptsLeft, code expired, mail send failed, wrong password, last admin, unavailable). It adds `StorageUnavailable` for Android Keystore failures. The server's text is kept only for validation, other 409s and a wrong code, and is collapsed to one line of at most 200 characters. The Russian copy is in `AccountFailureText.kt` (`stringResource`). A 503 without a code, or with `EMAIL_NOT_CONFIGURED`, shows **«Отправка почты не настроена. Регистрация временно недоступна — обратитесь к администратору.»**

**Registration** (`features/auth`)
- `RegistrationValidation`: same rules as iOS `RegistrationValidation` (in iOS `Features/Auth/AccountFailure.swift`; `Core/Utils/ValidationRules.swift` only holds message edit windows). Rules: e-mail trimmed/lowercased, one `@`, dotted domain, ≤254; full name collapsed to 2–100 characters; login lowercased to 3–64 characters from `[a-z0-9._-]`; password ≥8 characters and ≤1024 UTF-8 bytes; code limited to 6 ASCII digits.
- `RegistrationViewModel` / `RegistrationState`: form → code → pending, or signed in. Field hints appear only after the first attempt. One request at a time. A rate limit blocks the form until its deadline. The code is checked against `expiresInSec` locally. Resend waits 60 s, and after a `429` it waits as long as the server's `Retry-After`. A wrong or expired code is cleared. The password and code are cleared when the flow ends. «Изменить данные» returns to the form.
- `RegistrationScreen` (Material 3, `imePadding`, autofill content types, a 48 dp text button for resend), `AccountStatusScreen` (`SUBMITTED` / `PENDING` / `REJECTED`; the title is «Заявка на рассмотрении» or «Заявка отклонена»).
- Login: «Зарегистрироваться» is a **text button under the card**, so it does not compete with the primary «Войти». It is disabled while signing in. `403 ACCOUNT_PENDING` / `ACCOUNT_REJECTED` open the matching screen once (`LoginViewModel.onAccountStateShown()`); any other 403 still reads «Неверный логин или пароль».
- Navigation: `NavKey.Register` and `NavKey.AccountStatus(rejected)` are part of the sign-in flow. A verify that signs in leaves the flow completely, with no way back into registration. `NavKey.BlockedUsers` and `NavKey.DeleteAccount` are protected routes in `SessionRouteGuard`. No server-selection UI was added.

**Profile**
- A new «Конфиденциальность» section with «Заблокированные пользователи», which opens a list with avatar, name and «Разблокировать» per person, an empty state, and a retry notice when loading fails.
- «Удалить аккаунт» (danger row plus the note «Удаление аккаунта необратимо.») opens a screen with the irreversible warning and a password field, then «Удалить аккаунт навсегда?». On success it signs out to Login; a wrong password shows «Неверный пароль.».
- The warning text follows the contract: personal data is deleted and sent messages stay as «Удалённый сотрудник». This replaces iOS's inaccurate «переписка … будут удалены».

**Report and block**
- `ReportController` (reason codes `spam|abuse|inappropriate|threat|other`, as on iOS; details trimmed and capped at 1000 characters; one request at a time; retry after a failure) and `ReportSheet` (`ModalBottomSheet`, radio group, sent state).
- `BlockController` serves the person card and the direct chat and follows the app-wide block list. `SafetyNotices` shows the outcome in a snackbar; `BlockConfirmDialog` asks before blocking.
- Person card: under the info group, «Пожаловаться» and «Заблокировать» / «Разблокировать». Neither appears on one's own card.
- Chat:
  - Someone else's delivered message has «Пожаловаться» last in the long-press menu.
  - A direct chat with someone else has a «⋮» menu with «Пожаловаться» and «Заблокировать» / «Разблокировать».
  - `ComposerLock`: if I blocked the peer → «Вы заблокировали этого пользователя. Сообщения не доставляются.» plus «Разблокировать». If the server refuses a send with `DM_NOT_ALLOWED` → «Сообщение не может быть доставлено. Писать в эту переписку нельзя.» In both cases the composer is disabled (placeholder «Отправка недоступна») and the ViewModel drops new sends.
  - Blocking or unblocking reloads the history, because the server now hides or shows that person's messages.
- A debug-only `RegistrationPreviewActivity` shows the code and pending steps for screenshots (the dev stand has no SMTP). It sends nothing.

## Tests and results

New unit tests:
- `AccountFailureTest` (17)
- `RegistrationValidationTest` (6)
- `RegistrationViewModelTest` (13)
- `ApiClientAccountTest` (6)
- `AccountRepositoryTest` (5)
- `ReportControllerTest` (4)
- `BlockControllerTest` (4)
- `AccountSafetyViewModelsTest` (6)
- `ChatViewModelSafetyTest` (7)
- `WsEventParserErrorTest` (2)

Additions to existing tests:
- `LoginViewModelTest` +2
- `PersonCardTest` +3
- `MessageMenuPolicyTest` +1
- `AppNavigatorTest` +3

New Compose UI tests:
- `RegistrationFlowTest` (6), against a scripted `AccountRepository` / `AuthRepository`, starting from `MainActivity`:
  - form → code → «Заявка на рассмотрении» → back to login;
  - invalid form;
  - 503 mail;
  - wrong code with attempts left;
  - a registration that signs straight in;
  - a rejected login.
- `ChatSafetyUiTest` (4): the DM_NOT_ALLOWED banner and disabled composer; unblock from the banner; block asks first; reporting the person and a message.

**Final verification** (Windows, from `mobile/android`):
```
JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache --max-workers=2 -Dorg.gradle.jvmargs=-Xmx2g testDebugUnitTest lint assembleDebug
BUILD SUCCESSFUL in 2m 7s
unit tests: 450 run, 0 failures, 0 errors, 0 skipped
lint: 0 errors, 40 warnings, 1 hint (none in the touched code; the 2 strings.xml warnings are pre-existing unused strings)
```
**Instrumented** on `emulator-5554` (Pixel_8):
- `connectedDebugAndroidTest` (whole suite, before the two banner fixes): 60 tests, 0 failures. That includes `RegistrationFlowTest` 6/6, `LoginScreenTest` 9/9 and `MainNavigationTest` 2/2.
- After the banner fixes, the `com.openmychat.mobile.chat` package: 25 tests (`ChatContentTest` 12, `ChatUiV2Test` 9, `ChatSafetyUiTest` 4), 0 failures.

## TDD evidence

- **RED**, logic layer: the tests were written first, then this was run:
  ```
  gradlew.bat … compileDebugUnitTestKotlin
  ```
  Log: `/c/tmp/m-android-t3-red1.log`. `BUILD FAILED`, 283 compile errors, all unresolved references to the missing production API:
  ```
  25 core/network/ApiClientAccountTest.kt   (Unresolved reference 'requestRegistration' / 'attemptsLeft' …)
  11 data/repository/AccountRepositoryTest.kt (Unresolved reference 'DefaultAccountRepository')
  79 features/account/AccountFailureTest.kt
   6 features/auth/LoginViewModelTest.kt   (LoginError.AccountPending / onAccountStateShown)
  55 features/auth/RegistrationValidationTest.kt
  75 features/auth/RegistrationViewModelTest.kt
  32 testing/Fakes.kt
  ```
  The block/report, chat and navigation tests were added the same way, before their production code; they too failed first by not compiling.
- **First GREEN attempt**, focused run of the 14 new or changed classes: 119 tests, 1 failure, `AccountRepositoryTest > signingOutForgetsTheBlockList` (expected `[]`, was `[BlockedUser(8, Ева)]`). Cause: the test ran on `UnconfinedTestDispatcher`, the request resumed on `Dispatchers.IO`, and the collector never got to run. The test now uses the standard test dispatcher and `runCurrent()`; the production code was unchanged. The rerun passed (`AccountRepositoryTest` 5/5).
- **Behaviour RED/GREEN in UI tests**: `ChatSafetyUiTest.theMenuReportsThePersonAndALongPressReportsAMessage` first failed with `expected [report peer, report message 10] but was [report peer]`. The menu hands the action over after its exit animation, so the test now waits for it; then 4/4 passed.
- **GREEN**: the final full command above, 450/450.

## Screenshots

Folder: `C:/Users/user/Documents/Нет в репо/chat/.claude/worktrees/mobile-release-parity/.superpowers/sdd/2026-10-05-continuation/`. Each exists as `-light`, `-dark` and `-font2` (font scale 2.0).

| Screenshot | What it shows | How it was made |
|---|---|---|
| `task-3-register-form-*.png` | the registration form | real app, against the dev stand |
| `task-3-register-mail-not-configured-*.png` | the real 503 «Отправка почты не настроена» | real app, against the dev stand |
| `task-3-register-code-*.png` | code entry | debug-only `RegistrationPreviewActivity`; the dev stand has no SMTP, and nothing is sent anywhere |
| `task-3-register-pending-*.png` | «Заявка на рассмотрении» | debug-only `RegistrationPreviewActivity` |
| `task-3-delete-account-*.png`, `task-3-delete-confirm-*.png`, `task-3-delete-wrong-password-*.png` | delete screen, confirmation dialog, and the server's 403 shown as «Неверный пароль.» | logged in as `alice` on the dev stand; nothing was deleted |
| `task-3-report-sheet-*.png` | report sheet from Bob's card | dev stand |
| `task-3-chat-block-confirm-*.png`, `task-3-chat-blocked-banner-*.png` | block confirmation and the banner with the disabled composer | dev stand; Bob was unblocked again after each run |
| `task-3-login-light.png`, `task-3-login-font2.png` | login with «Зарегистрироваться» under the card | dev stand |

The dev stand ran with `SERVER_PORT=2014`, so the owner's port 2004 was never touched; HTTPS was on 8443. I left it and the `Pixel_8` emulator running so other lanes can reuse them. `server/node_modules` in this worktree was missing `sharp`, so I ran `npm ci` (no tracked files changed). No traffic went to production.

## Self-review findings (fixed)

- At font 2.0 the chat lock banner squeezed its text into a narrow column; it is now text above an end-aligned «Разблокировать» (105c9f2).
- The «Пользователь заблокирован» snackbar covered the banner; the banner now sits inside the composer's measured area, so snackbars float above it (4f35076).
- At font 2.0 two-line report reasons touched each other; the rows now have vertical padding (c2b7185).
- The unblock-failure dialog had an empty dismiss button; it is now a snackbar.
- A stray unused string (`report_attachment`) was removed.

## Concerns / notes

1. **`503 BUSY`**: the server answers `/register/request` with `503 {code:"BUSY"}` when the password hasher is busy. iOS only treats `PASSWORD_HASH_BUSY` / `LOGIN_BUSY` as a short wait, so it would show «почта не настроена» there. Android also treats `BUSY` as a 5 s wait. The iOS lane may want the same fix.
2. **Blocked chat in the list**: after a block, the direct chat stays in the conversations list until the next refresh, which the server filters. The open chat reloads at once. The contract's «убрать переписку из списка» is a recommendation; I did not add a local filter (YAGNI), but it is easy to add in `ConversationsViewModel` from `AccountRepository.blocked`.
3. **«Вложение» literal**: the report subject for a message without text uses this Russian literal in `ChatViewModel`. That follows the existing practice of Russian literals in ViewModels («Собеседник», etc.).
4. **Large files**: `ChatScreen.kt` (~420 lines), `ChatViewModel.kt` (~570) and `PersonCardScreen.kt` (~600) were already large, and this task added to them; consider splitting them later.
5. **Deprecation**: the new UI tests use `createEmptyComposeRule` / `createComposeRule`, which are deprecated in favour of the v2 API — the same as every existing UI test in the module.

---

## Fix round 1 (review findings 1 and 2)

### Commits
| SHA | Subject |
|---|---|
| 45454d7 | fix(android): load the block list with every session |
| 5557e81 | fix(android): drop a blocked person's chat from the conversation list |

### Changes
1. **Block list loaded at sign-in and startup.** `DefaultAccountRepository.init` now watches the session's presence (`tokenFlow.map { it != null }.distinctUntilChanged()`). When a session starts — an open session at app start, a sign-in, or a registration that signs straight in — it calls `refreshBlocked()` (`GET /api/blocks`) in the application scope. A token refresh is the same session, so it does not trigger another request. Sign-out cancels a running load and empties the list. A failed load is ignored: the list stays empty, the profile screen retries, and sends still meet `DM_NOT_ALLOWED`. Cancellation is rethrown. This matches iOS `loadAllData → account.loadBlocks()`. The person card, the chat's «⋮» menu and `ComposerLock` already follow `AccountRepository.blocked`, so a block made earlier or on another device now shows «Разблокировать» and closes the composer without a failed send. `internal var sessionLoad: Job?` lets tests wait for the load.
2. **Blocked direct chats leave the list.** `ConversationsViewModel` takes `AccountRepository`, defaulting to `UnavailableAccountRepository` for older tests.
   - Every load drops direct chats whose peer is in the block list.
   - When the set of blocked ids changes, it removes those chats at once and reloads the list (`loadData(showLoading = false)`), as iOS `onBlocksChanged` does. An unblock therefore brings the chat back.

### Tests
- `AccountRepositoryTest` (+2, now 7):
  - `aSessionLoadsTheBlockListAtStartAndAfterEverySignIn`: start with an open session → the list from the server; a token refresh sends no second request; sign-out empties the list; a new sign-in loads it again.
  - `aBlockListThatCannotLoadLeavesTheListEmptyAndTheSessionAlone`.
  - The `repository()` helper now waits for the startup load and clears `paths`. `aRefusedDeletionLeavesTheSessionAlone` queues its 403 after constructing the repository, so the startup request does not consume it; the assertions are unchanged.
- `ConversationsViewModelBlocksTest` (new, 3): blocking removes the chat at once and reloads the list; a block known at start never shows the chat; unblocking brings the chat back.
- `ChatViewModelSafetyTest` (+1, now 8): `aBlockMadeElsewhereClosesTheComposerOnceTheSessionsListArrives`.
- `ChatSafetyUiTest` (+1, now 5, device): `aBlockFromTheServersListClosesAnOpenChat`. It uses a real `ChatViewModel` + `ChatScreen`, and the scripted account's block list starts empty. A test sets the block list to [Bob], standing in for the session load returning a block made on another device. The test then checks the banner, the disabled composer, and «Разблокировать» in «⋮». Small device doubles live in `androidTest/.../chat/ChatTestDoubles.kt`.

### TDD evidence
- RED (compile): `gradlew.bat … testDebugUnitTest --tests '*AccountRepositoryTest' --tests '*ConversationsViewModelBlocksTest' --tests '*ChatViewModelSafetyTest'` → `Unresolved reference 'sessionLoad'` ×4, `No parameter with name 'account' found` — BUILD FAILED (`/c/tmp/m-android-t3-fix1-red.log`).
- RED (behaviour, after adding only the `sessionLoad` field and the `account` parameter): 18 tests, 3 failed (`/c/tmp/m-android-t3-fix1-red2.log`):
  - `aSessionLoadsTheBlockListAtStartAndAfterEverySignIn`: expected `[BlockedUser(id=7, name=Боб)]` but was `[]`
  - `blockingRemovesTheChatAtOnceAndReloadsTheList`: expected `[7]` but was `[7, 8]`
  - `aBlockKnownAtStartNeverShowsTheChat`: expected `[7]` but was `[7, 8]`
- GREEN, same filter plus all `ConversationsViewModel*`: `AccountRepositoryTest` 7/7, `ConversationsViewModelBlocksTest` 3/3, the other conversations suites 18/18, `ChatViewModelSafetyTest` 8/8 (`/c/tmp/m-android-t3-fix1-green.log`).
- Device: `connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openmychat.mobile.chat.ChatSafetyUiTest` → 5/5, BUILD SUCCESSFUL.

### Full command
```
JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache --max-workers=2 -Dorg.gradle.jvmargs=-Xmx2g testDebugUnitTest lint assembleDebug
BUILD SUCCESSFUL in 1m 33s
unit tests: 456 run, 0 failures, 0 errors, 0 skipped
lint: 0 errors, 40 warnings, 1 hint (unchanged; none in touched code)
```
Whole instrumented suite, run as an extra check: 65 tests, 64 passed. One failure: `ChatContentTest.theConnectionBannerShowsOnlyWhileTheLinkIsDown` hit its 5 s `waitUntil` while the emulator was heavily loaded (the run took 11m52s instead of ~3m). This test and `ChatContent` are not touched by these fixes. Re-run alone it passed, and so did the rest of `ChatContentTest` (12/12). It looks like a timing-sensitive existing test, not a regression.
