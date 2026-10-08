# Final review (Task 11): server, CI, mobile/dev, hygiene and security

Range: `master..mobile-release-parity-impl` (HEAD 07420d0), 406 commits, 976 files.
Area: `server/`, `.github/`, `mobile/dev/`, hygiene and security across the whole diff.
Reviewer: opus (read-only; no tracked files changed).

## Verification run

| Check | Result |
|---|---|
| `cd server && npm test` | **793 tests: 792 pass, 0 fail, 1 skipped** (the PG-only import test, which needs `TEST_DATABASE_URL`). Took 370 s. |
| `npm audit --omit=dev --audit-level=high` | **found 0 vulnerabilities**. proxy-addr is 2.0.8 (GHSA-jqcg-44mw-7w3h fixed in badffdd). |
| `npm run test:pg` (whole suite against a throw-away `postgres:16-alpine` container; production identity runs on PG) | **793 tests: 784 pass, 9 fail.** 3 failures are **pre-existing**: running master's code against PG fails the same 3 (`login-bruteforce.test.js:476,492`, `update-routes.test.js:168`). 6 failures are **new branch tests that depend on SQLite timing**, see Minor 18. No registration, block, account-deletion or report test fails on PG, so that SQL is verified on PostgreSQL. |
| Production image dependency check: `node:24-alpine` + `npm ci --omit=dev --ignore-scripts` from this lockfile, then `require('sharp')` with a real JPEG encode and `require('nodemailer')` | **SHARP_OK 0.35.5 / libvips 8.18.7, NODEMAILER_OK.** The musl prebuilt loads without install scripts, so the new top-level `require('sharp')` will not crash-loop on Railway. |

## Critical

None.

## Important

### I-1. The `allow_registration` setting does not gate the new email-code registration
(the desktop reviewer asked me to cover this; I verified it in the code)

- **Where:** `server/src/services/registration.service.js:128-197` (`requestRegistration`) and `:203-285` (`verifyRegistration`), and the routes at `server/src/api/index.js:664-698`. Nothing on the new path reads `allow_registration`. The only places that read it are the legacy `POST /auth/register` (`api/index.js:618-623`, which returns 403 «Самостоятельная регистрация отключена администратором»), `/settings/info` (`:1799`) and the security monitor.
- **Failure scenario:**
  - Production keeps the default `allow_registration='false'` (`db/identity/index.js:469,547`).
  - The owner sets SMTP on Railway (for example to test mail) and merges.
  - Anyone on the internet who can reach the server can now file self-registrations from the mobile app. An address on the allowlist (or in `REGISTRATION_ALLOWED_EMAILS`) gets an active account and a token immediately.
  - Meanwhile the desktop admin modal (`AdminUserModal.jsx:2197-2203`) tells the super-admin «Самостоятельная регистрация сейчас отключена — новых заявок не появится».
  - The security monitor (`security-monitor.service.js:324-326`) reports registration as «Выключена» / ok.
  - The admin's off switch is therefore ineffective, and the dashboard misreports the attack surface. Today the only real gate is whether SMTP is configured.
- **Intended interaction:**
  - `registration.md` does not mention `allow_registration` at all; the contract is silent.
  - The older flow (`openapi.yaml:322-362` for `/auth/register`) defines the setting as the master switch for self-registration: «Доступно только при включенной настройке `allow_registration: 'true'`», otherwise 403.
  - The allowlist is described as a refinement *inside* self-registration: it decides "activate immediately" versus "pending" (`registration.md` §1.2, §2).
  - Nothing in the docs makes the allowlist an exception to the master switch. The coherent reading is therefore: switch off means no self-registration of any kind, allowlisted or not. When the switch is on, an allowlisted address is approved immediately and every other address goes to pending.
