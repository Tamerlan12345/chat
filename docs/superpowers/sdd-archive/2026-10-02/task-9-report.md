# Task 9 report: Android design system, screen polish and motion

**Status: DONE_WITH_CONCERNS.** All these are green:
- 171 unit tests, `lint`, `assembleDebug` and `assembleRelease`;
- `connectedDebugAndroidTest`: 29 tests on `emulator-5554`.

Every screen was captured from real dev-stand data in light, dark and font scale 2.0, plus two medium-width (rail) captures.

Every visual bug from the audit was fixed and verified on the device. All carry items are done. The concerns are listed at the end.

- **Worktree:** `m-android`, branch `mobile/android`. Base `b432420`, head `64a724c`. Nothing was pushed.
- **Scope:** only `mobile/android/**` was edited.
- **Dev-CA trust:** that bullet was already done in Task 12 and was not touched.

## Commits

| SHA | Message |
|---|---|
| 9a3bd8d | feat(android): desktop design tokens, full type scale, DayNight window theme and splash |
| 64646c8 | fix(android): never knock without a stored device secret |
| 7883de5 | fix(android): login predicates, cleared password field and Russian quotes |
| 7bd677b | feat(android): design-system components and the Russian string catalog |
| 71d4164 | feat(android): desktop-style chat with follow-at-bottom and delete confirmation |
| 43a7ac7 | feat(android): inbox with name search, segments, typing previews and pull-to-refresh |
| c61cb0d | feat(android): announcement cards, detail sheet and surfaced errors |
| c4f8f8a | feat(android): grouped profile, dark call screen and live password rules |
| 3a04318 | feat(android): Material navigation suite, shared-axis transitions and snackbars |
| 98608d7 | fix(android): no clipped tab labels or cramped wake row at large font sizes |
| 3cfa54d | fix(android): offline banner on network loss; profile save outcomes; unused resources |
| 64a724c | feat(android): component previews for the design-system library |

The diff since `b432420` is 58+ files, about 4.9k lines added and 2.0k removed.

Only the final state was verified with the full command set. Intermediate commits were not each built on their own. The component commit, for example, relies on the screen commits that follow it.

## Token mapping

All values come from the brief, which matches desktop `theme.css`. Raw values live in `ui/theme/Tokens.kt` (`CentyTokens`). The Material `ColorScheme` is derived from them in `ui/theme/Theme.kt`.

A JVM test (`ThemeTokensTest`) checks the role mapping and WCAG contrast for ten text/fill pairs in both themes.

| Brief token | Light | Dark | Material role / where it is used |
|---|---|---|---|
| canvas (`bg-main`) | `#fcfcfd` | `#24242a` | `background`; chat canvas, login, window and splash background (`values[-night]/colors.xml`) |
| list (`bg-sidebar`) | `#f4f4f7` | `#1e1e24` | `surface`, `surfaceContainer(Low)`; inbox, announcements, profile, top bars, composer |
| frame (`bg-rail`) | `#ececf1` | `#19191e` | `surfaceVariant` (light); bottom navigation bar and rail; dark call screen background |
| card | `#ffffff` | `#2b2b32` | `surfaceContainerLowest` (light); incoming bubbles, cards, search and composer fields |
| elevated | `#ffffff` | `#303038` | `surfaceContainerHigh`; dialogs, menus, bottom sheet |
| text-strong / main / secondary / dim | `#16161d` / `#2b2b34` / `#4a4a55` / `#686874` | `#f4f4f7` / `#dfdfe5` / `#bdbdc7` / `#9898a4` | `onSurface`, `onBackground` = strong; `onSurfaceVariant` = secondary; dim for time, counters and hints |
| border / border-strong | `rgba(24,24,56,.10/.17)` | `rgba(255,255,255,.085/.15)` | Hairlines and bubble outlines; `outlineVariant` is the opaque border on canvas |
| primary | `#5b4ee6` | **`#6457ee`** | `primary`, with white `onPrimary` in **both** themes. This replaces the old dark `#A9A2FF`. |
| primary-soft | `rgba(91,78,230,.10)` | `rgba(150,140,255,.16)` | Own bubble fill, selected row and segment. `primaryContainer` and `secondaryContainer` are this token flattened on canvas (`#ECEBFB` / `#36354C`). |
| primary-line | `.30` | `.40` | Own bubble outline, selected segment outline |
| accent-text | `#4a3dd2` | `#b0a9ff` | Own bubble text, read ticks, links, selected nav item, sender names |
| danger / dangerText / danger-soft / danger-line / danger-fill | `#d9363b` / `#b4232a` / `.08` / `.30` / `#c9302c` | `#e5484d` / `#ff8f8f` / `.14` / `.40` / `#c9302c` | `error`; error boxes, offline banner, delete actions, end/decline call |
| success (+ text, soft, line, fill `#1a7f45`) | `#1f9d61` | `#3fb97a` | «Ознакомлен» success state, accept call, password rules met |
| warning (+ text, soft, line) | `#c98212` | `#e5a13a` | Reconnecting banner, «Срочно» badge |
| online / away / dnd / offline | `#2da44e` / `#d4951c` / `#d9363b` / `#9a9aa6` | `#3fb950` / `#e5a13a` / `#e5484d` / `#7d7d89` | Presence dots only (`StatusDot`) |
| channel avatar | `#475569` | `#3a3a44` | Slate channel avatar |
| radii | 6 / 8 / 12 / 16, plus a 2 dp tail | | `Shapes` (extraSmall 6, small 8, medium 12, large and extraLarge 16) and `CentyRadius`; the bubble tail is 2 dp on the sender's top corner |
| motion | ease-out `(.22,1,.36,1)`, 120 / 180 / 280 ms | | `CentyMotion` (`ui/theme/Motion.kt`) |

