# Task 18 report: server push notifications (ids only) and Task 16 follow-ups

**Status:** DONE_WITH_CONCERNS (concerns in §10). Worktree `m-integration`, branch `mobile/integration`, base `2a83182`. Nothing was pushed.

## Commits

| SHA | Message |
|---|---|
| `96e25b3` | fix(server): apply Task 16 review follow-ups for frame timeout and history |
| `17b8204` | fix(contracts): stop stale edit retries and clamp the server pause |
| `23a3db6` | feat(server): add FCM and APNs push providers with ids-only payloads |
| `c9c0c2c` | feat(server): register push tokens and notify offline recipients |
| `2edcf0f` | docs(contracts): document the push contract, fixtures and owner setup |

## 1. Threat model (summary)

**Assets.** Message content and sender names (must stay inside the perimeter), session integrity, push provider credentials (Firebase service-account key, APNs `.p8` key), device push tokens, availability of the message path.

**Trust boundaries.**
- Mobile client → `POST/DELETE /api/devices/push-token` (authenticated, untrusted body).
- Server → Google (`oauth2.googleapis.com`, `fcm.googleapis.com`) and Apple (`api[.sandbox].push.apple.com`). Everything sent here leaves the perimeter.
- Operator environment → credentials (env vars or secret files). A secret file is external input, too.
- Provider responses → server (status codes and reasons drive pruning and retries).

**STRIDE and mitigations.**

