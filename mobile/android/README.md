# CentyChat Android

Kotlin, Jetpack Compose, Material 3. minSdk 26, targetSdk 35.

## Windows verification

Requirements: JDK 17 (for example `C:\tmp\jdk17\jdk-17.0.20.1+1`), Android SDK with
`local.properties` containing `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk` (git-ignored).

```bash
cd mobile/android
JAVA_HOME=/c/tmp/jdk17/jdk-17.0.20.1+1 GRADLE_USER_HOME=/c/tmp/gradle-user-home \
  ./gradlew.bat --project-cache-dir /c/tmp/m-android-project-cache testDebugUnitTest lint assembleDebug
```

`--project-cache-dir` and `GRADLE_USER_HOME` must be ASCII paths: the repository path may contain
Cyrillic characters. For the same reason `app/build.gradle.kts` redirects build output to
`%TEMP%\centychat-android-build\CentyChat\app` when the project path is not ASCII, and
`gradle.properties` sets `android.overridePathCheck=true`. The debug APK is then at
`%TEMP%\centychat-android-build\CentyChat\app\outputs\apk\debug\app-debug.apk`.

## Install on the emulator

```bash
ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
"$ADB" devices   # expect emulator-5554 (Pixel_8)
"$ADB" -s emulator-5554 install -r "$LOCALAPPDATA/Temp/centychat-android-build/CentyChat/app/outputs/apk/debug/app-debug.apk"
"$ADB" -s emulator-5554 shell am start -n com.openmychat.mobile/.MainActivity
mkdir -p build-evidence && "$ADB" -s emulator-5554 exec-out screencap -p > build-evidence/screen.png
```

Debug builds allow cleartext HTTP only to local hosts (`http://10.0.2.2:2004/api`); release is HTTPS/WSS only.
Screenshots go to `build-evidence/` (git-ignored).
