# Task 11 final review — mobile/contracts and cross-platform parity

Range: master..mobile-release-parity-impl. Read-only review, no Gradle and no emulator.

**Status: complete.** Part 1 (contracts vs server) comes first; Part 2 (cross-platform parity) is appended. Part 2 combines my own reading with three sub-reviews; I re-checked the key lines of every Critical and Important item myself. A = mobile/android/app/src/main/java/com/openmychat/mobile/, I = mobile/ios/CentyChat/, D = desktop/src/, S = server/src/.

# Part 1 — contracts vs server

## Verified (green)
- `cd server && node --test test/mobile-delivery-reducer.test.js`: 73/73 pass (70 vectors, plus the coverage and format tests).
- `node --test test/notify-decision.test.js`: 6/6 pass.
- `node --test test/mobile-contract-fixtures.test.js`: 6/6 pass. The committed http/ws/push fixtures match what the current server serializes (key sets and types).
- Server constants match delivery-state.md §6.1:
  - `CLIENT_MSG_ID_RE` matches (message.service.js:65).
  - `MAX_TEXT_LENGTH` is 16000 (message.service.js:20).
  - The page cap is 200 (message.service.js:311).
  - `RATE_LIMITED` with `retry_after_ms` is in place (ws/server.js:714).
- Registration codes match registration.md: `USERNAME_TAKEN`, `EMAIL_TAKEN`, `CODE_INVALID` with `attemptsLeft`, `CODE_EXPIRED`/410, `ACCOUNT_PENDING`/`ACCOUNT_REJECTED`/403, `EMAIL_SEND_FAILED`/503 (registration.service.js, api/index.js:587-591, 670-708).
- `showsMeta` logic is equivalent on both platforms:
  - Android: ChatPresentation.kt:119, 132-145.
  - iOS: ChatProjection.swift:202-222, 266-271.
  - Both use the same 5-minute group break, the same edited check, and the same queued < sending < failed < sent < delivered < read ordering for the "stalled behind" rule.

## Critical
None found in the verified scope.

## Important
1. **The WS error-code table omits `DM_NOT_ALLOWED`.**
   - Where: ws-protocol.md:858-868 (§4.2).
   - Server: message.service.js:123 lists `DM_NOT_ALLOWED` as a permanent code, and it is sent over WS on blocked DMs (message.service.js:428). It appears only in registration.md:100.
   - Android acts on it (ComposerLock.kt:18-58). No `DM_NOT_ALLOWED` handling turned up in iOS Core/Features outside the unmerged UI layer.
   - Scenario: an iOS user who is blocked by the peer sees a generic failed send, with no lock or banner. That diverges from Android.
   - Fix: add the code to the table (`false`, send). Confirm iOS locks the composer the same way, or record that the lock lands with Task 10.
2. **openapi.yaml lacks the new endpoints, and they have no fixtures.**
   - Missing endpoints:
     - `/auth/register/request` and `/auth/register/verify`
     - `GET`/`POST /blocks` and `DELETE /blocks/:userId`
     - `POST /reports`
     - `DELETE /users/me`
     - `/admin/registration-allowlist`, `/admin/reports`, `/admin/reports/:id/close`
   - These all exist in server/src/api/index.js.
   - Nothing under fixtures/http covers them, so the drift test does not protect what the clients decode.
   - Scenario: a server serializer change (for example `blocks[].userId`) silently breaks both clients.
   - Fix: add the paths to openapi, capture fixtures in capture-fixtures.mjs, and add them to the required list.
3. **registration.md §1.1/§1.2 is incomplete.**
   - `request` can return 503 `{code:"BUSY"}` with `Retry-After` (api/index.js:675-677) and 503 `PASSWORD_HASH_BUSY` (api/index.js:663-665). Neither is documented.
   - "Почта не настроена" has **no `code`** (registration.service.js:152, 192), even though the contract says clients branch on `code`.
   - `verify` can return 409 `USERNAME_TAKEN`/`EMAIL_TAKEN` (registration.service.js:251-273), plus 429 `RATE_LIMITED` and 500. None of these are documented.
   - `CODE_INVALID` for a malformed code has no `attemptsLeft` (registration.service.js:207).
   - Scenario: clients guess (see Ruling D, iOS BUSY mapped to «почта не настроена»), or show a generic error when a name is taken between request and verify.
   - Fix: document every status. Give "not configured" a code such as `EMAIL_NOT_CONFIGURED`, or document that clients must branch on status 503 without a code.

