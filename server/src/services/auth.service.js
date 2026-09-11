const crypto = require('node:crypto');
const { identity } = require('../db/identity');
const { hashPassword, verifyPassword } = require('../db/identity/password');
const { getDatabase } = require('../db');
const UserService = require('./user.service');
const config = require('../config');

const INVALID_CREDENTIALS = 'Неверный логин или пароль';

// Хэш-приманка для несуществующего логина: проверка против него занимает
// столько же, сколько настоящая, и отказ не выдаёт себя скоростью. Считается
// один раз и лениво — чтобы не замедлять запуск сервера.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(18).toString('base64url'));
  }
  return dummyHashPromise;
}

class AuthService {
  /**
   * Токен подписывается HMAC-SHA256 на серверном секрете. Помимо кто и когда,
   * в него кладётся token_version — номер поколения учётной записи. При смене
   * пароля, смене роли или отключении сотрудника номер сдвигается, и все ранее
   * выданные токены перестают приниматься немедленно, не дожидаясь истечения
   * недельного срока.
   */
  static generateToken(user) {
    const payload = {
      userId: user.id,
      username: user.username,
      roleId: user.role_id,
      tv: Number(user.token_version || 1),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7
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
      if (!token || typeof token !== 'string') return null;
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

      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Проверяет, что токен всё ещё относится к действующей учётной записи.
   * Вызывается на каждом запросе — здесь же отсекаются токены, выданные до
   * смены пароля или до отключения сотрудника.
   */
  static async resolveSession(token) {
    const payload = this.verifyToken(token);
    if (!payload) return null;

    const user = await UserService.getUserById(payload.userId);
    if (!user || !user.is_active) return null;
    if (user.approval_status !== 'approved') return null;

    // Токены, выпущенные до появления нумерации поколений, поля tv не имеют.
    // Они принимаются только пока поколение первое: иначе однажды сменённый
    // пароль не отозвал бы их.
    const tokenVersion = Number(payload.tv || 1);
    if (tokenVersion !== Number(user.token_version || 1)) return null;

    return user;
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
      const minutes = Math.max(
        1,
        Math.ceil((new Date(row.locked_until).getTime() - now) / 60000)
      );
      throw new Error(
        `Учётная запись временно заблокирована после неудачных попыток входа. Повторите через ${minutes} мин.`
      );
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
    await db.run(
      `UPDATE users
       SET status = 'online', last_seen = $1, last_login_at = $1, last_login_ip = $2,
           failed_login_count = 0, locked_until = NULL
       WHERE id = $3`,
      [nowIso, ip, row.id]
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
