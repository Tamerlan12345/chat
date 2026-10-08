### Task 8: iOS — avatars, push token, authorized media

Worktree `m-ios`. Depends on Task 7.
`APIClient` gains push-token registration/unregistration per `mobile/contracts/push.md` (called after login and on token change, removed on logout/delete; APNs registration code compiled but inactive without an account — no entitlement change that breaks CI signing) and avatar URL opt-in (`X-Avatar-Format: url` header, `/ws?avatars=url`). Avatars load from `/api/users/{id}/avatar` with the Bearer token through an image loader with memory + disk cache keyed by URL/ETag (no third-party dependency), used by `AvatarView` everywhere; deterministic fallback colour = desktop name hash (ledger ruling 2026-10-02).
Acceptance: XCTests for request building and cache behaviour with a stub URLProtocol; screenshots show photo avatars from the dev stand; green CI.

