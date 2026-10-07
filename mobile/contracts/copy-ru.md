# Canonical Russian copy for all three clients

Status: **canonical** (Task 11 fix wave, 2026-10-07). Adopted from the copy proposal; the tables below are the source of truth for user-visible texts in the states they list.

- Machine-readable form: [`copy/ru.json`](copy/ru.json) — key → canonical text. Plurals are objects `{one, few, many, other}`. Android unit tests and iOS XCTest may load it and assert equality, the same way the reducer vectors are checked.
- Keys whose text comes from the server (`upload.quota`, the `{server message}` part of `delivery.reason.rejected`) are not in the JSON: `delivery.reason.rejected` in the JSON is the fallback used when the server sends no text.
- `login.busy_retrying` (desktop automatic retry) is in the JSON; it is described in the `login.busy` row.
- The "Android / iOS / Desktop" columns record where each text came from at adoption time (branch `mobile-release-parity-impl`); they are history, not instructions.
- Server texts for new codes match this table: `REGISTRATION_DISABLED` answers «Регистрация сейчас закрыта. Обратитесь к администратору.» (`reg.disabled`).

Path abbreviations:
- **A** = `mobile/android/app/src/main/res/values/strings.xml`, unless a `.kt` file is named
- **AK** = `mobile/android/app/src/main/java/com/openmychat/mobile/`
- **I** = `mobile/ios/CentyChat/`
- **I10** = the unmerged Task 10 branch `origin/mobile/ios`
- **D** = `desktop/src/renderer/src/`
- **S** = `server/src/`

In the tables, «—» means the client has no such state.

**Principles**
- Short, polite and plain, addressing the user as «вы».
- Say only what the server really does:
  - A block works in both directions and only in direct chats.
  - Account deletion keeps sent messages under «Удалённый сотрудник».
  - `DM_NOT_ALLOWED` does not reveal who blocked whom.
- No jargon: no «очередь», no «сервер обрабатывает».
- Each sentence ends with a period. Short labels (badges, banners, buttons) have no period.
- Placeholders: `{name}`, `{count}`, `{wait}`, `{ext}`, `{reason}`, `{code}`.
- **`{wait}` format, the same everywhere:**
  - under 60 s: `45 с`
  - otherwise `2 мин 30 с`, or `10 мин` when the seconds are 0

  This replaces Android's «2:30» (`AK/features/auth/LoginText.kt:33`), which screen readers mangle and which reads like a clock time. It also replaces iOS registration's «600 с» (`I/Features/Auth/AccountFailure.swift:133`).
- **Delivery.** Keys are proposed as a contract fixture `mobile/contracts/copy/ru.json` (key → text). The Android unit tests and the iOS XCTest suite would load it and assert that each platform's text equals it, the same way the reducer vectors are checked.

---

## 1. Sign-out

Canonical flow: **always ask** (Android and desktop already do; iOS asks only when something is unsent). The texts also work in iOS's current flow, which shows the same dialog only when there is an unsent line.

| Key | Canonical text | Android | iOS | Desktop | Choice and why |
|---|---|---|---|---|---|
| `signout.title` | Выйти из учётной записи? | «Выйти из учётной записи?» A:303 | «Выйти из аккаунта?» `I/Features/Profile/ProfileView.swift:194` | title «Выход из учётной записи» + «Выйти из учётной записи? …» `D/App.jsx:569-570` | **Android.** «Учётная запись» is the word used everywhere else in the product: profile, login, desktop. |
| `signout.body` | Чтобы снова войти на этом устройстве, понадобятся логин и пароль. | «Чтобы снова пользоваться CentyChat на этом устройстве, нужно будет ввести логин и пароль.» A:304 | — (no body) | «Для продолжения работы потребуется снова ввести пароль.» `D/App.jsx:570` | **New**, shortened from Android. It is true: logout drops the device secret, so knock will not sign in silently. |
| `signout.unsent` (plural) | one: «{count} неотправленное сообщение будет удалено.» · few: «{count} неотправленных сообщения будут удалены.» · many/other: «{count} неотправленных сообщений будут удалены.» | same words, with the period, A:305-310 | same words, no period, `I/Core/Delivery/DeliveryRuntime.swift:172-177` | — (no outbox) | **Android** (sentence with a period). Shown first, before `signout.body`, separated by a blank line. |
| `signout.unsent_unknown` | Не удалось проверить неотправленные сообщения. Если они есть, они будут удалены. | — (Android shows nothing; its count reads 0 before the store loads, `AK/data/delivery/DeliveryRuntime.kt:65-67`) | «Не удалось проверить неотправленные сообщения — если они есть, они будут удалены» `DeliveryRuntime.swift:166` | — | **iOS**, split into two sentences. Android needs this state: "0" while loading is not true. |
| `signout.confirm` | Выйти | «Выйти» A:302 | «Выйти» `ProfileView.swift:198` | «Выйти» | Same everywhere. |
| `signout.failed_unsent` | Не удалось удалить неотправленные сообщения. Выход отменён. | — (silent retry) | «Не удалось удалить неотправленные сообщения — выход отменён» `I/App/Stores/SessionStore.swift:296` | — | **iOS**, two sentences. It is true: the sign-out is aborted. |

