# Task 7 report: iOS «Сотрудники» tab, person card, universal search

Branch `mobile/ios` (worktree `m-ios`), pushed to origin. Final CI run **37265738969: green** (head `2ab0cd7`): build, 271 unit tests with 0 failures, 14 UI tests with 0 failures (including both new people tests), Release server lock check, screenshots published.

## What was implemented

**Navigation (App/)**
- `MainTabView` has 4 tabs: Чаты (`bubble.left.and.bubble.right`), Сотрудники (`person.2`), Объявления, Профиль. Each tab keeps its own stack and `@State`.
- `AppNavigation.swift` holds:
  - `AppNavigation`: tab selection.
  - `NavigationRouter`: one per tab, a typed `[AppRoute]` path.
  - `ChatRoute`, `PersonRoute` and `AppRoute`.
- `AppRoutes.swift` holds:
  - `.appRoutes(zoom:)`: the shared `navigationDestination` for a chat or a person card.
  - The `.navigationTransition(.zoom)` from the row avatar. It is used only on iOS 18+ and falls back to a plain push with Reduce Motion.
- A `PeopleRequests` serial change switches to «Сотрудники». It is sent by «Все сотрудники (N)» and by the card's «Отдел» row.
- `AppContainer`:
  - Owns `PeopleStore` (`APIPeopleSource` + `PeopleDiskCache`) and `SearchRecentsStore` (UserDefaults).
  - Registers the directory for `user_status_changed`.
  - Wipes both on sign-out.

**«Сотрудники»** (`Features/People/PeopleView.swift`, `PersonRowView.swift`, `DepartmentOutline.swift`, `UI/DesignSystem/Components/SectionIndexBar.swift`)
- Large title, and `.searchable(.navigationBarDrawer(.always))` with the placeholder «Имя, должность, отдел, вн. номер».
- Summary line «N сотрудников · M в сети» with tabular digits.
- Segmented «Все | Отделы» and a «В сети» toolbar chip.
- The header collapses while search is focused.
- «Все»: sticky A–Я sections with a trailing fast-scroll index. VoiceOver gets one adjustable element. At accessibility sizes the index is hidden and rows stack.
- Search results show the matched text highlighted (accent colour, bold).
- «Отделы»:
  - Flattened outline.
  - Chevron rotates 90° (180 ms).
  - «3/9 в сети» shows as a green pill when anyone is online.
  - People are indented 16 pt.
  - Search and «В сети» expand all matching branches.
  - «Без подразделения» comes last.
- States:
  - Skeleton rows on first load only.
  - A «Не удалось обновить список · Повторить» banner over the cached list.
  - A first-load failure state with «Повторить».
  - `ContentUnavailableView` for: nothing found (with «Очистить поиск»), nobody online («Показать всех»), and an empty directory.
- Pull-to-refresh waits for the server (`refreshAndWait`).
- Filters persist through `@SceneStorage`.

**Person card** (`PersonCardView.swift`)
- Header:
  - Avatar 96.
  - Name in title2, weight 600, never red.
  - Presence dot + `PresenceLine`, which gives «Был(а) в сети сегодня в …».
  - The custom status in «».
  - «Сотрудник больше не работает» for a former employee.
- Action tiles, 72 pt with the icon above the label:
  - **Написать** (primary) pushes the direct chat onto the current tab's router. There is no tab switch.
  - **Позвонить** (tonal) is disabled when the role lacks `can_call`, the peer is in DND, or the peer is offline. The reason is the accessibility hint and also a caption under the row. The own card has no call button: it shows «Редактировать профиль» instead, which switches to Profile.
  - **Побудить** (tonal) goes through `ProfileStore.sendWake`, because the server cooldown is per sender. While the cooldown runs the tile reads «Через N с».
- Info group:
  - Должность and Роль are plain rows.
  - Отдел opens «Сотрудники › Отделы» with that branch expanded.
  - Вн. номер copies on tap and shows a «Скопировано» HUD plus a VoiceOver announcement.
  - Мобильный and Email open the dialer / mail only through `ContactLinks.dial/mail`, which check the value. A long press opens a context menu with «Скопировать».
  - Empty rows are omitted.
