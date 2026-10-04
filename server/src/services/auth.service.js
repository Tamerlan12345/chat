const crypto = require('node:crypto');
const { identity } = require('../db/identity');
const { hashPassword, verifyPassword } = require('../db/identity/password');
const { getDatabase } = require('../db');
const UserService = require('./user.service');
const config = require('../config');
const { isRateLimited, registerFailure, resetLimit } = require('./rate-limiter');
const LoginThrottle = require('./login-throttle.service');
const { canonicalUsername } = LoginThrottle;
const { rateLimitIpKey } = require('./ip-access.service');

// Логин длиннее этого не заводится ни регистрацией (до 64), ни разумным
// администратором. Такой «логин» отклоняется сразу, до базы и до ключей
// ограничителей: иначе каждый ключ в памяти нёс бы до 256 КБ строки из тела
// запроса (аудит, раунд 4, находка Р4-04).
const MAX_LOGIN_LENGTH = 256;

// Ошибка «неверные данные» с кодом: маршрут по коду отличает подтверждённо
// неверный вход (его и только его засчитывать в предел неудач с адреса, ПР-02)
// от отказов, которые входом не являются (задержка, перегрузка очереди хэшей).
function invalidCredentials() {
  const err = new Error(INVALID_CREDENTIALS);
  err.code = 'INVALID_CREDENTIALS';
  return err;
}

// Одно сообщение на все отказы, включая временную блокировку: отдельный
// текст о блокировке выдавал, что такой логин существует.
const INVALID_CREDENTIALS = 'Неверный логин или пароль. После нескольких неудачных попыток вход временно заблокирован.';

// Хэш-приманка для несуществующего логина: проверка против него занимает
// столько же, сколько настоящая, и отказ не выдаёт себя скоростью. Считается
// один раз и лениво — чтобы не замедлять запуск сервера.
let dummyHashPromise = null;

const TOKEN_ISSUER = 'openmychat-server';
const TOKEN_AUDIENCE = 'openmychat-client';
// Отозванные номера держатся в памяти, чтобы не ходить в базу на каждом
// запросе за уже известным ответом. Размер ограничен сроком жизни токенов.
const revokedCache = new Set();

function tokenTtlSeconds() {
  const hours = Number(process.env.TOKEN_TTL_HOURS);
  return Math.round((Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : 12) * 3600);
}

function refreshGraceSeconds() {
  const value = Number(process.env.TOKEN_REFRESH_GRACE_SECONDS);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 300) : 60;
}

function sessionMaxSeconds() {
  const days = Number(process.env.SESSION_MAX_DAYS);
  return Math.round((Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30) * 86400);
}
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(18).toString('base64url'));
    // Неудачный расчёт (например, очередь хэшей переполнена) не должен
    // запомниться навсегда — следующий вызов попробует снова.
    dummyHashPromise.catch(() => { dummyHashPromise = null; });
  }
  return dummyHashPromise;
}

// Сколько в среднем занимает проверка пароля с нынешними параметрами scrypt.
// Нужна, чтобы выровнять по времени отказ для учётной записи, чей пароль ещё
// хранится с прежними, более дешёвыми параметрами (N=2^15 или старый формат):
// такая проверка идёт вчетверо быстрее приманки для несуществующего логина, и
// по секундомеру отличались бы «есть такой, но давно не входил» и «нет
// такого» — ровно на недели после подъёма N (аудит, раунд 4, находка Р4-09).
let fullVerifyMs = 0;
function noteFullVerify(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  fullVerifyMs = fullVerifyMs ? fullVerifyMs * 0.8 + ms * 0.2 : ms;
}

// Проверка против приманки. Ошибку «очередь хэшей переполнена» не глотает —
// иначе при перегрузке несуществующий логин отвечал бы мгновенно, а
// существующий — 503.
async function dummyVerify(password) {
  const started = Date.now();
  try {
    await verifyPassword(password, await dummyHash());
  } catch (err) {
    if (err?.code === 'PASSWORD_HASH_BUSY') throw err;
    return;
  }
  if (typeof password === 'string' && password) noteFullVerify(Date.now() - started);
}

