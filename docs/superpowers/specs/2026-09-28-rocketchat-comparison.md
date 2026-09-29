# Rocket.Chat Feature Inventory (research, Sept 2026)

Sources: https://github.com/RocketChat/Rocket.Chat , https://docs.rocket.chat , https://github.com/RocketChat/docs , https://github.com/RocketChat/Rocket.Chat.Electron

---

## 1. End-to-End Encryption (E2EE)

Primary sources:
- https://docs.rocket.chat/docs/end-to-end-encryption-specifications
- https://docs.rocket.chat/docs/configure-e2e-encryption
- https://docs.rocket.chat/docs/end-to-end-encryption-user-guide
- https://docs.rocket.chat/docs/end-to-end-encryption-faq
- https://github.com/RocketChat/docs/blob/main/use-rocket.chat/workspace-administration/settings/e2e-encryption.md
- Client source location: `apps/meteor/client/lib/e2ee/` (e.g. `apps/meteor/client/lib/e2ee/crypto/shared.ts`); server side under `apps/meteor/app/e2e/`

### 1.1 Cryptographic primitives / exact parameters

| Component | Algorithm | Parameters |
|---|---|---|
| Per-user identity key pair | RSA-OAEP | 2048-bit modulus, public exponent 65537, SHA-256 hash. Generated with `crypto.subtle.generateKey()`. |
| Master Key (wraps the private key) | AES-GCM | 256-bit key, derived via **PBKDF2 with 100,000 iterations** and a random salt from the user's E2E password / recovery phrase (Web Crypto `crypto.subtle.deriveKey`). |
| Room/Session Key | AES-GCM | 256-bit, generated with `crypto.generateKey({name:'AES-GCM', length:256}, ...)`, one per room. |

### 1.2 Key generation & first-login flow
- On first login, the client checks whether the user already has a key pair (`e2e.getUsersOfRoomWithoutKey`/`e2e.setUserPublicAndPrivateKeys` RPCs). If none exists, it generates a new RSA-OAEP key pair locally.
- The client automatically generates a **mnemonic recovery phrase** on first setup; this phrase (rather than only an arbitrary user password) is used to derive the 256-bit AES-GCM Master Key via PBKDF2.
- The private key is serialized, encrypted with the Master Key (AES-GCM), and uploaded to the server (`e2e.setUserPublicAndPrivateKeys`) — the server only ever stores the **encrypted** private key plus the plaintext public key.
- On a new device/browser, the encrypted private key is downloaded and decrypted client-side using the Master Key re-derived from the user's E2E password/recovery phrase; if the client has no key pair and can't decrypt, the user is prompted to enter their E2E password.

