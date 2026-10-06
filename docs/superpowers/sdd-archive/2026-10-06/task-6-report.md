# Task 6 report — Android anti-"AI-generated" polish pass + carried-over minors

Lane `m-android`, branch `mobile/android`, base `b851c65`. Not pushed. Tree clean at `30eb7cb`.

## 0. Controller priority: CI `android-emulator-tests` red on b851c65

Ran the full `connectedDebugAndroidTest` on `Pixel_8` from a clean temporary worktree at `b851c65`
(removed afterwards): **82 tests, 1 failure**.

| Failing test | Cause | Fix |
|---|---|---|
| `MainNavigationTest.tabsBackAndLogout` (waitUntil «Войти» timed out after «Выйти») | **Latent app bug.** `DeliveryModule.outgoing()` handed out the `DeliveryRuntime` as `OutgoingQueue` without starting it. In the app `CentyChatApp.onCreate` starts it, but under the instrumented tests' `HiltTestApplication` nothing had asked for the engine, so `discardForSignOut()` → `engine.reset()` waited forever on a command loop that never ran: sign-out never finished. | `f34a9df fix(android): sign-out never waits on a delivery core nobody started` — the provider returns `runtime.also { it.start() }` (like the engine and file-queue providers). Unit test `DeliveryModuleTest` RED → GREEN (`task-6-ci-red.log`). Re-ran the full suite on the device with the fix: **82/82 green** (`task-6-ci-fix-connected.xml`; baseline log `task-6-ci-baseline-connected.log`). |

Note: `f34a9df` also carries a pure file rename `PriorityBadge.kt → PriorityMarker.kt` (R100, identical content) that was staged by `git mv` at the time; it builds and changes nothing, the content change is in `30eb7cb`.

## 1. Commits (b851c65..30eb7cb)

| SHA | Message |
|---|---|
| f34a9df | fix(android): sign-out never waits on a delivery core nobody started |
| 90eede6 | fix(android): typing frames at most every 3 s; a refused chat reopens |
| 1bfd268 | fix(android): server waits count down and hold the action; cancellation is not a failure |
| ca16afb | fix(android): the bottom bar comes back with the inbox; one slide, no state write in layout |
| 22e4acb | feat(android): ask for notifications after sign-in, with one sentence on why (QA D8) |
| 0771600 | refactor(android): the chat's composer lock and DM_NOT_ALLOWED tracking in their own file |
| 5644bbd | style(android): polish pass - filled fields, quiet day pills, empty states in the upper third |
| 73dae1d | style(android): chat - one contour per group, baseline time, filled composer; no invitation in a closed chat |
| c00df22 | style(android): inbox, people and search - three type steps, inset hairlines, badge rules |
| 30eb7cb | style(android): announcements and profile as native grouped lists; notices without outlines; copy names its object |

## 2. Carried-over minors (each: fix + test)