- **Fix (additive and desktop-compatible):**
  1. At the top of `requestRegistration`, after field validation and before the SMTP check, the rate limits and any DB lookups, add `if ((await SettingsService.getSetting('allow_registration','false')) !== 'true') throw new RegistrationError(403, 'Самостоятельная регистрация отключена администратором', 'REGISTRATION_DISABLED')`.
  2. Add the same check at the top of `verifyRegistration`. The switch can be turned off while codes are still live, and those codes must not then create accounts.
  3. Add one row to `registration.md` §1.1/§1.2: `403 { error, code: "REGISTRATION_DISABLED" }`.
  4. Mobile clients should hide the «Регистрация» entry when `GET /api/settings/info` returns `allow_registration: false` (the field already exists; the desktop `LoginView.jsx:287` does this), and map the code to that text.
  5. Add tests: setting off gives 403 for both endpoints and sends no mail; setting on keeps the current behaviour.

  This changes no existing response and no desktop path; the desktop toggle starts meaning what its banner says. If the owner wants an "invite-only" mode later (allowlisted addresses may self-register while open registration is off), add it as a separate, explicit setting. Do not overload the existing one.
- **Release note:** before merging to master, the owner must decide whether to turn `allow_registration` on in production. Once fixed, merging no longer opens registration by itself.

### I-2. Blocking is not enforced on calls, «Побудка» (wake) or message edits
- **Where:**
  - `server/src/ws/server.js:1221-1258`: the `call_offer` path, `placeOffer` at `:1847`.
  - `server/src/ws/server.js:495`: `sendWake`.
  - `server/src/ws/server.js:1045-1052` together with `MessageService.editMessage` (`message.service.js:~635-665`).
  - The only block checks in the WebSocket layer are the typing indicator (`ws/server.js:1172`), plus send (`message.service.js:424-429`) and the read paths.
- **Failure scenarios:**
  - (a) User B is blocked by user A and keeps calling A. `call_offer` reaches every socket A has, and through `PushService.notifyCall` it also wakes A's phone with a call push (VoIP/FCM). Each call rings for 30 s.
  - (b) B sends a «Побудка» to A once a minute: a sound and alert on A's desktop.
  - (c) B edits an old direct message to A into abusive text. The server sends `message_updated` with the full new text to A's sockets (`conversationRecipients(updated)`). That contradicts `registration.md` §4 («сообщения заблокированного не отдаются блокировщику … ни по WebSocket»).
  - The mirror cases also hold: the blocker can still call, wake and edit toward the blocked user, while the contract says the blocker cannot write until they unblock. This weakens the App Store 1.2 block feature; reviewers test exactly this, and it gives a harassment channel.
- **Fix:**
  - At the start of the `call_offer` handling, check `Safety.isBlockedEitherWay(currentUser.id, targetUserId)` and reply `call_unavailable` with the generic `NOT_ONLINE_REASON`, so the reply does not reveal the block.
  - In `sendWake`, return `wake_error` `invalid_target`.
  - In `editMessage`, for `conversation_type='direct'`, throw `DM_NOT_ALLOWED` when the pair is blocked either way, as `sendMessageIdempotent` does. Alternatively, skip the recipient when fanning out `message_updated`.
  - Add three tests to `self-registration.test.js` next to the existing block tests.
  - All of this is additive; the desktop client already handles `call_unavailable`, `wake_error` and the edit error frame.

### I-3. Brute-forcing the 6-digit code is affordable for an attacker with many IP addresses when a whole `@domain` is on the allowlist
- **Where:** `registration.service.js:155-159` (10 requests per IP per hour, 3 per email per hour), `:210` (60 verifies per IP per 10 min), `:22` (5 attempts per code), `:23` (`MAX_UNCONFIRMED=2000`). There is no global limit on requests or on failed verifies.
- **Failure scenario:**
  - The allowlist contains `@company.kz`.
  - The attacker files requests for made-up mailboxes such as `x123@company.kz`. The mail bounces, and the attacker never needs the mailbox.
  - Each request allows 5 guesses at 1/10^6 each.
  - Per IP that is 10 requests per hour, so 50 guesses per hour; about 20,000 IP-hours give an expected success.
  - A rented pool of about 1,000 residential IPs gets an approved account with a token, default channels and the employee directory in about a day. The global ceiling of 2000 live requests × 5 guesses still allows about 60k guesses per hour.
  - Each attempt also sends a mail from the company SMTP, which hurts sender reputation.
  - With exact-address allowlist entries only, the risk is negligible: an unknown address gets a pending account that an admin must approve.