- «Пожаловаться» uses the existing `ReportSheetView`. «Заблокировать» / «Разблокировать» use `AccountStore.block/unblock`, with the same confirmation alert as the chat. These calls are not duplicated.
- The card's model registers for `wake_sent` events.

**Universal search in «Чаты»** (`Features/Search/*`, `ChatListView.swift`)
- `.searchable(isPresented:)` with the prompt «Люди, каналы, сообщения». While it is focused or holds text, the results screen replaces the inbox; the old inline filter was removed.
- Empty query: «Недавние», the last 5 people or channels opened.
- Results, in fixed order:
  - **Люди**: max 5, plus «Все сотрудники (N)», which carries the query to the «Сотрудники» tab.
  - **Каналы**: max 4, «#» optional.
  - **Сообщения**: a 2-row skeleton while loading, then hits showing sender, time, where, and a 2-line snippet with the match highlighted. Separate hints cover «от двух символов», nothing found, failure, and rate-limited.
- Return opens the first result.
- `UniversalSearchModel`:
  - Debounces 300 ms and only searches from 2 characters.
  - A new keystroke cancels the old search, and a late answer is never shown.
  - A trailing space neither searches again nor leaves the skeleton up.
  - 429 is reported separately.
- A message hit pushes `ChatDetailView(highlightMessageId:)`:
  - `ChatStore.loadAround` fetches `beforeId=id+1` and `afterId=id`, 30 each.
  - The list scrolls to the message and pulses it for 1.2 s. With Reduce Motion this is a plain fade.
  - Pages now merge by id. This fixes `load()` on a reconnect, which used to put older history after the newest page.

**Data / API:** `ChatRepository` gained `messages(in:limit:afterId:)` and `searchMessages(_:)`, and `APIClient.getMessages` gained `afterId`. Only the existing server endpoints are used: `/api/users`, `/api/org/tree`, `/api/users/:id` and `/api/messages/search`.

**Copy and docs:** all copy is Russian. The String Catalog was regenerated, and integer keys were fixed to `%lld`, including the old `peopleSummary` key. README structure updated.

## Tests
Unit tests (new files in `CentyChatTests/`):
- `PeopleSearchTests`: normalisation (case, ё=е, keeps length), tokens, phone queries, every rank, multi-word AND, online-first ordering (DND is not «online»), highlights, alphabetical order.
- `PeopleDirectoryTests`:
  - Active colleagues only, never yourself.
  - Department names come from the tree.
  - Tree counters, with «Без подразделения» last.
  - Filtering, path to a department, А–Я sections.
  - Russian plurals in the summary.
  - Outline rows.
- `PersonCardTests`:
  - «был(а) в сети» today / yesterday / date / SQLite timestamps / future dates.
  - `tel:`/`mailto:` safety, with injection rejected.
  - The call rule: permission comes before DND, then offline.
  - Refresh, live presence, own card, «Отдел» request, former employee, wake sent once with a cooldown.
- `PeopleStoreTests`:
  - Cache first, then the server.
  - Another owner's cache is ignored.
  - A failed refresh keeps the list.
  - Presence events stamp `last_seen`.
  - Sign-out wipes the directory and the cache.
- `PeopleModelTests`: the model's states and requests from other tabs. `PeopleWiringTests`: the container wiring (realtime and sign-out wipe of the directory and recents).
- `UniversalSearchTests`:
  - Local results on every keystroke.
  - Max 5 people and 4 channels.
  - One server request after the pause.
  - A query under 2 characters never reaches the server.
  - A stale answer is dropped.
  - Hit routing and highlights.
  - A trailing space does nothing.
  - 429 is reported.
  - Recents, «nothing found», «Все сотрудники», Return order, snippet cut.
- `SearchRecentsTests`, `HighlightTests`, and `ChatJumpTests` (around-load, no request when the message is already loaded, missing message, reload order, pending messages stay last).

