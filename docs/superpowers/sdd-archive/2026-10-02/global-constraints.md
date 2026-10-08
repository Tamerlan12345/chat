### Global Constraints (binding for every task)

- Integration branch: `mobile-release-parity-impl`. Per-role worktrees (created by the controller):
  - iOS → `C:/Users/user/Documents/Нет в репо/chat/.claude/worktrees/m-ios` (branch `mobile/ios`), owns `mobile/ios/**`, `.github/workflows/mobile-ios.yml`.
  - Android → `.../worktrees/m-android` (branch `mobile/android`), owns `mobile/android/**`, `.github/workflows/mobile-android.yml`.
  - Integration → `.../worktrees/m-integration` (branch `mobile/integration`), owns `server/**`, `mobile/contracts/**`, `mobile/dev/**`.
  - QA → `.../worktrees/m-qa` (branch `mobile/qa`), owns `mobile/qa/**`.
  - Never edit paths you do not own. Never push except where a task says so.
- Release builds: HTTPS/WSS only; tokens fail closed; no plaintext secrets; Android backup exclusions stay intact. Debug-only exceptions must be build-config gated.
- `mobile/contracts/*` is the source of truth. Platform behaviour must match it; contract changes come from Integration only.
- Server changes are additive and backward compatible with `desktop/` (existing desktop/server tests must keep passing).
- UI: iOS = SwiftUI + HIG (semantic colours, Dynamic Type, 44pt targets, VoiceOver labels, `ContentUnavailableView`, String Catalog `ru`). Android = Compose + Material 3 (edge-to-edge, IME insets, 48dp targets, `stringResource`, semantics, DayNight). Brand tokens come from `desktop/src/renderer/src/styles/theme.css` (primary `#5b4ee6`/`#6457ee`, bg `#fcfcfd`/`#24242a`, online `#2da44e`, away `#d4951c`, dnd `#d9363b`, brand gradient `#ec8ee0→#c078ee→#7c44ea→#2a72ee→#00daff`).
- All user-facing copy in Russian.
- TDD: failing test first for every behaviour change; small logical commits with conventional messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verification commands:
  - Android (Windows, Cyrillic path workaround): `cd mobile/android && JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache testDebugUnitTest lint assembleDebug`. Emulator `Pixel_8` is running as `emulator-5554`; adb at `$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe`.
  - iOS: no local Xcode. Push branch `mobile/ios` to `origin` and watch `gh run list --branch mobile/ios --workflow mobile-ios` / `gh run watch <id> --exit-status`; read failures with `gh run view <id> --log-failed`. A task is not done until the run is green.
  - Server: `cd server && npm test`.