- **Fix (cheap):**
  - Add a process-wide limit in `requestRegistration`, for example `checkRateLimit('reg-req-global', { maxAttempts: 60, windowMs: 3600000 })`.
  - Add a global budget for failed verifies, for example 300 per hour. When it is exceeded, return 429 and log one security-monitor warning.
  - Optionally add a per-domain request limit.
  - If none of this goes in before release: **release with exact-address allowlist entries only** (do not add `@domain` patterns or set `REGISTRATION_ALLOWED_EMAILS` to a domain).

## Minor

1. **The account-deletion broadcast leaks the erased PII.** `api/index.js:2005` broadcasts `user_updated` built from `{...req.user, full_name: 'Удалённый сотрудник', …}`, so the old `username`, `email`, `phone`, `job_title`, `extension` and `company` go to every connected socket. iOS consumes `user_updated` (`WebSocketEvents.swift:292`) and keeps them. This contradicts `registration.md` §3. Fix: broadcast `toPublicUser(await UserService.getUserById(req.user.id))` after the anonymising UPDATE. One line; recommended before release.
2. **Account deletion keeps the resized avatar copies.** `account.service.js:66-75` sets `avatar_url = NULL` directly and never calls `Avatars.purgeAvatarCache(uid)`. The files `uploads/.avatars/<id>-<ver>-<s|m>.jpg` stay on disk and in backups. They are not served (404), but this is a retention problem. Fix: `await require('../media/avatars').purgeAvatarCache(uid)` after the UPDATE.
3. **`purgeExpired()` runs only at boot.** `bootstrap.js:63`, `registration.service.js:288`. Expired and consumed `registration_requests` rows, holding emails and scrypt hashes of unverified passwords, pile up until the next restart. The unconfirmed cap counts only live rows, so this is not a denial-of-service risk. Fix: call it opportunistically in `requestRegistration` (throttled), or on an hourly unref'd timer.
4. **`verify` consumes the code before its capacity and uniqueness checks.** `registration.service.js:234-253`. A pending-cap 429 or a USERNAME_TAKEN race burns a valid code, and the user has to start over. `verify` 409 is also not in the contract table. Accept, or move the checks before consumption.
5. **Every INSERT failure in `verify` maps to 409 USERNAME_TAKEN.** `registration.service.js:271-274`. A real database error on PostgreSQL would surface as "логин занят" and hide the bug. Fix: map only unique-violations (pg `23505` / SQLite `SQLITE_CONSTRAINT_UNIQUE`) and rethrow the rest, which then becomes the 500 path.
6. **Re-approving a legacy rejected user leaves the account inactive.** `auth.service.js:634`: `approveUser` now also accepts `rejected`, and `rejectUser` no longer sets `is_active=0`. Rows rejected under master's code have `is_active=0`, so re-approving them produces an approved account that is still disabled. Fix: `SET approval_status='approved', is_active=1` in `approveUser`. Low impact.
7. **A rejected applicant can never re-apply with the same email or username** (`EMAIL_TAKEN`), and only a super-admin can clean that up. Accept as product behaviour; document it for admins.
8. **Anonymous email and username enumeration** through 409 `EMAIL_TAKEN`/`USERNAME_TAKEN` on `register/request`. This is in the contract and limited to 10 per IP per hour. Accept.
9. **The dev stand inherits `process.env`.** `mobile/dev/stand.mjs:76-84`. If a developer runs it under `railway run` or with `DATABASE_URL`, `SMTP_*`, `FCM_*` or `APNS_*` exported, the stand's server uses those real settings, and `seed.mjs` would create alice, bob and a changed admin password on the real identity DB. Fix: delete `DATABASE_URL`, `POSTGRES_URL`, `SMTP_*`, `FCM_*`, `APNS_*`, `JWT_SECRET` and `REGISTRATION_ALLOWED_EMAILS` from the child env, or refuse to start if they are present.
10. **Dev defaults point at port 2004, the owner's local server.**
    - `stand.mjs:115,148` and `dev.env`: `SERVER_PORT=2004`. This is protected by `assertPortFree`.
    - `tls-proxy.mjs:90` run alone is not protected: it would publish the owner's real server on `0.0.0.0:8443`.
    - `seed.mjs:51` run alone targets `127.0.0.1:2004` and tries dev admin passwords, which can trigger lockouts.
    - Fix: default to `SERVER_PORT=2014` or a free port, and require an explicit base URL for `seed.mjs`.
