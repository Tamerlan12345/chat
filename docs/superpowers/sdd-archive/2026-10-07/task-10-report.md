# Task 10 — iOS: design system, UI layer v2 and polish (plan Task 7) — report

Lane `m-ios`, branch `mobile/ios`, start 5125e3e. All evidence is **iOS Simulator (iPhone 16, CI macos-15)**; no Mac here.

## Status

**DONE_WITH_CONCERNS.** Head `ce6351d` (pushed to `mobile/ios`), CI run **37440917565 green**: build, unit **488/488**, UI **20 passed + 1 skipped** (the motion walkthrough runs on its own), release server lock ok, motion recordings light / dark / Reduce Motion all passed, 92 files published to `ci/ios-screenshots/ce6351d/` (89 PNG + 3 MP4). Before set: `ci/ios-screenshots/1e5d17f/` (50 PNG). All evidence is iOS Simulator.

## Commits (5125e3e..HEAD)

| Commit | What |
|---|---|
| 1e5d17f | test: screenshot tour of every screen in light / dark / AX-XXXL (the **before** run) |
| 679b7db | test: UI layer v2 behaviour, **RED against stubs** |
| 481ae96 | feat: UI layer v2 behaviour (connection status, stagger, level meter, bubble radii, chat dates, HUD timer, avatar memo, tab badges, router write-back, search memo / own avatar, gone-hit notice) |
| 97d7808 | fix: login shows only the CentyChat lockup (owner request) |
| 5bdf8aa | feat: design tokens and the visual component library |
| 88d7680 | feat: every screen on the design system (UI layer v2, polish pass), previews, component gallery |
| 37712c1 | test/ci: gallery and motion recordings; tour presses bubbles by coordinate |
| 68a6f35 | fix: chat opens at the newest message without a bottom anchor (+ image time on photo, failed-row spacing, letter separators, empty profile rows, cloud outline, real call stage in gallery) |
| 55cd626 | fix: «at the end» from scroll geometry (iOS 18 `onScrollGeometryChange`) instead of a lazy row's appear/disappear — removes the main-loop starvation |
| 4b033ac | test: after the keyboard drag, «↓» returns to the newest message |
| 6c5a75c | test/ci: viewer close retry; motion test results printed in the log |
| ce6351d | fix: image viewer keeps its close button's accessibility identifier; unique motion text |

## CI runs

| Run | Commit | Purpose | Result |
|---|---|---|---|
| 37416025512 | 1e5d17f | **before** screenshots | failed by design of the new tour only (light/dark tour stopped at the message menu: `press` on a non-hittable bubble); 50 screenshots published |
| 37416504068 | 679b7db | **RED** | build ok; unit tests failed with 55 assertion failures in the new tests (log `task-10-red.log`); UI RED: AppLaunch (company caption present), PeopleSearch (tab bar visible in chat) |
| 37419051434 | 37712c1 | first GREEN | build + all unit tests green; UI 20/21 — `UserPathQATests` timed out on an accessibility snapshot when opening the long chat (see «Fix after the first GREEN»); 89 screenshots + 3 motion videos published |
| 37425598743 | 68a6f35 | fix 1 | unit 488 green; UI: AX tour hung after send + list drag (app never idle) — same root cause as above, fixed in 55cd626 |
| 37430277530 | 55cd626 | — | cancelled (superseded by 4b033ac) |
| 37430378254 | 4b033ac | | **green**: unit 488/488, UI 20 passed + 1 skipped (motion test runs separately), release lock ok; 92 files published |
| 37434431290 | 6c5a75c | | **green** (same counts); showed the viewer's close button could not be found (identifier overridden) and the Reduce Motion recording stopping on a duplicate text |
| 37440917565 | ce6351d | final | **green**: unit 488/488, UI 20 + 1 skipped, motion light/dark/reduce passed, release lock ok; 92 files published |

Screenshots: `git fetch origin ci/ios-screenshots` then `git show origin/ci/ios-screenshots:<sha>/<file>`. Before = `1e5d17f/`, after = `ce6351d/` (and `37712c1/` for the first green set). File names: `<TestClass>-<test>--<name>-<light|dark|ax-xxxl>.png`.

## TDD evidence

RED run 37416504068 (stubs returning wrong values, assertions fail — not compile failures). Failing tests, then green from 481ae96 on:

