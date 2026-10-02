# CentyChat Mobile — design brief (iOS + Android)

Produced with the impeccable skill (init → shape) on 2026-10-02. Product truth: `PRODUCT.md`. Visual authority: the desktop app (`desktop/src/renderer/src/styles/theme.css`, `components/BrandMark.jsx`, `components/Avatar.jsx`, `components/ChatView.jsx`). Mode: **Operate**. Platform: **adaptive** — one identity, native grammar per OS.

The world is pinned by the owner ("совпадать с десктопом"), so there is no concept roll: mobile *inherits* the desktop world and translates it into each platform's native components. Owner's explicit asks: closer to desktop, smoother, better motion.

## Direction contract

- **THESIS** — "Desktop graphite, pocket-sized." One calm graphite canvas, one indigo accent, the gradient "C" mark only where the brand speaks. Refuses the category default of a colourful consumer messenger (WhatsApp-green bubbles, emoji-forward chrome, gradient backgrounds).
- **OWN-WORLD** — Cool graphite neutrals in three depths (frame → list → canvas), indigo `primary` used only for action, selection, focus and own-message tint; status colours only as small dots; hairline borders instead of shadows; 8-pt radius family; text in neutral greys with ≥4.5:1 contrast. Recognisable with content removed: a quiet grey stack with a single indigo signal.
- **STORY** — An employee away from the desk opens the app, instantly sees who wrote and what's unread, answers in two taps, and trusts every message's state (queued / sent / delivered / read / failed) without thinking about it.
- **FIRST VIEWPORT** — Inbox: large title «Чаты» (iOS) / top app bar (Android), compact connection banner only when not connected, segmented «Личные / Каналы», rows of 64–72pt/dp: avatar 44 with presence dot, name (headline weight), one-line preview (secondary), time (dim, top-right), unread pill in `primary` (bottom-right). Primary action "new chat" in the nav bar (iOS) / FAB (Android).
- **FORM** — Native list-detail messenger (position 1; no seed key — world pinned by brief, concept roll intentionally skipped).
- **FINISH** — unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Tokens (identical values on both platforms)

| Token | Light | Dark | Use |
|---|---|---|---|
| canvas (`bg-main`) | `#fcfcfd` | `#24242a` | chat background, forms |
| list (`bg-sidebar`) | `#f4f4f7` | `#1e1e24` | inbox / grouped lists background |
| frame (`bg-rail`) | `#ececf1` | `#19191e` | tab bar / nav bar material tint |
| card / incoming bubble | `#ffffff` | `#2b2b32` | |
| elevated (sheets, menus) | `#ffffff` | `#303038` | |
| text-strong | `#16161d` | `#f4f4f7` | names, titles |
| text-main | `#2b2b34` | `#dfdfe5` | body |
| text-secondary | `#4a4a55` | `#bdbdc7` | previews |
| text-dim | `#686874` | `#9898a4` | time, counters |
| border | `rgba(24,24,56,.10)` | `rgba(255,255,255,.085)` | hairlines, bubble outline |
| primary | `#5b4ee6` | `#6457ee` | buttons, unread pill, selection |
| primary-soft | `rgba(91,78,230,.10)` | `rgba(150,140,255,.16)` | own bubble fill, selected row |
| primary-line | `rgba(91,78,230,.30)` | `rgba(150,140,255,.40)` | own bubble outline |
| accent-text | `#4a3dd2` | `#b0a9ff` | own bubble text, links |
| danger / success / warning | `#d9363b` / `#1f9d61` / `#c98212` | `#e5484d` / `#3fb97a` / `#e5a13a` | errors, ok, warnings |
| online / away / dnd / offline | `#2da44e` / `#d4951c` / `#d9363b` / `#9a9aa6` | `#3fb950` / `#e5a13a` / `#e5484d` / `#7d7d89` | presence dots only |
| brand gradient | `#ec8ee0 → #c078ee → #7c44ea → #2a72ee → #00daff` (135°) | same | **only** the C mark (launch, onboarding, about) |

Spacing 4/8/12/16/20/24/32. Radii: 6 (chips), 8 (bubbles, fields, buttons), 12 (cards, sheets content), 16 (large surfaces), pill (unread, status chips). Bubble "tail": the corner nearest the sender is 2 (top-right for own, top-left for incoming) — the desktop signature. Elevation by tone + hairline, not drop shadows.

Avatar colour: deterministic from user id (stable hash → one of 8 desaturated hues tuned to pass 4.5:1 with white initials); channels use slate (`#475569` / `#2b2b2b`).

## Typography

