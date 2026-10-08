# Task 17 report: Android UI layer v2

**Status: DONE_WITH_CONCERNS.** Everything below is from worktree `m-android`, branch `mobile/android`, base `5ef7972`. Nothing was pushed, and only `mobile/android/**` was edited.

The concerns are listed at the end. The main ones:
- reply sending and the failed/queued states still wait on Task 15;
- the inbox → chat transition loses its first frames on the emulator;
- the `message_cancelled` fixture fix touched the data layer.

Final verification ran on HEAD `28f6406`, and everything is green:

| Check | Result |
|---|---|
| Unit tests | 206 tests in 50 suites, 0 failures |
| `lint` | 0 errors |
| `assembleDebug` | Built |
| `assembleRelease` | Built |
| `connectedDebugAndroidTest` on `emulator-5554` | 43 tests, 0 failures |

## Commits

| SHA | Message |
|---|---|
| 2053994 | feat(android): UI layer v2 component library |
| 8724133 | feat(android): grouped bubbles and the chat split into bubble, list, composer, top bar and pills |
| e0ab15c | feat(android): keyboard glued to the composer with interactive dismiss |
| e4a983a | feat(android): shared-element inbox to chat, lift-on-scroll bars, illustrated empty states |
| 5a5ea0a | feat(android): live call level meter from the peer's audio RMS |
| 475bb7a | fix(android): follow the recaptured Task 16 contract fixtures |
| 7142de1 | feat(android): debug-only component gallery as a test harness |
| 220f57a | perf(android): share delivery-glyph geometry and drop per-frame row callbacks |
| b77d8d6 | perf(android): resolve bubble-row strings once per list |
| 3186165 | fix(android): «Ответ · Вы» when answering an own message; shorter gallery chips |
| 28f6406 | chore(android): ignore the Kotlin compiler's .kotlin cache |

The diff since `5ef7972` is 54 files, about 4.8k lines added and 1.0k removed.

The full command set was run on the final state only. Intermediate commits do not each compile on their own. For example, the component commit adds `DeliveryMark.SENDING`, and the old `ChatScreen` it leaves behind has a `when` over that enum that is no longer exhaustive.

## Chat split (controller note)

`ChatScreen.kt` (911 lines) is now seven files:

| File | Lines | Holds |
|---|---|---|
| `ChatScreen.kt` | 273 | `ChatActions`, the stateful wrapper, and the `ChatContent` scaffold |
| `ChatTopBar.kt` | 144 | Lift-on-scroll header with shared avatar and name |
| `ChatList.kt` | 207 | Reverse layout, IME nested scroll, follow/anchor rule, sticky date, jump pill |
| `ChatBubble.kt` | 246 | One row: entrance, swipe, long-press lift, semantics, `ChatRowStrings` |
| `ChatComposer.kt` | 354 | L3 composer, growth, reply/edit banner, attach↔send morph, sent-text lift |
| `ChatPills.kt` | 47 | Inline and sticky day separators |
| `ChatMenu.kt` | 22 | `MessageMenuPolicy` |

### Grouping

The grouping rules are a pure function, `buildChatItems`, tested in `ChatGroupingTest`:
- A new group starts when the sender changes, the day changes, or the gap is more than 5 minutes. Exactly 5 minutes stays in the same group.
- Each bubble gets a `BubblePosition`: SINGLE, FIRST, MIDDLE or LAST.
- Radii:
  - free corners are 8;
  - sender-side corners where two bubbles of one group meet are 4 (`CentyRadius.joined`);
  - the tail (2) is only on the first bubble's top corner nearest the sender.
- Bubbles in a group are 2 dp apart; groups are 10 dp apart.
- Time and state sit inside the **last** bubble of a group. An earlier bubble keeps its own meta only when it says something the last one does not: «изменено», or a different delivery mark (for example an older ✓✓ under a read ✓✓, or a queued/failed one).
- The meta sits at the end of the last text line when it fits there (a custom `Layout`), so a short message stays one line tall.
- Day separators are L3 pills. A sticky copy floats at the top while that day's rows pass under it.

On the device, a 12-message burst from bob now reads as one column, with the time shown once (`s02-chat-grouped-*`).

## Component inventory (`ui/components`)

Previews are in `ComponentPreviewsV2.kt`. The original `ComponentPreviews.kt` is still there. Interactive versions are in the debug gallery.

| # | Brief component | File | Preview(s) |
|---|---|---|---|
| 1 | `BrandMark` | unchanged from Task 12 | — |
| 2 | `Avatar` | `Avatar.kt`: `CentyAvatar(typing=)`, `StatusDot(pulse=)` | «TypingBubble + Avatar typing pulse», «Components · light/dark» |
| 3 | `DeliveryGlyph` | `DeliveryGlyph.kt`: drawn paths, states QUEUED / SENDING / SENT / DELIVERED / READ / FAILED | «DeliveryGlyph · states · light/dark» |
| 4 | `MessageBubble` | `MessageBubble.kt`: `bubbleShape`, `BubbleMeta`, `ReplyQuote`, failed row | «MessageBubble · grouped · light/dark» |
| 5 | `TypingBubble` | `TypingBubble.kt`; `TypingDots(rise, gap)` in `Indicators.kt` | «TypingBubble + Avatar typing pulse» |
| 6 | `UnreadPill` + `JumpToLatestPill` | `Indicators.kt`, `JumpToLatestPill.kt` (the `JumpToLatest` rule) | «JumpToLatestPill · UnreadPill · DateSeparator · light/dark» |
| 7 | `DateSeparator` | `DateSeparator.kt` (+ `dayLabel`) | same |
| 8 | `ConnectionBanner` | `ConnectionBanner.kt` (`BannerState`, `ConnectionBannerMachine`) | «ConnectionBanner · states · light/dark» |
| 9 | `SkeletonRow` / `SkeletonBubble` | `Skeleton.kt` | «SkeletonRow · SkeletonBubble» |
| 10 | `EmptyState` + illustrations | `StatePanels.kt` (`illustration =`), `Illustrations.kt` | «EmptyState · spot illustrations · light/dark», «EmptyState · inbox» |
| 11 | `SwipeToReply` | `SwipeToReply.kt` (`SwipeToReplyMath`) | «SwipeToReply · MessageContextMenu (static)» |
| 12 | `MessageContextMenu` | `MessageContextMenu.kt` (`MessageMenuHost`, `MessageMenuState`, `LiftedMessage`) | same |
| 13 | `AcknowledgeButton` | `AcknowledgeButton.kt` (+ `DrawnCheck`) | «AcknowledgeButton · light/dark» |
| 14 | `CallStage` | `CallStage.kt`: `BreathingRing`, `LevelMeter`, `CallControl`, `CallToggle` | «CallStage · ring, level meter, controls» |
| 15 | `AttachmentTile` | `AttachmentTile.kt`: `FileAttachmentTile`, `ImageAttachmentTile`, `UploadProgressRing` | «AttachmentTile · file, upload, failed, image» |
| + | Depth | `Depth.kt`: `rememberLift`, `Modifier.liftSurface` | — |
| + | Shared elements | `SharedElements.kt`: `LocalSharedTransitionScope`, `SharedKeys`, `Modifier.sharedConversationElement` | — |

