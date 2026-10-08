# Task 4 report: contract corrections and shared fixtures

Status: DONE. Worktree `m-integration` (branch `mobile/integration`), not pushed.
Commits: `e3ca24c` (tooling, test, fixtures), `f818a80` (contract docs).

## Contract corrections (vs. server code)

ws-protocol.md
1. New section 1.1: clients ship with a build-time server URL (release = `https://centychat-production.up.railway.app`, `wss://.../ws`, no runtime override; debug via build config, dev stand 10.0.2.2:8443 / localhost:8443).
2. 6.3 rewritten: an expired or revoked token cannot be refreshed (`/auth/refresh` needs a still-valid token, 401 otherwise, and revokes the old token immediately). Recovery = `/auth/knock` with device secret (`paired` / `login_required` / `pending`) or password login. No `afterId`/`updatedSince`; `beforeId` only pages backwards. Resync = refetch conversations/channels and latest page, merge by id; missed read/delivered state only via `delivery_status` of the direct page. Proactive refresh 30 min before exp while valid.
3. `new_message` is always sent together with `direct_message` / `channel_message` with identical `message`, to recipients AND the sender (echo); same for REST sends. Clients must dedupe by `message.id`. Both payloads shown.
4. Live message frames have NO `delivery_status` (only `GET /messages/direct/{id}`); old doc claimed it.
5. `message_updated` carries the full message (old doc showed a partial one).
6. `call_*` relay: `targetUserId` is the frame RECIPIENT, `senderId/senderName` the peer; extra client fields (`reason`, `candidate`) are relayed. Server-originated `call_end` on drop has NO `targetUserId` and `reason: "connection_lost"` (old example was wrong).
7. `user_typing` for direct: `targetId` = recipient (you), conversation is identified by `userId`.
8. `announcement_acknowledged.announcementId` is a string; WS `new_announcement` lacks `read_at/confirmed_at/is_confirmed`; priority enum `normal|urgent|critical`.
9. `auth_success.user` is the full session profile (with `permissions_json`, `token_version`, `bound_ip`, ...), not 4 fields; `auth_error` codes table with client actions; `server_disconnect` reason list; `user_status_changed(offline)` has no `customStatus`; `error` contexts; wake_sent/ring/error/state documented; 6.2 sequence diagram fixed ("delivered" not set for recipients who connect later; no idempotency key, outcome unknown after a drop).
10. New section 7: event -> fixture file table.

openapi.yaml: `/auth/refresh` description fixed (no 60 s grace; expired token cannot be refreshed).

parity-matrix.md: all unfounded checkmarks replaced with honest status (legend: check / half / cross / ? / dash) from plan section 0 (D1-D15, per platform), added rows for create chat, resync, background calls, a11y, design, store, fixed server; removed non-existent `metadata` field, fixed `delivery_status`, announcement fields; checklist now has open items.

## Fixture inventory (66 files, all under `mobile/contracts/fixtures/`, described in `manifest.json`)

HTTP (20, `http/`): auth.login, auth.login-error (400), auth.unauthorized (401), auth.me, auth.refresh, auth.knock-pending, auth.knock-login-required, auth.knock-paired, auth.device-claim, auth.logout, users.list, users.get, channels.list, conversations.direct, messages.direct-page, messages.channel-page (includes a file message), messages.send-direct, files.policy, files.upload, announcements.list.

WS (45, `ws/`), event -> file:
- auth_success; auth_error: invalid_token, must_change_password, too_many_sessions, rate_limited
- server_disconnect: logout, role-changed
- new_message: direct, channel; direct_message; channel_message
- message_status_updated; messages_read; message_updated; message_deleted: direct, channel
- user_typing: direct, channel; user_status_changed: online, away, dnd; user_created; user_updated
- channel_created; channel_deleted; new_announcement; announcement_acknowledged
- call_offer; call_answer; call_rejected; ice_candidate; call_end (normal, connection_lost); call_denied; call_unavailable: dnd, offline
- wake_state: idle, cooldown; wake_sent; wake_ring; wake_error: cooldown, dnd, offline, invalid_target
- error: send_message, edit_message

`fixtures/README.md` states naming, normalization, and that both platforms must decode EVERY fixture (driven by manifest.json) in unit tests.

## How fixtures are generated / validated

- `mobile/dev/capture-fixtures.mjs`: starts a throwaway real server (new export `startServerProcess` in `stand.mjs`, empty temp data dir, random port, no TLS), seeds with `seed.mjs`, then replays a scripted client scenario over HTTP (`fetch`) and WebSocket (`ws`) with multiple sockets (alice, bob, admin, dave with must_change_password, carol for 9-session limit, role can_call toggle for `call_denied`, garbage auth until RATE_LIMITED last). Values normalized: tokens, timestamps (ranked per file, keeps format and order), wake epoch ms, random UIN, stored filename. Two consecutive runs produce byte-identical output. `--write` regenerates, `--check` compares.
- `server/test/mobile-contract-fixtures.test.js` (added to `npm test`): shapeDiff unit test, required-event coverage, required HTTP coverage, manifest == committed files, and a live re-capture compared with committed fixtures by key sets and value types (null is its own type, array lengths compared). Drift proof: renaming `sender_name` in a fixture fails with `$.message.senderName: missing in server output` / `sender_name: new in server output`.

## RED / GREEN

RED (before capture script/fixtures): `node --test test/mobile-contract-fixtures.test.js` -> tests 5, pass 0, fail 5 (shapeDiff import missing, no event fixtures, no HTTP fixtures, manifest missing, capture module not found). Saved in scratchpad `red.txt`.
GREEN: same file -> 5/5 pass (~6 s). Full `cd server && npm test`: tests 487, pass 486, fail 0, skipped 1 (the skip is pre-existing). `mobile-dev-stand.test.js` still green after the `stand.mjs` refactor.

## Files changed

- server/test/mobile-contract-fixtures.test.js (new), server/package.json (test list)
- mobile/dev/capture-fixtures.mjs (new), mobile/dev/stand.mjs (extract/export `startServerProcess`), mobile/dev/README.md
- mobile/contracts/fixtures/** (66 JSON + manifest.json + README.md)
- mobile/contracts/ws-protocol.md, parity-matrix.md, openapi.yaml

No server behaviour changed.

## Concerns

1. Fixtures mirror what the server does today, including warts Task 5 may change (live frames without `delivery_status`, user object leaking `permissions_json`/`token_version`/`bound_ip`/`last_login_ip`, 400 for bad login). When Task 5 changes behaviour: run `node mobile/dev/capture-fixtures.mjs --write`, review diff, update docs.
2. Shape check compares one scenario; nullable fields that are null in the scenario but strings elsewhere (e.g. `avatar_url`, `department_id`, `reply_to_id`, `custom_status`) appear only as null. Platforms must model them as optional; a richer scenario (reply, avatar, department) could be added later.
3. Not captured (unreachable or destructive): expired-token 401 (identical body to `auth.unauthorized`), generic `error` without `context`, `registration_pending`, `rd_*` remote-desktop frames (not used by mobile), `user_status_changed` offline. `device_id`/`device_secret` in knock fixtures are sample values.
4. Capture test takes ~6 s and spawns a node server; it needs a free loopback port and write access to the temp dir. The explicit test list in package.json means any new test must be added there by hand.
5. `openapi.yaml` was only patched for `/auth/refresh`; it was not audited line by line against the server (not in scope), so the same drift risk exists there as in the old ws doc. Fixtures are the authority.
6. Line endings: repo has `core.autocrlf=true`; fixtures are written with LF and git will warn but normalize.
