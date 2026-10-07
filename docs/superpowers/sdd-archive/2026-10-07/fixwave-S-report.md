# Fix wave — lane S report (server + contracts + CI + dev stand)

Worktree `m-integration`, branch `fix/server-contracts` (from `mobile-release-parity-impl` @ 07420d0), pushed to origin. Never pushed to master. No production traffic; port 2004 untouched (the stand now refuses it).

Logs in this folder: `fixwave-S-red-*.log` / `fixwave-S-green-*.log`.

## Commits

| Commit | What |
|---|---|
| e300fd6 | `mobile/contracts/copy-ru.md` + `copy/ru.json` (92 keys, canonical) — pushed first for lanes A/D |
| b9ac247 | I-1 registration switch, I-3 global limits, EMAIL_NOT_CONFIGURED, M3 purge, M4 code not burned, M5 unique-violation mapping |
| 988e16d | I-2 blocks on call_offer (+ call push), wake, direct-message edit — both directions |
| 0e87f31 | M1 deletion broadcast without erased PII, M2 avatar cache purge, M6 approve re-enables legacy rejected rows |
| 5b0a3a2 | Parity minor: Retry-After on the parallel-upload 429 |
| 7498c2f | M18: real ordering bug found on PG (late edit after tombstone) fixed; push tests made deterministic |
| 3b64cac | M9/M10/M11/M12 dev stand: no prod env, port 2014 (2004 refused), loopback proxy, name-constrained CA; seed enables registration |
| 6ff6c89 | M13 pin setup-java/upload-artifact by SHA; M14 screenshot push via extraheader from env |
| 5aa05ef | registration.md / ws-protocol.md / push.md / multi-device.md contract fixes |
| 788a9e3, 4eac767 | openapi.yaml new endpoints; 14 new mobile fixtures; drift test extended (openapi coverage + neutral data) |
| 3127ebd | `docs/PUSH-SETUP.md` (server part + placeholders), `.env.example` |
| 4d412e2 | `parity-matrix.md` refreshed |
| 9152033 | CANCELLED_MAX reducer vector 71 |

## Items

### Server — Important

| Item | Status | Evidence |
|---|---|---|
| **I-1** `allow_registration` gates `/auth/register/request` and `/verify` (decision Q) | **Fixed.** Off → 403 `{ error: «Регистрация сейчас закрыта. Обратитесь к администратору.», code: REGISTRATION_DISABLED }` (text = `copy-ru.md` `reg.disabled`). Checked first (before fields, SMTP, limits); applies to allowlisted addresses too; verify refuses live codes without spending them. On → unchanged. | red/green `registration`; test «allow_registration выключена…» (no mail, no row, no account, code reusable after re-enable) and «…включена: прежнее поведение» |
| **I-2** blocks on calls / wake / edit, both directions | **Fixed.** `call_offer` → `call_unavailable` with the generic «Сотрудник сейчас не в сети», no offer queued, so no call push; `wake_send` → `wake_error invalid_target`; `edit_message` on a DM → `DM_NOT_ALLOWED` (re-checked after the settings await), no `message_updated`. | red/green `blocks`; 3 tests in `self-registration.test.js` (both directions each, plus unblock restores editing) |
| **I-3** brute force with many IPs (decision R) | **Fixed.** Server-wide limits: 60 code requests/h and 300 failed verifies/h (env `REGISTRATION_GLOBAL_REQUESTS_PER_HOUR`, `REGISTRATION_GLOBAL_FAILED_VERIFIES_PER_HOUR`); 429 `RATE_LIMITED` + Retry-After; over-budget verify is not counted as an attempt; security alert `registration_request_flood` / `registration_code_bruteforce` at most once per hour. Per-IP/per-email limits and domain allowlist entries unchanged. | red/green `registration`; 2 tests (global request cap across IPs; failed-verify budget → 429 for everyone + alert row, attempt not spent) |

### Server — Minor