### Where each component is wired and where it is not

- **Wired to real data:**
  - grouped bubbles, glyph (✓ → ✓✓ → ✓✓ indigo), typing bubble, jump pill, sticky date, banner;
  - swipe-to-reply and the menu (Ответить / Копировать / Изменить / Удалить);
  - reply banner, file tiles (FILE messages), stamp, call meter;
  - empty states and illustrations in the inbox, channels, search, announcements, chat and errors;
  - avatar pulse in inbox rows and the chat header.
- **Built, and shown only in previews and the debug gallery:**
  - glyph QUEUED / SENDING / FAILED, the failed row «Повторить / Удалить», upload progress and retry. `ChatActions.localMark` / `onRetrySend` / `onDiscardFailed` are the hooks for Task 15.
  - the image tile: Android has no image loading for `IMAGE` messages yet.
  - the attach → send morph: `ChatComposer(onAttach = null)` until uploads exist.

### Debug gallery

`ComponentGalleryActivity` lives in `src/debug` only and is exported for `adb am start`. Its tabs are «Отправка», «Пустые», «Связь», «Ознакомлен», «Звонок» and «Вложения». «Отправка» runs the **real** `ChatContent` with a fake send queue: the first send fails, and a retry goes sending → sent → delivered → read.

## Motion table

The desktop ease-out is `(.22,1,.36,1)`; the v2 decelerate is `EaseOutExpo (.16,1,.3,1)`. "Reduce" means Remove animations, read live into `LocalReduceMotion`.

| Effect | Spec | Reduce fallback |
|---|---|---|
| **Message lands** (focal) | Sent text lifts out of the field (−24 dp, fade, 240 ms expo). The own bubble rises 24 dp and scales 0.96 → 1 from its bottom-end corner (240 ms expo). The rest of the list slides up with `animateItem` (240 ms expo). Then the glyph draws ✓ (delay 144 ms, 160 ms). | Fade 120 ms, no lift; glyph appears drawn |
| Glyph state change | New state stroke-draws in 160 ms while the previous fades out | Instant swap |
| Failed | Red ⟲ draws, one 4 dp decaying shake (280 ms), warning haptic | Colour only; the haptic stays |
| Incoming message | Fade + 8 dp rise, 260 ms ease-out | Fade 120 ms |
| Inbox → chat | Avatar and name shared elements (300 ms expo); the rest fades through (out 90 ms, in 210 ms after 90 ms); back and predictive back reverse it | 150 ms crossfade, no shared elements |
| Other navigation | Shared-axis X (unchanged from Task 9) | 150 ms crossfade (was 120) |
| Top-bar lift | Plane tone → elevated + hairline, 150 ms | 120 ms |
| Composer growth | `animateContentSize` spring (damping 0.85, MediumLow), 1–6 lines | Steps |
| Attach ↔ send | Scale 0.7 ↔ 1 + crossfade, 150 ms | Crossfade 120 ms |
| Reply / edit banner | Expands from the composer, 180 ms in / 120 ms out | Fade 120 ms |
| Long-press menu | Scrim fades in (scrim token), bubble lifts to 1.03 (180 ms); closes in 120 ms before the action runs | Scrim fade only, no lift |
| Swipe-to-reply | Arrow ring fills 0 → 1 toward 64 dp; tick haptic on crossing; spring back (damping 0.8) | 120 ms tween back |
| Jump pill | Scale 0.6 → 1 + fade 180 ms; the count rolls up | Fade |
| Typing | Dots wave 1.2 s with 0.2 s stagger, plus a 3 dp rise in the bubble; presence dot pulse 1 → 1.22 (600 ms reverse) | Static |
| Banner | Expands from the top 280 ms; tone crossfades; «Снова в сети» holds 1.2 s, then collapses in 180 ms | Fade 120 ms |
| «Ознакомлен» stamp | Ring then tick draw in 280 ms expo; the button crossfades and scales 0.96 → 1 into success; confirm haptic | Check shown drawn |
| Press | Ripple + primary-soft row highlight in 120 ms | Same |
| Skeleton | 1.2 s sweep | Static |
| Call ring and meter | Ring 1 → 1.08 over 1.6 s, only while ringing; meter bars read in the draw phase | Static ring |
| Image tile | Picture fades in over its placeholder, 280 ms | 120 ms |

All animated values are read in `graphicsLayer` or the draw phase. The only infinite loops are the typing dots and pulse and the call ring, and they exist only while typing or ringing.

## IME approach

