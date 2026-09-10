const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const AuthService = require('../services/auth.service');
const UserService = require('../services/user.service');
const OrgService = require('../services/org.service');
const MessageService = require('../services/message.service');
const AnnouncementService = require('../services/announcement.service');
const SettingsService = require('../services/settings.service');
const DbStudioService = require('../services/db-studio.service');
const FileService = require('../services/file.service');
const DeviceService = require('../services/device.service');
const OrgParserService = require('../services/org-parser.service');
const { checkRateLimit } = require('../services/rate-limiter');
const { getClientIp } = require('../services/ip-access.service');
const { getDatabase } = require('../db');
const AuditService = require('../services/audit.service');
const wsServer = require('../ws/server');
const config = require('../config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB limit

// Routes a user with must_change_password=1 may still reach — just enough to
// see who they are and actually change the password. Everything else 403s
// until they do. See docs/designs/auth-access-control-remediation.md item 10.
const PASSWORD_CHANGE_ALLOWLIST = new Set(['/auth/me', '/users/password']);

// Auth middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }
  const token = authHeader.substring(7);
  const payload = AuthService.verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Недействительный или истекший токен' });
  }
  req.user = UserService.getUserById(payload.userId);
  if (!req.user || !req.user.is_active) {
    return res.status(401).json({ error: 'Пользователь не найден или заблокирован' });
  }
  if (req.user.must_change_password && !PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
    return res.status(403).json({ error: 'Требуется смена пароля перед продолжением работы', code: 'MUST_CHANGE_PASSWORD' });
  }
  next();
}

// A department ("контурный") administrator carries is_admin as well, since it
// administers something — the two are told apart by is_scoped_admin. Checking
// is_admin alone therefore handed every department administrator the full
// superadmin surface, arbitrary SQL over the whole database included.
//
// role_id is not consulted: a migration that inserts a role with an explicit
// id shifts every later autoincrement id, so those numbers are not stable.
// Neither is username — an account's powers must come from its role.
function isSuperAdmin(user) {
  const permissions = user?.permissions || {};
  return Boolean(permissions.is_admin) && !permissions.is_scoped_admin;
}

function isScopedAdmin(user) {
  return Boolean(user?.permissions?.is_scoped_admin);
}

function requireAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Доступ запрещен: требуются права администратора' });
  }
  next();
}

function requireAdminOrScopedAdmin(req, res, next) {
  if (!isSuperAdmin(req.user) && !isScopedAdmin(req.user)) {
    return res.status(403).json({ error: 'Доступ запрещен: требуются права администратора' });
  }
  next();
}

// A department administrator may only act inside its own subtree, and may
// never hand out administrative powers. Without this it could edit anyone in
// the company and set role_id to Суперадминистратор — on itself included.
// Throws; callers already translate a thrown error into a 400/403 response.
function assertWithinAdminScope(actor, { targetUserId = null, payload = null } = {}) {
  if (isSuperAdmin(actor)) return;

  const scopeRootId = actor?.admin_scope_dept_id;
  if (!scopeRootId) {
    throw new Error('Администратору не назначено подразделение — управление пользователями недоступно');
  }
  const allowed = new Set(OrgService.getSubtreeDepartmentIds(scopeRootId));

  if (targetUserId !== null) {
    const target = UserService.getUserById(targetUserId);
    if (!target) throw new Error('Пользователь не найден');
    if (!allowed.has(target.department_id)) {
      throw new Error('Этот сотрудник относится к другому подразделению');
    }
  }

  if (payload) {
    if (payload.department_id !== undefined && payload.department_id !== null) {
      if (!allowed.has(Number(payload.department_id))) {
        throw new Error('Выбранное подразделение вне вашей зоны ответственности');
      }
    }
    if (payload.admin_scope_dept_id) {
      throw new Error('Назначать администраторов подразделений может только суперадминистратор');
    }
    if (payload.role_id !== undefined && payload.role_id !== null) {
      const role = getRoleById(Number(payload.role_id));
      const grants = role ? JSON.parse(role.permissions_json || '{}') : {};
      if (grants.is_admin || grants.is_scoped_admin) {
        throw new Error('Назначать административные роли может только суперадминистратор');
      }
    }
  }
}