Notes on the theme:
- **Typography** (`ui/theme/Type.kt`) is the full Material scale in sp: display, headline, title, body and label, each L/M/S. Tracking is tighter than Material's defaults, like the desktop font. Label styles use tabular digits (`tnum`) for times and counters.
- **No tonal tint:** `surfaceTint` is set to `surface`, so elevation is tone plus hairline, as the brief asks.
- **No dynamic colour:** the brand is pinned to the desktop.
- **XML theme:** `Theme.CentyChat` now has the parent `Theme.Material3.DayNight.NoActionBar`, with the window background from canvas.
- **Splash:** `Theme.CentyChat.Starting` uses the SplashScreen API (`core-splashscreen` 1.2.0) with the brand C mark inset into the safe circle. `installSplashScreen()` runs in `MainActivity`.
- **Removed:** the stale teal `colors.xml` palette.

## Component list (`ui/components`)

Previews for all of these are in `ComponentPreviews.kt`, in light and dark.

| Component | File | Notes |
|---|---|---|
| `CentyAvatar` | Avatar.kt | Ports desktop `lib/avatar.mjs` exactly: the same hash, 8 colours and initials rule, so a person has the same colour on every client (`AvatarPaletteTest` uses values taken from the desktop code with node). Shows a Coil 3 photo over the initials. Images load through `ApiClient.imageHttpClient`, which sends bearer credentials only to the fixed HTTPS server. Only HTTPS URLs load, absolute or server-relative. Supports a channel variant and a presence dot cut out of the background colour. |
| `StatusDot`, `presenceColor`, `presenceLabel` | Avatar.kt | Colour changes fade over 280 ms, like desktop. |
| `EmptyState`, `ErrorState`, `InlineNotice` | StatePanels.kt | Icon tile, a single sentence, and an action; «Повторить» on errors. They scroll at large font sizes. The error state is announced as a live region. |
| `ConnectionBanner`, `linkProblem()`, `rememberNetworkAvailable()` | ConnectionBanner.kt | Warning while reconnecting or refused; danger when offline or the session is gone. A 1.5 s grace period hides the normal connect at launch. It slides down from the top bar. |
| `SkeletonContainer`, `SkeletonBlock`, `ConversationSkeleton`, `ChatSkeleton`, `CardSkeleton` | Skeleton.kt | One shared 1.2 s light sweep. Blocks stay still with reduced motion. |
| `UnreadPill`, `TypingIndicator`, `TypingDots`, `DeliveryGlyph` + `DeliveryMark` | Indicators.kt | `DeliveryMark` has QUEUED, SENT, DELIVERED, READ and FAILED; queued and failed are ready for the Wave 2 outbox. |
| `LocalSnackbarHostState`, `CentySnackbarHost`, `Haptics` / `rememberHaptics` | Feedback.kt | One app-wide snackbar host. Haptics use platform constants: tick, longPress, confirm, reject. |
| `CentyConfirmDialog` | ConfirmationDialog.kt | Destructive variant uses `danger-fill`; test tags are provided. |
| `PriorityBadge` | PriorityBadge.kt | Desktop vocabulary: «Оповещение», «Срочно», «Критично». |

