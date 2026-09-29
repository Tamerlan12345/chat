const { identity } = require('../db/identity');
const { hashPassword, verifyPassword } = require('../db/identity/password');
const OrgService = require('./org.service');

// Поля, которые видит любой авторизованный сотрудник. Отсюда намеренно убраны
// bound_ip (адрес рабочего места коллеги — сведение служебное, не справочное),
// admin_scope_dept_id и состояние заявки на регистрацию: справочник сотрудников
// не должен рассказывать о внутреннем устройстве прав доступа.
const PUBLIC_FIELDS = `
  u.id, u.username, u.full_name, u.email, u.phone, u.job_title, u.department_id,
  u.uin, u.extension, u.company, u.role_id, u.avatar_url, u.status,
  u.custom_status, u.last_seen, u.is_active, u.created_at
`;

// Поля для администратора и для самого сотрудника.
const FULL_FIELDS = `
  ${PUBLIC_FIELDS}, u.bound_ip, u.admin_scope_dept_id, u.must_change_password,
  u.approval_status, u.registered_at, u.token_version, u.last_login_at, u.last_login_ip
`;

// То же самое, но без token_version — для контурного администратора в
// справочнике сотрудников. Номер поколения токена сам по себе не секрет, но
// вместе с секретом устройства, который claim'ит один сотрудник, а видит
// другой контурный администратор, он превращался в условие для получения
// чужого токена без пароля (аудит, находка №1). Суперадминистратору поле
// нужно для диагностики и оставлено.
const SCOPED_ADMIN_FIELDS = `
  ${PUBLIC_FIELDS}, u.bound_ip, u.admin_scope_dept_id, u.must_change_password,
  u.approval_status, u.registered_at, u.last_login_at, u.last_login_ip
`;

const JOINS = `
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN departments sd ON sd.id = u.admin_scope_dept_id
`;

const NAMED = `r.name AS role_name, r.permissions_json, d.name AS department_name, sd.name AS admin_scope_dept_name`;

// Те же публичные поля, но для уже загруженной записи: рассылки по WebSocket и
// карточка коллеги. Полная запись в рассылке уходила всем подключённым — с
// адресом рабочего места, последним IP входа и поколением токена.
const PUBLIC_KEYS = [
  'id', 'username', 'full_name', 'email', 'phone', 'job_title', 'department_id',
  'uin', 'extension', 'company', 'role_id', 'avatar_url', 'status',
  'custom_status', 'last_seen', 'is_active', 'created_at', 'department_name', 'role_name'
];

function toPublicUser(user) {
  if (!user) return user;
  const out = {};
  for (const key of PUBLIC_KEYS) {
    if (user[key] !== undefined) out[key] = user[key];
  }
  return out;
}

function withPermissions(user) {
  if (!user) return user;
  user.permissions = safeParse(user.permissions_json);
  return user;
}

// Проверка полей, которые сотрудник или администратор вписывают руками.
// Пределы — не про удобство: без них имя или должность, показанные в каждом
// сообщении и в оргструктуре компании, превращались в способ засорить эфир
// или выдать себя за кого-то ещё (аудит, находка №5).
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_MAX = 32;
const PHONE_RE = /^[0-9+()\-\s]+$/;
const NAME_FIELD_MAX = 120;

function assertEmail(value) {
  if (value === undefined || value === null || value === '') return;
  const email = String(value);
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    throw new Error(`Неверный формат email (не длиннее ${EMAIL_MAX} символов, вида имя@домен.зона)`);
  }
}

function assertPhone(value) {
  if (value === undefined || value === null || value === '') return;
  const phone = String(value);
  if (phone.length > PHONE_MAX || !PHONE_RE.test(phone)) {
    throw new Error(`Неверный формат телефона (не длиннее ${PHONE_MAX} символов: цифры, пробел, + ( ) -)`);
  }
}

function assertFieldLength(value, label, max = NAME_FIELD_MAX) {
  if (value === undefined || value === null || value === '') return;
  if (String(value).length > max) {
    throw new Error(`${label} — не длиннее ${max} символов`);
  }
}