## 2. Delivery `user_error` codes and failed messages

Codes are from `mobile/contracts/delivery-state.md` §5. Android texts are in `AK/features/chat/ChatViewModel.kt:624-635` (`DeliveryNotices`); iOS texts are in `I/App/Stores/ChatStore.swift:363-374`. Desktop has no reducer: it shows the server's `message` in a toast (`D/App.jsx:1740-1760`).

| Key | Canonical text | Android | iOS | Choice and why |
|---|---|---|---|---|
| `delivery.EMPTY_TEXT` | Нельзя отправить пустое сообщение | «Пустое сообщение не отправляется» | «Нельзя отправить пустое сообщение» | **iOS.** Plain and direct. |
| `delivery.TEXT_TOO_LONG` | Сообщение длиннее 16 000 символов | «Сообщение слишком длинное» | «Сообщение длиннее 16 000 символов» | **iOS.** It gives the real limit (`S/services/message.service.js:20`). |
| `delivery.NOT_EDITABLE` | Это сообщение нельзя изменить | «Это сообщение нельзя изменить» | «Сообщение нельзя изменить» | **Android.** «Это» points at the message the user acted on. |
| `delivery.EDIT_REJECTED` | Изменение не сохранено: сообщение больше нельзя изменить | «Изменение не сохранено» | «Сообщение нельзя изменить» (shared with NOT_EDITABLE) | **New.** The server refuses for good (window expired, message deleted, not the owner), and the local text goes back. Both facts should be said. |
| `delivery.NOT_DELETABLE` | Это сообщение нельзя удалить | «Это сообщение нельзя удалить» | «Сообщение нельзя удалить» | **Android**, same reason as NOT_EDITABLE. |
| `delivery.DELETE_REJECTED` | Сообщение не удалено: время на удаление истекло | «Сообщение нельзя удалить» | «Сообщение нельзя удалить» | **New.** The only permanent refusals for one's own message are `DELETE_WINDOW_EXPIRED`, `NOT_FOUND` or `NOT_OWNER` (ws-protocol §4.2), and for one's own message it is in practice the time window. It also tells the user the message stays. |
| `delivery.DELETE_NOT_CONFIRMED` | Сервер не подтвердил удаление — сообщение снова показано | «Удаление не подтвердилось — сообщение снова показано» | «Сервер не подтвердил удаление — сообщение снова видно» | **Mixed.** iOS's start (who did not confirm) and Android's end («показано»). |
| `delivery.INVALID_KEY` (`INVALID_CLIENT_MSG_ID`, `INVALID_CONVERSATION`, `INVALID_MESSAGE_TYPE`) | Не удалось подготовить сообщение к отправке | «Сообщение не удалось поставить в очередь» | default «Сообщение не сохранено — попробуйте ещё раз» | **New.** Android's text is jargon («очередь»), and iOS's wrongly says «не сохранено» and suggests a retry that cannot help. |
| `delivery.NOT_SAVED` (local persist failed) | Сообщение не сохранено — попробуйте ещё раз | same | same | Already identical. |
| `delivery.DM_NOT_ALLOWED` (failed bubble reason; see §4) | Сообщение не может быть доставлено | Android locks the composer instead (`AK/features/chat/ComposerLock.kt`) | falls into the default «Сообщение не сохранено — попробуйте ещё раз» (`ChatStore.swift:372`), which is **wrong** | The **server's** text (`S/services/message.service.js:428`). |
| `delivery.failed` (badge under the bubble) | Не отправлено | «Не отправлено» A:36 | «Не отправлено» / «Не отправлено: {reason}» `I/Features/ChatDetail/MessageBubbleView.swift:162` | — |
| `delivery.failed_with_reason` | Не отправлено: {reason} | — | iOS | **iOS.** The user should know whether «Повторить» can help. |
| `delivery.reason.max_attempts` | сервер не ответил | — | «Сервер не ответил» `ChatProjection.swift:158` | **iOS**, lower case after the colon. |
| `delivery.reason.rejected` | {server message}, or «сервер не принял сообщение» when there is none | — | `ChatProjection.swift:153-160` | **iOS**. |
| `delivery.retry` / `delivery.discard` | Повторить / Удалить | same | same | Already identical. |