The screens are split into a stateful wrapper and a stateless content composable: `ChatContent`, `ConversationsContent`, `AnnouncementsContent`. Each takes an `*Actions` interface, so Task 17 can reuse them and tests can render them without a server.

## Per-screen before / after

Before captures are in the scratchpad: `before/inbox.png`, `channels.png`, `chat-channel.png`, `chat-channel-empty.png`. After captures are in `build-evidence/task9/`.

### Login
- **Before:** Task 12's branded screen. The dark «Войти» used `#A9A2FF` with dark text. Company quotes were ASCII. The subtitle cut off without an ellipsis.
- **After:** filled `#6457ee` with white text. `АО «Страховая компания «Сентрас Иншуранс»»`, with an ellipsis after two lines. The field outline uses the full `outline` colour, which is at least 3:1. The error box is danger-soft.
- **Behaviour fixes:**
  - one shared submittable predicate;
  - the password field clears when the ViewModel drops it;
  - no knock without a stored device secret.

### Forced password change
- **Before:** a plain dialog that validated only on submit, with English exception text possible.
- **After:**
  - an elevated Material dialog with a show/hide toggle;
  - three rules that tick off live (length ≥ 8, differs from the current password, confirmation matches), each with `stateDescription`;
  - the button is enabled only when all rules hold;
  - a generic Russian error, except the secure-storage message that an existing test requires.

### Inbox
- **Before:**
  - «CentyChat / Сообщения» header;
  - a toggled search with the placeholder «Поиск сообщений»;
  - `TabRow` with counts;
  - a centred spinner while loading;
  - the literal `${channel.membersCount}`;
  - a failed refresh replaced the list with an error.
- **After:**
  - «Чаты» top bar on the list surface;
  - connection banner;
  - a persistent «Поиск по имени» field, filtering by full name or login (`filterByName`);
  - a Material segmented control «Личные / Каналы» with an animated unread pill;
  - 72 dp rows: avatar 44 with presence, name, time (accent when unread), one-line preview with «Вы: » for own messages, or the typing indicator;
  - unread pill;
  - selected row in primary-soft in list-detail mode;
  - pull-to-refresh;
  - skeleton rows;
  - empty and no-results states;
  - error state with retry;
  - a failed refresh keeps the list and shows a snackbar;
  - channel rows show a Russian plural member count.

### Chat
- **Before:**
  - spinner over an empty list;
  - auto-scroll on every message;
  - delete without confirmation;
  - bubble colour guessed with `background.red < 0.5f`;
  - a ⏱ for sent messages;
  - an italic typing row.
- **After:**
  - canvas background and date pills («Сегодня», «Вчера», «2 октября»);
  - grouping (same sender, same day, within 5 minutes; the tail only on the first bubble);
  - own bubbles in primary-soft with a primary-line outline and accent text; incoming bubbles on the card colour with a border;
  - footer with «изменено», time and delivery glyph (✓ sent, ✓✓ delivered, ✓✓ accent read);
  - reply quote with a 2 dp indigo bar, file chip and deleted-message placeholder;
  - a long-press menu (Копировать, Изменить, Удалить) with haptic, TalkBack custom actions and confirmation before delete;
  - header subtitle: live presence or the typing dots;
  - wake cooldown shown as a number;
  - a multi-line composer (up to 6 lines) above the keyboard, with a send button that fills only when there is text;
  - an edit banner;
  - «↓ N новых» pill;
  - skeleton, error with retry, and empty states;
  - connection banner.

  **Not built** (out of scope or no feature): «Ответить» (no reply sending in the data layer), attachments (no upload feature on Android).

### Announcements
- **Before:** a spinner, shadowed `Card`s, an `AlertDialog` for details, and acknowledgement or refresh errors that were swallowed.
- **After:**
  - hairline cards with a priority badge, a «Требует ознакомления» dot or «Ознакомлен» check, title, preview and author · date;
  - pull-to-refresh, skeleton, empty and error states;
  - connection banner;
  - details in a `ModalBottomSheet` with the full text;
  - «Ознакомлен» turns into a success state in place, with a confirm haptic;
  - failures show a snackbar plus a reject haptic, and the sheet stays open for a retry.

### Profile
- **Before:**
  - a centred 96 dp avatar;
  - status chips at 11 sp;
  - a hard-coded fallback company «АО СК «Сентрас Иншуранс»»;
  - «Побудка (Wake Buzzer)» in English;
  - save errors were swallowed.
