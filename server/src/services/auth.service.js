const crypto = require('node:crypto');
const { identity } = require('../db/identity');
const { hashPassword, verifyPassword } = require('../db/identity/password');
const { getDatabase } = require('../db');
const UserService = require('./user.service');
const config = require('../config');

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
  }
  return dummyHashPromise;
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
      // Принимаются до своего срока, чтобы обновление сервера не выбросило всех
      // разом; новых таких не выдаётся.
      if (payload.exp > 1e11) {
        if (payload.exp < nowMs) return null;
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
    const db = identity();
    const row = await db.get(
      `SELECT u.id, u.username, u.password_hash, u.salt, u.is_active, u.approval_status,
              u.failed_login_count, u.locked_until, u.token_version
       FROM users u WHERE u.username = $1`,
      [String(username || '').trim()]
    );

    // Отсутствующий, отключённый сотрудник и неверный пароль отвечают одним и
    // тем же сообщением и за одно и то же время: по разнице ответов (или по
    // секундомеру — scrypt идёт сотни миллисекунд) перебором выясняется, какие
    // логины заведены в компании.
    if (!row || !row.is_active) {
      await verifyPassword(password, await dummyHash()).catch(() => {});
      throw new Error(INVALID_CREDENTIALS);
    }

    const now = Date.now();
    if (row.locked_until && new Date(row.locked_until).getTime() > now) {
      await verifyPassword(password, await dummyHash()).catch(() => {});
      throw new Error(INVALID_CREDENTIALS);
    }

    const { ok, needsRehash } = await verifyPassword(password, row.password_hash, row.salt);
    if (!ok) {
      await this.registerFailedAttempt(row);
      throw new Error(INVALID_CREDENTIALS);
    }

    // Проверяется ПОСЛЕ пароля: иначе по разным ответам можно было бы
    // перебором выяснять, какие заявки поданы.
    if (row.approval_status === 'pending') {
      throw new Error('Заявка на регистрацию ещё не подтверждена администратором');
    }
    if (row.approval_status === 'rejected') {
      throw new Error('Заявка на регистрацию отклонена. Обратитесь к администратору.');
    }

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
           failed_login_count = 0, locked_until = NULL,
           must_change_password = CASE WHEN $4 = 1 THEN 1 ELSE must_change_password END
       WHERE id = $3`,
      [nowIso, ip, row.id, weak ? 1 : 0]
    );

    const user = await UserService.getUserById(row.id);
    return { user, token: this.generateToken(user) };
  }

  /**
   * Счётчик неудачных попыток живёт в базе, а не в памяти процесса: иначе
   * перезапуск сервера или смена адреса возобновляют подбор с нуля. После
   * порога учётная запись запирается на короткий срок — достаточный, чтобы
   * подбор стал бессмысленным, и слишком короткий, чтобы им травить коллегу.
   */
  static async registerFailedAttempt(row) {
    const attempts = Number(row.failed_login_count || 0) + 1;
    const reachedLimit = attempts >= config.LOGIN_MAX_FAILED_ATTEMPTS;
    const lockedUntil = reachedLimit
      ? new Date(Date.now() + config.LOGIN_LOCKOUT_MINUTES * 60000).toISOString()
      : null;

    await identity().run(
      `UPDATE users SET failed_login_count = $1, locked_until = COALESCE($2, locked_until) WHERE id = $3`,
      [reachedLimit ? 0 : attempts, lockedUntil, row.id]
    );

    if (reachedLimit) {
      require('./audit.service').log({ userId: row.id, action: 'account_locked', details: { minutes: config.LOGIN_LOCKOUT_MINUTES } });
      console.warn(
        `[Auth] Учётная запись "${row.username}" заблокирована на ${config.LOGIN_LOCKOUT_MINUTES} мин. ` +
          `после ${config.LOGIN_MAX_FAILED_ATTEMPTS} неудачных попыток входа.`
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
    UserService.assertPasswordPolicy(password);

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
    await db.run(`UPDATE users SET approval_status = 'approved' WHERE id = $1`, [Number(userId)]);

    // Каналы лежат в базе переписки — участие добавляется там.
    require('./message.service').addToDefaultChannels([userId]);

    return UserService.getUserById(userId);
  }

  static async rejectUser(userId) {
    await identity().run(
      `UPDATE users SET approval_status = 'rejected', is_active = 0, token_version = token_version + 1
       WHERE id = $1`,
      [Number(userId)]
    );
    return true;
  }

  static getUserById(id) {
    return UserService.getUserById(id);
  }
}

module.exports = AuthService;
