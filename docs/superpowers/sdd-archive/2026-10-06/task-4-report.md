# Task 4 report: Android attachments (open, download, send) — QA D4, D7

Worktree `m-android`, branch `mobile/android`. 10 commits on top of `d258cde` (Task 3 merge). Not pushed. Only `mobile/android/**` was edited.

## What was built

**Opening (D4).** A tap on an attachment opens it. A long press still opens the message menu.
- **Images** (jpg, jpeg, png, gif, webp, which are the formats the server can thumbnail):
  - The bubble shows the server thumbnail (`/api/files/thumb/{id}?size=m`) through Coil and the app's OkHttp client, so the bearer token goes only to the configured origin. The frame keeps the picture's proportions from `file_width`/`file_height`.
  - A tap opens a full-screen viewer (Dialog). It shows the thumbnail at once, and the full image fades in when its download finishes.
  - Gestures: pinch-zoom 1–5×, pan clamped to the picture, double tap zooms in and back, swipe down at 1× closes it. Back and «Закрыть» also close it. A failed full image shows the reason and «Повторить».
- **Other files:**
  - The file downloads with the auth header into `cacheDir/attachments/<fileId>/<safe name>`, never shared storage.
  - Resume follows `openapi.yaml`. A partial download continues with `Range` plus `If-Range: <etag>`. A 206 is appended; a 200 means the file changed and the download starts over; a 416 drops the partial and retries.
  - A finished copy is checked again with `If-None-Match` (a 304 reuses it). It also opens offline. A 403/404 deletes the cached copy.
  - `Accept-Encoding: identity` keeps byte offsets exact.
  - The file is opened with `ACTION_VIEW` on a `FileProvider` content URI (`${applicationId}.attachments`, `grantUriPermissions`, `FLAG_GRANT_READ_URI_PERMISSION`, no `file://`). The type comes from the sender; for octet-stream it comes from the extension.
  - If no app can open the type, the snackbar says «Нет приложения, чтобы открыть этот файл».
- **Tile states:** «Скачивание: N%» with a ring while downloading, and the Russian reason in red on failure. A second tap retries and resumes.
- The attachment cache is wiped when the session ends, the same rule as the history cache.

**Sending (D4).** «Прикрепить» in the composer opens a sheet with «Фото» (Photo Picker, `PickVisualMedia.ImageOnly`) and «Файл» (`OpenDocument */*`). No storage permission is needed.
- **Before upload:** the file is checked against the admin's `/api/files/policy` using the server's own wording:
  - «Файлы .exe к отправке не разрешены»
  - «У файла нет расширения»
  - «Файл пустой»
  - «Файл больше 100 МБ — такой файл загрузить нельзя»

  A refused file never enters the chat; the snackbar shows the reason.
- **The send queue:** the bubble appears at once, the same way a text message does (QA-fix queue).
  - The upload (`POST /api/files/upload`, multipart field `file`, UTF-8 file name) shows a progress ring with «Загрузка: N%» and a cancel button («Отменить загрузку»). Cancelling stops the HTTP call and removes the bubble.
  - Then it sends `send_message` with `msgType` `file`/`image`, **`text` = file name** (as the desktop does), and `metadata {file_id, size, mimeType, url, width?, height?}`. The `client_msg_id` is kept, so the echo replaces the local record.
  - **Offline:** the file waits as QUEUED and uploads when the connection returns. A network cut during the upload re-queues it instead of failing it.
  - **Server refusal** (413/415/403/429/507): the bubble becomes FAILED with the server's Russian text on the tile, plus a snackbar. «Повторить» uploads again. If the file is already uploaded and only the frame was refused, it re-sends the frame and does not upload again.
  - A cached chat that is reopened shows the file as QUEUED without a stale progress ring.
- The attach button appears only when the role allows uploads (`can_upload_files` or admin). It is disabled together with the Task 3 `ComposerLock`, and `sendAttachment` is a no-op while the lock is on.