## 3. Block, unblock and account deletion

What the server does (`mobile/contracts/registration.md` §4; `S/services/safety.service.js`, `S/services/message.service.js:428`):
- The block works in both directions: neither side can write.
- The blocked person's direct messages are hidden from the blocker.
- Channels are not affected.
- Unblocking brings the hidden messages back.

Desktop has no block or report features (none of these keys appear in `D`).

| Key | Canonical text | Android | iOS | Choice and why |
|---|---|---|---|---|
| `block.confirm.title` | Заблокировать пользователя? | A:438, same | `I/Features/ChatDetail/ChatDetailView.swift:255`, same | Already identical. |
| `block.confirm.body` | {name} не сможет писать вам, а вы — ему. Его личные сообщения будут скрыты. В каналах ничего не изменится. Разблокировать можно в чате или в профиле. | «%1$s не сможет писать вам, а вы — ему. Его сообщения в личной переписке будут скрыты. Разблокировать можно здесь же или в профиле.» A:439 | «Сообщения «{name}» будут скрыты на этом устройстве. Разблокировать можно в чате или в профиле.» `ChatDetailView.swift:261`, `I/Features/People/PersonCardView.swift:116` | **Android plus the channel sentence.** iOS is **untrue**: the server hides messages on every device and also forbids writing. iOS's channel filtering (`ChatDetailView.swift:115`) has to change to match. |
| `block.confirm.action` | Заблокировать | same | same | — |
| `block.done` | Пользователь заблокирован | A:440 | — | **Android.** iOS should show the same short notice. |
| `unblock.action` | Разблокировать | A:437 | `AccountSafetyViews.swift:212` | Identical. **No confirmation dialog** on either platform today; keep it that way, because unblocking only restores normal behaviour. |
| `unblock.done` | Пользователь разблокирован. Скрытые сообщения снова видны. | «Пользователь разблокирован» A:441 | — | **Android plus a true second sentence**: the server returns the hidden messages. |
| `unblock.failed` | Не удалось разблокировать. Повторите попытку. | «Не удалось разблокировать» A:411 | generic «Не удалось выполнить действие…» | **Android** plus a hint. |
| `chat.blocked_by_me.banner` | Вы заблокировали этого пользователя. Пока блокировка действует, писать друг другу нельзя. | «Вы заблокировали этого пользователя. Сообщения не доставляются.» A:443 | «Вы заблокировали этого пользователя. Его сообщения скрыты.» `ChatDetailView.swift:172` | **New.** It states the two-way effect in plain words, and the composer under it is disabled (§4). |
| `blocked.list.title` | Заблокированные | A:404 | iOS same screen | Identical. |
| `blocked.list.empty` | Вы никого не блокировали | A:405 | «Вы никого не блокировали.» `AccountSafetyViews.swift:198` | **Android.** It is a title, so no period. |
| `blocked.list.empty_hint` | Заблокировать человека можно в его карточке или в меню личной переписки. | A:406 | «…в диалоге: меню «⋯» вверху…» `AccountSafetyViews.swift:202` | **Android.** It does not depend on the icon. |
| `blocked.list.footer` | Вы не можете писать друг другу, пока блокировка не снята. | A:407 | «Сообщения заблокированных людей скрыты на этом устройстве.» `AccountSafetyViews.swift:226` | **Android.** iOS's «на этом устройстве» is untrue. |
| `blocked.list.load_failed` | Не удалось загрузить список заблокированных | A:410 | generic | **Android**. |
| `delete.warning` | Учётная запись и личные данные (имя, почта, телефон, фото) будут удалены безвозвратно. Отправленные сообщения останутся у собеседников с подписью «Удалённый сотрудник». Восстановить учётную запись нельзя. | «Аккаунт и личные данные (имя, почта, телефон, фото)… «Удалённый сотрудник». Восстановить аккаунт нельзя.» A:413 | «Аккаунт, переписка и личные данные будут удалены безвозвратно. Восстановить их нельзя.» `AccountSafetyViews.swift:271` | **Android**, with «учётная запись» for consistency (§1). iOS is **untrue**: the messages stay (registration.md §3). |
| `delete.confirm.title` | Удалить учётную запись навсегда? | «Удалить аккаунт навсегда?» A:416 | same `AccountSafetyViews.swift:346` | Both agree today. Changed only for the «учётная запись» rule; keeping «аккаунт» is also fine if the owner prefers it, as long as it is used in both places. |
| `delete.confirm.body` | Это действие нельзя отменить. | A:417 | `AccountSafetyViews.swift:351,353` | Identical. When something is unsent, `signout.unsent` goes first, separated by a blank line (Android `DeleteAccountScreen.kt:189`; iOS currently uses «. »). |
| `delete.wrong_password` | Неверный пароль. | A:394 | `AccountFailure.swift` | Identical. |
| `delete.last_admin` | Вы — единственный администратор. Назначьте другого администратора, затем удалите учётную запись. | A:395 | identical | «учётную запись» per §1. |

