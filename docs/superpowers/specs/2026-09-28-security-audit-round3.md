# OpenMyChat Enterprise: security audit, round 3

**Date:** 2026-09-28. **Branch:** `feature/security-autoupdate-rc-parity` (HEAD `04276d7`, same as `master` plus the skills commit). **Mode:** read-only, no repo files changed.

**Rubric:** `.claude/skills/security-and-hardening` (SKILL + hardening-patterns + security-checklist) and the security sections of `.claude/skills/electron-development/SKILL.md`.

**Excluded from this report (already closed and re-verified):** everything in commits `ac898cc` (round 1) and `35d4c75` (round 2), and everything marked done in `docs/designs/security-remediation-plan.md`. Items the plan lists as still open are grouped at the end. Where a plan item is marked done but the code does not match, the finding says so.

**Confidence:** High = path traced line by line; Medium = traced but one runtime detail unverified; Low = depends on deployment. Nothing was run against a live server.

`npm audit --omit=dev`: **0 vulnerabilities** in server/ and desktop/ (details at end).

---

## Summary (most severe first)

| # | Sev | Area | Finding | Fix |
|---|---|---|---|---|
| 1 | **High** | identity | Re-binding a device to a new user keeps the previous owner's stored secret; combined with visible `token_version`, a scoped admin can obtain a passwordless token as an in-scope employee | S |
| 2 | **High** | authz | A scoped admin can null out their own scope (accepted by `assertWithinAdminScope`), then batch-import with no scope restriction; the import also has no admin-protection check | S |
| 3 | Medium | disclosure | Department/user-targeted announcements are broadcast (full text) to every socket | S |
| 4 | Medium | authz | Scoped admins carry `is_admin`, so they pass `can_broadcast` gates: company-wide orders + read every ack journal (incl. IPs) | S |
| 5 | Medium | validation | Self-service profile update lets any user rewrite `full_name`/`job_title`/`email`/`phone` with no length/format limits (impersonation + amplification). Plan 1.8.3 marked done, not implemented | S |
| 6 | Medium | uploads | Chat attachments: no type policy, download filename is sender-controlled message text, no `will-download` guard (RD file path is hardened, chat path is not) | M |
| 7 | Medium | DoS | Authenticated exhaustion: no message-text cap; 16 MB WS frame JSON-parsed before rate check; no upload quota | S–M |
| 8 | Medium | DoS | Anonymous `/api/auth/knock` inserts unbounded `pending_devices` rows and admin-broadcasts each | S |
| 9 | Medium | session | Device secret never expires, survives logout (client flag only), resets `auth_time` (bypasses `SESSION_MAX_DAYS`), stored plaintext in localStorage | M |
| 10 | Low | integrity | Announcement ack accepts any id with no existence/addressee check, then broadcasts. Plan 1.8.4 marked done, not implemented | S |
| 11 | Low | disclosure | Creating a private channel broadcasts its name/topic to all users | S |
| 12 | Low | availability | Targeted lockout: an insider can keep any known username (incl. `admin`) locked | S |
| 13 | Low | electron | Packaged build keeps default menu + DevTools; `grantFileProtocolExtraPrivileges` fuse not disabled | S |
| 14 | Low | supply chain | Desktop CI audit uses `--omit=dev` (excludes shipped Electron); `npm ci` runs lifecycle scripts; actions pinned by tag only | S |
| 15 | Low | installer | Legacy `install-service.bat`: LocalSystem service running repo JS, `node.exe` via PATH, firewall `profile=any` | S |
| 16 | Low | data hygiene | Stale `identity.db` / `pre-identity-split.db` remain on volume and auto-import if Postgres empties (plan 1.9 cleanup not done) | S |
| 17 | Low | tokens | Legacy ms-expiry tokens still accepted: skip `iss`/`aud`/session-max, not revocable by logout | S |
| 18 | Low | misc | `/health` leaks version/store to anon (plan 3.6 open); scrypt N=2^15 below OWASP 2^17; role permissions JSON not schema-validated | S |