| # | Status | Evidence / reason |
|---|---|---|
| 1 deletion broadcast PII | **Fixed** — broadcasts the anonymised DB row (`deleted~<id>`, no email/phone/job title) | red/green `account` |
| 2 avatar cache on deletion | **Fixed** — `purgeAvatarCache` after the UPDATE | red/green `account` |
| 3 periodic purgeExpired | **Fixed** — opportunistic, at most every 10 min inside `request` | red/green `registration` |
| 4 verify consumes code before checks | **Fixed** — pending cap and name/email checks before consumption; an INSERT failure releases the code | red/green `registration` («отказ по пределу ожидающих заявок не гасит верный код») |
| 5 INSERT error mapping | **Fixed** — only PG 23505 / SQLite 2067 → 409 (EMAIL_TAKEN when the constraint/message names email, else USERNAME_TAKEN); others → 500 | red/green `registration` |
| 6 approve legacy rejected | **Fixed** — `is_active = 1` on approve | red/green `account` |
| 7 rejected applicant cannot re-apply | **Accepted** (product behaviour); documented in registration.md §2 | — |
| 8 enumeration via 409 | **Accepted** (in contract, 10/IP/h, now also the global cap) | — |
| 9 dev stand inherits env | **Fixed** — `standServerEnv` strips DATABASE_/POSTGRES/PG*, SMTP_, PUSH_/FCM_/APNS_, JWT_SECRET, AUDIT_HMAC_KEY, BACKUP_, REGISTRATION_, RAILWAY_, NODE_ENV, … | red/green `dev-stand` |
| 10 port 2004 | **Fixed** — default 2014 (`dev.env`, stand, tls-proxy); stand/proxy/seed refuse 2004; `seed.mjs` CLI needs an explicit URL | red/green `dev-stand` |
| 11 proxy on 0.0.0.0 | **Fixed** — 127.0.0.1 by default (emulator 10.0.2.2 = host loopback; simulator = localhost); `TLS_LISTEN_HOST=0.0.0.0` opt-in | red/green `dev-stand` |
| 12 dev CA name constraints | **Fixed** — `permitted;DNS:localhost, IP:127.0.0.1, IP:10.0.2.2`; test proves a leaf for another host fails `openssl verify`. Existing local CAs must be regenerated (`FORCE=1`), README says so | red/green `dev-stand` |
| 13 actions not pinned | **Fixed** — setup-java v4.9.1 `cf277c6…`, upload-artifact v4.6.2 `ea165f8…`; no tag-pinned `uses:` left | `grep` (no `@v` refs) |
| 14 token in screenshot push URL | **Fixed** — token as `http.extraheader` via `GIT_CONFIG_*` env (not URL/argv), masked. Branch growth: **accepted**, use `git clone --single-branch` (a squash/force-push pruning job was not worth the risk) | CI run on head (see Verification) |
| 15 `DATA_DIR` on Railway | **Accepted** — owner check before merge to master (no code change) | — |
| 16 eager `sharp` | **Accepted** — verified working on node:24-alpine (server review); lazy load is hardening only | — |
| 17 scoped admins miss live events | **Accepted** (as ruled by server and desktop reviews) | — |
| 18 PG timing tests | **Fixed.** 5 push tests now wait for the provider call. The multi-device failure was a **real ordering bug**: on a slow DB an edit's `message_updated` went out after the delete's tombstone (clients could resurrect deleted text). Fixed in the WS edit handler (editor gets `MESSAGE_DELETED`), reproduced deterministically on SQLite with a delayed read. | red/green `pg-timing` (PG 6 fail → 0), red/green `edit-after-delete` |
| 3 pre-existing master PG failures (`login-bruteforce` ×2, `update-routes`) | **Accepted / ticket** — fail identically on master; likely fire-and-forget `login_failure_log` writes landing after the response on PG, and an update-store ordering issue. Not touched. | `fixwave-S-green-full-pg.log` |
| Nightly `test:pg` CI job | **Not added** — it would be red until the 3 pre-existing failures are fixed; recommend adding with that ticket | — |

### Parity / contracts