async function padToFullVerify(password, startedAt) {
  if (!fullVerifyMs) {
    // Образца ещё нет (первый отказ после запуска) — одна настоящая проверка
    // приманки и даёт нужную длительность, и сама её выдерживает.
    await dummyVerify(password);
    return;
  }
  const left = fullVerifyMs - (Date.now() - startedAt);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
}

function throttledError({ retryAfterMs, reason, cls }) {
  const seconds = Math.max(1, Math.ceil((Number(retryAfterMs) || 1000) / 1000));
  // Текст не выдаёт, существует ли логин: корзины ведутся по имени и одинаково
  // наступают для несуществующих. При исчерпании суточной корзины (sec5)
  // сотруднику подсказываем безопасный путь. Корзина U (незнакомые адреса) —
  // «войдите с рабочего компьютера»; корзина F (уже знакомый адрес) — только
  // администратор.
  let message;
  if (reason === 'daily' && cls === 'F') {
    message = 'Превышено число неверных попыток входа за сутки. Обратитесь к администратору.';
  } else if (reason === 'daily') {
    message = 'Слишком много неверных попыток входа под этим логином за сутки. Войдите с рабочего компьютера или обратитесь к администратору.';
  } else if (reason === 'pending') {
    // Остаток суточной корзины уже занят попытками, которые проверяются прямо
    // сейчас (параллельный подбор): ждём их исхода, а не проверяем сверх предела.
    message = `Слишком много одновременных попыток входа под этим логином. Повторите через ${seconds} с.`;
  } else {
    message = `Слишком много неудачных попыток входа под этим логином. Повторите через ${seconds} с.`;
  }
  const err = new Error(message);
  err.code = 'ACCOUNT_THROTTLED';
  err.retryAfterSeconds = seconds;
  return err;
}

// «Знакомый» адрес для учётной записи: с него уже проходила проверка личности.
// Источники «знакомости», от быстрого к надёжному:
//   — «горячий» кэш удачных входов в памяти (LoginThrottle.isKnownSource);
//   — last_login_ip из строки (последний вход по паролю, переживает перезапуск);
//   — таблица trusted_login_sources (любое подтверждённое действие: вход,
//     «стук», продление, WebSocket — тоже переживает перезапуск, ПР-I4).
// С такого адреса задержка по учётной записи не действует.
async function isTrustedSource(row, ipKey) {
  if (!row) return false;
  const nameKey = canonicalUsername(row.username);
  if (LoginThrottle.isKnownSource(nameKey, ipKey)) return true;
  if (row.last_login_ip && rateLimitIpKey(row.last_login_ip) === ipKey) return true;
  return require('./trusted-sources.service').isTrusted(row.id, ipKey);
}

// Корзина суточного предела для попытки входа (sec5): знакомый этому сотруднику
// адрес — F, иначе U. Исключение (проверка sec5, п.4): у только что заведённой
// учётной записи знакомых адресов ещё нет вовсе, и первый вход с временным
// паролем из офиса с опечатками расходовал бы корзину U (5) с советом «войдите с
// рабочего компьютера» — тому, кто за ним и сидит. Поэтому для сотрудника БЕЗ
// единого знакомого адреса адрес, знакомый другим сотрудникам (офис, обратный
// индекс), считается F. Устоявшимся сотрудникам правило не расширяется: иначе
// гостевой Wi-Fi за тем же NAT мог бы расходовать их офисную корзину F.
async function budgetClassFor(row, ipKey, trusted) {
  if (trusted) return 'F';
  if (!row || row.last_login_ip) return 'U';
  const TrustedSources = require('./trusted-sources.service');
  if (!TrustedSources.isFamiliarToAnyoneSync(ipKey)) return 'U';
  return (await TrustedSources.hasAnyFamiliar(row.id)) ? 'U' : 'F';
}