## 4. `DM_NOT_ALLOWED` and the composer lock

The server refuses with 403 / WS `DM_NOT_ALLOWED`, «Сообщение не может быть доставлено». By design the text does not say who blocked whom (registration.md §4).

| Key | Canonical text | Android | iOS | Desktop | Choice and why |
|---|---|---|---|---|---|
| `chat.dm_not_allowed.banner` | Сообщение не может быть доставлено. Писать в эту переписку сейчас нельзя. | «Сообщение не может быть доставлено. Писать в эту переписку нельзя.» A:444 | — | toast with the server text `D/App.jsx:1740-1747` | **Android plus «сейчас»**: the lock lifts when the other side unblocks, and Android's lock clears on that (`ComposerLock.kt`). |
| `chat.composer.locked_placeholder` | Отправка недоступна | A:445 | — (iOS keeps the input enabled) | — | **Android.** iOS has to lock the input. |
| `chat.empty.locked` | Сообщений нет | A:135 | — (iOS invites «Напишите первое сообщение…») | — | **Android.** Inviting a message that cannot be sent is untrue. |

## 5. Registration

Server: `S/api/index.js` (`/auth/register/request`, `/auth/register/verify`) and `S/services/registration.service.js`. Before the fix wave:
- `/auth/register/request` does not check `allow_registration` today.
- The legacy `/auth/register` answers 403 «Самостоятельная регистрация отключена администратором» with no code (`S/api/index.js:622`).

Now (fix wave, lane S): `/auth/register/request` and `/auth/register/verify` → 403 `{ "error": "Регистрация сейчас закрыта. Обратитесь к администратору.", "code": "REGISTRATION_DISABLED" }`, documented in registration.md §1.1.

Desktop uses the legacy flow and shows the server's text (`D/components/LoginView.jsx:48-55`).