| Behaviour | Test | RED (stub) |
|---|---|---|
| Connection banner machine (problem kind, back-online, grace) | `ConnectionBannerMachineTests` ×7, `ConnectionStatusTests` ×2 | 11 assertions |
| Stagger 6×20 ms / 3×30 ms, none with Reduce Motion | `StaggerTests` ×3 | 4 |
| Peer audio RMS → dB → 5 bars; call store level | `AudioLevelTests` ×3, `CallLevelTests` | 6 |
| Bubble group radii (8 / joined 4 / tail 2 on first) | `BubbleCornersTests` ×2 | 4 |
| Russian day separators and inbox times (cached format styles) | `ChatDatesTests` ×2 | 8 |
| «Скопировано» keeps showing after a second copy | `TransientFlagTests` | 1 |
| Avatar memo sync lookup, inline decoded once, wiped at session end | `AvatarImageMemoTests` ×3 | 2 (+1 compile-free wipe check green only after GREEN wiring) |
| Tab badge = conversations with unread; none on active tab; 99+ | `TabBadgeTests` ×2 | 4 |
| «Написать» from a card opened over the same chat goes back | `NavigationRouterTests` ×2 | 1 |
| Own-DM search hit shows own avatar; author photo for others | `UniversalSearchModelTests.testAHitShowsItsAuthorsPhotoAndOwnDialogHitsShowYours` | 2 |
| Directory ranked once per change, not per `state` read (search) | `testTheDirectoryIsRankedOncePerQueryNotOnEveryRead` | 3 |
| People list built once per change | `PeopleModelTests.testTheListIsBuiltOncePerChangeNotOnEveryRead` | 3 |
| Gone search hit leaves a notice | `ChatJumpTests.testOpeningAtAGoneHitSaysSo` (+ `…AnExistingHitSaysNothing`) | 1 |
| No company caption / no tagline on login | `AppLaunchTests.testFreshInstallShowsLogin` (UI) | 2 |
| Tab bar hidden in a chat; card from the chat header; «Написать» back to that chat | `PeopleSearchUITests.testSearchToCardToChatAndBack` (UI) | 1 (stopped at first) |

Removed with the owner's request: `LoginFlowTests.testCompanyNameIsPlainCappedText` (the sanitiser it tested no longer exists); `CredentialBindingTests.testCompanyNameComesFromTheServer` became `testTheCompanyStaysAsServerData` (asserts `serverInfo.companyName`).

## Ledger items

| Item | Fix | Test / evidence |
|---|---|---|
| OWNER: no company caption on login | `LoginView` lockup = mark + wordmark only; `BrandCopy` sanitiser and `SessionStore.companyName` removed; company kept as `serverInfo.companyName` and shown in Профиль › «Компания» | AppLaunchTests (UI RED→GREEN), tour login asserts absence, CredentialBinding test; screenshot `01-login-*` |
| Incoming bubbles barely visible in light | Chat on the L2 canvas `#fcfcfd`; incoming = `card` + `border` hairline (desktop); own = `primary-soft` + `primary-line` + `accentText` | `05-chat-*`, gallery `40-gallery-1*` |
| Tab bar inside a pushed chat | `.toolbar(.hidden, for: .tabBar)` in the chat | PeopleSearchUITests asserts it hidden |
| «Все» list style | One L1 plane, rows on the list colour (no white bands), compact 28-pt sticky letters, no section spacing, hairlines from the text edge, index kept | `10-people-*` |
| Card from the chat-header avatar | Header (avatar + name + presence) is a button `chat-header-avatar` pushing the card over the chat; `NavigationRouter.open(chat:)` pops back to that chat on «Написать» | NavigationRouterTests, PeopleSearchUITests |
| «Скопировано» hides early | `TransientFlag` cancels the previous timer (card and chat copy) | TransientFlagTests |
| No feedback when a hit is gone | `ChatStore.open(at:)` shows «Сообщение не найдено — возможно, его удалили» (a top notice, not an alert) | ChatJumpTests |
| Highlight weight 600 | `Highlight.text` builds `Text` runs with `.fontWeight(.semibold)` (was bold 700 via stronglyEmphasized) | `12-search-*` |
| Section stagger in search and «Отделы» | `Stagger` + `staggeredAppearance` (search: first 3 items × 30 ms right after the screen appears, none while typing; Отделы: children of the department just opened × 20 ms, cap 6); Reduce Motion → none | StaggerTests; motion videos |
| Own-DM hit shows peer avatar | `MessageHit.avatarName/avatarUrl` = author (self person for «Вы») | UniversalSearch test |
| Re-ranking on every `state` access | Memo keyed on query + directory + channels (search) and on data + filters (people) | two counter tests |
| DateFormatter per row in search | `SearchHitTime` formatters cached per zone+pattern (lock-guarded); chat dates use static `Date.FormatStyle` | existing SearchHitTime tests + ChatDatesTests |
| ConnectionBanner | `ConnectionStatus` (realtime state + `NWPathMonitor` changes, 1.5 s grace, «Снова в сети» 1.2 s) and `ConnectionBanner` (danger/warning/success soft over L3, slides; crossfade with Reduce Motion) on Чаты, chat, Объявления, Профиль | machine/status tests; `19-offline-inbox`, gallery `40-gallery-2-*` |
| Task 8: initials flash before photo | `AvatarImageMemo` (main actor, session-scoped, wiped in `sessionDidEnd`) read synchronously in `AvatarView`; decode off main with `preparingForDisplay` | AvatarImageMemoTests |

