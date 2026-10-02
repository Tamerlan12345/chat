# Task 19 report: call-push hardening follow-ups

**Status:** DONE (minor concerns in §7). Worktree `m-integration`, branch `mobile/integration`, base `da0a72c`. Nothing was pushed.

## Commits

| SHA | Message |
|---|---|
| `3b5b523` | fix(server): harden the call-push lifecycle against races and stale outcomes |
| `553c59d` | docs(contracts): document idempotent call_answer and one-shot call tombstones |
| `e87c2fc` | fix(desktop): show server call reason codes as Russian text |

## 1. Items: change and test

All server tests are in `server/test/push-notifications.test.js`, in the section «Задача 19».

| # | Change | Test |
|---|---|---|
| 1 | **Duplicate `call_answer`.** In `ws/server.js`, the `call_answer` handler checks first whether `activeCalls.get(answerer) === target` and the target has no fresh pending offer. If so, the frame is **ignored silently**: it is not relayed and gets no `call_end`. | `Т19-1`: offer, answer, then a second answer. Bob gets no `call_end`, Alice gets exactly one `call_answer`, and the pair stays in `activeCalls`. |
| 2 | **`pushCallUndeliverable` matches `offerAt`.** `PushService.settle` passes `job.call.offerAt` to `presence.callUndeliverable(callerId, calleeId, offerAt)`. `pushCallUndeliverable` returns early when `offer.at !== offerAt`. | `Т19-2`: the first offer's FCM send is held; the caller sends `call_end` and re-offers; the second send succeeds; the held first send is released as `failed`. The caller gets no `call_unavailable`, the new offer still waits, and Bob gets `call_offer` on connect and no `call_end`. |
| 3 | **Retries survive `/auth/refresh`.** `deliver()` resolves `job.sessionJti` through the newly exported `PushTokens.currentJti(userId, jti)`, which follows the `rebindSession` old→new map, then compares that with the row. It also stores the resolved jti on the job, so later retries carry the new one. | `Т19-3`: first attempt `retry`, then `/auth/refresh` of the registering session. There is a second attempt to the same token. Logout with the new token still removes the row. |
| 4 | **`call_offer` await race.** A per-pair in-flight "offer attempt" (`offerAttempts`, key `caller>target`), with these rules:<br>• `call_end` / `call_rejected` from the caller to that target marks the attempt cancelled.<br>• A newer offer for the same pair supersedes the older attempt.<br>• `offerAttemptAbandoned(ws, attempt)` = cancelled, socket revoked, or socket no longer bound.<br>• It is checked after `freshUser()` and after `canRing()`, inside `ringByPush` before the offer is stored and the push enqueued, and again before `call_unavailable`.<br>• On abandon: no pending offer, no push, no reply.<br>• The entry is removed in `finally`, so the map holds only in-flight checks. | `Т19-4`: three cases, each gated with a monkey-patched await.<br>(a) Push path, caller `call_end` during `canRing`.<br>(b) Push path, caller disconnects during `canRing`.<br>(c) Online callee, caller `call_end` during `freshUser`.<br>Each case asserts no FCM call, no pending offer, and no `call_offer` to the callee, either live or on later connect. |
| 5 | **Tombstones consumed once.** In `replayPushedOffers`, an ended-offer entry is sent once, to the first open socket, then marked `delivered: true`. Later connects within the 60 s window skip it. The entry stays until TTL, so a late `call_answer` still gets the specific reason. **Why not delete:** a resent `call_end` with the same `senderId` would reach a *new* call with that peer and end it. Trade-off: a second device woken by the same push gets no `call_end` and falls back to the 10 s rule. This is documented in `push.md` §3 п. 5. | `Т19-5`: cancel, connect (`call_end cancelled`), reconnect (no `call_end`), then late `call_answer` → `call_end cancelled`. |
| 6 | **Queue full at `notifyCall`.** `notifyCall` now creates the delivery `group` on the job. When `enqueue` drops the job (queue full), `settle(job,'lost')` reaches `callUndeliverable` synchronously. The caller then gets `call_unavailable` «Сотрудник сейчас не в сети», the offer is cleared, and the tombstone becomes `unavailable`. | `Т19-6`: `concurrency:1, queueMax:1`, one held delivery plus one queued job. A `call_offer` to Carol, who has an Android token, gives `call_unavailable`, and no pending offer remains. |
| 7 | **`connection_lost` / `timeout` tombstone tests.** Writing the tests surfaced a **real bug**: `replayPushedOffers` called `rememberEndedPushOffer(callerId,'timeout')` after the callee's socket was registered. The "callee online" guard then skipped it, so an expired offer produced no `call_end` at all. Fix: `rememberEndedPushOffer(..., { calleeConnecting: true })` from the replay path. | `Т19-7а`: caller disconnects before the callee connects, giving `call_end connection_lost` with `senderId`/`senderName` and no `call_offer`. This passed before the change; it pins the behaviour. `Т19-7б`: the offer is aged by 3 minutes, so connect gives `call_end timeout`, the offer is cleared, and a late answer gets `call_end timeout`. |
| 8 | **Desktop reason text.** New `callReasonText(reason, fallback)` in `desktop/src/renderer/src/lib/call-signal.mjs`. It maps `no_call`, `unavailable`, `cancelled`, `timeout` and `connection_lost` to Russian copy:<br>• «Звонок уже завершён»<br>• «Не удалось дозвониться: сотрудник недоступен»<br>• «Вызов отменён»<br>• «Время вызова истекло»<br>• «Связь с собеседником прервалась»<br>A peer-written reason (already Russian, e.g. the mic failure) is shown as is. An unknown snake_case code falls back to the generic text instead of being shown. It is used for `call_end`, `call_rejected`, `call_unavailable` and `call_denied`. `VoiceCallPanel.jsx` needed no change, because it shows `callSignalAction(...).error`. | `desktop/test/call-lifecycle.test.mjs`: «коды причин сервера показываются по-русски, а не как есть». It checks every code across the `active`/`connecting`/`calling` phases and `call_rejected`/`call_unavailable`, that each text is distinct, that peer text passes through, that an unknown code is not leaked, and that a no-reason end still closes. |

