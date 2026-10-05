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
