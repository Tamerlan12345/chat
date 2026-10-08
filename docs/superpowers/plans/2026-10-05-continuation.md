# CentyChat — продолжение после передачи 2026-10-05

Источник: `docs/HANDOFF-2026-10-05.md` (что сделано и что осталось), `docs/superpowers/plans/2026-10-02-mobile-completion.md` (исходный план, задачи 7, 14, 15, 23 не закрыты), `docs/superpowers/plans/2026-10-02-design-brief.md` (дизайн), `PRODUCT.md`, отчёты QA в `docs/qa-reports/`.
Спецификация: контракты `mobile/contracts/*` (обязательны), дизайн-бриф, PRODUCT.md.

Уже сделано в этой сессии: iOS UI-тест удаления аккаунта листает список профиля по идентификатору `profile-list` (`ece2993`), проверка — CI `mobile-ios` на PR #3.

## Global Constraints (binding for every task)

- Integration branch: `mobile-release-parity-impl` (worktree `C:/Users/user/Documents/Нет в репо/chat/.claude/worktrees/mobile-release-parity`). Lane worktrees, created by the controller, each fast-forwarded to the integration branch before a task starts:
  - Desktop → `.../worktrees/m-desktop` (branch `work/desktop`), owns `desktop/**`.
  - Android → `.../worktrees/m-android` (branch `mobile/android`), owns `mobile/android/**`, `.github/workflows/mobile-android.yml`.
  - iOS → `.../worktrees/m-ios` (branch `mobile/ios`), owns `mobile/ios/**`, `.github/workflows/mobile-ios.yml`.
  - Never edit paths you do not own. `server/**` and `mobile/contracts/**` are read-only for every task in this plan; if a task needs a server change, stop and report NEEDS_CONTEXT.
  - Never push, except the iOS lane pushes `mobile/ios` to `origin` to run CI (no `--force`). Never touch `master`.
- Behaviour follows `mobile/contracts/*` exactly (`registration.md`, `delivery-state.md`, `ws-protocol.md`, `multi-device.md`, `push.md`, `openapi.yaml`, vectors in `fixtures/reducers/`).
- Security: release builds HTTPS/WSS only; tokens fail closed (Keychain / Android Keystore); no plaintext secrets or private keys committed; push payloads carry ids only. **Never send test traffic or credentials to production** (`https://centychat-production.up.railway.app`): debug builds default to the dev stand (`https://10.0.2.2:8443` Android, stand URL via launch argument on iOS). Do not touch the owner's local server on port 2004. Passwords never logged.
- UI: iOS = SwiftUI + HIG (semantic colours, Dynamic Type, 44pt targets, VoiceOver labels, `ContentUnavailableView`, String Catalog `ru`). Android = Compose + Material 3 (edge-to-edge, IME insets, 48dp targets, `stringResource`, semantics, DayNight). Desktop = existing React components and `desktop/src/renderer/src/styles/theme.css` tokens. Brand: primary `#5b4ee6`/`#6457ee`, online `#2da44e`, away `#d4951c`, dnd `#d9363b`, gradient `#ec8ee0→#c078ee→#7c44ea→#2a72ee→#00daff`. All user-facing copy in Russian. Design rules: `docs/superpowers/plans/2026-10-02-design-brief.md` (read only the sections a task names).
- TDD: a failing test first for every behaviour change; never weaken or delete existing tests. Small logical commits, conventional messages, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verification commands:
  - Desktop: `cd desktop && npm test` (≈470 pass today) and `npm run build` if the task touches the renderer.
  - Android (Windows, Cyrillic path workaround, 32 GB machine shared with other lanes): `cd mobile/android && JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache --max-workers=2 -Dorg.gradle.jvmargs=-Xmx2g testDebugUnitTest lint assembleDebug`. Emulator AVD `Pixel_8` (`emulator-5554`, adb at `$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe`) may be started for `connectedDebugAndroidTest` and screenshots; dev stand: `node mobile/dev/stand.mjs` (+ `mobile/dev/seed.mjs`), never production.
  - iOS: no local Xcode. Push `mobile/ios` and watch `gh run list --branch mobile/ios --workflow mobile-ios` / `gh run watch <id> --exit-status`; failures via `gh run view <id> --log-failed` (artifact downloads are blocked from this network; screenshots arrive on branch `ci/ios-screenshots`, readable with `gh api`). A task is not done until the run is green.

### Task 1: Desktop — close the review of QA-fixes Task 4