- **Edge to edge.** `enableEdgeToEdge` and `adjustResize` stay. Chat `Scaffold` insets are 0. The composer takes `WindowInsets.navigationBars ∪ ime` itself. On API 30+ that is the animated `WindowInsetsAnimation`, so the composer moves frame by frame with the keyboard. There is no manual offset.
- **Reverse layout.** The history is a `LazyColumn(reverseLayout = true)`, with index 0 the newest row. The viewport shrinks from the bottom and the newest message stays glued above the composer.
- **Interactive dismiss.** `Modifier.imeNestedScroll()` lets a drag down move the keyboard with the finger. A small `NestedScrollConnection` (`NoKeyboardPull`) eats what is left of an upward pull at the newest end, so pulling up never opens the keyboard. That is the Android sample's other half, and I judged it hostile in a chat.
- **Follow and anchor.** A bottom-up list keeps its place by key, so a row inserted at index 0 would land below the viewport. When the reader was at the bottom (checked in `SideEffect`, before the next measure), the list calls `requestScrollToItem(0)`.
  - `FollowPolicy` (Task 9) still decides what counts as unseen.
  - An own send while scrolled up animates to the bottom.
  - Opening the keyboard scrolls the conversation only if the reader was already at the bottom; otherwise the jump pill floats above the composer (`s07-keyboard-glued-*`).
- **Composer.** It grows from 1 to 6 lines (`ComposerSizing.MAX_LINES`), then scrolls inside. `ChatUiV2Test.theComposerGrowsToSixLinesThenScrollsInside` checks that the height at 6 lines equals the height at 20.
- **Forms.** Login already moves Login → Password → «Войти» through IME actions under `safeDrawingPadding` + `verticalScroll`, so the focused field is brought into view. It was not changed.

## Depth mapping

| Plane | Token (light / dark) | Android surfaces |
|---|---|---|
| L0 frame | `frame` `#ececf1` / `#19191e` | `NavigationBar` / rail, call screen |
| L1 list | `list` `#f4f4f7` / `#1e1e24` | Inbox, announcements, profile; inbox and announcement headers at rest |
| L2 canvas | `canvas` `#fcfcfd` / `#24242a` | Chat history; chat header at rest; login |
| L3 elevated | `elevated` `#ffffff` / `#303038` + hairline | Composer, reply/edit banner, menus, sheets, connection banner (soft tint over elevated), sticky and inline date pills, lifted top bars, the jump arrow |
| Scrim | `scrim` `rgba(20,20,40,.34)` / `rgba(8,8,12,.64)` | Lifted message menu, announcement sheet |

`Plane` and `CentyTokens.plane()` are in `Tokens.kt`.

Top bars are flat at rest and lift (tone + hairline, 150 ms) when content passes under them:
- chat: `listState.canScrollForward` in the reverse list;
- inbox and announcements: first index or offset above 0.

There are no shadows and no fake blur. The jump pill lost its old 3 dp shadow.

## Illustrations

`Illustrations.kt` has five authored `ImageVector`s:
- 120 dp, on a 120-unit grid;
- graphite line (`textSecondary`), indigo stroke (`accentText`), primary-soft fill flattened on card, card "paper";
- no gradients;
- built per theme from tokens, so light and dark are both authored.

| Kind | Drawing | Where |
|---|---|---|
| `INBOX` | Two overlapping bubbles (paper one with text lines; indigo reply with three dots) | Empty inbox, empty chat |
| `CHANNELS` | A hash in an indigo bubble, with a paper bubble behind | Empty channels |
| `ANNOUNCEMENTS` | Megaphone with an indigo check badge | Empty announcements |
| `OFFLINE` | Cloud with a broken link and sparks | Every `ErrorState` (default) |
| `SEARCH` | Magnifier over an empty bubble | Search with no results |

ThemeTokensTest gates the strokes at 3:1 against list, canvas and the soft fill.

## Frame stats (emulator evidence only)

**Setup.** Pixel_8 AVD, GLES through the host Intel UHD 770 translator, 60 Hz.

**Build.** *(Corrected in fix round 1: this build was **not** shrunk by R8; re-measured with R8 there.)* A release-type build: not debuggable, signed with the debug keystore. It is made by a local-only Gradle init script that adds a `benchmark` build type, plus a temporary `ServerConfig` patch that points that build type at the dev stand. The patch is reverted by the same script. Nothing about it is committed: `git status` was clean after every build.

**Scenarios** (`dumpsys gfxinfo <pkg> framestats`):
- scroll: 8 flings in a 40+ message chat;
- keyboard: 5 open/close cycles;
- insert: 12 WS messages from bob at 350 ms, while at the bottom.

| Scenario | Before (`5ef7972`) | After (`b77d8d6`) |
|---|---|---|
| Scroll | 152 frames, janky 6.6% (legacy 2.6%), p50 17 / p90 18 / p99 30 ms, slow UI-thread 0 | 232 frames, janky 3.9%, p50 17 / p90 21 / p99 32 ms, slow UI-thread **0** (4 before the `onPlaced`/glyph-geometry fix) |
| Keyboard | **62 frames**, janky 56% (legacy 0%), slow UI-thread 0, "slow issue draw" 35 | **231 frames**, janky 13.4% (legacy 0.4%), slow UI-thread 0 |
| Insert | 245 frames, janky 7.4%, p99 19 ms, slow UI-thread 2 | 245 frames, janky 7.4%, p99 18 ms, slow UI-thread 11 |

UI-thread time per frame is IntendedVsync → SyncQueued over the last 120 frames, parsed by a scratchpad script:

| Scenario | Before p50 / p90 / p99 / max (ms) | After p50 / p90 / p99 / max (ms) |
|---|---|---|
| Scroll | 3.0 / 5.6 / 12.6 / 13.8 | 3.0 / 5.6 / 8.6 / 10.9 |
| Keyboard | 2.3 / 6.6 / 7.8 / 7.8 | 4.2 / 7.1 / 10.1 / 10.3 |
| Insert | 2.0 / 3.5 / 6.6 / 6.7 | 2.2 / 3.8 / 10.8 / 12.1 |

Inbox → chat open, release-type, 5 warm opens, worst UI-thread frame per open:
- before `b77d8d6`: 47 / 41 / 22 / 20 / 37 ms;
- after: 33 / 9 / 21 / 27 / 7 ms.

