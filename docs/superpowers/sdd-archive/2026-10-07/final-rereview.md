# Task 11: final re-review of the integrated head

- **Head:** `b1ab56b` on `mobile-release-parity-impl`. The four fix-wave lanes are merged: S `1f7fa40`, D `4a6e48c`, A `fa96263` and I `b1ab56b`.
- **Reviewer:** Opus. The review was read-only apart from this file. Nothing was committed or pushed, no Gradle build ran, no emulator ran, and no traffic went to production.
- **Date:** 2026-10-07.

## Verdict: **Ready after fixes**

The product code on the merged head is consistent across the server, desktop, Android and iOS. Every Critical and Important item from the five final-review files is either fixed or explicitly accepted (section 4). The local suites are green (section 2), and all five CI runs on `b1ab56b` are green (section 3).

What blocks a merge to master is small, and none of it is product code:

1. **(Important, real defect)** Two Android test files exist only in the `m-android` worktree. They are not in the repository because `.gitignore` ignores them. See D1.
2. **(Important, documentation)** `docs/PUSH-SETUP.md` §2 is still a placeholder, and §4 promises call screens that do not exist. See D2.

Recommended at the same time: the CI path filters (D3), a refresh of `parity-matrix.md` (D4), and the code on the legacy `/auth/register` 403 (D5).

Once D1 and D2 are fixed and CI is green on the new head, this becomes **"Ready for release (pending owner steps)"** (section 5).

---

## 1. Cross-lane consistency on the merged head

### 1.1 Contract fixtures decode on both platforms

- After lane S's head `9152033`, the merge commits change nothing in `mobile/contracts/fixtures` or `copy/ru.json`. The only later change is `registration.md` (2 lines, S fix round 1). Lanes A and I therefore decoded exactly the fixture set that is merged now.
- The iOS merge changes nothing outside `mobile/ios` except `docs/PUSH-SETUP.md`: `git diff fa96263 b1ab56b` shows no edits under server, desktop, android, contracts, dev or .github. There are no conflict markers in the tree.
- **Android** (`ContractFixturesTest.kt`) walks the manifest. I mechanically cross-checked every success route in the manifest against `successDecoders`, and every `ws` event against `wsExpectations`. **Nothing is missing.** That covers 49 http fixtures, 61 ws fixtures and 8 push fixtures. Error fixtures (status ≥400) decode generically through `ApiErrorBody`.
- **iOS** (`ContractFixtureTests.swift:73-197`) has a named `case` for every `http/*` fixture, including the 13 new ones. Its `default:` fails the test. ws and push fixtures are decoded by event type and provider.
- **Server drift and vectors:** `node --test test/mobile-delivery-reducer.test.js test/mobile-contract-fixtures.test.js test/notify-decision.test.js` gives **89/89 pass**. This covers 71 reducer vectors (including CANCELLED_MAX vector 71), the notify vectors, the fixture drift test, openapi coverage and neutral data.

### 1.2 Copy: `mobile/contracts/copy/ru.json` is the single source

- `git ls-files` shows a single `ru.json` and a single `copy-ru.md`. I checked them against each other: every key, and every value including the plural forms, of the 92 keys in `ru.json` appears in `copy-ru.md`. There are no differences.
- **Android** `CopyRuTest.kt:29` reads `../../contracts/copy/ru.json` and compares it with `res/values/strings.xml` and the constants.
- **iOS** `CopyRuTests.swift:14` reads the same file. The fallback at `:15` is used only for the Linux run, and no copy is committed.
- **Desktop** keeps its own copy in two places: `desktop/src/renderer/src/lib/copy-ru.mjs` (`COPY`, 22 keys) and the `CANON` map in `desktop/test/copy-ru.test.mjs`. I ran a script that compared both against `ru.json` key by key. **There is no drift (22/22 and 22/22).**
- **Residual risk:** desktop's test compares against its own literal table, not against `ru.json`. A future edit to `ru.json` alone would not fail desktop CI. Recommendation (optional): have `copy-ru.test.mjs` read `../../mobile/contracts/copy/ru.json`, as the two mobile tests do.

