# Task 2 report: Android baseline green on Windows

Status: DONE. Full command (testDebugUnitTest lint assembleDebug) BUILD SUCCESSFUL; 63 unit tests, 0 failures.

## Findings / changes
- ServerEndpointPolicy had NO Russian message (all English), so the test could not be copied verbatim. TDD: added
  invalidServerUrlUsesTheRussianOnboardingMessage expecting "Введите корректный адрес сервера" (RED: ComparisonFailure), then localized all
  5 validation messages in ServerEndpointPolicy.kt to Russian (GREEN). No other code/tests referenced the English strings.
- Windows blockers fixed: (1) AGP path check rejects Cyrillic path -> android.overridePathCheck=true in gradle.properties;
  (2) JDK is at C:/tmp/jdk17/jdk-17.0.20.1+1 (nested; JAVA_HOME=/c/tmp/jdk17 is invalid); (3) test JVM ClassNotFoundException for all tests
  when build dir has Cyrillic -> app/build.gradle.kts redirects buildDirectory to %TEMP%/centychat-android-build/CentyChat/app when the path is non-ASCII.
  UTF-8 was already set (-Dfile.encoding=UTF-8); Cyrillic test passes, so compile reads UTF-8 fine.
- Added .gitignore (build-evidence/, local.properties), local.properties (sdk.dir), README.md with exact commands.
- Pre-existing warning: ReleaseConfigurationTest.kt:37 Java type mismatch (non-fatal).

## Emulator smoke (emulator-5554)
APK installed (Success) and launched. Screenshots in mobile/android/build-evidence/ (git-ignored, in worktree m-android):
- 02-login.png: launch screen (a server was already stored) "Вход в CentyChat", brand-purple title "Корпоративный мессенджер", login and password fields, disabled "Войти", link "Сменить адрес сервера".
- 01-server-setup.png: after tapping the link: "Подключение к серверу", URL field prefilled http://10.0.2.2:2004/api, "Подключиться" button.
Not exercised: actual login against a server.

## Commits
1. build(android): make Windows builds work with non-ASCII project path
2. fix(android): show endpoint validation errors in Russian

## Concerns
- Build output lives in %TEMP% for Cyrillic paths (documented in README); gradle.properties override is global but harmless.
- Edge-to-edge/status bar looks fine; the login screen is vertically centered with lots of empty space (design task).
