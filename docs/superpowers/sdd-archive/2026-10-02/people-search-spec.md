# People surface + universal search (owner request 2026-10-02, impeccable shape)

Owner: «нет поиска контактов — продумай UI, визуал близко к десктопу, порядок переходов, визуал и UI кнопок». Owner choices:
- the **«Сотрудники» tab + universal search in Chats** (the desktop pattern: «Контакты» rail section + Ctrl+K palette);
- the person card also shows **phone, email, status and «был(а) в сети»**.

Mode: Operate. World: inherited (desktop graphite, one indigo). No concept roll, because the structure is chosen by the owner and native navigation fixes the rest.

## Navigation
Four top-level destinations, in this order:

| # | Destination | iOS | Android |
|---|---|---|---|
| 1 | **Чаты** | tab bar, `bubble.left.and.bubble.right` | bar or rail |
| 2 | **Сотрудники** | `person.2` | `Icons.Outlined.Groups` |
| 3 | **Объявления** | tab bar | bar or rail |
| 4 | **Профиль** | tab bar | bar or rail |

Each tab keeps its own stack.

## Data, read-only (no server changes)
- People: `GET /api/users`. Show only `is_active && approval_status=approved`, and exclude yourself.
- Departments: `GET /api/org/tree`.
- Person detail: `GET /api/users/:id`.
- Message search: `GET /api/messages/search?q` (debounce 300 ms, ≥2 chars, rate-limited at 30/min server-side). Drop stale responses.
- Presence comes live from `user_status_changed`.
- Cache the people list with stale-while-revalidate. Keep the last list on disk, non-secret, so the tab opens instantly offline.
- Match on `full_name`, `username`, `job_title`, `department_name`, `extension`, phone digits and `email`. Matching is case-insensitive, treats `ё` as `е`, ignores punctuation in phone numbers, and handles multi-word queries with AND across tokens.
- Ranking:
  1. prefix of the surname or first name;
  2. prefix of another token;
  3. substring;
  4. other fields.

  Within a rank, people who are online come first, then alphabetical order.

## «Сотрудники» screen
- **Header:**
  - large title «Сотрудники» (iOS) / top app bar (Android);
  - under it the summary «48 сотрудников · 12 в сети» in caption/labelSmall `textDim`, with tabular digits;
  - search field: iOS `.searchable` with placement `.navigationBarDrawer(.always)`; Android an M3 `SearchBar` docked in the top bar. Placeholder «Имя, должность, отдел, вн. номер».
- **Scope switch, «Все» | «Отделы»:**
  - iOS: native segmented `Picker`. Android: M3 `SingleChoiceSegmentedButtonRow`.
  - On the right, a filter toggle «В сети» (Android: `FilterChip`; iOS: toolbar `Toggle` styled as a chip menu).
- **«Все» — alphabetical list:**
  - sticky section letters (L3 sticky header, `labelMedium` `textDim`);
  - an A–Я fast-scroll index on the trailing edge on iOS. On Android the fast-scroll thumb shows the letter bubble.
- **Person row, 64 pt/dp:**
  - avatar 40 with the presence ring;
  - name in `headline`/`titleMedium`, with the matched substring in accent-text weight 600 during search;
  - second line: job title · department in `subheadline`/`bodyMedium` `textSecondary`, one line, ellipsis;
  - trailing «вн. 214» in `caption` `textDim`, tabular.
  - No chevron on Android; disclosure chevron on iOS.
- **«Отделы» — org tree:**
  - department rows 52 with a disclosure triangle that rotates 90° (180 ms);
  - right-aligned «3/9 в сети» counter as a `success-soft` pill when anyone is online, `textDim` otherwise;
  - people indented 16 under their department;
  - expanding is a height animation plus a staggered fade of children (cap 6 × 20 ms);
  - search auto-expands the matching branches (as on desktop);
  - the «Без подразделения» group comes last.
- **States:**
  - skeleton rows on first load only;
  - error: inline banner «Не удалось обновить список · Повторить» above the cached list;
  - empty search: illustration «magnifier over empty bubble» + «Никого не нашли по «…»» + «Очистить поиск»;
  - offline: the ConnectionBanner.

## Person card
- **Presentation:** iOS uses a push with `.navigationTransition(.zoom(sourceID: avatar))` (iOS 18+; push as fallback). Android uses a shared element from the row avatar and name into the card header. Back reverses. From a chat header avatar tap, the same card opens over the chat.
- **Header, centred:**
  - avatar 96;
  - name in `title2`/`headlineSmall`, weight 600, `textStrong`. The name is never red, unlike the desktop panel's `--danger-text`; that would read as an error on mobile.
  - status line: presence dot + «В сети» / «Отошёл(ла)» / «Не беспокоить» / «Был(а) в сети сегодня в 14:32» / «…вчера» / «…12 сент.» from `last_seen`. The custom status in quotes goes on a second line in `textSecondary`.