### 1.3 REGISTRATION_DISABLED, DM_NOT_ALLOWED and BUSY

| Behaviour | Server | Android | iOS | Desktop |
|---|---|---|---|---|
| **REGISTRATION_DISABLED** | `registration.service.js:118-122` `assertRegistrationOpen()`, called first in request `:238` and verify `:333`. Returns 403 `{error: reg.disabled text, code}`. | `AccountFailure.kt:73-75`: 403 at either step gives `RegistrationDisabled`. The entry is hidden when `/settings/info` says `false` (`LoginViewModel.kt:139`, `LoginScreen.kt:193`) and kept when the value is unknown. | `AccountFailure.swift:75`: same mapping at either step. The entry is hidden when the value is `false` (`LoginView.swift:39`) and kept when unknown. | `copy-ru.mjs` `describeAuthFailure` maps the code to `reg.disabled`. The legacy form is hidden unless `allow_registration` is true (`LoginView.jsx:286`). **See D5:** the legacy `/auth/register` 403 carries no `code`. |
| **DM_NOT_ALLOWED** | Send `message.service.js:428`, edit `:660` and `:683` (both directions). REST returns 403 with the code (`api/index.js:1549`). The ws-protocol §4.2 row and the fixture `ws/error.dm_not_allowed.json` exist. | `ComposerLock.kt:18-58`: the composer is locked, and the banner and failed text are «Сообщение не может быть доставлено». | `ComposerLock.swift:24` together with `ChatDetailView.swift:177`: the same lock, the same reopen rules, and the same text (`AppCopy.swift:36`). | The toast shows the server text, which equals `delivery.DM_NOT_ALLOWED`. Desktop has no block UI (accepted, desktop M4). |
| **BUSY** (503 `BUSY` / `PASSWORD_HASH_BUSY` / `LOGIN_BUSY` + Retry-After) | Register request `api/index.js:677`, delete-me `:2001`, legacy register and login `PASSWORD_HASH_BUSY`. | `BUSY_CODES` (`AccountFailure.kt:59`) gives a short wait of 5 s by default (`reg.busy`). | `busyCodes` (`AccountFailure.swift:45`) gives `.serverBusy` with a 5 s default (`reg.busy`). | Login retries on its own (`login.busy_retrying`). Registration shows the server text. |

Conclusion: the three clients behave the same as the server. There are two cosmetic edges, and neither needs a fix:
- On `/auth/register/request` the hash-slot BUSY check (`api/index.js:675`) runs before the switch, so a busy server that also has registration off answers 503 rather than 403. The client then retries and receives 403 on the next attempt.
- A 503 on *verify* becomes `serverBusy` on iOS and `Unavailable` on Android. The server never sends BUSY on verify.

### 1.4 PUSH-SETUP docs: what the owner is missing

`docs/PUSH-SETUP.md` covers §1 (server), §3 (iOS, written by lane I) and §4 (check). `docs/PUSH-SETUP-android.md` is still a separate file. The following is missing or wrong:

1. **§2 Android is still the placeholder** «*(Раздел пишет команда Android…)*» (`PUSH-SETUP.md`, §2). Paste `PUSH-SETUP-android.md` §2.1–§2.4 there and delete the separate file. That file holds the `applicationId` `com.openmychat.mobile`, the `google-services.json` path and its gitignore entry, the CI secret step, the Play-image emulator, and what is not done.
2. **§4 step 4 is wrong for both platforms.** It says «Android — полноэкранное уведомление, iOS — CallKit». Android shows an ordinary high-importance notification («Входящий звонок»), with no full-screen intent and no microphone foreground service (`PUSH-SETUP-android.md` §2.4). iOS has no PushKit or CallKit at all (§3 «Чего пока нет»), and the server sends call pushes only to `voip` tokens (`server/src/push/push.service.js:32`). **iOS therefore receives no call push**; a call reaches iOS only while the app is running. Correct the step to say this.
3. **§1.1 does not name the Android package.** It says «идентификатором пакета приложения CentyChat». Name `com.openmychat.mobile` explicitly. Note that it differs from the iOS bundle `kz.centras.centychat`; the owner should decide whether that is intended before the first store upload, because it cannot be changed later.
4. **The CI secret step for `google-services.json` is described but not implemented.** No workflow writes `ANDROID_GOOGLE_SERVICES_JSON`. That is fine while push is off. Either note this as an owner step for a release build, or add the conditional step.
5. **The Railway variable names** for the server keys are present (§1.1/§1.2 and `.env.example:214-232`). No change is needed.

