# Task 1 — Android reproducible release verification

## Delivered

- Generated and committed the Gradle Wrapper with Gradle 8.9 and JDK 17:
  `gradlew`, `gradlew.bat`, and `gradle/wrapper/gradle-wrapper.jar`.
- Kept the Wrapper distribution at Gradle 8.10.2 and verified it launches with
  JDK 17.0.20.1.
- Enabled release shrinking with `isMinifyEnabled = true`.
- Removed broad, unproven R8 keep/dontwarn rules for OkHttp and serialization.
  The application declares no reflection boundary that requires an app-level
  rule; both dependencies supply consumer rules.
- Added `ReleaseConfigurationTest`, which asserts that the generated debug
  `BuildConfig` exposes a distinguishable debug variant. This keeps the
  debug/release distinction explicit without adding a transport-policy
  exception; endpoint policy remains the responsibility of Task 4.

## TDD evidence

1. RED: before the Wrapper existed, ran:

   ```powershell
   cd mobile/android
   .\gradlew.bat testDebugUnitTest --tests '*ReleaseConfigurationTest'
   ```

   It failed as expected because `gradlew.bat` was not present.
2. Generated the Wrapper, added the minimal release configuration, and ran
   the targeted test through that Wrapper.

## Verification results

| Command | Result |
| --- | --- |
| `JAVA_HOME=C:\tmp\jdk17\jdk-17.0.20.1+1; .\gradlew.bat --version` | PASS — Gradle 8.10.2 on JDK 17.0.20.1 |
| `JAVA_HOME=C:\tmp\jdk17\jdk-17.0.20.1+1; .\gradlew.bat -Pandroid.overridePathCheck=true testDebugUnitTest --tests '*ReleaseConfigurationTest'` | BLOCKED — Android SDK location is not configured or installed |
| `testDebugUnitTest lint assembleDebug assembleRelease` | Not run — blocked by the same missing Android SDK |

The temporary `-Pandroid.overridePathCheck=true` is only for this Windows
worktree path, which contains non-ASCII characters. It was not committed and
is unnecessary for a normal ASCII CI checkout.

## Blocker

Gradle reports:

```
SDK location not found. Define a valid SDK location with an ANDROID_HOME
environment variable or by setting sdk.dir in mobile/android/local.properties.
```

The standard local paths checked were absent:

- `C:\Users\user\AppData\Local\Android\Sdk`
- `C:\Android\Sdk`
- `C:\Users\user\Android\Sdk`

Once Android SDK Platform 35 is available, rerun the canonical command with
JDK 17 (and the local path override only when using this non-ASCII worktree):

```powershell
.\gradlew.bat testDebugUnitTest lint assembleDebug assembleRelease
```