**Test infrastructure:** `beforeEach` in `push-notifications.test.js` now resets the per-user `push-token:<id>` rate limit (30/min). Without this, the new tests got 429s from registrations made by earlier tests in the same minute and silently had no token.

## 2. Contract updates

- **`mobile/contracts/push.md` §3:**
  - п. 1: a caller hangup or disconnect during the server checks means no offer and no push.
  - п. 3: a full queue counts as "not woken"; only the current offer's deliveries count, so a stale failure of a previous offer does not cancel a re-offer.
  - п. 5: `call_end` on connect is delivered **once**, with the rationale and the second-device 10 s fallback.
  - п. 6: a late answer gets the reason for 60 s even after the replay.
  - New п. 7: a duplicate `call_answer` in an established pair is idempotent (ignored, no relay, no `call_end`).
- **`mobile/contracts/push.md` §6:** a retry continues across `/api/auth/refresh`.
- **`mobile/contracts/ws-protocol.md`:**
  - `call_offer`: abort on a caller hangup or disconnect during checks; the `call_end` replay is one-shot.
  - `call_answer`: the duplicate-answer rule.
  - `call_unavailable` paragraph: fixed the stale «call_answer … молча игнорирует», which Task 18 had made untrue, and added the push-delivery-failure and queue-full cases.
- No fixture shapes changed. `capture-fixtures --check` reports «fixtures match the server».

## 3. RED/GREEN evidence