11. **The dev proxy listens on all interfaces.** `tls-proxy.mjs:26`: `listenHost='0.0.0.0'`, with documented seed passwords. Anyone on the same LAN or Wi-Fi can use the stand. It is acceptable for emulator access, but consider `127.0.0.1` by default plus an opt-in.
12. **The dev CA is not name-constrained.** `make-dev-ca.sh:40-43`. Whoever has `dev-ca.key` can mint certificates for any host that a device trusting the dev CA will accept; CI simulators are ephemeral, developer simulators are not. Fix: `nameConstraints = critical, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:10.0.2.2/255.255.255.255`.
13. **Some actions are not pinned to a SHA.** `.github/workflows/mobile-android.yml:51,77,85` (new) and `:22,36` (pre-existing) use `actions/setup-java@v4` and `actions/upload-artifact@v4` by tag. Every other action in the repo is pinned. Pin these by SHA.
14. **The screenshot job puts its token in the remote URL.** `mobile-ios.yml:252` uses `https://x-access-token:${GH_TOKEN}@github.com/...`. GitHub masks the token, but prefer `git -c http.extraheader="AUTHORIZATION: bearer …"`.
    - The job is otherwise sound: push events only (no fork pull requests), `contents: write` only on this job, a concurrency group, no `pull_request_target`, and filenames quoted.
    - The orphan `ci/ios-screenshots` branch grows with every push (PNGs per SHA), and a plain `git clone` fetches it. Add a pruning policy (for example keep 30 SHAs), or document `--single-branch`.
15. **`DATA_DIR` env override** (`config/index.js:7`) is a new production-relevant variable. If it is ever set on Railway, the server opens an empty database. Confirm that no `DATA_DIR` variable exists in the Railway service before merging.
16. **The new `sharp` dependency loads eagerly.** `media/images.js:19` does a top-level `require('sharp')`, and `api/index.js` loads it at startup. It is verified working on node:24-alpine x64 (see table). Hardening: lazy-load it, so that a broken native module degrades to 503 on image endpoints instead of a crash-loop.
17. **Scoped admins miss live registration events** (Task 1 note). `ws/server.js:2049-2056`: `broadcastToAdmins` skips scoped admins, although `GET /admin/registrations` shows them in-scope rows. Self-registered users have `department_id=NULL`, so scoped admins never see or act on them anyway. Only legacy desktop registrations with a department miss the live ping. Accept (UX only; the list refreshes on open).

18. **Six new tests fail on PostgreSQL because they assume SQLite timing.** They pass on SQLite, which is what CI runs.
    - The failing tests: `push-notifications.test.js:499,591,802,842,857` and `multi-device.test.js:601`.
    - Cause: they send `call_offer` and then immediately `await push.idle()` or read `wsServer.pendingOffers`. On PostgreSQL the handler is still waiting on the identity lookups (`freshUser`, `callDevices`), so the offer has not been queued yet. `fcm.calls` is 0, and `pendingOffers.get(...)` is `undefined` (`reading 'at'`).
    - In the `multi-device` case, the delete wins as designed, but the edit frame the test waits for is never sent.
    - The production logic is the same either way; only the order of events in the tests changes.
    - Fix: wait for the condition (`waitCalls(fcm, 1)`, `waitFor(() => wsServer.pendingOffers.has(...))`) instead of `push.idle()`. Also consider a nightly `test:pg` job in CI. The 3 pre-existing master failures on PG deserve a ticket as well.

