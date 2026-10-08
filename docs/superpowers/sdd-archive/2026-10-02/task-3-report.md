# Task 3 report: local HTTPS/WSS dev stand

Status: DONE. Branch mobile/integration, one commit (feat(dev): local HTTPS/WSS dev stand ...).

## Built
- mobile/dev/tls-proxy.mjs: node:https + node:http + node:net upgrade piping, adds X-Forwarded-Proto/For/Host (client-supplied X-Forwarded-* dropped).
- mobile/dev/make-dev-ca.sh [outdir]: openssl root CA + leaf (SAN localhost, 127.0.0.1, 10.0.2.2), default 825-day validity (Apple limit), idempotent, FORCE=1.
- mobile/dev/seed.mjs: via REST API only. Idempotent. admin first-boot password replaced, users alice/bob created and must_change_password cleared, channel #mobile-dev, 3 direct msgs, 3 channel msgs (one type=file with uploaded dev-stand-notes.txt), 1 announcement.
- mobile/dev/stand.mjs: orchestrator (spawns server with HOST=127.0.0.1, DATA_DIR, TRUSTED_PROXY_IPS=loopback, waits for health, seeds, starts proxy). Exports startStand(); checks the server port is free.
- mobile/dev/README.md, dev.env (ports only), .gitattributes (sh = LF), root .gitignore: mobile/dev/certs/, mobile/dev/data/.
- server/src/config/index.js: additive optional DATA_DIR env override (default unchanged). Needed so the stand and the test use an isolated data dir instead of server/data.
- server/test/mobile-dev-stand.test.js (added to npm test script).

## Start
`cd server && npm install && cd .. && node mobile/dev/stand.mjs` (Git Bash and macOS identical; macOS CI snippet in README). Android: https://10.0.2.2:8443 ; iOS sim: https://localhost:8443.
Note: port 2004 was occupied by another process on this machine; set SERVER_PORT in dev.env (stand now fails fast with a clear message).

## Credentials (dev only)
alice / Alice-Dev-Stand-5271 ; bob / Bob-Dev-Stand-6384 ; admin / DevStand-Admin-7392 (first boot DevStand-Boot-4817).

## CA cert
Public: mobile/dev/certs/dev-ca.crt (generated on first start, git-ignored). Trust only in debug builds; README has Android debug network_security_config and iOS simctl keychain hints. mobile/android and mobile/ios untouched.

## Test cert decision
Committed TEST-ONLY throwaway fixture server/test/fixtures/mobile-dev-tls/ (made by the same script, 100-year validity, CA private key discarded, README.txt marks it test-only) so the test never needs openssl. Trade-off: a leaf private key is in the repo (secret scanners may flag; protects nothing, signed by a CA nobody trusts). Alternative would be generating at test time via openssl.

## Evidence
- RED: test run before implementation: 5/5 fail, ERR_MODULE_NOT_FOUND mobile/dev/stand.mjs.
- GREEN: 5/5 pass: HTTPS login as alice with only dev CA (HSTS header proves X-Forwarded-Proto), client without CA rejected, WSS auth_success, seed data present (channel, direct+channel msgs, file msg, announcement), re-seed is a no-op.
- Full `cd server && npm test`: 482 tests, 481 pass, 0 fail, 1 skipped (pre-existing), 237 s.
- Manual: CLI `node mobile/dev/stand.mjs` smoke: /api/health 200 over https://localhost:8443 and over 10.0.2.2:8443 (--resolve).

## Concerns
- Test startup takes ~9 s (spawns real server); before-hook timeout set to 90 s.
- Windows curl needs --ssl-no-revoke with a custom CA (documented).
- Android emulator reaching 10.0.2.2:8443 relies on the proxy binding 0.0.0.0 (it does); not exercised with a real emulator.

## Fix round 1: committed private key removed
- Deleted server/test/fixtures/mobile-dev-tls/ entirely. The test now runs mobile/dev/make-dev-ca.sh (DEV_CERT_DAYS=2) into an os.tmpdir() dir in before(), passes it as certDir to startStand, removes it in after(); all tests use `{ skip: !hasOpenssl }` (openssl and bash probes). README updated (the "test-only fixture" paragraph replaced). The earlier "Test cert decision" and certificate-fixture notes above are superseded.
- History rewritten by `git commit --amend`: c122f9c is now d28b0b6 (parent d031d6a). Old commit is unreachable (reflog only).
- Verification: `git log --all --oneline -- server/test/fixtures/mobile-dev-tls` returns nothing. `git grep -I "PRIVATE KEY" $(git rev-list d031d6a..HEAD)` only matches a regex string in the pre-existing .claude/skills/obsidian-second-brain/hooks/validate-ai-first.sh (not a key, not added by this branch; gitleaks private-key rule needs a full BEGIN..END block).
- Tests: mobile-dev-stand.test.js 5/5 pass (certs generated at test time); full npm test: 482 tests, 481 pass, 0 fail, 1 skipped.