UI tests: `CentyChatUITests/PeopleSearchUITests.swift`, registered in `project.pbxproj`. It runs against the dev stand only.
- `testSearchToCardToChatAndBack`: 4 tabs → search «Боб» → card → «Написать» → the chat opens in «Чаты» → back → card → back → search results → «Сотрудники» list and summary → a card from the list → back.
- `testPeopleScreensForReview`: screenshots of the list, the card and the search, in light, dark and AX-XXXL.
- Per the coordinator's note, the tests have a private copy of `dismissSystemPrompts()` (SpringBoard included). Replace it with the shared helper after the lanes merge. On failure the tests print the app and SpringBoard trees.

## TDD evidence and CI runs
- Baseline before the task: 37258137935, green.
- **RED**:
  - 30a38cb + 12e41b4 pushed the tests with API stubs only. In run **37260637760**, the app target (stubs) compiled, but the test build failed: `ChatJumpTests.swift:15: unable to type-check this expression in reasonable time`.
  - So the RED evidence is a failed test build, **not** assertion failures. Assertion-level RED on CI would have needed a revert-and-reapply round trip on a branch I may only fast-forward.
  - The earlier RED attempt, 37259982984, was cancelled by me and superseded.
- **GREEN unit**: 37261199711. All unit tests passed. Only my two new UI tests failed: after the first signed-in launch, nothing was hittable after sign-in, caused by the system «Save Password?» sheet the coordinator described. The light screenshots from that run were already correct.
- 37262818427: green, after waiting for the inbox and tapping by coordinate. The AX screenshots then showed truncated rows («А…»).
- 37264363695: green, after the AX layout fix.
- **37265738969: green, final** (head 2ab0cd7, with the SpringBoard prompt dismissal).
- `RegistrationFlowUITests.testDeleteAccount…` and `UserPathQATests` passed in every run of mine.
- Superseded runs I cancelled: 37259982984, 37260701878.

## Screenshots
Branch `ci/ios-screenshots`, commit `d2ec1a6` («ci(ios): screenshots for 2ab0cd7»), folder `2ab0cd7/`:
- `PeopleSearchUITests-testPeopleScreensForReview--10-people-{light,dark,ax-xxxl}.png`
- `…--11-person-card-{light,dark,ax-xxxl}.png`
- `…--12-search-{light,dark,ax-xxxl}.png`

Folders `5d8554f/` and `c51ceb7/` hold the same set from the previous green runs.

## Commits (on `mobile/ios`)
`30a38cb` test (red), `12e41b4` test fix, `066b17b` logic layer, `224711f` UI, `6755722` test type-check fix, `804b134` «В сети» chip, `c51ceb7` UI-test hardening, `5d8554f` AX layout, `2ab0cd7` SpringBoard prompt dismissal.

## Files
- **New, app:** `App/AppNavigation.swift`, `App/AppRoutes.swift`, `Features/People/{PeopleView,PersonCardView,PersonRowView,DepartmentOutline}.swift`, `Features/Search/{UniversalSearchModel,UniversalSearchView,SearchRecents}.swift`, `UI/DesignSystem/Components/{Highlight,SectionIndexBar}.swift`.
- **Changed, app:** `App/MainTabView.swift`, `App/AppContainer.swift`, `App/Stores/{ChatStore,ConversationsStore}.swift`, `Features/People/{PeopleModel,PeopleStore}.swift`, `Features/ChatList/ChatListView.swift`, `Features/ChatDetail/ChatDetailView.swift`, `Core/Network/APIClient.swift`, `Core/Repositories/{Repositories,LiveRepositories}.swift`, `UI/DesignSystem/CentyColors.swift` (successText/successSoft), `Resources/Localizable.xcstrings`, `README.md`, `CentyChat.xcodeproj/project.pbxproj`.
- **Tests:** `CentyChatTests/{PeopleSearchTests,PeopleDirectoryTests,PersonCardTests,PeopleStoreTests,UniversalSearchTests,ChatJumpTests}.swift`, `Support/TestDoubles.swift` (`FakePeopleSource`; `FakeChatRepository` now honours `beforeId`/`afterId` and supports search), `CentyChatUITests/PeopleSearchUITests.swift`.

