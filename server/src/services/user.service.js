const { getDatabase, hashPassword, verifyPassword } = require('../db');
const OrgService = require('./org.service');

class UserService {
  static getAllUsers(adminUser = null) {
    const db = getDatabase();
    
    // Check if scoped admin
    let allowedDeptIds = null;
    if (adminUser && adminUser.admin_scope_dept_id) {
      allowedDeptIds = OrgService.getSubtreeDepartmentIds(adminUser.admin_scope_dept_id);
    }

    let sql = `
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title, u.department_id, 
             u.uin, u.extension, u.company, u.bound_ip, u.admin_scope_dept_id,
             u.role_id, u.avatar_url, u.status, u.custom_status, u.last_seen, u.is_active,
             r.name as role_name, d.name as department_name, sd.name as admin_scope_dept_name,
             dp.device_name as paired_device_name, dp.device_id as paired_device_id
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      LEFT JOIN departments d ON u.department_id = d.id
      LEFT JOIN departments sd ON u.admin_scope_dept_id = sd.id
      LEFT JOIN device_pairings dp ON dp.user_id = u.id AND dp.is_active = 1
    `;

    if (allowedDeptIds && allowedDeptIds.length > 0) {
      const placeholders = allowedDeptIds.map(() => '?').join(',');
      sql += ` WHERE u.department_id IN (${placeholders}) `;
      sql += ` ORDER BY u.full_name ASC `;
      return db.prepare(sql).all(...allowedDeptIds);
    }

    sql += ` ORDER BY u.full_name ASC `;
    return db.prepare(sql).all();
  }

