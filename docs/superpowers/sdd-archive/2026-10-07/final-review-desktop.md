# Task 11: final review of desktop/ (master..mobile-release-parity-impl)

Reviewer: Opus, read-only. Worktree `mobile-release-parity`, branch `mobile-release-parity-impl`, reviewed 2026-10-07.

## Scope reviewed

`git diff master..mobile-release-parity-impl -- desktop` covers 24 files (+1495/-978, most of it package-lock):

- **Task 1 (QA D1/D2):** `lib/live-events.mjs`, the `registration_pending` case in `App.jsx`, and the `registrationTick` effect in `AdminUserModal`.
- **Task 2:** `RegistrationAllowlistAdmin.jsx`, `ReportsAdmin.jsx`, `useAdminApi.js`, `lib/registration-admin.mjs`, and the `.rep-status` CSS.
- **Owner request 53f4cef (Ruling L):** the company line is removed from login, and the window title changes.
- **Earlier branch work:**
  - multi-device: `viewing`, `conversation_read`, `notify`, and `authFrame` with `platform`/`presence`;
  - `avatarSrc`;
  - `callReasonText`;
  - `autoHideMenuBar`;
  - the npm-audit dependency bump (electron-builder 26.17 and an `@electron/get` ^5.1 override).

## Verification

- **`cd desktop && npm test`:** 481/481 pass, 0 fail, 0 skipped, about 69 s.
- **`npm run build`:** green with Vite 6.4.3, 88 modules. There is the usual warning about a chunk larger than 500 kB.
- **Lockfile resolution:** I ran `npm ci --ignore-scripts` in a scratch copy of the lockfile.
  - It resolves electron-builder 26.17.0, app-builder-lib 26.17.0 and electron 44.5.1, with `@electron/get` 5.1.0 deduplicated.
  - On Node 24, `require('app-builder-lib/out/util/electronGet.js')` loads. `@electron/get` 5 exports `downloadArtifact` and `ElectronDownloadCacheMode`, as app-builder-lib expects.
  - The worktree's own `node_modules` is older than the lockfile (electron-builder 26.15.3, electron 44.3.0). This affects only the environment; tests and build do not depend on those versions.

## Issues

### Critical

None.

### Important

**I1. Report reasons are shown to the admin as raw English codes.**
- **Where:** `desktop/src/renderer/src/components/ReportsAdmin.jsx:331`, which renders `<div>{report.reason}</div>`.
- **Failure:** Android (`ReportController.kt:18-24`) and iOS (`Registration.swift:106-121`) both send the codes `spam`, `abuse`, `inappropriate`, `threat` and `other` (contract: `reason` string ≤100). The server stores the code as received (`safety.service.js:81`). In the «Причина» column of «Жалобы», the super-admin therefore sees "spam" or "abuse" in an otherwise Russian console.
- **Why it was missed:** the Task 2 screenshots used seeded Russian text, and no test covers the codes.
- **Fix:**
  - Add `reportReasonLabel(code)` to `lib/registration-admin.mjs`. Use the same titles as iOS: Спам или реклама / Оскорбления или травля / Недопустимое содержимое / Угрозы или опасные действия / Другое.
  - Unknown values (free text from older clients) are shown unchanged.
  - Use the function at `ReportsAdmin.jsx:331`, and add a test in `registration-admin.test.mjs`.

**I2. The «Заявки» tab says registration is off, but email-code registration still works (cross-area, server).**
- **Where:** `desktop/src/renderer/src/components/AdminUserModal.jsx:2197-2203`. With `allow_registration !== 'true'`, it says: «Самостоятельная регистрация сейчас отключена — новых заявок не появится».
- **Failure:**
  - On this branch the new flow, `POST /api/auth/register/request` and `/verify` (`server/src/services/registration.service.js:128ff`, `api/index.js:670-700`), never reads `allow_registration`. Only the legacy `/auth/register` (`api/index.js:620`) does.
  - When SMTP is configured, mobile users can register while the setting is off. Their requests appear in the tab despite the banner.
  - Worse, addresses on «Разрешённые адреса» activate immediately. An admin who "turned registration off" has not closed self-registration.
  - No server test covers `allow_registration` for the new flow (`server/test/self-registration.test.js` has no reference to it).
- **Fix, preferred (server, owner decision):** gate `/auth/register/request` and `/verify` on `allow_registration`. For example, return 403 with code `REGISTRATION_DISABLED`, document it in `mobile/contracts/registration.md` §1, and have the mobile clients handle it.
- **Fix, otherwise (desktop):** change the banner to describe what the setting really controls, and say so on «Разрешённые адреса».
- I am passing this to the server/contracts reviewers. Desktop is where the false statement appears.

### Minor

