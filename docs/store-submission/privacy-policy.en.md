# CentyChat Privacy Policy (draft)

**Draft — owner/legal review required.** Do not publish until the owner and legal reviewer check this text and replace the bracketed fields.

**Controller:** [FULL LEGAL ENTITY NAME]. **Address:** [CONTROLLER ADDRESS]. **Data contact:** [EMAIL OR URL]. **Effective date:** [DATE]. **App version and environment:** [VERSION/CORPORATE ENVIRONMENT].

## Scope

CentyChat is a corporate messenger for an organization's employees. This policy covers the Android and iOS apps and their exchanges with the CentyChat server. [ORGANIZATION/OWNER] sets access, employee roles, and usage rules. The owner's present distribution choice is corporate distribution. Possible later store publication needs separate preparation and does not mean the app is already available in the App Store or Google Play.

## Data handled

- **Account and profile:** username, name, corporate email address, and phone number, job title, department, profile photo, and status where supplied or added by the organization. A password is used to sign in and confirm account deletion; the server keeps password verification data rather than the plain password.
- **Conversations and files:** messages, conversation and participant details, read state, attachments, photos and videos selected by the user, and reports submitted in the app. These are sent to the CentyChat server for delivery and synchronization among authorized participants.
- **Service and security:** user and device identifiers, session tokens, IP addresses on requests/sign-in, and sign-in/action events needed to operate the service and control access. The app sends a device identifier to the server for device binding and synchronization.
- **Calls:** with microphone permission, the app sends audio frames during a voice call through the CentyChat server to the other participant. [OWNER TO CONFIRM CALL STORAGE/RECORDING RULES IN ITS ENVIRONMENT].

The app requests microphone access for calls and notification permission. Users choose files/photos for attachments using system pickers; iOS asks for permission to add to the photo library when saving selected media. The current manifests do not request camera access.

## Data kept on the device

The apps keep session and remembered sign-in data, a local queue of unsent messages and files, and conversation/download caches. Android uses protected storage for the session and Room for the queue/cache; iOS uses Keychain and SwiftData. This supports intermittent connectivity and viewing history. Signing out or deleting an account initiates a wipe of current-session data on the device. System backups and effective file removal on every device need separate owner verification; no universal deletion time is promised here.

## Optional push notifications

If the owner configures Firebase Cloud Messaging (Android) or Apple Push Notification service (iOS), the app sends a device token to the CentyChat server. The server may send the push provider that token, the time and type of event, and numeric conversation/message/participant identifiers. Push payloads do not contain message text, names, or attachments; the app fetches those from the CentyChat server. Providers may process delivery metadata under their own terms. FCM/APNs credentials are not configured in this repository. Availability in a particular deployment depends on owner setup, app signing, and user permission. iOS push calls while the app is closed are not yet implemented.

## Purposes and recipients

Data supports accounts and access control, messages, attachments, calls, synchronization, notifications, and reports. Relevant conversation participants and authorized organization administrators can access data as provided by the service. CentyChat server hosting and infrastructure: [PROVIDER/LOCATION/COUNTRIES — CONFIRM]. Push provider transfer is possible only if the optional function is enabled. Other recipients and legal bases: [OWNER/LEGAL REVIEW REQUIRED].

## Retention and deletion

Retention periods for messages, attachments, accounts, logs, backups, and provider data: [RETENTION AND DELETION SCHEDULE — CONFIRM]. **Profile → Delete account** is available in the apps and requires a password. On a successful request, the server disables and de-identifies the user record and removes certain device bindings and push tokens; previously sent messages remain with the author shown as “Deleted employee.” This does not promise immediate removal of every copy, log, or backup. For further data requests contact: [EMAIL OR URL].

## Security and changes

The apps use a secure connection to the server and operating-system facilities for session secrets. Specific organizational safeguards, processing location, international transfer mechanism, and change notification process: [OWNER/LEGAL REVIEW REQUIRED].

Source evidence and open questions: [evidence.md](evidence.md).