  static getUserById(id) {
    const db = getDatabase();
    const user = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title, u.department_id,
             u.uin, u.extension, u.company, u.bound_ip, u.admin_scope_dept_id,
             u.role_id, u.avatar_url, u.status, u.custom_status, u.last_seen, u.is_active, u.must_change_password,
             r.name as role_name, r.permissions_json, d.name as department_name, sd.name as admin_scope_dept_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      LEFT JOIN departments d ON u.department_id = d.id
      LEFT JOIN departments sd ON u.admin_scope_dept_id = sd.id
      WHERE u.id = ?
    `).get(id);

    if (user) {
      user.permissions = JSON.parse(user.permissions_json || '{}');
    }
    return user;
  }

  static updateStatus(userId, status, customStatus = null) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users 
      SET status = ?, custom_status = ?, last_seen = ? 
      WHERE id = ?
    `).run(status, customStatus, now, userId);
    return this.getUserById(userId);
  }

  static updateProfile(userId, { full_name, email, phone, job_title, avatar_url, custom_status } = {}) {
    const db = getDatabase();
    // COALESCE рассчитан на NULL; undefined node:sqlite связать не может и
    // бросает ошибку на весь запрос. Форма профиля не отправляет
    // custom_status — из-за этого сохранение профиля не срабатывало никогда,
    // причём молча: ответ с ошибкой клиент не показывал.
    const orNull = (v) => (v === undefined ? null : v);
    db.prepare(`
      UPDATE users
      SET full_name = COALESCE(?, full_name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          job_title = COALESCE(?, job_title),
          avatar_url = COALESCE(?, avatar_url),
          custom_status = COALESCE(?, custom_status)
      WHERE id = ?
    `).run(
      orNull(full_name), orNull(email), orNull(phone),
      orNull(job_title), orNull(avatar_url), orNull(custom_status),
      userId
    );
    return this.getUserById(userId);
  }

  static changePassword(userId, oldPassword, newPassword) {
    const db = getDatabase();
    const user = db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('Пользователь не найден');

    if (!oldPassword) throw new Error('Укажите текущий пароль для подтверждения смены');
    const isValid = verifyPassword(oldPassword, user.password_hash, user.salt);
    if (!isValid) throw new Error('Старый пароль неверен');

    const { hash, salt } = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE id = ?').run(hash, salt, userId);
    return true;
  }

  static adminResetPassword(userId, newPassword) {
    const db = getDatabase();
    const { hash, salt } = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, must_change_password = 1 WHERE id = ?').run(hash, salt, userId);
    return true;
  }

  static setMustChangePassword(userId, required) {
    const db = getDatabase();
    db.prepare('UPDATE users SET must_change_password = ? WHERE id = ?').run(required ? 1 : 0, userId);
    return true;
  }

  static createUser({ username, full_name, email, phone, job_title, department_id, role_id, extension, uin, password, bound_ip, admin_scope_dept_id }) {
    const db = getDatabase();
    if (!username || !full_name) {
      throw new Error('Логин и ФИО обязательны для заполнения');
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existing) {
      throw new Error(`Пользователь с логином "${username.trim()}" уже существует`);
    }

    // Whatever password an admin sets here (or the fallback, if they leave
    // the field untouched) is only ever a starting point — must_change_password
    // below is what actually protects the account, same as the initial seed
    // admin and adminResetPassword.
    const { hash, salt } = hashPassword(password || '123456');
    const assignedUin = uin ? parseInt(uin, 10) : Math.floor(1000 + Math.random() * 9000);
    const now = new Date().toISOString();

    // "Сотрудник" is not reliably role id 2 — the "Контурный администратор"
    // migration in db/index.js reserves id 3 for itself before this table is
    // ever seeded, which pushes the seeded roles up to whatever ids are free
    // (4/5 in practice). Look the default up by name instead of assuming a
    // fixed numeric id, or every user created without an explicit role_id
    // hits a foreign key violation.
    const defaultRole = db.prepare("SELECT id FROM roles WHERE name = 'Сотрудник'").get();
    const resolvedRoleId = role_id ? Number(role_id) : (defaultRole ? defaultRole.id : null);

    const stmt = db.prepare(`
      INSERT INTO users (
        username, password_hash, salt, full_name, email, phone, job_title,
        department_id, role_id, uin, extension, company, bound_ip, admin_scope_dept_id, status, created_at, is_active, must_change_password
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, 1, 1)
    `);

    const info = stmt.run(
      username.trim(),
      hash,
      salt,
      full_name.trim(),
      email ? email.trim() : `${username.trim()}@cic.kz`,
      phone || '',
      job_title || 'Сотрудник',
      department_id ? Number(department_id) : null,
      resolvedRoleId,
      assignedUin,
      extension ? String(extension).trim() : '',
      'АО "Страховая компания "Сентрас Иншуранс"',
      bound_ip ? bound_ip.trim() : null,
      admin_scope_dept_id ? Number(admin_scope_dept_id) : null,
      now
    );

    return this.getUserById(info.lastInsertRowid);
  }

  static adminUpdateUser(userId, {
    username, full_name, email, phone, job_title, department_id, role_id, extension, uin, is_active, bound_ip, admin_scope_dept_id, must_change_password
  }) {
    const db = getDatabase();
    const user = this.getUserById(userId);
    if (!user) throw new Error('Пользователь не найден');

    if (username && username.trim() !== user.username) {
      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username.trim(), userId);
      if (existing) throw new Error(`Логин "${username.trim()}" уже занят другим сотрудником`);
    }

    db.prepare(`
      UPDATE users
      SET username = COALESCE(?, username),
          full_name = COALESCE(?, full_name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          job_title = COALESCE(?, job_title),
          department_id = ?,
          role_id = COALESCE(?, role_id),
          extension = COALESCE(?, extension),
          uin = COALESCE(?, uin),
          is_active = COALESCE(?, is_active),
          bound_ip = ?,
          admin_scope_dept_id = ?,
          must_change_password = COALESCE(?, must_change_password)
      WHERE id = ?
    `).run(
      username ? username.trim() : null,
      full_name ? full_name.trim() : null,
      email ? email.trim() : null,
      phone !== undefined ? phone : null,
      job_title ? job_title.trim() : null,
      department_id !== undefined ? (department_id ? Number(department_id) : null) : user.department_id,
      role_id ? Number(role_id) : null,
      extension !== undefined ? String(extension).trim() : null,
      uin ? Number(uin) : null,
      is_active !== undefined ? Number(is_active) : null,
      bound_ip !== undefined ? (bound_ip ? bound_ip.trim() : null) : user.bound_ip,
      admin_scope_dept_id !== undefined ? (admin_scope_dept_id ? Number(admin_scope_dept_id) : null) : user.admin_scope_dept_id,
      must_change_password !== undefined ? Number(Boolean(must_change_password)) : null,
      userId
    );

    return this.getUserById(userId);
  }

  static toggleUserActive(userId, is_active) {
    const db = getDatabase();
    const user = this.getUserById(userId);
    if (!user) throw new Error('Пользователь не найден');

    const newActiveState = is_active !== undefined ? (is_active ? 1 : 0) : (user.is_active ? 0 : 1);
    db.prepare("UPDATE users SET is_active = ?, status = CASE WHEN ? = 0 THEN 'offline' ELSE status END WHERE id = ?")
      .run(newActiveState, newActiveState, userId);

    return this.getUserById(userId);
  }
}

module.exports = UserService;
