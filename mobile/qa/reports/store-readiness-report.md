# CentyChat Mobile Store-Readiness Ledger

**Assessment date:** 2026-10-01
**Purpose:** capture missing publication evidence; this is not a store approval
or policy-compliance statement.

| Store | Current status | Why no release decision can be made |
|---|---|---|
| Apple App Store | NOT READY | A macOS/Xcode test/build record, signed candidate, physical iOS evidence, App Store Connect metadata and reviewer-access evidence are missing. |
| Google Play Store | NOT READY | Signed candidate, Play Console data-safety declaration, internal-track result and physical-device evidence are not attached. |

## Validation status by platform

| Validation activity | Status | Required evidence before reassessment |
|---|---|---|
| macOS/Xcode simulator validation | macOS/Xcode simulator validation: PENDING | `xcodebuild` command, selected Xcode version, simulator destination, commit SHA, `.xcresult` and exit code from a macOS runner. |
| iOS physical-device validation | iOS physical-device validation: PENDING | Candidate IPA/build identifier, device model/OS, permission and lifecycle scenario results, logs/video and tester/date. |
| Android physical-device validation | PENDING | Candidate APK/AAB SHA-256, device model/OS, permissions, edge-to-edge, lifecycle and network-loss evidence. |
| BrowserStack App Automate handoff | PENDING | Upload/session URLs, accepted artifact identifier, chosen device/OS, capability record and scenario results. |

## Apple submission gate

Before an App Store submission, attach all of the following to the candidate:

- macOS CI evidence for a clean simulator test and a release configuration
  build without code signing for the simulator;
- a signed distribution candidate whose bundle identifier, version and
  SHA-256 match the record under test;
- a review of `PrivacyInfo.xcprivacy`, permission usage descriptions and the
  matching App Store Connect privacy answers against the shipped binary;
- a complete App Review Information record, including a working reviewer test
  account, server availability instructions and any hardware prerequisites;
- physical-device evidence for microphone, camera/photo access, notifications,
  background/foreground transitions, network loss/recovery and audio routes
  used by the product.

## Google Play submission gate

Before a Play production rollout, attach all of the following:

- a signed Android App Bundle/APK candidate with package name, version code,
  SHA-256 and signing provenance;
- the matching Play Console Data safety form, content rating, privacy-policy
  URL, testing-track record and account/access instructions;
- results from a current Android physical device for dangerous-permission
  grant/deny/revoke flows, edge-to-edge/IME layouts, process recreation,
  network loss/recovery and audio behaviour;
- evidence that the uploaded artifact is the same SHA-256 artifact tested in
  the runtime records.

## Reassessment rule

Only release management may change a store from `NOT READY` after the exact
evidence required here, in `release-signoff.md` and in
`device-farm-handoff.md` is linked. Store acceptance remains an external
decision and must never be represented as already granted by this repository.