## Minor
1. **parity-matrix.md is stale.**
   - Line 27 says the statuses reflect "аудит 2026-10-02".
   - It has no rows for registration, account deletion, block/report, the outbox engine, or multi-device/presence.
   - The checklist at lines 260-264 still shows platform fixture decoding and push as open.
   - Fix: refresh it before release.
2. **No shared vectors for UI projection rules** (showsMeta and grouping). Each platform tests these on its own (ChatGroupingTest.kt, ChatProjectionTests.swift). Fix: optionally add `fixtures/projection/*.json`.
3. **No `CANCELLED_MAX` reducer vector** (already deferred in Task 5).
4. **Real company data in contracts.**
   - fixtures/http/users.list.json:6-7 holds `admin@cic.kz` and the phone `+7 (727) 244-77-00`. These come from the server seed at db/identity/index.js:453, so the data is corporate rather than personal.
   - openapi.yaml:3180, 3233, 3276, 3402, 4423 hold example emails in the form `k.akhmetov@cic.kz`. These were already on master but look like real employee names.
   - openapi.yaml:22 points at `chat.centras.kz`.
   - ws-protocol.md:21 names the production Railway host. That one is intentional.
   - Fix: replace the examples with `@example.test` and change the server seed contact.


# Part 2 — cross-platform parity (Android / iOS / desktop)

## Verified identical
- **Delivery reducers.** Kotlin `A/data/delivery/DeliveryReducer.kt:35-57` and Swift `I/Core/Delivery/DeliveryReducer.swift:11-42` are line-for-line ports of `delivery-reducer.mjs`. Every constant matches:
  - ack timeout 10 s; HTTP ack timeout 30 s; max attempts 5;
  - 8 sends and 8 ops per second;
  - backoff `min(1000·2^(n−1), 30000)`;
  - RATE_LIMITED default 1000 ms, capped at 30000 (`.kt:702-703` = `.swift:719-722`);
  - sync retry 5000; sync page 200; CANCELLED_MAX 100;
  - the same key-error and whitespace sets.
- **Vector runners.** Both walk `fixtures/reducers/` (not a list) and compare effects exactly:
  - Android: `test/.../contract/DeliveryReducerVectorsTest.kt:58`.
  - iOS: `CentyChatTests/DeliveryReducerVectorsTests.swift:12-19`, which also requires at least 70 files.
- **Engine:** the persist barrier, 401 handling (refresh once, keep the outbox, end the session only on a definitive rejection) and the 20-round background flush loop behave the same on both.
- **showsMeta:** same rule on both (see Part 1).
- **safeDownloadType.** Server `S/api/index.js:2086-2092`, Android `SAFE_TYPES` (`A/features/attachments/AttachmentIntents.kt:19-25`) and iOS `safeOpenTypes` (`I/Features/Attachments/AttachmentRules.swift:11-17`) list the same 21 types; I diffed them with a script. Desktop has no allow-list by design: it uses the server Content-Type plus a save-time block-list (`D/main/download-guard.js`).
- **Upload pre-check texts** match on Android and iOS and use the server's wording: 100 MB limit, no extension, extension not allowed, empty file.
- **AccountFailure status/code → state mapping** is identical (`A/features/account/AccountFailure.kt:58-108` = `I/Features/Auth/AccountFailure.swift:48-100`). This includes 503 `BUSY` → short wait, so Ruling D is closed.
- **Report reasons and titles** match: spam, abuse, inappropriate, threat, other.
- **Block list** is loaded at sign-in on both phones, and a blocked direct chat leaves the list on both.
- **Presence and viewing.** The `viewing` frame has the same shape. It is sent only on change and again after `auth_success`. Both send away when backgrounded. The `device_id` is one persistent value used by knock, auth and the push token.
- **Push handling:** both use `notify` and fall back to the old local rule; push ids are parsed with `> 0` on Android.

