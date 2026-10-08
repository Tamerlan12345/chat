# Task 8 report — iOS: avatars, push token, authorized media

Lane: `m-ios`, branch `mobile/ios` (started at integration head 1c29871). Pushed without `--force`.

## Status

DONE_WITH_CONCERNS — CI green (unit + UI + Release lock + screenshot publish). Concerns below.

## Commits (on `mobile/ios`, after 1c29871)

| SHA | Message |
|---|---|
| bbba3ce | test(ios): avatars by link, push-token registration, BUSY wait and per-account people filters (red) |
| 9353819 | feat(ios): avatars by link — X-Avatar-Format, /ws?avatars=url, authorized cached loader |
| 3978543 | feat(ios): register the APNs token with the server (push.md §2) |
| aaabb7c | fix(ios): people filters belong to the signed-in account; BUSY is a short wait |
| 7edd212 | test(ios): UI tests upload stand photos and share the system-prompt helper |
| bdab8bd | docs(ios): avatar loader and push-token registrar in the structure |
| 9bfc8f4 | fix(ios): token hex conversion is callable off the main actor |
| 4fa4e29 | test(ios): the card screenshot opens Bob, so the large photo is shown |
| 12a4dea | test(ios): at accessibility sizes the card screenshot falls back to the first row |

Note: 9353819 does not compile on its own (it references `LivePushTokenService`, added in the next commit); every pushed head compiles.

## What was implemented

**Avatars as links (contract `openapi.yaml` `User.avatar_url`, `ws-protocol.md`).**
- `APIClient` sends `X-Avatar-Format: url` on every request (JSON requests and the multipart upload). Every request goes to the configured server, so the header never reaches another host.
- `ServerEndpointPolicy.webSocketURL` builds `wss://<host>/ws?avatars=url`.
- New `Core/Media/AvatarImageLoader.swift` (actor, no third-party code):
  - `resolve(raw, serverURL, diameter)`: a server-relative path resolves against the server; only `https` is loaded (`http`, `//host`, `data:`, `javascript:` and empty values give nil, so initials show). The server's own `/api/users/<id>/avatar` gets `size=s` up to 48 pt and `size=m` above (same rule as Android `AvatarOptIn`). An existing `size` is replaced. Other hosts keep their URL.
  - Bearer token only to the configured origin over HTTPS. Other hosts get no token. Redirects are refused with a per-task delegate, so the token cannot follow a redirect.
  - Cache keyed by URL in two layers: memory (`NSCache`, 8 MB cost limit) and disk (`Caches/Avatars`, `isExcludedFromBackup = true`, file names are the SHA-256 of the URL, plus a JSON metadata file).
  - An entry is fresh for the response's `max-age` (the server sends `private, max-age=86400`; the default is 1 h). After that it is revalidated with `If-None-Match`:
    - 304 renews the entry
    - 200 replaces it
    - 404 or 410 drops it (initials)
    - network failure keeps showing the stale photo
    - a non-`image/*` answer is not cached
  - Requests for the same URL that run at the same time share one fetch.
  - The loader's `URLSession` has no `URLCache`, so `removeAll()` really forgets every photo (memory, disk, in-flight answers via a generation counter).
- `AvatarView` (used everywhere) gets the loader from `EnvironmentValues.avatarLoader`, which `appEnvironment` injects. It still shows inline `data:image` values from older servers. `AsyncImage` is gone because it cannot send the token.
- Fallback colour: the old `AvatarView` used `name.hashValue`, which is seeded per process. That is non-deterministic and breaks ledger ruling 2026-10-02. It is now `AvatarPalette`, an exact port of desktop `lib/avatar.mjs`: the same 8-colour palette, the hash over UTF-16 code units, and the same mixing. Initials follow the desktop too: a lowercase second word («Администратор системы») is not a name. The background is a solid palette colour, as on desktop and Android, instead of the previous gradient.
- Wipe: `AppContainer.sessionDidEnd()` runs `avatars.removeAll()`. This covers logout, revoked session and account deletion (`finishAccountDeletion` → `endSession`).