---

## 2. Re-run checks (local)

| Check | Result |
|---|---|
| `cd server && npm test` | **820 tests: 819 pass, 0 fail, 1 skipped.** The skip is the PG-only import test. It ran in 335 s. |
| `npm audit --omit=dev --audit-level=high` (server) | **found 0 vulnerabilities** |
| `cd desktop && npm test` | **514/514 pass**, 0 fail. All `test/*.test.*` files are wired into `npm test`. |
| Contract vectors, notify vectors, fixture drift and openapi coverage | **89/89 pass** (see 1.1) |
| Desktop `ru.json` drift script | 0 differences |
| Gradle and emulator | Not run, as the brief required |

## 3. CI on b1ab56b

Every run on `b1ab56b` finished. **All are green.**

| Run | Workflow | Event | Jobs | Result |
|---|---|---|---|---|
| 37609016462 | security-checks | push | server, desktop, secrets | **success** |
| 37609022286 | security-checks | pull_request | server, desktop, secrets | **success** |
| 37609022346 | mobile-android | pull_request | android-verify, android-emulator-tests | **success** |
| 37609016491 | mobile-ios | push | ios-simulator-tests (57 min), ios-release-server-lock, publish-ios-screenshots | **success** |
| 37609022267 | mobile-ios | pull_request | ios-simulator-tests (60 min), ios-release-server-lock (publish skipped on PR, by design) | **success** |

There is **no mobile-android push run on `b1ab56b`**. This is expected. The workflow's `push.paths` contain only `mobile/android/**` and its own file, and the iOS merge touched only `mobile/ios/**` and `docs/PUSH-SETUP.md`. The `pull_request` run 37609022346 builds the merged tree, so it is the run that counts. The last Android push run was 37575008245 on `fa96263`, and it succeeded.

No failures to investigate. The UI flakes from the lane I runs (`UserPathQATests:140` and `PeopleSearchUITests:117`) did not recur after the hardening in 7b610a6.

---

## 4. Critical and Important items from the five final reviews: status on the merged head

Paths: A = `mobile/android/app/src/main/java/com/openmychat/mobile/`, I = `mobile/ios/`, S = `server/src/`, D = `desktop/src/`.

### Server (`final-review-server.md`)

| Item | Status | Evidence |
|---|---|---|
| I-1 `allow_registration` does not gate email-code registration | **Fixed** | `S/services/registration.service.js:118-122`, called at `:238` (request) and `:333` (verify). Tests are in `self-registration.test.js` (S report). |
| I-2 blocks not enforced on calls, wake and edits | **Fixed** | Calls: `S/ws/server.js:1254-1257`. Wake: `:515`. Edits: `S/services/message.service.js:659-660`, `:682-683`. Ruling T adds ending calls already ringing on a block: `S/api/index.js:1968` → `ws/server.js:1932 endCallsBetween`. |
| I-3 code brute force (decision R) | **Fixed** | Dedicated global counters at `registration.service.js:45`. The request budget is at `:285` and the failed-verify budget at `:345`/`:364`. Env: `REGISTRATION_GLOBAL_*` (`S/config/index.js:315-316`). |
| Recommended minors 1, 2, 5, 9 | **Fixed** | Minor 1: `S/api/index.js:2009-2017` broadcasts the anonymised row. Minor 2: `S/services/account.service.js:77`. Minor 5: `registration.service.js:126,418`. Minor 9: the dev stand strips the env (S report). |
| Minor 15 `DATA_DIR` | **Accepted** | Owner check (section 5) |

### Desktop (`final-review-desktop.md`)