| Key | Canonical text | Android (A) | iOS (`I/Features/Auth/AccountFailure.swift`) | Choice and why |
|---|---|---|---|---|
| `reg.disabled` (new, 403 `REGISTRATION_DISABLED`) | Регистрация сейчас закрыта. Обратитесь к администратору. | — | — | **New.** Short and true; «сейчас» because the administrator can turn it back on. |
| `reg.busy` (503 `BUSY` / `PASSWORD_HASH_BUSY`) | Сервер сейчас занят. Повторите через {wait}. | shown as `account_error_throttled` «Слишком много попыток…» A:385 (wrong state) | shown as «Слишком много попыток…» :133 (wrong state) | **New key**, worded like Android's `login_error_busy` (A:79). «Слишком много попыток» is untrue for BUSY: the user did nothing wrong. Both platforms map BUSY to `Throttled`, so they need a separate case. |
| `reg.throttled` (429) | Слишком много попыток. Повторите через {wait}. | A:385 | :133 | Identical words; only `{wait}` is unified. |
| `reg.mail_not_configured` (503 `EMAIL_NOT_CONFIGURED`; older servers: 503 without a code) | Сервер не может отправить письмо с кодом: почта не настроена. Регистрация временно недоступна — обратитесь к администратору. | «Отправка почты не настроена. Регистрация…» A:384 | «Сервер пока не может отправить письмо с кодом: почта не настроена. Регистрация…» :129 | **iOS without «пока».** It says what failed (the code e-mail), which matters to the user. «пока» promises a fix nobody scheduled. |
| `reg.mail_send_failed` | Не удалось отправить письмо с кодом. Повторите попытку позже. | A:393 | identical | Identical. |
| `reg.username_taken` | Этот логин уже занят. Выберите другой. | A:387 | :105 | Identical. |
| `reg.email_taken` | На этот адрес почты уже подана заявка или есть учётная запись. | «…или есть аккаунт.» A:388 | identical :106 | «учётная запись» per §1. |
| `reg.conflict` | Такой логин или адрес почты уже зарегистрирован. | A:389 | identical | Identical. |
| `reg.invalid_input` | Проверьте введённые данные. | A:386 | identical | Identical; the server's own 400 text is shown when present. |
| `reg.wrong_code` | Неверный код. Проверьте письмо и попробуйте ещё раз. | A:390, no period | identical, period added in code | Identical; the period is part of the text. |
| `reg.attempts_left` | {text} Осталось попыток: {count}. | A:391 | :142 | Identical. |
| `reg.code_expired` | Код больше не действует: срок истёк, он уже использован или попытки закончились. Запросите новый код. | «Код недействителен: …» A:392 | identical | **New first words.** «больше не действует» is plainer than «недействителен»; the rest is identical. |
| `reg.code_expired_local` (client timer) | Срок действия кода истёк. Запросите новый код. | A:360 | iOS uses `reg.code_expired` | **Android.** It is the exact reason the client knows. |
| `reg.offline` | Нет связи с сервером. Проверьте подключение к интернету. | A:383 | :127 | Identical. |
| `reg.unavailable` | Не удалось выполнить действие. Повторите попытку позже. | A:397 | identical | Identical. |
| `reg.storage` | Защищённое хранилище устройства недоступно. Разблокируйте устройство и повторите попытку. | A:396 | — (generic; the login screen says «Не удалось надёжно сохранить данные сессии на этом устройстве.» `LoginFormModel.swift:92`) | **Android.** It tells the user what to do. iOS needs the case. |
| `reg.pending.title` (after verify 202) | Заявка на рассмотрении | A:375 | «Заявка отправлена» `I/Features/Auth/RegistrationFlowView.swift:69`, headline «Заявка отправлена на рассмотрение администратору» :352 | **Android.** It is the state the user is in now, and it matches the server's `ACCOUNT_PENDING`. |
| `reg.pending.body` | Почта подтверждена. Вход станет доступен после одобрения заявки администратором. Срок рассмотрения заранее неизвестен. | A:376 | `RegistrationFlowView.swift:358`, identical | Identical. |

## 6. Login: `ACCOUNT_PENDING` and `ACCOUNT_REJECTED`

The server answers 403 with `code` and short texts: «Заявка на рассмотрении» / «Заявка отклонена» (`S/api/index.js:587-591`).