function safeParse(json) {
  if (!json) return {};
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

class UserService {
  static toPublicUser(user) {
    return toPublicUser(user);
  }

  // Та же граница, что getAllUsers применяет через SCOPED_ADMIN_FIELDS —
  // token_version вместе с секретом устройства, который claim'ит один
  // сотрудник, открывал бы контурному администратору вход без пароля под ним
  // (аудит, находка №1). PUT /admin/users/:id раньше отдавал полную запись
  // (adminUpdateUser читает её через getUserById → FULL_FIELDS) в обход этого
  // правила — тот же ответ, тот же контурный администратор, то же поле.
  static hideAdminOnlyFields(record, actor) {
    if (record && actor?.permissions?.is_scoped_admin) {
      const { token_version, ...rest } = record;
      return rest;
    }
    return record;
  }

  /**
   * Справочник сотрудников. Администратору подразделения возвращаются только
   * его люди — иначе «контур» ничего не ограничивает.
   */
  static async getAllUsers(adminUser = null) {
    const db = identity();

    // Администратор подразделения без подразделения (его удалили) не должен
    // получать полный список сотрудников компании со служебными полями.
    if (adminUser?.permissions?.is_scoped_admin && !adminUser.admin_scope_dept_id) return [];

    let allowedDeptIds = null;
    if (adminUser && adminUser.admin_scope_dept_id) {
      allowedDeptIds = await OrgService.getSubtreeDepartmentIds(adminUser.admin_scope_dept_id);
    }

    const isScopedAdminCaller = Boolean(adminUser?.permissions?.is_scoped_admin);
    const fields = !adminUser ? PUBLIC_FIELDS : isScopedAdminCaller ? SCOPED_ADMIN_FIELDS : FULL_FIELDS;
    const pairing = adminUser
      ? `, dp.device_name AS paired_device_name, dp.device_id AS paired_device_id`
      : '';
    const pairingJoin = adminUser
      ? `LEFT JOIN device_pairings dp ON dp.user_id = u.id AND dp.is_active = 1`
      : '';

    if (allowedDeptIds && allowedDeptIds.length) {
      const placeholders = allowedDeptIds.map((_, i) => `$${i + 1}`).join(', ');
      return db.all(
        `SELECT ${fields}, ${NAMED}${pairing} ${JOINS} ${pairingJoin}
         WHERE u.department_id IN (${placeholders})
         ORDER BY u.full_name ASC`,
        allowedDeptIds
      );
    }

    // Справочник для сотрудников — только подтверждённые учётные записи:
    // ожидающие и отклонённые заявки видят администраторы в разделе заявок.
    const approvedOnly = adminUser ? '' : "WHERE u.approval_status = 'approved'";
    return db.all(
      `SELECT ${fields}, ${NAMED}${pairing} ${JOINS} ${pairingJoin} ${approvedOnly} ORDER BY u.full_name ASC`
    );
  }

  static async getUserById(id) {
    if (id === null || id === undefined || Number.isNaN(Number(id))) return null;
    const user = await identity().get(
      `SELECT ${FULL_FIELDS}, ${NAMED} ${JOINS} WHERE u.id = $1`,
      [Number(id)]
    );
    return withPermissions(user);
  }

  static async getUserByUsername(username) {
    const user = await identity().get(
      `SELECT ${FULL_FIELDS}, ${NAMED} ${JOINS} WHERE u.username = $1`,
      [String(username)]
    );
    return withPermissions(user);
  }

  /**
   * Краткие сведения о нескольких сотрудниках разом. Переписка лежит в другой
   * базе, поэтому имя отправителя к сообщению больше не приклеивается
   * соединением таблиц — оно берётся отсюда одним запросом на страницу
   * сообщений, а не по запросу на каждое.
   */
  static async getDirectory(ids) {
    const unique = [...new Set((ids || []).map(Number).filter((n) => Number.isFinite(n)))];
    if (!unique.length) return new Map();

    const placeholders = unique.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await identity().all(
      `SELECT u.id, u.username, u.full_name, u.avatar_url, u.job_title, u.status,
              u.uin, u.extension, u.email, u.phone, u.company, u.custom_status,
              d.name AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.id IN (${placeholders})`,
      unique
    );

    return new Map(rows.map((row) => [Number(row.id), row]));
  }

  /**
   * Поиск сотрудника по имени или логину. Нужен там, где искать приходится в
   * двух базах сразу: переписка ищется по тексту у себя, люди — здесь.
   */
  static async searchByName(term, limit = 50) {
    const needle = `%${String(term || '').trim().toLowerCase()}%`;
    if (needle === '%%') return [];
    return identity().all(
      `SELECT u.id, u.username, u.full_name, u.uin
       FROM users u
       WHERE LOWER(u.full_name) LIKE $1 OR LOWER(u.username) LIKE $1
       ORDER BY u.full_name ASC
       LIMIT $2`,
      [needle, Math.min(Math.max(Number(limit) || 50, 1), 200)]
    );
  }

  static async updateStatus(userId, status, customStatus = null) {
    const allowed = new Set(['online', 'away', 'dnd', 'offline']);
    const next = allowed.has(status) ? status : 'offline';
    await identity().run(
      `UPDATE users SET status = $1, custom_status = $2, last_seen = $3 WHERE id = $4`,
      [next, customStatus ?? null, new Date().toISOString(), Number(userId)]
    );
    return this.getUserById(userId);
  }

  static async updateProfile(userId, { email, phone, avatar_url, custom_status } = {}) {
    // ФИО и должность в это тело даже не принимаются — деструктуризация выше
    // намеренно их не берёт. Эти поля показывают отправителя в каждом
    // сообщении, оргструктуре и списке сотрудников: разреши их самому себе,
    // и сотрудник назовётся «Служба поддержки» или директором для фишинга
    // (план 1.8.3, аудит, находка №5). Меняет их только администратор —
    // см. adminUpdateUser.
    assertEmail(email);
    assertPhone(phone);
    // Фотография уходит каждому сотруднику в каждом ответе справочника. Снимок
    // с телефона на 8 МБ в data URL превращал список сотрудников в десятки
    // мегабайт, а произвольная строка — в ссылку куда угодно.
    // Проверяется только новая фотография: форма профиля отправляет текущую
    // обратно при каждом сохранении, и сотрудник со старой фотографией
    // (ссылкой или крупным снимком) иначе не смог бы поправить даже телефон.
    const currentAvatar =
      avatar_url !== undefined && avatar_url !== null && avatar_url !== ''
        ? (await identity().get('SELECT avatar_url FROM users WHERE id = $1', [Number(userId)]))?.avatar_url
        : null;
    if (avatar_url !== undefined && avatar_url !== null && avatar_url !== '' && String(avatar_url) !== String(currentAvatar ?? '')) {
      const value = String(avatar_url);
      const isImageData = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
      if (!isImageData) throw new Error('Фотография профиля должна быть изображением PNG, JPEG, GIF или WebP');
      if (value.length > 700 * 1024) throw new Error('Фотография слишком большая — выберите файл до 500 КБ');
    }
    if (custom_status !== undefined && custom_status !== null && String(custom_status).length > 200) {
      throw new Error('Подпись статуса — не длиннее 200 символов');
    }
    // COALESCE рассчитан на NULL: незаполненное поле формы приходит как
    // undefined, и связать его с параметром нельзя — из-за этого сохранение
    // профиля когда-то не срабатывало вовсе, причём молча.
    const orNull = (v) => (v === undefined ? null : v);
    await identity().run(
      `UPDATE users
       SET email = COALESCE($1, email),
           phone = COALESCE($2, phone),
           avatar_url = COALESCE($3, avatar_url),
           custom_status = COALESCE($4, custom_status)
       WHERE id = $5`,
      [orNull(email), orNull(phone), orNull(avatar_url), orNull(custom_status), Number(userId)]
    );
    return this.getUserById(userId);
  }

  static async changePassword(userId, oldPassword, newPassword) {
    const db = identity();
    const row = await db.get('SELECT password_hash, salt FROM users WHERE id = $1', [Number(userId)]);
    if (!row) throw new Error('Пользователь не найден');

    if (!oldPassword) throw new Error('Укажите текущий пароль для подтверждения смены');
    const { ok } = await verifyPassword(oldPassword, row.password_hash, row.salt);
    if (!ok) throw new Error('Старый пароль неверен');

    assertPasswordPolicy(newPassword);
    if (newPassword === oldPassword) {
      throw new Error('Новый пароль должен отличаться от текущего');
    }

    await this.setPassword(userId, newPassword, { mustChange: false });
    return true;
  }

  /**
   * Сброс пароля администратором. Если пароль не задан, он не «сбрасывается на
   * 123456», как было раньше, а генерируется случайным: между сбросом и первым
   * входом сотрудника проходит время, и всё это время общеизвестный пароль —
   * открытая дверь в чужую учётную запись. Сменить его всё равно придётся при
   * первом же входе.
   *
   * @returns {Promise<{ password: string, generated: boolean }>}
   */
  static async adminResetPassword(userId, newPassword = null) {
    const generated = !newPassword;
    const password = newPassword || generateTempPassword();
    // Пароль, придуманный администратором, проходит ту же политику: «1» или
    // «123456» до первой смены защищают учётную запись ничем.
    assertPasswordPolicy(password);
    await this.setPassword(userId, password, { mustChange: true });
    return { password, generated };
  }

  /**
   * Единственное место, где меняется пароль. Вместе с ним всегда сдвигается
   * token_version: выданные раньше токены перестают действовать сразу, а не
   * доживают свои семь дней. Ради этого всё и собрано в одну функцию — смена
   * пароля, после которой чужая сессия продолжает работать, защищает только
   * на словах.
   */
  static async setPassword(userId, newPassword, { mustChange = false } = {}) {
    const encoded = await hashPassword(newPassword);
    const now = new Date().toISOString();
    await identity().run(
      `UPDATE users
       SET password_hash = $1, salt = NULL, must_change_password = $2,
           password_changed_at = $3, token_version = token_version + 1,
           failed_login_count = 0, locked_until = NULL
       WHERE id = $4`,
      [encoded, mustChange ? 1 : 0, now, Number(userId)]
    );
  }

  static async setMustChangePassword(userId, required) {
    await identity().run('UPDATE users SET must_change_password = $1 WHERE id = $2', [
      required ? 1 : 0,
      Number(userId)
    ]);
    return true;
  }

  static async createUser({
    username, full_name, email, phone, job_title, department_id, role_id,
    extension, uin, password, bound_ip, admin_scope_dept_id
  }) {
    const db = identity();
    if (!username || !full_name) {
      throw new Error('Логин и ФИО обязательны для заполнения');
    }

    const login = String(username).trim();
    const existing = await db.get('SELECT id FROM users WHERE username = $1', [login]);
    if (existing) {
      throw new Error(`Пользователь с логином "${login}" уже существует`);
    }

    // Какой бы пароль ни задал администратор, защищает учётную запись не он, а
    // требование сменить его при первом входе. Если пароль не задан вовсе,
    // он генерируется — общего для всех новых сотрудников пароля быть не должно.
    const initial = password || generateTempPassword();
    assertPasswordPolicy(initial);
    const encoded = await hashPassword(initial);

    const assignedUin = uin ? parseInt(uin, 10) : Math.floor(1000 + Math.random() * 9000);
    const now = new Date().toISOString();

    // «Сотрудник» — не обязательно роль номер 2: миграции вставляли роли с
    // явными идентификаторами, и нумерация сдвигалась. Ищется по названию.
    const defaultRole = await db.get(`SELECT id FROM roles WHERE name = 'Сотрудник'`);
    const resolvedRoleId = role_id ? Number(role_id) : defaultRole ? defaultRole.id : null;

    const inserted = await db.run(
      `INSERT INTO users (
         username, password_hash, salt, full_name, email, phone, job_title,
         department_id, role_id, uin, extension, company, bound_ip,
         admin_scope_dept_id, status, created_at, is_active, must_change_password,
         approval_status, password_changed_at
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 'offline', $14, 1, 1, 'approved', $14)
       RETURNING id`,
      [
        login,
        encoded,
        String(full_name).trim(),
        email ? String(email).trim() : `${login}@cic.kz`,
        phone || '',
        job_title || 'Сотрудник',
        department_id ? Number(department_id) : null,
        resolvedRoleId,
        assignedUin,
        extension ? String(extension).trim() : '',
        'АО "Страховая компания "Сентрас Иншуранс"',
        bound_ip ? String(bound_ip).trim() : null,
        admin_scope_dept_id ? Number(admin_scope_dept_id) : null,
        now
      ]
    );

    const created = await this.getUserById(inserted.rows[0].id);
    // Сгенерированный пароль администратору надо показать — иначе передать его
    // сотруднику будет нечем. Заданный им самим не возвращается: он его знает.
    if (!password) created.initial_password = initial;
    return created;
  }

  static async adminUpdateUser(userId, {
    username, full_name, email, phone, job_title, department_id, role_id,
    extension, uin, is_active, bound_ip, admin_scope_dept_id, must_change_password
  }) {
    // Администратору эти поля доступны, но не без границ: те же форматы для
    // email/телефона, что и в самостоятельном изменении профиля, и предел
    // длины для ФИО/должности — их точно так же видит вся компания в каждом
    // сообщении и в оргструктуре (аудит, находка №5).
    assertEmail(email);
    assertPhone(phone);
    assertFieldLength(full_name, 'ФИО', NAME_FIELD_MAX);
    assertFieldLength(job_title, 'Должность', NAME_FIELD_MAX);

    const db = identity();
    const user = await this.getUserById(userId);
    if (!user) throw new Error('Пользователь не найден');

    if (username && String(username).trim() !== user.username) {
      const taken = await db.get('SELECT id FROM users WHERE username = $1 AND id <> $2', [
        String(username).trim(),
        Number(userId)
      ]);
      if (taken) throw new Error(`Логин "${String(username).trim()}" уже занят другим сотрудником`);
    }

    const deactivating = is_active !== undefined && !Number(is_active) && user.is_active;

    await db.run(
      `UPDATE users
       SET username = COALESCE($1, username),
           full_name = COALESCE($2, full_name),
           email = COALESCE($3, email),
           phone = COALESCE($4, phone),
           job_title = COALESCE($5, job_title),
           department_id = $6,
           role_id = COALESCE($7, role_id),
           extension = COALESCE($8, extension),
           uin = COALESCE($9, uin),
           is_active = COALESCE($10, is_active),
           bound_ip = $11,
           admin_scope_dept_id = $12,
           must_change_password = COALESCE($13, must_change_password),
           token_version = token_version + $14
       WHERE id = $15`,
      [
        username ? String(username).trim() : null,
        full_name ? String(full_name).trim() : null,
        email ? String(email).trim() : null,
        phone !== undefined ? phone : null,
        job_title ? String(job_title).trim() : null,
        department_id !== undefined ? (department_id ? Number(department_id) : null) : user.department_id,
        role_id ? Number(role_id) : null,
        extension !== undefined ? String(extension).trim() : null,
        uin ? Number(uin) : null,
        is_active !== undefined ? Number(Boolean(Number(is_active))) : null,
        bound_ip !== undefined ? (bound_ip ? String(bound_ip).trim() : null) : user.bound_ip,
        admin_scope_dept_id !== undefined
          ? (admin_scope_dept_id ? Number(admin_scope_dept_id) : null)
          : user.admin_scope_dept_id,
        must_change_password !== undefined ? Number(Boolean(must_change_password)) : null,
        // Смена роли или отключение учётной записи должны обрывать уже выданные
        // токены: иначе понижённый в правах сотрудник доработает неделю со
        // старыми правами в кармане.
        deactivating || (role_id && Number(role_id) !== user.role_id) ? 1 : 0,
        Number(userId)
      ]
    );

    return this.getUserById(userId);
  }

  static async toggleUserActive(userId, is_active) {
    const user = await this.getUserById(userId);
    if (!user) throw new Error('Пользователь не найден');

    const next = is_active !== undefined ? (is_active ? 1 : 0) : user.is_active ? 0 : 1;
    await identity().run(
      `UPDATE users
       SET is_active = $1,
           status = CASE WHEN $1 = 0 THEN 'offline' ELSE status END,
           token_version = token_version + CASE WHEN $1 = 0 THEN 1 ELSE 0 END
       WHERE id = $2`,
      [next, Number(userId)]
    );

    return this.getUserById(userId);
  }
}

// Требования к паролю намеренно скромные: восемь символов и запрет на десяток
// общеизвестных. Более жёсткие правила в корпоративной среде дают обратный
// результат — пароль переезжает на бумажку под клавиатурой. Начальный пароль,
// который сотрудник обязан сменить при первом входе, под правило не подпадает.
const WEAK = new Set([
  '123456', '1234567', '12345678', '123456789', 'password', 'qwerty', 'qwerty123',
  '111111', '000000', 'admin', 'admin123', 'пароль', 'йцукен'
]);

// Временный пароль для передачи сотруднику из рук в руки. Алфавит без символов,
// которые невозможно продиктовать без ошибки: 0/O, 1/l/I, 5/S.
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZabcdefghjkmnpqrtuvwxyz2346789';

function generateTempPassword(length = 14) {
  const bytes = require('node:crypto').randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TEMP_ALPHABET[bytes[i] % TEMP_ALPHABET.length];
  }
  return out;
}

function assertPasswordPolicy(password, { allowWeakInitial = false } = {}) {
  if (typeof password !== 'string' || !password) {
    throw new Error('Укажите новый пароль');
  }
  if (allowWeakInitial) return;
  if (password.length < 8) {
    throw new Error('Пароль должен быть не короче 8 символов');
  }
  if (WEAK.has(password.toLowerCase())) {
    throw new Error('Такой пароль слишком простой — подберите другой');
  }
}

module.exports = UserService;
module.exports.assertPasswordPolicy = assertPasswordPolicy;
// Переиспользуются в AuthService.register (самостоятельная регистрация) —
// те же пределы формата и длины, что и у administratorа, редактирующего
// профиль сотрудника (аудит, находка №5): анонимная заявка — тот же чужой
// ввод, что и тело PUT /admin/users/:id.
module.exports.assertEmail = assertEmail;
module.exports.assertPhone = assertPhone;
module.exports.assertFieldLength = assertFieldLength;
module.exports.NAME_FIELD_MAX = NAME_FIELD_MAX;
module.exports.isWeakPassword = (password) => {
  try {
    assertPasswordPolicy(password);
    return false;
  } catch {
    return true;
  }
};
module.exports.generateTempPassword = generateTempPassword;