| Item | Status |
|---|---|
| Part 1 #1 `DM_NOT_ALLOWED` in ws-protocol §4.2 | **Fixed** (send + edit), plus fixture `ws/error.dm_not_allowed.json` |
| Part 1 #2 openapi lacks new endpoints | **Fixed** — `/auth/register/request`, `/verify`, `DELETE /users/me`, `/blocks`, `/blocks/{userId}`, `/reports`, `/admin/registration-allowlist[/{id}]`, `/admin/reports`, `/admin/reports/{id}/close`, every real status. New drift test: every captured method/path/status must be in openapi (mutation log `fixwave-S-red-openapi-coverage.log`) |
| Part 1 #3 registration.md incomplete | **Fixed** — BUSY/Retry-After, PASSWORD_HASH_BUSY, 503 `EMAIL_NOT_CONFIGURED` (additive `code`, message kept; old servers: 503 without code = same), EMAIL_SEND_FAILED, 409s on verify, 429 with code and global limits, CODE_INVALID without attemptsLeft, 500, delete-account codes, report reason codes |
| Minor 1 parity-matrix stale | **Fixed** — table rebuilt from the Task 11 reviews |
| Minor 3 CANCELLED_MAX vector | **Fixed** — vector 71 (kills a CANCELLED_MAX mutation) |
| Minor 4 / P17 real data in contracts | **Fixed** in openapi/registration.md/fixtures: example names/emails/phones, `chat.example.com`, admin contact neutralised by the capture script, APNs bundle `com.example.centychat`. New test «contract examples use neutral data». Company name (server default) **kept**: owner's corporate name, not personal. Server seed admin contact **not changed** (fresh installs only; owner data). Platform tests with real-looking data are lanes A/I |
| P15 call-push docs vs server | **Fixed** — push.md §3 and multi-device.md §5/§9/§12 now state the server rule (push to every device without an online socket; vectors c01–c10); wrong «§7» comments fixed |
| ws-protocol: no `viewing` rate row | **Fixed** |
| Server parallel-upload 429 without Retry-After | **Fixed** (5b0a3a2) |
| copy-ru.md | **Committed** as canonical + `copy/ru.json` |
| docs/PUSH-SETUP.md | **Written** (server part; Android/iOS sections are placeholders for lanes A/I) |

## Verification (head 9152033)

| Check | Result | Log |
|---|---|---|
| `cd server && npm test` (SQLite) | **816 tests: 815 pass, 0 fail, 1 skipped** (PG-only import test) — includes contract vectors (74/74 incl. new vector 71), notify vectors, fixture drift test (9/9) | `fixwave-S-green-full-sqlite.log` |
| `npm audit --omit=dev --audit-level=high` | **found 0 vulnerabilities** | `fixwave-S-green-audit.log` |
| `npm test` against PostgreSQL 16 (Docker, throw-away container, `TEST_DATABASE_URL`) | **816: 813 pass, 3 fail** — only the 3 pre-existing master failures (`login-bruteforce` ×2, `update-routes`); the 6 timing failures from the review are gone | `fixwave-S-green-full-pg.log`, before: `fixwave-S-red-pg-timing.log` |
| Contract drift / openapi coverage mutation | old openapi.yaml → coverage test lists all 17 missing method/path pairs; old examples → neutral-data test fails | `fixwave-S-red-openapi-coverage.log` |
| CANCELLED_MAX mutation | reference with CANCELLED_MAX=1000 fails vector 71 | `fixwave-S-red-cancelled-max-mutation.log` |
| CI `security-checks` on head 9152033 | **success** (run 37568345517); green on every pushed head | `gh run list --branch fix/server-contracts` |
| CI `mobile-android` (pinned actions) | **success** on 5aa05ef (run 37567600618; the only push touching its paths) | — |
| CI `mobile-ios` with the new dev stand (port 2014, loopback, constrained CA) | **success** on 3b64cac (run 37567233866) and 5aa05ef incl. screenshot publish with extraheader (run 37567600667) | — |
| CI `mobile-ios` after new fixtures (4eac767, 9152033) | **failure, expected**: only `ContractFixtureTests.testEveryManifestFixtureDecodes` — the 13 new `http/*` fixtures have no iOS DTO case yet; `ws/error.dm_not_allowed` decodes; vector 71 passes; screenshot publish succeeds | runs 37568140926, 37568345375 |
| Android contract tests locally (mobile/android untouched) | `ContractFixturesTest` fails only on 6 unmapped success routes; `DeliveryReducerVectorsTest` 71/71 incl. vector 71 | `fixwave-S-platform-contract-check.log` |