**Menu (D7).** A bubble tap or long press still opens the menu: «Ответить», «Копировать», «Редактировать» (the `action_edit` label changed from «Изменить»), «Удалить», plus Task 3's «Пожаловаться».
- Edit and delete follow the server rules already in place (`MessageWindowValidator`, which mirrors `message.service.js`): only your own text messages, within `message_edit_window_minutes`; `NOT_TEXT_MESSAGE` means files are never editable.
- I checked this on the stand. A fresh message shows all four items. A message from yesterday shows only «Ответить»/«Копировать», which is correct.

## Files
New:
- `features/attachments/`: `MessageAttachment.kt`, `AttachmentDownloader.kt`, `UploadRules.kt`, `AttachmentOpener.kt`, `ZoomMath.kt`, `ImageViewer.kt`, `AttachmentPicker.kt`, `AttachmentBubbleContent.kt`, `AttachmentIntents.kt`
- `core/network/FileTransferClient.kt`
- `data/repository/AttachmentRepository.kt`
- `features/chat/AttachmentSends.kt`
- `res/xml/attachment_paths.xml`

Changed:
- `Message.kt` (`file_width`/`file_height`, transient `upload`), `Attachment.kt` (`LocalUpload`)
- `ChatViewModel.kt` (+141 lines: queue integration, `notices`, `opener`, `canAttach`), `ChatBubble.kt`, `ChatScreen.kt` (`ChatActions` + wiring)
- `AttachmentTile.kt` (status, cancel), `RealtimeRepository.kt` / `WebSocketClient.kt` (`sendAttachment`, `msgType`)
- `ApiClient.kt` (`internal raise()`), `RepositoryModule.kt`, `AndroidManifest.xml` (FileProvider), `strings.xml`, `MessageContextMenu.kt`/`ChatMenu.kt` (KDoc)

Tests:
- New: `MessageAttachmentTest`, `AttachmentDownloaderTest`, `UploadRulesTest`, `FileTransferClientTest`, `AttachmentOpenerTest`, `ZoomMathTest`, `ChatViewModelAttachmentTest` (unit); `AttachmentUiTest` (Compose)
- Changed: `testing/Fakes.kt` (`FakeAttachmentRepository`, `sendAttachment`), `androidTest/.../ChatTestDoubles.kt` (`sendAttachment`)

## Tests and results
- `testDebugUnitTest lint assembleDebug` with the global-constraints command (`--max-workers=2`): **BUILD SUCCESSFUL**, **517 unit tests, 0 failures**.
  - Lint: no errors.
  - The two `UseKtx` warnings in my files were fixed (`toUri`).
  - The remaining `UnusedResources` warnings (`inbox_search_hint`, `people_fast_scroll`) were there before this task.
