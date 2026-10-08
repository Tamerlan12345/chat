# Task 20 report: mobile media (Range, thumbnails, image metadata, avatar URLs) and call follow-ups

Worktree `m-integration`, branch `mobile/integration`. Base `8f0762f`; nothing pushed.

## Status

Done. Server suite, desktop suite and `capture-fixtures --check` are green (final numbers in "Test summaries"). Sharp builds and runs in the repo `Dockerfile` (node:24-alpine, musl) and on Windows.

## Commits (oldest first)

| SHA | Message |
|---|---|
| 9fc2ff2 | chore(server): add sharp 0.35.5 for image thumbnails and avatars |
| fb8627a | feat(server): byte ranges and ETag for attachment downloads |
| b611b16 | feat(server): lazy image thumbnails for attachments |
| 4d003a1 | feat(server): image dimensions and dominant colour for attachments |
| f14a053 | fix(server): keep attachment image columns through the legacy table rebuild |
| a73d611 | test(contracts): add attachment image fields to reducer vector messages |
| 77b51a4 | fix(server): key cached thumbnails by file content, not only by id |
| 1ed5678 | feat(server): avatar upload and avatar URLs for mobile clients |
| 9de9208 | fix(desktop): show initials for avatar values an <img> cannot load |
| 1e823d7 | fix(server): one answering device per call, socket-bound audio, offerSeq |
| 700c32d | fix(desktop): Russian text for the answered_elsewhere call end |
| 864fdf6 | docs(server): correct the stored avatar size comment |
| a1263a9 | docs(contracts): mobile media endpoints and single-device call answer |

## Endpoints and shapes

### `GET /api/files/download/:id` (Range, ETag)
- Authorization is unchanged and runs before any range handling: 404 for a missing file, then 403 for no access. The `Range` header is never looked at for an unauthorized caller.
- Every response carries `Accept-Ranges: bytes` and `ETag: "<sha256>"`. The sha256 is computed at upload. Legacy rows without a hash get `"<size hex><mtime hex>"`.
- `If-None-Match` matching the ETag returns `304` with no body.
- `Range` is parsed strictly. It must be exactly one byte range:
  - accepted forms: `bytes=a-b`, `bytes=a-`, `bytes=-n`;
  - an end beyond the file is clamped;
  - the result is `206` with `Content-Range: bytes a-b/size` and the exact `Content-Length`.
- Anything else in `Range` returns `416` with `Content-Range: bytes */size`. That covers multiple ranges, spaces, other units, reversed or empty ranges, `-0`, a start beyond EOF, and more than 15 digits.
- `If-Range` with the same strong ETag returns the range. Any other value, including a date, returns the whole file with `200`.
- `Cache-Control: private, no-store` is kept so the browser and Electron caches are not changed. The ETag exists for clients that keep their own cache.

### `GET /api/files/thumb/:id?size=s|m&format=webp|jpeg`
- Defaults: `size=s`, `format=webp`.
- Output:
  - longest side at most 160 px (`s`) or 480 px (`m`), never upscaled;
  - EXIF-oriented, all metadata stripped;
  - `image/webp` or `image/jpeg`.
- Same authorization as download, in the same order.
- Response headers:
  - `ETag: "thumb-v1-<contentKey>-<size>-<format>"`;
  - `Cache-Control: private, max-age=604800, immutable`;
  - CSP sandbox;
  - `If-None-Match` returns `304`.
- Errors are JSON `{error, code}`:

  | Status | Code | When |
  |---|---|---|
  | 400 | `BAD_REQUEST` | bad size or format |
  | 415 | `NOT_AN_IMAGE` | not an image by magic bytes |
  | 422 | `IMAGE_TOO_LARGE` | over 50 MP or over 40 MB |
  | 422 | `IMAGE_UNREADABLE` | corrupt image |
  | 503 | `IMAGE_BUSY` | render queue full; sent with `Retry-After` |

### Image metadata
- `POST /api/files/upload` now also returns `width`, `height` and `dominantColor` (`#rrggbb`).
  - Width and height are EXIF-oriented.
  - All three are `null` for non-images, images over 50 MP, or unreadable images.
