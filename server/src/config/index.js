const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '../../');
// DATA_DIR переопределяет каталог данных (локальный стенд mobile/dev, изолированные запуски).
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
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

function positiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Целое в пределах [min, max]; всё прочее (пусто, «abc», «30s», вне
// диапазона) — значение по умолчанию и предупреждение в журнал. Пределы
// защиты от подбора не должны молча превращаться в NaN: сравнение с NaN
// всегда ложно, и порог просто перестаёт срабатывать (аудит, раунд 4,
// находка Р4-07).
function boundedInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim();
  const n = /^-?\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    console.warn(
      `[Config] ${name}="${raw}" — ожидается целое число от ${min} до ${max}; использую значение по умолчанию (${fallback}).`
    );
    return fallback;
  }
  return n;
}

const DEFAULT_LEGACY_TOKEN_CUTOFF = '2026-10-15T00:00:00Z';

// Отсечка задаётся оператором как строка окружения — опечатка («2026-13-40»,
// пустая строка после подстановки CI, случайный текст) не должна превращать
// проверку в fail-open. new Date(мусор) даёт Invalid Date, чьё getTime() —
// NaN; сравнение payload.exp < NaN всегда ложно, и старый токен принимался бы
// вечно, каким бы его срок ни был (аудит ревью, находка №20). Невалидное
// значение — предупреждение в журнал и откат к жёсткой дате по умолчанию, а
// не отказ от запуска: отсечка не настолько критична, чтобы ронять сервер.
function resolveLegacyTokenCutoff() {
  const raw = process.env.LEGACY_TOKEN_CUTOFF;
  if (!raw) return DEFAULT_LEGACY_TOKEN_CUTOFF;
  if (Number.isNaN(new Date(raw).getTime())) {
    console.warn(
      `[Config] LEGACY_TOKEN_CUTOFF="${raw}" не распознан как дата — использую значение по умолчанию ` +
        `(${DEFAULT_LEGACY_TOKEN_CUTOFF}). Без этого отсечка старого формата токенов не сработала бы вовсе.`
    );
    return DEFAULT_LEGACY_TOKEN_CUTOFF;
  }
  return raw;
}