| Item | Status | Evidence |
|---|---|---|
| I1 raw report reason codes | **Fixed** | `D/renderer/src/components/ReportsAdmin.jsx:150` `reportReasonLabel(...)`. Tested in `registration-admin.test.mjs`. |
| I2 banner says registration is off while it is open | **Fixed** (server I-1 plus UI) | `AdminUserModal.jsx:2210-2216` (`REGISTRATION_SWITCH`), the new checkbox at `:2791-2798`, and the allow-list warning at `RegistrationAllowlistAdmin.jsx:109`. |
| M5 packaging | **Partly**: `engines >=22.12` is set (`desktop/package.json:28`) | Owner must still run `npm run pack` (section 5) |

### Android (`final-review-android.md`)

| Item | Status | Evidence |
|---|---|---|
| I1 sign-out keeps the device secret | **Fixed** | `A/core/network/ApiClient.kt:278-287` sends `{device_id}` and fails closed. `A/core/session/SessionManager.kt:384,390` `remove(KEY_DEVICE_SECRET)`. Test: `ApiClientLogoutDeviceTest`. |
| I2 uploads uncapped and transient statuses treated as final | **Fixed** | `A/features/chat/AttachmentSends.kt:90` (`Semaphore(MAX_PARALLEL)`, fair), `:484` (`MAX_PARALLEL = 2`), `:369` (0/401 wait), `:380-381` (Retry-After), `:490` (408/429/5xx). Test: `UploadQueueTest`. |
| I3 notification-tap intent trusted | **Fixed in code, regression test not in the repo (D1)** | `mobile/android/app/src/main/AndroidManifest.xml:53-54` `NotificationOpenActivity exported="false"`, `:65-66` messaging service `exported="false"`. `A/MainActivity.kt:64` reads no extras. `NotificationTapTest` is committed. **`ManifestHardeningTest` is not.** |
| I4 HTTP not bound to its account | **Fixed** | `A/core/network/RequestBinding.kt:17,26`, `BearerCredentialsInterceptor.kt:55` (`AccountChangedException`), `SessionManager.kt:363` (`replaceTokenIfCurrent`), `:373` (`clearSessionIfCurrent`). Tests: `RequestBindingTest`, `SessionAuthenticatorTest`, `SessionTokenReplaceTest`. |
| Cheap minors M1, M3, M4, M5 | **Fixed** | M1: `A/data/delivery/DeliveryEngine.kt:287` and `AttachmentSends.kt:449`. M3: `A/data/notifications/MessageNotifier.kt:123-125`. M4: `ChatViewModel.kt:473` and `AttachmentSends.kt:176`. M5: `AndroidManifest.xml:32` `usesCleartextTraffic="false"` (its test is also ignored by git, D1). |
| Parked 1 and 2, Task 5 line 99 | **Fixed** | Parked 1 and line 99 are fixed with I4; parked 2 is fixed with M4. |
| M6, M7, M8, M9, M10 | M7 and M10 **fixed** (P11, P8); M6, M8 and M9 **accepted** | fixwave-A report |

### iOS (`final-review-ios.md`)