- Every message gets three new fields: `file_width`, `file_height`, `file_dominant_color`. They are present on every message (null when there is no image), across REST pages, `/sync`, POST echoes and WS frames.
  - They are read from new `files` columns. Those columns are filled by the server, never taken from client `metadata_json`.
- Older files without dimensions are backfilled the first time their thumbnail renders.

### Avatars
- **`PUT /api/users/avatar`** (multipart field `file`):
  - max 5 MB (413 `IMAGE_TOO_LARGE`), magic bytes checked (415 `NOT_AN_IMAGE`), 50 MP cap (422), 10 requests/min (429 `RATE_LIMITED`);
  - the image is re-encoded to JPEG, at most 256 px on the longest side, EXIF-oriented, metadata stripped, transparency flattened on white;
  - it is stored as a data URL in `users.avatar_url`, the same column the desktop uses;
  - returns the user with `avatar_url` set to the URL form.
- **`DELETE /api/users/avatar`** clears the photo and returns the user.
- **`GET /api/users/:id/avatar?size=s|m`** (default `m`):
  - returns a 96 or 256 px square (centre-cropped) JPEG, re-encoded every time, never the stored bytes;
  - visible to any authenticated user, the same as the directory;
  - returns 404 `NO_AVATAR` for no photo, an unknown user, a legacy non-data value, or an unreadable stored image;
  - sends `ETag: "avatar-v1-<version>-<size>"` and `Cache-Control: private, max-age=86400`, with `304` support.
- **User payloads.** For every client except the desktop app:
  - `avatar_url` (users, `/auth/me`, the directory, the org tree, conversations, `auth_success`, `user_*` frames) becomes `/api/users/<id>/avatar?v=<16-hex sha256 of the stored value>`;
  - message `sender_avatar` gets the same treatment;
  - legacy non-data values (old http links) become `null`, so a client never takes its token to an arbitrary host.
- **Echo rule.** `PUT /users/profile` with the caller's own avatar URL is treated as "unchanged", so a mobile profile form that echoes the field back works.

## Dependency decision

- **Package:** `sharp@0.35.5`, pinned exactly (`"sharp": "0.35.5"`) and added with `npm install --save-exact --ignore-scripts`. The repo's manager is npm 11.17.0 with `package-lock.json`.
- **Why sharp:** it is mature and maintained (maintainer lovell); it supports WebP and JPEG; it has `limitInputPixels`; it strips metadata by default; it ships prebuilt libvips binaries for musl and glibc.
- **Release age:** 0.35.5 was released 2026-09-27, five days ago.
  - Its release notes add bounds checks (linear/GIF delay arrays) and libvips 1.3.4.
  - 0.35.4 (2026-08-26) adds resize and composite coordinate bounds.
  - I took the hardening release over a month-old one. Flag this if your policy requires a minimum release age.
- **Install scripts:** reviewed through registry metadata before the first install.
  - `sharp@0.35.5` declares no `install`, `preinstall` or `postinstall` script; older 0.33/0.34 had `install/check.js`, 0.35 dropped it.
  - The same holds for `@img/sharp-win32-x64`, `@img/sharp-linuxmusl-x64`, `@img/sharp-libvips-linuxmusl-x64`, `@img/colour`, `detect-libc` and `semver`.
  - The lockfile has zero `hasInstallScript` entries.
  - npm 11.17 has no verified granular script approval, so per the security skill I added:
    - `server/.npmrc` with `ignore-scripts=true`, a fail-closed policy for this boundary;
    - `--ignore-scripts` on the Dockerfile's `npm ci --omit=dev`.
- **Lockfile:** 636 lines added. It includes the platform-specific optional packages with `os`/`cpu`/`libc` fields; the musl x64 entry is present.
- **Audit:**
  - `npm audit`: 0 vulnerabilities;
  - `npm audit --omit=dev --audit-level=high`: 0;
  - `npm audit signatures`: 106 packages verified, 6 attestations, none missing or invalid.
- **Docker check (Docker Desktop 29.7.2):**
  - `docker build --target server-deps` succeeds; `npm ci --omit=dev --ignore-scripts` adds 107 packages.
  - In that image: `libc musl, vips 8.18.7, sharp 0.35.5`, and a 1200×800 EXIF-6 JPEG renders a 107×160 WebP with no EXIF.
  - The full `docker build .` succeeds, and sharp runs in the runtime stage as user `mychat`.