- **After:**
  - a grouped list: header with a 64 dp avatar, name and job title;
  - «Статус» with Material `FilterChip`s and presence dots, plus the custom status field with save;
  - «Учётная запись» rows (only fields that exist; the fabricated fallback was removed);
  - «Побудка»;
  - «Приложение» with the server host and a brand-mark version row;
  - «Выйти» in danger with a confirmation;
  - snackbars for save success or failure;
  - an inline notice for storage errors.

### Call
- **Before:** used the theme surface (light in light mode), raw `Color(0xFF2E7D32)`, and no labels.
- **After:**
  - dark in both themes (`CentyChatTheme(darkTheme = true)`), with light system-bar icons while open;
  - a 120 dp avatar with a breathing ring while ringing;
  - name and state with a tabular timer;
  - 64 dp round controls with labels: decline and end in danger-fill, accept in success-fill, toggles with `stateDescription`;
  - when the microphone is denied, a notice with «Открыть настройки».

### Navigation
- Tabs read «Чаты / Объявления / Профиль», with outlined and filled icons.
- Bars and rail use the frame colour, with a primary-soft indicator and accent selection.
- Navigation 3 uses a shared-axis X transition (forward, back and predictive back).
- One snackbar host is placed above the bottom bar, and above the composer in chat.
- Bottom insets are consumed under the bar.
- At fontScale 2.0, tab labels shrink to fit (`TextAutoSize`) instead of clipping.

### App-wide
- Toast became Snackbar for both the wake ring («Вас зовёт …», with vibration) and the server disconnect reason.

## Motion inventory

Desktop curve: `EaseOut = cubic-bezier(.22,1,.36,1)`. "Reduce" means the system "Remove animations" setting, `ANIMATOR_DURATION_SCALE == 0`. It is read live through a `ContentObserver` into `LocalReduceMotion`.

| # | Effect | Spec | Reduce-motion fallback |
|---|---|---|---|
| 1 | Navigation | Shared-axis X: slide 1/12 of the width, 280 ms ease-out, fade-in 180 ms after a 60 ms delay, fade-out 120 ms; predictive back uses the pop spec | 120 ms crossfade |
| 2 | Send bubble entrance | Own bubble: alpha 0→1, 14 dp rise, scale 0.96→1 from the bottom-end corner, 220 ms ease-out. Only messages that arrive after the first render animate (history stays still). `animateItem()` with stable keys (`msg-<id>`, `day-<date>`) handles placement (180 ms) and fade-out (120 ms). | Fade only, 120 ms; no placement animation |
| 2b | Delivery glyph | `AnimatedContent` crossfade, 120 ms | Same (a crossfade is the fallback) |
| 2c | Send button | Container transparent→primary and icon dim→white, 180 ms; scale 0.92→1 | Colour only |
| 3 | Incoming insert | Alpha plus an 8 dp rise, 260 ms. The list follows only when at the bottom; otherwise the «↓ N новых» pill rises 1/3 of its height with a fade (180 ms in, 120 ms out). | Fade only; instant scroll |
| 4 | Unread pill | Appears with scale 0.6→1 plus fade (180 ms), disappears in 120 ms. The number rolls up or down with a clipped slide. | 120 ms fades |
| 5 | Typing dots | Three dots, alpha 0.25→1→0.25 over a 1.2 s cycle with 0.2 s stagger (desktop `typing-blink`). Shown in the chat header and inbox rows. | Static dots |
| 6 | Connection banner | Expands from the top with a fade (280 ms), collapses in 180 ms; colour crossfades between warning and danger | 120 ms fade |
| 7 | Skeleton shimmer | Linear sweep, 1.2 s, restarting | Static blocks |
| 8 | Press feedback and haptics | Material ripple on rows, cards and buttons; primary-soft selected row. Haptics: tick on send, long-press on the message menu, confirm on «Ознакомлен» and on wake, reject on a failed acknowledgement or status save. | Haptics stay |
| 9 | Call breathing ring | Scale 1→1.08, 1.6 s, reverse repeat, only while ringing (the loop is removed once the call connects); ring colour fades in and out over 280 ms | Static ring |
| — | Login mark intro (from Task 12), presence dot colour (280 ms), «Ознакомлен» success swap (fade plus scale 0.96, 180 ms), header subtitle crossfade, password rules colour (180 ms) | | Intro off; others 120 ms or instant |

### Smoothness (emulator evidence only)