| Item | Status | Evidence |
|---|---|---|
| I1 locked Keychain signs the user out | **Fixed** | `I/CentyChat/Core/Storage/KeychainManager.swift:91` (AfterFirstUnlockThisDeviceOnly), `:308-314` (`.unavailable`), `:129` upgrade, called from `CentyChatMobileApp/CentyChatMobileApp.swift:20`. Test: `KeychainAvailabilityTests`. |
| I2 offline cold launch shows the login screen | **Fixed** | `I/CentyChat/App/Stores/SessionStore.swift:218,230-233` (stored user), `:80,118,240-241` (launchProblem with retry), `RootView.swift:35-40`. Tests: `SessionResilienceTests` and `SessionLifecycleTests`. |
| I3 PrivacyInfo is missing UserDefaults | **Fixed** | `I/CentyChat/Resources/PrivacyInfo.xcprivacy:127,130` (CA92.1), `:136,139` (C617.1). Test: `BundleMetadataTests`. |
| I4 no push entitlements or background mode | **Fixed in code; signing is an owner step** | `Info.plist:44-49` (`audio`, `fetch`, `remote-notification`), the template `mobile/ios/Signing/CentyChat.entitlements:12-13` (not referenced by design), `requestAuthorization` at `Core/MultiDevice/MessageNotifications.swift:136`, the tap handler at `App/PushRouting.swift:84-86`, and the environment from the profile at `Core/Push/NotificationRouting.swift:13-21`. |
| M1, M2, M3, M4, M5, M7, M8 (ruled fix) | **Fixed** | M1: `Core/Delivery/DeliveryEngine.swift:273` `withdraw` and `AttachmentUploads.swift:331-336`. M2: `AttachmentUploads.swift:139-149`. M3: `ProfileView.swift:143-144`. M4: `Core/Network/APIClient.swift:452-456`. M5: `scripts/verify-release-server-lock.sh:29`. M7: `Info.plist:22-23,31-32` with only the microphone and photo-add strings left. M8: the icon PNG colour type is 2 (RGB). |
| M6, M9, M10, M11 | **Accepted** | Ruled in the review; fixwave-I report |
| M12 tap does not open the chat | **Fixed** | `App/PushRouting.swift:84-86`, tied to its account (Ruling V2) |

### Contracts and parity (`final-review-parity.md`)

| Item | Status | Evidence |
|---|---|---|
| **C1 push** on both phones | **Fixed in code (decision P); keys are owner work** | Android: `A/data/push/FirebasePush.kt:61` `CentyMessagingService`, `PushRegistrar.kt`, and the conditional plugin at `mobile/android/app/build.gradle.kts:16-17`. iOS: see iOS I4. Real delivery is untested until keys exist (section 5). |
| Part 1 #1 DM_NOT_ALLOWED missing from ws-protocol | **Fixed** | ws-protocol §4.2 and `fixtures/ws/error.dm_not_allowed.json` |
| Part 1 #2 openapi lacks the new endpoints | **Fixed** | `openapi.yaml` plus the coverage drift test (89/89 above) |
| Part 1 #3 registration.md incomplete | **Fixed** | `registration.md` §1 (BUSY, PASSWORD_HASH_BUSY, EMAIL_NOT_CONFIGURED, 409, 429, REGISTRATION_DISABLED) |
| P1–P3 Android uploads | **Fixed** | See Android I2 |
| P4 trimming | **Fixed** | `A/features/chat/ChatViewModel.kt:423-424` |
| P5 iOS DM_NOT_ALLOWED lock | **Fixed** | See 1.3 |
| P6 channels hiding | **Fixed** | `I/CentyChat/Features/ChatDetail/ComposerLock.swift:71` (direct only) |
| P7 block and delete texts | **Fixed** | `I/CentyChat/Core/Utils/AppCopy.swift:47-48,61`, checked against `ru.json` |
| P8 claim after registration | **Fixed** | `A/data/repository/AccountRepository.kt:111-113` |
| P9 login lowercased | **Fixed** | `I/CentyChat/App/Stores/SessionStore.swift:310` (trim only) |
| P10 logout `device_id` and notifications | **Fixed** | Android: see I1 and M3. iOS: `App/Stores/MessageNotificationsStore.swift:97-100`. |
| P11 disk restart loop | **Fixed** | `A/data/delivery/DeliveryEngine.kt:571,589,597` |
| P12 iOS background flush | **Fixed** | `I/CentyChat/App/DeliveryBackgroundRefresh.swift:14,38`, `Info.plist:50-52`. Only the identifier is tested, not the handler, so it needs a device check. |
| P13, P14 copy | **Fixed** | `ru.json` is the single source (1.2) |
| P15 call-push docs | **Fixed** | push.md §3, multi-device.md |
| P16 desktop multi-device | **Fixed** | `D/renderer/src/App.jsx:1443-1488` (`isViewingHere`, `incomingMessagePlan`), `D/main/window-presence.js`. Minimize-away needs a new desktop shell (section 5). |
| P17 personal data | **Fixed** | Neutral data in contracts and tests. `AvatarTests` keeps one name because a colour hash depends on it (accepted). The production host stays in the release-pinning assertions (accepted). |

