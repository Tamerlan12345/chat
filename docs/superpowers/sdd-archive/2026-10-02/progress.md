# SDD ledger — plan: docs/superpowers/plans/2026-10-02-mobile-completion.md

Spec: docs/superpowers/specs/2026-09-30-mobile-release-parity-design.md (+ plan section 0/2 as amended spec). BASE d031d6a.

## Pre-flight scan
| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 ↔ T6/T7 (iOS) | T1 green build + ScreenshotTourTests → T6/T7 extend | sequential in m-ios; ok |
| T2 ↔ T8/T9 (Android) | T2 green baseline → T8 toolchain upgrade | sequential in m-android; ok |
| T3 ↔ T9, T10 | dev CA path + https://10.0.2.2:8443 → Android debug trust, QA live run | T9 owns Android trust config; ok |
| T4 ↔ T6, T8 | fixtures → platform decode tests | T6/T8 must merge mobile/integration first; ok |
| T5 ↔ wave 2 | client_msg_id/sync → outbox | consumers are wave 2; ok |
| T7 ↔ T9 | shared design brief → both platforms | brief written by controller before T7/T9 |
| T1 self | adds manifest XCTest instead of editing QA ps1 | consistent with ownership |
| T6 self | "Depends on Tasks 1 and 4" | ok |
| T10 self | needs all merged | gate |

