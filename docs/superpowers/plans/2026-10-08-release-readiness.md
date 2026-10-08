# Release readiness follow-up — 2026-10-08

Source: `docs/HANDOFF-2026-10-08.md`, section 5.3. The owner explicitly asked to resume and complete this work after the prior session had not started it.

## Global constraints

- Work only on `mobile-release-parity-impl`; never touch `master`, push, merge PR #3, or publish store materials.
- Do not access production services or send test traffic/credentials to production. Never use local server port 2004.
- No secrets, keystores, credentials, or private keys in the repository. Release signing configuration must fail closed when credentials are absent and document local/external secret setup.
- Store and privacy materials are drafts for owner/legal review and must describe only behavior verified in the current code.
- Preserve unrelated/untracked files, including `mobile/android/.idea/`.
- TDD for behavior changes; do not weaken tests.

## Task 1 — Android release signing scaffold

Add release signing configuration reading keystore values from environment variables or untracked `keystore.properties` outside version control. Version code/name must be supplied through build properties. No signing secret may be committed. Verify release configuration behavior and run the narrow Android verification available on this machine.

## Task 2 — Store submission draft package

Create drafts for RU/EN privacy policy, support page, English App Review notes, Google Play Data safety answers, and Apple App Privacy answers. Derive statements from actual Android/iOS/server code and existing policy/configuration. Mark each document clearly as a draft requiring owner/legal review; avoid claiming server-side practices not supported by repository evidence.

## Task 3 — Desktop localization and login layout checks

Make the desktop copy test load `mobile/contracts/copy/ru.json` directly (no duplicated local copy). Add a light/dark login-layout verification after the company label removal, following existing desktop test conventions. Run the focused tests and desktop suite/build as specified by the owning lane.

## Completion

Review each task diff before integrating its lane commit into this branch. Run applicable checks, then perform one review of the combined diff. Leave the branch unpushed and PR #3 unmerged.