**Nothing has slipped from the review lists.** The only gap is evidence, not behaviour: the I3/M5 manifest test and the push build test cited in the lane A report are not in the repository (D1).

---

## Defects found in this re-review

### D1 (Important, test evidence): two Android tests are gitignored and have never run in CI

- **Where:** `mobile/android/.gitignore:5` holds the pattern `build/`. It also matches the *source* test package `mobile/android/app/src/test/java/com/openmychat/mobile/build/`.
- **Effect:**
  - `ManifestHardeningTest.kt` (3 tests: cleartext off, tap activity not exported, the launcher reads no chat extras) and `PushBuildConfigurationTest.kt` (3 tests: the plugin is applied only with the json, the json is never committed, the messaging service is not exported) exist only untracked in the `m-android` worktree. `git check-ignore -v` confirms that `mobile/android/.gitignore:5` matches both.
  - The red log `fixwave-A-red-4-notifications-manifest-text.log:51-54` shows they ran locally. The lane A report cites them as evidence for I3, M5 and decision P, but CI has never run them, and the merged repository does not protect those hardening points.
  - The three older files in that package (`CredentialHygieneTest`, `DebugOnlyTrustTest`, `ReleaseConfigurationTest`) are tracked only because they were force-added. Any new file there is silently dropped.
- **Fix:**
  1. Anchor the pattern: `/build/` and `/app/build/`. Alternatively add `!app/src/**/build/`.
  2. `git add` the two files from `m-android`.
  3. Push and let `mobile-android` CI run them. This is test-only; no app code changes.

### D2 (Important, owner documentation): `docs/PUSH-SETUP.md`

See 1.4, items 1–3. Fold `docs/PUSH-SETUP-android.md` into §2 and delete it. Correct §4 step 4: Android shows an ordinary «Входящий звонок» notification, and iOS gets no call push without PushKit/CallKit. Name `com.openmychat.mobile` in §1.1.

### D3 (Minor, CI): contract changes do not trigger the platform workflows

- **Where:** `.github/workflows/mobile-android.yml` `paths` covers only `mobile/android/**` and its own file. `mobile-ios.yml` covers `mobile/contracts/fixtures/**`, but not `mobile/contracts/copy/**`.
- **Effect:** a change to `copy/ru.json` (both `CopyRu` tests), or to fixtures or reducer vectors (Android `ContractFixturesTest` and `DeliveryReducerVectorsTest`), can land with a green CI while the platform tests would fail.
- **Fix:** add `mobile/contracts/**` to both `pull_request` and `push` path lists. Optionally, have desktop `copy-ru.test.mjs` read `ru.json` too (1.2).

### D4 (Minor, documentation): `mobile/contracts/parity-matrix.md` is stale after the platform merges

- Lane S rebuilt it before lanes A and I landed. It still shows Android and iOS push as ✗, Android I1/I4/P1–P4/P8/P11 open, iOS I1/I3/P5–P7/P9 open, and copy as «◐ переходят» (`parity-matrix.md:33-50`).
- **Fix:** refresh it from the A and I reports. The remaining ◐ are calls (no PushKit/CallKit, no Android full-screen call), «Побудка» (foreground only), and real push delivery not yet tested.

### D5 (Minor, consistency): the legacy `/auth/register` 403 has no `code`

- **Where:** `server/src/api/index.js:620-623`. It returns `{error: 'Самостоятельная регистрация отключена администратором'}` with no `code`.
- **Effect:** desktop's `describeAuthFailure` cannot map it to the canonical `reg.disabled`. The case arises only in a race, because the form is hidden by `/settings/info`.
- **Fix:** an additive change, `{ error: REGISTRATION_DISABLED_MESSAGE, code: 'REGISTRATION_DISABLED' }`, plus one test.

---

## 5. Release-readiness checklist for the owner

### Done (on `b1ab56b`)

- **Server:**
  - email-code registration gated by `allow_registration`, with global code limits;
  - blocks enforced on calls, «Побудка» and edits;
  - account deletion broadcasts no erased data;
  - push code for FCM v1 and APNs, ids only, off without keys;
  - the dev stand isolated from production (port 2014, no production env);
  - CI actions pinned by SHA.