---

## 1. [High] Device re-bind inherits the previous owner's secret

**Confidence:** High. **Files:** `server/src/services/device.service.js:181-191` (bind), `:238-246` (auto-match), `:42-46` (knock trust check), `:268-283` (claim); `server/src/services/user.service.js:16-19,85` (`token_version` returned to scoped admins).

**Defect:** `bindDevice` and `autoMatchByIp` use `ON CONFLICT (device_id) DO UPDATE SET user_id = EXCLUDED.user_id …` and never clear `secret_hash` / `secret_token_version`. So a device row can change owner while keeping a secret that was claimed by a *different* user. `knock` grants a token when `secretMatches(secret, pairing.secret_hash)` and `secret_token_version === <new owner's> token_version`.

**Impact:** A party who once claimed a secret on a device (e.g. a scoped admin binding a device to himself, then re-binding it to an in-scope employee) can knock with that old secret and receive a token for the new owner, no password. `token_version` is readable via `GET /api/admin/users`, so the version-equality condition can be arranged (bump own `tv` via password change, or the target's `tv` via role edits). The victim's password and sessions are unaffected; audit shows only `device_bound` + a `device_login` under the victim. This defeats plan 1.2.2 ("device binding never returns an admin/other user's token"). Even benign PC hand-offs can silently log in as the new owner using the old secret.

**Rubric:** A01 Broken Access Control (secret not bound to its principal); checklist "resource access checks ownership".

**Fix (S):** On any `user_id` change in `device_pairings`, set `secret_hash=NULL, secret_token_version=NULL`. Preferably add `secret_user_id` written in `claimDeviceSecret` and require `secret_user_id = p.user_id` in `knock`. Regression test: claim as A, re-bind to B, knock must return `login_required`. Consider not returning `token_version` to scoped admins.

---

## 2. [High] Scoped admin can drop own scope, then run an unrestricted / admin-touching batch import

**Confidence:** High. **Files:** `server/src/api/index.js:202` (only truthy `admin_scope_dept_id` rejected), `user.service.js:397-399` (writes NULL, no `token_version` bump), `api/index.js:1494-1502` (import passes `req.user.admin_scope_dept_id`), `org-parser.service.js:314-316` (null scope disables all checks), `:381-407` (existing-user match + update).

**Defect A — scope self-removal:** `assertWithinAdminScope` rejects `payload.admin_scope_dept_id` only when truthy. `PUT /api/admin/users/:id {admin_scope_dept_id:null}` on the actor's own record passes and clears the scope, without invalidating the current token. On the next request `req.user.admin_scope_dept_id` is null.

**Defect B — import ignores scope and admin protection:** `applyImport` treats `adminScopeDeptId=null` as "no scope" (`inScopeIds=null`) and skips every in-scope guard. Even *with* a scope, the import path has no equivalent of the `assertWithinAdminScope` admin check (`api/index.js:182`): it matches existing users by `username OR full_name` and overwrites their `full_name`, `department_id`, `job_title`, `email`, `extension`, `bound_ip`. There is no block on touching super-admins or moving users, and `bound_ip` writes feed the device auto-match path (finding 1).

**Impact:** A scoped admin escalates to company-wide user modification, contradicting plan 1.2 and 2.4.3 (scope containment). Overwriting `bound_ip` and profile fields across the org is a strong privilege-escalation primitive.

**Fix (S):** In `assertWithinAdminScope`, reject any `admin_scope_dept_id` key present in the payload for a non-super-admin (`'admin_scope_dept_id' in payload`), not just truthy values. In `applyImport`, when the actor is a scoped admin require a non-null in-scope root and refuse if resolution yields none; add the admin-protection and out-of-scope-move checks to the update branch. Tests: scoped admin cannot null own scope; import as scoped admin cannot modify an out-of-scope or admin user.

---

## 3. [Medium] Targeted announcements are broadcast in full to everyone

**Confidence:** High. **Files:** `server/src/api/index.js:1095` (`wsServer.broadcast({type:'new_announcement', announcement: ann})`); visibility filtering only happens later in `AnnouncementService.getAnnouncementsForUser` (`announcement.service.js:69-80`).

**Defect:** On creation, the full announcement object (title + content + `target_type` + `target_ids`) is pushed to *every* authenticated socket via `broadcast`, regardless of `target_type='departments'|'users'`. The client shows a toast for all of them (`App.jsx:1365-1371`). The per-user filter that respects targeting is applied only on the REST fetch, not on the live push.

**Impact:** A "urgent" order addressed to one department or a named list leaks its full text to the whole company in real time (A01/Sensitive disclosure).

**Fix (S):** Compute recipients server-side (reuse the visibility logic) and `sendToUser` to each, or add a targeted broadcast helper. Do not `broadcast` the body for non-`all` announcements.

---

## 4. [Medium] Scoped admins bypass broadcast/ack-journal gates via `is_admin`

**Confidence:** High. **Files:** seeded scoped-admin role has `is_admin:true, is_scoped_admin:true, can_broadcast:false` (`server/src/db/identity/index.js:334-343`); gates check `is_admin` OR `can_broadcast`: `api/index.js:1088` (create announcement), `:1123` (read ack journal).

**Defect:** These two endpoints allow when `permissions.is_admin` is true, without excluding scoped admins (unlike `isSuperAdmin` used elsewhere, `api/index.js:138-141`). A scoped admin whose role sets `can_broadcast:false` still passes because `is_admin` is true.

**Impact:** A scoped admin sends company-wide official orders (impersonation of authority) and reads the full acknowledgement journal for any announcement, including every employee's `ip_address` (`announcement.service.js:114-129`) — company-wide PII, not scope-limited. Contradicts the round-2 intent that ack journals are for broadcasters only.

**Fix (S):** Change both checks to `isSuperAdmin(req.user) || permissions.can_broadcast`. For the ack journal, additionally restrict scoped admins to announcements they authored / their scope. Tests: scoped admin with `can_broadcast:false` gets 403 on both.

---

## 5. [Medium] Self-service profile fields are unvalidated (impersonation + amplification)

**Confidence:** High. **Files:** `PUT /api/users/profile` → `UserService.updateProfile` (`user.service.js:179-219`). Only `avatar_url` and `custom_status` are validated; `full_name`, `email`, `phone`, `job_title` are written via `COALESCE` with no length or format check.

**Defect:** Any authenticated user can set their own `full_name`/`job_title` to arbitrary strings of arbitrary length. These fields are shown as the sender identity across chats, the org tree, and admin panels. Plan item 1.8.3 ("Имя и должность меняет только администратор") is marked done in the plan but is **not** implemented — the endpoint has no such restriction.

**Impact:** (a) Impersonation — set `full_name` to "IT Support" or a director's name and send phishing DMs/announcements-of-authority; the recipient UI shows the spoofed name. (b) Amplification/DoS — a multi-MB `full_name`/`job_title` is embedded in `getDirectory` results and echoed into every message page and org-tree/broadcast payload sent to all users (`message.service.js:277-289`, `org.service` tree). (c) `email`/`phone` accept any string.

**Rubric:** Input validation at the boundary (allowlist shape, lengths); A01 (self-service should not set identity fields other roles rely on).

**Fix (S):** Enforce length caps (e.g. name ≤120, job_title ≤120, email ≤254 + format, phone ≤32 + digits) and, per plan 1.8.3, remove `full_name`/`job_title` from the self-service update (admin-only), or gate them. Add tests for oversized and role-sensitive fields.

---

## 6. [Medium] Chat attachments have no type policy and a sender-controlled download name

**Confidence:** Medium (server + client traced; browser download behaviour in Electron shell not executed). **Files:** upload `file.service.js:11-41` (only extension char-sanitised, no type/extension allowlist, `mime_type` stored from client), download `api/index.js:1333-1347`, client `ChatView.jsx:241-266` (`link.download = suggestedName` where `suggestedName = m.text`), no `session.on('will-download')` anywhere in `desktop/src/main`.

**Defect:** The remote-desktop file-receive path is thoroughly hardened (`received-file.js`: dangerous-extension rename, reserved names, Zone.Identifier, consent dialog). The ordinary chat attachment path has none of this. A user can upload any file type; the server serves it (correctly `Content-Disposition: attachment` + sandbox CSP, so no inline execution — good), but the client's forced-download name is the attacker-chosen message text `m.text`, and downloads into the Electron app write to disk with no Zone.Identifier and no dangerous-type handling.

**Impact:** An insider shares `Отчёт.pdf` whose message text / download name is `invoice.exe` (or uses RTL tricks), landing an executable in Downloads without a mark-of-the-web, so SmartScreen does not vet it on launch. This is the same class the RD path already fixed, left open on the chat path.

**Fix (M):** Apply an upload allowlist/denylist (reuse `received-file.js` dangerous-extension list, verify magic bytes for images). On the client, derive the download name from the stored original name, not `m.text`. Add a `session.on('will-download')` handler in main that applies the same naming/zone rules for any file leaving the app.

---

## 7. [Medium] Authenticated resource-exhaustion gaps

**Confidence:** Medium. **Files:** `message.service.js:216-219` (no max length on `body`); `ws/server.js:14` `MAX_MESSAGE_BYTES = 16 MB` with parse at `:297` before the type-based rate limit at `:307`; upload parallelism capped at 2 but no per-user total-bytes/day quota (`api/index.js:1275`).

**Defect:** Message text has a minimum ("non-empty") but no maximum, so a single authenticated message can be up to ~16 MB and is then stored and fanned out to every channel member / the DM partner. Pre-*type* rate limiting does not apply to the JSON.parse of a 16 MB authenticated frame. No cumulative upload quota.

**Impact:** One authenticated account can drive memory/bandwidth/storage cost far above intended (STRIDE: DoS). Not catastrophic (per-connection frame cap + per-IP socket cap exist), but the message-size gap is a cheap amplifier since the payload is persisted and rebroadcast.

**Fix (S–M):** Cap message text (e.g. 8–16 KB) in `sendMessage` and reject over it; lower `MAX_MESSAGE_BYTES` for text frames or size-check by type before parse; add a rolling per-user upload byte quota.

---

## 8. [Medium] Anonymous knock inflates `pending_devices` unboundedly

**Confidence:** High. **Files:** `api/index.js:229-246` (`/auth/knock`, rate-limited 30/min/IP), `device.service.js:66-100` (INSERT into `pending_devices` with client `device_id`, `device_name`, `platform`, `client_version`, then `broadcastToAdmins`).

**Defect:** An unauthenticated caller (from an allowed IP/LAN) can register arbitrarily many distinct `device_id`s. Each new id is a new row with client-controlled strings (capped only by the JSON body limit, no per-field length cap) and triggers an admin broadcast. The 30/min/IP limit still allows ~43k rows/day/IP.

**Impact:** Unbounded growth of the identity DB and admin device queue; admin-notification spam; a griefing / storage-pressure vector reachable before authentication (STRIDE: DoS + Repudiation noise).

**Fix (S):** Cap `pending_devices` per IP (and total), add length caps on `device_name`/`platform`/`client_version`, and coalesce/throttle admin broadcasts. Prune stale pending rows on a schedule.

---

## 9. [Medium] Device-secret session lifecycle is weaker than the password session

**Confidence:** Medium. **Files:** client `App.jsx:373-388` (secret generated and stored in `localStorage`), `:452-462` (silent login gated only by `mychat_logged_out` flag), `:558` (logout just sets that flag), `auth.service.js:60-72` (device token sets `auth_time = now`), plan 3.5.5 (token in `safeStorage`) still open.

**Defect:** (a) The device secret has no server-side expiry; only `token_version` equality bounds it. (b) "Выход" sets `localStorage.mychat_logged_out='1'` and revokes the current token, but the secret remains, so anyone with the machine (or a copy of localStorage) can knock again — logout does not unbind. (c) Each device login issues a token with fresh `auth_time`, so `SESSION_MAX_DAYS` (enforced only via `auth_time`, `auth.service.js:121`) never forces a real re-auth for device-logging clients. (d) The secret and token live in plaintext `localStorage`, readable by any code that reaches the renderer and by anyone with file access to the profile.

**Impact:** The passwordless path is a long-lived bearer credential that survives logout and never ages out, stored in the clear. This widens the blast radius of finding 1 and of stolen profile data.

**Fix (M):** Give device pairings/secrets a server-side expiry and rotate on use; on logout, call an unbind endpoint that clears the secret server-side; do not reset `auth_time` on device login (carry the original); move token + secret to `safeStorage` via the main process (plan 3.5.5). 

---

## 10. [Low] Announcement acknowledgement is unvalidated and broadcast

**Confidence:** High. **Files:** `api/index.js:1102-1116`, `announcement.service.js:85-96` (INSERT/UPSERT with `Number(announcementId)`, no existence check, no check the announcement targets the user), then `wsServer.broadcast({type:'announcement_acknowledged', userId, userName})`.

**Defect:** Any authenticated user can POST an ack for any id (including non-existent or one not addressed to them); a receipt row is written and an ack event with their name is broadcast to all. Plan 1.8.4 ("отметка ознакомления — только для существующего оповещения, адресованного сотруднику") is marked done but is not implemented here.

**Impact:** Forged compliance records (repudiation/integrity) — an employee can appear to have acknowledged an order they never saw, or spam ack events. Low severity (no direct escalation) but it corrupts the ack audit trail the feature exists to guarantee.

**Fix (S):** Verify the announcement exists and is visible to the user before writing the receipt; only broadcast for real receipts.

---

## 11. [Low] Private-channel creation leaks name/topic to everyone

**Confidence:** High. **Files:** `api/index.js:1244-1257` (`POST /channels`) → `MessageService.createChannel` then `wsServer.broadcast({type:'channel_created', channel})`; `createChannel` honours `type:'private'` (`message.service.js:395-408`).

**Defect:** A newly created private channel is broadcast to all sockets with its full row (name, topic). Non-members learn of and see the metadata of private channels.

**Impact:** Information disclosure of private-channel existence and topic. Low (topic only, not messages).

**Fix (S):** For `type='private'`, send `channel_created` only to the initial members.

---

## 12. [Low] Targeted account lockout (griefing)

**Confidence:** High. **Files:** `auth.service.js:280-299` (lockout after `LOGIN_MAX_FAILED_ATTEMPTS`, default 10), `api/index.js:271-282` (per-`ip+username` limiter + per-IP fail limiter).

**Defect:** Lockout is keyed on the account, so repeated wrong passwords for a known username lock that account for `LOGIN_LOCKOUT_MINUTES`. An insider who knows usernames (readily derivable, `firstname.lastname` style) can keep any account — including `admin` — perpetually locked by looping just under the per-IP fail limit, or from several IPs.

**Impact:** Availability / targeted denial of login. The round-2 work chose "incremental delay" over hard lock in the plan (1.7), but the code still hard-locks. No notification to the victim.

**Fix (S):** Prefer per-IP throttling + incremental delay over account hard-lock (as plan 1.7 intended), or exempt/alert on admin-account lockouts and notify the user on lock.

---

## 13. [Low] Electron packaged-build hardening gaps

**Confidence:** Medium (menu/DevTools observed absent from code; fuse list read). **Files:** `desktop/src/main/main.js` (no `Menu.setApplicationMenu(null)`, no `webContents.on('devtools-opened')` block, no `autoHideMenuBar`); `desktop/package.json` `electronFuses` block (no `grantFileProtocolExtraPrivileges:false`).

**Defect:** The good fuses are set (`runAsNode`, node-options, node-cli-inspect off; asar integrity, only-load-from-asar, cookie encryption on). But: (a) the default application menu remains, so `Ctrl+Shift+I` / `F12` open DevTools on the production window that loads remote server code; (b) `grantFileProtocolExtraPrivileges` is not disabled.

**Impact:** DevTools on a window rendering remote code eases inspection/token extraction on a shared machine; the file-protocol fuse is defence-in-depth for the local `file://` offline/indicator pages. Low, since IPC is sender-validated and CSP is set.

**Fix (S):** `Menu.setApplicationMenu(null)` (or a minimal menu) and refuse DevTools in packaged builds; add `grantFileProtocolExtraPrivileges: false` to the fuses. The skill's checklist calls for locking the production window surface.

---

## 14. [Low] CI/supply-chain gaps

**Confidence:** High. **Files:** `.github/workflows/security.yml`. Desktop job runs `npm audit --omit=dev` — Electron and the whole toolchain are devDependencies, so the shipped Chromium/Node runtime is never audited. Both jobs use `npm ci` (runs dependency lifecycle scripts). Actions are pinned by mutable tag (`actions/checkout@v4`, `gitleaks-action@v2`), not by commit SHA.

**Defect vs rubric:** The dependency-audit rule says audit against the committed lockfile including what ships; for an Electron app the runtime is a devDependency, so `--omit=dev` hides the most security-relevant component (Chromium). The install-script gate is not applied (`npm ci` executes scripts). SHA-pinning of actions is the recommended supply-chain control.

**Impact:** A future Electron CVE (they are frequent) would not fail CI. Low today because current versions are clean.

**Fix (S):** Run a full `npm audit` (not `--omit=dev`) for the desktop project, or specifically track Electron advisories; consider `npm ci --ignore-scripts` with a reviewed allowlist; pin actions by SHA.

---

## 15. [Low] Legacy on-prem installer scripts (only if used)

**Confidence:** Medium (scripts are for the self-hosted service path, not the Railway deployment). **Files:** `installer/install-service.bat`, `installer/setup-firewall.bat`, `installer/launch.vbs`.

**Defect:** `install-service.bat` registers `MyChatServer` as a LocalSystem auto-start service whose `binPath` runs `%~dp0..\server\src\index.js` from the (user-writable) repo folder, resolves `node.exe` via `where` (PATH search order can be hijacked), and opens the firewall for port 2004 with `profile=any` (including public networks). `launch.vbs` starts the server with `node` from PATH too.

**Impact:** If the repo folder or PATH is writable by a non-admin, the server code / node binary that runs as SYSTEM can be replaced (local privilege escalation). `profile=any` exposes the chat port on untrusted networks. Low because it applies only to the manual on-prem install, and the container/Railway path is unaffected.

**Fix (S):** Install to a protected directory, use an absolute `node.exe` path, and restrict the firewall rule to `profile=domain,private` and the office subnet.

---

## 16. [Low] Stale identity DB copies with password hashes remain on disk

**Confidence:** High. **Files:** `server/src/db/index.js:193-196` (writes `pre-identity-split.db`), `server/src/db/identity/index.js:117-155` (auto-imports from `identity.db` / `pre-identity-split.db` when the store is empty). Plan 1.9 asks to delete these after migration; no deletion code exists.

**Defect:** After migrating to Postgres, `data/identity.db` and `data/pre-identity-split.db` (full user table incl. password hashes/device data) stay on the volume. They are also an *auto-import source*: if the Postgres store is ever empty at startup (fresh DB, misconfig), the server silently repopulates from these local files.

**Impact:** (a) Extra copies of password hashes at rest on the volume (the backup path encrypts identity dumps, but these raw files are not managed). (b) An operator who points the app at a blank Postgres could unknowingly resurrect stale accounts/hashes.

**Fix (S):** After a verified migration, delete or move the SQLite identity files (plan 1.9); gate auto-import behind an explicit env flag rather than "store is empty".

---

## 17. [Low] Legacy millisecond-expiry tokens still honoured

**Confidence:** High. **Files:** `auth.service.js:112-116`. If `payload.exp > 1e11` the token is treated as legacy: accepted until `exp`, flagged `legacy`, and returned **before** the `iss`/`aud`/`iat`/`auth_time`(session-max) checks that follow for modern tokens.

**Defect:** Legacy tokens skip issuer/audience validation and the `SESSION_MAX_DAYS` bound. `/auth/refresh` refuses them (`api/index.js:335`), and `/auth/logout` can revoke by `jti` only if they carry one (older ones do not), so some legacy tokens cannot be revoked by logout at all — only by a `token_version` bump.

**Impact:** A pre-upgrade 7-day token remains a bearer credential with weaker checks until it expires. Low and self-limiting (no new legacy tokens are issued), but it is an accepted weaker path.

**Fix (S):** Set a hard cutoff date after which legacy tokens are rejected outright (force one re-login), or bump all `token_version` at deploy to retire them.

---

## 18. [Low] Smaller items

**Confidence:** High unless noted.
- **`/health` anonymous disclosure** (`app.js:164-171`): returns `version`, `identityStore`, uptime to unauthenticated callers before the desktop-only static gate. Plan 3.6 ("`/health` без подробностей для анонимных запросов") is still open. Fix: return bare `{status}` unless authenticated.
- **scrypt cost** (`server/src/db/identity/password.js:12`): `N=32768` (2^15). OWASP's current scrypt guidance is N≥2^17. Fix: raise N (rehash-on-login already exists, so migration is automatic).
- **Role permissions not schema-validated** (`api/index.js:595-637`): `PUT /admin/roles/:id` stores `JSON.stringify(permissions)` verbatim — any keys, any shape. Super-admin only, so low, but a typo'd/unknown permission key is silently persisted. Fix: validate against a known permission allowlist.
- **`downloadAttachment` name** duplicated note: see finding 6.

---

## Known open items (already tracked in the plan — not re-counted as findings)

From `docs/designs/security-remediation-plan.md`, still explicitly open and confirmed unimplemented in code: **3.4** (off-site/encrypted-at-rest DB, attachments in backups), **3.5.5** (token in `safeStorage` — still `localStorage`), **4.1** (data residency KZ), **4.2** (real code-signing cert; current cert is a self-signed exportable key, thumbprint `0EB6…862A`, valid to 2036 — treat as potentially compromised per the plan), **4.3–4.6** (CI build/signing from tag, SBOM, monitoring, policy docs), **4.4** (auto-update — the branch name suggests it is in progress but no `electron-updater` wiring exists in `desktop/src/main`). These are correctly deferred; listed here only so the reader knows they were checked, not missed.

Positive confirmations (spot-checked, holding up): parameterised SQL throughout; SQLite studio locked to the chat DB via `setAuthorizer` + read-only connection; WS auth/rate/origin/IP gates; RD consent + input/clipboard/file hardening in the main process; IPC sender validation (`isFromServerPage`) on sensitive channels; CSP/HSTS/Permissions-Policy headers; audit-log HMAC chain with anchor+checkpoint; AES-256-GCM encrypted backups; timing-safe token/secret comparison; file-access check by resolved `file_id` (not LIKE); packaged build blocks `http:`/`ws:` and env-var server override.

---

## Dependency audit (production deps)

`npm audit --omit=dev --json`, run 2026-09-28:

- **server/**: prod deps 101, **0 vulnerabilities** (info/low/moderate/high/critical all 0). Direct prod deps and locked versions: `express@5.2.1`, `ws@8.21.3`, `multer@2.4.0`, `pg@8.23.0`, `cors@2.8.6` — all current, no advisories.
- **desktop/**: prod deps 4 (`react@19.2.8`, `react-dom@19.2.8`), **0 vulnerabilities**. A full audit including devDependencies (Electron `44.3.0`, electron-builder `26.15.3`, vite `6.4.3`) also reported **0**. Caveat (finding 14): CI runs desktop audit with `--omit=dev`, which would not catch a future Electron advisory — Electron is the shipped runtime but a devDependency here.

No real production-dependency vulnerabilities to triage at this time. Supply-chain process gaps are captured in finding 14.