function getRoleById(roleId) {
  return getDatabase().prepare('SELECT permissions_json FROM roles WHERE id = ?').get(roleId);
}

router.post('/auth/knock', (req, res) => {
  try {
    const remoteIp = getClientIp(req) || '127.0.0.1';
    const { device_id, device_name, platform, client_version } = req.body || {};
    const result = DeviceService.knock({
      device_id,
      device_name,
      ip_address: remoteIp,
      platform,
      client_version
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 1. AUTH ──
router.post('/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

    const remoteIp = getClientIp(req) || '127.0.0.1';
    const rateLimitKey = `login:${remoteIp}:${String(username).toLowerCase()}`;
    if (!checkRateLimit(rateLimitKey, { maxAttempts: 5, windowMs: 60000 })) {
      return res.status(429).json({ error: 'Слишком много попыток входа. Повторите через минуту.' });
    }

    const result = AuthService.login(username, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/auth/register', (req, res) => {
  try {
    const allowRegistration = SettingsService.getSetting('allow_registration', 'true') === 'true';
    if (!allowRegistration) {
      return res.status(403).json({ error: 'Самостоятельная регистрация отключена администратором' });
    }
    const remoteIp = getClientIp(req) || '127.0.0.1';
    if (!checkRateLimit(`register:${remoteIp}`, { maxAttempts: 10, windowMs: 600000 })) {
      return res.status(429).json({ error: 'Слишком много попыток регистрации. Повторите позже.' });
    }
    const user = AuthService.register(req.body);
    // Токен не выдаётся: заявка ещё не подтверждена, входить пока не с чем.
    wsServer.broadcast({ type: 'registration_pending', username: user.username, fullName: user.full_name });
    res.status(201).json({
      pending: true,
      message: 'Заявка отправлена. Вход станет возможен после подтверждения администратором.'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── 2. USERS ──
router.get('/users', requireAuth, (req, res) => {
  const users = UserService.getAllUsers();
  res.json(users);
});

router.get('/users/:id', requireAuth, (req, res) => {
  const user = UserService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(user);
});

router.put('/users/profile', requireAuth, (req, res) => {
  try {
    const updated = UserService.updateProfile(req.user.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/users/password', requireAuth, (req, res) => {
  try {
    if (!checkRateLimit(`pwchange:${req.user.id}`, { maxAttempts: 5, windowMs: 60000 })) {
      return res.status(429).json({ error: 'Слишком много попыток. Повторите через минуту.' });
    }
    const { oldPassword, newPassword } = req.body;
    UserService.changePassword(req.user.id, oldPassword, newPassword);
    res.json({ success: true, message: 'Пароль успешно изменен' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── ADMIN USER MANAGEMENT ──
router.get('/admin/users', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const users = UserService.getAllUsers(req.user);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/users', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    assertWithinAdminScope(req.user, { payload: req.body });
    const newUser = UserService.createUser(req.body);
    wsServer.broadcast({
      type: 'user_created',
      user: newUser
    });
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/admin/users/:id', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id), payload: req.body });
    const updated = UserService.adminUpdateUser(Number(req.params.id), req.body);
    wsServer.broadcast({
      type: 'user_updated',
      user: updated
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/admin/users/:id', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    const updated = UserService.toggleUserActive(Number(req.params.id), false);
    wsServer.broadcast({
      type: 'user_updated',
      user: updated
    });
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/users/:id/toggle-active', requireAuth, requireAdmin, (req, res) => {
  try {
    const updated = UserService.toggleUserActive(Number(req.params.id));
    wsServer.broadcast({
      type: 'user_updated',
      user: updated
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Администратор подразделения заводит и правит своих сотрудников — забытый
// пароль он должен уметь сбросить им сам, иначе смысла в его роли мало.
// Границы контура проверяются ниже, как и в остальных операциях.
router.post('/admin/users/:id/reset-password', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const { password } = req.body || {};
    const targetId = Number(req.params.id);
    assertWithinAdminScope(req.user, { targetUserId: targetId });
    const newPassword = password || '123456';
    UserService.adminResetPassword(targetId, newPassword);
    // Resetting someone else's password hands them a temporary one, so they
    // must change it at next login. An admin resetting their OWN password
    // already chose it here — re-arming the flag would send them back to the
    // forced-change screen on every login, and that screen 403s the admin
    // console they'd need to clear it from.
    if (targetId === req.user.id) {
      UserService.setMustChangePassword(targetId, false);
    }
    res.json({
      success: true,
      message: password ? 'Пароль успешно изменён' : 'Пароль сброшен на 123456'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── MYCHAT SERVER CONTROL PANEL SUITE (https://nsoft-s.com/mcserverhelp/controlpanel.html) ──

// 1. Server Overview & Live Connections (info.html)
router.get('/admin/server/overview', requireAuth, requireAdmin, (req, res) => {
  try {
    const os = require('node:os');
    const netInterfaces = os.networkInterfaces();
    let lanIp = '127.0.0.1';
    for (const devName in netInterfaces) {
      const iface = netInterfaces[devName];
      for (const alias of iface) {
        if (alias.family === 'IPv4' && !alias.internal) {
          lanIp = alias.address;
          break;
        }
      }
    }

    const dbStats = DbStudioService.getDatabaseStats();
    const onlineList = wsServer.getOnlineConnectionsList();
    const totalUsers = UserService.getAllUsers().length;
    const allChannels = MessageService.getChannels(req.user.id);
    const company = SettingsService.getSetting('company_name', 'АО "Страховая компания "Сентрас Иншуранс"');

    res.json({
      server_name: SettingsService.getSetting('server_name', 'OpenMyChat Enterprise Server'),
      company_name: company,
      version: '2025.3.1 (Build 2026.09.07)',
      uptime_seconds: Math.floor(process.uptime()),
      lan_ip: lanIp,
      port: 2004,
      node_version: process.version,
      platform: os.platform() + ' ' + os.release() + ' (' + os.arch() + ')',
      db_engine: 'SQLite Enterprise (WAL Journal Mode)',
      db_stats: dbStats,
      online_count: onlineList.length,
      total_users: totalUsers,
      total_channels: allChannels.length,
      online_connections: onlineList
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/server/disconnect-user', requireAuth, requireAdmin, (req, res) => {
  try {
    const { userId } = req.body;
    const ok = wsServer.disconnectUser(userId);
    res.json({ success: ok, message: ok ? 'Сессия успешно сброшена' : 'Пользователь не подключен' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Roles & Permissions Management (grouprightsmanage.html)
router.get('/admin/roles', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = require('../db').getDatabase();
    const roles = db.prepare('SELECT * FROM roles ORDER BY id ASC').all();
    const parsed = roles.map((r) => ({
      ...r,
      permissions: typeof r.permissions_json === 'string' ? JSON.parse(r.permissions_json) : r.permissions_json
    }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/roles/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    const db = require('../db').getDatabase();
    db.prepare(
      'UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), permissions_json = ? WHERE id = ?'
    ).run(name, description, JSON.stringify(permissions), req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 3. Conferences Management (conference.html)
router.get('/admin/channels', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = require('../db').getDatabase();
    const channels = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) as members_count,
        (SELECT COUNT(*) FROM messages WHERE conversation_type = 'channel' AND target_id = c.id) as total_messages
      FROM channels c
      ORDER BY c.id ASC
    `).all();
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/channels', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, topic } = req.body;
    const db = require('../db').getDatabase();
    const now = new Date().toISOString();
    const formattedName = name.startsWith('#') ? name : '#' + name;
    const result = db.prepare(
      'INSERT INTO channels (name, topic, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(formattedName, topic || '', 'public', req.user.id, now);
    const channelId = result.lastInsertRowid;
    
    // Auto-join all existing registered users to the public corporate channel
    const users = db.prepare('SELECT id FROM users WHERE is_active = 1').all();
    const addMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    for (const u of users) {
      addMember.run(channelId, u.id, u.id === req.user.id ? 'admin' : 'member', now);
    }
    const newChan = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    wsServer.broadcast({ type: 'channel_created', channel: newChan });
    res.status(201).json(newChan);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/admin/channels/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = require('../db').getDatabase();
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!channel) throw new Error('Канал не найден');
    if (channel.name === '#Общий') throw new Error('Запрещено удалять главный корпоративный канал #Общий');

    db.prepare("DELETE FROM messages WHERE conversation_type = 'channel' AND target_id = ?").run(req.params.id);
    db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(req.params.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);

    wsServer.broadcast({ type: 'channel_deleted', channelId: Number(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Tools: Audit Logs, Port Test, DB Optimize (tools.html)
router.get('/admin/audit/messages', requireAuth, requireAdmin, (req, res) => {
  try {
    const { q, limit } = req.query;
    const logs = MessageService.searchAuditLogs(q || '', limit || 100);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/tools/port-test', requireAuth, requireAdmin, (req, res) => {
  const os = require('node:os');
  const tStart = Date.now();
  res.json({
    status: 'OK',
    server_port: 2004,
    chat_protocol: 'TCP / WebSocket RFC 6455',
    web_admin_protocol: 'HTTP/1.1 REST JSON',
    response_time_ms: Date.now() - tStart,
    network_interfaces: Object.keys(os.networkInterfaces())
  });
});

router.post('/admin/tools/vacuum', requireAuth, requireAdmin, (req, res) => {
  try {
    const stats = DbStudioService.optimizeDatabase();
    res.json({ success: true, message: 'Оптимизация и дефрагментация базы данных SQLite завершена успешно', stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Filters (filters.html)
router.get('/admin/filters', requireAuth, requireAdmin, (req, res) => {
  res.json({
    antiflood_limit: Number(SettingsService.getSetting('antiflood_limit', 10)),
    bad_words_enabled: SettingsService.getSetting('bad_words_enabled', 'true') === 'true',
    bad_words_list: SettingsService.getSetting('bad_words_list', 'спам,мат,реклама'),
    ip_blacklist: SettingsService.getSetting('ip_blacklist', '')
  });
});

router.post('/admin/filters', requireAuth, requireAdmin, (req, res) => {
  try {
    const { antiflood_limit, bad_words_enabled, bad_words_list, ip_blacklist } = req.body;
    if (antiflood_limit !== undefined) SettingsService.setSetting('antiflood_limit', antiflood_limit);
    if (bad_words_enabled !== undefined) SettingsService.setSetting('bad_words_enabled', String(bad_words_enabled));
    if (bad_words_list !== undefined) SettingsService.setSetting('bad_words_list', bad_words_list);
    if (ip_blacklist !== undefined) SettingsService.setSetting('ip_blacklist', ip_blacklist);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 6. Settings (settings.html)
router.get('/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.json(SettingsService.getAllSettings());
});

router.put('/admin/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const updated = SettingsService.updateSettings(req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Telegram Bot Gateway Test Endpoint
router.post('/admin/telegram/test', requireAuth, requireAdmin, async (req, res) => {
  const { bot_token, chat_id } = req.body;
  if (!bot_token) {
    return res.status(400).json({ success: false, error: 'Токен Telegram бота не указан.' });
  }
  try {
    const fetchRes = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const botInfo = await fetchRes.json();
    if (!botInfo.ok) {
      return res.status(400).json({ success: false, error: botInfo.description || 'Неверный токен бота' });
    }
    
    if (chat_id) {
      const sendRes = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id,
          text: '🔔 *OpenMyChat Enterprise Server*\\nТестовое оповещение успешно доставлено! Шлюз СК «Сентрас Иншуранс» готов к работе.',
          parse_mode: 'Markdown'
        })
      });
      const sendData = await sendRes.json();
      if (!sendData.ok) {
        return res.json({
          success: true,
          bot: botInfo.result,
          warning: `Бот @${botInfo.result.username} активен, но отправка в Chat ID не удалась: ${sendData.description}`
        });
      }
    }

    return res.json({
      success: true,
      bot: botInfo.result,
      message: `Бот @${botInfo.result.username} успешно проверен и готов к работе!`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Ошибка связи с api.telegram.org: ' + err.message });
  }
});

// 7. Licenses (licenses.html)
router.get('/admin/licenses', requireAuth, requireAdmin, (req, res) => {
  res.json({
    product_name: 'MyChat Server Enterprise',
    license_type: 'Корпоративная неограниченная (Enterprise LAN/WAN)',
    license_owner: SettingsService.getSetting('company_name', 'АО "Страховая компания "Сентрас Иншуранс"'),
    license_key: 'MC7-ENT-CENTR-2025-9981-A4F2',
    max_online_users: 'Без ограничений',
    current_active_users: UserService.getAllUsers().length,
    support_expiration: 'Бессрочная лицензия',
    registered_at: '2025-01-01'
  });
});

// ── 3. ORG STRUCTURE ──
router.get('/org/tree', requireAuth, (req, res) => {
  const data = OrgService.getOrganizationTree(req.user?.admin_scope_dept_id);
  res.json(data);
});

router.post('/org/departments', requireAuth, requireAdmin, (req, res) => {
  try {
    const dept = OrgService.createDepartment(req.body);
    res.status(201).json(dept);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/org/departments/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const dept = OrgService.updateDepartment(req.params.id, req.body);
    res.json(dept);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/org/departments/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    OrgService.deleteDepartment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/org/move-user', requireAuth, requireAdmin, (req, res) => {
  try {
    const { userId, departmentId } = req.body;
    OrgService.moveUser(userId, departmentId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 4. CHANNELS & CONVERSATIONS ──
router.get('/channels', requireAuth, (req, res) => {
  const channels = MessageService.getChannels(req.user.id);
  res.json(channels);
});

router.get('/conversations/direct', requireAuth, (req, res) => {
  const convos = MessageService.getDirectConversations(req.user.id);
  res.json(convos);
});

router.get('/messages', requireAuth, (req, res) => {
  try {
    const { conversationType, targetId, limit, beforeId } = req.query;
    if (!conversationType || !targetId) {
      return res.status(400).json({ error: 'Укажите conversationType и targetId' });
    }
    const messages = MessageService.getMessages(
      conversationType,
      Number(targetId),
      req.user.id,
      limit ? parseInt(limit, 10) : 50,
      beforeId ? parseInt(beforeId, 10) : null
    );
    res.json(messages);
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
});

router.get('/messages/direct/:targetId', requireAuth, (req, res) => {
  const messages = MessageService.getMessages(
    'direct',
    Number(req.params.targetId),
    req.user.id,
    req.query.limit ? parseInt(req.query.limit, 10) : 50,
    req.query.beforeId ? parseInt(req.query.beforeId, 10) : null
  );
  res.json(messages);
});

router.post('/messages/direct/:targetId', requireAuth, (req, res) => {
  try {
    const { text, type, reply_to_id, metadata } = req.body;
    const targetId = Number(req.params.targetId);
    const msg = MessageService.sendMessage({
      conversationType: 'direct',
      targetId,
      senderId: req.user.id,
      text,
      type: type || 'text',
      replyToId: reply_to_id || null,
      metadata
    });

    try {
      wsServer.sendToUser(targetId, { type: 'direct_message', message: msg });
      wsServer.sendToUser(targetId, { type: 'new_message', message: msg });
      wsServer.sendToUser(req.user.id, { type: 'direct_message', message: msg });
      wsServer.sendToUser(req.user.id, { type: 'new_message', message: msg });
    } catch (e) {
      console.warn('[WS Notify] Error dispatching direct message:', e.message);
    }

    res.status(201).json(msg);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/messages/channels/:targetId', requireAuth, (req, res) => {
  try {
    const messages = MessageService.getMessages(
      'channel',
      Number(req.params.targetId),
      req.user.id,
      req.query.limit ? parseInt(req.query.limit, 10) : 50,
      req.query.beforeId ? parseInt(req.query.beforeId, 10) : null
    );
    res.json(messages);
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
});

router.post('/messages/channels/:targetId', requireAuth, (req, res) => {
  try {
    const { text, type, reply_to_id, metadata } = req.body;
    const targetId = Number(req.params.targetId);
    const msg = MessageService.sendMessage({
      conversationType: 'channel',
      targetId,
      senderId: req.user.id,
      text,
      type: type || 'text',
      replyToId: reply_to_id || null,
      metadata
    });

    try {
      const db = require('../db').getDatabase();
      const members = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(targetId);
      for (const m of members) {
        wsServer.sendToUser(m.user_id, { type: 'channel_message', message: msg });
        wsServer.sendToUser(m.user_id, { type: 'new_message', message: msg });
      }
    } catch (e) {
      console.warn('[WS Notify] Error dispatching channel message:', e.message);
    }

    res.status(201).json(msg);
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
});

router.get('/messages/search', requireAuth, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const results = MessageService.searchMessages(q, req.user.id);
  res.json(results);
});

// ── 5. ANNOUNCEMENTS (С подтверждением) ──
router.get('/announcements', requireAuth, (req, res) => {
  const announcements = AnnouncementService.getAnnouncementsForUser(req.user.id);
  res.json(announcements);
});

router.post('/announcements', requireAuth, (req, res) => {
  try {
    if (!req.user.permissions.can_broadcast && !req.user.permissions.is_admin) {
      return res.status(403).json({ error: 'Нет прав на отправку массовых оповещений' });
    }
    const ann = AnnouncementService.createAnnouncement({
      author_id: req.user.id,
      ...req.body
    });

    // Notify connected users in realtime via WebSocket
    wsServer.broadcast({
      type: 'new_announcement',
      announcement: ann
    });

    res.status(201).json(ann);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/announcements/:id/acknowledge', requireAuth, (req, res) => {
  try {
    const ip = getClientIp(req) || '127.0.0.1';
    const result = AnnouncementService.acknowledgeAnnouncement(req.params.id, req.user.id, ip);
    
    // Broadcast receipt update
    wsServer.broadcast({
      type: 'announcement_acknowledged',
      announcementId: req.params.id,
      userId: req.user.id,
      userName: req.user.full_name
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/announcements/:id/audit', requireAuth, (req, res) => {
  try {
    const audit = AnnouncementService.getAnnouncementAudit(req.params.id);
    res.json(audit);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 6. SETTINGS & SERVER INFO ──
router.get('/settings/info', (req, res) => {
  const settings = SettingsService.getAllSettings();
  res.json({
    server_name: settings.server_name || 'OpenMyChat Enterprise Server',
    company_name: settings.company_name || 'Корпоративная сеть',
    allow_registration: settings.allow_registration === 'true' || settings.allow_registration === true,
    version: config.SERVER_VERSION
  });
});

// Department names only, and only while self-registration is enabled: the
// registration form has to offer this list before anyone can authenticate,
// but the full org tree (staff, contacts, structure) must not be readable by
// an anonymous caller.
router.get('/settings/departments', (req, res) => {
  const allowRegistration = SettingsService.getSetting('allow_registration', 'false') === 'true';
  if (!allowRegistration) return res.json({ departments: [] });

  const departments = getDatabase()
    .prepare('SELECT id, name FROM departments ORDER BY sort_order ASC, name ASC')
    .all();
  res.json({ departments });
});

// ── Заявки на регистрацию ──
// Сотрудник регистрируется сам, но пользоваться системой начинает только
// после подтверждения. Администратору не нужно заводить каждого руками, при
// этом посторонний в корпоративный чат не попадает.
router.get('/admin/registrations', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const rows = getDatabase()
      .prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title,
               u.department_id, d.name AS department_name, u.registered_at
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.approval_status = 'pending'
        ORDER BY u.registered_at ASC
      `)
      .all();

    // Администратор подразделения видит только заявки своего контура.
    if (isScopedAdmin(req.user) && req.user.admin_scope_dept_id) {
      const allowed = new Set(OrgService.getSubtreeDepartmentIds(req.user.admin_scope_dept_id));
      return res.json(rows.filter((r) => allowed.has(r.department_id)));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/registrations/:id/approve', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    const user = AuthService.approveUser(Number(req.params.id));
    AuditService.log({
      userId: req.user.id,
      action: 'registration_approved',
      ip: getClientIp(req),
      details: { approvedUserId: Number(req.params.id), username: user?.username }
    });
    wsServer.broadcast({ type: 'user_created', user });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/registrations/:id/reject', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    AuthService.rejectUser(Number(req.params.id));
    AuditService.log({
      userId: req.user.id,
      action: 'registration_rejected',
      ip: getClientIp(req),
      details: { rejectedUserId: Number(req.params.id) }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Журнал сеансов удалённого доступа: кто, к кому, когда, с управлением или
// только просмотром. Читать может только суперадминистратор.
router.get('/admin/audit', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(AuditService.list({ action: req.query.action || null, limit: req.query.limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings', requireAuth, (req, res) => {
  const settings = SettingsService.getAllSettings();
  res.json(settings);
});

router.put('/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const updated = SettingsService.updateSettings(req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/channels', requireAuth, (req, res) => {
  try {
    const { name, topic, type = 'public' } = req.body;
    if (!name) return res.status(400).json({ error: 'Укажите название канала' });
    const channel = MessageService.createChannel(name, topic, type, req.user.id);
    res.status(201).json(channel);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 8. FILES ──
router.post('/files/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не прикреплен' });
    const saved = FileService.saveUploadedFile({
      uploaderId: req.user.id,
      originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), // handle utf8 filenames
      buffer: req.file.buffer,
      mimeType: req.file.mimetype
    });
    res.status(201).json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/files/download/:id', requireAuth, (req, res) => {
  const file = FileService.getFileById(req.params.id);
  if (!file || !fs.existsSync(file.path)) {
    return res.status(404).send('Файл не найден');
  }
  if (!FileService.canUserAccessFile(req.user.id, req.params.id)) {
    return res.status(403).send('Доступ запрещен: файл вне ваших диалогов и каналов');
  }
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  fs.createReadStream(file.path).pipe(res);
});

router.get('/files/recent', requireAuth, (req, res) => {
  const files = FileService.getRecentFiles(req.user.id);
  res.json(files);
});

// ── 9. DATABASE STUDIO & ADMIN MANAGEMENT ──
router.get('/admin/db/stats', requireAuth, requireAdmin, (req, res) => {
  try {
    const stats = DbStudioService.getDatabaseStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/db/tables', requireAuth, requireAdmin, (req, res) => {
  try {
    const tables = DbStudioService.getTables();
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/db/tables/:name/schema', requireAuth, requireAdmin, (req, res) => {
  try {
    const schema = DbStudioService.getTableSchema(req.params.name);
    res.json(schema);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/db/tables/:name/data', requireAuth, requireAdmin, (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const data = DbStudioService.getTableData(req.params.name, limit, offset);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/db/query', requireAuth, requireAdmin, (req, res) => {
  try {
    const { sql } = req.body;
    const result = DbStudioService.executeCustomSql(sql);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/db/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    const backup = DbStudioService.backupDatabase();
    res.json(backup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/db/backups', requireAuth, requireAdmin, (req, res) => {
  const list = DbStudioService.listBackups();
  res.json(list);
});

router.get('/admin/db/backups/:filename', requireAuth, requireAdmin, (req, res) => {
  const safeName = path.basename(req.params.filename);
  const file = path.join(config.BACKUPS_DIR, safeName);
  if (!fs.existsSync(file)) return res.status(404).send('Бэкап не найден');
  res.download(file);
});


// ── ZERO-TOUCH DEVICE PAIRING & KNOCKING QUEUE ──
router.get('/admin/devices/pending', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const devices = DeviceService.getPendingDevices(req.user);
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/devices/bind', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const result = DeviceService.bindDevice({
      ...req.body,
      adminUser: req.user
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/devices/auto-match', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const result = DeviceService.autoMatchByIp(req.user);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/devices/unbind', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const result = DeviceService.unbindDevice(req.body.device_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── ORG STRUCTURE PARSER & BATCH IMPORT ──
router.post('/admin/org/preview-import', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const { text, format } = req.body || {};
    const preview = OrgParserService.parseRawText(text, format || 'auto');
    res.json({ success: true, preview });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/org/batch-import', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const { text, format, defaultPassword } = req.body || {};
    const parsed = OrgParserService.parseRawText(text, format || 'auto');
    const result = OrgParserService.applyImport({
      parsedData: parsed,
      defaultPassword: defaultPassword || 'admin',
      adminScopeDeptId: req.user.admin_scope_dept_id
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