- **Contracts:**
  - openapi covers every new endpoint;
  - 71 reducer vectors, notify vectors and fixtures, with a drift test;
  - `copy/ru.json` is the canonical Russian copy, checked by Android, iOS and desktop.
- **Desktop:**
  - report reasons in Russian;
  - a working registration switch with honest banners;
  - multi-device parity (away, `mark_read`, minimize);
  - canonical copy and `engines >=22.12`.
- **Android:**
  - requests bound to their account;
  - sign-out revokes the device secret;
  - uploads 2 at a time with transient retries;
  - notification taps hardened;
  - cleartext off;
  - FCM push behind `google-services.json`;
  - registration switch;
  - canonical copy.
- **iOS:**
  - Keychain AfterFirstUnlock, with locked ≠ absent;
  - an offline launch keeps the session;
  - privacy manifest, Info.plist and RGB icon;
  - push code with an entitlements template, notification permission, tap and BG flush;
  - DM_NOT_ALLOWED lock and the parity fixes;
  - canonical copy.

### Before merging to master (Railway deploys master to production)

1. **Fix D1 and D2** (and ideally D3–D5). Get CI green on the new head: `security-checks`, `mobile-android` and `mobile-ios`.
2. **Railway environment** (check each in the service's Variables):
   - `SMTP_HOST`, `SMTP_PORT` (587, or 465 with `SMTP_SECURE=true`), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and optionally `SMTP_REPLY_TO`.
     - Without `SMTP_HOST`/`SMTP_FROM`, registration answers 503 `EMAIL_NOT_CONFIGURED` and the clients show «почта не настроена».
     - TLS verification cannot be disabled, so the SMTP host must present a valid certificate.
   - `REGISTRATION_ALLOWED_EMAILS`: prefer **exact addresses**. A `@domain` entry is allowed and now capped by the global limits (`REGISTRATION_GLOBAL_REQUESTS_PER_HOUR=60` and `REGISTRATION_GLOBAL_FAILED_VERIFIES_PER_HOUR=300` by default), but exact entries keep unknown addresses in «pending».
   - **`DATA_DIR` must NOT be set.** If it is, the server opens an empty database (`server/src/config/index.js:7`).
   - Push keys are optional now; push stays off without them. When the keys arrive: `PUSH_FCM_SERVICE_ACCOUNT_JSON` (or `_FILE`) and `PUSH_APNS_KEY`/`_KEY_FILE`, `PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID`, `PUSH_APNS_BUNDLE_ID=kz.centras.centychat`. Check the boot log line `[Push] …` (PUSH-SETUP §1.4).
3. **The migrations are additive.** The server review verified that a rollback is safe. Take a Railway volume or DB backup before the deploy anyway.
4. **After the deploy** (owner decision 2026-10-07):
   - In the desktop admin, open «Консоль → Настройки» and enable «Самостоятельная регистрация сотрудников» (`allow_registration=true`). Do this only once SMTP is set.
   - Then send one real code to your own address and verify it.
   - Expect the security monitor to show registration as «Включена» (a warning, by design).
   - Turning it on also opens the legacy desktop form, which creates «pending» applications only.
5. **Desktop packaging:**
   - On the release machine, with Node ≥ 22.12, run `cd desktop && npm ci && npm run pack`, then `npm run dist` and the signing script. No CI job runs electron-builder.
   - Renderer changes reach installed 1.0.x/1.1.0 shells from the server. **Minimize-to-away (P16c) needs a new shell**, so bump the version and publish an update (`npm run release` / `publish:update`).
   - Check the new «Настройки» checkbox, the «Заявки» banner, the «Показать полностью» toggle on reports, and the status pill against the dev stand. Lane D took no screenshots.

### Physical-device checks (before any store or corporate build)

Use a separate staging server with keys, never production (PUSH-SETUP §4).

- **Push, Android:**
  - Use a Play-image device and a build with `google-services.json`.
  - Background or kill the app, send a DM, and expect the name and text.
  - The tap opens the chat for the right account.
  - Reading on desktop dismisses the notification.
  - After sign-out nothing arrives and shown notifications are gone.
  - A call push shows «Входящий звонок» for 30 s.
- **Push, iOS:**
  - Use a development-signed device build with `CODE_SIGN_ENTITLEMENTS` set.
  - The permission sheet appears once after sign-in.
  - Check the token's environment (`sandbox`).
  - Run the message push, the tap and the silent `read` dismissal.
  - An explicit sign-out unregisters the token.
  - Calls arrive only while the app is running (no PushKit).
- **Background flush:**
  - Android: airplane mode, queue a message, background the app, network back. WorkManager sends it once, with no duplicate.
  - iOS: the same with `BGAppRefreshTask` (`kz.centras.centychat.delivery-flush`). iOS schedules it at its discretion, so test with Xcode's `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"kz.centras.centychat.delivery-flush"]`. The flush after termination is accepted as device-only (Ruling V3).
- **R8 frame times (Android release):** re-measure the gfxinfo jank on a physical device. Task 6 emulator numbers were not conclusive (progress.md:139).
- **Calls and «Побудка» sound:**
  - Run a two-way call on both phones and desktop: audio route, mute, end on either side, and blocked users cannot call.
  - Check the «Побудка» sound and alert on each client, plus DND.
  - Android has no microphone foreground service, so a call loses the mic when backgrounded on API 34+ (pre-existing).
- **Notification permission sheet:**
  - Android 13+: `NotificationPermissionPrompt` (`A/MainActivity.kt:95-96`) has been tested only in unit tests, never on a device.
  - iOS: asked once after the first sign-in, and a refusal is not asked again.
- **Also:**
  - Forced 401 / token expiry on Android (the session survives, the queue stays).
  - iOS locked device during a call (I1 scenario).
  - An iOS offline cold launch (I2).
  - Sign-out with unsent messages (count line) on both phones.

### App Store and corporate distribution

- **iOS:**
  - **Account:** Apple Developer Program (or Enterprise for in-house).
  - **App ID** `kz.centras.centychat` with Push Notifications enabled.
  - **APNs key** `.p8` on the server.
  - **Signing:** add the Push capability or set `CODE_SIGN_ENTITLEMENTS = Signing/CentyChat.entitlements` (PUSH-SETUP §3). Bump `CURRENT_PROJECT_VERSION` for every upload.
  - **App Store Connect:**
    - App Privacy labels: contact info, user content, identifiers, and the push token.
    - A privacy policy URL and a support URL. **Neither exists yet** (`docs/HANDOFF-2026-10-05.md:29`).
    - English review notes with a demo account on an internet-reachable server.
    - Export compliance: already answered by `ITSAppUsesNonExemptEncryption=false`.
  - **Review guideline risks:**
    - 3.2 (single-company app): plan a Custom App via Apple Business Manager, Unlisted, or TestFlight-only.
    - 1.2 (report and block: present and server-enforced).
    - 5.1.1(v) (in-app account deletion: present).
  - **Before upload:** run Xcode «Generate Privacy Report» on the archive.
  - **Not in v1:** CallKit/PushKit (calls in the background).
- **Android:**
  - **Signing:** a release keystore and `signingConfig`. **None exists** (`mobile/android/app/build.gradle.kts` has none, and the release APK is unsigned). Store the keystore outside git.
  - **Versions:** bump `versionCode` (currently 1) and `versionName`.
  - **Firebase:** `google-services.json` for `com.openmychat.mobile`, plus the CI secret step (1.4 item 4).
  - **Distribution:** a managed Google Play private app (Play Console + organisation), or MDM sideload.
  - **Play forms:** Data safety, `POST_NOTIFICATIONS` rationale, and target SDK 36 (OK).
  - **Encryption at rest:** EncryptedSharedPreferences uses `security-crypto 1.1.0-alpha06`, which is accepted (M9).
- **Both:**
  - Production is pinned in release builds (Android `ServerConfig.kt:19,26`, iOS release lock job).
  - Never point test builds at production. Use the dev stand on port 2014 or a staging server.