**Push token (contract `push.md` §2).**
- `APIClient.registerPushToken` sends `POST /api/devices/push-token` with this body: `{platform:"ios", token, environment, kind, app_version, device_id}`. Optional fields that are nil are left out.
- `APIClient.unregisterPushToken` sends `DELETE /api/devices/push-token {token}` and returns `removed`.
- New `Core/Push/PushTokenRegistrar.swift` (`@MainActor`):
  - It registers the `alert` token (lowercase hex) after every sign-in and every launch with a live session (`sessionDidAuthenticate`, which restore and knock also reach) and on every new token. The same token is not sent twice.
  - On logout it removes the token with a best-effort DELETE, called from a new `SessionLifecycleDelegate.sessionWillSignOut()` while the session is still valid. The server also removes it on `/auth/logout` (which sends the same `device_id`) and on account deletion.
  - It forgets its state on any session end.
  - A failed registration is logged and retried at the next sign-in, launch or token change.
  - `environment` is `sandbox` in DEBUG builds and `production` in Release. `device_id` is the Keychain device id also used by knock and logout.
- `CentyAppDelegate` calls `registerForRemoteNotifications()` at launch (skipped in the unit-test host) and forwards `didRegisterForRemoteNotificationsWithDeviceToken` to the registrar through `PushRouter`. The failure callback is only logged. **No entitlement or Info.plist change**: without an Apple developer account there is no `aps-environment`, so APNs answers with the failure callback and nothing is registered. CI simulator builds are unaffected.

**Ruling D.**
1. `PeopleSearchUITests` dropped its private copy of the prompt helper and calls the shared `app.dismissSystemPrompts(timeout: 10)` after the tab bar appears.
2. `@SceneStorage("people.filters")` now stores `{owner, filters}`. `PeopleFilters.restored(from:owner:)` gives the filters back only to the account that saved them. Another account, no user, or the old format without an owner gets empty filters. `PeopleView` passes `session.currentUser?.id`.
3. `AccountFailure` treats `BUSY` (as well as `PASSWORD_HASH_BUSY` and `LOGIN_BUSY`) on registration `503` as `.throttled(until: now + Retry-After ?? 5 s)`, the same as Android `AccountFailure.BUSY_CODES`. It is no longer reported as «почта не настроена».

**Screenshots with photos.** `mobile/dev/seed.mjs` seeds no avatars (`mobile/dev/**` was not edited). `StandAPI` in `UserPathQATests.swift` is now internal and gained `uploadAvatar(as:jpeg:)`, which sends `PUT /api/users/avatar` as multipart with field `file`. `StandAvatars.ensureUploaded` uploads generated head-and-shoulders JPEG portraits for Alice and Bob once per test run, before the inbox and people screenshot tests. No pbxproj change was needed.

## Tests

New or changed XCTests:
- `AvatarTests`:
  - desktop colour vectors, computed with node from `avatar.mjs`, including an emoji name and an empty name
  - stability of the colour across calls
  - initials
  - URL resolution and size selection
  - only-HTTPS rules
  - `X-Avatar-Format: url` on API requests, through `RecordingURLProtocol`
  - `wss://…/ws?avatars=url`
- `AvatarImageLoaderTests`, against the new stub `Support/AvatarStubURLProtocol` (queued replies, headers recorded):
  - Bearer to own server
  - no token to another host
  - no plain-HTTP request
  - memory hit without a request
  - disk survives a new loader, and the directory is excluded from backup
  - stale entry revalidated with `If-None-Match`, 304 keeps and renews it
  - a changed photo replaces memory and disk
  - 404 drops the entry
  - offline keeps the stale photo
  - a non-image answer is not cached
  - `removeAll` wipes memory and disk
  - sign-out and account deletion wipe the cache, end-to-end through `TestApp`
- `PushTokenAPITests`:
  - the contract body and Bearer token
  - optional fields omitted
  - DELETE body and answer
  - a 400 `INVALID_TOKEN` comes through as an error
  - hex encoding
  - DEBUG builds use the sandbox