## Critical
C1. **Background notifications do not work on either phone: Android has no push code, and iOS is not wired up end to end.** This breaks `push.md` §2 and §5. The iOS side was planned as Task 8.
- **Android has no push at all.** There is no Firebase dependency, no `FirebaseMessagingService`, no `onNewToken`, and no call to `/api/devices/push-token` anywhere under `mobile/android` (confirmed by grep). `MessageNotifier.onPush` (`A/data/notifications/MessageNotifier.kt:142-152`) has no caller.
- **iOS registers a token but cannot show or route notifications.**
  - Nothing calls `requestAuthorization` (`I/Core/MultiDevice/MessageNotifications.swift:125`). Without that permission, even local banners from socket `notify` frames never appear.
  - `UIBackgroundModes` contains only `audio` (`I/Resources/Info.plist:40-43`), so the silent `read` push cannot wake the app. The README claims `remote-notification` is set; it is not.
  - There is no entitlements file, so APNs never issues a token.
  - There is no `didReceive response` handler, so tapping a notification does nothing (`I/App/PushRouting.swift:60-71` has only `willPresent`).
  - There is no PushKit/VoIP (already deferred in Task 8).
  - The unmerged `mobile/ios` (Task 10) changes none of this.
- **Scenario:** with the app in the background or killed, an employee gets no message, call or read-dismiss notification on either phone.
- **Fix:**
  - Android: add the FCM service; register the token after sign-in, at launch and in `onNewToken`; route incoming pushes into `MessageNotifier.onPush`.
  - iOS: request notification permission (Android already has `NotificationPermissionPrompt`); add `remote-notification` and the entitlements; add a tap handler that routes on `conversationType`/`targetId`.
  - If the owner rules push out of this release, record that ruling. Otherwise this blocks release.

## Important
P1. **Android uploads have no concurrency cap.**
- Android starts every waiting file at once (`A/features/chat/AttachmentSends.kt:100,117,209`).
- iOS caps at 2 (`I/Features/Attachments/AttachmentUploads.swift:136,445`), which matches the server's `MAX_PARALLEL_UPLOADS = 2` (`S/api/index.js:2148,2191-2193`). **iOS matches.**
- Scenario: three photos are queued offline. On reconnect the third gets 429 «Дождитесь окончания текущих загрузок».
- Fix: a semaphore of 2.

P2. **Android treats 408, 429, 5xx, 507 and 401 on upload as permanent failures.**
- Android retries only when `statusCode == 0` (`AttachmentSends.kt:329-341`).
- iOS waits and honours `Retry-After` (`I/Features/Attachments/AttachmentRules.swift:76-84`, `AttachmentUploads.swift:496-500`). **iOS matches** never-lose and what the server intends. This is the same bug iOS fixed in Task 9 round 1.
- Scenario: the 429 from P1, or a server restart mid-upload, leaves the file red with «Повторить».
- Fix: port `retryDelayMs` (`ApiException.retryAfterSeconds` is already filled).

P3. **Android can send file messages out of order.**
- Android enqueues each file when its upload finishes (`AttachmentSends.kt:297-305`).
- iOS hands files to the outbox in the order they were picked, per conversation (`AttachmentUploads.swift:520-541`). **iOS matches** the owner's FIFO intent; delivery-state §7.2 covers only the outbox.
- Fix: port the ordered hand-over.

P4. **Android trims composer text.**
- Android uses `isBlank()` and `text.trim()` before enqueue and edit (`A/features/chat/ChatViewModel.kt:422,432,436`).
- iOS sends the text as typed (`I/App/Stores/ChatStore.swift:249-255`), and the server stores it untrimmed. **iOS matches** delivery-state §6.1, where the reducer decides emptiness using the fixed WHITESPACE set.
- Scenario: leading and trailing newlines differ depending on the sender's platform. `" "` is silently dropped on Android but gets EMPTY_TEXT on iOS.
- Fix: drop the trim and `isBlank`.

P5. **iOS does not lock the composer for a blocked direct chat, and does not handle `DM_NOT_ALLOWED`.**
- Android locks the composer in both cases (`A/features/chat/ChatViewModel.kt:206-220`, `ComposerLock.kt:18-58`) and shows «Сообщение не может быть доставлено. Писать в эту переписку нельзя.» (`strings.xml:444`). **Android matches** registration.md §4.
- iOS shows a banner when *I* blocked the peer (`I/Features/ChatDetail/ChatDetailView.swift:167-184`), but the input stays enabled; send is disabled only when the text is blank (`:577`).
- On `DM_NOT_ALLOWED`, iOS falls through to «Сообщение не сохранено — попробуйте ещё раз» (`ChatStore.swift:372`), and retrying can never work.
- Task 10 does not change this.
- Fix: port ComposerLock and map `DM_NOT_ALLOWED`.

