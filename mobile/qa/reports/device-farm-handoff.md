# Device-Farm and Physical-Device Handoff

**Status:** PENDING — this is a runbook for collecting evidence, not proof of
execution.

## Purpose and boundary

BrowserStack App Automate can provide remote real-device execution evidence
after a testable candidate has been uploaded. It does **not** replace:

- macOS/Xcode simulator build and test evidence for iOS;
- a signed, immutable candidate artifact;
- Apple App Review or Google Play approval;
- targeted hands-on checks that require a specific accessory, network or
  corporate environment unavailable in the device farm.

A recorded BrowserStack real-device session can satisfy the physical-device
evidence requirement for scenarios it actually executes. It must identify the
candidate and retain the evidence below.

## Handoff prerequisites

1. Build a testable iOS IPA and Android APK/AAB from the release-candidate
   commit. Do not upload debug artifacts as release evidence.
2. Record Git commit SHA, package/bundle identifier, version/build number,
   artifact SHA-256, signing class and build provenance for each artifact.
3. Provide BrowserStack App Automate credentials through CI secrets or an
   approved secret manager; never commit access keys, passwords, tokens or
   reviewer credentials.
4. Provide a non-production test server (or an approved isolated tenant),
   named test accounts for ordinary/admin/password-change states and a reset
   procedure for every scenario.
5. Confirm the provider accepted the uploaded artifact and record its artifact
   identifier. If an iOS signing/profile constraint prevents installation,
   mark the row `BLOCKED` and use an approved physical device instead.

## Minimum execution coverage

Select actual device models and OS versions available at run time, record them
verbatim, and cover at least:

| Platform | Required device evidence |
|---|---|
| iOS | A supported iPhone on the minimum supported iOS version and a current supported iPhone/iOS combination; permission grant/deny/revoke, Keychain persistence, background/foreground, offline/reconnect, notifications and microphone/audio-route behaviour. |
| Android | A supported Android device on the minimum supported API level and a current supported Android release; permission grant/deny/revoke, process recreation, edge-to-edge/IME layout, offline/reconnect, notifications and microphone/audio-route behaviour. |
| Both | Login/refresh/revocation, password-change block, direct/channel messaging, file policy/upload/download, presence/DND, wake cooldown and call signalling. Run relay/audio/jitter cases where the test environment can observe frame/log evidence. |

For Bluetooth, wired headset, background-audio, captive-network, enterprise
certificate, push-delivery or other hardware/infrastructure-dependent paths,
record whether BrowserStack covers the path. If it does not, execute on an
approved physical iOS/Android device and attach equivalent evidence.

## Required record for every run

| Field | Required value |
|---|---|
| Candidate | Git commit SHA, version/build and package/bundle ID |
| Artifact | Artifact filename, artifact SHA-256, signing class and provider upload ID |
| Environment | Server revision/tenant, test-account role and data reset reference |
| Device | Provider, physical iOS device or Android device model, OS and locale/time zone |
| Automation | Capability/configuration record, framework/test-suite revision and session URL |
| Scenario | Scenario ID from `e2e-matrix.md`, steps/fixture and expected result |
| Result | result: PASS, FAIL, or BLOCKED |
| Evidence | Session URL, screenshots/video, device logs, network logs and crash report when applicable |
| Owner | Tester, execution timestamp, issue link for a failure and retest reference |

## BrowserStack App Automate session procedure

1. Upload only the candidate whose artifact SHA-256 has been recorded.
2. Start the session with the device/OS configuration recorded in the run
   result; retain the returned session URL.
3. Execute the assigned scenario IDs against the declared test tenant. Capture
   device logs, screenshots/video and any network or crash artifacts offered by
   the service.
4. Compare observed results with the contract and record `PASS`, `FAIL`, or
   `BLOCKED` for each platform independently. Link failures to issues; do not
   erase the failed session.
5. Repeat changed or failed cases on the corrected candidate and link both
   original and retest sessions.
6. Attach the final records to `parity-audit-report.md`,
   `store-readiness-report.md` and `release-signoff.md` before asking for a
   release decision.