- `PushTokenRegistrarTests`:
  - a token waits for a session
  - registration during the session, deduplicated, and a new token replaces the old one
  - sign-out removes the token and stops registering
  - a failed registration is retried at the next sign-in
  - session wiring: login registers, logout removes the token *before* `/auth/logout`, and a launch with a live session registers again
- `RegistrationAPITests.testBusyServerIsAShortWaitThatHonoursRetryAfter`: `Retry-After: 7` waits 7 s; without the header it waits 5 s.
- `PeopleStoreTests.testStoredFiltersBelongToTheAccountThatSetThem`.
- `TestApp` gained `pushTokens:` and `avatarLoader:` injection.

### TDD evidence

- RED: commit bbba3ce (tests plus compiling skeletons that return nil, 0 or empty values), run **37270583338** — **failure**.
  - The Release build passed.
  - The test build failed on one test-side isolation error: `PushTokenTests.swift:98: call to main actor-isolated static method 'hex' in a synchronous nonisolated context`. So the RED run stopped at compilation, not at failing assertions. I am stating this plainly.
  - The skeletons make every new assertion fail by construction: `resolve`, `data`, `colorHex` and `hex` return nil, 0 or empty, the API methods throw, and there is no header or WS query.
  - A second RED run was not spent because it would have required reverting the implementation on the pushed branch.
- Run 37271097801 (implementation pushed before RED finished) was cancelled. It would have failed on the same compile error.
- GREEN: commit 9bfc8f4 (`hex` made `nonisolated`), run **37271316282** — **success**.
  - Unit tests: **311 executed, 0 failures**.
  - UI tests: **14 executed, 0 failures** (719 s).
  - Release server lock: success. Screenshots published.
- Commit 4fa4e29, run **37273257820**: **failure**. In the ax-xxxl variant, Bob's row was below the fold and was never built into the accessibility tree («Bob must be listed (ax-xxxl)»). The light and dark variants passed, and their card screenshots show Bob's large photo.
- Final: commit **12a4dea** (at ax-xxxl the screenshot falls back to the first row), run **37278432258**: **success**. Unit tests: 311 executed, 0 failures. UI tests: 14 executed, 0 failures. Release lock: success. Screenshots: published.

## Screenshots

On branch `ci/ios-screenshots`, folders `9bfc8f4/`, `4fa4e29/` and **`12a4dea/` (final)**:
- `ScreenshotTourTests-testSignedInInboxAsAlice--03-inbox-alice-{light,dark}.png`: Bob's dialog row shows his photo.
- `PeopleSearchUITests-testPeopleScreensForReview--10-people-{light,dark,ax-xxxl}.png`: Bob has a photo; «Администратор системы» shows the initials «А» on the desktop colour `#475569`.
- `…--11-person-card-*.png`: in `9bfc8f4` this is the admin card (initials). In `4fa4e29/` and `12a4dea/` (light and dark) it is Bob's card with the large `size=m` photo. The ax-xxxl variant shows the first row's card.
- `…--12-search-*.png`: the person hit for Bob shows his photo.

Read them with `git show origin/ci/ios-screenshots:<sha>/<file>`.

## Files changed (mobile/ios only; workflow untouched)

- New: `CentyChat/Core/Media/AvatarImageLoader.swift`, `CentyChat/Core/Push/PushTokenRegistrar.swift`, `CentyChatTests/AvatarTests.swift`, `CentyChatTests/AvatarImageLoaderTests.swift`, `CentyChatTests/PushTokenTests.swift`, `CentyChatTests/Support/AvatarStubURLProtocol.swift`.
- Changed: `CentyChat/UI/DesignSystem/Components/AvatarView.swift`, `CentyChat/App/AppContainer.swift`, `CentyChat/App/PushRouting.swift`, `CentyChat/App/Stores/SessionStore.swift`, `CentyChat/Core/Network/APIClient.swift`, `CentyChat/Core/Network/ServerEndpointPolicy.swift`, `CentyChat/Features/Auth/AccountFailure.swift`, `CentyChat/Features/People/PeopleModel.swift`, `CentyChat/Features/People/PeopleView.swift`, `CentyChatMobileApp/CentyChatMobileApp.swift`, `CentyChatTests/PeopleStoreTests.swift`, `CentyChatTests/RegistrationAPITests.swift`, `CentyChatTests/Support/TestDoubles.swift`, `CentyChatUITests/PeopleSearchUITests.swift`, `CentyChatUITests/ScreenshotTourTests.swift`, `CentyChatUITests/UserPathQATests.swift`, `README.md`.

