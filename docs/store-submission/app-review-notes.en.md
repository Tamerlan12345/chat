# App Review Notes (English draft)

**Draft — owner/legal review required.** This is a template for a possible future submission, not a statement that an Apple Developer account, App Store Connect record, review account, or published app currently exists.

## Access for review

- App: CentyChat, bundle ID `kz.centras.centychat`; build/version: [EXACT SUBMITTED BUILD].
- Distribution proposal: [APPLE BUSINESS MANAGER CUSTOM APP / TESTFLIGHT / OTHER OWNER-APPROVED CHANNEL]. The owner has chosen corporate distribution and does not yet have an Apple Developer account. Final channel and reviewer access must be confirmed when an account exists.
- **Release-environment blocker:** the current iOS and Android Release builds are pinned at build time to the production CentyChat endpoint and have no Release server override. Do not submit these binaries for review or provide reviewer credentials until the owner has approved and produced a separate review build pointed at a non-production environment with representative test data. The review server URL and availability window remain [REVIEW SERVER URL] and [TIME WINDOW/TIME ZONE]; verify the submitted binary's actual endpoint before completing this template.
- Test username: [REVIEW ACCOUNT USERNAME]; password: [PROVIDE SECURELY IN APP STORE CONNECT REVIEW INFORMATION]; test organization/role: [ROLE]. Provide a second account [SECOND REVIEW ACCOUNT] if reviewing direct messaging and calls. Do not place credentials in this repository.
- Network, VPN, allowlist, or device requirements: [EXPLICIT INSTRUCTIONS OR “NONE” AFTER VERIFICATION]. Account registration/approval settings for this build: [CONFIRM].

## Suggested review path

Sign in, open the people directory, send a message between the supplied test accounts, select an attachment, and try a voice call with microphone permission. In Profile, review account details and **Delete account**. Deletion asks for the account password; use a disposable reviewer account, since the action disables/de-identifies it and previously sent messages remain as authored by “Deleted employee.” Supply a fresh account if review needs to continue after deletion.

Notification permission is requested after sign-in. Remote push depends on owner FCM/APNs credentials and iOS signing entitlement; these are not configured in the repository and must be checked against the exact submitted build. iOS calls to a closed app do not currently use PushKit/CallKit. If review build has no push configuration, reopen the app to synchronize new messages. Do not describe remote push as operational unless the owner has validated the candidate on a physical device.

The app uses microphone access for voice calls and photo-library add access when a user saves media. It does not request camera access in the current `Info.plist`. Its privacy manifest declares account/contact information, user identifiers, messages, audio, and photos/videos for app functionality; the final App Privacy form must be reconciled against the exact binary and SDK inventory.

## Before copying to App Store Connect

Do not use this template with the current production-pinned Release builds. First obtain owner approval for a dedicated non-production review configuration and build, then verify the signed binary's endpoint, server accessibility, reviewer accounts, role permissions, support/privacy URLs, and actual push setup. Replace every placeholder only after those checks. The owner must confirm the legal entity, data retention, backups, hosting location, and App Privacy answers. Do not put review credentials in this document or use production accounts/data for review.

Sources: [evidence.md](evidence.md).