P6. **iOS also hides blocked people's messages in channels.**
- The filter at `I/Features/ChatDetail/ChatDetailView.swift:115` applies to every chat, and channel bubbles offer «Заблокировать автора».
- registration.md §4 says «каналы не затрагиваются». **Android matches.**
- Fix: filter direct chats only, or record a ruling.

P7. **iOS copy contradicts the server for block and account deletion.**
- **Block confirmation:**
  - iOS says «…будут скрыты на этом устройстве» (`ChatDetailView.swift:261`, `PersonCardView.swift:116`).
  - Android says «%1$s не сможет писать вам, а вы — ему…» (`strings.xml:439`). **Android matches** the server, which refuses in both directions.
- **Delete-account warning:**
  - iOS says «Аккаунт, переписка и личные данные будут удалены безвозвратно» (`I/Features/Profile/AccountSafetyViews.swift:271`).
  - registration.md §3 says sent messages stay, signed «Удалённый сотрудник». **Android matches** (`strings.xml:413`).

P8. **Android does not claim the device after registration sign-in.** This is the open item from Task 3, now confirmed.
- iOS calls `claimDevice()` in `completeRegistration` (`I/App/Stores/SessionStore.swift:260-262`).
- On Android, `RegistrationOutcome.SignedIn` never claims (`A/data/repository/AccountRepository.kt:108-112`, `RegistrationViewModel.kt:116-117`); only `AuthRepository.login` does (`:66-87`).
- **iOS matches** the parity-matrix row «Device Claim».
- Scenario: an auto-approved Android registrant must type the password again once the short-lived token expires.
- Fix: a shared claim helper, called after SignedIn.

P9. **iOS lowercases the login name.**
- iOS: `I/App/Stores/SessionStore.swift:241` uses `.lowercased()`.
- Android (`A/data/repository/AuthRepository.kt:67`) and desktop only trim.
- The server looks up `WHERE u.username = $1` after a trim (`S/services/auth.service.js:389-392`). The column is case-sensitive (`S/db/identity/schema.js:36`), and admin-created or imported logins keep their case. **Android and desktop match.**
- Scenario: user «Ivanov» signs in on Android and desktop, but iOS answers «Неверный логин или пароль».
- Fix: trim only.

P10. **The logout request differs.**
- Android clears the session first, then posts `{}` without `device_id` (`A/core/network/ApiClient.kt:264-279`).
- iOS sends `{device_id}` (`I/Core/Network/APIClient.swift:470-475`) but swallows a failure with `try?`. **iOS matches** push.md §2 on the request body.
- Neither platform clears displayed notifications at sign-out.
- Fix: send `device_id` from Android, and call `cancelAll` on both.

P11. **Persist failure on server events.**
- Android restarts the socket immediately (`A/data/delivery/DeliveryEngine.kt:553`). The socket backoff resets on `auth_success`, so a broken disk loops at about one restart per second.
- iOS backs off up to 30 s (`I/Core/Delivery/DeliveryEngine.swift:657-667`). **iOS matches** delivery-state §5.
- Fix: port the `diskFailures` backoff to Android.

P12. **iOS has no OS-level background flush.**
- Android uses WorkManager (`A/data/delivery/work/DeliveryFlushWorker.kt`, `DeliveryRuntime.kt:95-99`). **Android matches** delivery-state §4.2.
- iOS has no BGTask; this was already deferred in Task 9.
- Fix: add a `BGAppRefreshTask`.

P13. **The sign-out confirmation differs on all three clients.**
- Android always confirms: «Выйти из учётной записи?» plus a password note (`strings.xml:303-304`).
- iOS signs out without confirming when nothing is unsent; otherwise it asks «Выйти из аккаунта?» (`I/Features/Profile/ProfileView.swift:127-131,193-204`).
- Desktop always confirms, with different wording (`D/renderer/src/App.jsx:569-570`).
- The unsent-messages line also differs:
  - Android's line ends with a period (`strings.xml:305-310`); iOS's does not (`I/Core/Delivery/DeliveryRuntime.swift:162-178`).
  - Android has no «Не удалось проверить неотправленные…» variant, and it shows 0 before the store has loaded (`A/data/delivery/DeliveryRuntime.kt:65-67`).
- Fix: one title, one body and one unsent line, always with a confirmation.