## Checklist results (areas with no findings beyond the above)

- **Migrations.** All are additive: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` behind `PRAGMA table_info`, and a one-time `change_seq` backfill above `sync_state.last_seq` before the UNIQUE index is created. Identity tables are created on PG with `GENERATED BY DEFAULT AS IDENTITY`. Rolling back to master's code after the migration is safe, because extra columns and tables are ignored. The backfill deliberately leaves `updated_at` alone, so the desktop does not mark the whole history «Изменено». `mobile-delivery-migration.test.js` covers an existing database.
- **Desktop API compatibility.** Every change is additive:
  - error frames gain `code`, `retryable` and correlation fields; `message` and `text` stay as before;
  - REST send returns 200 for a duplicate `client_msg_id`, which the desktop never sends;
  - the new `afterId` is validated only when present;
  - avatar URLs only appear for `X-Avatar-Format: url` or `?avatars=url`;
  - `/api/health` is added; `/health` is unchanged;
  - the desktop does not consume `user_updated`.
- **Registration crypto and logging.**
  - The code comes from `crypto.randomInt`, is stored only as an HMAC-SHA256 keyed by the JWT secret, and is compared in constant time.
  - Attempts are counted atomically before the comparison (`UPDATE … attempts < 5 RETURNING`), and the code is single-use.
  - The 410 responses cannot be told apart, and the `request` response does not reveal allowlist membership.
  - The password is hashed at `request` and the stored hash is cleared after verify.
  - Codes are never logged: the mailer logs only a masked recipient and SMTP error codes, and the HTTP log has method and path only (confirmed in the 793-test log).
- **SMTP.** It fails closed (503 if not configured; send failure deletes the request and returns 503 `EMAIL_SEND_FAILED`). `rejectUnauthorized` keeps its default of true with no override, STARTTLS is required unless implicit TLS is used, and TLS is 1.2 or newer. CR/LF are stripped from headers, and the address regex is ASCII-only.
- **Pending and rejected login.** These codes are returned only after the password checks out (no enumeration) and do not count as failures. `deleted` returns the normal invalid-credentials answer. Token verification (`auth.service.js:320`), device secrets, push and messaging all require `approved`.
- **`DELETE /users/me`.**
  - It acts only on `req.user.id` (no IDOR) and requires the password, with a fail limit of 5 per lockout window, 10 per hour and a hash slot.
  - The last super-admin cannot delete themselves; the `LIKE` match fails closed.
  - It bumps `token_version`, deletes pairings, trusted sources and push tokens, and closes sockets.
  - Remaining gaps: Minor 1 and 2.
- **Reports and blocks.** IDs come from the body or path but always act for `req.user`. A message can be reported only if the reporter can see it, and an inaccessible message gets 404. Admin listing and closing are super-admin only. Inputs are bounded, with a per-user cap and rate limit. Gaps: I-2.
- **Push.**
  - Payloads carry ids only (`push/payload.js`).
  - A token belongs to one user; `DELETE` removes only your own, and its answer does not show whether a token belongs to someone else.
  - The token is tied to the session (jti, token_version, auth_time) and dropped on logout, unbind, refresh-rebind, deactivation or deletion.
  - Delivery re-checks that the user is active, approved and in a live session.
  - Real FCM/APNs delivery has not been tested (no keys); accepted.
- **CI.**
  - No `pull_request_target` anywhere.
  - The workflow-level permission is `contents: read`; `pull-requests: read` was added for gitleaks.
  - Secrets: only `GITHUB_TOKEN`.
  - gitleaks allowlists only `server/test/helpers/rfc7515-vectors.json`. I verified that the file holds the public RFC 7515 A.2/A.3 keys (`d` values match the RFC).
- **Dev stand isolation.** The server has no dev-stand code path; the only addition is the optional `DATA_DIR`. The stand binds the server to `127.0.0.1`, sets `TRUSTED_PROXY_IPS` to loopback, and keeps certificates and data gitignored (`.gitignore:56-57`).
- **Hygiene.**
  - No committed `.env`, private keys, keystores, `google-services.json`, `.idea/`, `.gradle/`, `local.properties` or `toolsandroid-sdk/`. `mobile/android/.idea/` is untracked only.
  - `mobile/dev/dev.env` holds only ports.
  - There are no large binaries in the range. The largest tracked file is the pre-existing 1.3 MB `docs/OpenMyChat-презентация.html`.
- **Production hostname in tests.** It does not appear in any server test or in CI. Mobile tests use it only in string assertions on configuration; mobile reviewers confirm there is no network use.
- **`.agents/skills/`.**
  - The branch adds 60 third-party agent-skill files (17k lines) through de46bb6. master already tracks `.agents/` (the obsidian skills).
  - They are pinned by hash in `skills-lock.json`, excluded from the Docker image (`.dockerignore`), and contain no `curl|sh`, keys, or "ignore previous instructions" text.
  - Ruling: **accept**. It is tooling, not product, and is consistent with master. Optionally move it out of the product repo later.
- **`docs/superpowers/sdd-archive` and other docs.**
  - The only addresses in the docs are `noreply@anthropic.com`, loopback and `10.0.2.2`.
  - The JWTs are placeholders (`signature-placeholder`). There are no production credentials, no database URLs, and no password literals.
  - The production hostname is mentioned only as policy («never send test traffic»).
  - Ruling: **accept**.

## Ledger items in my area: rulings

| Ledger item | Ruling |
|---|---|
| Task 1 note: `broadcastToAdmins` skips scoped admins while the modal shows them registrations | **Accept** (Minor 17). Self-registered users have no department, so scoped admins cannot act on them. |
| Controller CI fix e2a620c, "final review must look at it" | CI/test part (RegistrationFlowUITests, UserPathQATests) looks sound. It also changes production iOS `LoginView.swift:139` (`.textContentType(.username)` becomes `.passwordContent(.username)`). **Defer to the iOS reviewer** to confirm the helper keeps autofill in Release builds. |
| HANDOFF-06: proxy-addr 2.0.8 (badffdd) | **Verified.** The lockfile has 2.0.8 and audit is clean. |
| HANDOFF-06: push not tested with real FCM/APNs keys | **Accept for this release.** Server push is off without credentials («push выключен» one-liner). Verify on staging before enabling keys in production. |
| HANDOFF-06: "do not merge to master without owner confirmation (migrations, email registration)" | Migrations: **safe** (see checklist). Email registration: **fix I-1 first**, and decide `allow_registration`, SMTP and the allowlist policy (I-3) explicitly before merging. |
| Task 8 deferred: PushKit voip token not registered (server holds call_offer) | The server side is correct: the push call window is 30 s (`CALL_RING_MS`) and the offer is cleared on ring timeout or on the caller's disconnect. Remaining work is iOS. **Accept** server-side. |
| Task 5 parked items (upload Authorization not bound to job owner; stale-screen sendAttachment) | Android-only. **Not my area**; the Android reviewer rules on them. |

## Verdict for this area: **Ready after fixes**

Blocking before merge to master (production):
- **I-1:** gate `register/request` and `register/verify` on `allow_registration`.
- **I-2:** enforce blocks on `call_offer`, wake and DM edits.
- **I-3:** global rate limits on registration requests and failed verifies, **or** an explicit owner decision to allowlist only exact addresses.

Strongly recommended in the same wave (each is one or two lines): Minor 1 (deletion broadcast PII), Minor 2 (avatar cache purge), Minor 5 (INSERT error mapping) and Minor 9 (strip production env from the dev stand).
