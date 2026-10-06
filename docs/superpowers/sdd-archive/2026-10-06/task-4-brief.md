### Task 4: Android — attachments: open, download, send (QA D4)

Worktree `m-android`. Depends on Task 3 (same lane, sequential).
- Tap on an attachment tile opens it: images in an in-app viewer (pinch-zoom, thumbnail first via the server thumbnail URL, full image after), other files downloaded with the auth header to app cache (Range/ETag resume per `openapi.yaml`) and opened with `ACTION_VIEW` through a `FileProvider` (`grantUriPermissions`, no `file://`); long-press keeps the context menu. Progress and failure states visible on the tile.
- Sending: attach button in the composer → system picker (`OpenDocument`/Photo Picker, no storage permission) → upload with the existing server upload endpoint and the admin file policy (size/type rejected with the server's Russian message), queued like a text message with progress and cancel.
- Bubble tap (QA D7): the context menu offers «Ответить», «Копировать», «Редактировать» (own, per server edit rules), «Удалить».
Acceptance: unit tests for download/resume and policy errors with fakes; Compose UI tests for tile tap vs long-press; emulator recording: send a photo and a PDF, open both, against the dev stand.