How to read this:
- **The emulator GPU is the bottleneck.** The "janky" counts come from "slow issue draw commands" and deadline misses at 60 Hz with a GPU p50 of 15–16 ms. Within the framestats window, no measured scroll, keyboard or insert frame spent more than 16 ms on the UI thread.
- **Keyboard.** The keyboard now renders every frame of the IME animation: 231 frames for 5 cycles, against 62 before, when the composer jumped through fewer frames. Fewer of them are janky.
- **Insert.** Inserts cost more per frame than before (UI p99 6.6 → 10.8 ms). That is the landing animation plus the placement of every visible row.
- **Inbox → chat.** The first chat frame still takes 20–30 ms on the UI thread, so on the emulator roughly the first third of the 300 ms shared transition is skipped. The shared avatar and name do travel (checked frame by frame in the release-type recording).
- **Hardware is still needed.** A real device and a baseline profile are needed before claiming 60/120 fps.

## Recordings and screenshots (`mobile/android/build-evidence/task17/`, git-ignored)

All are `adb shell screenrecord` / `exec-out screencap` on `emulator-5554`. They are emulator evidence against the dev stand, which ran as `SERVER_PORT=2014 node mobile/dev/stand.mjs`. The owner's `:2004` server was not touched.

**Builds used:**
- Realtime scenarios: the release-type build described above, so the motion is closer to what users get.
- Gallery scenarios (04, 07): the debug build, since the harness is debug-only.

**Recordings** (each 30 s or less):

| File | Shows |
|---|---|
| `01-inbox-to-chat-{light,dark,reduce}` | Row press highlight, shared avatar and name into the header, fade-through, back |
| `02-keyboard-{light,dark}` | Keyboard opens with the history anchored, drag-down interactive dismiss, reopen, composer grows to 6 lines then scrolls |
| `03-send-delivered-read-{light,dark,reduce}` | Own message lands (✓ draws), bob connects (✓✓), bob reads (✓✓ indigo) |
| `04-failed-retry-{light,dark}` | Gallery «Отправка»: send → sending → red ⟲ + shake + «Не отправлено · Повторить · Удалить» → Повторить → sending → sent → delivered → read |
| `05-swipe-to-reply-{light,dark}` | Short swipe springs back; long swipe fills the arrow and opens «Ответ · Боб Тестов» above the composer |
| `06-context-menu-{light,dark}` | Long press lifts the bubble over the scrim with Ответить / Копировать / Изменить / Удалить; back closes |
| `07-empty-states-{light,dark}` | Gallery «Пустые»: inbox, channels, announcements, search, offline illustrations |
| `08-banner-cycle-{light,dark}` | Airplane on: «Нет сети»; off: «Переподключение…» with dots, then «Снова в сети», then collapse |

The Remove-animations recordings are `01-*-reduce` and `03-*-reduce`, made with `animator_duration_scale 0`.

**Screenshots** (`s01`–`s12`, light and dark):

| File | Shows |
|---|---|
| `s01-inbox` | Inbox |
| `s02-chat-grouped` | Grouped bubbles, sticky «Сегодня», lifted header |
| `s03-chat-menu-lifted` | Lifted bubble, scrim, menu |
| `s04-reply-draft` | «Ответ · Вы» banner |
| `s05-typing-bubble` | Header «печатает» and the dots bubble |
| `s06-jump-pill-sticky-date` | «1 новое» pill and sticky date |
| `s07-keyboard-glued` | Keyboard open, history anchored, pill above the composer |
| `s08-call-level-meter` | Gallery call stage with the live meter |
| `s09-attachment-tiles` | PDF / upload ring / failed / image tiles |
| `s10-acknowledged-stamp` | «Ознакомлен» success |
| `s11-empty-inbox-illustration` | Empty inbox illustration |
| `s12-error-offline-illustration` | Offline error illustration |

I opened every capture once:
- recordings as ffmpeg contact sheets, plus frame-by-frame strips for the inbox → chat transition, the glyph states in 03 and the failed/retry bubble in 04;
- screenshots as montages.

Each shows what its name claims, with two caveats:
- In `06-context-menu-*` the second long press, on bob's message 12, did not open a menu. The first long press, on an own message, shows the full lift + scrim + four actions.
- `04-failed-retry-*` stops at the 20 s limit while the retried message is already past «sending». The sent → read part of this path is visible in `03`.

Re-recorded after a script fix: 04 and 07 in both themes (stale activity and an off-screen chip), and 05 and 06 in light.

**Device state restored:**
- `uimode night no`;
- `animator_duration_scale` deleted (it was unset before);
- airplane mode off;
- font scale 1.0 and size 1080x2400 were never changed.

The dev stand and the first emulator were stopped when the controller session restarted. The emulator was then restarted for the final `connectedDebugAndroidTest` run and is still running; its settings were rechecked after the final run: night mode no, `animator_duration_scale` null, airplane mode 0, font scale 1.0, size 1080x2400. Stand data in `mobile/dev/data` (git-ignored) now holds bob's test bursts and alice's test messages.

## Tests

**TDD.** Every pure rule was written test-first. The RED run used compile-only stubs and showed 22 of 31 new tests failing. The pure rules:
- `ChatGroupingTest` (8): positions, the 5-minute and day breaks, tail only on the first, meta on the last unless edited or a different mark, stable keys;
- `MessageMenuPolicyTest` (6): order Ответить / Копировать / Изменить / Удалить; incoming offers reply and copy only; files have no copy; deleted offers nothing; failed offers copy and discard;
- `SwipeToReplyMathTest` (4): direction (LTR and RTL), proportional fill, threshold, resistance capped at 1.6 thresholds;
- `JumpToLatestRuleTest` (3);
- `ConnectionBannerMachineTest` (5): problem, back online for 1.2 s, never announcing a healthy link, interruption;
- `ComposerSizingTest` (2);
- `AudioLevelTest` (3): RMS, dB-scaled bars, decay.

**Contrast gates.** `ThemeTokensTest` got 3 new tests:
- 18 v2 text pairs at 4.5:1 in both themes: L3 surfaces, the three banners, menus, failed row, reply quote inside the own bubble, attachment text and badges, the stamp;
- 10 graphic pairs at 3:1: read/failed/sent glyphs in the own bubble, swipe ring, illustration strokes, meter bars, typing dots;
- the scrim values, plus the dark elevated-vs-canvas tone step.

  One gate failed on the first run: dark file size on a tile was 4.14:1. The tile now uses `textSecondary`.

