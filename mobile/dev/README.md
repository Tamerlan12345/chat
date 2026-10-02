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
