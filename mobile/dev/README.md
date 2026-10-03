# CentyChat mobile dev stand (HTTPS/WSS + seed data)

Release builds of the mobile apps refuse plain HTTP, and the server itself speaks
HTTP only. This stand puts a zero-dependency TLS proxy in front of a real server
and fills it with data, so the apps can log in during development and CI.

```
app --https/wss--> tls-proxy.mjs (0.0.0.0:8443) --http/ws + X-Forwarded-Proto: https--> server (127.0.0.1:2004)
```

## Start (one command)

Requirements: Node 22+, `openssl` (only for the first run, to create certificates), `npm install` in `server/`.

Windows Git Bash:

```bash
cd server && npm install && cd ..
node mobile/dev/stand.mjs
```

macOS CI runner (same command; keep it in the background, then wait for the port):

```bash
(cd server && npm ci)
node mobile/dev/stand.mjs > /tmp/centy-stand.log 2>&1 &
until curl -fsS --cacert mobile/dev/certs/dev-ca.crt https://localhost:8443/api/health >/dev/null; do sleep 1; done
```

First run creates `mobile/dev/certs/` (via `make-dev-ca.sh`) and `mobile/dev/data/`
(server data, seeded once); both are git-ignored. Delete `mobile/dev/data/` to reset.
On Windows, plain `curl` (schannel) needs `--ssl-no-revoke` with a custom CA. Ports come from `mobile/dev/dev.env` (`TLS_PORT=8443`, `SERVER_PORT=2004`) or the environment.

## Addresses

| Client | Base URL | WebSocket |
|---|---|---|
| Android emulator | `https://10.0.2.2:8443` | `wss://10.0.2.2:8443/ws` |
| iOS simulator (CI) | `https://localhost:8443` | `wss://localhost:8443/ws` |

The certificate SAN covers `localhost`, `127.0.0.1`, `10.0.2.2`.

## Seed credentials (DEV ONLY)

| User | Password |
|---|---|
| `alice` (Алиса Тестова) | `Alice-Dev-Stand-5271` |
| `bob` (Боб Тестов) | `Bob-Dev-Stand-6384` |
| `admin` (after seeding) | `DevStand-Admin-7392` (first boot: `DevStand-Boot-4817`) |

Both users can log in immediately (no forced password change). Seed content:
channel `#mobile-dev` (all users are members), 3 direct messages alice/bob,
3 channel messages including one `file` message with attachment
`dev-stand-notes.txt`, and one announcement from admin. Seeding goes through the
server's own REST API (`seed.mjs`) and is idempotent.

## Trusting the dev CA (debug builds only)

Public CA certificate: **`mobile/dev/certs/dev-ca.crt`** (PEM). Never trust it in
release builds; the private key `dev-ca.key` stays in the git-ignored `certs/` directory.

- Android: debug-only `network_security_config` (`src/debug/`) with `<trust-anchors><certificates src="@raw/dev_ca"/></trust-anchors>`, copying `dev-ca.crt` to a debug raw resource at build time.
- iOS: in the debug/UI-test configuration only, add the cert to the simulator trust store
  (`xcrun simctl keychain booted add-root-cert mobile/dev/certs/dev-ca.crt`) or pin it in a DEBUG `URLSessionDelegate`.

Regenerate: `FORCE=1 bash mobile/dev/make-dev-ca.sh` (default leaf validity is 825 days, the
limit Apple accepts for user-trusted CAs).

## Files

- `stand.mjs` - orchestrator (`startStand()` is also used by the test).
- `tls-proxy.mjs` - HTTPS + WSS reverse proxy, only `node:` built-ins.
- `seed.mjs` - dev data through the server API.
- `make-dev-ca.sh` - dev root CA + leaf certificate.
- `dev.env` - dev-only ports.

Test: `cd server && node --test test/mobile-dev-stand.test.js` (also part of `npm test`).
It generates a short-lived (2 day) CA into a temp dir with make-dev-ca.sh and is skipped when openssl/bash are unavailable. No key material is committed.