P14. **Every delivery `user_error` text differs** between Android (`ChatViewModel.kt:624-635`) and iOS (`ChatStore.swift:363-374`).

| Code | Android | iOS |
|---|---|---|
| EMPTY_TEXT | «Пустое сообщение не отправляется» | «Нельзя отправить пустое сообщение» |
| TEXT_TOO_LONG | «Сообщение слишком длинное» | «Сообщение длиннее 16 000 символов» |
| EDIT_REJECTED | «Изменение не сохранено» | «Сообщение нельзя изменить» |
| NOT_EDITABLE | «Это сообщение нельзя изменить» | «Сообщение нельзя изменить» |
| NOT_DELETABLE | «Это сообщение нельзя удалить» | «Сообщение нельзя удалить» |
| DELETE_NOT_CONFIRMED | «Удаление не подтвердилось — сообщение снова показано» | «Сервер не подтвердил удаление — сообщение снова видно» |

- The failed bubble also differs: Android shows only «Не отправлено» (`MessageBubble.kt:314-322`), while iOS adds the reason (`I/Features/ChatDetail/ChatProjection.swift:153-161`).
- Fix: one shared strings table, for example a contract fixture `copy/ru.json` checked by both test suites.

P15. **The call-push rule in the docs contradicts the server.**
- `push.md` §3 says «…только сотруднику без единого сокета», and `multi-device.md:116,190,216` say the same.
- `decideCallNotification` (`S/ws/server.js:425-433,1849-1868`) and vectors c01–c10 do something else: a call push goes to every device without an online socket. **The server and the vectors are authoritative.**
- The comments that cite «§7» point to the wrong section.
- Fix: update the docs.

P16. **Desktop diverges from multi-device.md.**
- An idle but focused window with the chat open suppresses both the banner and the unread increment, because `isCurrentActive` ignores presence (`D/renderer/src/App.jsx:1409-1413,1457-1461`). This contradicts vector 05.
- `mark_read` is sent only near the bottom of the chat (`D/renderer/src/components/ChatView.jsx:146`), while `viewing` already silences the phone (§4.4).
- A minimized window counts as away only after `document.hidden` has lasted 180 s (`App.jsx:1982-1989`). With `backgroundThrottling:false` (`D/main/main.js:448`) this may never fire (not tested).
- Fix: add `presence !== 'away'` to `isCurrentActive`, mark read or count unread when scrolled up, and send away on minimize.

P17. **Tests and docs may contain real personal data.** These combine a real corporate domain with name-style emails, Kazakh names and Almaty landlines:
- Android: `test/.../data/SerializationTest.kt:22-23,50` («Канат Ахметов», `k.akhmetov@centras.kz`), `ContactLinksTest.kt:11,24`, `PeopleSearchTest.kt:69,78`.
- iOS: `CentyChatTests/DTOParsingTests.swift:13-15`, `PeopleSearchTests.swift:48,75,83`, `PersonCardTests.swift:52-54,65-66`, `CallStateMachineTests.swift:9`.
- Contracts: `openapi.yaml:3176-3183,3272-3280,3398-3406,3757,4419-4426` and `ws-protocol.md:352`.
- I cannot confirm these are real people.
- Fix:
  - replace the names with synthetic ones, the emails with `@example.test` and the phones with `+7 700 000 00 xx`;
  - neutralise the seed admin in `S/db/identity/index.js:453-454`;
  - recapture the fixtures.
- Real hosts are listed under Minor.