- New unit tests, 63 in total:
  - `MessageAttachmentTest` 8
  - `AttachmentDownloaderTest` 11 (resume / If-Range / 200-restart / 416 / 304 / offline cache / 403-404 texts / short body / safe names)
  - `UploadRulesTest` 8 (policy errors in the server's words)
  - `FileTransferClientTest` 7 (multipart field and UTF-8 name, progress, 413/415 Russian text, Range/If-Range/If-None-Match/identity headers, 401 through the session rules)
  - `AttachmentOpenerTest` 8
  - `ZoomMathTest` 6
  - `ChatViewModelAttachmentTest` 14 (progress, frame shape with text = name, image metadata, policy refusal, unreadable file, server refusal + retry re-upload, rejected frame retried without re-upload, offline queue + auto-send, network cut → QUEUED, cancel, no cancel after upload, composer lock, open, role without uploads, no stale ring)
- `connectedDebugAndroidTest` on `Pixel_8` (API 17 image):
  - Package `com.openmychat.mobile.chat`: **38/38**. That is `AttachmentUiTest` 12, `ChatContentTest` 12, `ChatUiV2Test` 9, `ChatSafetyUiTest` 5.
  - Package `components`: `ComponentsUiTest` **6/6**.
  - `AttachmentUiTest` covers:
    - tile tap opens and shows no menu
    - long press on the tile shows the menu and does not open
    - image tap opens
    - own text offers Ответить/Копировать/Редактировать/Удалить
    - download progress and failure text on the tile
    - upload progress and cancel
    - server refusal text and the failed row
    - attach chooser (Фото / Файл)
    - viewer closes by «Закрыть» and by swipe down
    - double tap zooms, and a drag while zoomed does not close
    - failed full image retry

## TDD evidence (RED → GREEN)
Every RED run was in the same Gradle command, filtered by `--tests`.

| Area | RED | GREEN |
|---|---|---|
| MessageAttachmentTest | `Unresolved reference 'Attachments'` / `'LocalUpload'` | 8/8 |
| AttachmentDownloaderTest (+ UploadRulesTest, written in the same window) | `Unresolved reference 'DownloadTransport'` / `'AttachmentDownloader'` | 11/11, 8/8 |
| FileTransferClientTest | `Unresolved reference 'FileTransferClient'` | 7/7 |
| ChatViewModelAttachmentTest | `No parameter with name 'attachments'`, `Unresolved reference 'sendAttachment'`/`'notices'` | 11/11 |
| AttachmentOpenerTest | `Unresolved reference 'AttachmentOpener'` / `'TransferState'` | 8/8 |
| VM open test | `Unresolved reference 'openAttachment'` / `'opener'` | 12/12 |
| ZoomMathTest | `Unresolved reference 'ZoomMath'` | 6/6 |
| AttachmentUiTest (compile) | `Unresolved reference 'ImageViewer'`, `'canAttach' overrides nothing`, … | 11/12 first run → 12/12 |
| canAttach test | `Unresolved reference 'canAttach'` (main compile) | 13/13 |
| stale-ring test | `AssertionError at ChatViewModelAttachmentTest.kt:299` (a behavioural RED, not a compile one) | 14/14 |

Notes on the evidence:
- The UploadRulesTest RED was in the same failing compile as the downloader test. Output was cut with `head`, so its own lines are not shown.
- In the first `AttachmentUiTest` run, `aRefusedUploadShowsTheServersReason` failed. The reason was only shown when the bubble's mark was FAILED, and the test double had no `localMark`. I fixed both: the reason now shows whenever `upload.error` is set, and the double uses `sendStateMark` like `ChatScreen` does.

## Emulator recording (dev stand `https://10.0.2.2:8443`, server on 2014, user alice → Боб Тестов)
I restarted the AVD and the stand myself after the controller's notes, and stopped both at the end. Port 2004 and production were not touched.

All files are in this folder:
- `task-4-recording-1-send-photo-and-pdf.mp4`: Прикрепить → Фото → Photo Picker → photo uploads and is sent (✓). Прикрепить → Файл → DocumentsUI → `Протокол_05-10.pdf`. The socket was reconnecting after the app came back from the document picker, so the PDF showed «Ожидает отправки», then uploaded and sent on its own when the socket returned (queue auto-resend).
- `task-4-recording-2-open-image-and-pdf.mp4`:
  - Tap the photo, the full-screen viewer opens, swipe down closes it.
  - Tap the PDF: it downloads to cache and opens in Google Drive's PDF viewer through the FileProvider, under its Cyrillic name.
  - Long press on the PDF tile shows the menu (Ответить/Удалить).
  - Tap on yesterday's own message shows Ответить/Копировать (the edit window has passed).
- `task-4-recording-3-message-menu.mp4`: a fresh own message is sent; a tap shows Ответить / Копировать / Редактировать / Удалить.
- Key frames:
  - `task-4-frame-1-photo-picker.png`
  - `task-4-frame-2-photo-sent.png`
  - `task-4-frame-3-pdf-queued-while-reconnecting.png`
  - `task-4-frame-4-image-viewer.png`
  - `task-4-frame-5-pdf-opened-in-viewer-app.png`
  - `task-4-frame-6-long-press-on-file-tile.png`
  - `task-4-frame-7-own-message-menu.png`

  There is no ffmpeg on this machine. These frames are `adb exec-out screencap` captures taken during the recorded session at those moments, not frames cut from the mp4.
- I could not show double-tap zoom on the recording. Two `adb input` taps are too slow to count as a double tap. The `AttachmentUiTest` Compose test covers it (`aDoubleTapZoomsTheViewerInsteadOfClosingIt`); pinch is unit-tested in `ZoomMathTest`.

## Self-review
- **Security:**
  - Bearer credentials go only to the configured origin. Thumbnails and downloads use `apiClient.imageHttpClient` with `BearerCredentialsInterceptor`.
  - Files stay only in the app cache and are wiped when the session ends.
  - The FileProvider exposes only `cache/attachments/` and is not exported; the grant is a one-off read.
  - File names are sanitised: no path separators, no leading dot, at most 120 characters.
  - No new permissions.
  - The server's `INVALID_METADATA` and `ATTACHMENT_NOT_ACCESSIBLE` checks still apply; the client sends only its own uploaded `file_id`.
- **Contracts:**
  - The `send_message` shape follows `ws-protocol.md` §3.2 (`msgType`, `metadata.file_id`, `client_msg_id`).
  - Download headers follow `openapi.yaml`.
  - The upload multipart field is `file`, and the name is sent as raw UTF-8, which the server decodes from latin1.
- **Structure:** new logic is in `features/attachments/` and `features/chat/AttachmentSends.kt`. `ChatViewModel.kt` still grew 592 → 733 lines, because the upload is part of its send queue. `ChatScreen.kt` grew 451 → 526.
- **Ruling A:** edit and delete still use the current repository calls (`realtimeRepository.editMessage`/`deleteMessage`), and the edit window and permissions are unchanged. Only the label changed. That is what QA reported, apart from tap-to-open.

## Concerns / follow-ups
1. **The socket reconnects slowly after the app comes back from a full-screen picker** (DocumentsUI, the PDF viewer app). This was already in the code before this task (the realtime connection manager or its backoff, not attachment code). The app sat on «Переподключение…» for roughly 30 s. The queue handled it (the PDF stayed «Ожидает отправки» and then went by itself), but users will notice. It is worth a look in Task 5 or the realtime lane.
2. **Photo Picker names.** On this Android build, Photo Picker files come with media-id names (`53.jpg`), not the original file name. That name becomes the message text and the file name on other clients. «Файл» (DocumentsUI) keeps real names.
3. **Replies.** «Ответить» still keeps a local reply draft only; `reply_to_id` is not sent, as before (the ChatScreen comment defers it to the send queue). Attachments are sent without a reply too.
4. **No persistence.** As instructed, the queue is in memory. A pending upload survives leaving and reopening the chat (through `ChatHistoryCache`) but not process death. The picked content-URI grant also does not survive process death. Task 5's outbox should store the file or take a persistable grant.
5. **Size limit.** The client only knows the server's hard 100 MB ceiling. A smaller admin limit (`max_upload_size_mb`) is reported by the server after the upload starts, with its own text («Файл больше N МБ…»), because `/settings/info` does not expose that limit.
6. **Edit label.** `action_edit` is used only by the message menu today. If another screen later needs «Изменить», it will need its own string.

---

## Fix report — review round 1

Commits: `867d38e`, `9a0be5e`, `28fe01e` (on `mobile/android`, not pushed).

### 1. (Important, security) The ACTION_VIEW type no longer comes from the sender
- `AttachmentIntents.viewType(name, typeForExtension = MimeTypeMap)` builds the type in three steps:
  1. Take the file's extension. Extensions are what the admin's policy controls.
  2. Look up its MIME type with `MimeTypeMap`.
  3. Keep that type only if it is in `AttachmentIntents.SAFE_TYPES`. Otherwise use `application/octet-stream`.
- `SAFE_TYPES` copies the server's `SAFE_DOWNLOAD_TYPES` exactly (`server/src/api/index.js` `safeDownloadType`): images except SVG, PDF, text/plain, text/csv, the audio, video and archive types listed there.
- The sender's label is gone from the path. `OpenRequest` now has no type field (`OpenRequest(file, name)`), so `metadata.mimeType` cannot reach the intent. `MessageAttachment.mimeType` is still used for the tile glyph and is still sent as upload metadata. Neither needs to be trusted.
- New `AttachmentIntentsTest` (5 tests):
  - a `.txt` labelled `text/html` by the sender goes through `AttachmentOpener` and opens as `text/plain`, and the label is not in the request;
  - allowed types open as themselves (pdf/txt/csv/png/jpg/mp4/zip, upper-case extension);
  - `svg`, `html`, `htm`, `xml`, `js` open as octet-stream;
  - `docx`, no extension and unknown extensions open as octet-stream;
  - the allowlist matches the server's list item for item.
- `AttachmentOpenerTest` was updated for the new `OpenRequest` shape. Its assertion is the same one, without the dropped field.

### 2. (Privacy) Thumbnails and avatars no longer survive sign-out
- New `SessionCacheWiper(root, clearImages)`. On every sign-out (session token becomes null) it deletes the attachments folder and clears the image loader's caches. That is Coil's `SingletonImageLoader` memory cache and disk cache, so thumbnails and avatars both go.
- `DefaultAttachmentRepository` uses it. Before, it only deleted the attachments folder.
- New `SessionCacheWiperTest`:
  - nothing is wiped while signed in;
  - sign-out deletes the files and clears the image caches;
  - every later sign-out wipes again.

  The Coil call itself is three lines and is not unit-tested; a JVM test cannot build a real `ImageLoader`.

### 3. A unit test that files and images are not editable
- `ChatViewModelAttachmentTest.filesAndImagesAreNeverEditableEvenMyOwnAndFresh`: a fresh own text message is editable; a FILE or IMAGE message with the same author and time is not (the server's `NOT_TEXT_MESSAGE` rule).
- This test passed on its first run. The rule was already in the code (`canEditMessage` checks `type != TEXT`), so it is a regression guard, not a red-then-green test.

### TDD
- RED for fixes 1 and 2 was a compile failure of the filtered run (`--tests "*AttachmentIntentsTest" --tests "*SessionCacheWiperTest" --tests "*ChatViewModelAttachmentTest"`):
  ```
  e: AttachmentIntentsTest.kt:30:71 Argument type mismatch: actual type is '() -> String?', but 'String?' was expected.
  e: AttachmentIntentsTest.kt:42:74 No value passed for parameter 'mimeType'.
  e: AttachmentIntentsTest.kt:84:31 Unresolved reference 'SAFE_TYPES'.
  e: SessionCacheWiperTest.kt:38:9 Unresolved reference 'SessionCacheWiper'.
  BUILD FAILED
  ```
- GREEN, run filtered to `features.attachments*` and `ChatViewModelAttachmentTest`:

  | Test class | Tests | Failures |
  |---|---|---|
  | AttachmentIntentsTest | 5 | 0 |
  | SessionCacheWiperTest | 1 | 0 |
  | AttachmentOpenerTest | 8 | 0 |
  | ChatViewModelAttachmentTest | 15 | 0 |
  | Other attachment tests | 33 | 0 |

### Full verification (run once)
Command (from `mobile/android`):
```
JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache --max-workers=2 -Dorg.gradle.jvmargs=-Xmx2g testDebugUnitTest lint assembleDebug
```
Output: `BUILD SUCCESSFUL in 1m 22s`.
- Unit tests: 525 run, 0 failures, 0 errors, 0 skipped. That is 517 before this round plus 8 new.
- Lint: 41 warnings, 0 errors. None are in the files this round touched.
- Compose UI tests were not run again. This round changed no Compose code, and the UI tests do not build `OpenRequest`.