**Compose UI tests** on `emulator-5554`. They were written alongside the components, not RED-first; the rules beneath them were RED-first.
- `ChatUiV2Test` (7):
  - grouping shows one glyph for a group of three;
  - the own-message menu offers all four actions over the scrim;
  - the incoming menu offers reply and copy only;
  - Ответить drafts a quote and sends with `replyTo = 1`;
  - the jump pill appears when reading far up and takes the reader back;
  - the composer is capped at 6 lines;
  - the typing bubble appears.
- `ComponentsUiTest` (6):
  - a short swipe does not reply;
  - a swipe past the threshold replies once;
  - a swipe toward the end does nothing;
  - the banner goes Нет сети → Переподключение… → Снова в сети → collapsed;
  - a healthy link says nothing;
  - the jump pill counts and hides.
- `ChatContentTest` was updated for the bottom-up list: «scroll to the oldest» became `performScrollToKey("msg-1")`.

**Fixtures.** `ContractFixturesTest` was failing on `5ef7972` before this task. Task 16 recaptured the fixtures: there is a new `message_cancelled` frame, and the reconnect status now refers to message 13. Commit `475bb7a` adds `message_cancelled` to `WsEventParser`'s explicit ignore list, with a comment pointing to Task 15, and updates the expected id.

Final command outputs on HEAD `28f6406`, run from `mobile/android` with `JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1`, `GRADLE_USER_HOME=/c/tmp/gradle-user-home` and `--project-cache-dir /c/tmp/m-android-project-cache`:

```
./gradlew.bat testDebugUnitTest lint assembleDebug assembleRelease
BUILD SUCCESSFUL in 2m 37s
112 actionable tasks: 6 executed, 106 up-to-date

./gradlew.bat connectedDebugAndroidTest
Running tests on devices: Pixel_8(AVD) - 17
BUILD SUCCESSFUL in 1m 39s
81 actionable tasks: 1 executed, 80 up-to-date
```

The two runs were separate because the emulator had to be restarted after the controller session restart.

Most tasks were up to date because an earlier full run of the same command, on `3186165`, was interrupted by the restart after it had built. The new commit `28f6406` only touches `.gitignore`.

| Result | Value |
|---|---|
| Unit tests (JUnit XML) | 206 in 50 suites, 0 failures. Task 9 ended with 172. |
| Instrumented (`TEST-Pixel_8(AVD) - 17.xml`) | 43, 0 failures and 0 errors. Task 9 ended with 30. |
| Lint (`lint-results-debug.xml`) | 28 issues, 0 errors |
| Release APK | `app-release-unsigned.apk`, 4.66 MB |
| Debug APK | `app-debug.apk` |

## Concerns

1. **Reply sending is not wired.** «Ответить» and swipe-to-reply set a local draft, and `ChatActions.onSend(text, replyTo)` receives it. `ChatScreen` still calls `viewModel.sendMessage(text)`, so a message sent with a draft reaches the server **without `reply_to_id`** until Task 15 carries it.
2. **Queued / sending / failed are not on real data.** They exist as components and in the gallery harness. On real data they appear only once Task 15 implements `ChatActions.localMark`, `onRetrySend` and `onDiscardFailed`. Recording `04-failed-retry` is the harness, not the app's send path.
3. **First frames of inbox → chat are skipped on the emulator.** The first chat frame costs 20–30 ms of UI-thread time (release-type, emulator), so part of the 300 ms shared transition is skipped. Row strings were already hoisted. A baseline profile, and measuring on hardware, are the next steps.
4. **Inserts cost a little more per frame** (UI p99 10.8 ms against 6.6 ms). That is the landing and placement animation. It is still under 16 ms on the emulator.
5. **Data-layer touch for the fixtures.** I edited `WsEventParser.kt`, outside the UI, only to make the pre-existing Task 16 fixture drift explicit, so that the suite is green. Task 15 should map `message_cancelled` properly.
6. **Interactive keyboard open is filtered out on purpose.** Pulling up at the newest end does not open the keyboard. If the owner wants the sample's open-by-pull, remove `NoKeyboardPull`.
7. **No attach button and no image loading on device.** The attach → send morph and the image tile are visible only in the gallery and previews.
8. **Production login attempt.** During the first measurement, my first benchmark APK (before the `ServerConfig` patch) pinned the production URL, so one login with the **dev-stand** credentials (alice; password: see mobile/dev/README.md) went to `centychat-production.up.railway.app` and was refused («Неверный логин или пароль»). Three more followed in fix round 1 (see its concerns).
9. **Measurement tooling is local only.** It lives in the scratchpad: the benchmark init script, the ServerConfig patch script, `bob.mjs`, `ui.mjs`, `measure.sh`, `rec.sh`, `shots.sh` and the framestats parser. To check the recordings I installed `imageio-ffmpeg` into the scratchpad with pip.
10. **The UI tests were not RED-first** (see Tests).


---

# Fix round 1

**Status: DONE_WITH_CONCERNS.** Every item from the code review and the design finish-review is fixed in one batch. No FAB and no «Начать чат», as ruled.

Everything is green on HEAD `2898ac9` (`mobile/android`, not pushed):

| Check | Result |
|---|---|
| Unit tests | 208 in 50 suites, 0 failures |
| `lint` | 0 errors (26 issues, down from 28) |
| `assembleDebug` | Built |
| `assembleRelease` | Built (4.66 MB) |
| `connectedDebugAndroidTest` on `emulator-5554` | 47 tests, 0 failures |

## Commits

| SHA | Message |
|---|---|
| b0b4a43 | fix(android): a bubble group reads as one shape and history never reflows |
| aee3564 | fix(android): follow rule survives the typing row; sticky date only while scrolling |
| 413299a | feat(android): the sent text travels into its bubble in one motion |
| a2b7a09 | fix(android): a reopened chat shows its last history at once |
| f409049 | fix(android): the navigation bar slides with inbox to chat instead of jumping |
| 1bac6b3 | fix(android): review minors in the component library |
| 2898ac9 | perf(android): light first chat frame; sticky date follows real movement |

## Code review

