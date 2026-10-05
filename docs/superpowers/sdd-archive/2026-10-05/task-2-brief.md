### Task 2: Desktop — admin UI for the registration allow-list and reports

Worktree `m-desktop`. Depends on Task 1.
Add to the existing admin UI (next to pending registrations in `AdminUserModal.jsx` or the admin section it belongs to — follow the existing structure):
- «Разрешённые адреса»: list, add (e-mail or `@domain` exactly as the server accepts — read `server/src/api/index.js` around `/admin/registration-allowlist` and `mobile/contracts/registration.md` §2), remove with confirmation; server errors shown in Russian.
- «Жалобы»: list from `GET /api/admin/reports` (who, on whom/what message, reason, date, status), close with `POST /api/admin/reports/:id/close`; open/closed filter if the API supports it.
- Only for users the server treats as admin (`requireAdmin`); hidden for scoped admins.
Acceptance: unit tests for the data/formatting logic with the existing desktop test runner; `npm test` and `npm run build` green; a screenshot of each new view (light and dark) from the dev build against a local server started from the worktree on a non-2004 port (`server/` with a throw-away database), attached to the report.