## Self-review and concerns
- **«Позвонить» rule:** it is also disabled when the peer is offline, not only for permission, DND and self. This keeps it in line with the existing iOS `CallAvailability`, Android and the design brief. Say if offline calls should stay enabled.
- **Button label:** «Побудить» (design brief and Android wording) is used for the «Побудка» action.
- **List styles:** the «Все» list uses `.plain`, so the letters stay sticky and the index works like Contacts. «Отделы», the card and the search results are inset grouped.
- **Not done:**
  - The children of an expanding department fade in as a group; there is no 6×20 ms stagger.
  - There is no ConnectionBanner, because no such iOS component exists.
  - The card cannot be opened from the chat header avatar; the brief did not require it.
  - The highlight weight is bold (`stronglyEmphasized`), not exactly 600.
- **Jump to a message:** if more than 30 messages lie between the hit and the newest page, the history between them is not loaded, so the chat shows a gap there.
- **Message search:** channel hits take their title from the loaded channel list, since `channel_name` is not decoded. Dates in the hits follow the device locale; the CI simulator is English, hence «AM».
- **UI-test helper:** replace the private `dismissSavePasswordPrompt` copy with `XCUIApplication.dismissSystemPrompts()` after the integration merge.
- **Tracking deferrals (Android parity):** «Недавние» and PeopleRequests mirror Android, but the search query does not survive process death the way Android's SavedStateHandle does. Only the People filters persist (SceneStorage).

## Fix round 1 (review finding: gap after a search jump; search-hit time)

**What changed:**
- **Jump to a search hit** (`App/Stores/HistoryWindow.swift` is new; `ChatStore.loadAround` changed):
  - Ported Android's `HistoryWindow`. It requests `beforeId = id + 1` with limit 31, and the hit must be in that page. It then requests `afterId` pages of 200, at most 5, until a page comes back short. The result is one continuous, deduplicated, ordered stretch from 30 messages before the hit up to the newest message.
  - That window replaces `messages`. Pending messages (ids ≤ 0) and anything newer that arrived meanwhile are kept.
  - If more than 1 000 messages are newer than the hit, or the hit is gone, `loadAround` returns false. The chat stays on its newest page and scrolls to the bottom with no highlight; `ChatDetailView` already handled `false` that way.
  - The old splice of hit ±30 into the newest page is gone, so the cached store can no longer hold two stretches with a hole between them.
- **Search-hit time** (`SearchHitTime` in `Features/Search/UniversalSearchModel.swift`, used by `UniversalSearchView`):
  - The format is fixed to ru_RU and 24-hour: «09:32» for today, «2 окт., 16:00» otherwise. It no longer follows the device region (before it showed «4:58 AM»).
  - It follows the inbox's today/other-day rule. The «d MMM, HH:mm» pattern is the one the review asked for; the inbox row itself shows only «dd.MM».

**Tests:**
- `ChatJumpTests`, rewritten. Each case now asserts the exact message ids:
  - After the jump: ids 10…200 exactly, continuous from the hit to the newest message (this replaces the old `contains(200)` check).
  - Overflow fallback, with 1 300 messages: false, and only the newest page 1251…1300.
  - A vanished hit: false, and the newest page 151…200.
  - A reload after the jump keeps 10…200.
  - A pending message stays last, after 10…200.
  - A hit already on screen makes no request.
- `HistoryWindowTests`, new, ported from Android `HistoryWindowTest`:
  - The window 70…300 is built with exactly the requests `before 101 31`, `after 100 200`, `after 300 200`.
  - More than 5 pages of newer messages gives up.
  - A missing hit gives up.
- `SearchHitTimeTests`: today shows the time only; another day shows «d MMM, HH:mm» in Russian.

**TDD evidence and CI runs:**
- **RED: run 37267802308** (commit 2ab1688). The tests ran with the old `loadAround` and a stub `SearchHitTime` (the old formatting). 8 failures out of 274: 6 in `ChatJumpTests` (ids 11…200 with gaps / a second stretch, no overflow fallback) and 2 in `SearchHitTimeTests` («5 окт. 2026 г., 4:32 AM» instead of «09:32»).
- **GREEN: run 37267887312** (commit 5935314) is green. 277 unit tests and 14 UI tests ran with 0 failures; the Release lock job and the screenshot publish succeeded.

**Commits:** `2ab1688` test (red), `5935314` fix.