**Important.** The "was at the bottom" snapshot (`ChatList.kt`) is now taken when the *newest message* changes, not the newest row. The row snapshot still drives `requestScrollToItem(0)` anchoring.

Two `ChatContentTest` cases run with `typingUser != null`:
- scrolled up + incoming → «1 новое»;
- scrolled up + own send → jumps to the bottom, no pill.

Proof the tests catch the bug: I temporarily restored the old snapshot logic and ran `ChatContentTest`. Exactly those two tests failed (2 of 11). With the fix, all 11 pass. The file was restored afterwards.

**Minors:**

| Minor | Fix |
|---|---|
| `ChatGroupingTest` | `aDeletedMessageKeepsItsPlaceInTheGroup`, `deletedIsNotEdited` |
| Dead helpers | `ComposerSizing.visibleLines` / `scrollsInternally` and `ComposerSizingTest` removed. The 1→6 line cap stays covered by `ChatUiV2Test.theComposerGrowsToSixLinesThenScrollsInside`. |
| `DeliveryGlyph` | `previous = null` in a `finally` |
| First message of an empty chat | Lands. The still baseline is taken in `ChatContent` the first time the history shows (empty counts), not when the list first composes. |
| `NoKeyboardPull` | Consumes only while `WindowInsets.isImeVisible` is false, so the stretch overscroll works with the keyboard open |
| `SwipeToReply` | `onDragStarted` cancels the spring-back job and continues from the current offset |
| `LiftedMessage` | Draws the row's latest bubble through `rememberUpdatedState` |
| Lint | `LocalResources.current` in `rememberChatRowStrings`; `EmptyState(title, modifier, icon, …)` |
| `ChatUiV2Test` | `menuActionsDispatch` (copy reaches the clipboard, edit reaches `onStartEdit`, delete opens the confirmation); `swipingABubbleInTheChatOpensTheReplyBanner` |

**TDD.** The two behaviour changes were RED before they were written: the stable-meta rule and the cached reopen (`ChatHistoryCacheTest`). That run had 208 tests and 2 failures.

## Design review

1. **Sticky date pill.**
   - It shows only while the history moves. It is driven by the first visible row's index/offset changing, fades in over 120 ms, and is gone 1 s after the last movement.
   - It sits 8 dp under the bar, with an opaque elevated fill and a `borderStrong` hairline (`DateSeparator(floating = true)`).
   - I first keyed it on `isScrollInProgress`. Movement turned out to be more robust: no false "still scrolling" from programmatic scrolls.
2. **Two «Сегодня» pills.** The sticky copy hides while that day's own separator is in `visibleItemsInfo`, and while the list does not fill the viewport (`!canScrollForward && !canScrollBackward`).
3. **Grouping.**
   - `CentyRadius.joined` 4 → **2 dp**.
   - A grouped bubble overlaps the one above it by its hairline (the row lays out 1 px shorter and places its content 1 px higher), so a group has **one** outline. There are no double lines or gaps, and a narrower or wider neighbour keeps its own visible edge.
   - Own bubbles are now opaque: primary-soft / primary-line flattened on canvas (`#ECEBFB` / `#36354C`). This makes the overlap seam a single line, and is also what fixes item 5.
   - Incoming light `#fff` on `#fcfcfd` still has no tone step. The group reads by the single contour and the 2 dp sender edge (`s02-chat-grouped-*`).
4. **The message lands** (`ChatLanding.kt`, `LandingOverlay` in an unclipped root layer):
   - On send, the composer hands its text and its exact position to a flight.
   - The text waits where it was typed until its bubble is in the list. The first matching fresh own bubble claims the flight, stays hidden, and keeps reporting its text position while it settles.
   - The text then travels X/Y into that position in 240 ms (`.16,1,.3,1`), with colour textMain → accentText, and the bubble appears under it.
   - The placeholder returns after 120 ms.
   - Fallback: if no bubble arrives within 900 ms, the text fades where it was.
   - Verified frame by frame in `03-send-delivered-read-light`: the final flight frame and the first bubble frame put the text at the same x/y.
5. **Lifted bubble.**
   - It is opaque in light and dark (item 3).
   - The menu anchors to a box 8 dp larger than the bubble on each side, so the gap holds whether the menu opens below or above. A plain `DropdownMenu(offset = 8dp)` pushed a flipped menu into the bubble.
6. **Bottom bar.**
   - `NavigationSuiteScaffold(state = rememberNavigationSuiteScaffoldState())` now hides and shows the bar (snap with reduce motion) instead of switching layout type, so it slides away with inbox → chat. The content area grows with it, so the chat composer follows down in the same motion, and the bar slides back up on back.
   - The gesture-bar inset is consumed only while the bar's target is Visible.
   - Verified frame by frame on device: 3–4 frames of slide forward and back. The composer no longer jumps.
7. **Skeleton flash on reopen.**
   - `ChatHistoryCache` (singleton, in memory, per process) keeps each conversation's last history, keyed by **user id + conversation**: another account never sees it.
   - A reopened chat starts from it. The server history **replaces** it rather than merging, so a message deleted meanwhile does not come back. Realtime messages that arrived during the request are still kept.
   - While loading with no cache, nothing shows for 300 ms, then the skeleton fades in.
   - Tests: `ChatHistoryCacheTest` (2), and `ChatContentTest.loadingShowsASkeletonNotASpinner` now checks the 300 ms delay.
8. **History reflow.** `showsMeta = endsGroup || edited`. Stable inputs only: a delivery status catching up never changes an older bubble's geometry.
   - Test: `metaComesFromStableInputsNeverFromTheDeliveryState`, which compares the same history before and after statuses catch up.
   - Trade-off: a queued or sending glyph on a non-last bubble of a group is not shown. A failed message is still unmistakable through its danger outline and «Не отправлено · Повторить · Удалить» row. The send queue is FIFO, so the last bubble's state covers the earlier ones.
