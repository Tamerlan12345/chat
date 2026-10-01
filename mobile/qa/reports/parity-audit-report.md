# CentyChat Mobile Feature-Parity Evidence Ledger

**Assessment date:** 2026-10-01
**Current parity status: UNVERIFIED**

Source inspection can identify implementation candidates, but it does not
prove behavioural equivalence. No end-to-end evidence on a macOS/iOS runtime
is attached to this report, therefore no cross-platform completion percentage
or release conclusion is valid.

| Runtime evidence gate | Status |
|---|---|
| Android automated verification linked to an immutable candidate | PENDING |
| Android physical-device validation | PENDING |
| iOS simulator validation | iOS simulator validation: PENDING |
| iOS physical-device validation | iOS physical-device validation: PENDING |
| Cross-platform run of the same scenario/data set | PENDING |

## Parity matrix to execute

Every item below requires the same server fixture, account roles and expected
contract on both platforms. Record each platform result independently as
`PASS`, `FAIL`, or `BLOCKED`; no inferred status is allowed.

| ID | Capability | iOS result | Android result | Evidence links |
|---|---|---|---|---|
| P-01 | Device knock and pairing states | UNVERIFIED | UNVERIFIED | — |
| P-02 | Device claim and device-secret persistence | UNVERIFIED | UNVERIFIED | — |
| P-03 | Login, refresh, expired/revoked session and secure-storage failure | UNVERIFIED | UNVERIFIED | — |
| P-04 | Mandatory password-change block | UNVERIFIED | UNVERIFIED | — |
| P-05 | Direct-message creation, receive and REST fallback | UNVERIFIED | UNVERIFIED | — |
| P-06 | Channel messages, unread counts and participant roles | UNVERIFIED | UNVERIFIED | — |
| P-07 | Message edit window boundaries | UNVERIFIED | UNVERIFIED | — |
| P-08 | Message delete permissions and window boundaries | UNVERIFIED | UNVERIFIED | — |
| P-09 | Typing indicator lifecycle | UNVERIFIED | UNVERIFIED | — |
| P-10 | Presence and Do Not Disturb | UNVERIFIED | UNVERIFIED | — |
| P-11 | Wake alert and cooldown | UNVERIFIED | UNVERIFIED | — |
| P-12 | Voice-call signalling states | UNVERIFIED | UNVERIFIED | — |
| P-13 | Audio relay frame encoding/decoding | UNVERIFIED | UNVERIFIED | — |
| P-14 | Silence suppression boundary | UNVERIFIED | UNVERIFIED | — |
| P-15 | Jitter-buffer overflow and recovery | UNVERIFIED | UNVERIFIED | — |
| P-16 | Announcements and acknowledgement | UNVERIFIED | UNVERIFIED | — |
| P-17 | Organisation directory and contact state | UNVERIFIED | UNVERIFIED | — |
| P-18 | File-policy filtering | UNVERIFIED | UNVERIFIED | — |
| P-19 | File upload, download and preview | UNVERIFIED | UNVERIFIED | — |
| P-20 | Offline queue/cache and reconnect | UNVERIFIED | UNVERIFIED | — |

## Acceptance rules

1. Use the concrete cases in
   [`../test-scenarios/e2e-matrix.md`](../test-scenarios/e2e-matrix.md), or
   attach a replacement case with equivalent inputs and expected outputs.
2. For every result, record candidate SHA, test server revision, device model,
   OS version, timestamp and an artifact such as a log, screenshot, video or
   BrowserStack session URL.
3. A `BLOCKED`, `FAIL`, missing row, changed contract, or unreviewed exception
   keeps the overall parity status `UNVERIFIED`.
4. iOS evidence must include the pending macOS simulator and physical-device
   gates; Android-only evidence cannot close cross-platform parity.