## Per screen: before → after (rule applied)

BEFORE = `1e5d17f/`, AFTER = `ce6351d/`.

Rule references: **T** = Tokens, **TY** = Typography, **MG** = Motion grammar, **D** = Depth model, **C#n** = visual component n, **K** = Keyboard, **B** = Buttons, **AI#n** = anti-«AI-generated» rule n, **P** = People surface section, **S** = Screens section.

| Screen | Before (`1e5d17f/…`) | After (`ce6351d/…`) | What changed (rule) |
|---|---|---|---|
| Login | `ScreenshotTourTests-testLoginIn{Light,Dark}Appearance--01-login-*.png`, `…AccessibilityTextSize--01-login-ax-xxxl.png`, `--02-login-error-*` | same names | Company caption under the lockup removed, no tagline (owner request, ruling L). Fields filled `bg-sunken`, outline only while focused (AI#1). «Войти» 50 pt, radius 12, `headline`, disabled at 38 % with a dim label (B). Gutters 16, rhythm 24 (AI#2). |
| Inbox (Личные) | `ScreenshotTourTests-testEveryScreenIn{Light,Dark}Appearance--03-inbox-*`, `…ax-xxxl` | same | L1 plane, borderless rows with hairlines from the text edge (D, AI#1); three type steps — name `headline` strong, preview `subheadline` secondary, time `caption` tabular (TY, AI#3); unread row lifts preview to `textMain` 600 + pill with numeric roll (AI#3, MG4, C#6); presence ring in the surface colour (C#2); «Обновить» button removed — pull-to-refresh (AI#5); segment counters and tab badge count conversations, none on the active tab (AI#6); skeleton rows / illustrated empty state with «Найти сотрудника» / offline retry (C#9, C#10, AI#4); connection banner (C#8); row avatar is the iOS 18 zoom source into the chat (UI v2 continuity). |
| Channels | `--04-channels-*` | same | Slate `#` tile instead of an indigo rounded square (C#2); same row grammar as dialogs. |
| Chat | `--05-chat-*` | same | L2 canvas; incoming bubbles `card` + `border` hairline — visible in light (Task 9 issue); own `primary-soft` + `primary-line` + `accentText` (T, C#4); radius 8, joined 4, 2-pt tail only on the first of a group, gaps 2 / 8 (C#4, AI#2/7); time on the last line when it fits; photo time on the photo; sticky quiet date pill «Сегодня/Вчера/15 сентября» (C#7, AI#7); header avatar + name + presence `textDim` / «печатает…» `accentText`, tap → card (AI#7, P Presentation); tab bar hidden (Task 9 issue); composer on the bar material with a filled field, attach morphs into a 40-pt send circle (K, B, D); opens at the newest message (was at the top). |
| Image viewer | `--06-image-viewer-*` | same | Unchanged viewer; the tile in the chat has a quiet placeholder, fade-in and an upload ring (C#15). |
| Message menu | (light/dark tour stopped here in the before run; AX: not reached) | `--07-message-menu-*` | Native context menu, preview shaped like the bubble (C#12); copy shows the «Скопировано» HUD; swipe-to-reply on the bubble (C#11). |
| Call | `--08-call-ax-xxxl` (call never stayed on screen: the stand's Bob has no socket) | gallery `ScreenshotTourTests-testComponentGallery--40-gallery-4-*` (the real `CallView` with a canned outgoing call) | Dark stage whatever the theme, breathing ring while ringing, level meter from the peer's RMS when active, 64-pt controls with labels, end in `danger-fill`, settings link for the microphone (C#14, S Call). |
| Сотрудники «Все» | `PeopleSearchUITests-testPeopleScreensForReview--10-people-*` and tour `--10-people-*` | same | One L1 plane — no white bands, no large section gaps, compact 28-pt sticky letters without a hairline above, index kept (Task 7 deferred «Все» style, D, AI#1/2). |
| Сотрудники «Отделы» | `--10b-departments-*` | same | 52-pt department rows, children fade in staggered 20 ms (cap 6) only right after opening, none with Reduce Motion (P, Task 7 deferred). |
| Person card | `--11-person-card-*` | same | L1 plane, `HUDCapsule` «Скопировано» that restarts on a second copy (Task 7 deferred); opens over the chat from its header; «Написать» from there returns to the chat (P Presentation). |
| Search | `--12-search-*` | same | Highlights at weight 600 (was 700); own-dialog hits show your avatar next to «Вы»; first three items of each section stagger 30 ms on entry; illustrated empty result with «Очистить поиск» as a link button (P, C#10, Task 7 deferred). |
| Announcements | `--13-announcements-ax-xxxl` | `--13-announcements-*` | Title «Объявления» (was «Распоряжения»); cards are buttons on inset grouped; importance = 6-pt dot + label, never a coloured border; «Требует ознакомления» with a dot and title at 600 (AI#8); filter toggle moved to the toolbar; illustrated empty state (C#10). |
| Announcement detail | `--14-announcement-detail-ax-xxxl` | `--14-announcement-detail-*` | Author line with avatar and date; «Подтверждаю ознакомление» → «Ознакомлен» stamp, the check draws in, success haptic (C#13). |
| Profile | `--15-profile-ax-xxxl`, `--17-profile-bottom-ax-xxxl` | `--15-profile-*`, `--17-profile-bottom-*` | Inset grouped on L1, header avatar 64 with presence, status as three chips with dots (S Profile), «Побудка» row, company kept as data («Компания»), empty values omitted, «Выйти» / «Удалить аккаунт» in the danger text style (B), section headers in sentence case (AI#8). |
| Password change | `--16-change-password-ax-xxxl` | `--16-change-password-*` | Card on the canvas, filled fields, requirements that check off live (S Change password), one primary button, «Отмена» in the bar. |
| Delete account | (not reached before) | `--18-delete-account-*` | L1 background token; danger text instead of the old red. |
| Registration | `ScreenshotTourTests-testRegistrationScreens--30/31/32-*` | same | Inherits the field and button styles (AI#1, B). |
| Offline | `OfflineQueueUITests-…--19-offline-inbox.png`, `--20-offline-queued.png` | same | «Переподключение…» banner under the bar (C#8); queued bubble with the clock glyph (C#3). |
| Components | — | `ScreenshotTourTests-testComponentGallery--40-gallery-{1,1b,2,3,4}-{light,dark,ax-xxxl}.png` | Every delivery state incl. a failed message with «Повторить / Удалить», file tile, reply, typing bubble, jump pill, glyph row (C#3–7, C#15); banners, six spot illustrations, skeletons, pills, HUD (C#8–10); buttons, «Ознакомлен», avatars, importance marker (B, C#2, C#13); the call stage (C#14). |

## Motion recordings (Simulator)

Workflow step «Record the motion walkthrough» runs `ScreenshotTourTests.testMotionWalkthrough` on its own three times — light, dark, and with `com.apple.Accessibility ReduceMotionEnabled` set in the simulator — and publishes `ios-motion-light.mp4`, `ios-motion-dark.mp4`, `ios-motion-reduce.mp4` next to the screenshots (`37712c1/` and ce6351d). The walkthrough covers: inbox → chat (zoom from the row on iOS 18), keyboard open / send (message lands) / interactive dismiss, swipe-to-reply, context menu, card from the header, empty search state, «Отделы» expand/collapse (stagger), tab switches. The whole UI run is also recorded (`ios-ui-video` artifact).
Not recordable on the stand: failed → retry (needs 5 failed HTTP attempts; shown statically in the gallery), send → delivered → read (no REST read endpoint on the server), the banner's «Снова в сети» (the UI-test offline switch is per launch; the cycle is unit-tested and its three states are in the gallery).

## Fixes after the first GREEN

1. Run 37419051434: `UserPathQATests.testUserPathEndToEnd` timed out evaluating an accessibility snapshot right after opening the (by then long) chat. 68a6f35 removed `.defaultScrollAnchor(.bottom)` (scroll to the newest row on appear / first page instead; inserts animate only after the first page; only the jump pill animates).
2. Run 37425598743: the AX tour hung after sending and dragging the list («App event loop idle notification not received»). Root cause: a 1-pt sentinel row at the end of the lazy list set `isAtBottom` from `onAppear`/`onDisappear`; with the keyboard leaving and rows inserting, that lifecycle ping-ponged with the state it set. 55cd626 derives «at the end» from `onScrollGeometryChange` (iOS 18; state changes only when the value changes; iOS 17 counts as at the end, no pill). Green since (37430378254, 37434431290).
3. The «chat opened at the top» seen in the tour screenshots was mostly the tour's own downward drag that closes the keyboard (it scrolls the history up); 4b033ac taps «↓» afterwards, which also exercises the pill.
4. ce6351d: `AttachmentImageViewer` put `.accessibilityIdentifier("image-viewer")` on the whole cover, which replaced the identifier of «Закрыть» (pre-existing; users unaffected, UI tests could not close it) — now a `.contain` container.

## Files changed

Design system: `UI/DesignSystem/CentyColors.swift` (desktop tokens, four planes), `CentyMotion.swift` (new: grammar + Stagger), components `AvatarView` (memo, presence ring, typing pulse, `ChannelAvatar`), `AvatarImageMemo` (new), `DeliveryStatusView` (self-drawing glyph, failed shake + haptic), `MessageBubbleShape` (new), `TypingIndicatorView` (wave + `TypingBubble`), `Pills` (new: Unread, JumpToLatest, DateSeparator), `ConnectionBanner` (new), `Skeleton` (new, shimmer), `EmptyStateView` (new, 6 spot illustrations), `MessageGestures` (new: swipe-to-reply, `AcknowledgeButton`), `CallStageComponents` (new: breathing ring, level meter, 64-pt controls), `CentyButton` (primary/tonal/destructive/link styles), `TransientFlag` (new + HUD), `Highlight`, `StatusBadge`; removed `ListLoadStateView`, `CentyTextField`.
App: `AppContainer` (connection status, avatar memo, wiring), `AppNavigation` (`open(chat:)`, `TabBadge`, `ChatRoute.zoomsFromRow`), `AppRoutes` (zoom chat + card), `MainTabView`, `RootView` (gallery switch), `Preview/PreviewSupport` + `Preview/DesignGalleryView` (Debug only), stores `CallStore` (peerLevel), `ChatStore` (`open(at:)`), `ConversationsStore` (unread conversations), `SessionStore` (company caption gone), `NetworkPathWatcher` (onChange), `LaunchTestFixture` (`-centychat-ui-gallery`).
Features: ChatList (3 files), ChatDetail (`ChatDetailView`, `MessageBubbleView`, new `ChatDates`), People (`PeopleView`, `PeopleModel`, `PersonCardView`, `PersonRowView`), Search (model + view), Announcements, Call (`CallView`, new `AudioLevel`), Profile (`ProfileView`, `AccountSafetyViews`), Auth (`LoginView`, `LoginFormModel`, `ChangePasswordModalView`, `RegistrationFlowView` preview), `Localizable.xcstrings` (+107 keys via `scripts/generate-string-catalog.py`).
Tests: new `UILayerV2Tests.swift`; `UniversalSearchTests`, `PeopleStoreTests`, `ChatJumpTests`, `LoginFlowTests`, `CredentialBindingTests`; UI: `ScreenshotTourTests` (every screen ×3, registration ×3, gallery ×3, motion walkthrough), `AppLaunchTests`, `PeopleSearchUITests`, `OfflineQueueUITests`, `UserPathQATests` (StandAPI photo message, announcement lookup). CI: `.github/workflows/mobile-ios.yml` (timeout 70, motion recordings, mp4 published with screenshots).

## Self-review

- **Swift 6 isolation:** new observable types are `@MainActor` (`ConnectionStatus`, `TransientFlag`, `AvatarImageMemo`); timers are `Task`s on the main actor cancelled on reuse; image decode is `Task.detached` returning `UIImage` (Sendable); the search-time formatter cache is a lock-guarded `@unchecked Sendable` class (DateFormatter formatting is thread-safe); no `nonisolated(unsafe)`.
- **Accessibility:** every icon-only control has a label (call, menu, attach, send, jump pill, filter, header avatar with hint), presence dots hidden, rows read as one element, swipe-to-reply also a named VoiceOver action, notices announced, level meter has label/value, status chips carry `.isSelected`, headers have `.isHeader`.
- **Dynamic Type to AX5:** fonts are text styles only (fixed sizes only for glyphs sized with their containers); person card actions, profile status chips and call controls switch to vertical layouts at accessibility sizes; inbox rows wrap names/previews; AX-XXXL screenshots for every screen.
- **44-pt targets:** toolbar icons, attach/send (44 frame, 40-pt send circle), banner close, link buttons (`CentyLinkButtonStyle` min 44), chips (44 frame).
- **Reduce Motion:** lift → fade, zoom transitions off, stagger off, glyph draw → instant (haptic stays), shake off, breathing ring still, shimmer off, typing dots still, banner crossfades.
- **No production traffic:** previews and gallery use `https://preview.invalid` fakes; UI tests talk to the dev stand only.

## Concerns / not done

- **Before set is incomplete for light/dark** past the image viewer: the new tour's message-menu press failed on a non-hittable bubble in the before run (1e5d17f), so light/dark before shots exist for login, inbox, channels, chat and viewer only; the AX before run (and `PeopleSearchUITests` light/dark/AX) covers people, card, search, announcements, profile, password change. No before shots of the message menu, delete account or the call stage. A second before run was not possible without pushing the old head again.
- **Call stage on the stand** never stays on screen (Bob has no socket, the call ends at once); the after evidence is the real `CallView` in the component gallery with a canned outgoing call (`40-gallery-4-*`).
- **Not recorded as video:** failed → retry (needs 5 failed HTTP attempts), sent → delivered → read (no REST read endpoint), the banner's «Снова в сети» cycle (UI-test offline switch is per launch). Covered by unit tests and gallery stills instead. Videos are not frame-inspected here (no player); no dropped-frame measurement.
- **Jump pill «↓ N новых» needs iOS 18** (`onScrollGeometryChange`); on iOS 17 the list counts as at the end (auto-follow still works; the pill does not show). Chosen over a lifecycle sentinel that starved the main loop.
- **Swipe action «Прочитано» in the inbox** (brief «Inbox») not added: the client has no server-side «mark read» outside an open chat; not inventing one.
- **Spot illustrations / skeleton shimmer** are authored in SwiftUI `Canvas` without design review by a designer; the controller's finish review should look at `40-gallery-2-*`.
- **iPad split view** (`NavigationSplitView` in «Чаты») is compiled and wired but not exercised by any test or screenshot (CI simulator is iPhone 16).
- **Previews** (`#Preview` for every screen and component, Debug only, `PreviewSupport` fakes) compile in CI but were not rendered (no Xcode canvas here).
- **Date pill at AX sizes** grows with Dynamic Type (large «Сегодня» over the list); readable, but may want a cap.
- Removed `LoginFlowTests.testCompanyNameIsPlainCappedText` together with the sanitiser the owner request made obsolete; the absence is now asserted by `AppLaunchTests` and the login tour.

## Fix round 1 (FIX_BASE ce6351d)

**Status:** DONE. Head `a45208d` is pushed to `mobile/ios`.
- CI run **37447449242 is green.** Build passes; unit tests **491/491**. UI tests: **20 passed, 2 skipped** — the iPad check (skipped on iPhone) and the motion walkthrough (runs in its own step).
- The iPad split-view step passed on «iPad Pro 11-inch (M4)». The light, dark and Reduce Motion motion recordings passed. The release lock check passed.
- 93 files were published to `ci/ios-screenshots/a45208d/`.

**RED run:** 37447152566 on b96a976, log in `task-10-fix1-red.log`.
- `UserPathQATests.swift:73` failed with «An opened chat is at its end: no «↓» pill». This reproduces the reviewer's finding on the ce6351d code.
- `ConnectionStatusTests.testEveryShownPhaseIsAnnouncedToVoiceOver` failed: nothing was announced.

**Commits:**
- b96a976 — the RED tests.
- a45208d — the fixes.

| # | Finding | Fix | Test / evidence |
|---|---|---|---|
| 1 | The at-end check ignored the top inset, so the end of a long history never counted as the end. | The check now takes the larger of `visibleRect.maxY` and `contentOffset + container + contentInsets.top`, against `contentSize − 48`. | 3 UI assertions in `UserPathQATests`: no `chat-jump-latest` after opening the long chat, after sending, and after Bob's message arrives (RED→GREEN). New `ChatScrollEndTests` (2). In `a45208d/…--20-offline-queued.png` the queued clock is no longer covered. |
| 2 | The iPad tab bar disappeared for good once a chat was selected. | `ChatDetailView(hidesTabBar:)`, default true: `.toolbar(hidesTabBar ? .hidden : .automatic, for: .tabBar)`. The split-view detail passes false. Pushed chats in regular width (`RoutedChat` reads the size class) keep the tab bar too. | New `testIPadSplitViewKeepsTheTabBar` on an iPad simulator in landscape, asserting the «Сотрудники» tab is present and hittable with a chat selected. Screenshots `a45208d/ScreenshotTourTests-testIPadSplitViewKeepsTheTabBar--50-ipad-split-{light,dark}.png` and `--51-ipad-split-chat-{light,dark}.png`; they are stored rotated, as XCUI captured them in landscape. New workflow step «Run the iPad split-view check». |
| 3 | Following used `store.messages.last` (blocked senders included). | First scroll, follow, «N новых» count, keyboard follow and the search-hit fallback now use `rows.last`. | Covered by the UserPath assertions; delivery and outbox code untouched. |
| 4 | Banner changes were not announced to VoiceOver. | `ConnectionStatus(announce:)` posts `UIAccessibility` announcements «Нет сети / Переподключение… / Снова в сети» once per phase change, from the single app-wide status rather than per banner view. | `testEveryShownPhaseIsAnnouncedToVoiceOver` (RED→GREEN). |
| 5 | `08-call` was byte-identical to the chat screenshot. | The tour captures `08-call-*` only when `call-stage` is on screen; on the stand it never is, so there is no misleading file. | `a45208d/` has no `08-call-*`. The call stage evidence is `40-gallery-4-*` (the real `CallView`). The «Call» row in the per-screen table already points there. |

**Observation for review.** In `51-ipad-split-chat-light` the iPad detail chat shows messages up to 10:38, with empty space below them. The sidebar's newest preview is 10:47 (from the motion recordings). Either the lazy list had not drawn its last rows 2 s after selection, or the first scroll to the end does not take in the detail column. The tab bar part of the finding is verified. This open-at-end question on iPad is not, and nothing tests it.

## Fix round 2 — Stopped 2026-10-06 17:05 (owner stop time)

The working tree is clean; nothing is left uncommitted. Head on `mobile/ios` is **bbd7480**, pushed.

**RED run 37453755106 (7c47540, tests only).** Log: `task-10-fix2-red.log`.
- iPhone: `UserPathQATests.swift:72` failed with «A long chat opens at its newest message, on screen». The bug is reproduced on a45208d.
- `testSigningOutDuringAProblemIsNotAnnouncedAsBackOnline` failed: VoiceOver also heard «Снова в сети».
- iPad: `testIPadSplitViewKeepsTheTabBar` **passed** on a45208d, so the iPad RED was not reproduced in that run.

**Fix run 37453946352 (bbd7480) failed.** bbd7480 is an iOS 18 scroll position pinned to the bottom edge, re-scrolled on every content-height change until the reader drags. It also takes the end check from `visibleRect.maxY` alone and hides the banner on sign-out.
- Passing: unit 492/492; iPhone UI 20 passed (2 skipped by design), including the new «newest message on screen» assertion; motion light, dark and Reduce Motion.
- Failing: the iPad step, `ScreenshotTourTests.swift:258` «A long chat opens at its newest message, on screen».
- No iPad chat screenshot exists, because the capture comes after the assertion.

**Hypothesis.** Either is possible:
- In the iPad detail column (landscape, inside a split view with `.id(selectedChat)`), `position.scrollTo(edge: .bottom)` lands under the composer, or short of the end. Possible causes: the bottom safe-area inset, or the column resizing after the last content-height change.
- `isHittable` fails for an element that sits behind the composer bar.

**Next step.**
1. Capture the iPad screenshot before the assertion and print the newest bubble's frame against the window and composer frames.
2. Add one deferred re-scroll to the bottom edge (about 250 ms after a request, while still pinned).
3. If the edge ignores the bottom inset, scroll to the last row id with `.bottom` anchor through the same `ScrollPosition`.
4. Re-run CI.

## Fix round 3 (FIX_BASE bbd7480)

**Status.** DONE. Head **0124c01** is pushed to `mobile/ios`. CI run **37567132661 is green**:
- unit 492/492; iPhone UI 20 passed, 2 skipped by design (the iPad check runs in its own step; the motion walkthrough too);
- motion light, dark and Reduce Motion pass;
- iPad split-view check passes in both light and dark;
- release lock ok; 94 files published to `ci/ios-screenshots/0124c01/`.

**Was the iPad failure flaky, or did bbd7480 make it worse?**

Run 37563398167 on 3e4a9aa failed. It had the new evidence-first capture, and it answered the question:
- The screenshot `3e4a9aa/…--51-ipad-split-chat-light.png` shows the newest message «iPad последнее light 43613 03:26» on screen, right above the composer.
- The failure was XCUI's «Multiple matching elements»: `app.staticTexts[latest]` matched both the bubble and the **inbox preview in the iPad sidebar**, which shows the same words.

So the iPad assertion was flaky by construction. Whether it passed depended on whether the sidebar preview had updated when the text was queried:
- before the update, it found the bubble (a45208d passed);
- with both present, the lookup errored;
- bbd7480's «not hittable» was most likely the same race. There is no screenshot for that run, so this cannot be proven after the fact.

There was no evidence that bbd7480 made iPad worse.

**Root causes and fixes.**
1. **Test query (the real failure).** The message list is now an identified accessibility container (`chat-messages`). The iPad check and the user path read the newest text inside it: `app.scrollViews["chat-messages"].staticTexts[latest]`. The assertion stays meaningful: that bubble must be hittable 2 s after opening.
2. **Scroll robustness in a split-view column.** This is a fix by reasoning, not a reproduced bug. While pinned to the end, the list re-scrolled only when the content height changed. A detail column can settle its size and insets after the first scroll with the content height unchanged.
   - The pinned re-scroll now follows `EndMetrics`: content height, container width and height, top and bottom insets.
   - It is deterministic, driven by geometry, with no added delays.
   - Offset changes are excluded from the metric's equality, so scrolling by hand never re-scrolls.
3. **Evidence first.** The iPad check captures `51-…` before asserting, and logs `CHAT-GEOMETRY`: the newest bubble, composer and window frames, plus a UI-test-only accessibility probe of the list's scroll geometry (`LaunchTestFixture.exposesScrollProbe`, Debug UI tests only).
   - Run 37567132661, iPad light: `newest=(344,711,215x20) hittable=true composer=(346,768,786x22) window=1210x834 probe=content=2319 container=890x612 insets=104/85 offset=1602 visibleMaxY=2404 pinned=true`.
   - `visibleRect.maxY` = offset + top inset + container + bottom inset. This confirms the round-1 analysis: offset + container alone misses the top inset, and `visibleRect` is the right measure.

**Commits.**
- 3e4a9aa — geometry-driven re-scroll, evidence-first iPad check, probe.
- 0124c01 — list-scoped newest-message query.

**CI.**
- 37563398167 (3e4a9aa): failure — the duplicate-text query; screenshot shows the newest message on screen.
- 37567132661 (0124c01): **success**.

**iPad evidence.** The newest message shows above the composer and the tab bar is visible:
- `0124c01/ScreenshotTourTests-testIPadSplitViewKeepsTheTabBar--51-ipad-split-chat-light.png` («iPad последнее light 47286 04:28»);
- `--51-ipad-split-chat-dark.png`.