### 1.3 Room key distribution
- When a room is set to encrypted, a random AES-GCM 256-bit session key is generated.
- That session key is individually RSA-OAEP-encrypted with **each room member's public key** and stored as a `suggestedKey` field in each user's subscription document — this allows asynchronous distribution (members don't need to be online simultaneously to receive the key).
- Each member's client decrypts `suggestedKey` with its own RSA private key to recover the shared AES-GCM room key.

### 1.4 Key rotation / reset
- Rooms keep a bounded history of old keys: `oldRoomKeys` array, **capped at 10 entries**.
- On a key reset (e.g., admin/user resets E2E keys, or "Reset Room Key"), the server strips the `E2EKey` property from all room members' subscriptions and distributes a freshly generated session key; the previous key is pushed into `oldRoomKeys`.
- Decryption logic: each message carries a `keyID`; the client first tries the current session key, and if the `keyID` doesn't match, falls back to searching `oldRoomKeys`.
- Because `oldRoomKeys` is capped at 10, **after more than 10 resets, messages encrypted under keys older than the 10 most recent become permanently undecryptable** (irrecoverable).
- Users can also fully reset their personal E2E key pair, which invalidates their access to previously encrypted rooms until keys are redistributed (documented as risky — "beta" caveat; users are warned this can cause permanent data loss for that user).

### 1.5 Features that break / degrade under E2EE
- **Search**: encrypted messages do not appear in message search results (content is opaque server-side).
- **Message auditing / DLP**: server-side message auditor and Data Loss Prevention tooling cannot inspect encrypted content.
- **Bots / REST API / integrations**: cannot read encrypted message content unless the bot itself has been given room keys (not supported by default).
- **File uploads**: historically NOT covered by E2EE by default in the base spec — "file uploads remain unencrypted" per the admin settings doc (separate/enterprise E2E file-encryption capability exists on top — see §2).
- **Push notification previews**: message content generally excluded/redacted for encrypted rooms.
- Feature is explicitly flagged in docs as **beta** with these caveats called out, and admins are told to evaluate the tradeoffs before enabling for production.
- A dedicated PR title found during research — "feat: E2EE warnings on search and audit panel" (RocketChat/Rocket.Chat#32551) — confirms the product now proactively surfaces these limitations in the UI.

### 1.6 Admin configuration (Administration > Workspace > Settings > E2E Encryption)
- `Enabled` — master on/off switch; when true, users can create encrypted rooms / toggle encryption on DMs and private rooms.
- `Enable encryption for Direct Rooms by default`
- `Enable encryption for Private Rooms by default`
- Version 8.8.0 added a **"Force end-to-end encryption on private rooms"** setting (mandatory E2E, no opt-out per room).
- There is also a **"Post-Quantum resistant TLS"** configuration guide (`configure-rocket-chat-with-post-quantum-resistant-tls`), which is about transport-layer PQ-hybrid TLS, not the E2EE message layer itself.

### 1.7 Independent security research on Rocket.Chat E2EE
- Academic paper: "Gravity of the Situation: Security Analysis on Rocket.Chat E2EE" — https://eprint.iacr.org/2025/2300.pdf and companion site https://gravity-of-the-situation-rc.github.io/
- ETH Zürich master's thesis: "Breaking Cryptography in the Wild: Rocket.Chat" by Noah Schmid — https://ethz.ch/content/dam/ethz/special-interest/infk/inst-infsec/appliedcrypto/education/theses/masters-thesis_noah-schmid.pdf
  (Both indicate the E2EE implementation has drawn dedicated academic security scrutiny — worth a follow-up read if a deeper cryptographic critique is needed.)

---

## 2. Security Features

Primary sources: https://docs.rocket.chat/docs/security-overview , https://docs.rocket.chat/docs/secure-rocketchat , https://docs.rocket.chat/docs/security , https://docs.rocket.chat/docs/two-factor-authentication-configuration

### 2.1 Two-Factor Authentication (2FA/MFA)
- TOTP (authenticator app) and email-code based 2FA.
- Configured at Administration > Workspace > Settings > Accounts > Two Factor Authentication (admin-only configuration).
- Each one-time code is single-use.
- Developer reference: https://developer.rocket.chat/docs/two-factor-authentication

### 2.2 Password policy
- Configurable password policy plus **password history** (prevents reuse of recent passwords).
- (Exact numeric defaults — min length, complexity requirements — not confirmed from the fetched page; the policy page returned 404 during this research. Recommend checking Administration > Settings > Accounts > Password Policy directly in a live instance for exact numbers if needed.)

### 2.3 Brute-force / rate limiting
- **API rate limiter**: general rate limits on requests to prevent DoS and scraping (`docs/rate-limiter`).
- **Failed-login blocking**: admins can enable "Block failed login attempts by IP" and "by Username" independently (PR #17783 added per-user/per-IP blocking).
- Known limitation: blocking-by-username protection does not fully extend to LDAP-backed accounts (GitHub issue #18939).
- IP allowlisting supports both plain IPs and CIDR ranges (e.g., `172.36.5.1`, `172.36.0.0/16`), though community bug reports note inconsistent enforcement in some versions.

### 2.4 Session management & device management
- Configurable session lifetime / forced re-authentication.
- **Device Management**: admins/users can view connected devices/sessions, receive new-login alerts, and remotely revoke sessions.

### 2.5 Roles & permissions
- Role-based access control (RBAC) with granular permissions (`docs/roles-in-rocketchat`, `docs/permissions`).
- **Custom roles** (Enterprise/premium tier feature).
- **Attribute-Based Access Control (ABAC)** for policy-driven, attribute-level access decisions (`docs/attribute-based-access-control-abac`, `docs/configure-abac`) — more advanced than RBAC alone.
- Room-level access controls: private channels, read-only channels, broadcast channels.

### 2.6 Audit logging
- **Audit Logs** (`docs/audit-logs`) — general audit trail of admin/user actions.
- **Message Auditor** (`docs/message-auditor`) — lets admins search messages (including, per marketing copy, encrypted ones under certain configurations/keys available to the org) across the workspace for compliance/legal hold purposes.
- **Audit edits, deletions, and encrypted communications** (`docs/audit-edits-deletions-and-encrypted-communications`).
- **Audit Workspace Security Logs** (`docs/audit-workspace-security-logs`) — security-event-specific logging (logins, permission changes, etc.).

### 2.7 OTR (Off-the-Record) messaging
- Source: https://github.com/RocketChat/docs/blob/main/use-rocket.chat/user-guides/messages/off-the-record-otr-messaging-user-guide.md
- DM-only (one-on-one), **both parties must be online simultaneously** to start/use an OTR session.
- Messages exist only in browser session storage (non-persistent); nothing is stored server-side.
- Once the OTR session ends and session storage clears, messages are unrecoverable.
- Explicitly contrasted with E2EE in the docs: E2EE messages *are* persisted server-side (as ciphertext) and durable; OTR messages are not persisted at all — different threat models (OTR = deniability/no record; E2EE = confidentiality with durability).

### 2.8 Retention policy / message & file pruning
- Source: https://docs.rocket.chat/docs/retention-policy
- Location: Administration > Workspace > Settings > Retention Policy > Global Policies.
- Policy is split three ways: **Channels**, **Private Groups**, **Direct Messages** — each independently enabled/configured.
- Settings per type: enable/disable pruning, **Message Age** (value + unit: days/hours/minutes) after which messages auto-delete, **Thread Protection** toggle (exclude threads from pruning), option to delete only files vs. messages+files.
- Room-level override: individual rooms can set their own retention/prune policy overriding the global one (Room Info > Edit > Prune).
- Multiple GitHub issues note historical bugs (files not physically deleted from disk, only DB records removed, etc.) — worth flagging as an operational caveat, not just a documented feature.

### 2.9 Data export / GDPR
- `docs/gdpr` — GDPR compliance documentation.
- `docs/data-processing-agreement-gdpr` — DPA terms.
- `docs/user-data-download` — self-service **personal data export** for end users (right to portability).
- Admin-side account deletion / right-to-be-forgotten flows exist as part of the same compliance bundle.

### 2.10 File upload restrictions
- `docs/file-upload` — MIME-type allow/deny lists, max file size, per-role upload permissions.
- Optional **ClamAV malware scanning** integration for uploaded files.
- Optional **MinIO** (S3-compatible) storage backend (`docs/minio`) for enterprise file storage control.
- File uploads are **not covered by E2EE by default** (see §1.5); there is an "E2E file encryption" capability referenced in higher-tier security messaging but the base beta E2EE spec explicitly excludes files.

### 2.11 Content Security Policy / iframe restrictions
- Not independently confirmed via a dedicated fetched page in this pass; Rocket.Chat ships configurable CSP headers and an "Iframe Integration" admin setting (allows embedding Rocket.Chat in an iframe, or embedding external content via iframe messages) — flagged here as needing direct verification against a live admin panel (Administration > Settings > General > IFrame Integration) if exact header values are required.

### 2.12 SSO / identity
- LDAP / Active Directory
- SAML
- OAuth2 / OpenID Connect — described as using "modern OAuth flow" with **CSRF protection and PKCE**.
- CAS support also mentioned in the security overview.

### 2.13 Other security-relevant items surfaced
- **TLS in transit**; optional **post-quantum-resistant TLS** configuration guide.
- **FIPS 140-3** compliance messaging (cryptographic module compliance claim).
- **Data Loss Prevention (DLP) app** — blocks/flags sharing of sensitive info patterns (e.g., credit card numbers, PII regex).
- **CORS controls**.
- **Push notification content exclusion** mode — strips message body from push payloads for compliance (HIPAA-oriented use case).
- **Moderation queue / moderation console** (`docs/moderation`) — reported-message review workflow for moderators/admins.
- Banned/blocked words filtering, message edit/delete time-limit settings, and custom emoji moderation are standard Rocket.Chat admin settings (Administration > Settings > Message: "Allow Message Editing", "Block Message Editing After X minutes", "Allow Message Deleting", "Block Message Deleting After X minutes", "Blocked Words" / banned-word filter) — these exist in the product but were not independently re-verified against a fetched doc page in this pass; treat as high-confidence based on general product knowledge, flag for direct admin-panel confirmation if exact wording/limits matter.
- Read receipts: supported as an opt-in room/account setting ("Read Receipt") — standard feature, not deeply sourced in this pass.

---

## 3. General Messenger Features

Source: https://docs.rocket.chat (llms.txt index) and general product docs.

- **Threads** (`docs/threads`) — sub-conversations attached to a parent message.
- **Discussions** (`docs/discussions`) — spun-off sub-channels linked to a parent message/channel; **not supported over Matrix federation** (remain Rocket.Chat-local).
- **Reactions**, **@mentions**, **pinned messages**, **starred messages** — standard channel-action features.
- **Message search** — full-text search across (non-encrypted) message history.
- **Read receipts**, **typing indicators**, **user presence/status** (online/away/busy/offline), **custom status messages**.
- **Polls** — via built-in or marketplace apps.
- **Video conferencing** — built-in Jitsi-based calls plus integrations (e.g., BigBlueButton).
- **Omnichannel** (`docs/omnichannel`, `docs/omnichannel-admins-guide`) — unified customer-service inbox routing Live Chat (website widget), email, SMS, WhatsApp, and social channels into agent queues with routing/SLA rules.
- **Integrations / webhooks / bots** — incoming/outgoing webhooks, REST API, Apps Engine (marketplace apps), bot framework.
- **Slash commands** — built-in and app-defined.
- **Markdown / rich message formatting** — bold/italic/code blocks/quotes, etc.
- **File sharing** — drag-and-drop uploads, previews.
- **Voice messages** — inline audio recording/playback.
- **Per-room notification preferences** — mute, custom sound, mobile/desktop/email toggles per channel.
- **Do Not Disturb** status.
- **Teams** — a grouping construct above channels (Team = collection of channels with shared membership/admin).
- **Federation** — two generations:
  1. Legacy/basic Matrix-bridge-based federation (`docs/rocketchat-native-federation`, `matrix-bridge-configuration`) requiring an external Matrix homeserver bridge.
  2. **Native Federation** (introduced v7.11+, alpha as of research date) — Matrix protocol implemented directly inside Rocket.Chat, no external bridge/database needed. Supports federated messages, reactions, mentions, threads, edits, deletes across servers; **discussions are not federated**.
  - Rocket.Chat joined the Matrix ecosystem officially per Matrix.org's 2022 blog post "Welcoming Rocket.Chat to Matrix."
- **Mobile push notifications** (`docs/push`) — via Rocket.Chat's push gateway or self-hosted push relay.

---

## 4. Rocket.Chat.Electron Desktop App

Source: https://github.com/RocketChat/Rocket.Chat.Electron , plus GitHub issues (#907, #1856, #603, #523, #849, #168, #1670, #2666, #619) for config-file behavior.

Repo tagline as of this research: "The Secure CommsOS™ for mission-critical operations."

### 4.1 Update mechanism
- Built on **electron-builder**'s auto-update tooling (config files `dev-app-update.yml`, `alpha-app-update.yml`, `beta-app-update.yml` present in the repo for different release channels) — i.e., effectively electron-updater-style update manifests per channel.
- Update settings are user-visible/toggleable in the app's "About" dialog (checkbox for checking updates), and those choices persist to `update.json`.

### 4.2 `update.json` (per-user update state)
- Location: `%AppData%\Rocket.Chat\update.json` on Windows (user-scope).
- Example minimal content to lock updates off: `{ "canUpdate": false, "autoUpdate": false }`.
- This removes/disables the update-related options in the About dialog for that user profile.
- Multiple GitHub issues (#1856, #603) report this file becoming unrecognized or ignored across certain versions/install modes (MSI, all-users install) — i.e., known reliability caveats admins should test before relying on it at scale.

### 4.3 `overridden-settings.json` (enterprise/admin-controlled override)
- Location: same user-preferences folder — `%APPDATA%/Rocket.Chat/` for per-user installs, or the **installation folder** itself for an all-users (machine-wide) Windows install.
- Purpose: **every key present in this file overrides both the default settings and the end-user's own saved settings** — i.e., it's the admin lockdown mechanism, stronger than `update.json`.
- Confirmed/likely keys (from issues + repo conventions):
  - `"doCheckForUpdatesOnStartup": true|false` — whether the app auto-checks for updates on launch.
  - `"isUpdatingEnabled": true|false` — whether the user is permitted to update the app at all (the master kill-switch admins use to fully disable updates fleet-wide).
  - `"isAddNewServersEnabled": true|false` — lock the app to a fixed set of servers (prevents users adding arbitrary new workspaces) — used to build single-server enterprise deployments.
  - `"isTrayIconEnabled": true|false`
  - `"isMenuBarEnabled": true|false`
  - `"isMinimizeOnCloseEnabled": true|false`
  - `"isFlashFrameEnabled": true|false`
  - `"isInternalVideoChatWindowEnabled": true|false`
  - `"isNotificationQuickReplyEnabled": true|false`
- Note: GitHub issue #2666 ("overridden-settings.json does not work") and #619 ("Update Process deletes All-Users servers.json config") indicate real-world reliability issues admins have hit with these override mechanisms across versions — worth flagging if recommending this as a hard control.

### 4.4 Command-line / installer-level update control
- Windows installer supports silent install with update disabled at install time: `installer.exe /S /allusers /autoupdate=0`.
- A PR (#907) specifically titled "[NEW] Disable autoupdate on windows installer" indicates this was an explicit, deliberately added capability (not just incidental).

### 4.5 Other desktop app features
- **Multiple servers** — sidebar-based multi-workspace switching.
- **Tray icon** support with minimize-to-tray behavior.
- **Deep linking** (`rocketchat://` protocol handling — implied by "Add new servers" and server-management architecture; not independently re-verified this pass).
- **Screen sharing** — supported via the internal video chat window / WebRTC (Jitsi) integration; `isInternalVideoChatWindowEnabled` setting controls whether calls open in an embedded window vs. external browser.
- **Spell check** — standard Electron/Chromium spellcheck integration (native OS dictionaries); not independently re-verified this pass but consistent with Electron app conventions and prior product docs.
- **Notification quick reply** — reply to a message directly from the OS notification.
- Platform support (as documented): **Windows 10+, macOS 12+, Linux (Ubuntu 22.04+ baseline)**, across x64/ARM64/ia32.

---

## 5. Gaps / items flagged for direct verification

These items were referenced by product marketing/docs pages but not independently confirmed against a primary source page in this research pass — recommend a live-instance check (Administration panel) if exact wording/defaults are needed for a decision:

- Exact default password-policy numeric values (min length, character-class requirements) — the `docs/password-policy` URL 404'd.
- Exact CSP header configuration and default iframe-embedding restrictions.
- Exact default message edit/delete time-limit values and "Blocked Words" filter mechanics.
- Deep-link URL scheme details for the Electron app.
- Whether E2E file encryption is a base feature vs. Enterprise-only add-on (docs are inconsistent: base E2EE spec says files are unencrypted; marketing security pages imply broader "data protection" including files).