// Ключ ограничителя входа — конкретный адрес (сеть /64 для IPv6) и логин в
// единой форме (canonicalUsername), не учётная запись сама по себе (см.
// registerFailedAttempt/login).
function loginLockKey(ip, username) {
  return `login-lock:${rateLimitIpKey(ip)}:${canonicalUsername(username)}`;
}
function loginLockOptions() {
  // scope 'name': ключ содержит логин из тела запроса — живёт в отдельной
  // карте, чтобы спрей выдуманными логинами не вытеснял адресные счётчики
  // (проверка раунда 4, ПР-01).
  return { maxAttempts: config.LOGIN_MAX_FAILED_ATTEMPTS, windowMs: config.LOGIN_LOCKOUT_MINUTES * 60000, scope: 'name' };
}

// «Сколько учётных записей сейчас заблокировано» для панели администратора
// (DbStudioService.getIdentityStats) — по логину, а не по паре адрес+логин: с
// точки зрения администратора важно «этим логином сейчас нельзя войти хотя бы
// с одного места», а не сколько разных адресов его атакуют. Отдельная карта,
// а не разбор ключей ограничителя (loginLockKey): логин панель администратора
// не проверяет на двоеточия при создании (UserService.createUser их не
// запрещает), а адрес бывает IPv6 с двоеточиями внутри — по одной строке их
// было бы не различить.
const lockedUsernamesUntil = new Map(); // логин в нижнем регистре -> когда снимется

function markUsernameLocked(username, windowMs) {
  lockedUsernamesUntil.set(canonicalUsername(username), Date.now() + windowMs);
}

// Живой снимок, не кэш: устаревшие записи вычищаются здесь же, при каждом
// обращении — отдельного таймера ради нечастой статистики заводить незачем.
function countLockedUsernames() {
  const now = Date.now();
  for (const [name, until] of lockedUsernamesUntil) {
    if (until <= now) lockedUsernamesUntil.delete(name);
  }
  return lockedUsernamesUntil.size;
}

