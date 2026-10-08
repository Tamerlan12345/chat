### Task 7: iOS — «Сотрудники» tab, person card, universal search

Worktree `m-ios`. Design brief section «People surface + universal search» (iOS variant: native `.searchable`, segmented Picker «Все | Отделы», inset grouped lists, `.navigationTransition(.zoom)`), Android Task 21 as behavioural reference (`mobile/android/app/src/main/java/com/openmychat/mobile/features/people`, `features/search`). Models/store already exist in `mobile/ios/CentyChat/Features/People/` (merged from `mobile/ios-ui`) — build the UI on them, add what is missing.
- 4 tabs (Чаты, Сотрудники, Объявления, Профиль) with state retained per tab.
- «Сотрудники»: A–Я sections, «Отделы» org tree, «В сети» filter and summary line, pull-to-refresh, cached list.
- Person card: avatar/status, «был(а) в сети», phone/email (`tel:`/`mailto:` safe), actions «Написать» (pushes the chat on the current stack), «Позвонить» (disabled with reason when not allowed / DND), «Побудка», «Пожаловаться», «Заблокировать».
- Universal search in «Чаты»: people / channels / messages, recents, jump to message with highlight.
Acceptance: XCTest for ranking/normalisation (already partly present — extend), UI test path tabs → search → card → «Написать» → back; screenshots light/dark/AX size published by CI; green CI.

