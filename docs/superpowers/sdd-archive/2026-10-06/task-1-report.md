
## Fix round: deleted attachment preview (commit 7ef758b)

Finding (Important): conversationSnippet labelled an empty-text non-text last message «Вложение»; the server delete keeps type but clears text/metadata, so deleted attachments showed «Вложение» while ChatView shows «Сообщение удалено».

Changes (desktop/** only):
- desktop/src/renderer/src/lib/live-events.mjs: any existing last message (last_message_time set) with empty text -> «Сообщение удалено», type ignored. Comment documents the known edge: server allows captionless attachments from other clients (empty text rejected only for type 'text'), which would also show as deleted.
- desktop/test/live-events.test.mjs: test renamed to «удалённое вложение (type сохраняется, text пуст) — тоже «Сообщение удалено», как в ChatView»; covers type file and image.
- desktop/package.json: live-events.test.mjs was NOT in the npm test script (f7f3dd1 tests never ran); added.
- Environment: worktree had no node_modules (18 unrelated failures: missing builder-util-runtime/electron-updater); junctioned desktop/node_modules to mobile-release-parity's (untracked, not committed).

Command: cd desktop && npm test
RED (test changed first, script fixed to include it): tests 473, pass 472, fail 1 (the renamed test, got «Вложение»).
GREEN (after fix): tests 473, pass 473, fail 0.