Review-only task for commit `f7f3dd1` (base `f7f3dd1~1`): conversation preview after deleting the last message («Сообщение удалено» / «Вложение») and live handling of the server frame `registration_pending` for admins (`desktop/src/renderer/src/App.jsx`, `AdminUserModal.jsx`, `desktop/test/live-events.test.mjs`). Requirements are Task 4 of `docs/superpowers/plans/2026-10-04-qa-fixes.md` and defects D1/D2 in `docs/qa-reports/qa-desktop-report.md`. Known caveats from the implementer: the `App.jsx` branch and the `useEffect` in `AdminUserModal` are covered only by the build; the server sends no `is_deleted` for deleted attachments. Any fix happens in the Desktop lane worktree.

### Task 2: Desktop — admin UI for the registration allow-list and reports

Worktree `m-desktop`. Depends on Task 1.
Add to the existing admin UI (next to pending registrations in `AdminUserModal.jsx` or the admin section it belongs to — follow the existing structure):
- «Разрешённые адреса»: list, add (e-mail or `@domain` exactly as the server accepts — read `server/src/api/index.js` around `/admin/registration-allowlist` and `mobile/contracts/registration.md` §2), remove with confirmation; server errors shown in Russian.
- «Жалобы»: list from `GET /api/admin/reports` (who, on whom/what message, reason, date, status), close with `POST /api/admin/reports/:id/close`; open/closed filter if the API supports it.
- Only for users the server treats as admin (`requireAdmin`); hidden for scoped admins.
Acceptance: unit tests for the data/formatting logic with the existing desktop test runner; `npm test` and `npm run build` green; a screenshot of each new view (light and dark) from the dev build against a local server started from the worktree on a non-2004 port (`server/` with a throw-away database), attached to the report.

### Task 3: Android — self-registration, pending state, account deletion, report and block