| Key | Canonical text | Android | iOS | Desktop | Choice and why |
|---|---|---|---|---|---|
| `login.pending.title` | Заявка на рассмотрении | A:375 (status screen) | — (text in the error box) | server text «Заявка на рассмотрении» via `describeFailure` `D/components/LoginView.jsx:48-49` | **Server and Android**. |
| `login.pending.body` | Заявка на регистрацию ещё рассматривается администратором. Вход откроется после одобрения. | A:377 | `I/Features/Auth/LoginFormModel.swift:86` | — | Identical on mobile. Desktop should branch on `code` and show this too. |
| `login.rejected.title` | Заявка отклонена | A:378 | — | server text | **Server and Android**. |
| `login.rejected.body` | Заявка на регистрацию отклонена администратором. Обратитесь к администратору вашей компании. | A:379 | `LoginFormModel.swift:88` | — | Identical on mobile; desktop should use it as well. |
| `login.busy` | Сервер сейчас занят. Повторите через {wait}. | A:79 | «Сервер обрабатывает много входов. Повторите через …» `LoginFormModel.swift:84` | «Сервер занят, повторяю вход… (попытка N)» `D/components/LoginView.jsx:188` (automatic retry) | **Android.** Desktop's automatic-retry note can stay as a separate key, `login.busy_retrying`: «Сервер занят. Повторяем вход…». |
| `login.invalid` | Неверный логин или пароль | A:76 | `LoginFormModel.swift:78` | server text | Identical. |
| `login.offline` | Нет связи с сервером. Проверьте подключение к интернету. | A:81 | :90 | «Нет связи с сервером — проверьте сеть и повторите» `D/components/LoginView.jsx:215,279` | **Mobile.** |

## 7. Connection banners

| Key | Canonical text | Android | iOS | Desktop | Choice and why |
|---|---|---|---|---|---|
| `conn.offline` (the device has no network) | Нет сети | A:24 | I10 `UI/DesignSystem/Components/ConnectionBanner.swift:82` (not on this branch) | «Нет связи с сервером» status pill `D/App.jsx:2663` | **Mobile.** Use it only when the OS reports no network. |
| `conn.reconnecting` (network present, socket down) | Переподключение… | A:25 | I10 `ConnectionBanner.swift:83` | — (the same pill says «Нет связи с сервером») | **Mobile.** Desktop should say this while it retries; «Нет связи с сервером» is for a final state only. |
| `conn.back_online` | Снова в сети | A:26 | I10 (`ConnectionBanner`, 1.2 s) | — | **Mobile**. |
| `conn.online` (desktop pill only) | Подключено | — | — | `D/App.jsx:2663` | Keep on desktop. |
| `conn.refused` | Сервер временно не принимает подключения. Повторяем… | «…не принимает подключение. Повторяем…» A:27 | — | — | **Android**, plural «подключения». iOS should add it. |
| `conn.signed_out` | Сеанс завершён. Войдите снова. | «Сессия завершена. Войдите снова.» A:28 | — | — | **New word** «сеанс», the Russian term already used in server texts. |

## 8. Attachments

Server texts: `S/api/index.js:2160-2194` and `S/services/file-policy.service.js:176,264,267`. Mobile pre-checks: Android `AK/features/attachments/UploadRules.kt:16-36`, iOS `I/Features/Attachments/AttachmentRules.swift:23-24,53-59`. Desktop: `D/lib/attachments.mjs:21`, `D/lib/file-policy.mjs:64`, `D/App.jsx:1798-1800`.