- **Windows:** sharp loads from `@img/sharp-win32-x64` and the whole server suite runs on it.
- **Fallback:** the `jpeg-js`/`pngjs` fallback was not needed.

## Security controls

- **Type detection:**
  - The type comes from magic bytes only: JPEG `FFD8FF`, PNG signature, `GIF87a`/`GIF89a`, `RIFF....WEBP`.
  - libvips' own detected format must equal the sniffed type, or the request gets 415.
  - SVG, PDF, TIFF and HEIF are rejected even if the stored MIME says `image/png`. Tests cover forged rows.
- **Decompression bombs:**
  - Header-only `metadata()` runs with `limitInputPixels` = 50 MP, followed by an explicit `width*height` check, all before any decode.
  - A 20000×20000 PNG of about 100 bytes returns 422 and no cache file is written.
  - Decode itself also runs with `limitInputPixels`, `failOn:'error'`, `pages:1` and `timeout 15s`.
- **Resource limits:**
  - at most 2 concurrent renders, a waiting queue capped at 64 (then 503);
  - `sharp.cache(false)`, `sharp.concurrency(1)`;
  - a 40 MB source cap for thumbnails and a 5 MB cap for avatar uploads (checked against both Content-Length and multer limits);
  - avatar uploads are rate-limited to 10/min per user.
- **Re-encoding:**
  - Thumbnails and served avatars are always re-encoded with metadata stripped.
  - Uploaded avatars are re-encoded before storage; a test proves an EXIF payload does not survive.
  - The avatar endpoint never returns stored bytes.
- **Cache paths:**
  - Built only from server data:
    - thumbnails: `.thumbs/<int id>-<contentKey>-<s|m>.<webp|jpg>`;
    - avatars: `.avatars/<int id>-<16hex version>-<s|m>.jpg`.
  - `contentKey` is a sha256 of the server-generated `stored_filename` and sha256. The avatar version is a sha256 of the stored value.
  - Size and format come from allowlists checked with `Object.hasOwn`, so `constructor` and the like are not accepted.
  - Writes are atomic (tmp file, then rename, with the tmp removed on failure). In-flight renders are de-duplicated.
  - Stale avatar versions are removed only when their name matches the exact server pattern inside the fixed directory.
  - The uploads dir is not served statically.
- **Id reuse (found while testing):** the content key in thumbnail names prevents a cross-file leak after a DB restore. Without it, a reused id would serve another file's thumbnail. That is commit 77b51a4.
- **Authorization:** thumbnails use the same `FileService.canUserAccessFile` gate and order as download. Range is handled after authorization.
- **Avatar URLs:** non-desktop clients never receive data URLs or legacy external links (those become `null`).

## Desktop compatibility

I kept the legacy field for the desktop rather than switching desktop rendering to URLs. `avatar_url` is read directly in several places (`Avatar.jsx`, `PersonInfoPanel.jsx`, `UserProfileModal.jsx` preview and save-echo), and I may only edit the avatar files.

- **Detection:** the server checks the User-Agent for `Electron/` or `OpenMyChatDesktop/`. Electron's default UA plus the app's `userAgentFallback` suffix in `desktop/src/main/main.js` always contain them.
- **What the desktop gets:** exactly the stored data URL in `avatar_url` and `sender_avatar`, over HTTP (an `res.json` wrapper on the API router) and WS (the per-socket `send` wrapper is installed only for non-desktop sockets).
- **Not a security control:** a forged UA only gets photos the caller can already see in the directory.
- **Existing data-URL avatars:**
  - They keep rendering on the desktop unchanged.
  - Via the URL endpoint they are re-encoded lazily on first request and cached by content version. That is the lazy migration; no batch job, and the stored column is not rewritten.
  - The desktop's `PUT /users/profile` data-URL path is unchanged.
- **Desktop code change (9de9208):** `avatarSrc()` in `lib/avatar.mjs`, used by `Avatar.jsx`.
  - It keeps data-image, http(s) and blob values.
  - It turns `/api/users/...` URLs and non-image schemes into initials, avoiding 401 requests in browser-fallback mode.
  - Tests are in `desktop/test/avatar.test.mjs`.

