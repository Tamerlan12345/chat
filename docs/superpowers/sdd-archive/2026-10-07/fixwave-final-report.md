# Final polish (D1–D5 + release checklist): report

- **Branch:** `fix/final-polish` (worktree `m-integration`), from `mobile-release-parity-impl` at `b1ab56b`. Pushed to origin. Nothing pushed to master.
- **Head:** `6ce4933`.
- **Date:** 2026-10-07.
- No production traffic, port 2004 untouched, no secrets, no git stash, no test weakened. Gradle ran with `--max-workers=2 -Xmx1536m` and no emulator.

## Commits

| Commit | Defect | Content |
|---|---|---|
| `47268d2` | D5 | Legacy `/auth/register` 403 → `{ error: reg.disabled text, code: 'REGISTRATION_DISABLED' }` (uses `Registration.REGISTRATION_DISABLED_MESSAGE`, the same constant as request/verify). New test in `self-registration.test.js` (red first). `openapi.yaml` 403 now refs `RegistrationErrorResponse`; `copy-ru.md` §5 note updated. |
| `f0b323c` | D3 | `mobile/contracts/**` in the push and pull_request path filters of `mobile-android.yml` (added) and `mobile-ios.yml` (replaces `mobile/contracts/fixtures/**`). |
| `5d8ff0c` | D2 | `docs/PUSH-SETUP.md`: §2 holds the Android section (2.1–2.4), `docs/PUSH-SETUP-android.md` deleted. §1.1 names `com.openmychat.mobile` (checked against `build.gradle.kts:48,52`) and flags the difference from `kz.centras.centychat`. §1.2 `PUSH_APNS_BUNDLE_ID` row notes the app registers no VoIP token. §2.2 states that no workflow writes `google-services.json` and describes the owner's conditional CI step. §4 step 4 corrected. |
| `995acc4` | D4 | `parity-matrix.md` §2 refreshed to the merged state: all A/I fix-wave items done; push ◐ "code complete, needs keys"; remaining ◐ = calls, «Побудка», store/owner steps. Checklist §5 lines updated. |
| `7ddd384` | — | `docs/RELEASE-CHECKLIST.md` (Russian, owner-facing). |
| `6ce4933` | D1 | `mobile/android/.gitignore` anchored (`/build/`, `/app/build/`, `/.kotlin/`, `/app/.kotlin/`, `/.gradle/`); `ManifestHardeningTest.kt` and `PushBuildConfigurationTest.kt` copied unchanged from `m-android` and committed. |

## D2: what the code says (checked before writing)

- Android call push: `SystemNotificationSink.kt:80-100` — channel «Звонки» `IMPORTANCE_HIGH`, `CATEGORY_CALL`, `setTimeoutAfter(30_000)`, no `setFullScreenIntent`, no `USE_FULL_SCREEN_INTENT` / `FOREGROUND_SERVICE` in the manifest. Title «Входящий звонок» (`strings.xml:338`).
- iOS: no `PKPushRegistry`/`CXProvider` anywhere in `mobile/ios`; the `.voip` kind exists only in the registrar enum. Server `push.service.js:32` `callCapable = platform === 'android' || kind === 'voip'` → iOS gets no call push.

## Verification (local)

| Check | Result | Log |
|---|---|---|
| D5 red | new test fails: body has no `code`, old text | `fixwave-F-red-d5-legacy-register.log` |
| D5 green, `self-registration.test.js` | 36/36 pass | `fixwave-F-green-d5-self-registration.log` |
| Contract vectors / fixture drift / openapi coverage | 89/89 pass | (console) |
| `cd server && npm test` | **821 tests: 820 pass, 0 fail, 1 skipped** (PG-only) | `fixwave-F-green-server-npm-test.log` |
| `npm audit --omit=dev --audit-level=high` | found 0 vulnerabilities | `fixwave-F-green-server-audit.log` |
| D1 targeted Gradle (`ManifestHardeningTest`, `PushBuildConfigurationTest`) | **6/6 pass** (3 + 3). No product-code finding. | `fixwave-F-green-d1-hidden-android-tests.log` |
| Full `:app:testDebugUnitTest` | **782 tests, 0 failures, 0 errors, 0 skipped** | `fixwave-F-green-android-full-unit.log` |
| `git status --ignored mobile/android` | only `mobile/android/.gradle/` and `mobile/android/build/` ignored; no source file hidden | — |

Note: the first Gradle attempt failed only because the fresh worktree had no `local.properties`; reran with `ANDROID_HOME` set (nothing written to the repo).

## CI on 6ce4933

All push runs on `6ce4933` finished **green** (no PR exists for the branch, so there are no pull_request runs).

| Run | Workflow | Jobs | Result |
|---|---|---|---|
| 37617219067 | security-checks | server, desktop, secrets | **success** |
| 37617219111 | mobile-android | android-verify (`testDebugUnitTest lint assembleDebug assembleDebugAndroidTest assembleRelease`, now including the two formerly ignored tests), android-emulator-tests | **success** |
| 37617219132 | mobile-ios | ios-release-server-lock, ios-simulator-tests (~60 min), publish-ios-screenshots | **success** |

The iOS run was triggered by the new `mobile/contracts/**` filter (and the workflow edit) — D3 works as intended.

## Verdict

D1–D5 are fixed and CI is green on the head. Per final-rereview.md this is **"Ready for release (pending owner steps)"**. Merging to master remains the owner's decision.

## Left for the owner

See `docs/RELEASE-CHECKLIST.md`: Railway variables (SMTP_*, REGISTRATION_ALLOWED_EMAILS, `DATA_DIR` unset), enabling «Самостоятельная регистрация сотрудников» after deploy plus one real code, desktop `npm run pack` on Node ≥ 22.12, physical-device checks, signing/versions/privacy policy/support URL/demo account/Custom App.

Optional, not done (out of D1–D5 scope): desktop `copy-ru.test.mjs` reading `ru.json` directly (final-rereview §1.2).