Measured with `dumpsys gfxinfo` on the **debug** build, `Pixel_8` AVD, with GLES through the host Intel UHD 770 translator. The run covered 8 fling scrolls in a 30-message chat plus segment switches:
- 280 frames;
- p50 31 ms, p90 53 ms, p95 69 ms, p99 113 ms;
- 21% janky.

This is not representative: it is a debug build (no R8, no baseline profile) on an emulator GPU. Visually the animations played smoothly on the emulator, but 60/120 fps needs a check of the release build on hardware.

## Bug fixes and their tests

TDD: each test was written first and failed for the stated reason before the fix. Behavioural RED runs used stub APIs that kept the old behaviour.

| Bug / carry item | Fix | Test (RED → GREEN) |
|---|---|---|
| Knock sent a null device secret (pending device labelled Windows, admin broadcast, knock-fail budget) | `DefaultAuthRepository.knock()` returns false with no request when no secret is stored, and sends the stored secret otherwise | `AuthRepositoryKnockTest` (2): RED showed `"device_secret":null` sent in both cases |
| A whitespace-only password enabled «Войти» | One predicate, `LoginViewModel.hasCredentials`, used by the button and the submit guard | `LoginViewModelTest.aWhitespaceOnlyPasswordDoesNotEnableSignIn`: RED "share one predicate" |
| The local password stayed in the field after `MUST_CHANGE_PASSWORD` | The screen collects `viewModel.password` and clears its local state | `LoginScreenTest.aForcedPasswordChangeClearsThePasswordFieldOnScreen` (device): RED timeout, then GREEN |
| ASCII quotes in `company_name` | `typographicQuotes()` (open, close and nested balancing) in `CompanyName.sanitize`; `maxLines = 2` with an ellipsis; also used for the profile company | `LoginTextTest.asciiQuotesInTheCompanyNameBecomeRussianQuotes`: RED `"Ромашка"` |
| `reducers/` skip was implicit | `ContractFixturesTest` walks every directory; `reducers/` is a one-line commented exclusion | Existing suite green |
| Forced auto-scroll on every message | `FollowPolicy` (follow only at the bottom or on an own send; otherwise count unseen messages) plus the «↓ N новых» pill | `ChatPresentationTest` (5, RED 4/5 against a stub); device tests `ChatContentTest.aNewIncomingMessageWhileScrolledUpShowsAPillInsteadOfJumping` and `aNewMessageAtTheBottomIsFollowed`; also verified live with 16 messages from bob over WS |
| No delete confirmation | `CentyConfirmDialog` before `onDelete` | `ChatContentTest.deletingAMessageAsksForConfirmationFirst` (cancel deletes nothing; confirm deletes once) |
| Literal `${channel.membersCount}` | `plurals/channel_members` | `ConversationsContentTest.aChannelWithoutMessagesShowsItsMemberCountInRussian` |
| Misleading search placeholder | «Поиск по имени», with the filter by name only | `ConversationsViewModelStatesTest.searchMatchesNamesOnly` (RED); `ConversationsContentTest.theSearchFieldSaysItSearchesByName` |
| A failed inbox refresh replaced the list | Content is kept and `RefreshFailed` goes to a snackbar | `ConversationsViewModelStatesTest.aFailedRefreshKeepsTheListAndSaysSo` (RED) |
| No typing in the inbox | `typing` set with a 3 s expiry; own typing ignored | `typingShowsInTheRowForThreeSeconds`, `ownTypingInAChannelIsNotShown` (RED) |
| Announcement errors swallowed | `AnnouncementsEvent` (RefreshFailed, Acknowledged, AcknowledgeFailed) | `AnnouncementsViewModelTest` (3, RED: no events) |
| Profile status save errors swallowed | `ProfileEvent` | `ProfileViewModelEventsTest` (2; written after the code, not RED-first) |
| Toast | Snackbar host | Verified on the device |
| `ChatScreen` loading and error states | Skeleton and `ErrorState` | `ChatContentTest.loadingShowsASkeletonNotASpinner`, `anErrorOffersRetry` (raw exception text is never shown), `anEmptyChatSaysSo` |
| Connection banner | `ConnectionBanner` | `ChatContentTest.theConnectionBannerShowsOnlyWhileTheLinkIsDown`, `noBannerWhileConnected`; `ConversationsContentTest.theBannerAppearsWhileReconnecting`. Airplane mode on the device showed «Нет подключения к интернету» (danger) after a fix: the first device run showed "reconnecting" because a lost default network was not treated as offline. |
| `background.red < 0.5f` bubble hack | Tokens | `ThemeTokensTest` (written with the theme) |
| Dark primary `#A9A2FF` | `#6457ee` with white text | `ThemeTokensTest.filledButtonsUseTheBriefPrimaryWithWhiteTextInBothThemes` |
| Stale teal `colors.xml`; XML theme not DayNight (white flash); no SplashScreen | DayNight theme, canvas window colour, SplashScreen API | Verified on the device |
| Inbox loading spinner, empty and error | Skeleton, empty and error components | `ConversationsContentTest.loadingShowsSkeletonRows`, `anEmptyInboxSaysSo`, `anErrorIsNotABlankListAndRetries` |

