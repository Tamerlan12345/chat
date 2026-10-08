# Task 2 implementation report — desktop credential persistence

Status: implemented, with rollout/native smoke limitations below. Worktree: `C:\Users\user\.codex\worktrees\owasp-hardening\chat`, branch `codex/owasp-hardening`. No push or deployment performed by this implementer.

## Implemented

- New main-process credential vault uses Electron safeStorage; unavailable encryption and Linux basic_text fail closed. Per-configured-origin file names, encrypted payloads, exclusive temporary writes, fsync, rename, and a serialized operation queue prevent partial updates and claim/logout races.
- Narrow restore/save-token/clear/claim/knock preload IPC. Every handler checks the configured server origin, top frame and main window. Secret generation and claim/knock transmission are owned by main with fixed endpoints, redirect rejection and request timeout. Paired secrets are never returned by IPC.
- Renderer migration removes old token/device identity localStorage entries only after persistence acknowledgment. Existing vault wins over stale legacy entries. Mislabelled legacy origin, corruption and secure-storage failures do not trigger plaintext fallback.
- Active token is shared in renderer memory; all admin consumers updated. Login persists before session activation, refresh/password-change await persistence, silent device login uses main, logout retains bounded unbind/revoke then clears persisted credentials. Token callbacks now await persistence; logout disk failures are shown rather than silently claiming success.
- Existing installed shells without the new bridge, and ordinary browser clients, retain explicit legacy behavior. New shells pin credential use to the native configured server origin. Details in `docs/desktop-credentials.md`.

## Verification

- Installed locked desktop dependencies using `npm.cmd ci --ignore-scripts --offline --no-audit --no-fund` (305 packages, successful). Initial full suite before dependency installation failed on missing packages; that run is not counted as verification.
- `node --test desktop/test/credentials.test.js desktop/test/credentials-renderer.test.mjs`: 16/16 passing, no skipped tests.
- `npm.cmd test --prefix desktop`: earlier full run 528/528 passing; final full run including the three added tests recorded below.
- `npm.cmd run build --prefix desktop`: successful, 90 modules transformed; Vite reports the existing large chunk warning (>500 kB). No build error.
- `node --check desktop/src/main/main.js`, `node --check desktop/src/main/credentials.js`, `git diff --check`: successful.
- TDD was not explicitly required for this task; tests were written with the implementation. No claim of a pre-implementation red run.

## Exact files

- `desktop/package.json`
- `desktop/src/main/credentials.js`
- `desktop/src/main/main.js`
- `desktop/src/preload/preload.js`
- `desktop/src/renderer/src/lib/credentials.mjs`
- `desktop/src/renderer/src/App.jsx`
- `desktop/src/renderer/src/components/AdminUserModal.jsx`
- `desktop/src/renderer/src/components/FilePolicyAdmin.jsx`
- `desktop/src/renderer/src/components/LoginView.jsx`
- `desktop/src/renderer/src/components/SecurityCenter.jsx`
- `desktop/src/renderer/src/components/UpdatesAdmin.jsx`
- `desktop/src/renderer/src/components/UserProfileModal.jsx`
- `desktop/src/renderer/src/components/useAdminApi.js`
- `desktop/test/credentials.test.js`
- `desktop/test/credentials-renderer.test.mjs`
- `docs/desktop-credentials.md`
- this report

## Self-review and limits

Self-review caught and fixed migration-origin ambiguity, refresh completion racing logout, password callback persistence ordering, secure-store-unavailable logout, and disk-write failure reporting. No unrelated files intentionally edited. The existing large App.jsx was changed narrowly rather than restructured.

The test encryption adapter uses authenticated AES encryption to exercise persistence boundaries; real Windows DPAPI/keyring behavior, packaged installation, reboot and in-place upgrade remain untested here. A server-renderer deployment alone does not remediate old installed shells: those retain plaintext localStorage until the new shell is installed. Active bearer tokens remain accessible to trusted-origin renderer JavaScript; same-origin XSS remains a session risk. Migrating legacy secrets cannot erase prior copies/backups or prove forensic erasure. Offline server revocation remains best effort. Origin mismatch requires native configuration correction; destructive reset/re-pair was not automated. Ciphertext deletion when OS storage cannot be opened also loses local device identity and may require re-pairing on later login.

Final full run: npm.cmd test --prefix desktop — 531 tests, 531 pass, 0 fail, 0 skipped, duration 70667.506 ms.

## Review fix round 1

Addressed both independent-review findings with a separate follow-up commit:

- P1: a failed vault clear now keeps `loggingOutRef` set and renders a dedicated exit barrier before either the login or account view. Only retrying credential cleanup is allowed; successful cleanup reloads the entire document. Late callbacks changing auth state cannot bypass the barrier, and a login callback cannot persist or activate a new account while logout is pending.
- P2: both ordinary and forced password-renewal paths check logout before enqueueing token persistence. The forced path checks again after the password response, before any account-state changes. Existing checks after persistence still prevent reopening a socket if logout starts during a write.
- Added four App lifecycle regressions in `desktop/test/credentials-app-lifecycle.test.js`, included by `desktop/package.json`. The harness executes actual App handler source and its JSX exit/login render branch; it covers failed cleanup with retained account data, retry/full reload, late ordinary and forced password responses, and a save already enqueued before logout. An initial harness run failed because Windows CRLF prevented locating the render branch; normalization fixed the harness. This was not a product failure or a claimed TDD red run.

Commands and output:

```text
node --test desktop/test/credentials-app-lifecycle.test.js desktop/test/credentials.test.js desktop/test/credentials-renderer.test.mjs
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 151.8708

npm.cmd run build --prefix desktop
vite v6.4.3 building for production...
✓ 90 modules transformed.
✓ built in 2.23s
```

The existing Vite chunk-size warning remains (657.29 kB main bundle). `git diff --check` passed with no output. Full-suite results appended below. Changed files for this fix: App.jsx, package.json, the new lifecycle test, and this report. Diff inspected; no unrelated change, push or deployment by this implementer.

```text
npm.cmd test --prefix desktop
ℹ tests 535
ℹ suites 0
ℹ pass 535
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 69229.7028
```