Red → green pairs: `registration`, `blocks`, `account`, `upload-retry-after`, `edit-after-delete`, `pg-timing`, `dev-stand`, `contracts`.

## Notes for the coordinator

1. **Platform fixture tests need new decoders.** Android `ContractFixturesTest` and iOS `ContractFixtureTests` decode every manifest entry. 13 new HTTP fixtures + `ws/error.dm_not_allowed.json`. Android: error fixtures (≥400) pass generically; it needs success DTO mappings for `GET /api/settings/info`, `GET/POST /api/blocks`, `DELETE /api/blocks/{id}`, `POST /api/reports`, `DELETE /api/users/me`. iOS needs a `case` for every new `http/*` name. Until lanes A and I add them, their fixture tests fail on this branch. Admin-console routes were deliberately kept out of the mobile fixtures (still in openapi). Vector 71 is also picked up by both platform vector runners (constants match per the parity review).
2. **Dev stand changed defaults**: server port 2014, proxy on 127.0.0.1, name-constrained CA (regenerate old local CAs with `FORCE=1`), `seed.mjs` needs a URL, `allow_registration` on.
3. **Before merging to master** (owner): decide `allow_registration` in production (now it really gates email-code registration), SMTP, and allowlist policy (exact addresses preferred; global limits now cap domain brute force). Check no `DATA_DIR` on Railway.

## Fix round 1 (Ruling T) — commit 14cb909

| Item | Status | Evidence |
|---|---|---|
| T1 global request budget spent by requests that send no mail | **Fixed.** The budget is taken after field, per-IP/e-mail, taken and capacity checks, right before hashing and sending; it is refunded when no code mail goes out (EMAIL_SEND_FAILED, EMAIL_NOT_CONFIGURED, PASSWORD_HASH_BUSY). | Test «общий предел заявок считает только отправленные письма…»: with a budget of 1, a 409, a 400 and a failed send leave it intact; then one 202, then 429 |
| T2 global counters evictable in the shared limiter map | **Fixed.** Dedicated fixed-window counters (`requests`, `failedVerifies`) in `registration.service.js`; nothing to evict. Tests reset them with `Registration.resetGlobalCounters()`. | Test «общие счётчики регистрации не вытесняются…»: shared map shrunk to 3 buckets and flooded with 20 keys; both budgets still answer 429 |
| T3 a ringing call survives blocking | **Fixed.** `POST /blocks` → `wsServer.endCallsBetween()` in both directions: a pending or still-checking offer is cleared; the callee gets `call_end` (`unavailable`), and a push-woken phone gets it on connect instead of the replayed `call_offer`; the caller gets `call_unavailable` with the generic reason. The push queue drops the call push, because `callOffer` no longer finds the offer. Calls that were already answered are not changed: either side can hang up. Documented in registration.md §4. | Tests «блокировка снимает уже звонящий вызов…» (online; a late answer does not start a call) and «блокировка вызывающим снимает вызов через push…» (caller blocks; phone with its own `device_id` gets `call_end`, no `call_offer`) |

Verification at 14cb909:
- red: `fixwave-S-r1-red.log` (4 of 35 failing).
- green: `fixwave-S-r1-green.log` (87/87: self-registration, call-devices, push-notifications, rate-limiter).
- `npm test`: 820 tests, 819 pass, 0 fail, 1 skipped (`fixwave-S-r1-full-sqlite.log`).
- `npm audit`: 0 vulnerabilities (`fixwave-S-r1-audit.log`).
- CI `security-checks` run 37572461300: success.