## Rulings
- Ruling: Run implementers in parallel across roles (iOS / Android / Integration / QA) in disjoint worktrees, sequential within a role — user explicitly requested parallel platform development; file ownership is disjoint so no conflicts — if wrong: merge conflicts in shared files (plan doc only), cheap.
- Ruling: iOS agent may push branch `mobile/ios` to origin to trigger macOS CI — user approved pushing to run macOS CI; it is the only way to compile iOS — if wrong: an extra remote branch to delete.
- Ruling: Dev HTTPS via local TLS proxy + dev CA trusted only in debug builds — user did not name a test server; avoids weakening release transport policy — if wrong: swap base URL to a hosted stand later.
- Ruling: Push notifications deferred to wave 4; iOS tested via `xcrun simctl push` without Apple account, Android FCM needs a free Firebase project from the user — per user answer.
- Ruling: Discarded uncommitted broken `ServerEndpointPolicyTest` edit (`?????` text) in integration worktree; recreated by Task 2 — content captured in plan.
Task 2: complete (commits d031d6a..a56d221, review clean; screenshots verified by controller)
Task 2: minor (deferred): build-dir redirect only in app module and keyed only by project name (shared across worktrees); overridePathCheck uncommented; only 1 of 5 localized messages asserted; ReleaseConfigurationTest.kt:37 type-mismatch warning
Task 3: review — Needs fixes (Important: committed TEST-ONLY private key trips gitleaks history scan)
Task 3: minor (deferred): README warning about LAN exposure of dev stand; stand should refuse non-dev data dir (marker file); freePort race in test; passwords printed to stdout
Ruling: Rewrite unpushed mobile/integration commit so the key never enters history — local unpushed branch, not shared — if wrong: none (branch never left the machine)
Plan amended (owner request): Tasks 11 (iOS) and 12 (Android) — fixed production server https://centychat-production.up.railway.app, no server-setup screen, branded login, security review. Lane order iOS 1→6→11→7, Android 2→8→12→9.
Ruling: No certificate pinning now — prod uses Railway wildcard *.up.railway.app from Let's Encrypt (YE2 → Root YE → ISRG X2/X1) whose roots are rotating; a pin could brick all installs with no remote fix — if wrong: a MITM with a mis-issued publicly trusted cert is not blocked; revisit with a company domain.
Ruling: Debug builds keep a build-config-only server override (no runtime UI) for the dev stand — needed for emulator/CI testing without production credentials — if wrong: debug artefact could point elsewhere; release unaffected.
Ruling: Dev-CA trust moved from Task 9 to Task 12 (login task owns connectivity).
Task 3: fix round 1/5 (1 addressed, 0 open; commit amended c122f9c→d28b0b6)
Task 3: complete (commits d031d6a..d28b0b6, review clean after 1 fix round)
Task 1: complete (commits d031d6a..2e426ec, review clean; CI run 36959971688 green, 49 unit + 3 UI)
Task 1: minor (deferred): prod wiring of nonisolated audio factories not guarded by test/comment; 3499750 doesn't build alone (bisect); pre-existing unused-let warnings in AppState.handleWebSocketEvent; ScreenshotTour relies on refused 127.0.0.1:9; BundleMetadataTests fails under swift test (Bundle.module); QA regex should also match mach_absolute_time
Task 1: ⚠️ screenshot content unverified — this network blocks *.blob.core.windows.net (GitHub artifact storage).
Ruling: iOS CI additionally exports xcresult screenshots as PNG and commits them to orphan branch `ci/ios-screenshots` (job-scoped contents: write), readable via api.github.com — only way for controller to see iOS UI from this network — if wrong: an extra remote branch with images; remove later.
Ruling: Start Task 6 before Task 4 lands; fixture-decode tests added when Task 4 merges (controller will notify implementer) — keeps iOS lane busy per owner's "ускоряй" — if wrong: small follow-up commit.
Task 4: complete (commits 59c7bd7..f818a80, review clean)
Task 4: minor (deferred → carried into Task 5): capture-fixtures.mjs:86 regex `/.d+/` should be `/\.\d+/`; ws-protocol must state message_deleted.targetId is stored target_id (match by messageId); README capture time; user object warts (permissions_json, token_version, bound_ip, last_login_ip) — Task 5 must re-run --write when shapes change
Task 5: review — Needs fixes (Important: change_seq = MAX(live rows)+1 regresses after hard delete → /sync silently skips changes). Fix round 1 dispatched (monotonic sync_state counter + epoch in cursor + regression tests).
Task 5: minor (deferred): wrap markPendingDelivered/markAsRead batches in a transaction; since=0 full scan at 60/min; document that duplicate client_msg_id body is ignored; "deleted is skipped" test never exercises is_deleted; no concurrent-duplicate test; channel-duplicate test doesn't assert no 2nd frame to other member
Task 5: fix round 1/5 (2 addressed, 0 open; commits 247a238..37ee893)
Task 5: complete (commits d90418b..37ee893, review clean after 1 fix round)
Task 5: minor (deferred): raw-file restore keeps epoch (runbook note); double restore of same backup reuses epoch; withChangeSeq rollback after failed RELEASE theoretical
Task 6: review — Needs fixes (Important: open chat increments unread + no mark_read for new msgs; backoff reset on any first frame incl. auth_error → endless reconnect/alert loop). Fix round 1 dispatched (+ cheap minors: jitter cap, English leftovers, screenshot publish hardening).
Task 6: minor (deferred): revalidation reconnect skips sessionDidResume reload; offline launch with stored token drops to login; optimistic message shows "sent" when socket down (→ Wave 2 outbox); re-login test doesn't assert single pump; burst from new dialog → repeated reloads; unneeded @unchecked in test harness; claimDevice before mandatory password change — verify server accepts claim with must_change_password token
Ruling: Fixture-decode test for iOS moves from Task 6 to Task 11 — subagent's `git merge` of the integration branch was blocked by the permission classifier; controller will not run that blocked merge on its behalf; after Task 6 merges into the integration branch, m-ios fast-forwards and gets fixtures through the normal lane sync — if wrong: one task later for fixture parity on iOS.
Plan amended: Task 13 (Integration — delivery-state contract + shared reducer vectors) for Wave 2, started early since Integration lane is free.
Task 8: implementer DONE_WITH_CONCERNS (e8f3dba..b3f7540; 102 unit, 6 androidTest green). Review dispatched.
Ruling: Keep compileSdk 36 (no 37) — brief/Play requirement is targetSdk 36; newest libs needing compileSdk 37 are not required for any feature — if wrong: a later bump, cheap.
Note for user: Task 8 runs made 3 failed `admin` + 1 failed `alice` logins against the user's local dev server on :2004 (chat/server/data) — possible temporary lockout; production untouched.
Task 8: review — Needs fixes (Important: onOpen resets backoff → transient auth_error loop ~1Hz; spec ❌ list-detail from medium instead of expanded). Fix round 1 dispatched (+ minors: CallAudio onCleared guard, drop restored Call keys, no-op suppress).
Ruling: list-detail two-pane only at expanded (≥840dp) per brief; medium = rail + single pane — if wrong: easy threshold change.
Task 8: minor (deferred): ended calls block incoming for 1.5s; refused token with unchanged verify stays Unauthorized; InMemorySharedPreferences x3; no own-direct-unread test; no NavKey serialization round-trip test; lint warning count before/after
Task 6: fix round 1/5 (2 addressed + minors, 1 new Important open — false mark_read while app backgrounded; commits 4ac747a..c65d4d0). Fix round 2 dispatched.
Task 8: fix round 1/5 (3 addressed, 0 open; commits b3f7540..9974a0e)
Task 8: complete (commits e8f3dba..9974a0e, review clean after 1 fix round)
Task 8: minor (deferred): network drop mid auth_error streak can emit a 2nd AuthError; stale CallEnd from previous call can reach new VM (no callId in protocol)
Task 6: fix round 2/5 (1 addressed + minor check, 0 open; commits c65d4d0..9434f51)
Task 6: complete (commits 3f7dabe..9434f51, review clean after 2 fix rounds)
Task 6: minor (deferred): unstructured Task ordering on rapid scenePhase changes; .task markAsRead after load ignores scene activity
Task 13: review — Needs fixes (Important: edit/delete ops unthrottled + fire-once → silent loss of user delete; cancelled possibly-stored message still delivered after sync). Fix round 1 dispatched (+ M1 attempt budget, M2 persist failure, M3 G3 note, M4 sync chain id, M5 projection/trim).
Ruling: A message the user cancelled is never sent later; after a completed sync without its client_msg_id it is dropped locally, with it → delete_message — privacy: cancelled text must not reach the recipient — if wrong: a rare race (frame stored after sync read) shows the message as a normal own message the user can delete.
Task 13: minor (deferred): coverage is self-declared via `covers`; cancelled entries left hidden in outbox after max_attempts (should be resolved by the cancel ruling)
Task 12: implementer DONE_WITH_CONCERNS (8ea22d7..51c101b; 148 unit, 14 androidTest; real alice sign-in on emulator via dev stand verified by controller screenshots). Review dispatched.
Task 12: carry-forward: Android passwordless knock sends null device secret (never worked) → fix in a later task; dark login button uses old #A9A2FF → Task 9; company name quotes "…" → «…» in Task 9
Task 12: complete (commits 8ea22d7..51c101b, review clean)
Task 12: minor (carried into Task 9): knock without secret has server side effects (skip until passwordless designed / platform=android); password local state not cleared after MUST_CHANGE_PASSWORD; whitespace-only password predicate mismatch; company name maxLines w/o ellipsis; last_username in backup (decide); reducers/ skip implicit in ContractFixturesTest; prod URL defined twice
Task 13: fix round 1/5 (2 Important + 5 minors addressed, 0 open; commits f504886..e79401a)
Task 13: complete (commits e3907ad..e79401a, review clean after 1 fix round)
Task 13: minor (deferred → Task 16): after 410 bootstrap, cancelled entry dropped on a chain that cannot see it (persisted cancelled-keys set closes it); cancelled message found on server shows as normal until tombstone (hide messages with pending delete op); edits under fixed-vs-sliding window jitter can still be lost
Plan amended: Task 16 (Integration server gaps G1–G4,G7–G9), Tasks 14/15 (Wave 2 messaging core iOS/Android).
Task 11: implementer DONE_WITH_CONCERNS (e52d829..b659f4c; 133 unit + 5 UI green in run 36970343746). Review dispatched.
BLOCKER (needs owner): GitHub Actions billing — "payments failed / spending limit" stopped publish job; private repo macOS minutes (10x multiplier) likely exhausted → further iOS CI runs may not start. Stop condition (paid external resource) → asked owner.
Task 11: carry-forward: company name quotes "…"→«…» on iOS (Task 7); fc452ee doesn't build alone
Task 11: complete (commits e52d829..b659f4c, review clean)
Task 11: minor (carried into Task 7): eye icon overflows at AX sizes; Retry-After: 0 shows nothing; double tap → spurious error haptic; dev stand log echoes seed passwords; Release plist ships CentyChatServerURL key; copy still mentions server address + unused ServerConnect keys; after Task 16 merge, iOS fixture test must map http/messages.send-cancelled and ws/message_cancelled
Owner decision: push payload = ids only (no message text through Google/Apple). Owner: continue Android; iOS lane paused until CI billing resolved (owner asked about making repo public — advised against, see reply).
Task 16: implementer DONE (6ecc97f..c02a73a; 607/608 server tests; 67 vectors). Review dispatched.
Plan amended (owner request): design brief «UI layer v2» (motion thesis 'message lands', IME glue, 4-plane depth, 15 visual components, delight). Task 17 (Android) after Task 9; Task 7 (iOS) extended. Ruling: v2 as a separate Android task rather than injecting into in-flight Task 9 — avoids overloading a mid-task agent — if wrong: some screens touched twice.
Task 16: complete (commits 6ecc97f..c02a73a, review clean)
Ruling: Accept the breaking contract change from Task 16 (new `cancelled` state key, `cancel` op kind, op client_msg_id, DELETE_REJECTED/EDIT_REJECTED, hide messages with pending delete) — forced by the owner's cancel ruling; Wave 2 Tasks 14/15 have not started, so they implement the new contract directly — if wrong: none, no client shipped it.
Task 16: minor (→ Task 18): stale edit re-queue can revert newer edit; clamp retry_after_ms ≤30000; snapshotTotals over-counts tombstones; frame timeout on non-queued frames (rd/ICE); history row uses pre-await text in delete/edit; doc wording (never a *permanent* refusal; mark_read overflow silent); 3 untested branches; cancelled-key cap boundary untested
Task 16 note for platform reviews: §3.4 hide-pending-delete rule is a UI projection not covered by vectors — check in Tasks 14/15 reviews.
Plan amended: Task 18 (Integration push server, ids-only per owner + Task 16 follow-ups).
Task 9: implementer DONE_WITH_CONCERNS (b432420..64a724c; 171 unit + 29 androidTest). Controller design notes → Task 17: bubbles not grouped (each boxed, big gaps), no date separators. Avatar hue from name (matches desktop) — Ruling: keep name-based hash identical to desktop; iOS must use the same algorithm — consistency with desktop beats brief's 'user id' wording — if wrong: colours change when a user is renamed.
Task 9: review — Needs fixes (Important: dark primary #6457ee used for text/outlines 2.58–3.45:1; own-bubble footer 4.17:1). Fix round 1 dispatched (+ draft wipe bug, double haptic, light nav indicator 1.00:1, font2 clipping, reduce-motion gaps, snackbar offset, strings, call a11y, channel avatar dark).
Ruling: Features omitted in Task 9 are deferred, not added — reply/attach/failed retry → Task 15 (Wave 2); new-chat FAB, Profile «Сменить пароль», call level meter → later feature task (Wave 3) — Task 9 is a design pass, features need contract work — if wrong: users wait one wave longer for these.
Task 9: minor (deferred): ChatScreen.kt 892 lines (split in Task 17); search field 44dp; dialog buttons pill vs 8dp radius; report token table inaccuracy; ProfileViewModelEventsTest not TDD
Task 9: fix round 1/5 (2 Important + 10 minors addressed, 0 open; commits 64a724c..b0a4dc0)
Task 9: complete (commits b432420..b0a4dc0, review clean after 1 fix round)
Task 9: minor (deferred): password error uses "" sentinel
Task 18: implementer DONE_WITH_CONCERNS (2a83182..2edcf0f; 652/653; 70 vectors). Review dispatched. Note: after merge, Android/iOS fixture tests must accept manifest kind 'push' and push-token routes; reducers need T54 (sent edit kept as sending) — handle in Tasks 15/14.
Task 18: review — Needs fixes (Important: queued/retried push jobs not re-checked for ownership/session at send time; call-push lifecycle rings for dead calls / caller rings into the void). Fix round 1 dispatched (+ prune scope, APNs JWT refresh race, FCM call body test, logout leftovers, push.md note, gitleaks allowlist for RFC vectors).
Ruling: Accept the cancelled-key cap escape (Task 16) as documented residual risk — client never re-sends cancelled entries and a late in-flight frame would need to survive >1000 later cancels behind the per-socket G1 queue — if wrong: one cancelled message delivered in an extreme abuse scenario.
Task 18: fix round 1/5 (2 Important + minors addressed, 0 open; commits 2edcf0f..8c7eaee)
Task 18: complete (commits 2a83182..8c7eaee, review clean after 1 fix round)
Task 18: minor (→ Task 19): duplicate call_answer during live call gets call_end (tears down mobile call view); desktop shows raw "no_call"; pushCallUndeliverable doesn't match offerAt; session_jti check drops retries after legit refresh; canRing await widens call_end race; tombstones not consumed; queue-full call never tells caller; no tests for connection_lost/timeout tombstone reasons
Plan amended: Task 19 (call-push hardening). Ruling: Integration may edit desktop call-signal.mjs / VoiceCallPanel.jsx for reason→Russian text mapping — the raw code is a server-contract consequence; tiny scoped desktop change — if wrong: revert two files.
Task 19: complete (commits da0a72c..e87c2fc, review clean)
Task 19: minor (→ Task 20): two devices of same user can both answer → both stream mic (narrow idempotency to answering socket); offer.at ms timestamp → monotonic offerSeq; redundant abandoned() check; App.jsx:1304 raw reason (prose today)
Plan amended: Task 20 (media Range/thumbs/avatar URLs + socket-scoped call answer).
Ruling: Task 20 thumbnails use sharp (pinned, audited, Docker-verified), pure-JS fallback if Docker incompatible — mature lib with decompression-bomb limits and EXIF stripping; avoids hand-rolled decoders — if wrong: native dep adds supply-chain/maintenance surface.
Task 17: implementer DONE_WITH_CONCERNS (5ef7972..28f6406; 206 unit, 43 androidTest). Note: one dev-stand credential login hit production (refused) during benchmarking. Review dispatched (code + design).
Task 17: code review — Needs fixes (Important: follow/unseen snapshot keyed on list head → stale while typing row shown). Design finish-review — verdict FIX (sticky date over text; double date pills; grouping unreadable → joined 2dp; text lift disconnected; lifted bubble not lifted in light; bottom bar jumps; skeleton flash on cached chat; old bubble reflow; composer growth clip; jump pill placement; remove-animations crossfade). Fix round 1 dispatched with code minors.
Task 17: iOS parity notes recorded in design review (sticky date rule, joined 2pt, stable time rule, skeleton only w/o cache, opaque lifted fill, matchedGeometry text lift, system tab bar hide, Reduce Motion 150ms crossfade).
Task 20: implementer DONE (8f0762f..a1263a9; server 706, desktop 460, audit 0). Review dispatched.
Task 20: review — Needs fixes (Important: UA-sniffed avatar format with URL default breaks desktop browser mode; WS doesn't null legacy non-data avatars → potential token off-host). Fix round 1 dispatched (+ thumbnail DoS negative cache/inspect in slot/per-user cap, avatar retention, thumb URL versioning, legacy avatar normalization, If-Range order, fixture artifact).
Ruling: Ratify Task 20's root Dockerfile `--ignore-scripts` change (outside Integration's owned paths) — needed for sharp install policy in the deps stage — if wrong: revert one line.
Ruling: Keep sharp 0.35.5 (exact pin, integrity, no install scripts, bounds-check fixes in the untrusted-input surface) — reviewer recommendation; no release-age rule in repo — if wrong: a regression in a 5-day-old release; re-run audit signatures before release.
Task 20: minor (deferred): directory-filter gap on avatar/user endpoints (consistent with existing); call grace window to rebind reconnecting socket; repeated avatar hash per request (memoize)
Task 20: fix round 1/5 (2 Important + 6 minors addressed, 0 open; commits a1263a9..89956f6)
Task 20: complete (commits 8f0762f..89956f6, review clean after 1 fix round)
Task 20: minor (deferred): purgeAvatarCache race with concurrent render (transient 404); abandoned libvips metadata() keeps CPU after 5s timeout. Mobile clients must send X-Avatar-Format: url and connect /ws?avatars=url (Tasks 14/15 + Wave 3).
Plan amended (owner request + impeccable shape): design brief «People surface + universal search» (owner chose tab + universal search; card shows phone, email, status/last seen) and «Anti-AI polish pass». Tasks 21 (Android people/search/buttons) and 23 (Android polish) after 17; iOS Task 7 extended. PRODUCT.md updated (fixed server, push ids-only, people search).
Ruling: Android lane order 17 → 21 → 23 → 15 — owner's current priority is visuals + contacts; outbox (15) follows — if wrong: offline-send reliability on Android lands later.
Ruling: «Написать» from the person card pushes the chat onto the current tab's stack (no forced tab switch unlike desktop) — preserves back chain on mobile — if wrong: easy to switch to tab jump.
Task 17: fix round 1 implementer DONE_WITH_CONCERNS (28f6406..2898ac9; 208 unit, 47 androidTest). 3 more dev-stand logins reached production via connectedDebugAndroidTest rebuilding debug APK with default prod URL.
Ruling: Debug builds default to the dev stand (https://10.0.2.2:8443), never production; production URL only in release (and an explicit opt-in Gradle property for a debug-against-prod build) — prevents test traffic/credential attempts against production; owner's "preset working server" applies to release builds — if wrong: a developer must pass -Pcentychat.serverUrl=prod to test debug against prod. Carry into Task 21 (Android) and iOS lane.
Task 17: fix round 1/5 (code Important + 10/11 design addressed; 1 open — design 6 composer inset jump on inbox↔chat; commits 28f6406..2898ac9). Fix round 2 dispatched (+ reduce-motion blank frame, landing re-wrap, double send, history cache clear on logout + refresh error, cold-start bar state, KDoc, debug default = dev stand).
Ruling: Concern 3 (queued/sending glyph hidden on non-last group bubbles) accepted for Task 17; Task 15 must add showsMeta for out-of-order QUEUED/SENDING (rank < group-last) + FIFO queue test — principle #1 — if wrong: a stalled earlier message hidden until Task 15.
Task 17: fix round 2/5 (design 6 + 8 minors addressed, 0 open; commits 2898ac9..fbf562e); design verdict SHIP
Task 17: complete (commits 5ef7972..fbf562e, review clean after 2 fix rounds)
Task 17: minor (→ Task 23): bar returns ~250–290ms late on chat→inbox back; bar slide drops frames on R8; own-bubble no-flight entrance changed to fade (motion table stale); ChatBubble blank-line leftovers; barVisiblePx written in layout
SESSION END 2026-10-02 16:5x: Task 21 not started (no code; ContractFixturesTest RED on ca49056 — 9 fixtures from T18–T20). Handoff: docs/superpowers/2026-10-02-HANDOFF-mobile.md; ledger archived to docs/superpowers/sdd-archive/2026-10-02/.
