const crypto = require('node:crypto');
const { getDatabase, hashPassword, verifyPassword } = require('../db');
const config = require('../config');

class AuthService {
  // Simple HMAC-SHA256 token generator without third-party JWT library requirement
  static generateToken(user) {
    const payload = {
      userId: user.id,
      username: user.username,
      roleId: user.role_id,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7 // 7 days
    };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', config.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  static verifyToken(token) {
    try {
      if (!token || typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [header, body, signature] = parts;
      const expectedSignature = crypto.createHmac('sha256', config.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
      if (signature !== expectedSignature) return null;
      
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  static login(username, password) {
    const db = getDatabase();
    const user = db.prepare(`
      SELECT u.*, r.name as role_name, r.permissions_json, d.name as department_name 
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.username = ? AND u.is_active = 1
    `).get(username);

    if (!user) {
      throw new Error('Пользователь не найден или деактивирован');
    }

    const isValid = verifyPassword(password, user.password_hash, user.salt);
    if (!isValid) {
      throw new Error('Неверный пароль');
    }

    // Проверяется ПОСЛЕ пароля: иначе по разным ответам можно было бы
    // перебором выяснять, какие логины заведены в компании.
    if (user.approval_status === 'pending') {
      throw new Error('Заявка на регистрацию ещё не подтверждена администратором');
    }
    if (user.approval_status === 'rejected') {
      throw new Error('Заявка на регистрацию отклонена. Обратитесь к администратору.');
    }

    // Set online status & update last seen
    const now = new Date().toISOString();
    db.prepare("UPDATE users SET status = 'online', last_seen = ? WHERE id = ?").run(now, user.id);

    const token = this.generateToken(user);
    const { password_hash, salt, ...safeUser } = user;
    safeUser.permissions = JSON.parse(user.permissions_json || '{}');

    return { user: safeUser, token };
  }

  static register(userData) {
    const db = getDatabase();
    // role_id is deliberately NOT read from userData: this endpoint is
    // reachable without authentication whenever self-registration is on, so
    // honouring a caller-supplied role let anyone register straight into
    // Суперадминистратор. A new account is always an ordinary employee;
    // promoting one is an administrator's action.
    const { username, password, full_name, email, phone, job_title, department_id } = userData;
    
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      throw new Error('Пользователь с таким логином уже существует');
    }

    const maxUinRow = db.prepare('SELECT COALESCE(MAX(uin), 0) + 1 as nextUin FROM users').get();
    const nextUin = maxUinRow.nextUin;

    const companyRow = db.prepare("SELECT value FROM server_settings WHERE key = 'company_name'").get();
    const companyName = companyRow ? companyRow.value : 'Корпоративная сеть';

    const { hash, salt } = hashPassword(password);
    const now = new Date().toISOString();

    // "Сотрудник" is not reliably role id 2 — a migration can reserve a
    // lower id for another role before this ever seeds (see
    // user.service.js createUser for the same fix), so look it up by name
    // instead of assuming a fixed numeric id.
    const defaultRole = db.prepare("SELECT id FROM roles WHERE name = 'Сотрудник'").get();
    const resolvedRoleId = defaultRole ? defaultRole.id : null;

    // Заявка, а не готовая учётная запись: войти можно только после того,
    // как администратор её подтвердит.
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, salt, full_name, email, phone, job_title, department_id, role_id, uin, company, created_at, approval_status, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(username, hash, salt, full_name || username, email || null, phone || null, job_title || 'Сотрудник', department_id || null, resolvedRoleId, nextUin, companyName, now, now);

    const newUserId = result.lastInsertRowid;

    // В общие каналы заявка не добавляется — это произойдёт при одобрении,
    // иначе неподтверждённый человек уже числился бы среди участников.
    return this.getUserById(newUserId);
  }

  // Вызывается при одобрении заявки администратором.
  static approveUser(userId) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare("UPDATE users SET approval_status = 'approved' WHERE id = ?").run(userId);

    const systemChannels = db.prepare("SELECT id FROM channels WHERE type = 'system'").all();
    const insertMember = db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    );
    for (const ch of systemChannels) {
      insertMember.run(ch.id, userId, 'member', now);
    }
    return this.getUserById(userId);
  }

  static rejectUser(userId) {
    const db = getDatabase();
    db.prepare("UPDATE users SET approval_status = 'rejected', is_active = 0 WHERE id = ?").run(userId);
    return true;
  }

  static getUserById(id) {
    const db = getDatabase();
    const user = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title, u.department_id, 
             u.uin, u.extension, u.company,
             u.role_id, u.avatar_url, u.status, u.custom_status, u.last_seen, u.created_at,
             r.name as role_name, r.permissions_json, d.name as department_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.id = ?
    `).get(id);

    if (user) {
      user.permissions = JSON.parse(user.permissions_json || '{}');
    }
    return user;
  }

}

module.exports = AuthService;