- **Server RED.** The tests were written first and run against the unchanged `da0a72c` sources with `node --test --test-name-pattern="Т19" test/push-notifications.test.js`: **8 tests, 1 pass, 7 fail.**

  | Test | Failure |
  |---|---|
  | Т19-1 | «отвечающему не пришёл call_end» (the `call_end` was received) |
  | Т19-2 | «вызывающему не сказали «не в сети» из-за старого вызова» (the stale failure cancelled the new offer) |
  | Т19-3 | `1 !== 2` (the retry was dropped after refresh) |
  | Т19-4 | `1 !== 0` (the push was sent for an offer the caller had already cancelled) |
  | Т19-5 | «повторный вход call_end не повторяет» (it was repeated) |
  | Т19-6 | «событие не пришло» (no `call_unavailable` when the queue was full) |
  | Т19-7б | «событие не пришло» (no `timeout` `call_end`: the bug described in item 7) |
  | Т19-7а | passed (existing behaviour, now pinned) |

- **Server GREEN.** `push-notifications.test.js`: **36/36.**
- **Desktop RED.** `node --test test/call-lifecycle.test.mjs`: **13 tests, 12 pass, 1 fail**, «no_call: русский текст, а не undefined».
- **Desktop GREEN.** 13/13.

## 4. Test summaries

- **`cd server && npm test`:** **673 tests, 672 pass, 0 fail, 1 skipped.** The baseline was 665 / 664 / 1 skipped; 8 tests were added.
- **`node mobile/dev/capture-fixtures.mjs --check`:** «fixtures match the server». `mobile-contract-fixtures.test.js` passes 6/6.
- **`cd desktop && npm test`:** **456 tests, 456 pass, 0 fail.** `npm install` was run first because `node_modules` was missing; no tracked files changed.

## 5. Files changed

- `server/src/ws/server.js`:
  - `offerAttempts` and its helpers (`beginOfferAttempt`, `cancelOfferAttempt`, `endOfferAttempt`, `offerAttemptAbandoned`);
  - `call_offer` re-checks;
  - the duplicate-answer guard;
  - the `ringByPush` abandon check;
  - the `offerAt` match in `pushCallUndeliverable`;
  - `rememberEndedPushOffer` `calleeConnecting`;
  - the one-shot replay.
- `server/src/push/push.service.js`: the `group` in `notifyCall`, `offerAt` in `callUndeliverable`, and the `currentJti` resolution in `deliver`.
- `server/src/push/token-store.js`: exports `currentJti`.
- `server/test/push-notifications.test.js`: 8 new tests and the rate-limit reset in `beforeEach`.
- `mobile/contracts/push.md`, `mobile/contracts/ws-protocol.md`.
- `desktop/src/renderer/src/lib/call-signal.mjs`, `desktop/test/call-lifecycle.test.mjs`. `VoiceCallPanel.jsx` was not touched.

## 6. Notes for the platform clients

- They may send `call_answer` more than once (CallKit and in-app UI). The server ignores repeats inside an established pair.
- A `call_end` with `reason` ∈ {`cancelled`, `connection_lost`, `timeout`, `unavailable`} on connect arrives only on the first socket after the call ended. Keep the 10 s "no `call_offer` → missed call" rule as the fallback.
- Map the reason codes to Russian copy, as desktop now does.

## 7. Concerns

1. **Second-device trade-off (item 5).** With two call-capable devices for one user (two phones, or phone and tablet), only the first to connect gets the ended-call `call_end`. The other ends its ringing UI after the 10 s fallback. I chose this over repeating the tombstone, because repeating could end a newer call with the same peer. It is documented in `push.md`.
2. **Rebind memory bound (item 3).** The old→new jti map lives in memory for 10 min. Retry delays are capped at 5 min, so a refresh is always resolved on the next attempt, and the job then carries the new jti. After a **server restart**, rebind memory and the push queue are both lost, so there is nothing to resolve.
3. **Duplicate-answer guard scope (item 1).** The answer is ignored only when the pair is already established with *that* peer and the peer has no fresh pending offer to the answerer. If the peer somehow re-offers while the call is active (not a desktop flow), the normal answer path applies.
4. **Item 4 uses re-checks, not serialisation.** Call frames still bypass the per-socket queue, so ICE latency is unchanged. The abandon check also covers a caller who hangs up from another socket of the same user, because the key is the user pair.
5. **The test-only rate-limit reset in `beforeEach`** (`limiter.resetLimit`) changes shared test setup. The existing 429 test still passes, because it counts within one test.
