# Fix wave, lane D (desktop): report

- **Branch:** `fix/desktop`, worktree `m-desktop`, based on `07420d0`. Pushed to `origin/fix/desktop`.
- **Commits** (oldest first):
  - `9e71065` Russian report reasons, action-specific admin errors
  - `825d5c9` multi-device parity: away in the notify decision, mark_read while viewing, a minimized window is away
  - `f38fa59` registration switch per decision Q, the toast opens «Заявки», canonical copy
  - `45ae934` canonical text for a download without network
- **Verification:**
  - `cd desktop && npm test`: 509/509 pass, 0 fail, 0 skipped (the baseline was 481). Log: `fixwave-D-green-full-npm-test.log`.
  - `npm run build`: green, Vite, 89 modules, with the usual warning about a chunk over 500 kB. Log: `fixwave-D-green-build.log`.
- **TDD logs:** `fixwave-D-red-{1..4}-*.log` were written before each fix, and `fixwave-D-green-{1..4}-*.log` after it.
- **Existing tests:** none was weakened.
  - `attachments.test.mjs` changed from `match /Больше 100 МБ/` to an exact `strictEqual` with the canonical text, which is stricter.
  - All other changes add tests.
  - There are two new suites, `window-presence.test.js` and `copy-ru.test.mjs`, and both are wired into `npm test`.

## Items

| Item | Status | What changed | Evidence |
|---|---|---|---|
| **I1** Report reasons were raw codes | **fixed** | `reportReasonLabel()` maps spam/abuse/inappropriate/threat/other to the iOS titles. Free text from old clients is shown as it is, and an empty reason shows «—». `reporterName()` returns «—» instead of `undefined` (deferred T2). `ReportsAdmin` uses both. | `registration-admin.test.mjs`: 3 tests plus a source check. Red and green logs 1. |
| **I2** The banner contradicted the real behaviour (decision Q) | **fixed** (depends on lane S) | «Настройки» had **no** `allow_registration` control, although the banner sent admins there. It now has the checkbox «Самостоятельная регистрация сотрудников» with an explanation. When the setting is off, the «Заявки» banner says: «Самостоятельная регистрация выключена — новых заявок не будет. Сервер не принимает заявки ни с компьютера, ни с телефона, в том числе с адресов из списка «Разрешённые адреса»…». «Разрешённые адреса» shows a warning that the list has no effect while registration is off. Banners appear only after the settings have loaded, so the default `'false'` no longer flashes a false warning. The texts are in `REGISTRATION_SWITCH`. | `registration-admin.test.mjs`: 2 tests. Red and green logs 3. |
| **P16a** Away was ignored in the notify decision (vector 05) | **fixed** | `isViewingHere()` is the same condition as `viewing`: chat open, section visible, window focused, presence online. `incomingMessagePlan()` decides mark_read, the unread count and the banner. App.jsx uses both for direct messages and channels. An idle desktop with the chat open now counts the message as unread and shows the server's banner. | A new test runs the desk sockets of every `fixtures/notify/NN-*.json` message vector through the desktop logic. It checks that the banner matches `expected.banner` and that mark_read happens only while viewing. Red and green logs 2. |
| **P16b** mark_read was sent only near the bottom | **fixed** | While the window is viewing the chat, each new incoming message is marked read at once, even when scrolled up (multi-device §4 rule 4). Returning to online marks the open chat read. `markConversationRead` no longer marks while away. | `multi-device.test.mjs` source checks. Logs 2. |
| **P16c** A minimized window became away only after 180 s, or never | **fixed** | New `src/main/window-presence.js`. `main.js` sends `power-monitor-event` with away on minimize or hide, and with the combined state on restore or show. Unlock, resume and active after idle no longer force online while the window is minimized. A window started in the tray reports away after the page loads. | `window-presence.test.js`, 3 tests. Logs 2. |
| **M1** Report text was cut off | **fixed** | Details have a «Показать полностью» / «Свернуть» toggle. The preview of the reported message has a `title` with the full text. | Build. Manual check not run (see concerns). |
| **M2** Allowlist load and delete errors were never shown | **fixed** | `allowlistErrorMessage(data, status, fallback)` uses the action's text. `useAdminApi` passes `fallback` to `explain`. Errors now carry `status`; a 404 on close or remove reloads the stale list. | `registration-admin.test.mjs` and `admin-access.test.mjs` (`httpError`). Logs 1. |
| **M3** Pending and rejected login texts were terse | **fixed** | `describeAuthFailure()` branches on `code`: `login.pending.body`, `login.rejected.body` and `reg.disabled` (`REGISTRATION_DISABLED`). Otherwise it shows the server's text or the old fallback. | `copy-ru.test.mjs`. Logs 3. |
| **M4** No block UI on desktop | **accepted** | Post-release feature, outside this plan. It is compatible with the server: the `DM_NOT_ALLOWED` toast shows the server's text, which equals `delivery.DM_NOT_ALLOWED`. | — |
| **M5** `engines` field | **fixed** | `"engines": {"node": ">=22.12"}` in `package.json` and in the `package-lock.json` root. Still to do: run `npm run pack` on the release machine before tagging. | `build-config.test.js`. Logs 3. |
| **M6** Clicking the registration toast did nothing | **fixed** | The toast carries `data: {admin:'registrations'}`. `toastTarget()` and `openToastTarget()` serve both the in-app card and the Windows notification click. The console opens on «Заявки», or switches to it if already open (`focusTab`). It opens only for admins. | `live-events.test.mjs`, 3 tests. Logs 3. |
| **M7** Report filter tabs lacked semantics | **fixed** | The filter is now a button group with `aria-pressed`, no longer a half-implemented tablist. | Build. |
| **Ruling L** Login tagline | **fixed** | «Корпоративный мессенджер для сотрудников» and its CSS are removed; there is no replacement. | `copy-ru.test.mjs` (no tagline, no company line). Logs 3. |
| **Copy** Canonical texts (copy-ru-proposal.md) | **fixed** where desktop has the state | `lib/copy-ru.mjs` covers: signout.title, signout.body and signout.confirm; reg.disabled; login.pending and login.rejected; login.busy_retrying; login.offline; conn.offline, conn.reconnecting and conn.online (the status pill now distinguishes «Нет сети» from «Переподключение…»); upload.too_big and upload.no_extension (pre-checks and the 413 fallback); upload.refused; download.forbidden, download.failed and download.no_network; delivery.DM_NOT_ALLOWED. Not applicable on desktop: signout.unsent* (no outbox), block keys, reg.* email-code keys, login.busy with a countdown (desktop retries on its own). The sign-out cancel button keeps «Остаться», which has no canonical key. | `copy-ru.test.mjs` compares each text word for word with the table. Logs 3 and 4. |
| T2 `filterRef` (reload used a stale filter) | **fixed** | `close()` reloads with `filterRef.current`. | — |
| T2 Flicker on reload, no reload after 404 | **fixed** | Reload keeps the rows (`keepRows`); a 404 triggers a reload. | — |
| T2 `PATTERN_RE` drift | **fixed** | A test reads `server/src/services/registration.service.js` and compares the regex source with `ALLOWLIST_PATTERN_RE`. | `registration-admin.test.mjs`. |
| T1 Double fetch on mount | **accepted** | As already ruled: two idempotent GETs. | — |
| Parity: desktop uses the legacy `/auth/register` | **accepted** | Under decision Q the legacy endpoint is already gated by `allow_registration`. The form is hidden through `/settings/info`. A `REGISTRATION_DISABLED` code from the server is shown with the canonical text. Moving desktop to the email-code flow is post-release work. | — |
| Parity: desktop had no notify vectors | **fixed** | See P16a. | — |