## Minor
- **iOS `message_deleted` without an integer `messageId` drops every pending `cancel` op.** `confirmDeleted(&state, nil)` removes all ops whose messageId is nil (`I/Core/Delivery/DeliveryReducer.swift:825-834,282-284`). Kotlin guards against this (`DeliveryReducer.kt:814`). The reference wipes them only on an explicit `null`. Fix: an integer guard in all three, plus a vector.
- **The iOS vector runner is weaker than Android's.** It treats a missing state key as null (`DeliveryReducerVectorsTests.swift:77`), and has no length check (`:69`) and no name check. Android has all three (`DeliveryReducerVectorsTest.kt:29,33,46`).
- **Vector gaps:** CANCELLED_MAX eviction; HTTP 408, 429 and 404 on send; malformed `retry_after_ms`; `message_deleted` without an id.
- **Retry-After parsing.** Android reads delta-seconds only and applies no cap (`A/core/network/ApiClient.kt:517-519`). iOS also reads HTTP dates and caps the wait at 86400 s (`I/Core/Network/RetryAfter.swift`).
- **Socket reconnect jitter.** Android can wait up to about 36 s (`WebSocketClient.kt:220-222`); iOS clamps to 1–30 s.
- **Android `conversation_read`** clears unread only through a bus that does not replay, feeding the list ViewModel (`MessageNotifier.kt:36-43`, `ConversationsViewModel.kt:198`). iOS applies it in the session-wide store (`ConversationsStore.swift:158`).
- **Android notifications** use the tag `<type>-<id>` with a fixed id of 1, so each new message replaces the last. There is no group summary, and the requestCode `tag.hashCode()` can collide (`SystemNotificationSink.kt:54-79`).
- **Notify vectors.** iOS runs them (`NotifyDecisionVectorTests.swift:44-52`). Android excludes them (`ContractFixturesTest.kt:135`) and desktop has none. `multi-device.md:202` allows this, but it is asymmetric.
- **Registration.**
  - iOS ignores the 429 wait on «Подтвердить» and «Отправить код ещё раз» (`RegistrationFlowModel.swift:93-110`). Android holds both (`RegistrationViewModel.kt:49,108,175-179`).
  - When the code expires, Android clears the field and iOS does not.
  - The pending screen title is «Заявка на рассмотрении» on Android and «Заявка отправлена» on iOS.
  - Desktop still uses the legacy `/auth/register`.
- **iOS ignores the 429 wait for report and block** (`AccountSafetyViews.swift:140`). Android gates both (`ReportController.kt:112`, `BlockController.kt:57`).
- **Copy differences:**
  - mail not configured (Android `strings.xml:384`, iOS `AccountFailure.swift:129`);
  - throttle countdown «10:00» vs «600 с»;
  - the login 503 and 404 texts;
  - blocked banner «…Сообщения не доставляются.» vs «…Его сообщения скрыты.»;
  - the blocked-list footer and empty state, and the report-sent and report-sending texts;
  - desktop says «отправить нельзя» where the server says «загрузить нельзя» (`D/renderer/src/lib/attachments.mjs:21`);
  - the preview after the last message is deleted: «Сообщений пока нет» (Android) vs «Нет сообщений» (iOS);
  - a reply to an original with empty text: «Вложение» (iOS) vs no quote (Android);
  - Android has `account_error_storage` (`strings.xml:396`); iOS shows its generic text.
- **Ruling L.** iOS still shows the company line on this branch (`I/Features/Auth/LoginView.swift:98`); the unmerged Task 10 removes it. Desktop still shows the tagline «Корпоративный мессенджер для сотрудников» (`D/renderer/src/components/LoginView.jsx:299`), contrary to «no replacement tagline».
- **File-name pre-check.** The mobile pre-checks lack the server's file-name check (`NAME_RISK_RE`); desktop has it (`D/renderer/src/lib/file-policy.mjs:23-27`).
- **The server's parallel-limit 429 sends no `Retry-After`.**
- **Real hosts in tests.**
  - The production host appears in Android `ServerConfigTest.kt:17,25,26` and `SessionManagerServerBindingTest.kt:34,49-56`, and in iOS `ServerEnvironmentTests.swift:8,16,96,97` and `CredentialBindingTests.swift:34,50`. The release-pinning assertions are legitimate; the binding tests should use `.example`.
  - The registration tests on both phones, and `registration.md:16,71`, use registrable `.kz` hosts: `chat.old-company.kz`, `company.kz`, `b.kz` and `c.kz`.
  - The real APNs topic `kz.centras.centychat` appears in `fixtures/push/apns.*.json:3`.
- **ws-protocol.md has no `viewing` row (20/s)** in its rate-limit table.

# Final verdict
**Not ready for release.**
- **Critical (C1):** background notifications have no code on Android and are not wired up on iOS. This blocks release unless the owner explicitly rules push out of it.
- **Important:** 17 divergences. The contracts are clean and the reducers are verified identical; the problems are in the engine, upload, account and UI layers, which the vectors cannot reach. The side that matches the contract is named for each one above.

**Ready after fixes** once:
- C1 is fixed or formally deferred;
- the Android items P1–P4, P8, P10 and P11 are fixed;
- the iOS items P5–P7 and P9 are fixed;
- the copy tables in P13 and P14 are agreed;
- the docs are updated (Part 1 items 1–3, P15).
