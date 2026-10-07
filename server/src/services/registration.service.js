// Самостоятельная регистрация по коду из письма (мобильные клиенты, App Store).
//
//   request: проверка полей -> пределы -> письмо с 6-значным кодом;
//   verify:  код подошёл -> учётная запись. Адрес в списке разрешённых —
//            сразу активна (вход как обычный), иначе approval_status='pending'
//            и решение за администратором.
//
// Принципы: код — crypto.randomInt, в базе только HMAC-хэш, живёт 10 минут,
// 5 попыток, одноразовый; ответ request не раскрывает, есть ли адрес в списке.
// Пароль хэшируется сразу (scrypt) и ждёт подтверждения в виде хэша.
const crypto = require('node:crypto');
const { identity } = require('../db/identity');
const { hashPassword } = require('../db/identity/password');
const config = require('../config');
const UserService = require('./user.service');
const AuthService = require('./auth.service');
const { checkRateLimit } = require('./rate-limiter');
const SettingsService = require('./settings.service');
const defaultMailer = require('./mailer.service');
const { isValidAddress, buildVerificationEmail, EMAIL_NOT_CONFIGURED } = defaultMailer;

const CODE_TTL_SEC = 600;
const MAX_ATTEMPTS = 5;
const MAX_UNCONFIRMED = 2000; // незавершённых заявок одновременно
const MAX_PENDING_ACCOUNTS = 200; // ожидающих решения администратора
// Общие (на весь сервер) пределы — решение R. Пределы на IP и на адрес почты
// не останавливают перебор кода с тысяч адресов, когда в списке разрешённых
// целый @домен: каждая заявка — 5 попыток угадать код. Общий предел заявок
// ограничивает и число писем с почты компании.
const GLOBAL_WINDOW_MS = 3600000;
const DEFAULT_LIMITS = Object.freeze({
  globalRequestsPerHour: config.REGISTRATION_GLOBAL_REQUESTS_PER_HOUR,
  globalFailedVerifiesPerHour: config.REGISTRATION_GLOBAL_FAILED_VERIFIES_PER_HOUR,
  maxPendingAccounts: MAX_PENDING_ACCOUNTS
});
let limits = { ...DEFAULT_LIMITS };

// Общие счётчики — свои, а не в общей карте rate-limiter: та при переполнении
// вытесняет самые старые ключи, и поток запросов с тысяч адресов (IPv6 /64)
// обнулял бы бюджет решения R. Здесь два числа, вытеснять нечего.
// Фиксированное окно в час, как у остальных пределов регистрации.
function newWindow() {
  return { count: 0, windowStart: 0 };
}
const globalCounters = { requests: newWindow(), failedVerifies: newWindow() };

function currentWindow(counter, now = Date.now()) {
  if (now - counter.windowStart >= GLOBAL_WINDOW_MS) {
    counter.count = 0;
    counter.windowStart = now;
  }
  return counter;
}

// Взять единицу бюджета; null — бюджет исчерпан. Возвращённую отметку можно
// вернуть (refundGlobal), если письмо так и не ушло.
function takeGlobal(counter, max) {
  const w = currentWindow(counter);
  if (w.count >= max) return null;
  w.count += 1;
  return { counter, windowStart: w.windowStart };
}

function refundGlobal(ticket) {
  if (ticket && ticket.counter.windowStart === ticket.windowStart && ticket.counter.count > 0) ticket.counter.count -= 1;
}

function bumpGlobal(counter) {
  currentWindow(counter).count += 1;
}

function globalExhausted(counter, max) {
  return currentWindow(counter).count >= max;
}

function resetGlobalCounters() {
  globalCounters.requests = newWindow();
  globalCounters.failedVerifies = newWindow();
}
// Чистка просроченных заявок по ходу работы — не чаще раза в 10 минут.
const PURGE_INTERVAL_MS = 10 * 60000;
let lastPurgeAt = 0;
// Текст совпадает с mobile/contracts/copy-ru.md (reg.disabled).
const REGISTRATION_DISABLED_MESSAGE = 'Регистрация сейчас закрыта. Обратитесь к администратору.';
const DISPLAY_NAME_MAX = 100;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,64}$/;
const ALLOWLIST_PATTERN_RE = /^(?:[a-z0-9._%+-]{1,64})?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

