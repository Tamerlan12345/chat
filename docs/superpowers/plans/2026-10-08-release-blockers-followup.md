# Release blockers follow-up implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Resolve code and verification gaps from `docs/security_best_practices_report.md` that can be addressed offline, and state precisely which release checks still require owner credentials, devices, or a staging service.

**Architecture:** Keep Android push registration, server scope checks, and iOS push documentation as independent changes. Verify the Windows desktop packaging in a temporary output directory without launching a production-pinned executable or publishing an update. Run focused checks, then combined suites and a separate review.

**Tech Stack:** Kotlin/Gradle/JUnit, Node/Express/node:test, Electron/electron-builder, Markdown.

**Spec:** `docs/security_best_practices_report.md` and the existing `mobile/contracts/push.md` contract. The user confirmed this report is the intended plan and requested subagent execution.

## Global Constraints

These constraints governed the offline implementation phase. Later on 2026-10-08, the owner explicitly requested a push, merge into `master`, and repeat tests on the Railway service currently used as a test environment; that release request supersedes the no-push/no-deploy lines below for the release phase.

- Work only in the local `mobile-release-parity-impl` worktree. Do not push, merge PR #3, touch `master`, or publish artifacts.
- Never contact production or port 2004. Use loopback ephemeral ports in tests. Packaged desktop defaults to production, so do not launch an installed or packaged app.
- Do not add secrets, keystores, Firebase/Apple credentials or private keys to the repository. Preserve `mobile/android/.idea/` and existing `desktop/release` artifacts.
- Android release signing must still fail closed without credentials. iOS PushKit/CallKit and notification extension are accepted v1 limitations, not new features in this task.
- Changes to behavior use a failing test first. No claim of physical push or signed update verification without the corresponding device, key and artifact.

## Review Focus

- Repeated sign-in to the same account must register FCM token again; test the exact same user with a new token/session.
- Account switch during token registration must not send a token under the wrong session; test session transition and cancellation/serialization behavior.
- An out-of-scope employee or pending registration must neither appear in scoped admin lists nor be mutated by scoped admin; assert unchanged rows and an in-scope positive control.
- An older provider token callback must not replace a newer token after concurrent work; pin ordering in a test.
- Desktop build artifacts must stay in an isolated directory and must never be described as signed or install-tested.

---

### Task 1: Android FCM registration after every sign-in

**Files:**
- Modify: `mobile/android/app/src/main/java/com/openmychat/mobile/data/push/PushRegistrar.kt`
- Modify: `mobile/android/app/src/test/java/com/openmychat/mobile/data/push/PushTest.kt`
- Modify only if an explicit post-commit event is needed: `mobile/android/app/src/main/java/com/openmychat/mobile/core/session/SessionManager.kt`

**Interfaces:** Preserve `PushRegistrar.start()` and `onNewToken(String)` and the `PushTokenSource` interface. The existing `SessionManager.tokenFlow` and `currentUserFlow` expose session changes; avoid binding a new JWT to a stale user during a cross-account transition.

- [x] Add a test: after initial registration, `saveAuthSuccess` for the same user with a new JWT causes a second `POST /api/devices/push-token`.
- [x] Run the focused test and record its failure against the current implementation.
- [x] Add a deterministic test for out-of-order provider token events and account switching, with the latest token remaining registered.
- [x] Implement the smallest session-aware, serialized registration path. Keep startup and `onNewToken` behavior, and do not retry forever on provider/network failure.
- [x] Run `./gradlew.bat :app:testDebugUnitTest --tests com.openmychat.mobile.data.push.PushTest` from `mobile/android` and review the diff.

### Task 2: Scoped administrator negative controls

**Files:**
- Modify: `server/test/scope-containment.test.js`
- Modify only if a failing test proves a bug: `server/src/api/index.js` or the owning service.

**Interfaces:** Use the existing `freshBoot`, ephemeral loopback HTTP server and `api()` helper. Check status and persisted state; do not infer authorization from the response alone.

- [x] Add sibling departments A/B with a scoped administrator in A, employee and pending registration/device in B.
- [x] Add cross-scope list and mutation tests for users, registrations and device binding/unbinding; assert B remains unchanged and A has a working positive control.
- [x] Run `node --test --test-timeout=20000 test/scope-containment.test.js` from `server`; fix production code only if a negative control fails.
- [x] Check whether `/admin/registrations` limits before scope filtering and add a focused pagination test; if the defect is reproduced, filter in SQL before `LIMIT` and rerun focused tests.

### Task 3: Align iOS push contract with v1 implementation

**Files:**
- Modify: `mobile/contracts/push.md`
- Modify if needed for consistent wording: `docs/PUSH-SETUP.md` and `docs/security_best_practices_report.md`.

**Interfaces:** Preserve payload schema and server/client behavior. The app has no Notification Service Extension or PushKit/CallKit target; v1 lock-screen APNs alert is generic until the app fetches content from the server.

- [x] Identify every sentence promising fetched message text inside an iOS Notification Service Extension or VoIP delivery while the app is closed.
- [x] Revise those promises to match current v1 and mark the extension and PushKit/CallKit as future, explicit work. Keep the identifiers-only privacy property.
- [x] Search all changed docs for contradictory claims; ensure the release report names these as limitations, not verified features.

### Task 4: Desktop package and release-boundary check

**Files:** No product source edit unless a concrete packaging defect is reproduced. Store evidence in `docs/security_best_practices_report.md`.

- [x] Build desktop UI, then package NSIS with `MYCHAT_SKIP_SIGN=1` and a fresh temporary output directory, leaving `desktop/release` untouched.
- [x] Inspect installer output, embedded `app-update.yml`, and Authenticode status. Label it a packaging check only; do not install, launch or publish the production-pinned executable.
- [x] Verify missing pinned certificate still blocks `npm run sign` only if it can be checked without altering shared `installer/` artifacts. Record why signed upgrade and clean-machine install remain unavailable.

### Task 5: Combined verification and review

- [x] Run focused Android and server tests, then applicable full suites for changed components; inspect exit codes and failed/skipped counts.
- [x] Review each task diff for requirements, correctness, security and untracked-file preservation; run a broad combined review.
- [x] Update the report with fresh results, unresolved owner inputs and exact release gates. Do not claim OWASP certification or complete release readiness.

## Execution result (2026-10-08)

- Android: 791/791 local debug unit tests passed. An independent review approved the session and token ordering changes.
- Server: focused scope suite 19/19; full `npm test` 825 total, 816 passed, 9 skipped, 0 failed. Independent security review approved the final diff. PostgreSQL integration still needs a running database.
- Desktop: 515/515 tests, UI build and isolated unsigned NSIS packaging passed. `npm run sign` was not invoked because no release certificate is available and the command may touch shared installer artifacts; installation and update from a server remain release gates.
- iOS: documentation and fixture generator now describe the actual v1 APNs alert and future PushKit/CallKit support. No Xcode/device execution was possible on this Windows host.
- `docs/security_best_practices_report.md` records the remaining owner credentials, devices, staging environment and qualified OWASP checks.