| Minor | Fix | Test |
|---|---|---|
| Blocked/refused empty DM shows «Напишите первое сообщение» above «Отправка недоступна» | `ChatEmptyState(lock)`: open chat keeps the illustration + invitation; a locked chat shows only a quiet «Сообщений нет» (tag `chat-empty-locked`) | `ChatSafetyUiTest` +3 Compose cases (not yet run on device after the change — see Stopped) |
| `NOT_DELIVERABLE` never clears | `RefusedDelivery` (ComposerLock.kt): a successful history load, a newer message from the peer, or my unblock mark the current refusals as reopened; a new refusal closes again | `ChatViewModelSafetyTest` +4 (reload reopens, peer message reopens, new refusal re-closes, own echo does not reopen) — RED→GREEN |
| Frozen throttle countdowns (DeleteAccount, ReportSheet, SafetyNotices) | `rememberClock()` ticks every second; `DeleteAccountState.canDeleteAt`, `ReportSheetState.canSendAt`, `BlockController.retryAt` hold the action until the 429 deadline, then re-enable; the block snackbar text is read on draw (`TickingSnackbar`) so it counts down; editing the password keeps the wait | `DeleteAccountUnsentTest.aRateLimitHolds…`, `ReportControllerTest.theSheetKnows…` + adjusted `aFailureStaysOnTheSheetAndCanBeRetried` (now waits out the 429 before the retry), `BlockControllerTest.theServersWaitHolds…` — RED→GREEN |
| `RegistrationViewModel.verify()` ignores 429 wait | `canVerifyAt(now)` (code complete and no running wait) used by the VM and the screen | `RegistrationViewModelTest.aRateLimitedCodeCheckWaitsForItsDeadline` — RED→GREEN |
| `catch (e: Exception)` swallows `CancellationException` | rethrown in BlockController, ReportController, RegistrationViewModel (×2), DeleteAccountViewModel, BlockedUsersViewModel (×2); busy flags reset in `finally`/the cancel branch | 5 tests (`aCancelled…`) — RED→GREEN |
| Missing tests: failed local wipe; caches wiped on deletion | tests only (behaviour was already right) | `AccountRepositoryTest.aLocalWipeThatFails…` (keystore refuses after the server deletion → `SecureStorageUnavailableException`, follow-up still ran), `DeleteAccountUnsentTest.aFailedLocalWipeSaysTheSecureStorageIsUnavailable` (`StorageUnavailable`), `AccountRepositoryTest.deletingTheAccountWipesTheCachedPeopleDirectory` (real SessionManager + DefaultPeopleRepository), `ChatHistoryCacheTest.deletingTheAccountClearsTheChatCache` (real delivery runtime: memory and disk) |
| Bar returns ~250–290 ms late | Root cause from the library bytecode: `NavigationSuiteScaffoldStateImpl.currentValue` is `Visible` only at exactly 1.0, and the scaffold's visible slide is `animateFloatAsState` keyed on `currentValue` — so `show()` ran a full invisible spring first, then the visible one. `rememberBottomBarState` uses `snapTo`, so the one slide starts with the navigation | `BottomBarStateTest` (androidTest): RED with show()/hide() (`expected Visible but was Hidden` after 48 ms, `task-6-red-barstate.log`), GREEN with snapTo |
| Bar slide drops frames on R8 | one spring per frame instead of two; the bar height is a plain holder written in measure (no snapshot write in layout) | debug-build gfxinfo, 6× inbox↔chat warm, emulator under load (noisy): p95 400→250 ms, p99 650→300 ms (`task-6-gfx-*-warm.txt`). **R8 build not re-measured** (needs a stand-pointed non-debug build; Task 17 did it with a ServerConfig patch I did not want to repeat) |
| Stale motion table | `CentyMotion` KDoc now holds the motion table as the code does it (own bubble without a flight fades + rises 8 dp like an incoming one; SEND also drives row placement; bar slide via `rememberBottomBarState`); `ChatBubbleRow` KDoc updated | — |
| ChatBubble blank lines; `barVisiblePx` in layout | removed; holder above | — |
| QA D8 | the system dialog no longer appears at launch; after sign-in (API 33+, not granted, not asked) a sheet «Уведомления о сообщениях / Разрешите уведомления, чтобы не пропускать новые сообщения, звонки и побудки…» with «Разрешить уведомления» / «Не сейчас», asked once per install | `NotificationPromptTest` (4); screenshots `task-6-before-notification-permission-light` (dialog over the login screen) vs `task-6-after-notification-explainer-light` + `…-notification-system-light` |
| Typing frames | `TypingSignal`: one frame at start, ≤1 per 3 s while typing, one stop frame after 5 s idle / emptied field / send; receiver holds «печатает» 6 s (desktop) | `TypingSignalTest` (4) + `ChatViewModelTypingTest` (2) — RED→GREEN |
| Large files | extracted `ComposerLockBanner.kt`, `ChatEmptyState.kt`, `ComposerLock.kt` (RefusedDelivery), `TypingSignal.kt`, `PersonSafetyGroup.kt`; ChatViewModel 651→~636 lines, PersonCardScreen 617→~568 | — |

TDD evidence: `task-6-red-logic.log` (20 failing against compile stubs), `task-6-green-logic.log`, `task-6-ci-red.log`, `task-6-red-barstate.log` / `task-6-green-barstate.log`. Presentation helpers `InboxBadges`, `AnnouncementSections`, `NotificationPrompt` got tests written alongside, not strictly first.

## 3. Per-screen changes (rule = design brief «Anti-"AI-generated" polish pass»)