- **Action row, directly under the header.** Three equal buttons, each 72 tall with an icon above the label:

  | Order | Button | Style | Behaviour |
  |---|---|---|---|
  | 1 | **Написать** | primary fill, white | opens the direct chat |
  | 2 | **Позвонить** | tonal: `primary-soft` fill, `accentText` icon and label | disabled when `can_call` is false (label «Звонки недоступны») or the person is offline («Не в сети»); the disabled caption sits under the row, not as a toast |
  | 3 | **Побудить** | tonal | — |

  Press feedback: scale 0.97 plus a light haptic.
- **Info group** (iOS inset grouped list, Android `ListItem`s on an L3 card), in this order:
  1. Должность
  2. Отдел — tap switches to «Сотрудники › Отделы» with that branch expanded
  3. Вн. номер — tap copies, with a Snackbar or iOS HUD «Скопировано»
  4. Мобильный — tap opens the system dialer (`tel:`), long-press copies; the trailing icon is a phone glyph
  5. Email — tap opens `mailto:`, long-press copies
  6. Роль — only if `role_name`

  Rows with no value are omitted, never shown as «—».
- **Own card:** the action row is replaced by «Редактировать профиль», which opens Profile.

## Universal search in «Чаты»
- **Entry.**
  - iOS: `.searchable` on the Chats list, with search suggestions for people.
  - Android: an M3 `SearchBar` in the top bar expanding to a full-screen `SearchView`.
  - The search has its own screen state and is not filtered inline over the inbox.
- **Empty query:** «Недавние», the last 5 people or chats opened (local, non-secret prefs).
- **Results:** sections in the fixed order **Люди · Каналы · Сообщения**.
  - Люди: max 5 + «Все сотрудники (N)», which opens the «Сотрудники» tab with the query carried over.
  - Каналы: max 4.
  - Сообщения: from the server after 300 ms, max 20, row = sender + time + 2-line snippet with the match highlighted. Tapping opens the chat scrolled to that message, using `beforeId`/`afterId` around it, with a 1.2 s highlight pulse on the bubble.
  - While the server search is in flight: a 2-row message skeleton under the local results. They don't wait for each other.
- **Keyboard:** Return opens the first result. Results scroll with `scrollDismissesKeyboard(.interactively)` / `imeNestedScroll`.

## Transition order (one grammar for the whole people flow)
1. **Tab switch.** Crossfade 150 ms with no slide (system tab behaviour). Each tab keeps its scroll and search state.
2. **Search focus.** The field expands, the scope switch and summary collapse up (200 ms) and the keyboard rises. The results list replaces the browse list with a fade-through 150 ms; sections appear with a ≤3-item stagger of 30 ms.
3. **Typing.** Local results update per keystroke without animation (instant is the feedback). Server message results fade in when they arrive.
4. **Row → card.** Shared avatar and name (300 ms, decelerate). The rest of the card fades through.
5. **«Написать».** The chat pushes onto the **current tab's stack** (back → card → list). There is no forced tab switch, unlike desktop. The avatar shares into the chat header.
6. **«Позвонить».** The call stage presents full-screen over everything (iOS full-screen cover / Android dialog scene), so the stack underneath is preserved.
7. **Back** reverses each step exactly; predictive back on Android previews the list under the card.
8. **Reduce Motion:** every shared/fade-through becomes a 150 ms crossfade; the stagger is removed.

## Buttons (system-wide, also applies to existing screens)
- **Primary** (one per screen, the single most likely action):
  - filled `primary`, white label;
  - height 48 dp / 50 pt, radius 12;
  - label `headline`/`labelLarge` weight 600;
  - pressed: `primary-pressed`;
  - disabled: 38% opacity of the fill plus `textDim` label;
  - loading: an in-place spinner replaces the label, width unchanged.
- **Tonal** (secondary actions): `primary-soft` fill, `accentText` label, same metrics.
- **Text/link:** `accentText` with no fill, used for «Отмена», «Повторить», «Очистить поиск». Minimum target 44/48.
- **Destructive:** «Выйти» and «Удалить» use the `danger` text style inside lists; a filled `danger-fill` appears only in a confirmation dialog.
- **Icon buttons** (top bar, composer): 44/48 target, 24 glyph, no circle background except the send button. Send is a 40 circle filled `primary` when enabled, an attach glyph otherwise.
- **Never:**
  - outlined pill buttons as primary actions;
  - two filled buttons side by side;
  - an «OK» in an alert where the action can be named.

---