`MainNavigationTest` and `LoginScreenTest` were updated for the new copy: «Чаты» tab, «Поиск по имени», «Учётная запись», logout through the dialog's confirm tag.

## Command outputs

Run from `mobile/android` with `JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1`, `GRADLE_USER_HOME=/c/tmp/gradle-user-home` and `--project-cache-dir /c/tmp/m-android-project-cache`:

```
./gradlew.bat testDebugUnitTest lint assembleDebug assembleRelease connectedDebugAndroidTest
Running tests on devices: Pixel_8(AVD) - 17
Wrote HTML report to .../app/reports/lint-results-debug.html
BUILD SUCCESSFUL in 2m 17s
149 actionable tasks: 49 executed, 100 up-to-date
```

| Result | Value |
|---|---|
| Unit tests (JUnit XML) | 171, 0 failures |
| Instrumented tests (`TEST-Pixel_8(AVD) - 17.xml`) | 29, 0 failures |
| Release APK | `app-release-unsigned.apk`, 4.58 MB |
| Lint | 0 errors |

Lint warnings, all pre-existing or informational:

| Warning | Count / note |
|---|---|
| GradleDependency | 11 |
| NewerVersionAvailable | 4 |
| UseKtx | 3 |
| ConstantLocale | 2, in `DateTimeUtils` |
| OldTargetApi | 1 |
| ObsoleteSdkInt | 1, `mipmap-anydpi-v26` |
| UnusedResources | 1, `ic_launcher_round` |
| NotShrinkingResources | 1 |
| UseTomlInstead | 1 |

## Screenshots (`mobile/android/build-evidence/task9/`)

This folder is git-ignored, as before. These are emulator captures (`adb exec-out screencap`, `emulator-5554`, Pixel 8, 1080×2400) of the debug build against the HTTPS dev stand. The stand ran as `SERVER_PORT=2014 node mobile/dev/stand.mjs`. The owner's `:2004` server was not touched.

I opened every PNG once through contact sheets and each shows what its name claims. One full pass was redone as the allowed confirmation pass: the first light pass picked up a stray keystroke and drifted, and the first font2 pass drifted the same way.

For each mode (`-light`, `-dark`, `-font2`):

| File | Shows |
|---|---|
| `01-login` | Login |
| `02-login-error` | «Неверный логин или пароль» |
| `03-inbox-direct` | Inbox, «Личные» |
| `04-inbox-channels` | Inbox, «Каналы» |
| `05-chat-direct` | Chat with Боб Тестов |
| `06-chat-menu` | Long-press menu |
| `07-chat-delete-confirm` | Delete dialog |
| `08-chat-channel` | `#mobile-dev` with a file chip and sender name |
| `09-announcements` | Urgent unread card plus an acknowledged card |
| `10-announcement-sheet` | Detail sheet with «Ознакомлен» |
| `11-profile` | Profile, top |
| `12-profile-bottom` | Profile, bottom (app info, «Выйти») |
| `13-inbox-offline-banner` | Airplane mode, danger banner |
| `14-call-incoming` | Incoming call from bob, real `call_offer` over WS |

Extras:
- `15-rail-inbox-medium-light.png`, `16-rail-chat-medium-light.png`: navigation rail plus a single pane at `wm size 1840x2400` (≈700 dp, medium width), then restored with `wm size reset`.
- `17-chat-remove-animations-light.png`, `18-chat-remove-animations-after-light.png`: `animator_duration_scale 0` while bob types and sends. The dots are static and the message is followed instantly.

Device state was restored afterwards:
- `font_scale 1.0`;
- `uimode night no`;
- physical size 1080x2400;
- `animator_duration_scale` deleted (it was unset before);
- airplane mode off.

Live checks on the stand: typing and presence going green in the chat header; follow at the bottom and the «2 новых» pill with bob's WS burst; send from the composer; ✓ → ✓✓ when bob came online; acknowledging an announcement.