9. **Composer growth.** It grows at once (a new line is never clipped) and only shrinks with the spring (custom `shrinkSmoothly()` layout modifier).
10. **«↓ N новых».** Aligned to the end, 12 dp above the composer.
11. **Remove animations.** Android's «Удалить анимацию» sets `ANIMATOR_DURATION_SCALE = 0`, and Compose applies that scale to every animation, so at 0 every fade, including the reduce-motion 150 ms crossfade, is a cut. That is the system's choice, and the brief's 150 ms crossfade cannot survive it.
    - `LocalReduceMotion` is true only at 0.
    - The reduce branches still matter at 0: they remove spatial motion (no lift, no shared elements, no landing flight, no shake) and swap in fades, so nothing slides even for a frame.
    - Recordings `01-*-reduce` and `03-*-reduce` show the cut behaviour.

Two additions while re-verifying:
- **Light first chat frame.** With a cached history, the whole list now composed in the transition's first frame. The history now composes two frames after the screen, while the incoming chat is still invisible: the fade-through starts after 90 ms.
- **«Ответ · Вы».** It still works with the opaque fill.

## Frame stats — correction and re-measurement (emulator evidence only)

**Correction.** The main report's frame stats came from a non-debuggable `benchmark` build **without R8**. Under AGP 9, `initWith release` did not carry `isMinifyEnabled` over: the APK was 18 MB of unshrunk dex. I only found this in this round. The local init script now sets `minifyEnabled true` and the release ProGuard files, and the APK is 4.67 MB like `assembleRelease`.

Both sides were re-measured with R8, same emulator and scenarios. The "before" build came from a temporary worktree at `5ef7972`, which was removed afterwards:

| Scenario | Before (R8, `5ef7972`) | After (R8, `2898ac9`, scroll/keyboard/insert measured on `1bac6b3` + sticky change) |
|---|---|---|
| Scroll (8 flings) | 174 frames, janky 4.6%, slow UI-thread 0, UI p50 / p90 / p99 / max 2.9 / 5.1 / 7.3 / 7.6 ms | 140 frames, janky 10.0%, slow UI-thread 0, UI 3.0 / 5.1 / 6.9 / 9.2 ms |
| Keyboard (5 cycles) | 61 frames, janky 55.7%, slow UI-thread 0, UI max 42.3 ms | 61 frames, janky 63.9%, slow UI-thread 1, UI max 9.8 ms |
| Insert (12 WS messages) | 244 frames, janky 7.4%, slow UI-thread 1, UI p99 6.4 ms | 244 frames, janky 7.0%, slow UI-thread 6, UI p99 9.2 / max 10.0 ms |
| Inbox → chat, 5 warm opens, worst UI-thread frame | 21 / 29 / 19 / 23 / 23 ms | 55 / 36 / 22 / 22 / 30 ms (open 1 cold) |

How to read this:
- **UI thread.** Within the framestats window, no scroll, keyboard or insert frame spends more than 16 ms on the UI thread on either side. Janky percentages are emulator-GPU deadline misses (GPU p50 15–16 ms at 60 Hz) and vary run to run.
- **Keyboard frame count.** The 231-frame figure in the main report was from the non-R8 build and is not reproduced here (61 both sides). I withdraw that claim.
- **Chat open.** It is roughly at parity once warm. The first open after launch is still heavier than before: ViewModel and cache setup, plus the bar animation's per-frame relayout.
- **Inserts.** They cost slightly more per frame: the landing and placement animations.
- **Hardware is still needed.** Hardware plus a baseline profile are needed before claiming 60/120 fps.

## Recaptured evidence (`build-evidence/task17/`)

**R8 build, against the dev stand:**
- `01-inbox-to-chat-{light,dark,reduce}`: bar slides with the transition, no skeleton flash on reopen;
- `02-keyboard-{light,dark}`: sticky date only while moving, composer grows without clipping;
- `03-send-delivered-read-{light,dark,reduce}`: the landing flight, then ✓ → ✓✓ → indigo ✓✓, with no reflow of older bubbles;
- `05-swipe-to-reply-{light,dark}`: re-shot on the newest, fully visible incoming bubble, «Сообщение 12 из 12»;
- `06-context-menu-{light,dark}`: opaque lifted copy, 8 dp to the menu.

**Debug build** (gallery harness): `04-failed-retry-{light,dark}`.

**Screenshots** `s01`–`s12`, light and dark: all retaken on the debug build against the stand.

`07-empty-states-*` and `08-banner-cycle-*` were not affected and were kept.

I opened every recapture once, as contact sheets plus frame-by-frame strips for the landing, the bar slide and the swipe.

**Device state restored:**
- night mode no;
- `animator_duration_scale` null;
- airplane mode 0;
- font scale 1.0;
- size 1080x2400.

The emulator and the dev stand are still running.

## Concerns (this round)

1. **More production login attempts.** Three more login attempts with the dev-stand account went to the production server, and all were refused. Gradle's `connectedDebugAndroidTest` rebuilds the debug APK without `-Pcentychat.serverUrl`, so the debug app on the device pointed at production. Separately, two of my builds failed silently, because exporting `MSYS_NO_PATHCONV=1` breaks Gradle's `/c/tmp` arguments in Git Bash. Every install now checks the generated `BuildConfig.SERVER_URL` first and aborts if it is not the stand.
2. **Production debug APK on disk.** The debug APK left by the final command run is a production-pointed debug build, which is normal for that command. The device currently has the stand-pointed debug build from the screenshot pass.
3. **Earlier frame stats were without R8.** The main report's frame stats were without R8 (see the correction above).
4. **Queued/sending glyph on a non-last bubble** is not shown under the stable-meta rule (design 8 trade-off). Failed is always shown.
5. **Interactive keyboard open is still filtered**, now only while the keyboard is hidden.
6. **Unchanged from the main report:** reply sending, queued/failed on real data and attach still wait on Task 15.


---

# Fix round 2

**Status: DONE.** Design 6 is closed and every minor is folded in. Debug builds now default to the dev stand.

Final verification on HEAD `fbf562e` (`mobile/android`, not pushed, tree clean), all green:

| Check | Result |
|---|---|
| Unit tests | 216 in 52 suites, 0 failures |
| `lint` | 0 errors (26 issues) |
| `assembleDebug` | Built |
| `assembleRelease` | Built |
| `connectedDebugAndroidTest` on `emulator-5554` | 48 tests, 0 failures |

