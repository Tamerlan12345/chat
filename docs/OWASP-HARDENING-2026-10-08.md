# OWASP hardening plan — 2026-10-08

Source: CSO run `1791443592037-d485d82386dccd84` (partial), independent server/client/Railway reviews. Work in isolated branch. Never expose secrets. Fix one supported finding per commit, run covering tests, and obtain separate read-only review. Do not infer full OWASP/ASVS or release readiness from partial results.

## Task 1: scoped-admin capability bypass

In `server/src/api/index.js`, channel creation and `requireUploadPermission` accept `is_admin` as override although scoped admins also have this flag. Use existing `isSuperAdmin(req.user)` as override. Add regression tests for scoped admin with each capability disabled (403), enabled (success), and super-admin unchanged. Run covering server tests and commit.

## Task 2: desktop credential storage

Design and implement removal of paired-device secret and bearer token from renderer localStorage, using origin-checked IPC and OS-protected main-process storage. Preserve silent login and explicit migration, fail closed if secure storage unavailable. Cover origin, migration, logout/unbind, restore. Run desktop tests and commit separately.

## Task 3: runtime and coverage

Record seven Railway security warnings and unencrypted local backups. Apply only operational changes with verified intended behavior; do not guess browser/IP/remote-desktop policy. Repeat bounded live tests, CI and whole-diff review; update OWASP report with exact gaps.

## Preflight conflict scan

| Pair | Shared interface | Ruling |
| --- | --- | --- |
| 1/2 | Sessions and device auth | Separate commits; run integration tests after both. |
| 1/3 | Server deployment | Deploy only reviewed code. |
| 2/3 | Desktop release | CI is not evidence of installed release. |

Each task's stated tests match its code scope; Task 2 must preserve silent login while removing renderer-held secrets. The broad environment policy choices are deferred to explicit configuration evidence.

## Task 4: repeat iOS simulator verification

The PR iOS CI run 37738033173 failed only its iPad split-view assertion for Bob; earlier iPhone UI/unit steps passed and previous run with identical iOS source passed. Investigate prompt overlay and transient inbox loading. Make the iPad UI test wait for authenticated tab bar, dismiss system prompts before Bob assertion, and capture diagnostics on failure. Do not weaken the user-visible Bob or split-view assertion. Re-run CI and review the fix separately.

Task 4 touches iOS UI tests only; it shares no source files with Tasks 1-2, but its CI status informs Task 3 release reporting.
