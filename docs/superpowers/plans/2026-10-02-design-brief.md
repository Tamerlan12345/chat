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

- **Server setup** — first run. Centered C mark (gradient, 72) + «CentyChat» + one line «Корпоративный мессенджер». One field «Адрес сервера» with example placeholder, primary button «Подключиться», inline validation + connection check states (checking → ok → error with reason). No empty half-screen: content sits in the upper third, keyboard-safe.
- **Login** — same header (mark smaller, 56) + server chip showing host with «Изменить». Fields login/password (show/hide), primary «Войти» full width, disabled until valid, loading state in-button. Errors in a danger-soft box like desktop `.login-error-box`. Remove the duplicated big title «Вход в CentyChat» + «Корпоративный мессенджер» stack seen in current Android build.
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
