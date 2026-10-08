# App Review Notes (English draft)

**Draft — owner/legal review required.** This is a template for a possible future submission, not a statement that an Apple Developer account, App Store Connect record, review account, or published app currently exists.

## Access for review

- App: CentyChat, bundle ID `kz.centras.centychat`; build/version: [EXACT SUBMITTED BUILD].
- Distribution proposal: [APPLE BUSINESS MANAGER CUSTOM APP / TESTFLIGHT / OTHER OWNER-APPROVED CHANNEL]. The owner has chosen corporate distribution and does not yet have an Apple Developer account. Final channel and reviewer access must be confirmed when an account exists.
- Review server: [REVIEW SERVER URL], available during [TIME WINDOW/TIME ZONE]. This must be a reviewer-accessible non-production environment with representative test data.
- Test username: [REVIEW ACCOUNT USERNAME]; password: [PROVIDE SECURELY IN APP STORE CONNECT REVIEW INFORMATION]; test organization/role: [ROLE]. Provide a second account [SECOND REVIEW ACCOUNT] if reviewing direct messaging and calls. Do not place credentials in this repository.
- Network, VPN, allowlist, or device requirements: [EXPLICIT INSTRUCTIONS OR “NONE” AFTER VERIFICATION]. Account registration/approval settings for this build: [CONFIRM].

## Suggested review path

Sign in, open the people directory, send a message between the supplied test accounts, select an attachment, and try a voice call with microphone permission. In Profile, review account details and **Delete account**. Deletion asks for the account password; use a disposable reviewer account, since the action disables/de-identifies it and previously sent messages remain as authored by “Deleted employee.” Supply a fresh account if review needs to continue after deletion.

Notification permission is requested after sign-in. Remote push depends on owner FCM/APNs credentials and iOS signing entitlement; these are not configured in the repository and must be checked against the exact submitted build. iOS calls to a closed app do not currently use PushKit/CallKit. If review build has no push configuration, reopen the app to synchronize new messages. Do not describe remote push as operational unless the owner has validated the candidate on a physical device.

The app uses microphone access for voice calls and photo-library add access when a user saves media. It does not request camera access in the current `Info.plist`. Its privacy manifest declares account/contact information, user identifiers, messages, audio, and photos/videos for app functionality; the final App Privacy form must be reconciled against the exact binary and SDK inventory.

## Before copying to App Store Connect

Replace every placeholder; verify the signed build, server accessibility, reviewer accounts, role permissions, support/privacy URLs, and actual push setup. The owner must confirm the legal entity, data retention, backups, hosting location, and App Privacy answers. No review credentials or production traffic belong in this document.

Sources: [evidence.md](evidence.md).