class AuthService {
  /**
   * Токен подписывается HMAC-SHA256 на серверном секрете. Внутри:
   *   tv        — поколение учётной записи: смена пароля, роли или отключение
   *               сдвигают его, и прежние токены перестают приниматься сразу;
   *   iat/exp   — выдан и истекает, в секундах; срок — TOKEN_TTL_HOURS (12 ч),
   *               клиент продлевает его сам, пока сотрудник работает;
   *   auth_time — когда человек в последний раз подтвердил себя (пароль или
   *               устройство); продление её не сдвигает, поэтому бесконечно
   *               жить на продлениях нельзя (SESSION_MAX_DAYS);
   *   amr       — чем подтвердил: pwd (пароль) или device (секрет устройства);
   *   jti       — номер токена, по нему выход из системы отзывает именно его;
   *   iss/aud   — чей токен и для кого: подпись тем же ключом другого
   *               назначения здесь не пройдёт.
   * Прежде токен жил неделю, и выйти из системы по-настоящему было нельзя.
   */
  static generateToken(user, { amr = 'pwd', authTime = null } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      userId: user.id,
      username: user.username,
      roleId: user.role_id,
      tv: Number(user.token_version || 1),
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      iat: now,
      exp: now + tokenTtlSeconds(),
      auth_time: Number.isFinite(authTime) ? authTime : now,
      amr: amr === 'device' ? 'device' : 'pwd',
      jti: crypto.randomBytes(16).toString('hex')
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', config.JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  // Подпись токена верна (структура + HMAC), без проверки срока и поколения.
  // Нужна, чтобы отличить протухший, но НАШ токен (обычное переподключение
  // утром) от мусора/подбора: первый — не попытка угадать токен и не должен
  // расходовать предел ws_auth (проверка раунда 4, M7).
  static signatureValid(token) {
    try {
      if (!token || typeof token !== 'string' || token.length > 4096) return false;
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const [header, body, signature] = parts;
      const expected = crypto
        .createHmac('sha256', config.JWT_SECRET)
        .update(`${header}.${body}`)
        .digest('base64url');
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  static verifyToken(token) {
    try {
      if (!token || typeof token !== 'string' || token.length > 4096) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [header, body, signature] = parts;

      const expected = crypto
        .createHmac('sha256', config.JWT_SECRET)
        .update(`${header}.${body}`)
        .digest('base64url');

      // Сравнение за постоянное время: по длительности обычного сравнения строк
      // подпись можно подбирать побайтно.
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

      const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      if (!head || head.alg !== 'HS256') return null;

      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || typeof payload.exp !== 'number') return null;

      const nowMs = Date.now();
      // Токены прежнего формата хранили срок в миллисекундах и жили неделю.
      // Принимались до своего срока, чтобы обновление сервера не выбросило всех
      // разом — но они также обходят проверки iss/aud/auth_time ниже, которым
      // подчиняются все новые токены. LEGACY_TOKEN_CUTOFF — жёсткая дата, после
      // которой такой токен не принимается, даже если его exp ещё впереди:
      // владельцу придётся войти заново (аудит, находка №17). Новых токенов
      // этого формата не выдаётся уже давно.
      if (payload.exp > 1e11) {
        if (payload.exp < nowMs) return null;
        if (nowMs >= new Date(config.LEGACY_TOKEN_CUTOFF).getTime()) return null;
        payload.legacy = true;
        return payload;
      }

      if (payload.exp * 1000 < nowMs) return null;
      if (payload.iss !== TOKEN_ISSUER || payload.aud !== TOKEN_AUDIENCE) return null;
      if (typeof payload.iat !== 'number' || payload.iat * 1000 > nowMs + 60000) return null;
      if (typeof payload.auth_time !== 'number' || (payload.auth_time + sessionMaxSeconds()) * 1000 < nowMs) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Проверяет, что токен всё ещё относится к действующей учётной записи и не
   * отозван выходом. Вызывается на каждом запросе — здесь же отсекаются
   * токены, выданные до смены пароля или до отключения сотрудника.
   */
  static async resolveSessionDetailed(token) {
    const payload = this.verifyToken(token);
    if (!payload) return null;

    if (payload.jti && (await this.isRevoked(payload.jti))) return null;

    const user = await UserService.getUserById(payload.userId);
    if (!user || !user.is_active) return null;
    if (user.approval_status !== 'approved') return null;

    // Токены, выпущенные до появления нумерации поколений, поля tv не имеют.
    // Они принимаются только пока поколение первое: иначе однажды сменённый
    // пароль не отозвал бы их.
    const tokenVersion = Number(payload.tv || 1);
    if (tokenVersion !== Number(user.token_version || 1)) return null;

    return { user, payload };
  }

  static async resolveSession(token) {
    const session = await this.resolveSessionDetailed(token);
    return session ? session.user : null;
  }

  // Продление: новый токен с тем же способом и временем подтверждения, но с
  // новым сроком. Старый отзывается не мгновенно, а через короткую паузу:
  // запросы, отправленные со старым токеном за миг до продления, иначе
  // получали бы отказ, и сотрудника выбрасывало на экран входа.
  static async refreshToken(user, payload) {
    const token = this.generateToken(user, {
      amr: payload.amr,
      authTime: Number.isFinite(payload.auth_time) ? payload.auth_time : null
    });
    if (payload.jti) await this.revokeToken(payload, { graceSeconds: refreshGraceSeconds() });
    return token;
  }

  // Выход отзывает сразу; продление — с паузой (graceSeconds).
  static async revokeToken(payload, { graceSeconds = 0 } = {}) {
    if (!payload?.jti) return false;
    const expiresAt = new Date((payload.exp > 1e11 ? payload.exp : payload.exp * 1000)).toISOString();
    const effectiveAt = new Date(Date.now() + graceSeconds * 1000).toISOString();
    await identity().run(
      `INSERT INTO revoked_tokens (jti, user_id, expires_at, revoked_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (jti) DO UPDATE SET revoked_at = CASE
         WHEN EXCLUDED.revoked_at < revoked_tokens.revoked_at THEN EXCLUDED.revoked_at
         ELSE revoked_tokens.revoked_at END`,
      [String(payload.jti), Number(payload.userId) || null, expiresAt, effectiveAt]
    );
    if (graceSeconds <= 0) revokedCache.add(String(payload.jti));
    // Истёкшие записи больше ничего не отзывают — таблица не должна расти вечно.
    if (Math.random() < 0.05) {
      identity().run('DELETE FROM revoked_tokens WHERE expires_at < $1', [new Date().toISOString()]).catch(() => {});
    }
    return true;
  }

  static async hasRevocationRecord(jti) {
    return Boolean(await identity().get('SELECT 1 AS hit FROM revoked_tokens WHERE jti = $1', [String(jti)]));
  }

  static async isRevoked(jti) {
    if (revokedCache.has(String(jti))) return true;
    const row = await identity().get('SELECT revoked_at FROM revoked_tokens WHERE jti = $1', [String(jti)]);
    if (!row) return false;
    if (new Date(row.revoked_at).getTime() > Date.now()) return false; // ещё идёт пауза после продления
    revokedCache.add(String(jti));
    return true;
  }

  static async login(username, password, { ip = null } = {}) {
    const nameKey = canonicalUsername(username);
    if (!nameKey || nameKey.length > MAX_LOGIN_LENGTH) throw invalidCredentials();
    const ipKey = rateLimitIpKey(ip);

    const db = identity();
    const row = await db.get(
      `SELECT u.id, u.username, u.password_hash, u.salt, u.is_active, u.approval_status,
              u.token_version, u.last_login_ip
       FROM users u WHERE u.username = $1`,
      [String(username || '').trim()]
    );

    // Суточная корзина неудач на учётную запись (sec5) — до проверки пароля:
    // исчерпанная корзина отклоняет вход БЕЗ scrypt, даже верный пароль. Класс
    // выбирается по знакомости адреса (F — знакомый, U — незнакомый). Для
    // существующего сотрудника журнал неудач подгружается из базы (переживает
    // перезапуск). Одинаково для несуществующих логинов — без оракула.
    const trusted = await isTrustedSource(row, ipKey);
    const budgetClass = await budgetClassFor(row, ipKey, trusted);
    if (row) await LoginThrottle.ensureLoaded(row.id, nameKey);
    // Ключ корзины — единая форма логина и для существующих, и для выдуманных
    // (проверка sec5, п.2): вариант регистра существующего логина не получает
    // свежую корзину. Между admit и try ниже нет ничего, что может бросить, —
    // билет всегда возвращается в settle (там освобождается слот «в полёте»).
    const admission = LoginThrottle.admit(nameKey, { ipKey, trusted, cls: budgetClass, userId: row?.id ?? null });
    if (!admission.ok) throw throttledError(admission);

    // Несуществующий, отключённый сотрудник и неверный пароль идут по ОДНОМУ
    // пути — те же проверки, тот же счёт, то же время. Иначе по тому, на каком
    // шаге ответ отличается (или когда включается задержка/блокировка),
    // перебором выясняется, какие логины заведены (проверка раунда 4, ПР-03).
    const active = Boolean(row && row.is_active);
    let outcome = 'neutral';
    try {
      const lockKey = loginLockKey(ip, nameKey);
      // Блокировка — по паре адрес+логин, а не по учётной записи целиком: иначе
      // подбор пароля к «admin» с одного адреса запирал бы вход этим логином
      // для всей компании (аудит, находка №12; план 1.7). Проверяется одинаково
      // для существующих и несуществующих логинов; пароль при блокировке не
      // проверяется, и попытка нейтральна для задержки по учётной записи
      // (outcome остаётся 'neutral').
      if (isRateLimited(lockKey, loginLockOptions())) {
        await dummyVerify(password); // приманка теми же параметрами scrypt; может бросить BUSY (нейтрально)
        throw invalidCredentials();
      }

      const startedAt = Date.now();
      let ok = false;
      let needsRehash = false;
      if (active) {
        // BUSY (очередь хэшей переполнена) бросается ДО установки outcome:
        // и для существующего, и для несуществующего логина перегрузка
        // нейтральна для счётчиков — иначе занятость очереди сама становилась
        // бы оракулом (проверка раунда 4, ПР-03б).
        ({ ok, needsRehash } = await verifyPassword(password, row.password_hash, row.salt));
        if (!needsRehash && typeof password === 'string' && password) noteFullVerify(Date.now() - startedAt);
      } else {
        await dummyVerify(password); // то же время, что и настоящая проверка; тоже может бросить BUSY
      }

      if (!ok) {
        // Пароль подтверждённо неверен (или логина нет/он отключён) — только
        // теперь это неудача: BUSY выше сюда не доходит и в счёт не идёт.
        outcome = 'failure';
        await this.registerFailedAttempt({ nameKey, userId: row?.id ?? null, ip });
        // Пароль хранится с прежними, более дешёвыми параметрами — отказ
        // выдерживается до длительности обычной проверки (Р4-09).
        if (active && needsRehash) await padToFullVerify(password, startedAt);
        throw invalidCredentials();
      }
      outcome = 'success';

      // Проверяется ПОСЛЕ пароля: иначе по разным ответам можно было бы
      // перебором выяснять, какие заявки поданы.
      if (row.approval_status === 'pending') {
        throw Object.assign(new Error('Заявка на регистрацию ещё не подтверждена администратором'), { code: 'ACCOUNT_PENDING' });
      }
      if (row.approval_status === 'rejected') {
        throw Object.assign(new Error('Заявка на регистрацию отклонена. Обратитесь к администратору.'), { code: 'ACCOUNT_REJECTED' });
      }
      if (row.approval_status === 'deleted') throw invalidCredentials();

      return await this.completeLogin(row, password, { ip, nameKey, ipKey, needsRehash });
    } finally {
      LoginThrottle.settle(admission.ticket, outcome);
    }
  }

  // Вторая половина входа — пароль уже подошёл.
  static async completeLogin(row, password, { ip, nameKey, ipKey, needsRehash }) {
    const db = identity();

    // Пароль, сохранённый прежним способом (или с устаревшими параметрами),
    // пересчитывается прямо здесь: другого момента, когда открытый пароль
    // известен серверу, не бывает.
    if (needsRehash) {
      try {
        const encoded = await hashPassword(password);
        await db.run('UPDATE users SET password_hash = $1, salt = NULL WHERE id = $2', [
          encoded,
          row.id
        ]);
      } catch (err) {
        console.warn('[Auth] не удалось обновить формат пароля:', err.message);
      }
    }

    const nowIso = new Date().toISOString();
    // Старые учётные записи с паролем вроде «123456» заводились до появления
    // политики. Верный, но слабый пароль пускает — и сразу требует сменить.
    const weak = UserService.isWeakPassword(String(password));
    await db.run(
      `UPDATE users
       SET status = 'online', last_seen = $1, last_login_at = $1, last_login_ip = $2,
           must_change_password = CASE WHEN $4 = 1 THEN 1 ELSE must_change_password END
       WHERE id = $3`,
      [nowIso, ip, row.id, weak ? 1 : 0]
    );

    // Успешный вход снимает накопленные неудачи по этой же паре адрес+логин —
    // иначе они продолжают копиться к следующей блокировке (аудит ревью,
    // находка №19). Суточную корзину сбрасывает settle('success') в login() —
    // но ТОЛЬКО свою: успех со знакомого адреса чистит F, с незнакомого — U,
    // и другой класс не трогает (иначе офисный вход дарил бы подбору бюджет).
    // Адрес запоминается как знакомый.
    resetLimit(loginLockKey(ip, nameKey), { scope: 'name' });
    LoginThrottle.rememberSuccess(nameKey, ipKey);
    // Адрес удачного входа по паролю — знакомый и после перезапуска; вход по
    // паролю вправе завести новый знакомый адрес (ПР-I4, I-2).
    require('./trusted-sources.service').recordAsync(row.id, ipKey, { allowCreate: true });

    const user = await UserService.getUserById(row.id);
    return { user, token: this.generateToken(user) };
  }

  /**
   * Счётчик неудачных попыток живёт в памяти процесса, по паре адрес+логин, а
   * не по учётной записи в базе (см. комментарий в login()). После порога эта
   * пара временно не пускает ко входу — достаточно долго, чтобы подбор стал
   * бессмысленным, и не трогая ни владельца с другого места, ни коллегу,
   * которого атакующий этим же логином не запирает нигде, кроме своего адреса.
   */
  static async registerFailedAttempt({ nameKey, userId = null, ip }) {
    const key = loginLockKey(ip, nameKey); // та же единая форма, что и при проверке
    const opts = loginLockOptions();
    const wasLocked = isRateLimited(key, opts);
    registerFailure(key, opts);
    if (wasLocked) return; // уже заблокирован этой парой — событие не повторяется

    if (isRateLimited(key, opts)) {
      // Порог только что достигнут для этой пары адрес+логин. Событие и запись
      // в статистику — только для реально существующей учётной записи: для
      // несуществующего логина (userId = null) их нет, но это ненаблюдаемо для
      // атакующего (тот же ответ, то же время), а счёт в ограничителе выше уже
      // одинаков для обоих — этого достаточно, чтобы путь не расходился (ПР-03).
      if (userId === null) return;
      markUsernameLocked(nameKey, opts.windowMs);

      // В центр безопасности событие уходит только для учётной записи
      // администратора: рядовой сотрудник, несколько раз ошибившийся паролем,
      // тревоги поднимать не должен (план 1.7, аудит, находка №12).
      const account = await UserService.getUserById(userId);
      if (account?.permissions?.is_admin || account?.permissions?.is_scoped_admin) {
        require('./audit.service').log({
          userId,
          action: 'account_locked',
          ip,
          details: { minutes: config.LOGIN_LOCKOUT_MINUTES, username: nameKey }
        });
      }
      console.warn(
        `[Auth] Вход в учётную запись "${nameKey}" с адреса ${ip || 'неизвестно'} заблокирован на ` +
          `${config.LOGIN_LOCKOUT_MINUTES} мин. после ${config.LOGIN_MAX_FAILED_ATTEMPTS} неудачных попыток.`
      );
    }
  }

  static async register(userData) {
    const db = identity();
    // role_id намеренно НЕ берётся из userData: этот маршрут доступен без
    // авторизации, пока включена самостоятельная регистрация, и роль из тела
    // запроса позволила бы зарегистрироваться сразу суперадминистратором.
    const { username, password, full_name, email, phone, job_title, department_id } = userData || {};

    const login = String(username || '').trim();
    if (!login || !password) throw new Error('Укажите логин и пароль');
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(login)) {
      throw new Error('Логин может состоять из латинских букв, цифр, точки, дефиса и подчёркивания (3–64 символа)');
    }
    UserService.assertPasswordPolicy(password, { username: login });
    // Самостоятельная регистрация доступна без входа — те же пределы формата
    // и длины, что и у администратора, редактирующего чужой профиль (аудит,
    // находка №5): без них анонимная заявка засоряла бы оргструктуру и ленту
    // сообщений именем на десятки килобайт или фишинговым email/телефоном.
    UserService.assertFieldLength(full_name, 'ФИО');
    UserService.assertFieldLength(job_title, 'Должность');
    UserService.assertEmail(email);
    UserService.assertPhone(phone);

    const existing = await db.get('SELECT id FROM users WHERE username = $1', [login]);
    if (existing) {
      throw new Error('Пользователь с таким логином уже существует');
    }

    // Подразделение принимается только из существующих: произвольное число в
    // теле запроса не должно приводить к сотруднику, приписанному в никуда.
    let resolvedDept = null;
    if (department_id) {
      const dept = await db.get('SELECT id FROM departments WHERE id = $1', [Number(department_id)]);
      resolvedDept = dept ? dept.id : null;
    }

    const maxUin = await db.get('SELECT COALESCE(MAX(uin), 0) + 1 AS next FROM users');
    const company = await db.get(`SELECT value FROM server_settings WHERE key = 'company_name'`);
    const defaultRole = await db.get(`SELECT id FROM roles WHERE name = 'Сотрудник'`);

    const encoded = await hashPassword(password);
    const now = new Date().toISOString();

    // Заявка, а не готовая учётная запись: войти можно только после того, как
    // администратор её подтвердит.
    const inserted = await db.run(
      `INSERT INTO users (
         username, password_hash, salt, full_name, email, phone, job_title,
         department_id, role_id, uin, company, created_at, approval_status,
         registered_at, password_changed_at
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $11, $11)
       RETURNING id`,
      [
        login,
        encoded,
        String(full_name || login).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        job_title ? String(job_title).trim() : 'Сотрудник',
        resolvedDept,
        defaultRole ? defaultRole.id : null,
        Number(maxUin?.next || 1),
        company ? company.value : 'Корпоративная сеть',
        now
      ]
    );

    // В общие каналы заявка не добавляется — это произойдёт при одобрении,
    // иначе неподтверждённый человек уже числился бы среди участников.
    return UserService.getUserById(inserted.rows[0].id);
  }

  static async approveUser(userId) {
    const db = identity();
    const res = await db.run(
      `UPDATE users SET approval_status = 'approved' WHERE id = $1 AND approval_status IN ('pending', 'rejected')`,
      [Number(userId)]
    );
    if (!res.changes) throw new Error('Заявка не найдена');

    // Каналы лежат в базе переписки — участие добавляется там.
    require('./message.service').addToDefaultChannels([userId]);

    return UserService.getUserById(userId);
  }

  static async rejectUser(userId) {
    await identity().run(
      `UPDATE users SET approval_status = 'rejected', token_version = token_version + 1
       WHERE id = $1 AND approval_status <> 'deleted'`,
      [Number(userId)]
    );
    return true;
  }

  static getUserById(id) {
    return UserService.getUserById(id);
  }

  // Для панели администратора (DbStudioService.getIdentityStats) — см.
  // countLockedUsernames выше.
  static countLockedAccounts() {
    return countLockedUsernames();
  }

  // Логины под блокировкой пары адрес+логин прямо сейчас — чтобы панель могла
  // объединить их с исчерпавшими суточную корзину без двойного счёта (sec5).
  static lockedUsernames() {
    countLockedUsernames(); // заодно вычищает истёкшие
    return [...lockedUsernamesUntil.keys()];
  }

  // Та же граница, что verifyToken применяет к auth_time токена, — но нужна и
  // ДО выпуска токена (DeviceService.knock, находка №9в): секрет устройства
  // может быть ещё не истёкшим (DEVICE_SECRET_TTL_DAYS, по умолчанию 30 дней),
  // а токен по нему — уже родиться отклонённым, если SESSION_MAX_DAYS короче.
  // Общая функция вместо копии логики — иначе они разошлись бы при следующей
  // правке одной из двух.
  static sessionMaxSeconds() {
    return sessionMaxSeconds();
  }
}

module.exports = AuthService;
