# Google Play Data safety — answer worksheet

**Draft — owner/legal review required.** Candidate answers for `com.openmychat.mobile`; they are not a completed Play Console declaration. Reconcile with the signed artifact, merged manifest, SDK inventory, actual deployment, and Google Play's current form definitions before entry.

## Form-level answers to verify

| Question | Draft answer / owner action |
|---|---|
| Does the app collect or share user data? | **Yes, it collects/transmits data** to the CentyChat server for app functionality. Optional FCM may receive push tokens and numeric event IDs if configured. |
| Is data encrypted in transit? | The Android release app disallows cleartext traffic. Confirm the deployed server endpoint and every SDK/network path for the exact artifact before selecting “Yes.” |
| Can users request deletion? | **Yes, in app:** Profile → Delete account, password confirmation. Server de-identifies account; sent messages remain. Supply [PUBLIC ACCOUNT DELETION URL/CONTACT] if Play requires an external deletion resource. Do not state that all backups/logs are erased. |
| Is collection optional? | Account/sign-in and messaging data are required to use core functions; profile additions, attachments, reports, microphone/calls, notification permission, and push use depend on user action/owner configuration. Verify each Play category's optional/required field. |
| Is data shared with third parties? | **Owner decision pending.** The CentyChat server is the service backend. When FCM is enabled, Google processes device tokens and numeric push metadata. Owner/legal must classify this under Play's service-provider and sharing definitions, contracts, and actual configuration. Do not submit a blanket “No” without that review. |

## Data types and purposes

| Play category / type | Current evidence and proposed purpose | Handling / open question |
|---|---|---|
| Personal info: name, email address, phone number, user IDs | Account creation, profile/directory, authentication and access control. | Sent to CentyChat server; name/email/phone as supplied. Phone may be absent. Linked to account. |
| Personal info: other info | Job title, department, status, username and profile details. | Map to current Play categories and whether each field is required; server holds profile values. |
| Messages: in-app messages | Text, conversation/participant and read state for messaging/sync. | Sent to CentyChat server and recipients; copies/unsent messages cached locally. |
| Photos and videos; files and docs | User-selected attachments and profile photos for messaging/profile. | Uploaded to CentyChat server when chosen; local pending upload/download copies can exist. |
| Audio files / other audio | Live microphone frames for voice calls. | Relayed through CentyChat server during call. Confirm the current Play type and whether streaming frames count as collection; no recording/retention claim is made. |
| App activity: app interactions / other actions | Reports, blocks, read state and service/audit events. | Sent to CentyChat server for core functions/safety. Owner to verify exact Play mapping. |
| Device or other IDs | App device ID, session association and, only if configured, FCM token. | App sends identifiers to CentyChat server. FCM token and numeric event IDs can reach Google for delivery. |
| Approximate location from IP | Server sees IP on requests and logs some security events. | No device location permission is requested; owner/legal must determine whether Play's location category applies to server IP processing. Do not claim location is never processed. |

The observed purposes are **app functionality** and **security/fraud prevention** for applicable sign-in/audit data. No advertising or tracking purpose is evidenced by the examined app code. This is not proof about a future build or all infrastructure. Check SDK auto-collection and final Play definitions before marking any type as collected, shared, optional, ephemeral, or deletable.

## On-device versus provider data

Android keeps a protected session and a Room queue/cache of unsent and recent messages. The app's backup rules exclude the session and delivery database, but this does not establish a server backup/retention schedule. Firebase Messaging is a dependency; the Google Services plugin is applied only when the owner supplies ignored `app/google-services.json`. Server FCM credentials are absent from the repository. Remote push is conditional, not currently verified as operational.

Owner must provide [LEGAL ENTITY], [PRIVACY POLICY URL], [SUPPORT/DELETION URL], [HOSTING/COUNTRIES], [RETENTION SCHEDULE INCLUDING BACKUPS], and [FINAL SDK/THIRD-PARTY DATA INVENTORY].

Sources: [evidence.md](evidence.md).