| Key | Canonical text | Android | iOS | Desktop | Choice and why |
|---|---|---|---|---|---|
| `upload.too_big` | Файл больше 100 МБ — такой файл загрузить нельзя | `UploadRules.kt:17` | `AttachmentRules.swift:54` | «Больше 100 МБ — такой файл отправить нельзя» `attachments.mjs:21`; «Файл больше 100 МБ — такой файл отправить нельзя» `App.jsx:1798` | **Server and mobile** (server 413 text). |
| `upload.empty` | Файл пустой | `UploadRules.kt:16` | `AttachmentRules.swift:53` | — | Identical. |
| `upload.no_extension` | У файла нет расширения | `UploadRules.kt:20` | `:57` | «У файла нет расширения — такой файл сервер не примет» `file-policy.mjs:64` | **Server** (`file-policy.service.js:264`). |
| `upload.ext_not_allowed` | Файлы .{ext} к отправке не разрешены | `UploadRules.kt:22` | `:59` | server text | **Server** (`:267`). |
| `upload.name_invalid` | Имя файла содержит недопустимые символы | — (only after upload) | — | `file-policy.mjs:23-27` | **Server** (`:176`). Mobile should pre-check it too. |
| `upload.waiting_slot` (server 429 «Дождитесь окончания текущих загрузок») | Ждёт своей очереди на загрузку | the server text, shown as a failure | waits silently | server text, toast | **New status label.** After the Android fix (final review P1/P2) this is a wait, not an error. «Ждёт своей очереди» is plain Russian, not jargon. |
| `upload.quota` (429 with Retry-After) | the server text (limit in МБ per hour) | server text | waits, honouring Retry-After | server text | **Server**. It names the real limit. |
| `upload.disk_full` (507) | На сервере недостаточно свободного места. Обратитесь к администратору. | server text | waits | server text | **Server**. |
| `upload.refused` | Сервер не принял файл | `UploadRules.kt:36` | `AttachmentRules.swift:24` | `App.jsx:1798` | Identical. |
| `upload.no_network` | Нет связи с сервером — файл отправится, когда связь вернётся | «Нет связи с сервером» `UploadRules.kt:35` | same `:23` | «Нет связи с сервером» `App.jsx:1800` | **New on mobile.** It is true: both phones keep the file and retry. Desktop does not retry, so it keeps «Нет связи с сервером». |
| `upload.failed_badge` | Не загрузилось | A:148 | (badge in the upload strip) | — | **Android**. |
| `upload.cannot_prepare` | Не удалось подготовить файл к отправке | «Не удалось сохранить файл для отправки» `AK/features/chat/ChatViewModel.kt:62` | «Не удалось подготовить файл к отправке» `I/App/Stores/ChatStore.swift:279` | — | **iOS.** It describes the user's action, not the app's internals. |
| `download.no_network` | Нет связи с сервером — файл не скачан | `AK/features/attachments/AttachmentDownloader.kt:172` | `I/Features/Attachments/AttachmentDownloader.swift:34` | «Не удалось скачать файл» + «Нет связи с сервером» `D/components/ChatView.jsx:366` | **Mobile**. |
| `download.interrupted` | Связь прервалась. Нажмите ещё раз — загрузка продолжится. | «Связь прервалась — нажмите ещё раз, загрузка продолжится» `AttachmentDownloader.kt:173` | — | — | **Android**, split into two sentences. iOS also resumes with Range and should say so. |
| `download.forbidden` (403) | Нет доступа к файлу | `AttachmentDownloader.kt:165` | `AttachmentDownloader.swift:226` | «Нет доступа к этому файлу» `ChatView.jsx:353` | **Mobile**. |
| `download.not_found` (404) | Файл не найден | `:166` | `:227` | — | Identical. |
| `download.failed` (other) | Не удалось скачать файл | «Не удалось скачать файл (код N)» `:167` | same `:228` | «Не удалось скачать файл» `ChatView.jsx:353` | **Desktop.** An HTTP code means nothing to an employee; log it instead. |
| `open.no_app` (Android only) | Нет приложения, чтобы открыть этот файл | A:160 | — (Quick Look) | — | Keep on Android. |

## 9. How to adopt
1. Add `mobile/contracts/copy/ru.json` (key → canonical text, plurals as `{one,few,many}`).
2. Map each key to an Android `strings.xml` name, an iOS `Localizable.xcstrings` key and a desktop constant module.
3. Add tests that load the JSON and assert every mapped string is equal.
4. Server: add `REGISTRATION_DISABLED` and document it; give "mail not configured" a code (`EMAIL_NOT_CONFIGURED`) so clients stop branching on «503 without a code».
5. Behaviour changes these texts depend on (from `final-review-parity.md`):
   - iOS composer lock (P5) and the channel filter (P6);
   - Android upload waits (P1/P2);
   - always confirm sign-out (P13);
   - desktop: branch on `code` for pending/rejected and on BUSY.
