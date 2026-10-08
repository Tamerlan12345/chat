# Apple App Privacy — answer worksheet

**Draft — owner/legal review required.** Candidate App Store Connect entries for bundle `kz.centras.centychat`; reconcile the signed binary, `PrivacyInfo.xcprivacy`, extension/SDK manifests, and the deployed service before submission. The owner has no Apple Developer account yet and chose corporate distribution. These are preparation notes for any future Apple channel, not a submitted form.

## Form-level answers

- **Data collected:** Yes. The app sends account/profile information, messages and selected files to the CentyChat server; it relays live call audio through the server. Local Keychain/SwiftData data alone is described separately below.
- **Data linked to the user:** account/profile data, user ID, messages, attachments, and reports are account-related. The current privacy manifest marks its listed data types linked to the user and used for **App Functionality**.
- **Tracking:** The current privacy manifest says `NSPrivacyTracking = false` and has no tracking domains. Verify the exact shipped SDKs and Apple's definition before answering “No” in App Store Connect.
- **Third parties:** With APNs configured, Apple receives a device token and numeric push event IDs/timing; no message text, names, or attachments in push payloads. APNs credentials and signing entitlement are not configured in this repository. Hosting/subprocessors: [OWNER TO IDENTIFY].

## Proposed data type mapping

| Apple category / type | Use and destination | Review point |
|---|---|---|
| Contact Info: Name, Email Address, Phone Number | Account/profile and employee directory on CentyChat server. | Phone may be optional. Current manifest lists all three as linked, App Functionality. |
| Identifiers: User ID | Account/access and conversation identity on CentyChat server. | Listed in current manifest. |
| Identifiers: Device ID | App device binding, session association, optional APNs token registration on CentyChat server. | **Potential manifest/form gap:** device ID/push token is used in code but is not among the manifest's listed collected data types. Owner must decide Apple category and update release metadata/source if required. |
| User Content: Emails or Text Messages | Chat messages sent to CentyChat server and intended recipients. | Listed in current manifest. |
| User Content: Photos or Videos | User-selected attachment/profile media sent to server. | Listed in current manifest. |
| User Content: Other User Content | Other file attachments and user-entered reports. | Not separately listed in current manifest; confirm Apple category and form entry for actual release. |
| User Content: Audio Data | Live voice frames relayed through CentyChat server during calls. | Listed in current manifest. Confirm collection/retention characterization; do not imply recordings are stored or never stored. |
| Usage Data / Diagnostics | Sign-in/security events and IP handling exist server-side. | Owner must map any applicable Apple types after checking production logs, SDKs, and exact release build. |

For the listed data, **App Functionality** is supported. Sign-in/audit processing may also require an Apple purpose category after owner review. No advertising purpose is evidenced by the examined code.

## Device storage and deletion

iOS keeps session secrets/remembered login in Keychain and message outbox/cache/pending uploads in SwiftData. The delivery store is excluded from device backup in code. This does not establish server or provider retention. **Profile → Delete account** sends an authenticated, password-confirmed request; the server de-identifies the user and removes certain bindings/tokens, while prior messages remain attributed to “Deleted employee.” Enter [RETENTION/BACKUP SCHEDULE] and [PRIVACY/DELETION CONTACT URL] only after owner review.

Remote APNs messages require owner credentials and app entitlement. iOS closed-app calling via PushKit/CallKit is not implemented. Do not present push delivery as available for review until validated on the submitted physical-device build.

Sources: [evidence.md](evidence.md).