- iOS: SF via Dynamic Type text styles only. Mapping: screen title `.largeTitle`; row name `.headline`; preview `.subheadline` secondary; time/counters `.caption` (dim, monospaced digits); bubble body `.body`; sender name in channels `.footnote.weight(.semibold)` accent-text.
- Android: Roboto via Material type scale (sp). Row name `titleMedium`; preview `bodyMedium`; time `labelSmall`; bubble `bodyLarge`; screen title `titleLarge`/`headlineSmall` in large top bar.
- Tabular digits for times and counters on both.

## Motion grammar (the owner's "smoother")

One grammar, platform-native curves. Desktop reference: `ease-out cubic-bezier(.22,1,.36,1)`, fast 120 ms / base 180 ms / slow 280 ms.

1. **Navigation** stays system: iOS push/sheet, Android Navigation 3 shared-axis X (forward/back) and predictive back. Never custom-replace.
2. **Message send**: the composer text lifts into a new own bubble that grows from the composer (iOS `matchedGeometryEffect`-style or spring scale 0.96→1 + fade, 220 ms; Android `animateItem()` + scale/fade). State glyph crossfades queued ⏱ → sent ✓ → delivered ✓✓ → read ✓✓ (accent) with 120 ms.
3. **Incoming message**: inserts with fade + 8-pt rise, list keeps position if the user is scrolled up and shows a "↓ N новых" pill instead of jumping.
4. **Unread pill**: number changes with numeric text transition (iOS `.contentTransition(.numericText())`, Android `AnimatedContent` slide-up); pill appears/disappears with scale 0.6→1.
5. **Typing indicator**: three-dot wave (desktop `typing-dots`, 0.2 s stagger) in the chat header subtitle and inbox preview.
6. **Connection banner**: slides down from under the nav bar, colour-coded (warning while reconnecting, danger when offline), collapses when connected.
7. **Loading**: skeleton rows with a slow shimmer (1.2 s) — never a centred spinner for lists; pull-to-refresh native.
8. **Press feedback**: rows highlight with `primary-soft`; buttons scale 0.97 on press (iOS) / Material ripple (Android). Haptics: light impact on send, success notification on "Ознакомлен", warning on failed send.
9. **Calls**: incoming-call screen has a breathing ring around the avatar (scale 1→1.08, 1.6 s); active call shows a live level meter from audio RMS.
10. **Reduce Motion / Remove animations**: every effect above degrades to a 120 ms crossfade or instant change.

Performance: 60/120 fps; list items stable keys (message id / client_msg_id), no layout thrash on insert; images decoded off main thread.

## Screens

- **Server setup** — removed (owner, 2026-10-02): the production server is fixed at build time; first launch opens Login.
- **Login** — the app's front door and the strongest brand moment. Gradient C mark (72) with «CentyChat» lockup, company name from `/api/settings/info` underneath (fallback «Корпоративный мессенджер»), then one card: login, password (show/hide), primary «Войти» full width, disabled until both fields are filled, in-button progress. No server field, no «Сменить сервер». Errors in a danger-soft box like desktop `.login-error-box`; throttling shows a countdown. Content sits in the upper third and stays above the keyboard; no nav-bar title duplicating the lockup (current Android shows «Вход в CentyChat» + «Корпоративный мессенджер» — remove). Motion: the mark fades/scales in once on first appearance (Reduce Motion → none); fields and button crossfade into the "signing in" state.
- **Change password (forced)** — sheet/screen with policy hints that check off live.
- **Inbox** — see FIRST VIEWPORT. Swipe actions: mark read, mute (if supported), delete-for-me not applicable → only "Прочитано". Search field filters by name (placeholder «Поиск по имени»). Empty: «Пока нет диалогов» + «Начать чат». Error: inline retry row, not a blank list.
- **New chat / channel** — sheet with searchable people list (avatar, name, department), channel creation form gated by permission.
- **Chat** — canvas background; date separators as small centered pills; grouped consecutive bubbles from the same sender (2-pt gap, tail only on first); own bubbles right with `primary-soft` fill + `primary-line` outline + `accent-text`; incoming `card` + `border`; time + state inside bubble footer (dim, caption). Reply quote inside bubble with a 2-pt indigo bar. Long-press context menu: Ответить, Копировать, Изменить, Удалить (with confirmation, window-limited). Composer: multi-line (max 6 lines), attach (44/48 target), send button appears filled `primary` only when text present (animated). Failed message: red ⚠ with «Повторить / Удалить».
- **Announcements** — list of cards with importance marker, unread dot, «Ознакомлен» status; detail with full text and a primary «Ознакомлен» button that turns into a success state with haptic.
- **Call** — dark full-screen regardless of theme (desktop does the same for call panels): large avatar, name, state text, timer; bottom controls 64-pt circular (mute, speaker, end in `danger-fill`); permission-denied state with «Открыть настройки».
- **Profile** — grouped list: header with avatar + name + status picker (online/away/DND chips with dots), custom status; «Побудка», «Сменить пароль», «Сервер», «О приложении» (C mark, version), «Выйти» in danger.

