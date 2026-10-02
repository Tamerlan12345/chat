const { identity } = require('../db/identity');
const { hashPassword, verifyPassword } = require('../db/identity/password');
const OrgService = require('./org.service');

// Экранирование спецсимволов LIKE (% _ \): строка поиска сотрудника ищется
// буквально. Пара к ESCAPE '\' в запросе; работает в SQLite и PostgreSQL.
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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
    // Длина ограничена, а % и _ экранированы: строка ищется буквально, а не
    // как шаблон, и «%%%…» не превращается в дорогой перебор (проверка
    // раунда 4, M1). ESCAPE '\' работает и в SQLite, и в PostgreSQL.
    const raw = String(term || '').trim().toLowerCase().slice(0, 200);
    if (!raw) return [];
    const needle = `%${escapeLike(raw)}%`;
    return identity().all(
      `SELECT u.id, u.username, u.full_name, u.uin
       FROM users u
       WHERE LOWER(u.full_name) LIKE $1 ESCAPE '\\' OR LOWER(u.username) LIKE $1 ESCAPE '\\'
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
    // Клиент, получивший профиль с адресом фото (/api/users/<id>/avatar?v=…,
    // задача 20), отправляет его обратно при сохранении — это «фото не
    // менялось», а не новое значение.
    if (require('../media/avatars').isOwnAvatarUrl(userId, avatar_url)) avatar_url = undefined;
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

  // Фото, уже перекодированное сервером (PUT /api/users/avatar), или null —
  // снять. Проверок формата здесь нет: значение собирает сам сервер.
  static async setAvatar(userId, dataUrl) {
    await identity().run('UPDATE users SET avatar_url = $1 WHERE id = $2', [dataUrl, Number(userId)]);
    return this.getUserById(userId);
  }

  static async changePassword(userId, oldPassword, newPassword) {
    const db = identity();
    const row = await db.get(
      'SELECT username, password_hash, salt FROM users WHERE id = $1',
      [Number(userId)]
    );
    if (!row) throw new Error('Пользователь не найден');

    if (!oldPassword) throw new Error('Укажите текущий пароль для подтверждения смены');

    // Смену пароля вызывает уже вошедший сотрудник (действующий токен). Её НЕ
    // гейтит задержка по учётной записи, которую способен раскрутить кто-то
    // снаружи: иначе посторонний, засыпав чужой логин на входе, заодно
    // блокировал бы владельцу смену пароля (проверка раунда 4, ПР-I4). От
    // подбора текущего пароля с украденным токеном защищает отдельный предел
    // на сотрудника (маршрут /users/password, ключ pwchange-fail).
    const { ok } = await verifyPassword(oldPassword, row.password_hash, row.salt);
    if (!ok) {
      const err = new Error('Старый пароль неверен');
      err.code = 'OLD_PASSWORD_INVALID';
      throw err;
    }

    assertPasswordPolicy(newPassword, { username: row.username });
    if (newPassword === oldPassword) {
      throw new Error('Новый пароль должен отличаться от текущего');
    }

    // Самостоятельная смена снимает только корзину P (неверный текущий пароль
    // при смене), но НЕ корзины входа U/F: иначе каждая смена пароля владельцем
    // дарила бы постороннему, исчерпавшему U, свежие догадки (sec5).
    await this.setPassword(userId, newPassword, { mustChange: false, clearLoginBudgets: false });
    require('./login-throttle.service').clearPasswordChange(row.username, { userId });
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
    // «123456» до первой смены защищают учётную запись ничем. «Пароль равен
    // логину» — тоже: логин коллеги знает любой в компании.
    const target = newPassword
      ? await identity().get('SELECT username FROM users WHERE id = $1', [Number(userId)])
      : null;
    assertPasswordPolicy(password, { username: target?.username });
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
  static async setPassword(userId, newPassword, { mustChange = false, clearLoginBudgets = true } = {}) {
    const encoded = await hashPassword(newPassword);
    const now = new Date().toISOString();
    const row = await identity().get('SELECT username FROM users WHERE id = $1', [Number(userId)]);
    await identity().run(
      `UPDATE users
       SET password_hash = $1, salt = NULL, must_change_password = $2,
           password_changed_at = $3, token_version = token_version + 1,
           failed_login_count = 0, locked_until = NULL
       WHERE id = $4`,
      [encoded, mustChange ? 1 : 0, now, Number(userId)]
    );
    // Сброс пароля администратором снимает наказание с учётной записи целиком
    // (все три суточные корзины U/F/P и персональные задержки): администратор
    // сам решил, что сотрудник должен снова входить откуда угодно. userId нужен,
    // чтобы вычистить и персистентный журнал login_failure_log (sec5).
    // Самостоятельная смена (changePassword) передаёт clearLoginBudgets: false.
    if (clearLoginBudgets) {
      require('./login-throttle.service').clearAccount(row?.username, { userId });
    }
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
    assertPasswordPolicy(initial, { username: login });
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

// Требования к паролю намеренно скромные: восемь символов и запрет на
// общеизвестные. Более жёсткие правила в корпоративной среде дают обратный
// результат — пароль переезжает на бумажку под клавиатурой. Начальный пароль,
// который сотрудник обязан сменить при первом входе, под правило не подпадает.
//
// WEAK — прежний, короткий список. По нему (и по длине) решается, требовать
// ли смену пароля ПРИ ВХОДЕ (isWeakPassword → must_change_password). Он
// намеренно не расширяется: новые правила ниже действуют только при задании
// и смене пароля, а уже существующий пароль продолжает пускать как раньше —
// иначе выкладка выпуска разом отправила бы на смену пароля всех, кого
// раньше правило устраивало (аудит, раунд 4, находка Р4-08).
const WEAK = new Set([
  '123456', '1234567', '12345678', '123456789', 'password', 'qwerty', 'qwerty123',
  '111111', '000000', 'admin', 'admin123', 'пароль', 'йцукен'
]);

// Самые распространённые пароли из открытых списков утечек (длиной от 8
// символов — короче и так не пройдут), клавиатурные ряды в обеих раскладках,
// русские слова, набранные в латинской раскладке, и очевидное для компании.
// Сравнение — после NFKC и в нижнем регистре. Список встроен, без внешней
// зависимости: смысл в том, чтобы отсечь первые сотни догадок любого
// подбора, а не заменить собой словарь.
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '0123456789', '87654321', '987654321',
  '11111111', '00000000', '22222222', '55555555', '66666666', '77777777', '88888888', '99999999',
  '12121212', '11223344', '12341234', '12344321', '123123123', '147258369', '159753456', '123654789',
  '12qwaszx', '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4', 'q1w2e3r4t5', '1qaz2wsx', '1qazxsw2',
  'zaq12wsx', 'zaq1zaq1', 'qazwsxedc', 'qweasdzxc', '123qweasd', '123qwe123', 'qwe12345', 'qwer1234',
  '1234qwer', 'asd12345', 'abc12345', 'abcd1234', '1234abcd', 'aa123456', 'qwerty12', 'qwerty123',
  'qwerty1234', 'qwertyui', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'zxcvbnm123', 'qwerasdf',
  'password', 'password1', 'password12', 'password123', 'password!', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  'pa$$w0rd', 'welcome1', 'welcome123', 'welcome01', 'letmein1', 'changeme', 'changeme1', 'trustno1',
  'iloveyou', 'iloveyou1', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'starwars',
  'whatever', 'computer', 'internet', 'michael1', 'jennifer', 'dragon12', 'master12', 'monkey12',
  'shadow12', 'admin123', 'admin1234', 'administrator', 'root1234', 'user1234', 'test1234', 'testtest',
  'default1', 'secret12', 'qwerty!@', 'q1w2e3r4!', 'asdf1234', 'zxcv1234',
  // Русские: сам пароль, ряды клавиатуры, русские слова в латинской раскладке.
  'пароль12', 'пароль123', 'пароль1234', 'йцукенгш', 'йцукенгшщз', 'йцукен12', 'йцукен123', 'фывапролд',
  'фыва1234', 'gfhjkm12', 'gfhjkm123', 'gfhjkmgfhjkm', 'qwertyйцукен', 'ktnjktnj', 'cjkysirj', 'vfrcbv12',
  // Компания и продукт — первое, что пробуют.
  'centras1', 'centras123', 'centras2024', 'centras2025', 'centras2026', 'sentras1', 'sentras123',
  'сентрас1', 'сентрас123', 'mychat123', 'openmychat', 'centrasinsurance'
]);

// «Лето2026», «winter2025!» — время года и год.
const SEASON_YEAR = /^(summer|winter|spring|autumn|fall|лето|зима|весна|осень)[\s._-]?\d{2,4}[!.]?$/;

// Основа (stem) очевидно слабых паролей: их обыгрывают регистром, цифрами,
// разделителями, знаками и заменой букв похожими символами. Точного списка не
// хватало (проверка раунда 4, ПР-I5, I-6). Сверка идёт по нескольким «буквенным
// формам» пароля — см. candidateForms:
//
//   BRAND_STEMS — марка, продукт и род деятельности компании (кириллица,
//     латиница, набор не в той раскладке). Отсекаются по ВХОЖДЕНИЮ (contains):
//     «MyCentras2026», «WelcomeCentras1» — тоже вокруг марки. Основы длинные и
//     характерные, поэтому вхождение не задевает обычные пароли. Голых «centy»
//     и «mychat» здесь нет намеренно — иначе «Centymeter…», «mychatter…»
//     отвергались бы зря (I-6).
//   WORD_STEMS — обычные словарные основы (password, пароль, qwerty…).
//     Отсекаются только при ПОЛНОМ совпадении с буквенной формой (основа плюс
//     цифры/знаки), иначе «парольдлятеста», «passwordbook» отвергались бы зря.
const BRAND_STEMS = [
  'centychat', 'сентичат',
  'centras', 'sentras', 'сентрас', 'ctynhfc', // ctynhfc = «сентрас» в латинской раскладке
  'centrasinsurance', 'centrasins', 'openmychat', 'мойчат',
  'insurance', 'иншуранс'
];
const WORD_STEMS = [
  'password', 'пароль', 'qwerty', 'qwertz', 'йцукен', 'gfhjkm', // gfhjkm = «пароль» в латинской раскладке
  'welcome', 'letmein', 'changeme', 'iloveyou', 'administrator',
  // Прежнее имя продукта: по ПОЛНОМУ совпадению — «mychat2026»/«MyChat!2026»
  // отклоняются, а «mychatter-is-fun-2026» проходит (третий раунд, пункт 4).
  'mychat'
];

// Замена цифр и знаков на буквы (leetspeak): «P@ssw0rd», «C3ntras», «Pa$$word».
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't' };
// Латиница ↔ кириллица (гомоглифы): «Lето», «сentras». Сводим В ОБЕ стороны —
// проверяем и латинскую, и кириллическую форму (I-6). Только для сверки с
// основой; на хранение и проверку пароля не влияет.
const LAT2CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', l: 'л', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const CYR2LAT = Object.fromEntries(Object.entries(LAT2CYR).map(([lat, cyr]) => [cyr, lat]));

function mapChars(text, table) {
  return [...text].map((ch) => table[ch] || ch).join('');
}
function lettersOnly(text) {
  return [...text].filter((ch) => /\p{L}/u.test(ch)).join('');
}

// Набор буквенных форм пароля для сверки с основами. Две базы: как есть (ловит
// цифры между буквами: «q1w2e3r4t5y6» → «qwerty») и с leet-заменой в «ядре»
// без хвоста из знаков/цифр (ловит «P@ssw0rd2026» → «password»). Каждая — ещё и
// в кириллической и латинской свёртке гомоглифов.
function candidateForms(password) {
  const base = String(password).normalize('NFKC').toLowerCase();
  const core = base.replace(/[^\p{L}]+$/u, ''); // без хвоста из цифр/знаков
  const forms = new Set();
  for (const src of [lettersOnly(base), lettersOnly(mapChars(core, LEET))]) {
    if (!src) continue;
    forms.add(src);
    forms.add(mapChars(src, CYR2LAT)); // кириллица → латиница
    forms.add(mapChars(src, LAT2CYR)); // латиница → кириллица
  }
  return [...forms];
}
function matchesBannedStem(password) {
  const forms = candidateForms(password);
  if (BRAND_STEMS.some((stem) => forms.some((f) => f.includes(stem)))) return true;
  return WORD_STEMS.some((stem) => forms.some((f) => f === stem));
}

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

/**
 * Политика для НОВОГО пароля: задание администратором, смена сотрудником,
 * регистрация, импорт, INITIAL_ADMIN_PASSWORD и ADMIN_PASSWORD_RESET. При входе
 * она не применяется — см. WEAK и isWeakPassword.
 *
 * Сравнения идут после NFKC — в том же виде пароль и хэшируется
 * (db/identity/password.js). Раньше проверка смотрела на пароль как есть, и
 * «１２３４５６７８» полноширинными цифрами проходил, хотя хранился и
 * проверялся как «12345678».
 *
 * @param {string} password
 * @param {{ username?: string, allowWeakInitial?: boolean }} [options]
 *   username — логин владельца: пароль, равный логину (или логину с цифрами
 *   в конце, или логину задом наперёд), отклоняется — логин коллеги знает
 *   любой в компании.
 */
function assertPasswordPolicy(password, { username = null, allowWeakInitial = false } = {}) {
  if (typeof password !== 'string' || !password) {
    throw new Error('Укажите новый пароль');
  }
  if (allowWeakInitial) return;
  const normalized = password.normalize('NFKC');
  if ([...normalized].length < 8) {
    throw new Error('Пароль должен быть не короче 8 символов');
  }
  // Та же граница, что и при хэшировании (db/identity/password.js): здесь —
  // понятный текст до того, как дело дойдёт до расчёта.
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('Пароль слишком длинный');
  }
  const lower = normalized.toLowerCase();
  // «Лето2026», «Lето2026» (латинская L вместо Л): свёртка гомоглифов к
  // кириллице для проверки времени года.
  const seasonFolded = mapChars(lower, LAT2CYR);
  if (
    WEAK.has(lower) || COMMON_PASSWORDS.has(lower) ||
    SEASON_YEAR.test(lower) || SEASON_YEAR.test(seasonFolded) ||
    matchesBannedStem(password)
  ) {
    throw new Error('Такой пароль слишком простой — подберите другой');
  }
  if (new Set(lower).size <= 2) {
    throw new Error('Пароль из одного-двух повторяющихся символов слишком простой — подберите другой');
  }
  const login = username ? String(username).normalize('NFKC').trim().toLowerCase() : '';
  if (login) {
    const reversed = [...login].reverse().join('');
    // Логин и хвост из не-букв (цифры, знаки) — «ivanov2026!» — тот же логин.
    const loginPlusTail = lower.startsWith(login) && /^[^\p{L}]*$/u.test(lower.slice(login.length));
    if (lower === reversed || loginPlusTail) {
      throw new Error('Пароль не должен совпадать с логином — подберите другой');
    }
  }
}

// Прежнее правило «слабого» пароля — только для решения при ВХОДЕ, требовать
// ли смену (AuthService.login). Не расширяется вместе с политикой выше.
function isLegacyWeakPassword(password) {
  if (typeof password !== 'string' || !password) return true;
  if (password.length < 8) return true;
  return WEAK.has(password.toLowerCase());
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
// Решение при входе: пускать как обычно или требовать смены пароля. Сознательно
// по прежнему правилу, а не по assertPasswordPolicy: выпуск с более строгой
// политикой не должен разом отправить на смену пароля всех, кто входил вчера
// (аудит, раунд 4, находка Р4-08; см. docs/выпуск-2026-10-безопасность.md).
module.exports.isWeakPassword = isLegacyWeakPassword;
module.exports.generateTempPassword = generateTempPassword;