- **All lists** — borderless rows, hairlines from the text edge (`InsetDivider`, `textEdgeAfter`) (rule 1); spacing on 4/8/12/16/24/32, off-rhythm 6/10/14/20 dp values moved (rule 2); section headers `titleSmall` accent, 24 above / 8 below (rules 2, 8).
- **Inbox** — search field filled `bg-sunken`, outline only while searching (1); row name titleMedium 600 / preview bodyMedium / time labelSmall text-dim; unread preview text-main 600 (3); segment counters = conversations with unread, none on the open segment (6); empty inbox action «Найти сотрудника» → «Сотрудники», tonal, block at 35 % (4, 5).
- **Search** — shared section header; message hit title titleMedium (3).
- **Chat** — one contour per group (shared edge painted over; steps where widths differ), group gap 8 (7, 2); time on the last line's baseline (7); composer filled field on L3, no outline; send = 40 dp primary circle (7, buttons); inline day pill quiet (`bg-sunken`, caption, text-dim, no border), sticky copy stays L3 (7); top bar presence text-dim / typing accent (already so); locked empty chat neutral (minor).
- **People / card** — inset hairlines; empty directory without «Обновить» (pull-to-refresh) (5); card sections 24 apart; card info groups stay outlined (they are cards on L3 — allowed by rule 1).
- **Announcements** — native grouped list in two titleSmall sections («Требуют ознакомления», «Ознакомлены»), title 600 until acknowledged, importance = 6 dp dot + label, no boxed/bordered badge (8).
- **Profile / Заблокированные** — Android sections with titleSmall headers and inset hairlines instead of outlined cards (8, 1); status dots on the title line; names titleMedium (3).
- **Delete account / login / call** — danger notices tone-only, no outline (1); delete and report count down and re-enable (minor).
- **Report / attachment sheets, registration** — gutter 16 (2).
- **Copy** (5) — «Не удалось обновить переписку», «…список сотрудников», «…список заблокированных», «Удаление аккаунта…»; unused «Обновить» removed.
- Form inputs (OutlinedTextField with floating label) keep their outline: the desktop's form inputs are outlined too, and a borderless floating-label field fails non-text contrast — judgement call, flagged for the design review.
- Brief conflict, judgement call: rule 2 «in-group gap 2» vs rule 7 «outline the group contour only» — a contour needs touching bubbles, so the group is joined (2 dp is the joined corner radius).

## 4. Tests and results (final state 30eb7cb)

- `testDebugUnitTest lint assembleDebug` (global command, `--max-workers=2`): **BUILD SUCCESSFUL**; unit **699 tests, 0 failures** (baseline 666); lint 0 errors, 40 warnings (`task-6-final-gradle.log`).
- `connectedDebugAndroidTest`: full suite **82/82 at b851c65 + f34a9df**; `BottomBarStateTest` green on the final tree. **The full androidTest suite was not re-run on the final tree** (ChatSafetyUiTest +3, ChatContentTest copy change, polish) — see Stopped.

## 5. Screenshots (`task-6-screens/`)