## States every screen must design

loading (skeleton), empty (icon + one sentence + action), error (message + «Повторить»), offline (banner + cached content), permission denied (explanation + settings link), long content (names 40+ chars truncate middle-safe, previews 1 line, bubbles wrap), large text (AX5 / fontScale 2.0 — rows grow, nothing clipped, primary actions reachable).

## Anti-goals

- No gradient backgrounds, glassmorphism, neon, or brand gradient outside the C mark.
- No custom navigation bars, custom back gestures, iOS-styled controls on Android or vice versa.
- No centred spinners on lists, no Toasts on Android, no alerts for non-blocking errors.
- No hard-coded font sizes; no raw hex in views (tokens only).
- No English strings.

## Verification

- iOS: `ScreenshotTourTests` in CI capture every screen light/dark + accessibility size (Simulator evidence; say so).
- Android: `adb exec-out screencap` on `emulator-5554` light/dark + `font_scale 2.0` (emulator evidence; say so).
- Native platforms skip the impeccable web detector; the finish review checks against this brief, `ios.md` and `android.md` platform references.
- After both platforms pass, document the built system in `DESIGN.md` (documenter step).

---

# UI layer v2 — transitions, keyboard, depth, visual components (owner request 2026-10-02)

Owner: «полностью улучши UI слой — переходы, открытие клавиатуры, наслоенность; добавь визуалы и компоненты; удобство и лучшая работа системы». Produced with impeccable `animate` + `delight` + `layout` (Operate mode, native platforms: system motion first, brand in the open layer).

## Motion thesis

- **Focal moment (authored, product-specific): "the message lands".** Principle #1 is *never lose a message*, so the one sequence we author is the life of an own message:
  - The composer text lifts into its bubble: ≈240 ms, decelerate `cubic-bezier(.16,1,.3,1)` / spring damping 0.85.
  - The delivery glyph *draws* itself through ⏱ → ✓ → ✓✓ → ✓✓ indigo: stroke-draw 160 ms per state, crossfade between states.
  - Failed: the glyph becomes a red ⟲ with a single 4-pt shake and a warning haptic.
  - This is the product's signature; nothing else gets equal flourish.
- **Continuity:**
  - Inbox row → chat: the avatar and name travel into the chat header.
    - iOS: `matchedTransitionSource` + `.navigationTransition(.zoom)` on iOS 18+, push as the fallback.
    - Android: Navigation 3 shared element via `SharedTransitionLayout` + `sharedElement` for avatar/name; fade-through for the rest.
  - Back reverses exactly.
  - Sheets rise from the bottom with a scrim fade (iOS system sheet; Android `ModalBottomSheet`).
- **Feedback:**
  - Press: 0.97 scale (iOS) / ripple (Android), plus a 120 ms `primary-soft` row highlight.
  - Unread pill: numeric roll.
  - Typing: dots wave.
  - «Ознакомлен»: check draw + success haptic.
- **Budget:**
  - At most one shared-element transition at a time.
  - No blur animations on Android < 12.
  - List item animations only via stable keys (`animateItem()`, SwiftUI `.transition` on identity).
  - No infinite loops except typing dots and the call ring; both stop when offscreen.
  - Target 60/120 fps; profile on each device class.
- **Reduce Motion / Remove animations:**
  - shared elements → crossfade 150 ms;
  - lift → fade;
  - glyph draw → instant swap;
  - shake → colour only;
  - haptics stay.

## Keyboard (IME) — glued, never jumps

- The composer is pinned to the keyboard and moves **frame-synchronously** with it.
  - **Android:**
    - `enableEdgeToEdge`;
    - `Modifier.imePadding()` on the composer container, driven by animated `WindowInsets.ime` (API 30+ `WindowInsetsAnimation`);
    - message list with `reverseLayout = true`, so the newest message stays anchored above the composer while the keyboard opens;
    - `Modifier.imeNestedScroll()` for **interactive dismiss** by dragging the list down;
    - no `adjustResize` jumps.
  - **iOS:**
    - composer in `.safeAreaInset(edge: .bottom)`;
    - list with `.defaultScrollAnchor(.bottom)` and `.scrollDismissesKeyboard(.interactively)`;
    - no manual keyboard-notification offsets.
- Opening the keyboard scrolls the conversation only if the user was already at the bottom. If they were scrolled up, the «↓ N новых» pill floats above the composer.
- The composer grows smoothly from 1 to 6 lines (height animates with a spring), then scrolls internally. The attach button morphs into send when text appears (scale + crossfade, 150 ms).
- Forms: focus moves Login → Password → «Войти» via IME actions. The active field always stays visible above the keyboard (Android `bringIntoViewRequester`; iOS `@FocusState` + `ScrollView` + `.scrollPosition`).

