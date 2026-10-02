# CentyChat Android

Kotlin, Jetpack Compose, Material 3. minSdk 26, compileSdk/targetSdk 36.

Toolchain: Gradle 9.8.0, AGP 9.4.1 (built-in Kotlin, so no `kotlin-android` plugin), Kotlin 2.4.20,
Compose BOM 2026.06.01. Newer Compose BOMs (2026.08.00+), lifecycle 2.11 and core 1.19 require
compileSdk 37, so they stay pinned until the project moves past compileSdk 36.

## Windows verification

Requirements: JDK 17 (for example `C:\tmp\jdk17\jdk-17.0.20.1+1`), Android SDK with
`local.properties` containing `sdk.dir=C\:/Users/<you>/AppData/Local/Android/Sdk` (git-ignored; lint
rejects an unescaped drive-letter colon).

```bash
cd mobile/android
JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home \
  ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache testDebugUnitTest lint assembleDebug
```

`--project-cache-dir` and `GRADLE_USER_HOME` must be ASCII paths: the repository path may contain
Cyrillic characters. For the same reason `app/build.gradle.kts` redirects build output to
`%TEMP%\centychat-android-build\CentyChat-<checkout-hash>\app` when the project path is not ASCII
(the hash keeps parallel worktrees from sharing and locking each other's intermediates), and
`gradle.properties` sets `android.overridePathCheck=true`. The debug APK is then at
`%TEMP%\centychat-android-build\CentyChat-<checkout-hash>\app\outputs\apk\debug\app-debug.apk`.

## Install on the emulator

```bash
ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
"$ADB" devices   # expect emulator-5554 (Pixel_8)
"$ADB" -s emulator-5554 install -r "$(ls -d "$LOCALAPPDATA"/Temp/centychat-android-build/CentyChat-*/app/outputs/apk/debug/app-debug.apk | head -1)"
"$ADB" -s emulator-5554 shell am start -n com.openmychat.mobile/.MainActivity
mkdir -p build-evidence && "$ADB" -s emulator-5554 exec-out screencap -p > build-evidence/screen.png
```

## Server

The server is fixed at build time; the app has no server field and no runtime override.

- **Release:** always `https://centychat-production.up.railway.app` (`BuildConfig.SERVER_URL`, and
  `ServerConfig` ignores the build value outside debug as a second guard). HTTPS/WSS only, system
  trust only, no network security config.
- **Debug:** the local HTTPS dev stand `https://10.0.2.2:8443` by default, never production, so
  connected tests and stray debug installs cannot send dev credentials to the real server.
  `-Pcentychat.serverUrl=https://host[:port]` overrides it (pass the production URL explicitly to
  point a debug build there). Stored credentials
  issued by a different server are wiped on start, so switching a debug build between servers
  signs you out instead of sending a token to the wrong host.

### Local HTTPS dev stand (debug only)

```bash
(cd server && npm ci)
SERVER_PORT=2014 node mobile/dev/stand.mjs     # 2004 may be taken by a local server; see mobile/dev/README.md
cd mobile/android
JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home   ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache assembleDebug   # the stand is the debug default
```

The stand creates its CA at `mobile/dev/certs/dev-ca.crt` (git-ignored). When that file exists,
the debug build's `generateDebugDevCaResources` task copies it into a generated resource overlay
(`raw/centychat_dev_ca`) together with a copy of `src/debug/res/xml/debug_network_security_config.xml`
that adds it as a trust anchor for the local hosts only. Nothing is copied into `src/`, and
release builds never see it. Without the file the checked-in debug config applies. Sign in as
`alice` / `Alice-Dev-Stand-5271` (see `mobile/dev/README.md`).

Debug builds also allow cleartext HTTP to local hosts, but bearer tokens are only ever sent over HTTPS.
Screenshots go to `build-evidence/` (git-ignored).