**M1. Report text is cut off with no way to read all of it.**
- **Where:** `ReportsAdmin.jsx:326` (message, 140 characters) and `:332` (details, 200 characters).
- **Failure:** details can be up to 2000 characters (`DETAILS_MAX`). The admin who decides on a report cannot read the full complaint or the full reported message.
- **Fix:** add a `title={full}` attribute, or a «Показать полностью» toggle.

**M2. The load and delete error texts on «Разрешённые адреса» are never used.**
- **Where:** `RegistrationAllowlistAdmin.jsx:29-30` and `:81-82`.
- **Failure:** `useAdminApi` gives `explain` precedence over `fallback`. A failed load (500, no body) therefore shows «Не удалось выполнить действие» instead of «Не удалось загрузить список разрешённых адресов».
- **Fix:** have `allowlistErrorMessage(data, status, fallback)` honour `fallback`, or pass `explain` only for POST.

**M3. The pending and rejected login messages are terse.**
- **Where:** `LoginView.jsx:49`.
- **Failure:** a pending or rejected account sees only «Заявка на рассмотрении» or «Заявка отклонена», because the server maps both codes to these short texts at `api/index.js:587-592`. It is Russian and correct, but less helpful than the mobile screens.
- **Fix (optional):** branch on `data.code`, for example «Заявка на регистрацию ещё не подтверждена администратором…» and «…отклонена. Обратитесь к администратору.».

**M4. Blocks have no UI on desktop (parity gap, outside this plan).**
- **Failure:** a user who blocked someone on the phone sees the dialog disappear on desktop (`message.service.js` drops blocked partners from the conversation list). The history is empty when opened from Контакты. Sending shows the toast «Сообщение не отправлено — Сообщение не может быть доставлено». Desktop offers no way to unblock.
- **Compatibility:** this is compatible. The WS `error` frame still carries `context: 'send_message'`, `message` and `text`, which is all desktop reads (`App.jsx:1151-1163`). It is not a crash.
- **Fix (post-release):** a «Заблокированные» list with an unblock action in the profile.

**M5. Packaging with the new build dependencies has not been run.**
- **Where:** `desktop/package.json:115-121`.
- **Failure:** no CI job runs `electron-builder` on this branch. Under the override, `@electron/get` 5 is ESM-only (`engines.node >=22.12`) and is loaded through `require()`. On a release machine with Node <22.12, `npm run dist` would fail.
- **Fix:** run `npm run pack` on the release machine before tagging. Consider adding `"engines": {"node": ">=22.12"}` to `desktop/package.json`.

**M6. Clicking the registration toast does nothing.**
- **Where:** the `registration_pending` toast (`App.jsx:1500-1503`, `live-events.mjs:20`).
- **Failure:** the toast has no `data`, so a click only dismisses it (`ToastNotificationStack.jsx:115`, `App.jsx:2718`). The admin has to navigate to Консоль → Заявки by hand.
- **Fix:** pass `data: { admin: 'registrations' }` and open the admin modal on that tab.

**M7. The «Жалобы» filter tabs lack full keyboard semantics.**
- **Where:** `ReportsAdmin.jsx:270-283`.
- **Failure:** the filter uses `role="tablist"` and `role="tab"`, but there is no arrow-key navigation, no `tabpanel` and no `aria-controls`.
- **Fix:** either complete the tabs pattern, or use a plain button group with `aria-pressed`.

### Checked and found clean

1. **Admin UI (Task 2):** checked against the server routes in `server/src/api/index.js:1904-1961`.
   - **Shapes:** the allow-list rows `{id, pattern, created_at}` and the report fields (`reporter.name`, `reportedUser.name`, `messageText`, `createdAt`, `status`) match.
   - **Pattern check:** the client regex is identical to `ALLOWLIST_PATTERN_RE` in `registration.service.js:27`.
   - **Access:** both views are super-admin only, which matches the server's `requireAdmin`.
   - **Interaction:** removing and closing both ask for confirmation, and a stale-response guard protects the filter switch.
2. **Live `registration_pending`:** the tick re-reads the open console, and a toast names the applicant. Ruling on the server sending this only to super-admins: see the deferred items.
3. **Conversation preview after deletion:**
   - `conversationSnippet` gives «Сообщение удалено» for an empty text on an existing record, whether text or attachment, which matches ChatView. A live attachment shows its file name. With no record at all, the preview is «Нажмите для беседы».
   - The heuristic is safe because Android and iOS send the file name as the attachment text too (iOS `AttachmentUploads.swift:553`).
   - `message_deleted` triggers `refreshConversations()`.
4. **Ruling L:**
   - The company line is gone from both login layouts, and its CSS is removed.
   - The title is `CentyChat — ${name}${ext} (${status})`, with `ext` = ` (в.н.N)`. Signed out, it is `CentyChat`.
   - Company data stays in the admin and profile views, as the ruling requires. No test asserts the title. The controller checked it, and it is acceptable.
