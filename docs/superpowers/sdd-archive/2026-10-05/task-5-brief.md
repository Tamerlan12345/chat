### Task 5: Android — messaging core: contract reducer and durable outbox (rest of plan Task 15)

Worktree `m-android`. Depends on Task 4.
Implement `mobile/contracts/delivery-state.md` on Android: a Kotlin reducer passing **every** vector in `mobile/contracts/fixtures/reducers/` (JUnit reading the JSON in place, like the existing `ContractFixturesTest`); a Room-backed outbox and conversation cache so queued/failed messages survive process death; an effects executor (WS send, HTTP flush, timers, persist barrier, `/api/sync` chain, 410 resync) with WorkManager for background flush; composer cleared only after durable enqueue; showsMeta for out-of-order QUEUED/SENDING bubbles that are not group-last plus a FIFO queue test (ledger ruling from 2026-10-02). Replace the in-memory queue added by the QA fixes (`4d08e46`, `6ce510f`, `d69a809`) with this core without regressing their tests; history paging `beforeId`; reply/edit/delete confirmation.
Acceptance: unit tests green including all reducer vectors; emulator evidence: airplane-mode send → force-stop → relaunch → reconnect → exactly one delivery seen from bob's session on the dev stand.