## Overlap with Task 17 (UI layer v2)

- **Already built (basic forms only), do not redo:**
  - the long-press message menu: a Material `DropdownMenu` with haptic and TalkBack custom actions, which existed before in plainer form;
  - the `DeliveryGlyph` crossfade (no stroke-draw);
  - the own-bubble lift (fade, rise, scale; no shared element);
  - the composer moves with the IME through `windowInsetsPadding(navigationBars ∪ ime)`. This is not the frame-synchronised `imeNestedScroll` / `reverseLayout` choreography.
- **Not built:** shared-element inbox → chat, swipe-to-reply, spot illustrations, glyph stroke-draw, and the call level meter (`CallAudio` exposes no RMS).

## Concerns

1. **Smoothness is unproven on hardware.** See the emulator numbers above. A release build on a real device (plus a baseline profile) is needed before claiming 60/120 fps.
2. **Avatar colour is hashed from the name, not the user id** as the brief says. This deliberately matches desktop `lib/avatar.mjs` so the same person has the same colour on desktop and Android. iOS should use the same algorithm.
3. **Features in the brief that have no backing feature on Android yet were left out rather than faked:**
   - inbox FAB / «Начать чат» and the new-chat sheet (there is no user directory screen; the empty inbox offers «Обновить»);
   - «Ответить» in the message menu (`sendMessage` has no reply id);
   - the attach button;
   - «Сменить пароль» in the profile (the change can revoke tokens, so it needs a deliberate flow);
   - the swipe action «Прочитано»;
   - the call level meter.
4. **Some text is still raw or partly English:**
   - ViewModel error strings remain in the VMs, but screens no longer show them: they map states to `strings.xml`.
   - The secure-storage message is still the exception's English text. An existing test pins it, and it is shown in the change-password dialog.
   - `rejectCall("Доступ к микрофону отклонен")` and `rejectBusy` send Russian literals to the server as reasons. They are not UI.
5. **Snackbar «Сигнал побудки отправлен» is shown optimistically** when wake is sent. A later `wake_error` is not surfaced; the existing VM ignores it.
6. **Coil version:** pinned to 3.3.0, because 3.6.x requires `compileSdk` 37.
7. **New dependencies:** `com.google.android.material:material` 1.14.0 (for the XML DayNight parent) and `core-splashscreen` 1.2.0.
8. **The capture script is flaky with adb `input`.** It is in the scratchpad (`capture.sh`), not committed. `build-evidence/` is git-ignored, so the controller reviews the PNGs on disk.
9. **Pre-existing lint warnings remain:**
   - `ConstantLocale` in `DateTimeUtils` (the time format is fixed at class load);
   - `ic_launcher_round` is unused.
10. **Leftover state:**
    - the dev stand data in `mobile/dev/data` (git-ignored) now holds bob's test messages and one more announcement, «Плановые работы…», created as admin;
    - the stand process was stopped at the end;
    - the emulator `emulator-5554` was restarted once during the task (it had disappeared) and is still running.

---

# Fix round 1

**Status: DONE.** Both Important contrast failures and all the listed Minors are fixed. Everything is green: 172 unit tests; `lint`, `assembleDebug` and `assembleRelease` succeed; `connectedDebugAndroidTest` passes 30 tests on `emulator-5554`. Dark and font2 screenshots were recaptured. Head is now `b0a4dc0`, not pushed.

## Commits

| SHA | Message |
|---|---|
| d90bc73 | fix(android): keep the chat draft, anchor snackbars to the composer, own-bubble meta contrast |
| a704cbf | fix(android): brand foreground in accent text, nav indicator, a11y and reduce motion |
| b0a4dc0 | fix(android): anchor the message menu to the bubble |

## Important fixes

1. **`primary` is now a fill colour only.** Every foreground use of the brand switched to `accentText` (`#4a3dd2` light, `#b0a9ff` dark). The change is central, in the new `ui/components/Controls.kt`:
   - `CentyTextButton` and `CentyOutlinedButton` (with a `borderStrong` hairline) replace the Material defaults in:
     - `ConfirmationDialog`;
     - `StatePanels` (`EmptyState` action, `InlineNotice`);
     - `ChangePasswordDialog`;
     - the call screen («Закрыть», «Открыть настройки»).
   - `centyFieldColors()` is the one shared text-field colour set: focused border, label and cursor in accent text, on the card container. It replaces the duplicated `fieldColors()` in Login, Profile and ChangePasswordDialog.
   - The composer and search cursors, the pull-to-refresh indicator and the profile progress indicator also use accent text.
   - Text selection colours are set to accent text in `CentyChatTheme`.
   - `ThemeTokensTest` now checks, in light and dark, accent text on elevated, card, list, canvas and frame (the call screen), and the selected nav item on its indicator. All are at least 4.5:1.
