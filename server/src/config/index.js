const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '../../');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'mychat.db');
// Учётные записи живут отдельно от переписки. Когда задан DATABASE_URL —
// в PostgreSQL; без него (локальная разработка и тесты) — в отдельном файле
// SQLite, но через тот же асинхронный интерфейс, что и PostgreSQL, чтобы
// проверяемый код и рабочий код были одним и тем же кодом.
const IDENTITY_DB_PATH = path.join(DATA_DIR, 'identity.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const JWT_SECRET_PATH = path.join(DATA_DIR, '.jwt_secret');

const DATABASE_URL = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

// Режим TLS до PostgreSQL. По умолчанию — проверяемый TLS для внешних узлов и
// отсутствие TLS для локальной и внутренней сети (внутри Railway трафик между
// контейнерами не выходит за пределы частной сети, а сертификата у внутреннего
// имени нет вовсе). Ослабить проверку можно только явно: DATABASE_SSL=no-verify.
function resolvePgSsl(url) {
  const explicit = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (explicit === 'disable' || explicit === 'off' || explicit === 'false') return false;
  if (explicit === 'no-verify' || explicit === 'allow') {
    return { rejectUnauthorized: false, __insecure: true };
  }

  let host = '';
  let sslmode = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname || '';
    sslmode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
  } catch {
    /* строка подключения нестандартного вида — решаем по умолчанию ниже */
  }

  if (sslmode === 'disable') return false;
  if (sslmode === 'require' || sslmode === 'no-verify') {
    return { rejectUnauthorized: false, __insecure: true };
  }

  const isPrivate =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.railway.internal') ||
    host.endsWith('.internal') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate) return false;

  const ca = process.env.DATABASE_CA_CERT;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

// JWT_SECRET: use an operator-supplied env var if set, otherwise generate a
// random per-install secret once and persist it locally. Never fall back to a
// hardcoded shared value — a secret baked into source code can't protect
// anything. Rotating (deleting) the file invalidates every token issued
// before the rotation. See docs/designs/auth-access-control-remediation.md
// item 4.
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) {
    // Короткий ключ подписи подбирается офлайн по любому перехваченному токену.
    if (Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32) {
      throw new Error('JWT_SECRET должен быть не короче 32 байт (например, openssl rand -base64 48)');
    }
    return process.env.JWT_SECRET;
  }

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

  // ── Хранилище учётных записей ──────────────────────────────────────────
  // Переписка остаётся в SQLite (DB_PATH). Здесь — только люди, роли,
  // подразделения, привязки устройств и журнал действий.
  DATABASE_URL,
  IDENTITY_DRIVER: DATABASE_URL ? 'postgres' : 'sqlite',
  IDENTITY_DB_PATH,
  PG_SSL: DATABASE_URL ? resolvePgSsl(DATABASE_URL) : false,
  PG_POOL_MAX: process.env.PG_POOL_MAX ? parseInt(process.env.PG_POOL_MAX, 10) : 10,
  // Запрос, зависший в базе, не должен держать соединение бесконечно: пул
  // конечен, и несколько таких запросов останавливают весь сервер.
  PG_STATEMENT_TIMEOUT_MS: process.env.PG_STATEMENT_TIMEOUT_MS
    ? parseInt(process.env.PG_STATEMENT_TIMEOUT_MS, 10)
    : 15000,

  // Блокировка учётной записи после серии неудачных входов. В отличие от
  // ограничителя по IP, живущего в памяти процесса, счётчик хранится в базе:
  // перезапуск сервера и смена адреса подбор не возобновляют.
  LOGIN_MAX_FAILED_ATTEMPTS: process.env.LOGIN_MAX_FAILED_ATTEMPTS
    ? parseInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS, 10)
    : 10,
  LOGIN_LOCKOUT_MINUTES: process.env.LOGIN_LOCKOUT_MINUTES
    ? parseInt(process.env.LOGIN_LOCKOUT_MINUTES, 10)
    : 15,
  // Секрет устройства (вход без пароля) не вечен: не подтверждённый повторным
  // входом по паролю дольше этого срока перестаёт действовать сам. Без этого
  // предела украденная копия localStorage работала бы бессрочно (аудит,
  // находка №9).
  DEVICE_SECRET_TTL_DAYS: process.env.DEVICE_SECRET_TTL_DAYS
    ? parseInt(process.env.DEVICE_SECRET_TTL_DAYS, 10)
    : 30,
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

  // Whether a plain browser may load the UI, or only the desktop app (see the
  // User-Agent check in index.js). Default false keeps the server's address
  // from serving a branded corporate login page to anyone who types it in.
  ALLOW_BROWSER_ACCESS: process.env.ALLOW_BROWSER_ACCESS === 'true',

  SERVER_VERSION: '2026.1.0-pro'
};