- BEFORE (baseline b851c65, dev stand on port 2014, seeded with 9 more people in 3 departments, DMs, an image, #общий, urgent/critical announcements, Никита blocked): light 33, dark 32, font 2.0 29 screens — login, register form/code/wrong code/pending, gallery empty states, inbox Личные/Каналы, search recents/results, chat direct, message menu, attach sheet, image viewer, chat ⋮ menu, call, channel chat, people Все/Отделы, person card (+actions, report sheet, block confirm, blocked person), blocked empty chat, announcements, profile (top/bottom/end), blocked users, delete account, sign-out confirmation; plus `task-6-before-notification-permission-light` (D8). Font 2.0 lacks blocked-users, block-confirm, report-sheet (tour could not reach them at that size).
- AFTER: only **9 light** shots kept (auth screens, gallery empty states, inbox, notification explainer + system dialog). A first complete after-light set was taken and reviewed (chat contour, announcements, profile, people, blocked users, menu) but deleted when the final run restarted; the final after runs (light/dark/font 2.0) were stopped by the controller.
- Paired names: `task-6-before-<screen>-<variant>.png` / `task-6-after-<screen>-<variant>.png`.

## 6. Self-review

- Contour seam: first device check showed a faint 1 px antialias row; the erase band is now whole pixels + 1 (in `73dae1d`); not re-verified on device after that change.
- `RefusedDelivery` reopens on *any* successful reload — exactly as asked; a still-blocked peer gets one refused send per reload cycle, which then re-locks.
- `TypingSignal` stop frame on send happens through the existing `onTyping(false)` call in `ChatScreen.onSubmit`.
- A transient «Переподключение…» stuck for ~3 min was seen once during the first after run; not reproducible (network toggle and a full re-run reconnected normally); no realtime code was changed. Watch for it.

## 7. Concerns

1. Full androidTest not re-run on the final tree; after screenshots incomplete (see Stopped).
2. R8 frame drops not re-measured on an R8 build.
3. `f34a9df` contains the unrelated (no-op) file rename.
4. Search field `bg-sunken` on the list plane is a light tone step (contrast 1.05–1.08 vs the plane); test threshold set to 1.05 — design review should judge.

## Stopped at 16:52

- **Done:** CI fix (82/82 on device), all carried-over minors with tests, D8, typing throttle, bar timing/holder, motion table, polish on every screen; all committed (10 commits, tree clean); unit 699/0, lint 0 errors, assembleDebug green; BEFORE screenshots light/dark/font 2.0.
- **Not done:** AFTER screenshots (only 9 light); full `connectedDebugAndroidTest` on the final tree; on-device re-check of the contour seam; R8 measurement; 3 missing BEFORE font-2.0 shots.
- **Next step:** start the stand (`SERVER_PORT=2014 node mobile/dev/stand.mjs`) and `Pixel_8`, install the final debug APK, run the tour (`tour.sh after light|dark|font2`, scripts in the session scratchpad) and the full `connectedDebugAndroidTest`, then the design finish-review.
- Emulator and dev stand stopped; no other processes left running by this task.

---

## Continuation 2026-10-06

Lane `m-android`, branch `mobile/android`, head **499c91b** (the controller pushed fb14f00; nothing pushed by me). Tree clean.

### C1. Commits since the stop (30eb7cb..499c91b)

| SHA | Message | Kind |
|---|---|---|
| 5c65e3d | fix(android): a finishing activity no longer cuts the realtime link of the one that replaced it | bug found during the screenshot pass (C3) |
| cabb161 | feat(android): the login screen shows the CentyChat lockup alone, without a company line | **owner request** (controller, 2026-10-06) |
| fb14f00 | style(android): a group of equally wide bubbles runs one straight side, no pinch at the join | polish, rule 7 |
| a0d0e2f | style(android): at a large system font the unblock button goes under the blocked person's name | polish, font 2.0 finding |
| 499c91b | ci(android): name each failing instrumented test in the emulator job's log | CI diagnosability (C5) |

All commits since b851c65: f34a9df, 90eede6, 1bfd268, ca16afb, 22e4acb, 0771600, 5644bbd, 73dae1d, c00df22, 30eb7cb, 5c65e3d, cabb161, fb14f00, a0d0e2f, 499c91b.

### C2. Per-screen changes in this continuation (design brief «Anti-"AI-generated" polish pass»)

- **Login — owner request.** The company caption under the brand (server `company_name`, e.g. «АО «Страховая компания «Сентрас Иншуранс»», fallback «Корпоративный мессенджер») is gone; only the CentyChat lockup remains, no replacement tagline (rule 5: chrome that says nothing about the object). Removed with it: `LoginViewModel.companyName` and its load, `AuthRepository.companyName()`, the `CompanyName` sanitiser, `login_company_fallback`. Kept: `typographicQuotes` (the profile's «Компания» line — user data, unchanged) and `ServerInfo.companyName` (wire model). Tests: `LoginScreenTest.theLockupAndCompanyNameAppearOnce…` and `withoutACompanyNameTheDefaultSubtitleIsShown` replaced by `theLockupStandsAloneWithoutACompanyLine` (RED on device: «АО «Тестовая компания»» found, `task-6-red-login-company.log`; GREEN 8/8, `task-6-green-login-company.log`). Removed as tests of deleted code: the `LoginViewModelTest` company-name pair and `LoginTextTest.companyNameIsPlainSingleLineTextOfBoundedLength`; the quotes test now calls `typographicQuotes` directly. `RegistrationFlowTest` / `RegistrationPreviewActivity` never referenced the company line (checked).
- **Chat — rule 7 «outline the group contour only».** The on-device contour check showed a pinch where two bubbles of a group meet even when both are equally wide (two wrapped messages), plus a notch on the sender side: the corner arcs at the join were kept. Those corners are now squared over the arc and the straight outline drawn in; where widths differ the contour still steps (e.g. `T5F4-airplane` over `T5F4-signout`). The contour modifier draws before the bubble's clip. Checked on light and dark crops; no seam. Pure drawing, no test.
- **Заблокированные at font 2.0 — rule 3 hierarchy and the brief's «AX/font-2 size» verification.** The first font-2.0 shot of this screen ever taken showed «Ники / та …» squeezed by the tonal «Разблокировать». From font scale 1.5 the button sits under the name. New `BlockedUsersLayoutTest`: RED «the name is cut off on lines [1]» (`task-6-red-blocked-font2.log`), GREEN (`task-6-green-blocked-font2.log`).
- Everything else as in §3 above, now confirmed on the AFTER screenshots (auth, inbox, search, chat, channel, people, card, sheets, announcements, profile, blocked users, delete account).

### C3. Bug found during verification — stuck «Переподключение…» (5c65e3d)

The stuck «Переподключение…» noted in §6 reproduced deterministically, also on the baseline build b851c65 (pre-existing). Root cause, from instrumented logs: Back at the root finishes `MainActivity`; reopening the app at once creates the new activity before the old one's `onDestroy`, whose `connectionManager.stop()` then closed the socket for good — the new activity's `start()` had been a no-op. Now `RealtimeConnectionManager.start(owner)/stop(owner)`: only the activity that started the link last may stop it (a token object, so the singleton never holds an activity). Unit RED→GREEN (`task-6-red-link-owner.log`, `task-6-green-link-owner.log`); on device, Back + immediate relaunch keeps the socket (no `[WS] disconnected` on the stand), Back alone still disconnects. This changes behaviour beyond the polish brief — flagged so the controller can keep or split it.

### C4. Screenshots — where the pairs are

Folder `.superpowers/sdd/2026-10-05-continuation/task-6-screens/`:
- BEFORE (b851c65, first session, canonical): `task-6-before-<screen>-<light|dark|font2>.png` — light 33, dark 32, font 2.0 29.
- AFTER (final UI a0d0e2f; same stand and seed; colleagues kept online as in the BEFORE run): `task-6-after-<screen>-<variant>.png` — **light 34, dark 34, font 2.0 34**. Screens: login, register-form, register-code, register-wrong-code, register-pending, gallery-empty-states, notification-explainer, notification-system, inbox-direct, inbox-channels, search-recents, search-results, chat-direct, message-menu, attach-sheet, image-viewer, chat-person-menu, call, chat-channel, people-all, people-departments, person-card, person-card-actions, report-sheet, block-confirm, person-card-blocked, chat-blocked-empty, announcements, profile, profile-bottom, blocked-users, profile-end, delete-account, signout-confirm.
- **Side-by-side pairs:** `task-6-screens/pairs/task-6-pair-<screen>-<variant>.png` (101 images, BEFORE left, AFTER right, labelled). `notification-permission-light` (BEFORE: system dialog over the login) pairs with AFTER explainer + system dialog. AFTER only (no BEFORE exists): font 2.0 report-sheet, block-confirm, blocked-users; dark and font 2.0 notification shots.
- Environment artefacts, not app UI: the emulator IME's floating «≡» on shots with a focused field (search-results, in both sets); the M3 drag-handle tooltip «Маркер перемещения» on the explainer sheet (pointer hover).

### C5. Tests and results (final tree)

- `testDebugUnitTest lint assembleDebug` (global command, `--max-workers=2`) at a0d0e2f: **BUILD SUCCESSFUL**; unit **698 tests, 0 failures** (699 + 2 link-owner − 3 removed company-name tests); lint **0 errors, 41 warnings** (40 before; none in files changed in this continuation) — `task-6-final2-gradle.log`. 499c91b only touches the CI shell script.
- `connectedDebugAndroidTest`, full suite:
  - Pixel_8 (API 37) at a0d0e2f: **86/86** (`task-6-final-connected.xml`) — includes ChatSafetyUiTest 8 (the 3 new locked-empty cases), ChatContentTest 12 (copy change), BottomBarStateTest, LoginScreenTest 8, BlockedUsersLayoutTest.
  - API 34 google_apis x86_64 (the CI job's image) at 499c91b: **86/86, three runs in a row** (`task-6-final-connected-api34-run1..3.xml`).
- **CI run 37425247301 (fb14f00) red in `connectedDebugAndroidTest`: not reproduced.** The log does not name the test and the report artifact cannot be downloaded from this network (blob store resets the connection). 30eb7cb was green on CI; locally the suite is green 4× on API 34/37 with the new commits. 499c91b makes the job print each failing test with its first stack lines. **Needs a CI re-run on the pushed head.**
- R8 bar slide re-measured: measurement-only `benchmark` build type via an init script (R8, not debuggable, debug-signed, dev stand; ServerConfig patched only for the build and restored — tree clean), same emulator, warm, 6× inbox↔chat, two alternating rounds:

| build | frames | janky | p50 | p90 | p95 | p99 |
|---|---|---|---|---|---|---|
| b851c65 r1 / r2 | 357 / 316 | 7.8 % / 9.2 % | 18 / 17 ms | 31 / 32 | 34 / 34 | 65 / 65 |
| a0d0e2f r1 / r2 | 267 / 265 | 11.6 % / 11.3 % | 18 / 17 ms | 32 / 32 | 34 / 34 | 65 / 81 |

  Files `task-6-gfx-r8-{base,head}-{1,2}.txt`. Reading: about 20 % fewer frames per cycle (one slide instead of two), the janky count unchanged (28–31), percentiles equal. **No measurable improvement of the R8 frame drops** — the double slide does not explain them; emulator numbers only.

### C6. Concerns

1. CI `android-emulator-tests` red on fb14f00, not reproduced locally (C5); re-run needed with 499c91b.
2. 5c65e3d is a functional fix outside the polish brief (pre-existing bug) — keep or split.
3. R8 frame drops not measurably improved (C5).
4. Three company-name tests deleted together with the code they tested (owner request); quote typography keeps its test.
5. Bubbles a few px apart in width (image bubble over a text bubble) still show a small rounded step at the join.
6. The first light AFTER pass hit a cold-start ANR dialog (first frame 32 s right after install under emulator load, nothing in app code); final shots taken after `cmd package compile -m speed`, with ANR detection in the tour.
7. Installed for the API 34 check, outside the repo: SDK `system-images/android-34/google_apis/x86_64` (≈1.5 GB) and AVD `Api34` — delete if unwanted.
8. `f34a9df` still carries the no-op rename `PriorityBadge.kt → PriorityMarker.kt` (not split, as allowed).
9. Emulators, dev stand and helper processes started in this continuation are stopped; the temporary R8 baseline worktree is removed.

---

## Fix round 1

FIX_BASE 499c91b → head **7bf6827**, pushed to `origin/mobile/android`.

| SHA | Message | Review item |
|---|---|---|
| c3ef4ad | test(android): wait for the delivered history before asserting it in the open-chat block test | IMPORTANT 1 |
| 783948e | ci(android): list failing tests from result files in per-device subfolders too | MINOR 2 |
| 37f7e0d | refactor(android): the realtime link's owner is required on start and stop | MINOR 3 |
| 7bf6827 | refactor(android): the chat's typing signal is declared with the other collaborators | MINOR 4 |

1. **CI-red test** (`ChatSafetyUiTest.aBlockFromTheServersListClosesAnOpenChat`, «'Купите слона' is not displayed», CI run 37430929130 on 499c91b, also red on fb14f00 = the RED). The history reaches the screen through `TestDelivery` → delivery engine → Room suspend DAOs, which Compose idling does not track; the assertion ran right after `setContent`. Now `compose.waitUntil(5_000) { …hasText("Купите слона")… }` first, then the unchanged `assertIsDisplayed()`. Audit of the other androidTests: no other test drives `TestDelivery`/Room behind a screen (`RoomDeliveryStoreTest` is `runBlocking` without UI; `EntryScopedViewModelTest` uses a probe ViewModel; Login/Registration tests already `waitUntil`; `MainNavigationTest` asserts only static chrome after launch). GREEN locally on the API 34 AVD: ChatSafetyUiTest 5 runs × 8/8 (`task-6-fix1-chatsafety-api34.log`), full suite 2 runs × **86/86** (`task-6-fix1-connected-api34-run1..2.xml`).
2. `run-ui-tests-recorded.sh`: the listing uses `find mobile/android/app/build/outputs/androidTest-results -name '*.xml'`, still only on failure, each parse `|| true`, the original exit status kept. Checked against a fake per-device subfolder with a failing case (prints `FAILED com.A.t1` + stack lines).
3. `RealtimeConnectionManager.start(owner: Any)` / `stop(owner: Any)` without defaults; `MainActivity` already passed its token; the unit tests use a `screen` token.
4. `ChatViewModel`: `typing` (TypingSignal) is declared next to `refusedDelivery`, before the `init` blocks and `onCleared`.

Not touched: delivery/outbox/owner logic, server lockfile.

**Results:** `testDebugUnitTest lint assembleDebug` BUILD SUCCESSFUL — unit 698/0, lint 0 errors / 41 warnings (`task-6-fix1-gradle.log`). **CI `mobile-android` run 37433478839 on 7bf6827: success** — android-verify success, **android-emulator-tests success**. (security-checks ignored as instructed — fixed on integration in badffdd.) The Api34 emulator used for the check is stopped.
