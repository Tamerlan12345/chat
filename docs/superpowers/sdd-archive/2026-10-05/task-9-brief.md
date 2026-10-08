### Task 9: iOS — messaging core: contract reducer and durable outbox (plan Task 14)

Worktree `m-ios`. Depends on Task 8. Same scope as Task 5 on iOS: Swift reducer passing every vector in `mobile/contracts/fixtures/reducers/` (table-driven XCTest reading the JSON), SwiftData outbox + conversation cache, effects executor, reconnect, composer cleared after durable enqueue, visible delivery states with retry/cancel, `beforeId` paging, reply/edit/delete confirmation, attachment open/download/send parity with Task 4.
Acceptance: all vectors green in CI; UI test offline send → reconnect against the dev stand with screenshots; green CI.