## Self-review

- Completeness against the brief:
  - header and WS opt-in ✓
  - loader with memory + disk, URL/ETag, Bearer only to origin, wipe on sign-out and deletion ✓
  - used by `AvatarView` everywhere ✓
  - desktop name-hash fallback ✓ (it was *not* kept before, now fixed)
  - push register after login, launch and token change; removed on logout (deletion is server-side) ✓
  - APNs code compiled and inert, no entitlement change ✓
  - Ruling D 1–3 ✓
  - screenshots with photos ✓
- Swift 6: no `@unchecked` or `nonisolated(unsafe)` in production code.
  - The loader is an actor; `NSCache` is actor-isolated and built in the init before assignment.
  - `RefuseRedirects` is a stateless `final` NSObject that is `Sendable`.
  - The registrar is `@MainActor`; `hex` is `nonisolated static`.
  - Test doubles use the existing `Locked` box (`@unchecked Sendable`, test target only, existing pattern).
- Existing patterns: same `RecordingURLProtocol` and `TestApp` harness, `Log` categories, contract comments. No existing test was weakened or deleted. `PeopleFilters.encoded`/`decoded` are kept because existing tests cover them.
- YAGNI: no PushKit or VoIP registration (no CallKit yet). `Kind.voip` exists only because it is part of the contract DTO.

## Concerns

1. **The RED run failed at test compilation (one isolation error in a test), not at assertions.** See TDD evidence.
2. **VoIP (PushKit) token not registered.** `push.md` says iOS registers both `alert` and `voip`. PushKit needs CallKit (`reportNewIncomingCall` on every VoIP push) and the `voip` background mode, which was removed for App Review until CallKit exists. Only `alert` is registered; the DTO supports `kind: voip`.
3. **Explicit DELETE on logout** goes slightly beyond `push.md` («отдельно звать не нужно»), but follows the brief. It is best effort. If `/auth/logout` then fails (only on a Keychain error), the token stays unregistered until the next launch.
4. **`environment` is `sandbox` for DEBUG and `production` for Release.** This matches Xcode versus TestFlight/App Store signing, but an ad-hoc Release build signed with a development profile would report the wrong value. Revisit when signing exists.
5. **Old avatar versions stay on disk until sign-out.** When `v=` changes, the previous URL's files are not pruned. They are small JPEGs (≤ 256 px) in Caches, which the OS may purge.
6. **Search message hits for your own messages show the partner's initials, not their photo.** This is Task 7 behaviour: `hit.isOwn ? nil : senderAvatar`. A follow-up could look the photo up in the directory.
7. The loader does not refresh an expired token on 401. It keeps the stale photo or shows initials, and the next view load retries after `APIClient` has refreshed the token.

---

## Fix report — review round 1

Commits: 7063141 (red tests), 22c8953 and the two commits before it (fixes): `fix(ios): every discarded session wipes its local data, awaited; no logout DELETE`, `fix(ios): avatars load only from the server's avatar path`, `fix(ios): sign-out clears the stored people filters`.

### Changes

1. **Launch-time session end now wipes (privacy).** `SessionStore` sends every path that discards stored credentials through the same `delegate.sessionDidEnd()` as sign-out. That call wipes photos, the people directory cache, search recents and the stores.
   - Paths covered:
     - a stored token refused at launch whose knock then fails (`restoreStoredSession` → `enterWithDeviceSecret(discardsSession: true)`)
     - a device secret whose knock fails
     - credentials issued by another server (`bindStoredCredentials` returns `.wiped`)
     - failure to wipe foreign credentials (fail closed)
   - Revalidation was already covered: a failed knock there leads to `endSession`.
   - A successful knock keeps the data, because the device secret belongs to the same user.
