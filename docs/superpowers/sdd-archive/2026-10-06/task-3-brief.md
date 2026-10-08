### Task 3: Android — self-registration, pending state, account deletion, report and block

Worktree `m-android`. Parity with iOS (reference: `mobile/ios/CentyChat/Features/Auth/*Registration*`, `AccountFailure.swift`, `Features/Profile/AccountSafetyViews.swift`, `Core/Repositories/AccountRepository.swift`) and contract `mobile/contracts/registration.md` (all sections).
- Login screen: «Зарегистрироваться» → form (full name, e-mail, login, password with the same validation rules as iOS `Core/Utils/ValidationRules.swift`) → `POST /api/auth/register/request` → code entry (resend with the server's cooldown, `Retry-After`) → `/verify` → either signed in or «Заявка на рассмотрении» screen; `ACCOUNT_PENDING` / `ACCOUNT_REJECTED` on login show the matching screens; `EMAIL_NOT_CONFIGURED`/503 → «Отправка почты не настроена».
- Profile: «Удалить аккаунт» (password confirmation, irreversible warning, `DELETE /api/users/me`, then local sign-out wiping Keystore session, caches and the people cache); «Заблокированные пользователи» list with unblock.
- Person card and chat: «Пожаловаться» (user or message, reason) and «Заблокировать» / «Разблокировать»; a direct chat with a blocked user shows the server's `DM_NOT_ALLOWED` as a Russian banner and disables the composer.
- Error mapping is a pure function with unit tests (same codes as iOS `AccountFailure`).
Acceptance: unit tests (view models, error mapping, validation), Compose UI tests for the registration flow with a fake repository; `testDebugUnitTest lint assembleDebug` green; emulator screenshots (light, dark, font 2.0) of the registration form, code entry, pending, delete-account and report sheet against the dev stand.