| Threat | Mitigation |
|---|---|
| **Information disclosure through Google/Apple** (the owner's primary concern) | The payload is ids only: `{type, conversationType, targetId, messageId}` or `{type, callerId}`. APNs alert is the fixed placeholder «Новое сообщение». No text, no sender name, no channel name. Enforced three ways: by the builders in `payload.js`, by tests that scan everything sent to the fake providers for the text and the name, and by a fixture test that allows only id keys. What leaks unavoidably: the device token, timing and frequency, and numeric ids. This is documented in `push.md` §1. |
| Disclosure to the wrong device (logout, shared phone, password change) | Each token is bound to user + session (`jti`, token generation, `auth_time`) + optional `device_id`. Logout, device unbind, admin unbind, password change, disabled account and expired session all stop delivery (fail closed: the session is checked before every delivery, and a dead row is deleted). A token re-registered by another user moves to that user, so the previous user's ids no longer go to a phone someone else now uses. This is audited as `push_token_rebound`, and the token itself is not logged. |
| Spoofing / IDOR on the token API | Only the caller's own token can be deleted. A foreign token and a non-existent token get the same `{removed:false}`, so the response is not an oracle. Registration always binds to `req.user`. |
| SSRF / credential exfiltration through config | Provider URLs are constants. `token_uri` from the service-account JSON is ignored. `project_id` is pattern-checked before it goes into the path. The APNs transport rejects any origin other than the two Apple hosts. A device token is regex-checked before it goes into the APNs `:path`. |
| Secret leakage in logs or errors | Credentials come only from env or a secret file, never from the admin console or the DB. Config warnings name the variable, never its value (JSON parse errors are replaced, because V8 quotes input in them). Provider results carry only reason codes; tokens are never logged. No key material is committed: tests generate keys at runtime, plus the published RFC 7515 test vectors. |
| DoS on the message path | Delivery is asynchronous: `notify*` only enqueues, and draining starts on `setImmediate`. Concurrency is bounded (8), the queue is bounded (10 000, then new jobs are dropped with a counter and a throttled warning), retries are bounded (4) and the backoff is capped at 5 min. Provider requests time out after 10 s. A test holds the provider and asserts that REST latency is unaffected. |
| DoS on the token store | 30 req/min per user (`429 RATE_LIMITED`), at most 10 tokens per user (the oldest are evicted), strict field validation (token ≤ 4096 chars). |
| Tampering / repudiation | The `push_token_rebound` audit entry. The admin-visible chat DB stores tokens, but a token is useless without our provider credentials. |
| Elevation (calls) | The VoIP ring path keeps every existing call rule: `can_call`, the DND refusal, the 2-minute pending offer, and `call_answer` only against a real pending offer. Only the pushed offer is replayed, only to the callee, and only while it is still pending. |

**Abuse cases tested:**
- another user deleting a token;
- the same token registered by a second user;
- a flood of registrations (429);
- a malformed token, platform, kind, environment, app_version or device_id;
- a session revoked by password change;
- a provider that answers `invalid`, keeps answering `retry`, or hangs;
- a broken service-account JSON containing a "secret" (not echoed);
- a path-injection `project_id` or bundle id;
- an APNs token with `../`.

## 2. API and payload shapes

**`POST /api/devices/push-token`** (Bearer):

```json
{"platform":"ios"|"android","token":"…","environment":"sandbox"|"production","kind":"alert"|"voip","app_version":"1.0.0","device_id":"…"}
```

- **Response:** `200 {"registered":true,"push_enabled":bool}`. The call is idempotent.
- **Errors:** `400 {error, code}` with one of `INVALID_PLATFORM`, `INVALID_TOKEN`, `INVALID_ENVIRONMENT`, `INVALID_KIND`, `INVALID_APP_VERSION`, `INVALID_DEVICE_ID`. `429 RATE_LIMITED` with `Retry-After: 60`.
- **Additive fields beyond the brief.**
  - `kind`: iOS needs a separate PushKit VoIP token for calls.
  - `device_id`: the same id as in `/auth/knock`, so unbind can find the tokens. A new token for the same device and kind replaces the old one.
- **Field defaults.** `environment` is required for iOS and defaults to `production` for Android.

**`DELETE /api/devices/push-token {token}`** returns `200 {"removed":bool}`.

**Automatic removal:**
- `/auth/logout` removes the tokens of this session (`jti`), plus the tokens of `device_id` when it is given.
- `/auth/device/unbind` removes the device's tokens for this user.
- `/admin/devices/unbind` removes the device's tokens for all users.
- `/auth/refresh` moves the binding to the new `jti`.
- A dead session (token generation, `SESSION_MAX_DAYS`, revoked `jti`) or an inactive or unapproved user gets its tokens deleted at delivery time.

**Payloads** (exactly as in the brief):
- Message: `{type:"message", conversationType, targetId, messageId}`. `targetId` is the conversation **as seen by the recipient**: the channel id, or the peer (author) id for a direct message. That is the same value the client passes to `mark_read` and `GET /messages`.
- Call: `{type:"call", callerId, callId?}`. `callId` is reserved and only emitted when present; the protocol has no call id yet.

| | FCM HTTP v1 | APNs |
|---|---|---|
| message | data-only (values are strings), `android.priority HIGH`, `ttl 86400s`, `collapse_key m-<type>-<id>` | `apns-push-type alert`, topic `<bundle>`, priority 10, expiration +86400 s, `apns-collapse-id`, `aps:{alert:{body:"Новое сообщение"}, sound, mutable-content:1, thread-id}`, plus ids as numbers |
| call | `HIGH`, `ttl 30s` | topic `<bundle>.voip`, `apns-push-type voip`, priority 10, expiration +30 s, payload `{type, callerId}` |

**When the server pushes.**
- **Messages.** A new message (WS or REST, via `publishNewMessage`) goes to every recipient except the author who has **no WS socket on any device** and is not in DND. That is one push per message per capable token. A duplicate `client_msg_id` send does not push. Edits, deletes and reads do not push.
- **Calls.** A `call_offer` to a user with no socket and a call-capable token (Android FCM, or an iOS `voip` token) sends a call push. The caller does **not** get `call_unavailable`. The offer waits in `pendingOffers` (the existing 2-minute TTL), and after the callee's `auth_success` / `wake_state` the server replays the identical `call_offer` frame. After that, signalling is normal.
  - With no capable token, or with push off, the caller gets `call_unavailable` "не в сети" as before.
  - DND keeps the existing desktop behaviour: `call_unavailable` "Не беспокоить", and **no call push**. A "mute" concept does not exist on the server, so there is nothing more to honour.

## 3. Provider design (`server/src/push/`)

| File | Responsibility |
|---|---|
| `jwt.js` | `signJwt` and `signCompact` for RS256 and ES256 using `node:crypto`. ES256 uses `dsaEncoding: 'ieee-p1363'` (raw r‖s, as JWS requires). `none` and HMAC are refused. |
| `payload.js` | Pure builders: `messagePayload`, `callPayload`, `notificationFor` (kind, ids, TTL, collapse key). The only place payload content is defined. |
| `fcm.js` | Validates the service account (type, `project_id` pattern, email, RSA key) and retains only what it needs. OAuth2 JWT-bearer goes to the fixed Google token URL. The access token is cached until 60 s before expiry and fetched by a single in-flight request. A 401 refreshes it and retries once. Results map to `ok` / `invalid` (`UNREGISTERED`, 404, `SENDER_ID_MISMATCH`, 400 "registration token") / `retry` (429, 5xx, network, honouring `Retry-After`) / `failed`. Requests time out after 10 s. |
| `apns.js` | The `.p8` key must be EC P-256; literal `\n` escapes from env are accepted. The provider JWT `{alg ES256, kid}` / `{iss team, iat}` is reused for 50 min (Apple: valid for 60 min, refresh at most every 20). An HTTP/2 session per host via `node:http2` is reused, unref'd and closed when idle; only the two Apple origins are allowed. 403 `ExpiredProviderToken` triggers a new JWT and one retry. 410, `BadDeviceToken`, `DeviceTokenNotForTopic` and `ExpiredToken` mark the token invalid. 429 and 5xx retry. The host is chosen by the token's `environment`. |
| `config.js` | `loadPushConfig(env)` and `describePushConfig()`. A missing or broken credential disables only that provider, with a warning that contains no secret. |
| `token-store.js` | The `push_tokens` table in the chat SQLite DB, with additive `CREATE TABLE IF NOT EXISTS` and indexes. Register runs inside a savepoint: device-token replacement, upsert (ownership moves), then eviction above the per-user cap. Also: own-only remove, remove for logout or device, and session rebind. |
| `push.service.js` | A singleton queue. `notifyMessage` / `notifyCall` only enqueue. A fan-out job per user re-checks presence and DND, checks the user and session, and enqueues one job per token. Each token job delivers, prunes, or retries with exponential backoff (base 1 s ×4, 20 % jitter, ≥ `Retry-After`, cap 5 min, 4 attempts). Also `canRing` (sync), `configureFromEnv`, `idle()` (tests) and stats. |

Hooks in `ws/server.js` (all additive): `attachPresence` in the constructor, `pushToOffline` at the end of `publishNewMessage` (wrapped in try/catch so a push failure never affects the echo or fan-out), `ringByPush` before the "not online" reply in `call_offer`, and `replayPushedOffers` after `auth_success`. Hooks in `api/index.js`: the routes, plus logout, unbind, admin unbind and refresh. In `index.js`: `configureFromEnv()` at startup. Desktop is unaffected unless a desktop user calls an offline mobile user who has a VoIP token (see §10).

**Dependencies:** zero new packages.

## 4. Configuration and owner setup

Environment variables (documented with placeholders in `.env.example`, steps in `mobile/dev/README.md` § "Push notifications"):

| Variable | Meaning |
|---|---|
| `PUSH_FCM_SERVICE_ACCOUNT_FILE` / `PUSH_FCM_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON (path or inline) |
| `PUSH_APNS_KEY_FILE` / `PUSH_APNS_KEY` | APNs `.p8` (path or PEM, `\n` allowed) |
| `PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID` | 10-char Apple ids |
| `PUSH_APNS_BUNDLE_ID` | iOS bundle id; calls go to `<bundle>.voip` |
| `PUSH_MAX_TOKENS_PER_USER` (10), `PUSH_CONCURRENCY` (8), `PUSH_QUEUE_MAX` (10000), `PUSH_MAX_ATTEMPTS` (4) | limits |

With nothing set, startup logs «[Push] Push-уведомления выключены: …», and every send is a no-op.

**Owner steps, Android:**
1. In the Firebase console, create a project and add an Android app with id `com.openmychat.mobile` (the current `applicationId`). `google-services.json` is client config.
2. Project settings → Service accounts → Generate new private key.
3. Set `PUSH_FCM_SERVICE_ACCOUNT_JSON` (Railway variable) or `PUSH_FCM_SERVICE_ACCOUNT_FILE` (a secret file outside the repo).
4. Restart; the log shows "FCM (Android, проект …)".

**Owner steps, iOS:** this needs a paid Apple Developer account.
1. Enable Push Notifications on identifier `kz.centras.centychat`.
2. Keys → create an APNs key, download `AuthKey_<KEYID>.p8` (it can be downloaded only once), and note the Key ID and Team ID.
3. Set `PUSH_APNS_KEY_FILE` (or `PUSH_APNS_KEY`), `PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID` and `PUSH_APNS_BUNDLE_ID=kz.centras.centychat`.
4. Restart. One key serves both sandbox and production; each token declares its `environment`.

## 5. Task 16 follow-ups done

| Follow-up | What changed | Test / vector |
|---|---|---|
| A stale rate-limited edit must not revert a newer edit | Reducer: a sent `edit` op now stays in `ops` as `sending` (no timer) until it is confirmed, with at most one per message. A newer sent edit supersedes the older one. `RATE_LIMITED` matches only the last sent edit (same text) and re-queues it, unless a newer edit or delete is pending. A stale one (already superseded) is ignored. A record with the same id and text confirms it. A final error removes it (`EDIT_REJECTED`). Disconnect or restart drops it, and it is not resent. Contract: §3.2, §6.1–6.3, §7.3, §7.10, and new T54. | new vector **70**; 25, 26, 49 and 66 updated (only the `ops` persist and final `ops` changed, each diff reviewed) |
| Clamp `retry_after_ms` ≤ 30000 | `RATE_LIMITED_MAX_RETRY_MS = 30000` for send, delete, cancel and edit | new vector **68** |
| `snapshotTotals` ignores tombstones | Deleted foreign messages newer than `last_message_ids` are not added (own deleted channel messages still reset the count). Contract §6.3 and §7.8. | new vector **69** |
| Frame timeout only on the queued path | `runFrame(..., {timeout})`: only `enqueueFrame` arms the 30 s race. ws-protocol §2.3 wording updated. | `Т18: таймаут обработчика…` |
| History row uses the post-await `current` | `editMessage` re-reads the full row after the settings await and writes history from it (also `NOT_FOUND` if the row vanished). `deleteMessage` writes history and the tombstone from `current`. | `Т18: запись истории правки…`, `…удаления…` |
| Doc wording | "это **не окончательный** отказ" (delivery-state §6.3); `mark_read` beyond the socket queue is dropped **silently** (ws-protocol §2.3); the §7.3 rate-limit paragraph no longer says "silently dropped" for G2 servers and includes `cancel_message`; `retry_after_ms` clamp noted | — |
| Tests for the 3 untested branches (my selection; the brief did not list them, so I picked from a coverage run of Task 16 code) | 1. `runFrame` catch: `INTERNAL_ERROR` with correlation for ack frames, the generic error for others, nothing leaked. 2. A WS publish failure after INSERT still echoes to the author. 3. Queued frames of a revoked socket are dropped, while a normally closed socket's queued frames are processed as the author. Plus the cancelled-key cap boundary (exactly N kept and blocking; N+1 evicts exactly the oldest). | 4 `Т18:` tests |

## 6. RED/GREEN evidence

- **Server follow-ups.** RED: the first full run with the new tests appended gave 615 tests, 611 pass, **3 fail**:
  - the timeout test failed with "[WS] кадр presence обрабатывается дольше 60 мс";
  - edit history was `['Версия 0','Версия 0']` (expected `'Версия 2'`);
  - delete history was `['edit:До правки','delete:До правки']`.

  The 4 branch-coverage tests passed on existing code, as expected. They pin down behaviour; they do not change it. GREEN: 49/49 in `mobile-delivery-gaps` and `message-edit-delete`.
- **Reducer.** New vectors 68–70 run against the base reducer (`HEAD` copy) **fail**:
  - 68 scheduled ticks at 3 601 100 and 46 300 and paused ops until 100 001 199;
  - 69 gave unread `{channel:5:4, direct:3:1}` (expected `{channel:5:3}`);
  - 70 **re-sent the stale "А" after "Б"** (the revert).

  With the new reducer, all 70 vectors pass.
- **Push.** RED: `push-providers.test.js` failed with `Cannot find module '../src/push/jwt'`; all 18 tests in `push-notifications.test.js` failed (the module was missing). GREEN: 16/16 and 18/18.
- **Fixtures.** RED: the drift test, extended first, failed on the missing `devices.*` / `push/*` fixtures. GREEN after `capture-fixtures --write`, and `--check` reports "fixtures match the server".

## 7. Test summary

- `cd server && npm test`: **653 tests, 652 pass, 0 fail, 1 skipped** (baseline before the task: 608 / 607 pass / 1 skipped).
  - Added: 7 server follow-up tests, 3 reducer vectors, 16 provider unit tests, 18 push integration tests and 1 fixture test.
  - `push-providers.test.js` and `push-notifications.test.js` were added to the explicit list.
- `node mobile/dev/capture-fixtures.mjs --check`: "fixtures match the server".
- The JWT known-answer test: RS256 signing reproduces the RFC 7515 A.2 JWS byte-for-byte. ES256 is checked against the RFC 7515 A.3 key: the RFC signature verifies as P1363, and our signature is 64 bytes and verifies.
- `openapi.yaml` now parses (js-yaml). **HEAD already failed to parse** at the Task 16 403 description (an unquoted `code: NOT_CHANNEL_MEMBER`); I fixed that too.

## 8. Contract

- `mobile/contracts/push.md` (new): principle, registration, when pushes are sent, payloads per provider, collapse/TTL/priority, foreground vs background behaviour (Android FCM service, iOS NSE + CallKit/PushKit rules, the 10 s replay rule for calls), reliability.
- `openapi.yaml`: `/devices/push-token` POST and DELETE, the `PushTokenRegisterRequest` and `PushTokenRegisterResponse` schemas, and notes on logout and unbind.
- `ws-protocol.md` (call push exception, §7 fixture pointer), `delivery-state.md`, `parity-matrix.md` and `fixtures/README.md` (`push/` directory, manifest `kind: "push"`).
- New fixtures:
  - `http/devices.push-token-register|invalid|delete.json`;
  - `push/fcm.message.direct|channel.json`, `push/fcm.call.json`;
  - `push/apns.message.direct|channel.json`, `push/apns.call.json`.

  The push fixtures are built by the server code (`fcmMessageBody`, `apnsRequest`) inside `capture-fixtures.mjs`, with a fixed clock and placeholder device tokens. The `token` normalizer now replaces only JWT-shaped values.

## 9. Files changed

- **Server:**
  - `src/push/{jwt,payload,fcm,apns,config,token-store,push.service}.js` (new)
  - `src/ws/server.js`, `src/api/index.js`, `src/db/index.js`, `src/index.js`, `src/services/message.service.js`
  - `package.json`
  - tests: `test/push-providers.test.js`, `test/push-notifications.test.js`, `test/helpers/rfc7515-vectors.json` (new), `test/mobile-delivery-gaps.test.js`, `test/mobile-contract-fixtures.test.js`
- **Contracts:**
  - `push.md` (new), `openapi.yaml`, `ws-protocol.md`, `delivery-state.md`, `parity-matrix.md`
  - `reference/delivery-reducer.mjs`
  - `fixtures/reducers/{25,26,49,66}.json`, `68–70.json` (new), `fixtures/reducers/README.md`
  - `fixtures/README.md`, `fixtures/manifest.json`, `fixtures/http/devices.*.json`, `fixtures/push/*.json` (new)
- **Dev:** `mobile/dev/capture-fixtures.mjs`, `mobile/dev/README.md`
- **Root:** `.env.example` (placeholders only)

## 10. Concerns

1. **Platform contract changes (Wave 2 and push tasks).**
   - Fixture decoders walk `manifest.json` and must handle the new `kind: "push"` (`provider`, `trigger`), plus the routes `POST /api/devices/push-token` and `DELETE /api/devices/push-token`. Android's `ContractFixturesTest` currently errors on unknown kinds and routes, so iOS and Android need small mapping updates when they merge.
   - Reducers must implement the new edit rule: a sent `edit` stays in `ops` as `sending` (T54). This changes vectors 25, 26, 49 and 66.
2. **Call behaviour changes for callers when the callee is offline but has a VoIP-capable token.** Instead of an immediate `call_unavailable`, the caller rings until their own timeout (desktop has `RING_TIMEOUT_MS`), and the offer is replayed when the phone connects. If the caller hangs up first, the woken phone gets no offer and must end the CallKit/full-screen call after 10 s (`push.md` §5); there is no "call cancelled" push. A cancel push (`{type:"call_end", callerId}`) would be a small follow-up if the owner wants a faster dismissal.
3. **Metadata still reaches Google/Apple:** timing, frequency, device token, and numeric ids (including the peer user id in direct messages and `callerId`). This is inherent to push and is documented, but the owner should know that ids are not hidden.
4. **Push tokens live in the chat SQLite DB.** Super-admins can therefore see them in DB studio and backups. They are useless without our provider credentials, but they are personal device data. Retention: rows are removed on logout, unbind, password change, user deactivation and provider rejection, and are capped at 10 per user. There is no time-based expiry for tokens that are never used again.
5. **The queue is in memory.** A restart loses pending pushes (messages are not lost; clients sync). DND is also in memory (pre-existing), so after a server restart a DND user who has not reconnected receives message pushes until their client sends `set_dnd` again.
6. **The stale-edit fix has a documented residual.** If the newer edit is dropped *silently* (no `RATE_LIMITED` reply because of the reply budget) and the older edit's `RATE_LIMITED` arrived before the newer one was sent, the older one is resent. The result is visible to the user, as with any lost edit.
7. **The "3 untested branches" were not enumerated in the brief.** I chose them from a coverage run (listed in §5); the controller may have meant different ones.
8. **No real provider round-trip was possible here** (no credentials). FCM and APNs are verified against their documented request and response formats with injected transports. The first production use should be watched in the logs (`[Push] …`).


---

# Fix round 1/5 (review: 2 Important + Minors)

## Commits

| SHA | Message |
|---|---|
| `80c3ca1` | fix(server): re-validate push tokens on each attempt and narrow pruning |
| `8c7eaee` | fix(server): tie call pushes to the live offer and tell the caller when undeliverable |

Bisect note: `80c3ca1` changes `canRing` to async and adds the `callOffer` hook, which `8c7eaee` wires into `ws/server.js`. Call pushes only work, and the call tests only pass, at `8c7eaee`. Review both commits together.

## Important 1: queued and retried pushes re-validate the token row on every attempt

`push.service.js` `deliver()` now starts every attempt, including retries minutes later, with these checks:

- It re-reads the row by token (`PushTokens.get`).
- It requires `row.user_id === job.userId` and the same `session_jti` that was fanned out.
- It re-runs `activeUser` (active and approved) and `sessionAlive` (token generation, `SESSION_MAX_DAYS`, revoked `jti`).
- After those awaits it re-checks `stillWanted` (socket, DND, call still pending).

If any check fails, the job is dropped. A dead session also deletes the row. `invalid` deletes only while the row is still owned by the same user (`deleteOwned`).

Tests:
- `Повтор доставки перепроверяет владельца…`: the provider answers `retry`, the token is re-registered as bob, and the provider is called once in total.
- `…сеанс: сотрудник вышел…`: `retry`, then alice logs out with the registering session, and the provider is called once in total.

## Important 2: call-push lifecycle

**(a) Calls follow the pending offer.**
- `stillWanted` for call jobs requires `presence.callOffer(callerId, calleeId)` to be the same offer (same `at`) and still pending, and requires the time to be before `offerAt + 30 s`.
- The provider expiry comes from the offer time: `notification.expiresAtMs = offerAt + 30 s`. APNs `apns-expiration` uses it, and the FCM `ttl` is the remaining seconds.
- A retry whose delay would cross the window is not scheduled.

**(b) The caller gets `call_unavailable`** «Сотрудник сейчас не в сети», and the offer is cleared, in either case:
- `canRing` is now async and counts only live rows (active user, live session); it deletes dead rows.
- The fan-out finds no live row, or every token delivery of the call ends `invalid`, `config`, `failed`, exhausted or out of window. Each call carries a delivery group; the first accepted delivery, or a moot outcome (offer gone, callee online), closes it.

If the callee connects during the async check, the server takes the normal online path.

**(c) Short memory of ended push offers.** `endedPushOffers` (60 s) records push offers that ended before the callee connected:
- caller `call_end` → `cancelled`;
- caller disconnect → `connection_lost`;
- expired offer → `timeout`;
- undeliverable → `unavailable`.

On the callee's `auth_success` the server sends `call_end {senderId: callerId, senderName, reason}`. An unmatched `call_answer` now gets `call_end` back (the remembered reason, or `no_call`), and no pair is created.
- New fixture: `ws/call_end.no_call.json`.
- `push.md` §3 gains a six-step lifecycle and the iOS/Android handling of `call_end`.
- `ws-protocol.md` covers `call_offer`/`call_answer` and the §7 fixture map.

Tests:
- `Звонок: вызывающий сбросил…`: retry, then `call_end` → no second push, and the callee connecting gets `call_end` `cancelled`.
- `…срок у поставщика — от времени вызова…`: the same `expiresAtMs` across attempts with a non-increasing ttl; with a backoff longer than the window, the caller gets `call_unavailable` after one attempt.
- `…живого устройства нет…`: a dead session gives `call_unavailable`, no provider call, and the row is deleted.
- `…все доставки не удались…`: FCM `invalid` + APNs `failed` give `call_unavailable`, the offer is cleared, and the callee gets `call_end` `unavailable`.
- `Ответ на вызов, которого нет…`: `call_end` `no_call`, no pair.
- The existing test "Звонок отменён до входа…" now also asserts `call_end` `cancelled`.

## Minors

- **Pruning.**
  - Prune only on FCM `UNREGISTERED`, APNs 410 and APNs `BadDeviceToken`.
  - New status `config` for FCM `SENDER_ID_MISMATCH` and a bare 404, and for APNs `DeviceTokenNotForTopic`, `TopicDisallowed`, `BadTopic`, `InvalidProviderToken` and `MissingProviderToken`. It is logged once per provider and reason with `console.error` «ОШИБКА НАСТРОЙКИ», and tokens are kept.
  - FCM 400 "registration token" is now `failed` (no prune). APNs `ExpiredToken` is `failed`.
  - Tests: the updated provider case tables, and `Ошибка настройки поставщика не удаляет токены…`.
- **APNs JWT refresh.** On `ExpiredProviderToken`, the JWT is refreshed only if `cached.jwt` is still the JWT that failed. Test: `ExpiredProviderToken не обновляет токен, если его уже обновил параллельный запрос`.
- **FCM call body.** The whole body is now asserted with `deepStrictEqual`.
- **Logout leftovers.**
  - A legacy (no `jti`) logout removes the user's no-`jti` rows, on that device if one is named.
  - `rebindSession` remembers old→new `jti` for 10 min, so a registration made with the old token during the refresh grace binds to the new session.
  - Tests: `Продление: регистрация старым токеном в паузу…` and `Выход сеансом старого формата…`.
- **`push.md` §2:** one line saying that possession of the token string is the device proof.
- **gitleaks:** a root `.gitleaks.toml` (`[extend] useDefault = true`) plus an allowlist for `^server/test/helpers/rfc7515-vectors\.json$` only.
- **`delivery-state.md` §7.10:** a sentence documenting the server cancelled-key cap as accepted residual risk (controller ruling).

## RED/GREEN

- **RED:** I ran the new and updated tests against the pre-fix sources (`git checkout HEAD -- src/push src/ws/server.js`, restored afterwards): 46 tests, 31 pass, **15 fail**. The 15 are exactly the new or changed tests: 4 provider tests, 10 new integration tests and the strengthened "Звонок отменён…" test.

  Note: in this round I wrote the implementation before the tests. RED was demonstrated afterwards against the previous code rather than before writing it.
- **GREEN:** `push-providers` 18/18, `push-notifications` 28/28.

## Commands and output

- `cd server && npm test` gives **665 tests, 664 pass, 0 fail, 1 skipped**.
- `node mobile/dev/capture-fixtures.mjs --check` prints `fixtures match the server`.
- Reducer vectors: 70/70 (unchanged).

## Remaining notes

- The `call_answer` → `call_end` reply also applies to desktop answering a stale offer, which is harmless: desktop ends its call view.
- `endedPushOffers` lives in memory and is bounded by 60 s TTL pruning on every insert.
