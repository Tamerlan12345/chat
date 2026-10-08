# SDD ledger — plan: C:/Users/user/Documents/Нет в репо/chat/.claude/worktrees/mobile-release-parity/docs/superpowers/plans/2026-10-05-continuation.md

Spec: mobile/contracts/*, docs/superpowers/plans/2026-10-02-design-brief.md, PRODUCT.md (reachable).
Start: integration branch at 2dd1853 (plan commit). Pre-session fix: ece2993 iOS deletion UI test swipes `profile-list`.

## Pre-flight scan
| Rows | Produces / consumes | Finding |
|---|---|---|
| T1 ↔ T2 | both touch desktop AdminUserModal.jsx | sequential in one lane — OK |
| T3 ↔ T4 | T3 adds account/report repos; T4 chat bubble menu + attachments in ChatScreen/ChatViewModel | sequential — OK |
| T4 ↔ T5 | T4 adds Копировать/Редактировать/Удалить menu; T5 «reply/edit/delete confirmation» on reducer | overlap → Ruling A |
| T5 | replaces QA in-memory queue (4d08e46…) | must keep those tests — stated in task |
| T5 ↔ T9 | same reducer vectors | consistent — OK |
| T4 ↔ T9 | attachment parity | T9 follows T4 behaviour — OK |
| T6 ↔ T3–T5 | restyles screens they add | ordered last in lane — OK |
| T7 ↔ T8 | T8 changes AvatarView used by T7 | T7 uses existing AvatarView; T8 upgrades in place — OK |
| T7 ↔ T10 | T10 restyles T7 screens | T10 excludes People build, polishes it — OK |
| T1..T10 self-consistency | tests specified vs files | no contradictions found |
| T2 | needs local server for screenshots | uses throw-away DB, non-2004 port — OK |

Ruling A: Task 4 adds the bubble menu entries on the current repository calls; Task 5 moves edit/delete onto the reducer and adds confirmations — avoids blocking QA D7 on the core rewrite — if wrong: menu wiring touched twice.
Ruling B: Three lanes run in parallel (Desktop, Android, iOS) despite SDD's one-implementer rule — disjoint worktrees and owned paths, owner asks for parallel subagents; controller merges each lane into the integration branch — if wrong: merge conflicts only in docs/CI files, resolved by controller.

## Progress
Task 1: review dispatched (sonnet) on 2fc22db..f7f3dd1 (review-only task)
Task 3: implementer dispatched (opus), lane m-android, BASE 2dd1853
Task 7: implementer dispatched (opus), lane m-ios, BASE 2dd1853
Task 1: review — spec ❌ (1 Important: deleted attachment preview «Вложение» vs «Сообщение удалено», live-events.mjs:9 + test 238-241); D2 ✅
Task 1: minor (deferred): AdminUserModal double fetch on mount after first tick; App.jsx registration_pending case + modal effect untested; redundant guards live-events.mjs:5-7
Task 1: note: server broadcastToAdmins skips scoped admins while the modal shows them registrations — server is read-only in this plan; for final review
Task 1: fix round 1 dispatched (fresh implementer, sonnet; original implementer was another session), lane m-desktop, FIX_BASE f7f3dd1 (m-desktop at 2dd1853)
Task 1: fix round 1 DONE 7ef758b (also wired live-events.test.mjs into npm test — it never ran; 473/473); scoped re-review dispatched
Task 1: fix round 1/5 (1 addressed, 0 open; commits 2dd1853..7ef758b)
Task 1: complete (commits 2fc22db..7ef758b, review clean after 1 fix round); merged into integration
Task 1: minor (deferred): mobile clients' last_message_type previews may also label deleted attachments «Вложение» (out of scope observation)
Task 2: implementer dispatched (sonnet), lane m-desktop
Task 2: implementer DONE (d56fe6c..03d4cdf; 481 pass, build green, screenshots light/dark); review dispatched (sonnet)
Task 2: complete (commits d56fe6c..03d4cdf, review clean); merged into integration
Task 2: minor (deferred): ReportsAdmin reload uses captured filter after close; list flicker on reload + no reload on 404 close/remove; PATTERN_RE copied from server without drift test; reporter?.name could print undefined
Task 3: implementer DONE_WITH_CONCERNS (2dd1853..4f35076; 450 unit, lint 0, androidTest 60/60); review dispatched (opus, large diff). Dev stand left running on SERVER_PORT=2014 + emulator.
Controller CI fix (outside plan tasks): iOS UI flakes — ece2993 (profile-list id; not sufficient) + e2a620c (dismiss Save Password sheet via SpringBoard, diagnostics dump, login field autofill off in UI tests). Ruling: controller fixes pre-existing CI test infra directly (not a plan task, small, blocks every lane's green gate) — if wrong: the fix is unreviewed; final review must look at e2a620c.
Task 3: review — spec ❌ (2 Important: block list not loaded at sign-in; blocked DM not removed from list — contract §4/iOS parity). Fix round 1 sent to original implementer (FIX_BASE 4f35076).
Task 3: minor (→ Task 6): blocked-chat empty state «Напишите первое сообщение» vs «Отправка недоступна» (ChatScreen.kt:327); NOT_DELIVERABLE lock never clears on peer unblock; frozen throttle countdown (DeleteAccountScreen.kt:145, ReportSheet, SafetyNotices); verify() ignores 429 wait; catch Exception swallows CancellationException; tests missing for failed local wipe and cache wipe on deletion; ChatScreen/ChatViewModel/PersonCardScreen large
Task 3: minor (final review): registration sign-in skips claimDevice (knock re-pairing) — check iOS parity
Task 3: minor (→ iOS lane Task 8): iOS maps register/request 503 BUSY (Retry-After) to «почта не настроена»; Android handles BUSY correctly
Task 3: fix round 1 DONE (4f35076..5557e81; 456 unit, ChatSafetyUiTest 5/5; ChatContentTest banner wait flaked once under load, passed alone); scoped re-review dispatched
CI: iOS PR + push green on e2a620c (first green PR run of mobile-ios since 3588648)
Task 3: fix round 1/5 (2 addressed, 0 open; commits 4f35076..5557e81)
Task 3: complete (commits 2dd1853..5557e81, review clean after 1 fix round); merged into integration
Task 3: minor (deferred): overlapping ConversationsViewModel.loadData not serialised; slow sign-in refreshBlocked can overwrite a block made meanwhile; WS message from a blocked person may re-add the DM until next reload
Task 4: implementer dispatched (opus), lane m-android
Task 7: implementer DONE (2dd1853..2ab0cd7; CI 37265738969 green: 271 unit, 14 UI); screenshots ci/ios-screenshots d2ec1a6/2ab0cd7; review dispatched (opus)
Task 7: review — spec ❌ (1 Important: jump-to-message leaves permanent history gap, ChatStore.swift:99-116; Android HistoryWindow parity). Fix round 1 sent to original implementer (FIX_BASE 2ab0cd7).
Ruling C: include the one-line search-date ru_RU fix in Task 7 fix round 1 although Minor — same file area, user-visible English «AM» in Russian UI — if wrong: none (tiny change, still re-reviewed).
Task 7: minor (→ Task 10): «Все» list style (plain list on grey with white bands/large section gaps); card from chat-header avatar not implemented; @SceneStorage people filters survive sign-out (previous user's query visible — privacy, fix in Task 8 or 10); timing-based UniversalSearchTests may flake; «Скопировано» HUD early hide; no feedback when hit message gone; highlight weight/stagger/own-DM avatar/re-ranking per access; private dismissSystemPrompts copy in PeopleSearchUITests → shared helper after merge; ConnectionBanner and Отделы stagger missing
Task 7: fix round 1 DONE (2ab0cd7..5935314; CI RED 37267802308 → GREEN 37267887312: 277 unit, 14 UI); scoped re-review dispatched
Task 7: fix round 1/5 (2 addressed, 0 open; commits 2ab0cd7..5935314)
Task 7: complete (commits 2dd1853..5935314, review clean after 1 fix round); merged into integration (1c29871)
Task 7: minor (deferred): realtime edit/delete during window load overwritten by snapshot (Android same); DateFormatter per row; reconnect load() after long offline can leave a gap (pre-existing — relevant to Task 9 core)
Ruling D: fold three small iOS items into Task 8 — swap PeopleSearchUITests' private prompt helper for the shared one; clear @SceneStorage people filters on sign-out (previous user's query leaks to next account — privacy); map register/request 503 BUSY with Retry-After to a wait (Android parity) instead of «почта не настроена» — all touch session/network code Task 8 already edits — if wrong: slightly larger Task 8 diff.
Task 8: implementer dispatched (opus), lane m-ios
Task 4: implementer DONE (d258cde..59aa7dd; 517 unit, AttachmentUiTest 12/12, chat 38/38); review dispatching
Task 4: review — 1 Important (security: ACTION_VIEW MIME from sender metadata bypasses server R4-14 safe-type rule); controller's «Редактировать on image» observation = false positive (menu belonged to a text message; canEditMessage false for non-TEXT). Fix round 1 sent to original implementer (FIX_BASE 59aa7dd).
Ruling E: rule in two Minors for Task 4 fix round 1 — Coil thumbnail disk cache not wiped on sign-out (privacy on shared devices) and a canEditMessage(FILE/IMAGE)=false test — cheap, privacy-relevant — if wrong: slightly larger fix diff.
Task 4: minor (→ Task 5): upload failure classified offline only if socket already disconnected (use statusCode==0 → QUEUED); 206 Content-Range start not checked; blocking execute() not cancelled with coroutine; «Файл пустой» client wording; ChatViewModel 733 lines — move upload orchestration to AttachmentSends with the outbox; Photo Picker names (53.jpg) become caption; «Ответить» sends no reply_to_id; ~30 s WS reconnect after returning from picker/viewer (pre-existing)
Task 4: fix round 1 DONE (59aa7dd..28fe01e; 525 unit); scoped re-review dispatched
Task 4: fix round 1/5 (3 addressed, 0 open; commits 59aa7dd..28fe01e)
Task 4: complete (commits d258cde..28fe01e, review clean after 1 fix round); merged into integration
Task 4: minor (→ Task 5): SessionCacheWiper.wipe() — clearImages()/deleteRecursively not guarded; an IOException would crash sign-out and end the collector (wrap in runCatching); in-flight thumbnail fetch may repopulate cache after wipe; tile kind still from sender mimeType (display only)
Task 5: implementer dispatched (opus), lane m-android
Task 5: implementer DONE_WITH_CONCERNS (06bc8ee..fe4e85b; 627 unit, vectors 70/70, androidTest 82/82; airplane→force-stop→relaunch exactly one delivery); review dispatched (opus)
Task 5: review — 2 Important (outbox wiped on involuntary 401 / refresh network error; swallowed load failure then overwritten). Fix round 1 sent to original implementer (FIX_BASE fe4e85b).
Ruling F: rule in for Task 5 round 1 — refresh network error must not end the session (root cause of #1); engine command-loop deferreds completed on exception (worker hang); sign-out wipe failure fails loudly; worker retry() while uploads pending — reliability of the never-lose principle — if wrong: larger fix diff.
Task 5: process deviation: engine/view-model tests written after code (mutation logs show teeth) — recorded, not a blocker.
Task 5: minor (deferred): persistent disk error → tight WS reconnect loop without backoff (§5); upload cancel race between upload return and enqueue; admin delete of others' message ignores sendFrame false (silent drop with no socket); text typed during upload overtakes the file (documented limitation); conversation list own unread logic + refresh_conversation_lists 2 GETs/sync unused; no CANCELLED_MAX vector (raise with Integration; local test trimming at 100); background flush not run on device (TestListenableWorkerBuilder test); weak persist-before-send ordering assertion (DeliveryEngineTest:83); LocalSendTimes global map never pruned/cleared on sign-out
Task 8: implementer DONE_WITH_CONCERNS (1c29871..12a4dea; CI 37278432258 green: 311 unit, 14 UI); review dispatched (opus)
Task 8: review — 1 Important (avatar cache not wiped when stored session is discarded at launch: restore/knock failure path skips sessionDidEnd). Fix round 1 sent to original implementer (FIX_BASE 12a4dea).
Ruling G: rule in for Task 8 round 1 — redirect-refusal test; Bearer only for own-origin avatar path and no fetch from other hosts; drop extra logout push-token DELETE (contract says unnecessary; adds latency/failure mode); literally clear people filters on sign-out; await the wipe in sessionDidEnd — security/privacy hardening, cheap — if wrong: slightly larger fix diff.
Task 8: deferred (→ CallKit task): PushKit voip token not registered — would make server hold call_offer 2 min without CallKit; record as not done.
Task 8: minor (deferred): old avatar versions never pruned before sign-out; initials flash before photo (actor hop) + inline base64 decode per body; test quality (sandbox #if mirror test, FakePushTokenService @unchecked Sendable, RED at compilation); initials differ from desktop for surrogate pairs/titlecase (colour same)
Task 5: fix round 1 DONE (fe4e85b..1b64270; 642 unit; RED 12 failing logged); scoped re-review dispatched
Task 5: fix round 1/5 (5 addressed, 1 new Important open — B1 cross-account send via restore() replaying auth without owner check / adopt dropped while load blocked / me=null after wipe; commits fe4e85b..1b64270)
Ruling H: rule in for round 2 — B2 (engine never ready after sign-out during blocked load), B3 (runCatching adopt swallows cancellation), deleteAccount discard + unsent count in confirmation — privacy/retention and liveness of the never-lose core — if wrong: larger fix diff.
Task 5: fix round 2 sent to original implementer (FIX_BASE 1b64270)
Task 5: minor (deferred): no direct tests for ReplaceHistory/Adopt completing exceptionally; ProfileViewModel.logout deletes unsent before authRepository.logout (user consented); emulator scenario (real authenticator, logout dialog, forced 401) to re-run before release
Task 5: fix round 2 DONE (1b64270..0069c7a; 650 unit; RED 6 failing); scoped re-review dispatched
Task 8: fix round 1 DONE (12a4dea..22c8953; RED 37281660751 assertions, GREEN 37281883653: 315 unit, 14 UI); scoped re-review dispatched
Task 8: fix round 1/5 (6 addressed, 0 open; commits 12a4dea..22c8953)
Task 8: complete (commits 1c29871..22c8953, review clean after 1 fix round); merged into integration (9c14de7)
Task 8: minor (deferred): SessionStore.swift:197 isSigningIn early return skips launch wipe if user signs in mid-knock; secret-only offline knock failure wipes caches (over-eager, harmless); dead FakePushTokenService unregister scaffolding; PeopleFilters scene-storage wiring untested
Task 9: implementer dispatched (opus), lane m-ios
Task 5: fix round 2/5 (B1 text paths, B2, B3, (ii) addressed; 1 Important open — owner not on disk for cache/upload rows → cross-account attachment send and cache visibility; commits 1b64270..0069c7a)
Task 5: fix round 3 sent to original implementer (FIX_BASE 0069c7a) + ruled-in minors: owner check before restore replay/emit; deleteAccount discard despite local SecureStorage failure
Task 5: minor (deferred): RetryWipe claims authenticatedUserId after signedIn (theoretical relabel window); round-1-era me=null+outbox data wiped silently on first claim (unreleased build, ok); delete confirmation reuses sign-out plural string
Task 5: fix round 3 DONE (0069c7a..59f4ce7; 655 unit; RED 5 failing; flaky test due to real network I/O in ProfileViewModelLogoutStorageTest fixed); scoped re-review dispatched
Task 5: fix round 3/5 (finding 1 + deleteAccount addressed; open: restore-emit fix dead in production wiring (DeliveryModule start without signedInAs); new: aborted sign-out leaves engine deaf (signedOut never cleared); inverted claimFor logic in enqueue lets ownerless message through → later silently wiped; ownerSignedIn accepts me==null race; commits 0069c7a..59f4ce7)
Task 5: production-traffic check — old ProfileViewModelLogoutStorageTest hit https://chat.example (reserved, unroutable), no token; no unit test reaches a real host. OK.
Task 5: fix round 4 → fresh implementer (opus) per SDD rounds 4-5 (FIX_BASE 59f4ce7)
Task 5: minor (deferred): HttpDeliveryBackend/RealtimeDeliveryLink use current session token not model owner's (narrow window, epoch checks drop late results)
Task 5: fix round 4 DONE (59f4ce7..debeba9; 661 unit; RED 6; emulator re-run OK: exactly one delivery, sign-out confirmation)
Task 5: fix round 4/5 (4 addressed; 1 Important open — in-flight upload of previous account enqueued/uploaded under new account (needs owner stamped in event, checked in engine loop); commits 59f4ce7..debeba9)
Task 5: fix round 5 sent to round-4 implementer (FIX_BASE debeba9) + ruled-in minors: prune race under lock; RetryClaim signedIn ?: signedInNow()
Task 5: minor (deferred): logout()-threw abort hook is a no-op in production (session already null — safe); handed-over copies pruned on delete-failed sign-out (cosmetic); duplicate auth_success resends head (server de-dupes); RealtimeDeliveryLink.authenticatedUserId returns session id not socket's (safe while RealtimeConnectionManager disconnects on session loss); androidTest ChatTestDoubles builds engine without production wiring
Task 5: fix round 5 DONE (debeba9..2337c48; 666 unit; RED 5; mutation 3)
Task 5: fix round 5/5 (3 addressed, 0 open; 2 new Minor; commits debeba9..2337c48)
Task 5: parked — upload Authorization read at OkHttp dispatch time, not bound to the job's owner (B's bytes could upload under C's token in a narrow window before forget() cancels; no message leak — engine refuses) — Ruling: real, Minor, deferred to final review / hardening; fix = per-job captured token or interceptor skipping requests tagged with another account.
Task 5: parked — sendAttachment from a stale screen uses live owner() not screenAccount (race-only; navigation clears stacks on session loss) — Ruling: real, Minor, deferred; fix = pass screenAccount into add.
Task 5: minor (deferred): late forget() can hide a new file from UI until next restore (pre-existing, nothing lost); editSent states no account.
Task 5: complete (commits 06bc8ee..2337c48, 2 parked after 5 fix rounds); merged into integration (b851c65)
Task 6: implementer dispatched (opus), lane m-android
CI: mobile-android emulator tests RED on b851c65 (Task 5 merge; green on 9c14de7) — assigned to Task 6 implementer as first commit (androidTest doubles not re-run on device after rounds 3-5)
Task 9: implementer DONE_WITH_CONCERNS (9c14de7..4b86f5a; CI 37299354417 green: 420 unit, 15 UI, vectors 70/70); review dispatched (opus)
Task 9: review — 5 Important (aborted sign-out still deletes unsent; late history page / stale owner claimed into other account; signed-out socket frames persisted; other account's waiting files shown; uploads unbounded vs server 2-parallel limit + 429/5xx permanent fail + whole file in memory). Fix round 1 sent to original implementer (FIX_BASE 4b86f5a).
Ruling I: rule in for Task 9 round 1 — composer clears text typed during enqueue; whitespace trim contrary to §6.1; restore publishes before owner check; unknown unsent count when store unreadable; downloader generation guard + dedupe — never-lose/contract/privacy, cheap — if wrong: larger fix diff.
Task 9: minor (deferred): APIClient.raw clears credentials on 401 of the retried request after a successful refresh (check vs request rules); LocalSendTimes static memory only; list unread from ConversationsStore; admin delete direct; no BGTask; tests after code (mutation logs ok)
Task 6: STOPPED 16:52 — 10 commits b851c65..30eb7cb (pushed): f34a9df fixes CI red (MainNavigationTest.tabsBackAndLogout — sign-out waited on unstarted delivery runtime; 82/82 on device); 699 unit; polish incomplete (after-screenshots 9 light only); final tree androidTest not re-run
Task 9: fix round 1 DONE (4b86f5a..503d2e4; CI 37304787048 green: 442 unit, 15 UI); STOPPED 16:52 — scoped re-review NOT yet run
SESSION RESUME 2026-10-06: Task 9 scoped re-review dispatched; Task 6 resumed with fresh implementer
Task 9: fix round 1/5 (10 addressed; new: 1 Important — aborted sign-out (uploads clear fails after engine reset) leaves engine deaf with false message; commits 4b86f5a..503d2e4)
Ruling J: rule in for Task 9 round 2 — stale progress strands file; ownerless-model upload rows not owner-checked; offline «Повторить» stuck; stale download deletes new folder; upload 401 retry with next account's token; generation-guard test that proves nothing — never-lose/owner-on-disk/privacy, cheap — if wrong: larger fix diff.
Task 9: fix round 2 sent to original implementer (FIX_BASE 503d2e4)
Task 9: minor (deferred): uploads retry forever on 5xx (no cap); forget/add race after account switch (pre-existing); cold-launch publish before adopt (consumers gate on me)
Task 9: fix round 2 DONE (503d2e4..d09c7c3; CI 37406041791 green: 453 unit, 15 UI); scoped re-review dispatched
Task 9: fix round 2/5 (7 addressed, 0 Important open; 2 new Minor; commits 503d2e4..d09c7c3)
Ruling K: run round 3 for the two Minors — changePassword token rotation without recorded pair can end a session via revalidate (violates "session ends only on definitive rejection"); discarded-account wipe not independent (retention) — one-line/small fixes — if wrong: one extra CI run.
Task 9: minor (deferred): add() race while queue has no owner; generation test assertion filters dot-files
Owner request 2026-10-06: remove the company caption («АО «Страховая компания «Сентрас Иншуранс»») from login screens — «это чат, понятно». Desktop: separate small dispatch (login + window title; admin/profile company data kept). Android: added to Task 6. iOS: add to Task 10 (LoginView.swift BrandCopy.companyLine / login-company).
Ruling L: interpret as "remove the line, no replacement tagline" on all three clients; keep company as data in profile/admin — if wrong: add a tagline back (one string).
Owner request (desktop): 53f4cef merged (controller-checked 10-line diff, 481 tests, build green)
Task 9: fix round 3 DONE (d09c7c3..d4a1d95; CI 37412906675 green: 456 unit, 15 UI); scoped re-review dispatched
Task 9: fix round 3/5 (2 addressed, 0 open; commits d09c7c3..d4a1d95)
Task 9: minor (deferred): discard-rows retry test has weak teeth (concurrent forget clear); changePassword records pair from keychain token not the request's token (narrow chain break if the POST itself refreshes); settle() fixed waits; revoked-T1 401 before changePassword response clears credentials; deleted account rows after kill removed only on next claim
Task 9: complete (commits 9c14de7..d4a1d95, review clean after 3 fix rounds); merged into integration (5125e3e)
Task 10: implementer dispatched (opus), lane m-ios
SESSION RESTART 2026-10-06 11:42: Task 6 (android fb14f00 pushed, 1 uncommitted file) and Task 10 (ios 37712c1, CI 37419051434 red) resumed via their agents
Task 6: implementer DONE_WITH_CONCERNS (b851c65..499c91b pushed; 698 unit, androidTest 86/86 Pixel_8 + 3x API34; CI 37425247301 red on fb14f00 unreproduced — 499c91b names failing tests; 5c65e3d behaviour fix beyond polish; 3 tests deleted with company code); review dispatched (opus)
Task 6: review — Ready after fixes. 1 Important: ChatSafetyUiTest.kt:152 races TestDelivery Room load (CI red 2 runs: fb14f00, 499c91b run 37430929130). 5c65e3d ruled correct/keep; deleted tests dead-code only (4 not 3). Fix round 1 sent to original implementer (FIX_BASE 499c91b).
Ruling M: rule in for Task 6 round 1 — run-ui-tests-recorded.sh find instead of glob; RealtimeConnectionManager owner required; ChatViewModel typing declared with collaborators — cheap, prevents silent CI/socket regressions — if wrong: slightly larger fix diff.
Task 6: minor (deferred): NotificationPermissionPrompt sheet untested on device; profile-light before/after pair not comparable; tick ✓✓ from stand state; few-px bubble width step (design review); PriorityBadge rename bundled in f34a9df; R8 frame drops NOT closed — re-measure on physical device before release.
Task 6: fix round 1/5 (4 addressed, 0 open; commits 499c91b..7bf6827; CI 37433478839 green incl. emulator)
Task 6: complete (commits b851c65..7bf6827, review clean after 1 fix round); merged into integration (e62cbcf)
Task 10: implementer DONE_WITH_CONCERNS (5125e3e..ce6351d pushed; CI 37440917565 green: 488 unit, 20 UI + 1 skip, motion recordings; hang fix via iOS18 onScrollGeometryChange; concerns: partial before-shots, call screen gallery-only, no swipe Прочитано, iPad/Previews not in CI); review dispatched (opus)
Task 10: review — Ready after fixes. 2 Important: iOS18 at-end check ignores contentInsets (pill over newest, incoming not followed); iPad split detail hides tab bar forever. Fix round 1 sent to original implementer (FIX_BASE ce6351d).
Ruling N: rule in for Task 10 round 1 — follow logic on rows.last not store.messages.last (blocked senders); VoiceOver announcement for offline/back-online banner; drop/label misleading 08-call after-shots — correctness/a11y, cheap — if wrong: slightly larger fix diff.
Task 10: minor (deferred): sticky date pill covers text at AX sizes; motion step continue-on-error is evidence not gate; ProfileView deprecated updatePresence warning (pre-existing).
Task 10: fix round 1/5 (5 addressed; new: 1 Important — long chat does not open at newest message (iPad 51-ipad-split-chat shows 10:38 vs 10:47; proxy.scrollTo estimated heights); 2 new Minor; commits ce6351d..a45208d; CI 37447449242 green)
Ruling O: rule in for Task 10 round 2 — isAtEnd use visibleRect.maxY (unit-tested) instead of max of two estimates; banner no «Снова в сети» announcement when !isRunning (sign-out) — cheap, a11y/correctness — if wrong: one extra CI run.
Task 10: fix round 2 sent to original implementer (FIX_BASE a45208d)
Task 10: fix round 2 (7c47540 RED CI 37453755106 red as expected; bbd7480 CI 37453946352 RED — iPad testIPadSplitViewKeepsTheTabBar: long chat not at newest message on screen)
STOPPED 2026-10-06 17:05 by owner request: Task 10 needs round 3 (iPad split detail open-at-end); Task 11 not started. Handoff docs/HANDOFF-2026-10-06.md
SESSION RESUME 2026-10-07: Task 10 fix round 3 sent to original implementer (FIX_BASE bbd7480, iPad open-at-end)
Task 11: final whole-branch review dispatched in parallel (opus x5: server/CI/security, desktop, android, ios excl. Task 10, contracts/parity) -> final-review-<area>.md; Task 10 delta reviewed on its own before merge
Task 11: desktop — Ready after fixes (I1 report reason codes raw; I2 allow_registration not enforced by email registration -> server reviewer; 7 minor)
Task 11: ios — Ready after fixes (I1 keychain WhenUnlocked + read error = absent signs out on locked device; I2 offline cold launch shows login; I3 PrivacyInfo missing UserDefaults CA92.1; I4 push entitlements/background mode — owner decision; M1 cancel during upload handover still sends; M2 upload retry forever; M4 delete-account keychain fail; M5 release-lock script flags; M3/I2 after Task 10 merge)
Task 11: parity — partial (contracts: DM_NOT_ALLOWED missing in ws-protocol; openapi lacks new endpoints/fixtures; registration.md missing BUSY/503 no code/409/429); parity comparison resent
Task 11: android — Ready after fixes (I1 logout keeps device secret -> auto re-login on admin-paired devices; I2 uploads uncapped, non-0 status = failed, no Retry-After/401 transient; I3 notification-tap intent trusted from any app; I4 HTTP requests not bound to account (parked 1 + line 99); M1 cancel after upload still sends; M3 old account notifications; M4 parked 2; M5 usesCleartextTraffic=false)
Task 11: parity — NOT READY (C1 no push on Android (no FCM/token), iOS no permission ask/background mode/entitlements/tap handling -> owner decision; 17 Important: android uploads cap/order, trim, claimDevice after registration, logout device_id, disk-failure socket loop; ios DM_NOT_ALLOWED composer lock, channel block hiding, block/delete warnings, login lowercased, no background flush; copy tables; call-push doc; desktop away/mark_read/minimized; personal data in fixtures)
Task 11: server — Ready after fixes (I-1 allow_registration not checked by email registration (confirmed); I-2 block not enforced on calls/wake/edits; I-3 6-digit code brute force with @domain allowlist, no global limits; 18 minor incl. deletion broadcast leaks erased PII, dev stand inherits env + port 2004 default, pg timing tests). npm test 792/793, audit 0, pg 784/793 (3 pre-existing)
Owner decisions 2026-10-07: P push code now, keys later (off without keys); Q allow_registration = master switch for email registration (403 REGISTRATION_DISABLED) — owner asked 'isn't it already protected?', explained (code proves email only; anyone can file pending), default applied, owner may override; R global limits on code request/verify.
Task 11 fix wave: brief fixwave-brief.md; lanes S (server+contracts, m-integration fix/server-contracts), D (desktop, m-desktop fix/desktop), A (android, m-android mobile/android) dispatched (opus); lane I (iOS) waits for Task 10 merge; copy table drafted by parity reviewer
Fix wave D: implementer DONE_WITH_CONCERNS (07420d0..45ae934; 509 tests, build green; I2 banner true only with lane S merged — merge together); review dispatched (opus)
Fix wave D: review — Ready to merge (gate: merge only together with lane S server commit). Ruling S: rule in minors 1 (double mark_read) and 2 (start-in-tray away lost) — cheap; minor 3 (copy test reads contract md) after S merge; minor 4 screenshots before release — deferred.
Fix wave D: fix round 1 (621a8d0; 514 tests; controller-checked diff: IPC handler guarded by isFromServerPage, dedupe by last id) — READY, merge together with lane S
Fix wave S: implementer DONE_WITH_CONCERNS (07420d0..9152033; 815 server tests, pg 813/816 (3 pre-existing), audit 0, security-checks green; new http fixtures make iOS ContractFixtureTests + Android contract test red until decoders added in lanes A/I); review dispatched
Fix wave S: review — Ready to merge, 4 minor. Ruling T: rule in minors 1 (global budget counted after taken checks / only mail-sending requests), 2 (dedicated non-evictable global counters), 3 (POST /blocks clears pending offers between the pair) — cheap security; minor 4 fixture gaps accepted (decoders in lanes A/I; mail-stub success fixtures deferred).
Task 10: fix round 3 DONE (bbd7480..0124c01; CI 37567132661 green incl. iPad light/dark; root: test lookup matched sidebar preview too; app re-scroll on container/inset change); scoped re-review dispatched
Task 10: fix rounds 2-3 re-review — Ready to merge. Minor carried to lane I: isAtEnd subtract contentInsets.bottom; EndPinning unpin only on .interacting (unpin when end check false); probe overlay #if DEBUG.
Task 10: complete (commits 5125e3e..0124c01, 3 fix rounds); merged into integration (1b4f38a)
Fix wave I: mobile/ios prepared (ff to 1b4f38a + merge fix/server-contracts = b0bd691); implementer dispatched (opus, fresh)
Fix wave A: implementer DONE (07420d0..ae3c7dd incl. merge of fix/server-contracts 9152033; 773 unit, lint 0, androidTest 86/86 Api34, CI 37572192448 green); review dispatched (package 9152033..ae3c7dd)
Fix wave A: review — Ready to merge. Ruling U: rule in m1 (replaceTokenIfCurrent under session lock), m2 (deleteToken on explicit sign-out / queued logout), m3 (truthful sign-out failure message) — cheap, auth/privacy; accept m4 (re-upload after process death, orphan only) and m5 (downloads unbound, read-only).
Fix wave S: fix round 1 (14cb909; 819 tests; controller-checked) — complete. Fix wave D: complete. Both merged into integration (1f7fa40, 4a6e48c); merged head: desktop 514/514, server 819/819. NOTE: mobile-ios ContractFixtureTests red on integration until lane I merges (new http fixtures).
Fix wave A: fix round 1 (4b78f27; 782 unit; CI 37574080040 green; controller-checked) — complete; merged into integration (fa96263)
Fix wave I: implementer DONE_WITH_CONCERNS (b0bd691..e4e602e; CI 37577123333 pending; bd9c0a7 build error fixed ee93ee8; linux docker evidence); review dispatched
Fix wave I: review — ready to merge once CI green; 7 minor. Ruling V: rule in 1 (cancel during handover online: withdrawn set in engine), 2 (notification route tied to account, cleared at session end), 4 (no token while authenticated -> revalidate), 5 (blank launch: retry/backoff + visible retry), 6 (unregisterForRemoteNotifications on explicit sign-out, parity with Android m2) — ownership/never-sent/stuck states, cheap; accept 3 (background flush after termination — device check) and 7 (login flash before first unlock).
Owner decision 2026-10-07: enable self-registration in production (allow_registration=true). Production DB setting — owner flips it in desktop admin «Настройки» after the release deploy, once SMTP_* on Railway are set; not done by us (no production access/traffic).
Fix wave I: fix round 1 re-review — all 5 fixed, nothing new; CI 37578279816 red only on 3 stale copy unit tests (UI/iPad/release lock passed). Controller fixed tests in 1947ff7; CI 37587863344 running.
Fix wave I: CI 37587863344 (1947ff7): unit green; UI testUserPathEndToEnd failed once at UserPathQATests:140 (profile name not found in 20s) — same test passed on 18e7834 and 1947ff7 changed only unit-test strings → treated as flake; rerun of failed job started. If it repeats: investigate as real (I2 user snapshot / profile).
Fix wave I: CI 37587863344 attempt 2: user path passed, PeopleSearchUITests:117 failed (person-card not shown after tap) — 2 different UI failures in 3 runs on unchanged app code → flakiness; implementer hardening UI tests (no weakening) + checking PersonCardView.
Fix wave I: CI hardening 7b610a6 (tests only, no weakening, controller-checked); CI 37602081015 green — complete; merged into integration (b1ab56b). All Task 11 fix-wave lanes merged.
Task 11: final integrated re-review — Ready after fixes: D1 android .gitignore build/ hides test sources (ManifestHardeningTest, PushBuildConfigurationTest never in CI); D2 PUSH-SETUP §2 placeholder + wrong call-push step + package name; D3 CI path filters miss mobile/contracts/**; D4 parity-matrix stale; D5 legacy /auth/register 403 lacks code. CI on b1ab56b all green; server 819, desktop 514, vectors 89. Final polish lane dispatched (m-integration, fix/final-polish).
Task 11: final polish (b1ab56b..6ce4933; CI 37617219067/111/132 green) merged into integration (4387fed). Task 11 COMPLETE — verdict: Ready for release (pending owner steps). Master NOT merged — needs owner confirmation.
2026-10-08: PR security-checks (gitleaks, PR range) red on iOS test literal Str0ng-Passw0rd (9x generic-api-key; push runs green, scan only new commits). Fixed by exact-value allowlist in .gitleaks.toml (00faba4); verified locally in Docker 9 → 0.