5. **Server compatibility:**
   - `ACCOUNT_PENDING` and `ACCOUNT_REJECTED` (403 + Russian `error`) display correctly through `describeFailure`.
   - `DM_NOT_ALLOWED` arrives as a WS `error` with `context: 'send_message'` and shows a toast.
   - The additive frames are handled where needed or ignored safely: `conversation_read` is handled; `message_cancelled` and the `notify` field are tolerated.
   - The deleted-account `user_updated` is handled.
   - The legacy `/auth/register` still exists and still broadcasts `registration_pending`.
6. **Electron security:**
   - All three `BrowserWindow`s keep `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.
   - Preload and IPC are unchanged on this branch. The IPC `isTrustedFrame` check and main-window-only checks are intact.
   - External links: `setWindowOpenHandler` denies new windows and opens only `http`/`https` in the system browser. `will-navigate`, `will-redirect` and `will-frame-navigate` are restricted to the server origin.
   - `autoHideMenuBar: !app.isPackaged` affects development builds only. Packaged builds still call `Menu.setApplicationMenu(null)` and suppress DevTools. A guard test exists (`main-guards.test.js:297`).
7. **XSS:** the new views have no `dangerouslySetInnerHTML` or `innerHTML` anywhere in the renderer. Every user-supplied field (pattern, names, reason, details, message text) is rendered as JSX text. The confirm dialog renders `{request.message}` as text with `pre-line`. No user data reaches `href` or `src`. `avatarSrc` narrows what is accepted, rejecting `javascript:` and non-image `data:` URLs.
8. **Copy and tests:**
   - All new copy is Russian, apart from the codes in I1.
   - Modified existing tests were not weakened:
     - `avatar`, `main-guards` and `copy-install` only add tests.
     - `copy-install` resolves the long-path form for a CI path comparison.
     - `sha512-powershell` feeds a precomputed hash instead of calling `Get-FileHash`, and still asserts that the old formula fails.
   - New suites: `multi-device` (8), `live-events` and `registration-admin`. All are wired into `npm test`. `live-events` had never run before 7ef758b.

## Rulings on deferred desktop items

| Item | Ruling |
|---|---|
| T1: `AdminUserModal` fetches twice on mount when `registrationTick > 0` (`:330-339`) | Real but harmless: two idempotent GETs. Accept; post-release. |
| T1: the `registration_pending` case in `App.jsx` and the modal effect are untested | Accept for release. The pure helper is tested, and QA #20/#21 covered the flow by hand. Post-release, extract a reducer if the area grows. |
| T1: redundant guards in `live-events.mjs:5-7` | Resolved. The file was rewritten in 7ef758b, and the guards (`:11-15`) are now needed. |
| T1 note: `broadcastToAdmins` skips scoped admins (`ws/server.js:2052`) | By design. Live names would reach admins outside the registrant's scope. Scoped admins see requests in scope when they open the console. Accept; a scope-aware broadcast is optional post-release work. |
| T1: mobile previews of deleted attachments | Not desktop. Passed to the Android and iOS reviewers. |
| T2: `ReportsAdmin` reloads with the filter captured at confirm time (`:254`) | Real but narrow: switching tabs while a close is in flight shows the old filter's rows under the new tab until the next switch. Minor; fix with a `filterRef`. Not blocking. |
| T2: list flickers to a spinner on reload; no reload after a 404 on close/remove | Minor UX. A 404 happens only when the row was purged (reporter deleted) or removed by another admin. Fix: keep the rows during the refresh and reload on 404. Not blocking. |
| T2: `PATTERN_RE` copied from the server without a drift test | Minor. The regexes are identical today, and the server stays authoritative because it returns a 400 in Russian. Cheap fix: a test that reads `server/src/services/registration.service.js` and compares the regex source. Recommended in the fix wave, not blocking. |
| T2: `reporter?.name` could print "undefined" (`ReportsAdmin.jsx:245`) | Unreachable with this server, which always returns `reporter.name` (falling back to 'Удалённый пользователь'). Add a trivial `|| '—'` alongside I1. |
| Owner request 53f4cef (Ruling L, desktop) | Verified correct (see Checked and found clean, item 4). |

## Verdict

**Ready after fixes.**

- **I1** is a small desktop change: a label map and a test.
- **I2** needs an owner or server decision. Either gate the email-code registration on `allow_registration` (preferred), or correct the desktop banner. Desktop must not tell the admin registration is off while it is open.
- **M1 to M7:** none blocks release. M1 and M2 are cheap enough to include in the same fix wave.
- **Before release:** run `npm run pack` on the release machine (M5).
