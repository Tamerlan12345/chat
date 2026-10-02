# Task 21 report: Android «Сотрудники», person card, universal search, buttons

**Status: STOPPED EARLY (session ended by the coordinator).** No implementation was written. Worktree `m-android`, branch `mobile/android`, HEAD `ca49056` is unchanged. The tree under `mobile/android/**` is clean.

**No WIP commit.** `git status --short mobile/android` was empty, so `git add -A mobile/android && git commit` had nothing to commit. I did not create an empty commit. Nothing was pushed.

## State at stop

### Done (reading and analysis only)

**Read:**
- the brief, the binding spec `people-search-spec.md`, the design brief (tokens, UI layer v2 components, polish section) and the global constraints;
- the Task 17 report;
- craft-floor, `android.md`, `animate.md` and the navigation-3 skill index.

**Mapped the existing Android code:**
- Navigation:
  - `NavKey`, `AppNavigationState` (one stack per top-level route; the start tab sits under the selected one) and `AppNavigator`;
  - `CentyNavigation` (`NavigationSuiteScaffold`, the shared-axis / inbox↔chat fade-through spec, the bar hide rule `currentKey is Chat && isCompact`);
  - `ListDetailScene`.
- `SharedElements.kt`: `LocalSharedTransitionScope`, `SharedKeys`, `sharedConversationElement`.
- `ConversationsScreen` and its ViewModel (inline name filter, bordered search field, segments).
- `ApiClient`: no `/users`, `/org/tree` or `/messages/search` methods yet, and no avatar opt-in.
- The `User` DTO, which already has phone, email, extension, last_seen, role_name and permissions.

**Ran the RED baseline of `ContractFixturesTest`.** `everyFixtureInTheManifestDecodes` fails on HEAD with these entries:
- `http/devices.push-token-delete.json`: no DTO mapped for `DELETE /api/devices/push-token`.
- `http/devices.push-token-register.json`: no DTO mapped for `POST /api/devices/push-token`.
- `http/users.avatar-upload.json`: no DTO mapped for `PUT /api/users/avatar`.
- `push/{apns,fcm}.*.json` (6 files): `unknown fixture kind push`.

The other three tests in that class pass. `ws/call_end.no_call.json` and `ws/message_cancelled*` already decode.

**Planned handling for the fixture test (not applied):**
- Map `PUT /api/users/avatar` to `User`. The fixture is a full `User` record.
- Ignore `POST`/`DELETE /api/devices/push-token` explicitly, with the comment "Android push registration — Android push task (Wave 4), contract push.md".
- Accept kind `push` explicitly. Parse each file and assert that `provider` is `fcm` or `apns`, and that the FCM `message.data.type` is `message` or `call`. Add the comment "FCM receiver not implemented on Android yet — Android push task".

**Server facts checked:**
- `/api/users` (non-admin) returns approved users, including inactive ones. It carries `department_name` and `permissions_json`, but no `permissions` object.
- `/api/org/tree` returns `{tree[{id,name,subDepartments,employees,totalStaffCount,onlineStaffCount}], unassigned, totalUsers, onlineUsers}`. It has no `department_name`. Its online count includes `away`.
- `/api/messages/search?q` returns at most 30 messages by `id DESC`. The match is a SQLite `LIKE`, which is case-insensitive for ASCII only, so a Cyrillic search on the server is case-sensitive.
- Avatar opt-in: header `X-Avatar-Format: url` (a router-wide middleware) and `/ws?avatars=url`. Avatar images are served at `/api/users/:id/avatar?size=s|m`.
- The desktop `PersonInfoPanel` shows no call button. The «Позвонить» rule (`can_call`) therefore has to come from the current user's own permissions plus the peer's presence, per the spec.

### Not done (all of Task 21)

- the 4-tab navigation (`NavKey.People`, `NavKey.Person`) and per-tab state;
- the people repository: `/api/users` + `/api/org/tree`, the department join, the `is_active` filter, the disk cache with stale-while-revalidate, and live presence;
- the pure rules, TDD: normalisation and ranking, last-seen formatting, people filtering, department join and the online counter;
- the «Сотрудники» screen («Все» A–Я with sticky letters and the fast-scroll bubble, «Отделы» org tree, the «В сети» filter, the summary line, the states);
- the person card (shared element, action row with the disabled-call reasons, info group with `tel:`/`mailto:`/copy, own card);
- universal search in «Чаты» (recents, people/channels/messages sections, 300 ms debounce, stale-drop, jump to the message with `beforeId`/`afterId` and a highlight pulse);
- the system-wide button styles;
- the avatar opt-in: OkHttp interceptor, the WS URL and Coil `?size=`;
- the fixture-test fix;
- dev-stand test data (10+ people across 3+ departments);
- the Compose UI tests, screenshots, recordings and full verification.

### Red / unverified

- **Red:** `ContractFixturesTest.everyFixtureInTheManifestDecodes` on HEAD `ca49056` (9 entries, listed above). It was red before this task started, because the server Tasks 18–20 were merged without the matching client changes.
- **Not run:** the full unit suite, lint, `assembleRelease` and `connectedDebugAndroidTest`.
- **Emulator and stand:** `emulator-5554` was up at the start. The dev stand was not started, and no stand data was changed.

## Concerns for the next session

1. Server message search is case-sensitive for Cyrillic (`LIKE`). The client cannot fix this. Either document it, or ask Integration for a `lower()`-normalised column or an FTS index.
2. The org tree counts `away` as online, but the spec's «В сети» filter might mean `online` only. This needs one ruling so the counter and the filter agree.
3. `/api/users` has no `permissions` object for colleagues, so the «Звонки недоступны» reason has to come from the caller's own `can_call`. If the owner meant the peer's permission, Integration would need to expose it.