class RegistrationError extends Error {
  constructor(status, message, code = null, extra = {}) {
    super(message);
    this.name = 'RegistrationError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let mailer = defaultMailer;
// Подмена транспорта в тестах.
function setMailer(next) {
  mailer = next || defaultMailer;
}

// Для тестов: подменить общие пределы; null — вернуть значения по умолчанию.
function configureLimits(overrides) {
  limits = { ...DEFAULT_LIMITS, ...(overrides || {}) };
}

function resetPurgeClock() {
  lastPurgeAt = 0;
}

// allow_registration — главный выключатель самостоятельной регистрации
// (решение Q). Выключен — ни заявок, ни подтверждений, в том числе для адресов
// из списка разрешённых: список уточняет «сразу или на рассмотрение» только
// внутри включённой регистрации.
async function assertRegistrationOpen() {
  if ((await SettingsService.getSetting('allow_registration', 'false')) !== 'true') {
    throw new RegistrationError(403, REGISTRATION_DISABLED_MESSAGE, 'REGISTRATION_DISABLED');
  }
}

// Нарушение уникальности: PostgreSQL 23505, node:sqlite SQLITE_CONSTRAINT_UNIQUE
// (2067). Прочие ошибки базы — не «логин занят», а внутренняя ошибка (500).
function isUniqueViolation(err) {
  return Boolean(err) && (err.code === '23505' || err.errcode === 2067);
}

// Не больше одного оповещения на правило за окно общего предела.
const lastAlertAt = new Map();
function alertOncePerWindow(rule, title) {
  const now = Date.now();
  if (now - (lastAlertAt.get(rule) || 0) < GLOBAL_WINDOW_MS) return;
  lastAlertAt.set(rule, now);
  try {
    require('./security-monitor.service').raise(rule, 'high', title, {});
  } catch (err) {
    console.warn('[Registration] оповещение безопасности не поднято:', err.message);
  }
}

async function maybePurgeExpired() {
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = now;
  try {
    await purgeExpired();
  } catch (err) {
    console.warn('[Registration] чистка заявок не удалась:', err.message);
  }
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function hashCode(registrationId, code) {
  return crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(`registration-code\u001f${registrationId}\u001f${code}`)
    .digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function emailKey(email) {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
}

// ── Список разрешённых адресов ────────────────────────────────────────────

function normalizePattern(value) {
  const pattern = String(value ?? '').trim().toLowerCase();
  if (pattern.length > 254 || !ALLOWLIST_PATTERN_RE.test(pattern)) {
    throw new RegistrationError(400, 'Укажите адрес (user@domain.kz) или домен (@domain.kz)');
  }
  return pattern;
}

async function isAllowed(email, db = identity()) {
  const address = normalizeEmail(email);
  const at = address.lastIndexOf('@');
  if (at < 1) return false;
  const row = await db.get(
    'SELECT id FROM registration_allowlist WHERE pattern = $1 OR pattern = $2',
    [address, address.slice(at)]
  );
  return Boolean(row);
}

async function listAllowlist() {
  return identity().all('SELECT id, pattern, created_at FROM registration_allowlist ORDER BY pattern ASC');
}

async function addAllowlist(patternRaw, createdBy = null) {
  const pattern = normalizePattern(patternRaw);
  const now = new Date().toISOString();
  const res = await identity().run(
    `INSERT INTO registration_allowlist (pattern, created_at, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (pattern) DO NOTHING RETURNING id`,
    [pattern, now, createdBy]
  );
  if (!res.rows.length) throw new RegistrationError(409, 'Такая запись уже есть');
  const row = await identity().get('SELECT id, pattern, created_at FROM registration_allowlist WHERE pattern = $1', [pattern]);
  return row;
}

async function removeAllowlist(id) {
  const res = await identity().run('DELETE FROM registration_allowlist WHERE id = $1', [Number(id)]);
  return res.changes > 0;
}

// REGISTRATION_ALLOWED_EMAILS: через запятую. Дополняет таблицу, ничего не удаляет.
async function seedAllowlistFromEnv(raw = config.REGISTRATION_ALLOWED_EMAILS) {
  const items = String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  let added = 0;
  for (const item of items) {
    try {
      await addAllowlist(item, null);
      added += 1;
    } catch (err) {
      if (!(err instanceof RegistrationError) || err.status !== 409) {
        console.warn(`[Registration] запись списка разрешённых пропущена: ${err.message}`);
      }
    }
  }
  return added;
}

// ── Шаг 1: заявка и письмо ────────────────────────────────────────────────

async function requestRegistration(body, { ip = '0.0.0.0' } = {}) {
  await assertRegistrationOpen();
  const { email: emailRaw, username: usernameRaw, displayName: displayRaw, password } = body || {};
  if (typeof emailRaw !== 'string' || typeof usernameRaw !== 'string' || typeof password !== 'string' ||
      typeof displayRaw !== 'string') {
    throw new RegistrationError(400, 'Укажите email, логин, имя и пароль');
  }
  const email = normalizeEmail(emailRaw);
  const username = usernameRaw.trim();
  const displayName = displayRaw.trim();

  if (!isValidAddress(email)) throw new RegistrationError(400, 'Неверный формат email');
  if (!USERNAME_RE.test(username)) {
    throw new RegistrationError(400, 'Логин может состоять из латинских букв, цифр, точки, дефиса и подчёркивания (3–64 символа)');
  }
  if (!displayName) throw new RegistrationError(400, 'Укажите имя');
  if (displayName.length > DISPLAY_NAME_MAX) throw new RegistrationError(400, `Имя — не длиннее ${DISPLAY_NAME_MAX} символов`);
  if (/[\u0000-\u001f\u007f]/.test(displayName)) throw new RegistrationError(400, 'Имя содержит недопустимые символы');
  try {
    UserService.assertPasswordPolicy(password, { username });
  } catch (err) {
    throw new RegistrationError(400, err.message);
  }

  // Почта не настроена — честный отказ, письмо не «отправлено понарошку».
  if (!mailer.isConfigured()) throw new RegistrationError(503, 'Отправка почты не настроена', 'EMAIL_NOT_CONFIGURED');

  // Пределы — до тяжёлого хэширования и обращений к базе.
  const ipKey = require('./ip-access.service').rateLimitIpKey(ip);
  if (!checkRateLimit(`reg-req-ip:${ipKey}`, { maxAttempts: 10, windowMs: 3600000 }) ||
      !checkRateLimit(`reg-req-email:${emailKey(email)}`, { maxAttempts: 3, windowMs: 3600000, scope: 'name' })) {
    throw new RegistrationError(429, 'Слишком много запросов. Повторите позже.', 'RATE_LIMITED', { retryAfter: 600 });
  }
  await maybePurgeExpired();
  const db = identity();
  const taken = await db.get('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  if (taken) throw new RegistrationError(409, 'Этот логин уже занят', 'USERNAME_TAKEN');
  const emailTaken = await db.get('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
  if (emailTaken) throw new RegistrationError(409, 'Этот email уже зарегистрирован', 'EMAIL_TAKEN');

  const total = await db.get('SELECT COUNT(*) AS n FROM registration_requests WHERE consumed_at IS NULL AND expires_at > $1', [new Date().toISOString()]);
  if (Number(total?.n || 0) >= MAX_UNCONFIRMED) {
    throw new RegistrationError(429, 'Сервис временно перегружен. Повторите позже.', 'RATE_LIMITED');
  }

  // Общий предел считает только письма с кодом: проверка — после полей,
  // пределов на IP и почту, занятости и ёмкости; если письмо не ушло (сбой
  // почты, занят расчёт хэша), единица бюджета возвращается.
  const ticket = takeGlobal(globalCounters.requests, limits.globalRequestsPerHour);
  if (!ticket) {
    alertOncePerWindow('registration_request_flood', 'Исчерпан общий предел заявок на регистрацию');
    throw new RegistrationError(429, 'Слишком много запросов. Повторите позже.', 'RATE_LIMITED', { retryAfter: 600 });
  }
  try {
    return await createRequestAndSendCode(db, { email, username, displayName, password });
  } catch (err) {
    refundGlobal(ticket);
    throw err;
  }
}

async function createRequestAndSendCode(db, { email, username, displayName, password }) {
  const passwordHash = await hashPassword(password); // может бросить PASSWORD_HASH_BUSY
  const registrationId = crypto.randomBytes(18).toString('base64url');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();

  // Одна живая заявка на адрес: новая отменяет прежнюю.
  await db.run('DELETE FROM registration_requests WHERE email = $1', [email]);
  await db.run(
    `INSERT INTO registration_requests
       (id, email, username, display_name, password_hash, code_hash, attempts, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`,
    [registrationId, email, username, displayName, passwordHash, hashCode(registrationId, code),
      new Date(now + CODE_TTL_SEC * 1000).toISOString(), new Date(now).toISOString()]
  );

  try {
    const message = buildVerificationEmail({ code, ttlMinutes: CODE_TTL_SEC / 60 });
    await mailer.sendMail({ to: email, ...message });
  } catch (err) {
    await db.run('DELETE FROM registration_requests WHERE id = $1', [registrationId]);
    if (err && err.code === EMAIL_NOT_CONFIGURED) throw new RegistrationError(503, 'Отправка почты не настроена', 'EMAIL_NOT_CONFIGURED');
    throw new RegistrationError(503, 'Не удалось отправить письмо', 'EMAIL_SEND_FAILED');
  }

  return { status: 'code_sent', registrationId, expiresInSec: CODE_TTL_SEC };
}

// ── Шаг 2: подтверждение кода ─────────────────────────────────────────────

const GONE = () => new RegistrationError(410, 'Код недействителен или истёк. Запросите новый.', 'CODE_EXPIRED');

async function verifyRegistration(body, { ip = '0.0.0.0' } = {}) {
  // Выключатель проверяется и здесь: живые коды, выданные до выключения,
  // учётных записей не создают.
  await assertRegistrationOpen();
  const { registrationId, code } = body || {};
  if (typeof registrationId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(registrationId) ||
      typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new RegistrationError(400, 'Неверный код', 'CODE_INVALID');
  }
  const ipKey = require('./ip-access.service').rateLimitIpKey(ip);
  if (!checkRateLimit(`reg-verify-ip:${ipKey}`, { maxAttempts: 60, windowMs: 600000 })) {
    throw new RegistrationError(429, 'Слишком много попыток. Повторите позже.', 'RATE_LIMITED', { retryAfter: 300 });
  }
  // Общий бюджет неудачных проверок исчерпан — перебор идёт с многих адресов.
  // Ждут все, попытка не засчитывается.
  if (globalExhausted(globalCounters.failedVerifies, limits.globalFailedVerifiesPerHour)) {
    alertOncePerWindow('registration_code_bruteforce', 'Исчерпан общий бюджет неудачных проверок кода регистрации — возможен перебор');
    throw new RegistrationError(429, 'Слишком много попыток. Повторите позже.', 'RATE_LIMITED', { retryAfter: 600 });
  }

  const db = identity();
  const nowIso = new Date().toISOString();
  // Попытка засчитывается ДО сравнения и атомарно: параллельный перебор не
  // получает больше MAX_ATTEMPTS проверок.
  const bumped = await db.run(
    `UPDATE registration_requests SET attempts = attempts + 1
     WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2 AND attempts < $3
     RETURNING attempts, code_hash`,
    [registrationId, nowIso, MAX_ATTEMPTS]
  );
  const row = bumped.rows && bumped.rows[0];
  if (!row) throw GONE();

  if (!safeEqualHex(row.code_hash, hashCode(registrationId, code))) {
    bumpGlobal(globalCounters.failedVerifies);
    const left = Math.max(0, MAX_ATTEMPTS - Number(row.attempts));
    if (left === 0) throw GONE();
    throw new RegistrationError(400, 'Неверный код', 'CODE_INVALID', { attemptsLeft: left });
  }

  // Проверки ёмкости и занятости — ДО потребления кода: отказ 429/409 не
  // сжигает верный код, его можно предъявить снова, пока он жив.
  const req = await db.get('SELECT * FROM registration_requests WHERE id = $1', [registrationId]);
  if (!req) throw GONE();
  const allowed = await isAllowed(req.email, db);

  if (!allowed) {
    const pending = await db.get(`SELECT COUNT(*) AS n FROM users WHERE approval_status = 'pending'`);
    if (Number(pending?.n || 0) >= limits.maxPendingAccounts) {
      throw new RegistrationError(429, 'Слишком много заявок ожидают подтверждения. Обратитесь к администратору.', 'RATE_LIMITED');
    }
  }

  const taken = await db.get('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [req.username]);
  if (taken) throw new RegistrationError(409, 'Этот логин уже занят', 'USERNAME_TAKEN');
  const emailTaken = await db.get('SELECT id FROM users WHERE LOWER(email) = $1', [req.email]);
  if (emailTaken) throw new RegistrationError(409, 'Этот email уже зарегистрирован', 'EMAIL_TAKEN');

  // Одноразовость: потребить может только один запрос.
  const consumed = await db.run(
    'UPDATE registration_requests SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL',
    [nowIso, registrationId]
  );
  if (!consumed.changes) throw GONE();

  const maxUin = await db.get('SELECT COALESCE(MAX(uin), 0) + 1 AS next FROM users');
  const company = await db.get(`SELECT value FROM server_settings WHERE key = 'company_name'`);
  const defaultRole = await db.get(`SELECT id FROM roles WHERE name = 'Сотрудник'`);
  const status = allowed ? 'approved' : 'pending';

  let inserted;
  try {
    inserted = await db.run(
      `INSERT INTO users (
         username, password_hash, salt, full_name, email, job_title, role_id, uin, company,
         created_at, approval_status, registered_at, password_changed_at
       ) VALUES ($1, $2, NULL, $3, $4, 'Сотрудник', $5, $6, $7, $8, $9, $8, $8)
       RETURNING id`,
      [req.username, req.password_hash, req.display_name, req.email, defaultRole ? defaultRole.id : null,
        Number(maxUin?.next || 1), company ? company.value : 'Корпоративная сеть', nowIso, status]
    );
  } catch (err) {
    // Учётная запись не создана — код снова действует (попытки по-прежнему
    // считаются атомарно выше).
    await db.run('UPDATE registration_requests SET consumed_at = NULL WHERE id = $1', [registrationId])
      .catch(() => {});
    // Гонка за логин или почту между проверкой и вставкой (UNIQUE) — 409.
    // Любая другая ошибка базы — внутренняя (500), а не «логин занят».
    if (!isUniqueViolation(err)) throw err;
    if (/email/i.test(`${err.constraint || ''} ${err.message || ''}`)) {
      throw new RegistrationError(409, 'Этот email уже зарегистрирован', 'EMAIL_TAKEN');
    }
    throw new RegistrationError(409, 'Этот логин уже занят', 'USERNAME_TAKEN');
  }
  const userId = inserted.rows[0].id;
  // Хэш пароля больше не нужен в таблице заявок.
  await db.run('UPDATE registration_requests SET password_hash = $1 WHERE id = $2', ['', registrationId]);

  if (!allowed) return { status: 'pending', user: { id: userId, username: req.username, full_name: req.display_name } };

  require('./message.service').addToDefaultChannels([userId]);
  await db.run('UPDATE users SET last_login_at = $1, last_login_ip = $2, last_seen = $1 WHERE id = $3', [nowIso, ip, userId]);
  const user = await UserService.getUserById(userId);
  return { status: 'approved', user, token: AuthService.generateToken(user) };
}

// Чистка просроченных и потреблённых заявок.
async function purgeExpired() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await identity().run('DELETE FROM registration_requests WHERE expires_at < $1 OR consumed_at < $1', [cutoff]);
}

module.exports = {
  RegistrationError,
  CODE_TTL_SEC,
  MAX_ATTEMPTS,
  REGISTRATION_DISABLED_MESSAGE,
  setMailer,
  configureLimits,
  resetGlobalCounters,
  resetPurgeClock,
  isUniqueViolation,
  isAllowed,
  listAllowlist,
  addAllowlist,
  removeAllowlist,
  seedAllowlistFromEnv,
  requestRegistration,
  verifyRegistration,
  purgeExpired
};