## Call changes

- **Binding:** a call is bound to two sockets: the one that sent `call_offer` (`pendingOffers[...].ws`) and the one that answered. This is stored in `callBindings: userId -> {ws, peerId, role}`.
- **Repeat answer:** `call_answer` from the bound socket during the call is an idempotent silent no-op (behaviour kept).
- **`answered_elsewhere`:**
  - `call_answer` from another socket of the same user returns `call_end {senderId: caller, senderName, reason: "answered_elsewhere"}`. It does not take over the call and is not relayed.
  - When a call is answered, all other callee sockets immediately receive the same `call_end … answered_elsewhere`, so they stop ringing (CallKit `.answeredElsewhere`).
  - A callee socket that logs in during that call (for example a second phone woken by the same push) also receives it.
- **Other signals:** `call_rejected`, `call_end` and `ice_candidate` from a non-bound socket during an active call are dropped, so "Reject" on the desktop cannot kill the call the phone answered.
- **Audio relay:** frames are accepted only from the bound socket and relayed only to the peer's bound socket. Other devices of either user neither hear nor inject audio.
- **Disconnects:**
  - Closing a bound socket ends the call with `connection_lost`, even if the user has other sockets.
  - Closing the offering socket cancels a pending offer.
  - Incoming offers are cancelled only when the callee has no sockets left.
- **`offerSeq`:**
  - A monotonic `offerSeq` is stored on each pending offer and passed into `PushService.notifyCall`.
  - `stillWanted`, `settle` and `callUndeliverable` match by `seq` instead of `at`.
  - `offerAt` is kept only for the ring-window expiry.
  - Internal only; it is not in the push payload.
- **Desktop:** `REASON_TEXT.answered_elsewhere = 'Звонок принят на другом устройстве'`.
  - In the ringing phase it dismisses silently.
  - In connecting/active it shows the text.

## Contracts and fixtures

- **`openapi.yaml`:**
  - new paths `/files/thumb/{id}`, `/users/avatar` (PUT, DELETE), `/users/{id}/avatar`;
  - Range/ETag on download (headers, 206/304/416);
  - `ImageErrorResponse`;
  - `avatar_url`/`sender_avatar` semantics; `file_width`/`file_height`/`file_dominant_color`;
  - upload `width`/`height`/`dominantColor`.
  - It parses with PyYAML.
- **`ws-protocol.md`:** single-device answer, `answered_elsewhere` frame, non-bound signals dropped, bound-socket audio routing (§5.1), avatar URL note, fixture table.
- **`push.md` §3:**
  - item 5 (answered elsewhere on login);
  - item 7 (idempotent per socket);
  - new item 8 (one device per call);
  - new item 9 (`offerSeq`).
- **Fixtures (`--write`, then `--check`: "fixtures match the server"):**
  - new: `http/files.upload-image.json`, `http/users.avatar-upload.json`, `http/users.get-with-avatar.json`, `http/users.avatar-not-image.json`, `ws/call_end.answered_elsewhere.json`;
  - message fixtures carry the three file_* fields;
  - the 36 hand-written reducer vectors were updated to the same message shape (a73d611).

## RED → GREEN evidence

- **Download Range/ETag** (`mobile-media.test.js`):
  - RED: 4 of 5 failed (`accept-ranges` null; 200 instead of 206 or 416). The access test already passed.
  - GREEN: 5/5.
  - Two test-side fixes on the way: trailing OWS is stripped by the HTTP parser, so that case was removed; a Cyrillic If-Range value is not a ByteString, so it was replaced.
- **Thumbnails:** RED 7 new tests failing (route missing); GREEN 12/12.
- **Image metadata:** RED 3 failing; GREEN 15/15.
- **Image columns and legacy rebuild:** the full suite exposed `table files__new has no column named width` in identity-source and migration tests. Fixed by adding the columns to the base DDL; GREEN.
- **Avatars:**
  - RED: 8 failing (routes and shaping missing).
  - One false failure came from my own 10/min limiter across tests; I added a per-test reset and a dedicated limiter test.
  - GREEN: 25/25.