2. **The token never follows a redirect.** New test: the own-server avatar answers 302 to `https://cdn.example.org/…`, and the loader returns no photo and records exactly one request. The stub URLProtocol can now emit `wasRedirectedTo`. The test passed in the RED run because the `RefuseRedirects` guard already existed.
3. **The loader only loads the server's avatar path.** `resolve` and `data(for:)` accept only HTTPS on the configured origin with path `/api/users/<id>/avatar`. That URL always carries the token. Other hosts are never requested (no third-party IP leak), and other server paths never get the token; both show initials.
4. **No `DELETE /devices/push-token` on logout.** `sessionWillSignOut` is removed, along with `PushTokenRegistrar.sessionWillSignOut` and `PushTokenService.unregister`. `/auth/logout` with `device_id` removes the token server-side (`push.md` §2). `APIClient.unregisterPushToken` stays as the contract endpoint and is tested. The contract needs no removal on token change: a new token of the same device replaces the old one.
5. **Stored people filters are cleared on sign-out.** `PeopleFilters.retained(_:signedInUser:)` returns "" when no user is signed in or the account differs. `PeopleView` applies it `onChange(of: currentUser?.id)` and `onDisappear`, in addition to owner-scoping.
6. **The wipe is awaited.**
   - `SessionLifecycleDelegate.sessionDidEnd()` is now `async`, and `AppContainer` awaits `avatars.removeAll()` inside it instead of starting an unstructured `Task`.
   - `endSession` awaits the wipe *before* `phase = .signedOut`, so the login screen cannot start a new session during the wipe.
   - The launch path re-checks `isSigningIn` and `phase` after the await.

### Tests

New or changed tests:
- `AvatarImageLoaderTests`:
  - `testASessionRejectedAtLaunchWipesTheSessionCaches`: avatar memory and disk, people cache and recents are all empty.
  - `testAnotherHostIsNeverRequested` replaces the old "no token to another host" test.
  - `testAnotherPathOnTheServerIsNeverRequested`
  - `testTheTokenNeverFollowsARedirect`
  - The sign-out and deletion wipe tests now assert immediately after `logout()` / `finishAccountDeletion()` returns, without `eventually`.
- `AvatarTests.testOnlyHTTPSImagesAreLoaded`: other hosts and other server paths give nil.
- `PushTokenRegistrarTests`:
  - `testSignOutStopsRegistering`
  - `testSignInRegistersAndSignOutLeavesRemovalToTheServer`: no DELETE, logout called, signed out.
- `PeopleModelTests.testSignOutClearsTheStoredFilters`

Item 4 changed my own tests from this task to the new rule. No pre-existing test was changed.

### CI

- RED: commit 7063141, run **37281660751**, **failure at assertions** (real RED this time). Unit tests failed in `AvatarImageLoaderTests` (10 failures) and `AvatarTests` (2), plus `PeopleModelTests` and `PushTokenRegistrarTests`:
  - photos still cached after logout returns and after deletion ("7 bytes")
  - launch-time rejection left the photos, `CachedPeople` and recents in place
  - another host and another path were requested and returned the photo
  - `resolve` kept the cdn and download URLs
  - `retained` kept the stored filters for nil and for another user
  - logout sent the DELETE (`["abcd0102"]`)
  - The redirect test passed, as expected.
- GREEN: commit **22c8953**, run **37281883653**, **success**. Unit tests: **315 executed, 0 failures**. UI tests: **14 executed, 0 failures**. Release lock: success. Screenshots: published to `ci/ios-screenshots:22c8953/` (17 PNGs).

### Remaining concerns

Unchanged from the main report (VoIP token, sandbox/production heuristic, old avatar versions on disk, own-message search hits). Concern 3 there (the logout DELETE) is resolved by this round.

New behaviour to note: a launch with only a device secret whose knock fails *offline* is treated as an ended session, so its local caches are wiped. They are rebuilt after the next sign-in.