2. **Own-bubble footer** (time, «изменено», delivery glyph): `textDim` became `textSecondary`. In dark it was 4.17:1 and now passes 4.5:1. `ThemeTokensTest` checks "time in own bubble" (`textSecondary` on primary-soft over canvas) in both themes.

## Minors

| Item | Fix | Proof |
|---|---|---|
| The draft was wiped on re-entry | The composer saves the edited id (`rememberSaveable`) and replaces the text only when the edited message really changes | `ChatContentTest.aTypedDraftSurvivesLeavingAndComingBack` (`StateRestorationTester`): RED showed `EditableText = ''`, now GREEN |
| Double long-press haptic; no-op TalkBack click | Removed the manual haptic, since `combinedClickable` does it. A tap opens the same menu, with `onClickLabel` «Действия с сообщением». | The existing delete-confirmation test still passes |
| Light nav indicator at 1.00:1 | New `navIndicator` token: light `#D2D0EF` (primary-soft .18 on frame), dark `#36354C` | `ThemeTokensTest.theSelectedNavigationPillStandsOffTheBar` (at least 1.2:1 tone step); visible in the font2 captures |
| fontScale 2.0 clipping | The profile value has no `maxLines` and wraps, end-aligned; the announcement author · date line wraps | `12-profile-bottom-font2`, `09-announcements-font2` |
| Reduce motion | Inbox and announcement `animateItem()` skip placement when reduced. `TypingDots` and the call `BreathingAvatar` read the animated `State` inside `graphicsLayer {}`, without recomposition. | — |
| Hard-coded 72 dp snackbar offset | `SnackbarAnchor` (`LocalSnackbarAnchor`): the composer reports its measured height (`onSizeChanged`, reset on dispose), and the host pads by it above the IME and nav-bar insets | — |
| Strings | `file_size_bytes`, `file_size_kb` and `file_size_mb` («Б», «КБ», «МБ»); `password_error_failed` (the VMs pass `PASSWORD_CHANGE_GENERIC_ERROR`, and the dialog shows the string); `profile_version_value` «Версия %1$s» | — |
| Call-screen a11y | Each control's whole column is one target, with ripple only on the circle. The icon has no description, so the visible label is the name, read once. Mute and speaker use `toggleable` with `Role.Switch` and a spoken `stateDescription`. | — |
| Dark channel avatar | `#2b2b2b`, matching desktop | `ThemeTokensTest`: white on it is at least 4.5:1 |
| Message menu anchoring (found during recapture) | For own messages the menu opened from the row box; it now anchors to the bubble | `06-chat-menu-dark`, `06-chat-menu-font2` |

The omitted features stay out, as ruled: «Ответить», attach and failed «Повторить / Удалить» go to Task 15; the new-chat FAB, «Сменить пароль» and the call level meter go to a later task.

## Recaptured screenshots (`build-evidence/task9/`)

These are emulator captures against the dev stand (`SERVER_PORT=2014`):
- the full dark pass (`01`–`14-*-dark.png`);
- the full font2 pass (`01`–`14-*-font2.png`), which also shows the new light nav indicator.

`06-chat-menu-*` and `07-chat-delete-confirm-*` were captured again on a fresh own message. The original one is now past the 60-minute delete window, so its menu correctly shows only «Копировать».

Checked on the images:
- «Отмена» and the outlined actions are lilac accent in dark;
- the own-bubble time is lighter;
- the profile company wraps to four lines at font2;
- the announcement dates are visible.

Device state was restored: `font_scale 1.0`, night mode off. The stand was stopped.

## Command output

```
./gradlew.bat testDebugUnitTest lint assembleDebug assembleRelease connectedDebugAndroidTest
Running tests on devices: Pixel_8(AVD) - 17
BUILD SUCCESSFUL in 1m 47s
149 actionable tasks: 36 executed, 113 up-to-date
```

| Result | Value |
|---|---|
| JUnit XML (unit + instrumented) | 202 testcases, 0 failures |
| Instrumented (`TEST-Pixel_8(AVD) - 17.xml`) | 30 tests |