## Depth model («наслоенность») — four planes from desktop tokens

| Plane | Role | Light / Dark | iOS | Android |
|---|---|---|---|---|
| L0 frame | tab bar / rail | `#ececf1` / `#19191e` | `.bar` material over content | `NavigationBar`/`NavigationRail`, `surfaceContainer` |
| L1 list | inbox, grouped lists | `#f4f4f7` / `#1e1e24` | grouped background token | `surface` |
| L2 canvas | chat, forms | `#fcfcfd` / `#24242a` | plain background | canvas token |
| L3 elevated | composer, sheets, menus, banners, sticky date pill | `#ffffff` / `#303038` + hairline | `.regularMaterial` / `.thinMaterial` | `surfaceContainerHigh` + tonal elevation; scrim `rgba(20,20,40,.34)` / `rgba(8,8,12,.64)` |

- Elevation comes from tone plus a hairline, never heavy shadows.
- The top bar is flat at rest and **lifts on scroll** (hairline + tone shift, 150 ms), so the user sees content passing underneath.
- On iOS, content scrolls under translucent L0/L3 system materials. Android uses opaque tonal surfaces, with no fake blur.
- Every overlay has a scrim and an obvious dismiss (swipe down / back).

## Visual component library (same names on both platforms)

1. **`BrandMark`** — the exact desktop C (done).
2. **`Avatar`**
   - Deterministic hue from the user id; initials, or the image when available.
   - Presence dot with a 2-pt ring in the surface colour; the dot pulses softly while the person is typing.
   - Channel avatar: slate tile with a `#` glyph.
3. **`DeliveryGlyph`** — custom-drawn path with animated stroke for queued, sending, sent, delivered, read and failed.
4. **`MessageBubble`**
   - Grouping radii: first/middle/last, with the tail corner of 2 only on the first.
   - Own: primary-soft + primary-line + accent-text. Incoming: card + border.
   - Reply quote with a 2-pt indigo bar; edited label; failed row «Повторить / Удалить».
5. **`TypingBubble`** — 3-dot wave with 0.2 s stagger; also used as the inbox preview line.
6. **`UnreadPill` + `JumpToLatestPill`** («↓ N новых») — numeric roll, scale-in.
7. **`DateSeparator`** — sticky L3 pill.
8. **`ConnectionBanner`** — slides from under the bar:
   - «Нет сети» (danger-soft);
   - «Переподключение…» (warning-soft, dots);
   - «Снова в сети» (success-soft, auto-collapses after 1.2 s).
9. **`SkeletonRow` / `SkeletonBubble`** — slow 1.2 s shimmer, real row geometry so there is no layout shift on swap.
10. **`EmptyState` with authored spot illustrations**
    - Vector, 120 pt, primary + graphite line art with soft primary-soft fills; no gradients, no stock art.
    - Inbox: two overlapping bubbles.
    - Channels: a hash in a bubble.
    - Announcements: a megaphone with a check.
    - Offline: a cloud with a broken link.
    - Search: a magnifier over an empty bubble.
    - Each pairs one sentence with one action.
11. **`SwipeToReply`** — dragging a bubble reveals an arrow that fills toward the threshold. Crossing it gives a light haptic tick; release starts a reply with the quote.
12. **`MessageContextMenu`** — long-press lifts the bubble (scale 1.03) over a scrim with Ответить / Копировать / Изменить / Удалить.
    - iOS: native `.contextMenu(menuItems:preview:)`.
    - Android: anchored Material menu + lifted bubble.
13. **`AcknowledgeButton`** — «Ознакомлен» → the check draws in, the button switches to the success state, success haptic.
14. **`CallStage`**
    - Dark full-screen.
    - Breathing ring around the avatar.
    - Live 5-bar level meter from audio RMS.
    - 64-pt circular controls.
15. **`AttachmentTile`**
    - Image: dominant-colour placeholder + fade-in, upload progress ring, failure with retry.
    - PDF: tile with glyph, size and an open action.

## Delight thesis

*Certainty, not fun.* The user should feel **sure**: that a message landed, that an order was acknowledged, that the app is back online. Delight lives only in four places:
- the message-lands sequence;
- the «Ознакомлен» stamp;
- «Снова в сети»;
- first-run empty states that orient.

No confetti, no sounds, no mascot.

## Acceptance (both platforms)

- Screen recordings (Android `adb shell screenrecord`, iOS `xcrun simctl io booted recordVideo`) of:
  - inbox → chat transition;
  - keyboard open/close with interactive dismiss;
  - send → delivered → read;
  - failed → retry;
  - swipe-to-reply;
  - context menu;
  - empty states;
  - the connection-banner cycle.
- Record each in light and dark, plus one with Reduce Motion.
- No visible dropped frames during the keyboard animation or list inserts. Label the evidence as emulator/simulator.