- **Thumbnail id reuse:** a stale `.thumbs` file from an earlier run was served for a reused file id, so the backfill test failed. Fixed by the content key; GREEN.
- **Desktop avatarSrc:** RED (missing export); GREEN 11/11 in avatar.test.mjs.
- **Calls** (`call-devices.test.js`):
  - RED: 9/9 failing. Main reasons: no `answered_elsewhere` frames (waitFor timeouts); audio delivered to and from non-bound sockets; offerSeq absent (`undefined > undefined`).
  - The frozen-clock offerSeq test failed with the real bug: "старый провал не сказал «не в сети»". With identical `at`, the stale delivery failure cancelled the new offer and sent `call_unavailable`.
  - GREEN: 9/9.
- **Desktop call text:** RED 1 failing; GREEN 14/14 in call-lifecycle.test.mjs.

## Test summaries

- **Server, `npm test`, 40 files:** see the final run below. The run just before the last commit was 704 pass / 2 fail / 1 skipped. The 2 failures were the fixture test importing my half-edited `capture-fixtures.mjs` (duplicate identifier); that is fixed and committed.
- **Server, final run on HEAD a1263a9:** 707 tests: 706 pass, 0 fail, 1 skipped (PostgreSQL-only test, needs TEST_DATABASE_URL); about 348 s.
- **Desktop, `npm test`:** 460/460 pass.
- **`node mobile/dev/capture-fixtures.mjs --check`:** fixtures match the server (run twice; stable).
- **Audit:** `npm audit` 0; `npm audit signatures` all verified.

## Files changed

- **Server source:**
  - `server/src/api/index.js` (download Range/ETag, thumb route, avatar routes, response shaping);
  - `server/src/files/http-range.js` (new);
  - `server/src/media/images.js`, `server/src/media/thumbnails.js`, `server/src/media/avatars.js` (new);
  - `server/src/services/file.service.js`, `message.service.js`, `user.service.js`;
  - `server/src/db/index.js` (files columns);
  - `server/src/ws/server.js` (avatar frame shaping, call binding, offerSeq);
  - `server/src/push/push.service.js` (offerSeq).
- **Server tests and config:**
  - `server/test/mobile-media.test.js`, `server/test/call-devices.test.js` (new);
  - `server/package.json` (sharp, test list), `server/package-lock.json`, `server/.npmrc`.
- **Repo root:** `Dockerfile` (`--ignore-scripts`).
- **Desktop:**
  - `desktop/src/renderer/src/lib/avatar.mjs`, `components/Avatar.jsx`, `test/avatar.test.mjs`;
  - `desktop/src/renderer/src/lib/call-signal.mjs`, `test/call-lifecycle.test.mjs`.
- **Contracts:**
  - `mobile/contracts/openapi.yaml`, `ws-protocol.md`, `push.md`;
  - `mobile/contracts/fixtures/**` (http, ws, reducers, manifest);
  - `mobile/dev/capture-fixtures.mjs`.

## Concerns

1. **Client detection by User-Agent.**
   - Desktop vs everyone else is decided by the `Electron/` or `OpenMyChatDesktop/` UA. It is not a security boundary (the same photos are visible either way).
   - In `ALLOW_BROWSER_ACCESS` browser mode, the SPA gets URL-form avatars:
     - `Avatar.jsx` shows initials;
     - `PersonInfoPanel`'s large photo would show a broken image (a file outside my desktop scope);
     - `UserProfileModal` echoes the URL, which the server treats as unchanged.
   - A later desktop task could switch these components to authenticated fetches.
2. **sharp release age.** 0.35.5 is five days old; I chose it for its bounds-check hardening. Pin 0.35.4 instead if a release-age policy applies.
3. **New behaviour on bound-socket loss.** A mobile socket flap during a call now ends the call with `connection_lost`, even if the user has another device online. Before, the call survived while any socket remained; audio then went to all sockets.
4. **Legacy avatar bytes on the desktop.** Data-URL avatars saved by the desktop are stored and sent to desktop clients as-is (pre-existing behaviour). Only the URL endpoint re-encodes them. The desktop canvas already re-encodes on save, so EXIF should not be present in practice.
5. **Thumbnail cache growth.** It is bounded per file (at most 4 small variants) but not globally. Nothing deletes thumbnails, mirroring attachments, which are never deleted either.
6. **Delayed metadata for older attachments.** They get `file_width`/`file_height` only after their first thumbnail request. Mobile should fall back to an extension check plus requesting the thumbnail.
7. **HEIC is not supported.** The prebuilt libvips has no HEVC, so iOS clients should send JPEG for avatars and attachments to get thumbnails.