Worktree `m-android`. Parity with iOS (reference: `mobile/ios/CentyChat/Features/Auth/*Registration*`, `AccountFailure.swift`, `Features/Profile/AccountSafetyViews.swift`, `Core/Repositories/AccountRepository.swift`) and contract `mobile/contracts/registration.md` (all sections).
- Login screen: «Зарегистрироваться» → form (full name, e-mail, login, password with the same validation rules as iOS `Core/Utils/ValidationRules.swift`) → `POST /api/auth/register/request` → code entry (resend with the server's cooldown, `Retry-After`) → `/verify` → either signed in or «Заявка на рассмотрении» screen; `ACCOUNT_PENDING` / `ACCOUNT_REJECTED` on login show the matching screens; `EMAIL_NOT_CONFIGURED`/503 → «Отправка почты не настроена».
- Profile: «Удалить аккаунт» (password confirmation, irreversible warning, `DELETE /api/users/me`, then local sign-out wiping Keystore session, caches and the people cache); «Заблокированные пользователи» list with unblock.
- Person card and chat: «Пожаловаться» (user or message, reason) and «Заблокировать» / «Разблокировать»; a direct chat with a blocked user shows the server's `DM_NOT_ALLOWED` as a Russian banner and disables the composer.
- Error mapping is a pure function with unit tests (same codes as iOS `AccountFailure`).
Acceptance: unit tests (view models, error mapping, validation), Compose UI tests for the registration flow with a fake repository; `testDebugUnitTest lint assembleDebug` green; emulator screenshots (light, dark, font 2.0) of the registration form, code entry, pending, delete-account and report sheet against the dev stand.

### Task 4: Android — attachments: open, download, send (QA D4)

Worktree `m-android`. Depends on Task 3 (same lane, sequential).
- Tap on an attachment tile opens it: images in an in-app viewer (pinch-zoom, thumbnail first via the server thumbnail URL, full image after), other files downloaded with the auth header to app cache (Range/ETag resume per `openapi.yaml`) and opened with `ACTION_VIEW` through a `FileProvider` (`grantUriPermissions`, no `file://`); long-press keeps the context menu. Progress and failure states visible on the tile.
- Sending: attach button in the composer → system picker (`OpenDocument`/Photo Picker, no storage permission) → upload with the existing server upload endpoint and the admin file policy (size/type rejected with the server's Russian message), queued like a text message with progress and cancel.
- Bubble tap (QA D7): the context menu offers «Ответить», «Копировать», «Редактировать» (own, per server edit rules), «Удалить».
Acceptance: unit tests for download/resume and policy errors with fakes; Compose UI tests for tile tap vs long-press; emulator recording: send a photo and a PDF, open both, against the dev stand.

### Task 5: Android — messaging core: contract reducer and durable outbox (rest of plan Task 15)

Worktree `m-android`. Depends on Task 4.
Implement `mobile/contracts/delivery-state.md` on Android: a Kotlin reducer passing **every** vector in `mobile/contracts/fixtures/reducers/` (JUnit reading the JSON in place, like the existing `ContractFixturesTest`); a Room-backed outbox and conversation cache so queued/failed messages survive process death; an effects executor (WS send, HTTP flush, timers, persist barrier, `/api/sync` chain, 410 resync) with WorkManager for background flush; composer cleared only after durable enqueue; showsMeta for out-of-order QUEUED/SENDING bubbles that are not group-last plus a FIFO queue test (ledger ruling from 2026-10-02). Replace the in-memory queue added by the QA fixes (`4d08e46`, `6ce510f`, `d69a809`) with this core without regressing their tests; history paging `beforeId`; reply/edit/delete confirmation.
Acceptance: unit tests green including all reducer vectors; emulator evidence: airplane-mode send → force-stop → relaunch → reconnect → exactly one delivery seen from bob's session on the dev stand.

### Task 6: Android — anti-"AI-generated" polish pass (plan Task 23)

Worktree `m-android`. Depends on Task 5.
Apply the design brief section «Anti-"AI-generated" polish pass» to every Android screen (borders only where specified, spacing rhythm, three type steps per row, empty states with next-step actions, copy naming its objects, badge rules, chat refinements, grouped native lists in Profile/Announcements, announcement importance dot). Also fix the Task 17 deferred minors (bar return timing chat→inbox, R8 frame drops on bar slide, stale motion table, ChatBubble blank lines, `barVisiblePx` written in layout), QA D8 (ask POST_NOTIFICATIONS after login with a short explanation) and throttle typing frames (≤1 per 3 s while typing, stop frame on idle/send). Functionality must not change.
Acceptance: before/after screenshots of every screen in light, dark and font 2.0; existing UI tests green; independent design finish-review by the controller.

### Task 7: iOS — «Сотрудники» tab, person card, universal search

Worktree `m-ios`. Design brief section «People surface + universal search» (iOS variant: native `.searchable`, segmented Picker «Все | Отделы», inset grouped lists, `.navigationTransition(.zoom)`), Android Task 21 as behavioural reference (`mobile/android/app/src/main/java/com/openmychat/mobile/features/people`, `features/search`). Models/store already exist in `mobile/ios/CentyChat/Features/People/` (merged from `mobile/ios-ui`) — build the UI on them, add what is missing.
- 4 tabs (Чаты, Сотрудники, Объявления, Профиль) with state retained per tab.
- «Сотрудники»: A–Я sections, «Отделы» org tree, «В сети» filter and summary line, pull-to-refresh, cached list.
- Person card: avatar/status, «был(а) в сети», phone/email (`tel:`/`mailto:` safe), actions «Написать» (pushes the chat on the current stack), «Позвонить» (disabled with reason when not allowed / DND), «Побудка», «Пожаловаться», «Заблокировать».
- Universal search in «Чаты»: people / channels / messages, recents, jump to message with highlight.
Acceptance: XCTest for ranking/normalisation (already partly present — extend), UI test path tabs → search → card → «Написать» → back; screenshots light/dark/AX size published by CI; green CI.

### Task 8: iOS — avatars, push token, authorized media

Worktree `m-ios`. Depends on Task 7.
`APIClient` gains push-token registration/unregistration per `mobile/contracts/push.md` (called after login and on token change, removed on logout/delete; APNs registration code compiled but inactive without an account — no entitlement change that breaks CI signing) and avatar URL opt-in (`X-Avatar-Format: url` header, `/ws?avatars=url`). Avatars load from `/api/users/{id}/avatar` with the Bearer token through an image loader with memory + disk cache keyed by URL/ETag (no third-party dependency), used by `AvatarView` everywhere; deterministic fallback colour = desktop name hash (ledger ruling 2026-10-02).
Acceptance: XCTests for request building and cache behaviour with a stub URLProtocol; screenshots show photo avatars from the dev stand; green CI.

### Task 9: iOS — messaging core: contract reducer and durable outbox (plan Task 14)

Worktree `m-ios`. Depends on Task 8. Same scope as Task 5 on iOS: Swift reducer passing every vector in `mobile/contracts/fixtures/reducers/` (table-driven XCTest reading the JSON), SwiftData outbox + conversation cache, effects executor, reconnect, composer cleared after durable enqueue, visible delivery states with retry/cancel, `beforeId` paging, reply/edit/delete confirmation, attachment open/download/send parity with Task 4.
Acceptance: all vectors green in CI; UI test offline send → reconnect against the dev stand with screenshots; green CI.

### Task 10: iOS — design system, UI layer v2 and polish (plan Task 7)

Worktree `m-ios`. Depends on Task 9. Plan Task 7 text in `docs/superpowers/plans/2026-10-02-mobile-completion.md` (including both «Extended 2026-10-02» paragraphs, minus the People part already done in Task 7 here).
Acceptance as in that text; CI videos/screenshots; independent design finish-review by the controller.

### Task 11: Whole-branch review

After Tasks 1–10: final whole-branch review on the most capable model over `master..mobile-release-parity-impl`, with the ledger's deferred minors and rulings.