// Потолок анонимных запросов: 0 — выключено осознанно, иначе не меньше
// разумного пола (иначе легко случайно перекрыть офис одной опечаткой).
// Промежуточные значения 1..пол отклоняются к значению по умолчанию.
function resolveAnonCeiling() {
  const FLOOR = 600;
  const DEFAULT = 12000;
  const raw = process.env.ANON_RATE_LIMIT_PER_MINUTE;
  if (raw === undefined || raw === '') return DEFAULT;
  const text = String(raw).trim();
  const n = /^-?\d+$/.test(text) ? Number(text) : NaN;
  if (n === 0) return 0;
  if (!Number.isSafeInteger(n) || n < FLOOR || n > 1000000) {
    console.warn(
      `[Config] ANON_RATE_LIMIT_PER_MINUTE="${raw}" — ожидается 0 (выключено) или число не меньше ${FLOOR}; ` +
        `использую значение по умолчанию (${DEFAULT}).`
    );
    return DEFAULT;
  }
  return n;
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

  // Порог и срок временной задержки входа. Задержка держится по паре
  // адрес+логин (аудит, находка №12), а не по учётной записи целиком: подбор
  // пароля с одного адреса не запирает вход этим логином с других адресов, и
  // настоящий владелец остаётся с доступом. Счётчик — в памяти процесса
  // (см. AuthService.loginLockKey/registerFailedAttempt), а не в базе:
  // перезапуск сервера или смена адреса атакующим возобновляют отсчёт заново
  // — приемлемый компромисс для временной задержки, а не жёсткой блокировки.
  //
  // Раньше оба значения читались parseInt без проверки: «abc» давало NaN, и
  // задержка не наступала никогда (count >= NaN всегда ложно) — опечатка в
  // настройках молча выключала защиту от подбора (Р4-07).
  LOGIN_MAX_FAILED_ATTEMPTS: boundedInt('LOGIN_MAX_FAILED_ATTEMPTS', 10, { min: 1, max: 1000 }),
  LOGIN_LOCKOUT_MINUTES: boundedInt('LOGIN_LOCKOUT_MINUTES', 15, { min: 1, max: 1440 }),
  LOGIN_ACCOUNT_MAX_DELAY_SECONDS: boundedInt('LOGIN_ACCOUNT_MAX_DELAY_SECONDS', 60, { min: 1, max: 3600 }),
  // Суточный предел неверных проверок пароля на учётную запись (требование
  // владельца, sec5): три раздельные корзины за скользящие 24 часа, чтобы один
  // класс не съедал бюджет другого — вход с незнакомых адресов (U), вход со
  // знакомых (F), смена пароля (P). Итого ≤ U+F+P ≈ 20/сутки. Исчерпанная
  // корзина отклоняет вход без проверки пароля (429). Считается только
  // подтверждённая неудача; журнал переживает перезапуск (login_failure_log).
  // 0 у любой — корзина выключена (по умолчанию все включены); минимум 1.
  LOGIN_DAILY_FAILURES_UNFAMILIAR: boundedInt('LOGIN_DAILY_FAILURES_UNFAMILIAR', 5, { min: 0, max: 100000 }),
  LOGIN_DAILY_FAILURES_FAMILIAR: boundedInt('LOGIN_DAILY_FAILURES_FAMILIAR', 10, { min: 0, max: 100000 }),
  PASSWORD_CHANGE_DAILY_FAILURES: boundedInt('PASSWORD_CHANGE_DAILY_FAILURES', 5, { min: 0, max: 100000 }),
  // Одновременных проверок пароля с одного адреса. Для адреса, незнакомого ни
  // одной учётной записи, — жёстко мало (не даёт занять очередь хэшей); для
  // адреса офиса (знакомого хотя бы одному) — щедро (проверка раунда 4, I-C).
  LOGIN_INFLIGHT_PER_IP: boundedInt('LOGIN_INFLIGHT_PER_IP', 20, { min: 1, max: 200 }),
  LOGIN_INFLIGHT_UNFAMILIAR: boundedInt('LOGIN_INFLIGHT_UNFAMILIAR', 3, { min: 1, max: 50 }),
  // Сколько расчётов хэша пароля (scrypt, ~128 МиБ каждый) идут одновременно;
  // остальные ждут в короткой очереди, переполненная очередь — отказ 503.
  // Без предела поток попыток входа занимал все потоки libuv (на них же
  // чтение и запись файлов) и поднимал память на 128 МиБ за каждый (Р4-03).
  PASSWORD_HASH_CONCURRENCY: boundedInt('PASSWORD_HASH_CONCURRENCY', 2, { min: 1, max: 16 }),
  // Общий потолок анонимных запросов к /api и /health с одного адреса (сети
  // /64 для IPv6) в минуту. Дешёвые публичные GET (сведения о сервере,
  // /health) из-под него исключены — иначе утренний запуск офиса за одним NAT
  // (сотни клиентов, токены за ночь истекли) упирался бы в него (проверка
  // раунда 4, ПР-I1). 0 — выключено; иначе не меньше 600.
  ANON_RATE_LIMIT_PER_MINUTE: resolveAnonCeiling(),
  // Объём загрузок вложений на одного сотрудника за час (окно отсчитывается
  // от первой загрузки), МБ;
  // 0 — без предела (Р4-11).
  UPLOAD_MAX_MB_PER_HOUR: boundedInt('UPLOAD_MAX_MB_PER_HOUR', 2048, { min: 0, max: 1000000 }),
  // Ниже этого запаса свободного места (МБ) на томе загрузок сервер не
  // принимает файл: иначе запись базы переписки в тот же том может оборваться
  // на переполнении (проверка раунда 4, M2). 0 — проверку выключить.
  UPLOAD_MIN_FREE_DISK_MB: boundedInt('UPLOAD_MIN_FREE_DISK_MB', 1024, { min: 0, max: 10000000 }),
  // Секрет устройства (вход без пароля) не вечен: не подтверждённый повторным
  // входом по паролю дольше этого срока перестаёт действовать сам. Без этого
  // предела украденная копия localStorage работала бы бессрочно (аудит,
  // находка №9).
  // Нечисловое значение (опечатка вида "30d" или пустая переменная от CI)
  // раньше давало NaN: claimDeviceSecret считал expiresAt через него и падал
  // на new Date(NaN).toISOString() — 500 в ответ на обычный вход по паролю на
  // уже привязанном устройстве (аудит ревью, находка №20). positiveInt — тот
  // же помощник, что и для UPDATES_MAX_*, — откатывается к 30 сам.
  DEVICE_SECRET_TTL_DAYS: positiveInt(process.env.DEVICE_SECRET_TTL_DAYS, 30),
  // Токены прежнего (миллисекундного) формата принимаются лишь до этой даты —
  // после неё отклоняются, даже если их exp ещё не наступил, и владельцу
  // придётся войти заново обычным способом. Без отсечки такой токен обходил
  // бы проверки iss/aud/auth_time, которым подчиняются все новые токены
  // (аудит, находка №17).
  LEGACY_TOKEN_CUTOFF: resolveLegacyTokenCutoff(),
  // Автоимпорт учётных записей из резервных файлов (data/identity.db,
  // data/pre-identity-split.db) в пустое хранилище — операция, которая
  // подставляет чужие пароли и устройства поверх того, что сервер считает
  // «новой установкой». Раньше он срабатывал сам по себе, как только рабочее
  // хранилище оказывалось пустым — в том числе по ошибке (опечатка в
  // DATABASE_URL, ещё не поднявшийся PostgreSQL). Явный флаг — осознанное
  // решение оператора, а не побочный эффект пустой базы (аудит, находка №16).
  IDENTITY_AUTO_IMPORT: process.env.IDENTITY_AUTO_IMPORT === 'true',
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

  // ── Автообновление настольного клиента ────────────────────────────────
  // Релизы лежат рядом с остальными данными: в docker-compose корень только
  // для чтения, писать можно лишь в data/.
  UPDATES_DIR: process.env.UPDATES_DIR ? path.resolve(process.env.UPDATES_DIR) : path.join(DATA_DIR, 'updates'),
  // Жёсткий выключатель на уровне развёртывания: консоль администратора его
  // не переопределяет — угнанная учётная запись не включит раздачу обратно.
  UPDATES_DISABLED: process.env.UPDATES_DISABLED === 'true',
  // Сверх этого числа скачивание получает 503 и Retry-After: утренний запуск
  // всего офиса не должен забить канал и диск сервера.
  UPDATES_MAX_CONCURRENT_DOWNLOADS: positiveInt(process.env.UPDATES_MAX_CONCURRENT_DOWNLOADS, 20),
  UPDATES_MAX_FILE_MB: positiveInt(process.env.UPDATES_MAX_FILE_MB, 600),
  // Высокий потолок запросов автообновления на адрес (сеть /64) в минуту —
  // чтобы вместить весь офис за одним NAT; у каждой установки, кроме того, свой
  // предел по install-id (проверка раунда 4, M7). Через boundedInt (M6).
  UPDATES_MAX_REQ_PER_MIN_PER_IP: boundedInt('UPDATES_MAX_REQ_PER_MIN_PER_IP', 6000, { min: 60, max: 10000000 }),

  // Исходящая почта (SMTP). Пустые SMTP_HOST или SMTP_FROM — отправка отключена
  // и честно сообщает об этом (см. services/mailer.service.js). Проверка TLS-
  // сертификата не отключается ничем. SMTP_SECURE=true — неявный TLS (порт 465),
  // иначе обязателен STARTTLS.
  SMTP_HOST: (process.env.SMTP_HOST || '').trim(),
  SMTP_PORT: boundedInt('SMTP_PORT', 587, { min: 1, max: 65535 }),
  SMTP_SECURE: String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true',
  SMTP_USER: (process.env.SMTP_USER || '').trim(),
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: (process.env.SMTP_FROM || '').trim(),
  SMTP_REPLY_TO: (process.env.SMTP_REPLY_TO || '').trim(),

  // Самостоятельная регистрация: адреса и @домены, которым учётная запись
  // активируется сразу после кода из письма (через запятую). Дополняет список,
  // заданный администратором в базе; остальные адреса попадают на рассмотрение.
  REGISTRATION_ALLOWED_EMAILS: (process.env.REGISTRATION_ALLOWED_EMAILS || '').trim(),
  // Общие (на весь сервер) пределы самостоятельной регистрации: заявок на код
  // в час и неудачных проверок кода в час — со всех адресов вместе (решение R).
  REGISTRATION_GLOBAL_REQUESTS_PER_HOUR: boundedInt('REGISTRATION_GLOBAL_REQUESTS_PER_HOUR', 60, { min: 1, max: 100000 }),
  REGISTRATION_GLOBAL_FAILED_VERIFIES_PER_HOUR: boundedInt('REGISTRATION_GLOBAL_FAILED_VERIFIES_PER_HOUR', 300, { min: 1, max: 100000 }),

  SERVER_VERSION: '2026.1.0-pro'
};
