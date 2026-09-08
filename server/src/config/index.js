const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '../../');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'mychat.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const JWT_SECRET_PATH = path.join(DATA_DIR, '.jwt_secret');

// JWT_SECRET: use an operator-supplied env var if set, otherwise generate a
// random per-install secret once and persist it locally. Never fall back to a
// hardcoded shared value — a secret baked into source code can't protect
// anything. Rotating (deleting) the file invalidates every token issued
// before the rotation. See docs/designs/auth-access-control-remediation.md
// item 4.
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(JWT_SECRET_PATH)) {
    const existing = fs.readFileSync(JWT_SECRET_PATH, 'utf8').trim();
    if (existing) return existing;
  }

  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(JWT_SECRET_PATH, generated, { mode: 0o600 });
  return generated;
}

module.exports = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 2004,
  HOST: process.env.HOST || '0.0.0.0',
  JWT_SECRET: resolveJwtSecret(),
  ROOT_DIR,
  DATA_DIR,
  DB_PATH,
  UPLOADS_DIR,
  BACKUPS_DIR,
  // Automatic scheduled backups (in addition to the manual "Backup now"
  // button in the admin DB studio) — mychat.db is the only copy of the
  // company's data, so this is not optional in production.
  BACKUP_INTERVAL_HOURS: process.env.BACKUP_INTERVAL_HOURS ? parseFloat(process.env.BACKUP_INTERVAL_HOURS) : 24,
  BACKUP_RETENTION_COUNT: process.env.BACKUP_RETENTION_COUNT ? parseInt(process.env.BACKUP_RETENTION_COUNT, 10) : 14,

  // Network-level access control — set at deploy time (container env), not
  // through the admin panel. Deliberately outside the app's own
  // admin-changeable settings: a compromised admin account should not be
  // able to self-authorize a bypass of the network restriction. Empty =
  // disabled (open), which is the right default for a LAN-only deployment.
  // Comma-separated IPv4 addresses and/or CIDR ranges, e.g.
  // "87.255.197.10,192.168.10.0/24".
  ALLOWED_CLIENT_IPS: (process.env.ALLOWED_CLIENT_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Only needed once a reverse proxy (nginx/Caddy) sits in front for TLS —
  // the IP(s) of that proxy itself, so its X-Forwarded-For header is trusted
  // for the ALLOWED_CLIENT_IPS check above. Leave empty when the app is
  // reachable directly (current docker-compose.yml setup): X-Forwarded-For
  // is then never trusted, and only the raw TCP socket IP is used — a
  // request that isn't relayed by one of these exact proxy IPs cannot spoof
  // its way past the allowlist by forging this header itself.
  TRUSTED_PROXY_IPS: (process.env.TRUSTED_PROXY_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),

  SERVER_VERSION: '2026.1.0-pro'
};