---

# Fix round 1/5

Commits: `6020b4d` fix(server): avatar URLs only on explicit opt-in; harden thumbnail and avatar paths; `89956f6` docs(contracts): document avatar URL opt-in and thumbnail caching. Not pushed.

## Changes

### Important 1: avatar format is an explicit opt-in, and the User-Agent logic is removed
- **Default.** Every consumer gets data URLs, exactly as before Task 20. That includes the desktop in Electron, the desktop renderer in a browser (`ALLOW_BROWSER_ACCESS`) and integrations. `PersonInfoPanel` and `UserProfileModal` work in browser mode again.
- **HTTP opt-in.** The header `X-Avatar-Format: url` (case-insensitive, trimmed) switches the `res.json` wrapper on the API router to URL form. Any other value, or no header, keeps data URLs.
- **WS opt-in.** Chosen once at the handshake with the query parameter `/ws?avatars=url`; it is parsed from `req.url` in the `connection` handler. I picked the query over an auth-frame field because the `send` wrapper must be installed before any frame goes out, including `auth_success`. `ws` matches the path without the query, so `/ws?avatars=url` still routes.
- **Removed:** `wantsLegacyAvatars` and `LEGACY_UA_RE`. The new functions are `Avatars.wantsAvatarUrls(headers)` and `Avatars.socketWantsAvatarUrls(req)`.
- **Contracts:**
  - `openapi.yaml`: `info.description`, `User`/`PublicUser`/`DirectConversation` `avatar_url` and `Message.sender_avatar` now document the opt-in;
  - `ws-protocol.md`: connection path line and the `auth_success` note;
  - no `Electron` mention remains in the contracts.
- **capture-fixtures** sends `X-Avatar-Format: url` on every HTTP call and connects to `/ws?avatars=url`, so the fixtures stay "what the mobile client sees". Mobile clients (Wave 3) must send the header and the query; the contracts say so.

### Important 2: WS nulls legacy non-data avatars for opted-in sockets
- `shapeFrame` now parses and shapes every outbound text frame that contains an `"avatar_url"` or `"sender_avatar"` key, not only frames containing `"data:`.
- `shapeAvatars` applies this rule:
  - the user's own `/api/users/<id>/avatar…` value is kept;
  - a data URL becomes the `/api/...` URL;
  - any other string becomes `null`.
- This covers `auth_success`, `new_message` and `user_updated` (tested), and every other frame, since the wrapper sits on `ws.send`.

### Minors
- **Thumbnail DoS:**
  - `inspect` (header `metadata()`) now runs inside the render slot, raced against a 5 s timeout. Thumbnails, probe, avatar normalize and avatar render all inspect inside the slot.
  - Failures with status 415 or 422 are remembered in memory per `<file id>-<contentKey>` for 10 minutes, bounded to 1000 entries with oldest evicted first. 503 and 429 are not remembered.
  - Cache-miss renders are capped per user via `checkRateLimit('thumb-render:<id>')`, `THUMB_RENDERS_PER_MINUTE`, default 60/min. Over the cap the response is 429 `RATE_LIMITED` with `Retry-After: 60`. Cache hits are unlimited.
- **Avatar retention.** `Avatars.purgeAvatarCache(id)` (that is `removeStale(id, null)`) runs:
  - in `UserService.setAvatar`, which covers both PUT and DELETE `/users/avatar`;
  - in `updateProfile` whenever the avatar changes or is cleared with an empty string.