The server honours an optional `DATA_DIR` environment variable (added for this stand)
to place its databases and uploads outside `server/data`.

## Push notifications (server side, Task 18)

The server can wake the mobile apps through FCM (Android) and APNs/PushKit (iOS).
Only ids pass through Google/Apple (owner decision): `{type:"message", conversationType, targetId, messageId}`
or `{type:"call", callerId}` — never message text or names. The app fetches the content from our server.
Contract: `mobile/contracts/push.md`. Code: `server/src/push/`.

Push is **off** unless credentials are configured (one log line at startup: «Push-уведомления выключены»).
The dev stand and the fixture capture run with push off; token registration still works (`push_enabled: false`).
Credentials come only from the environment or a secret file — never commit them, never put them in this repo
(the `mobile/dev/` and `server/data/` trees are not a place for keys either).

### Owner setup: Android (Firebase)

1. https://console.firebase.google.com → create (or open) the project → add an Android app with the
   application id of the Android build (see `mobile/android/app/build.gradle.kts`, `applicationId`).
   Download `google-services.json` for the app build (that file is client config, not a server secret).
2. Project settings → **Service accounts** → **Generate new private key**. This JSON is the server secret.
3. Give it to the server, one of:
   - Railway: Variables → `PUSH_FCM_SERVICE_ACCOUNT_JSON` = the whole JSON;
   - Docker/VM: a secret file outside the repo, `PUSH_FCM_SERVICE_ACCOUNT_FILE=/run/secrets/firebase-service-account.json`.
4. Restart. The log says `Push-уведомления включены: FCM (Android, проект <project_id>)`.
   The Firebase Cloud Messaging API (V1) must be enabled for the project (it is by default for new projects).

### Owner setup: iOS (APNs + PushKit)

Needs a paid Apple Developer account.
1. developer.apple.com → Certificates, IDs & Profiles → **Identifiers** → the app's bundle id → enable
   **Push Notifications**. VoIP pushes use the same key; the topic is `<bundle id>.voip` (the app adds the
   PushKit/VoIP background mode and the Notification Service Extension — a platform task).
2. **Keys** → create a key with **Apple Push Notifications service (APNs)** → download `AuthKey_<KEYID>.p8`
   (downloadable once). Note the **Key ID** (10 chars) and the **Team ID** (Membership, 10 chars).
3. Server environment:
   - `PUSH_APNS_KEY_FILE=/run/secrets/AuthKey_<KEYID>.p8` (or `PUSH_APNS_KEY` = PEM text, `\n` allowed);
   - `PUSH_APNS_KEY_ID=<KEYID>`, `PUSH_APNS_TEAM_ID=<TEAMID>`, `PUSH_APNS_BUNDLE_ID=<bundle id>`.
4. Restart. The log says `… APNs (iOS, <bundle id>)`. One key serves both sandbox (Xcode builds) and
   production (TestFlight/App Store); each device token says which (`environment` at registration).

A configuration error disables only that provider and logs a warning that names the variable
(never its value). Limits: `PUSH_MAX_TOKENS_PER_USER` (10), `PUSH_CONCURRENCY` (8), `PUSH_QUEUE_MAX` (10000),
`PUSH_MAX_ATTEMPTS` (4) — see `.env.example`.

Local check without accounts: iOS simulator — `xcrun simctl push booted <bundle id> payload.apns`
with the `payload` object from `mobile/contracts/fixtures/push/apns.message.direct.json`;
Android — `push/fcm.message.direct.json` `message.data` through the FCM console test message (needs Firebase).

## Contract fixtures

`node mobile/dev/capture-fixtures.mjs --write` starts a throwaway server (empty data dir, random port, no TLS),
seeds it with the data above and replays a client scenario over HTTP and WebSocket, writing the real responses and
frames to `mobile/contracts/fixtures/`. `--check` compares against the committed files. The server test
`server/test/mobile-contract-fixtures.test.js` runs the same capture and fails on drift. See
`mobile/contracts/fixtures/README.md`.
