### Task 1: Desktop — close the review of QA-fixes Task 4

Review-only task for commit `f7f3dd1` (base `f7f3dd1~1`): conversation preview after deleting the last message («Сообщение удалено» / «Вложение») and live handling of the server frame `registration_pending` for admins (`desktop/src/renderer/src/App.jsx`, `AdminUserModal.jsx`, `desktop/test/live-events.test.mjs`). Requirements are Task 4 of `docs/superpowers/plans/2026-10-04-qa-fixes.md` and defects D1/D2 in `docs/qa-reports/qa-desktop-report.md`. Known caveats from the implementer: the `App.jsx` branch and the `useEffect` in `AdminUserModal` are covered only by the build; the server sends no `is_deleted` for deleted attachments. Any fix happens in the Desktop lane worktree.