The debug build used by the connected run has `SERVER_URL = https://10.0.2.2:8443`.

## Commits

| SHA | Message |
|---|---|
| 02a0352 | fix(android): the composer follows the sliding bar; landings queue and wrap like their bubble |
| c297cd8 | fix(android): history cache ends with the session; refresh failure says so |
| fbf562e | fix(android): debug builds default to the local dev stand, never production |

## Design 6: the composer and the sliding bar

**Root cause, confirmed with a temporary on-device log.** I measured the bar's visible height each frame from the content area's constraints:
- forward: 273 → 253 → 0 px;
- back: 0 → 19 → 109 → 187 → 234 → 268 → 272 → 273 px.

The slide itself was fine. The jump came from `NavigationSuiteScaffold`: with the state API it changes its **own** inset consumption for the content the moment the bar's *target* changes. On back, the chat therefore lost its gesture-inset padding on the first frame (the ≈24 dp drop), and on forward it gained it early. Consumption can only be added, never undone, below the scaffold, so a visible-fraction `consumeWindowInsets` alone could not fix the back case. I tried it first; the recording still showed the 63 px drop.

**Fix:**
- The navigation shell measures the bar's visible height in the same layout pass, before the screens measure, and exposes it as `LocalBottomBarVisible`.
- It consumes the gesture inset only by that height, so lists and the snackbar follow the slide.
- The chat composer pads itself from the **raw** insets and that height through the `bottomBarAwareInsetsPadding()` layout modifier, so it is immune to the scaffold's consumption switch. Bottom padding = `max(ime, navInset − min(navInset, barVisible))`, which puts the composer `max(visible bar, gesture inset)` above the edge.
- IME and nav insets are read in the layout phase, so there is no recomposition per frame.

**Pure function and test.** `NavBarInset.consumedBottom` / `composerLift`. `NavBarInsetTest` checks fractions 0…1 in both directions:
- the lift is monotonic;
- no step is larger than one slide step;
- rest positions are the bar when shown and the gesture inset when hidden.

**Cold start / deep link.** `rememberNavigationSuiteScaffoldState(initialValue = …)` starts from the current destination.

**Frame-by-frame verification** (re-recorded `01-inbox-to-chat-{light,dark,reduce}` on the R8 build; the composer field's bottom border was tracked per frame with a pixel-column script and checked on contact sheets):
- **Forward:** the chat appears with the composer at its rest line (field bottom y = 2315 px). The bar finishes sliding under the fade. The composer never goes below the rest line or over the gesture handle, and does not pop.
- **Back:** the composer holds 2315 px on every frame while the chat fades out (the old 2315 → 2378 drop is gone). Then the inbox's bar slides up over 6 frames.
- **Reduce:** chat frames are all at 2315 px, and the reopen has no blank frame.
- **Debug build:** on the slower debug build the composer moves monotonically down with the bar. One big step comes from the scaffold's own slide dropping frames (253 → 0 px in one frame on the emulator), not from a mismatch with the bar.

## Minors

| Minor | Fix | Proof |
|---|---|---|
| Blank frame on reduce-motion reopen | `historyReady` starts true with reduce motion (`ChatScreen`). | Re-recorded `01-reduce`: the reopen goes inbox → chat with no blank frame. |
| Moving text re-wraps at hand-off | The flying text uses `bubbleTextMaxWidth(window)`, which mirrors the bubble row's constraints: list padding 12+12, box `widthIn(max = 320) fillMaxWidth(0.84)`, text padding 12+12. The composer measures the message at that width with a `TextMeasurer` and launches a flight only when it fits in 6 lines; longer messages fade in (any bubble without a flight fades and rises 8 dp). | — |
| Rapid double send | `LandingState` keeps a list of flights; each fresh own bubble claims the oldest unclaimed flight with its text, and each lands on its own. | `LandingStateTest` (3, JVM): two quick «Да» land in msg-1 and msg-2; other text is not carried; the target follows the settling bubble. |
| History cache and logout | `ChatHistoryCache` collects the session token and wipes itself the moment it becomes null (logout, revoked token). It stays keyed by user id. | `ChatHistoryCacheTest.signingOutClearsTheCache` |
| Refresh failure over cache | The cached history stays and a quiet `InlineNotice` «Не удалось обновить» with «Повторить» appears under the banner (`ChatViewModel.refreshFailed`). | `ChatHistoryCacheTest.aFailedRefreshOverCachedHistoryKeepsItAndSaysSo`; `ChatContentTest.aFailedRefreshOverCachedHistorySaysSoAndRetries` (device) |
| Reduce-motion rationale | Now in the KDoc of `LocalReduceMotion` (`ui/theme/Motion.kt`). | — |
| Debug default (pulled forward from Task 21) | `val devStandServerUrl = "https://10.0.2.2:8443"` is the debug default in `app/build.gradle.kts`; production is reachable from debug only through `-Pcentychat.serverUrl=…`; release is unchanged. `ServerConfig` KDoc and `mobile/android/README.md` are updated. | `ReleaseConfigurationTest.debugDefaultsToTheLocalDevStandNeverProduction` (RED first). The final `connectedDebugAndroidTest` built against the stand. |

**TDD.** Five tests were written first and failed against compile-only stubs (213 tests, 5 failed): the debug default, the two `NavBarInset` tests, and the two cache tests. All are green now.

Concern 3 from round 1 (queued/sending on non-last bubbles) is left for Task 15, as ruled.

## Evidence

- Re-recorded on the R8 build: `01-inbox-to-chat-{light,dark,reduce}`.
- The other captures from fix round 1 still stand: nothing else in them changed visually.
- I did not capture a separate multi-line landing clip. The scripted send did not fire after an emulator restart, and the wrap width is the bubble's own formula.

**Device state restored:**
- night mode no;
- `animator_duration_scale` null;
- airplane mode 0;
- font scale 1.0;
- size 1080x2400.

The first emulator was stopped at its 2-hour background limit and restarted. The emulator and the dev stand are running.

## Concerns (this round)

- None new.
- The "R8 or not" caveat for frame stats from round 1 stands as corrected there.