- **Thumbnail URL versioning.** Thumbnails now send `Cache-Control: private, no-cache` instead of `max-age=604800, immutable`. The client revalidates with the ETag, which already contains the content key, and gets cheap 304s while the file is the same. A reused id therefore never serves a stale thumbnail. I chose this over adding a `?v=` field to message metadata, which would have meant another message-shape change.
- **Legacy avatar normalization.**
  - `PUT /users/profile` data URLs (changed values only) are decoded and run through `normalizeAvatar`: JPEG, at most 256 px, EXIF-oriented, metadata stripped, re-wrapped as a data URL, so the desktop stays compatible.
  - An undecodable payload returns 400 "Фотография профиля должна быть изображением…".
  - An echo of the unchanged stored value is still a no-op.
  - The existing `ws-security.test.js` assertion that stored the 8-byte fake PNG `iVBORw0KGgo=` verbatim now expects rejection, plus a real 4×4 PNG stored as a JPEG data URL. This follows the controller's normalization directive.
- **If-Range order.** If-Range is evaluated before the Range header (RFC 9110 §13.1.5 / §13.2.2). If it doesn't match, Range is ignored entirely and the response is 200 with the full file, even when Range is malformed.
- **Fixture.** The `storedFilename` normalization keeps the real extension (`…_0123456789abcdef.png` in `files.upload-image.json`).

## Covering tests (`server/test/mobile-media.test.js`; RED before the fix: 12 failing, then 0)
- "По умолчанию ответы API несут data URL…": the default, Electron UA, Android UA and `X-Avatar-Format: data` all give data URLs for `/users`, `/auth/me` and message pages. The opt-in (including `URL` in caps) gives URLs for users, me, messages and conversations.
- "PUT /users/avatar …": the opt-in response is a URL; the response without the header is the stored data URL.
- "WebSocket: с ?avatars=url …": an opt-in socket gets URLs in `auth_success` and `new_message`; a default socket and an Electron-UA socket get data URLs.
- "WebSocket с ?avatars=url: старая ссылка … — null": a legacy `https://` avatar is `null` for the opted-in socket in `auth_success`, `new_message` and `user_updated`, and unchanged for a default socket.
- "Старая ссылка … с X-Avatar-Format: url — null, по умолчанию — как раньше".
- "Миниатюра: битую картинку сервер декодирует один раз…": 4 requests in different sizes and formats all return 422, and `renderThumbnail` is called once.
- "Миниатюра: предел отрисовок на сотрудника…": with the cap at 2, the third new render returns 429 with `Retry-After`, and a cached thumbnail is still 200.
- "Миниатюра: клиент перепроверяет кэш по ETag (не immutable)…": the response is `private, no-cache` with no `immutable` and no positive `max-age`.
- "Кэш аватаров: новое фото и снятие фото убирают…": old renditions are removed after a new upload, after a profile change, after a profile clear (empty string) and after DELETE.
- "PUT /users/profile с data URL: фото перекодируется…": a PNG with EXIF is stored as a clean JPEG data URL; an echo is a no-op; a signature-only fake returns 400.
- "Скачивание: If-Range проверяется раньше Range…": `Range: bytes=0-1,4-5` with a non-matching If-Range returns 200 with the full body.
- `ws-security.test.js`: the legacy avatar test was updated as described above.

## Commands and output
- `node --test test/mobile-media.test.js` (RED, before the fix): `pass 20, fail 12`. GREEN: `pass 32, fail 0`; with the profile-clear case added and `ws-security.test.js`: `pass 58, fail 0`.
- `cd server && npm test` (working tree before commit): `tests 714, pass 713, fail 0, skipped 1`.
- `cd server && npm test` (HEAD 89956f6): `tests 714, pass 713, fail 0, skipped 1` (PostgreSQL-only test), about 379 s.
- `cd desktop && npm test`: `tests 460, pass 460, fail 0`.
- `node mobile/dev/capture-fixtures.mjs --write`, then `--check`: `fixtures match the server`. The only fixture diff is the `storedFilename` extension in `files.upload-image.json`.

## Concerns update
- Concern 1 from the main report (UA sniffing, broken browser mode) is resolved: the default is unchanged for everyone.
- New: the iOS and Android clients must send `X-Avatar-Format: url` on every HTTP request and connect to `/ws?avatars=url` to get avatar URLs. Without them they get data URLs, the same as before Task 20. This is documented in `openapi.yaml` and `ws-protocol.md`.
- The thumbnail failure cache and the per-user render limiter are per process and in memory. That matches the existing rate limiter.