## Concerns

1. **I2 depends on lane S.** The new banner and allowlist texts describe the server after decision Q. Until `fix/server-contracts` is merged, email-code registration still works with the switch off. Merge both lanes together.
2. **P16c needs a new desktop shell.** Installed shells (1.0.x / 1.1.0) load the new renderer from the server, but their `main.js` does not send minimize or hide events. On those shells, behaviour stays as before: the renderer's 180 s `document.hidden` fallback.
3. **No live check.** I did not run a manual Electron session or take screenshots. That would cover the new «Настройки» checkbox, the banner, the expand toggle, the status pill, and minimize-to-away against the dev stand. The evidence is unit and source tests plus a green build.

## Fix round 1 (Ruling S)

Commit `621a8d0`, pushed to `origin/fix/desktop`.

| Item | Status | What changed | Evidence |
|---|---|---|---|
| Two `mark_read` frames per incoming message when the chat is scrolled to the bottom (`plan.markRead` plus ChatView `onMarkRead`) | **fixed** | `createReadMarks()` in `lib/multi-device.mjs` remembers, for each conversation, up to which message id `mark_read` was already sent on this socket. Both call sites now pass that id: App.jsx passes `msg.id` and ChatView passes `latestMessageId(messages)`. The second mark for the same message is skipped. The memory resets on `auth_success`. Marks without an id still always go out: window focus returning, a chat switch (the feed still shows the previous chat at that moment) and the user's own unsent messages. Locally, the unread count is still zeroed every time. | `multi-device.test.mjs`: 3 tests |
| The start-in-tray away could be lost (`hidden-at-load` sent before the renderer subscribed) | **fixed** | The preload exposes `getWindowPresence()`. `main.js` handles `get-window-presence` (server page only) and returns `currentPresence()`. Right after subscribing to `onPowerMonitorEvent`, App.jsx asks for the current state and applies away. The main process still sends `hidden-at-load` as well. | `window-presence.test.js`: 2 tests |

**Logs** (in this folder):
- red: `fixwave-D-red-fix1.log` (5 tests fail);
- green: `fixwave-D-green-fix1.log`;
- full `npm test`: `fixwave-D-green-fix1-full-npm-test.log`, 514/514 pass;
- `npm run build`: `fixwave-D-green-fix1-build.log`, green.
