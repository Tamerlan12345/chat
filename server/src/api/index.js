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
const { identity } = require('../db/identity');
const AuditService = require('../services/audit.service');
const wsServer = require('../ws/server');
const config = require('../config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Обработчики работают с двумя базами и почти все асинхронные. Обёртка ловит
// отказ обещания и превращает его в обычный ответ об ошибке: необработанный
// отказ в Node завершает процесс, то есть одна опечатка в запросе роняла бы
// сервер целиком.
const route = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// Маршруты, доступные сотруднику с must_change_password = 1: ровно столько,
// чтобы понять, кто он, и сменить пароль. Всё остальное отвечает 403.
const PASSWORD_CHANGE_ALLOWLIST = new Set(['/auth/me', '/users/password']);

const requireAuth = route(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  // resolveSession проверяет не только подпись и срок, но и поколение токена:
  // выданный до смены пароля, до смены роли или до отключения сотрудника
  // перестаёт действовать сразу, а не доживает свою неделю.
  const user = await AuthService.resolveSession(authHeader.substring(7));
  if (!user) {
    return res.status(401).json({ error: 'Недействительный или истекший токен' });
  }

  req.user = user;
  if (user.must_change_password && !PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
    return res.status(403).json({
      error: 'Требуется смена пароля перед продолжением работы',
      code: 'MUST_CHANGE_PASSWORD'
    });
  }
  next();
});

// Администратор подразделения («контурный») тоже несёт is_admin — он ведь
// администрирует. Различает их is_scoped_admin. Проверка одного лишь is_admin
// раздавала каждому такому администратору полный набор прав суперадминистратора,
// включая произвольный SQL по всей базе.
//
// role_id не используется: миграция, вставляющая роль с явным идентификатором,
// сдвигает нумерацию, и эти числа не устойчивы. Имя учётной записи — тем более:
// права должны следовать из роли.
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

// Администратор подразделения действует только внутри своего поддерева и не
// может раздавать административные права. Без этой проверки он правил бы
// кого угодно в компании и назначил бы себе роль суперадминистратора.
async function assertWithinAdminScope(actor, { targetUserId = null, payload = null } = {}) {
  if (isSuperAdmin(actor)) return;

  const scopeRootId = actor?.admin_scope_dept_id;
  if (!scopeRootId) {
    throw new Error('Администратору не назначено подразделение — управление пользователями недоступно');
  }
  const allowed = new Set(await OrgService.getSubtreeDepartmentIds(scopeRootId));

  if (targetUserId !== null) {
    const target = await UserService.getUserById(targetUserId);
    if (!target) throw new Error('Пользователь не найден');
    if (!allowed.has(Number(target.department_id))) {
      throw new Error('Этот сотрудник относится к другому подразделению');
    }
  }

  if (payload) {
    // «Без подразделения» — тоже вне зоны: так администратор подразделения
    // выводил сотрудника из своего контура, а заведённый без отдела человек
    // оказывался вне чьего-либо контроля.
    const creating = targetUserId === null;
    const deptGiven = payload.department_id !== undefined;
    if ((creating && (payload.department_id === undefined || payload.department_id === null || payload.department_id === '')) ||
        (!creating && deptGiven && (payload.department_id === null || payload.department_id === ''))) {
      throw new Error('Укажите подразделение из вашей зоны ответственности');
    }
    if (deptGiven && payload.department_id !== null && payload.department_id !== '') {
      if (!allowed.has(Number(payload.department_id))) {
        throw new Error('Выбранное подразделение вне вашей зоны ответственности');
      }
    }
    if (payload.admin_scope_dept_id) {
      throw new Error('Назначать администраторов подразделений может только суперадминистратор');
    }
    if (payload.role_id !== undefined && payload.role_id !== null) {
      const role = await getRoleById(Number(payload.role_id));
      const grants = role ? safeParse(role.permissions_json) : {};
      if (grants.is_admin || grants.is_scoped_admin) {
        throw new Error('Назначать административные роли может только суперадминистратор');
      }
    }
  }
}

function getRoleById(roleId) {
  return identity().get('SELECT permissions_json FROM roles WHERE id = $1', [Number(roleId)]);
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

router.post('/auth/knock', route(async (req, res) => {
  try {
    const remoteIp = getClientIp(req) || '127.0.0.1';
    const { device_id, device_name, platform, client_version } = req.body || {};
    res.json(await DeviceService.knock({
      device_id, device_name, ip_address: remoteIp, platform, client_version
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── 1. AUTH ──
router.post('/auth/login', route(async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

    const remoteIp = getClientIp(req) || '127.0.0.1';
    const rateLimitKey = `login:${remoteIp}:${String(username).toLowerCase()}`;
    if (!checkRateLimit(rateLimitKey, { maxAttempts: 5, windowMs: 60000 })) {
      return res.status(429).json({ error: 'Слишком много попыток входа. Повторите через минуту.' });
    }

    const result = await AuthService.login(username, password, { ip: remoteIp });
    AuditService.log({
      userId: result.user.id,
      action: 'login',
      ip: remoteIp,
      details: { username: result.user.username }
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/auth/register', route(async (req, res) => {
  try {
    const allowRegistration = (await SettingsService.getSetting('allow_registration', 'false')) === 'true';
    if (!allowRegistration) {
      return res.status(403).json({ error: 'Самостоятельная регистрация отключена администратором' });
    }
    const remoteIp = getClientIp(req) || '127.0.0.1';
    if (!checkRateLimit(`register:${remoteIp}`, { maxAttempts: 10, windowMs: 600000 })) {
      return res.status(429).json({ error: 'Слишком много попыток регистрации. Повторите позже.' });
    }

    const user = await AuthService.register(req.body);
    // Токен не выдаётся: заявка ещё не подтверждена, входить пока не с чем.
    wsServer.broadcastToAdmins({ type: 'registration_pending', username: user.username, fullName: user.full_name });
    res.status(201).json({
      pending: true,
      message: 'Заявка отправлена. Вход станет возможен после подтверждения администратором.'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── 2. USERS ──
router.get('/users', requireAuth, route(async (req, res) => {
  res.json(await UserService.getAllUsers());
}));

router.get('/users/:id', requireAuth, route(async (req, res) => {
  const user = await UserService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  // Полная запись — себе и администратору. Коллеге — те же поля, что и в
  // общем справочнике, без адресов входа и устройства прав.
  const privileged = user.id === req.user.id || isSuperAdmin(req.user) || isScopedAdmin(req.user);
  res.json(privileged ? user : UserService.toPublicUser(user));
}));

router.put('/users/profile', requireAuth, route(async (req, res) => {
  try {
    res.json(await UserService.updateProfile(req.user.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/users/password', requireAuth, route(async (req, res) => {
  try {
    if (!checkRateLimit(`pwchange:${req.user.id}`, { maxAttempts: 5, windowMs: 60000 })) {
      return res.status(429).json({ error: 'Слишком много попыток. Повторите через минуту.' });
    }
    const { oldPassword, newPassword } = req.body || {};
    await UserService.changePassword(req.user.id, oldPassword, newPassword);
    AuditService.log({ userId: req.user.id, action: 'password_changed', ip: getClientIp(req) });

    // Прежний токен только что перестал действовать вместе со сменой пароля —
    // без нового клиенту пришлось бы входить заново прямо здесь.
    const refreshed = await UserService.getUserById(req.user.id);
    res.json({
      success: true,
      message: 'Пароль успешно изменен',
      token: AuthService.generateToken(refreshed),
      user: refreshed
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── ADMIN USER MANAGEMENT ──
router.get('/admin/users', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  res.json(await UserService.getAllUsers(req.user));
}));

router.post('/admin/users', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { payload: req.body });
    const newUser = await UserService.createUser(req.body);
    AuditService.log({
      userId: req.user.id,
      action: 'user_created',
      ip: getClientIp(req),
      details: { createdUserId: newUser.id, username: newUser.username }
    });
    // Начальный пароль виден только тому, кто завёл учётную запись, и только в
    // этом ответе — в рассылке его быть не должно.
    const { initial_password, ...broadcastable } = newUser;
    wsServer.broadcast({ type: 'user_created', user: UserService.toPublicUser(broadcastable) });
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.put('/admin/users/:id', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id), payload: req.body });
    const updated = await UserService.adminUpdateUser(Number(req.params.id), req.body);
    wsServer.broadcast({ type: 'user_updated', user: UserService.toPublicUser(updated) });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/admin/users/:id', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    const updated = await UserService.toggleUserActive(Number(req.params.id), false);
    AuditService.log({
      userId: req.user.id,
      action: 'user_deactivated',
      ip: getClientIp(req),
      details: { targetUserId: Number(req.params.id) }
    });
    wsServer.disconnectUser(Number(req.params.id), 'Учётная запись отключена администратором');
    wsServer.broadcast({ type: 'user_updated', user: UserService.toPublicUser(updated) });
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/users/:id/toggle-active', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const updated = await UserService.toggleUserActive(Number(req.params.id));
    if (!updated.is_active) wsServer.disconnectUser(Number(req.params.id), 'Учётная запись отключена администратором');
    wsServer.broadcast({ type: 'user_updated', user: UserService.toPublicUser(updated) });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Администратор подразделения заводит и правит своих сотрудников — забытый
// пароль он должен уметь сбросить им сам, иначе смысла в его роли мало.
// Границы контура проверяются так же, как и в остальных операциях.
router.post('/admin/users/:id/reset-password', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    const { password } = req.body || {};
    const targetId = Number(req.params.id);
    await assertWithinAdminScope(req.user, { targetUserId: targetId });

    const { password: issued, generated } = await UserService.adminResetPassword(targetId, password || null);

    // Сброс чужого пароля выдаёт временный, который сотрудник обязан сменить.
    // Администратор, сбросивший пароль сам себе, его уже выбрал — повторное
    // требование отправляло бы его на экран смены пароля при каждом входе, а
    // тот экран закрывает как раз админ-панель, из которой флаг и снимается.
    if (targetId === req.user.id) {
      await UserService.setMustChangePassword(targetId, false);
    }

    AuditService.log({
      userId: req.user.id,
      action: 'password_reset_by_admin',
      ip: getClientIp(req),
      details: { targetUserId: targetId, generated }
    });
    wsServer.disconnectUser(targetId, 'Пароль сброшен администратором — войдите заново');

    res.json({
      success: true,
      generated,
      // Сгенерированный пароль возвращается ровно один раз — передать его
      // сотруднику больше неоткуда. Заданный администратором не возвращается.
      password: generated ? issued : undefined,
      message: generated
        ? 'Выдан временный пароль — передайте его сотруднику, при первом входе он его сменит'
        : 'Пароль успешно изменён'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── СЕРВЕРНАЯ ПАНЕЛЬ УПРАВЛЕНИЯ ──
router.get('/admin/server/overview', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const os = require('node:os');
    const netInterfaces = os.networkInterfaces();
    let lanIp = '127.0.0.1';
    for (const devName in netInterfaces) {
      for (const alias of netInterfaces[devName]) {
        if (alias.family === 'IPv4' && !alias.internal) {
          lanIp = alias.address;
          break;
        }
      }
    }

    const [dbStats, identityStats, allUsers, settings] = await Promise.all([
      Promise.resolve(DbStudioService.getDatabaseStats()),
      DbStudioService.getIdentityStats(),
      UserService.getAllUsers(),
      SettingsService.getAllSettings()
    ]);
    const onlineList = wsServer.getOnlineConnectionsList();
    const allChannels = MessageService.getChannels(req.user.id);

    res.json({
      server_name: settings.server_name || 'OpenMyChat Enterprise Server',
      company_name: settings.company_name || 'АО "Страховая компания "Сентрас Иншуранс"',
      version: config.SERVER_VERSION,
      uptime_seconds: Math.floor(process.uptime()),
      lan_ip: lanIp,
      port: config.PORT,
      node_version: process.version,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      db_engine: `Переписка: SQLite (WAL) · Учётные записи: ${identityStats.engine}`,
      db_stats: dbStats,
      identity_stats: identityStats,
      online_count: onlineList.length,
      total_users: allUsers.length,
      total_channels: allChannels.length,
      online_connections: onlineList
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

router.post('/admin/server/disconnect-user', requireAuth, requireAdmin, (req, res) => {
  try {
    const ok = wsServer.disconnectUser(req.body?.userId);
    res.json({ success: ok, message: ok ? 'Сессия успешно сброшена' : 'Пользователь не подключен' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── РОЛИ И ПРАВА ──
router.get('/admin/roles', requireAuth, requireAdmin, route(async (req, res) => {
  const roles = await identity().all('SELECT * FROM roles ORDER BY id ASC');
  res.json(roles.map((role) => ({ ...role, permissions: safeParse(role.permissions_json) })));
}));

// Права ролей меняет только суперадминистратор — этим правом можно выдать себе
// что угодно.
router.put('/admin/roles/:id', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { name, description, permissions } = req.body || {};
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Не переданы права роли' });
    }

    const db = identity();
    const roleId = Number(req.params.id);
    const role = await db.get('SELECT * FROM roles WHERE id = $1', [roleId]);
    if (!role) return res.status(404).json({ error: 'Роль не найдена' });

    // Защита от необратимой самоблокировки: снять признак администратора у
    // роли, кроме которой администраторов больше нет, — значит навсегда лишить
    // систему управления. Восстановить это можно было бы только правкой базы
    // напрямую, поэтому такая правка отклоняется.
    const grantsFullAdmin = Boolean(permissions.is_admin) && !permissions.is_scoped_admin;
    const current = safeParse(role.permissions_json);
    const roleHadFullAdmin = Boolean(current.is_admin) && !current.is_scoped_admin;

    if (roleHadFullAdmin && !grantsFullAdmin) {
      const remaining = await db.get(
        `SELECT COUNT(*) AS n
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.is_active = 1 AND u.role_id <> $1
           AND r.permissions_json LIKE '%"is_admin":true%'
           AND r.permissions_json NOT LIKE '%"is_scoped_admin":true%'`,
        [roleId]
      );
      if (!Number(remaining?.n || 0)) {
        return res.status(400).json({
          error: 'Нельзя снять права администратора: в системе не останется ни одного администратора'
        });
      }
    }

    const orNull = (v) => (v === undefined ? null : v);
    await db.run(
      `UPDATE roles
       SET name = COALESCE($1, name), description = COALESCE($2, description), permissions_json = $3
       WHERE id = $4`,
      [orNull(name), orNull(description), JSON.stringify(permissions), roleId]
    );

    // Права изменились — у всех, кто носит эту роль, должны обновиться и
    // выданные токены, иначе новые ограничения вступят в силу только через
    // неделю.
    await db.run('UPDATE users SET token_version = token_version + 1 WHERE role_id = $1', [roleId]);
    wsServer.disconnectUsersWithRole(roleId, 'Права вашей роли изменены администратором — войдите заново');

    AuditService.log({
      userId: req.user.id,
      action: 'role_permissions_changed',
      ip: getClientIp(req),
      details: { roleId, roleName: role.name, permissions }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── КАНАЛЫ (администрирование) ──
router.get('/admin/channels', requireAuth, requireAdmin, (req, res) => {
  try {
    const channels = getDatabase().prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS members_count,
        (SELECT COUNT(*) FROM messages WHERE conversation_type = 'channel' AND target_id = c.id) AS total_messages
      FROM channels c
      ORDER BY c.id ASC
    `).all();
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/channels', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { name, topic } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Укажите название канала' });

    const db = getDatabase();
    const now = new Date().toISOString();
    const formattedName = String(name).startsWith('#') ? String(name) : `#${name}`;
    const result = db
      .prepare('INSERT INTO channels (name, topic, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(formattedName, topic || '', 'public', req.user.id, now);
    const channelId = Number(result.lastInsertRowid);

    // Все действующие сотрудники сразу становятся участниками общего канала.
    const users = await identity().all('SELECT id FROM users WHERE is_active = 1');
    const addMember = db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    );
    for (const user of users) {
      addMember.run(channelId, user.id, user.id === req.user.id ? 'admin' : 'member', now);
    }

    const created = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    wsServer.broadcast({ type: 'channel_created', channel: created });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/admin/channels/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const channelId = Number(req.params.id);
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel) throw new Error('Канал не найден');
    if (channel.name === '#Общий' || channel.name === 'Общий') {
      throw new Error('Запрещено удалять главный корпоративный канал');
    }

    db.prepare("DELETE FROM messages WHERE conversation_type = 'channel' AND target_id = ?").run(channelId);
    db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channelId);
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);

    wsServer.broadcast({ type: 'channel_deleted', channelId });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── ИНСТРУМЕНТЫ ──
router.get('/admin/audit/messages', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json(await MessageService.searchAuditLogs(req.query.q || '', req.query.limit || 100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

router.get('/admin/tools/port-test', requireAuth, requireAdmin, (req, res) => {
  const os = require('node:os');
  const tStart = Date.now();
  res.json({
    status: 'OK',
    server_port: config.PORT,
    chat_protocol: 'TCP / WebSocket RFC 6455',
    web_admin_protocol: 'HTTP/1.1 REST JSON',
    response_time_ms: Date.now() - tStart,
    network_interfaces: Object.keys(os.networkInterfaces())
  });
});

router.post('/admin/tools/vacuum', requireAuth, requireAdmin, (req, res) => {
  try {
    const stats = DbStudioService.optimizeDatabase();
    res.json({ success: true, message: 'Оптимизация базы переписки завершена успешно', stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ФИЛЬТРЫ ──
router.get('/admin/filters', requireAuth, requireAdmin, route(async (req, res) => {
  const settings = await SettingsService.getAllSettings();
  res.json({
    antiflood_limit: Number(settings.antiflood_limit || 10),
    bad_words_enabled: settings.bad_words_enabled === 'true',
    bad_words_list: settings.bad_words_list || 'спам,мат,реклама',
    ip_blacklist: settings.ip_blacklist || ''
  });
}));

router.post('/admin/filters', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { antiflood_limit, bad_words_enabled, bad_words_list, ip_blacklist } = req.body || {};
    if (antiflood_limit !== undefined) await SettingsService.setSetting('antiflood_limit', antiflood_limit);
    if (bad_words_enabled !== undefined) await SettingsService.setSetting('bad_words_enabled', String(bad_words_enabled));
    if (bad_words_list !== undefined) await SettingsService.setSetting('bad_words_list', bad_words_list);
    if (ip_blacklist !== undefined) {
      await SettingsService.setSetting('ip_blacklist', ip_blacklist);
      AuditService.log({
        userId: req.user.id,
        action: 'ip_blacklist_changed',
        ip: getClientIp(req),
        details: { value: ip_blacklist }
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── НАСТРОЙКИ ──
router.get('/admin/settings', requireAuth, requireAdmin, route(async (req, res) => {
  res.json(await SettingsService.getAllSettings({ fresh: true }));
}));

router.put('/admin/settings', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json(await SettingsService.updateSettings(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/telegram/test', requireAuth, requireAdmin, route(async (req, res) => {
  const { bot_token, chat_id } = req.body || {};
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
          text: '🔔 *OpenMyChat Enterprise Server*\\nТестовое оповещение успешно доставлено!',
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

    res.json({
      success: true,
      bot: botInfo.result,
      message: `Бот @${botInfo.result.username} успешно проверен и готов к работе!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `Ошибка связи с api.telegram.org: ${err.message}` });
  }
}));

router.get('/admin/licenses', requireAuth, requireAdmin, route(async (req, res) => {
  const [settings, users] = await Promise.all([
    SettingsService.getAllSettings(),
    UserService.getAllUsers()
  ]);
  res.json({
    product_name: 'MyChat Server Enterprise',
    license_type: 'Корпоративная неограниченная (Enterprise LAN/WAN)',
    license_owner: settings.company_name || 'АО "Страховая компания "Сентрас Иншуранс"',
    license_key: 'MC7-ENT-CENTR-2025-9981-A4F2',
    max_online_users: 'Без ограничений',
    current_active_users: users.length,
    support_expiration: 'Бессрочная лицензия',
    registered_at: '2025-01-01'
  });
}));

// ── 3. ОРГСТРУКТУРА ──
router.get('/org/tree', requireAuth, route(async (req, res) => {
  // Контур сужает дерево только администратору подразделения. Поле
  // admin_scope_dept_id можно проставить и рядовому сотруднику — и его
  // «Контакты» молча сжимались до одного отдела.
  const scope = isScopedAdmin(req.user) ? req.user.admin_scope_dept_id : null;
  res.json(await OrgService.getOrganizationTree(scope));
}));

router.post('/org/departments', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.status(201).json(await OrgService.createDepartment(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.put('/org/departments/:id', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json(await OrgService.updateDepartment(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/org/departments/:id', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    await OrgService.deleteDepartment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/org/move-user', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { userId, departmentId } = req.body || {};
    await OrgService.moveUser(userId, departmentId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── 4. КАНАЛЫ И ПЕРЕПИСКА ──
router.get('/channels', requireAuth, (req, res) => {
  res.json(MessageService.getChannels(req.user.id));
});

router.get('/conversations/direct', requireAuth, route(async (req, res) => {
  res.json(await MessageService.getDirectConversations(req.user.id));
}));

router.get('/messages', requireAuth, route(async (req, res) => {
  try {
    const { conversationType, targetId, limit, beforeId } = req.query;
    if (!conversationType || !targetId) {
      return res.status(400).json({ error: 'Укажите conversationType и targetId' });
    }
    res.json(await MessageService.getMessages(
      conversationType,
      Number(targetId),
      req.user.id,
      limit ? parseInt(limit, 10) : 50,
      beforeId ? parseInt(beforeId, 10) : null
    ));
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
}));

router.get('/messages/direct/:targetId', requireAuth, route(async (req, res) => {
  res.json(await MessageService.getMessages(
    'direct',
    Number(req.params.targetId),
    req.user.id,
    req.query.limit ? parseInt(req.query.limit, 10) : 50,
    req.query.beforeId ? parseInt(req.query.beforeId, 10) : null
  ));
}));

router.post('/messages/direct/:targetId', requireAuth, route(async (req, res) => {
  try {
    const { text, type, reply_to_id, metadata } = req.body || {};
    const targetId = Number(req.params.targetId);
    const msg = await MessageService.sendMessage({
      conversationType: 'direct',
      targetId,
      senderId: req.user.id,
      text,
      type: type || 'text',
      replyToId: reply_to_id || null,
      metadata
    });

    for (const userId of [targetId, req.user.id]) {
      wsServer.sendToUser(userId, { type: 'direct_message', message: msg });
      wsServer.sendToUser(userId, { type: 'new_message', message: msg });
    }

    res.status(201).json(msg);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.get('/messages/channels/:targetId', requireAuth, route(async (req, res) => {
  try {
    res.json(await MessageService.getMessages(
      'channel',
      Number(req.params.targetId),
      req.user.id,
      req.query.limit ? parseInt(req.query.limit, 10) : 50,
      req.query.beforeId ? parseInt(req.query.beforeId, 10) : null
    ));
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
}));

router.post('/messages/channels/:targetId', requireAuth, route(async (req, res) => {
  try {
    const { text, type, reply_to_id, metadata } = req.body || {};
    const targetId = Number(req.params.targetId);
    const msg = await MessageService.sendMessage({
      conversationType: 'channel',
      targetId,
      senderId: req.user.id,
      text,
      type: type || 'text',
      replyToId: reply_to_id || null,
      metadata
    });

    for (const memberId of MessageService.getChannelMemberIds(targetId)) {
      wsServer.sendToUser(memberId, { type: 'channel_message', message: msg });
      wsServer.sendToUser(memberId, { type: 'new_message', message: msg });
    }

    res.status(201).json(msg);
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
}));

router.get('/messages/search', requireAuth, route(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  res.json(await MessageService.searchMessages(q, req.user.id));
}));

// ── 5. ОПОВЕЩЕНИЯ ──
router.get('/announcements', requireAuth, route(async (req, res) => {
  res.json(await AnnouncementService.getAnnouncementsForUser(req.user.id));
}));

router.post('/announcements', requireAuth, route(async (req, res) => {
  try {
    if (!req.user.permissions.can_broadcast && !req.user.permissions.is_admin) {
      return res.status(403).json({ error: 'Нет прав на отправку массовых оповещений' });
    }
    const ann = await AnnouncementService.createAnnouncement({ author_id: req.user.id, ...req.body });
    wsServer.broadcast({ type: 'new_announcement', announcement: ann });
    res.status(201).json(ann);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/announcements/:id/acknowledge', requireAuth, (req, res) => {
  try {
    const ip = getClientIp(req) || '127.0.0.1';
    const result = AnnouncementService.acknowledgeAnnouncement(req.params.id, req.user.id, ip);
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

router.get('/announcements/:id/audit', requireAuth, route(async (req, res) => {
  try {
    // Кто и когда ознакомился — сведения для тех, кто рассылает распоряжения,
    // а не для всех сотрудников.
    const permissions = req.user.permissions || {};
    if (!permissions.is_admin && !permissions.can_broadcast) {
      return res.status(403).json({ error: 'Журнал ознакомления доступен только администраторам' });
    }
    res.json(await AnnouncementService.getAnnouncementAudit(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── 6. СВЕДЕНИЯ О СЕРВЕРЕ ──
router.get('/settings/info', route(async (req, res) => {
  const settings = await SettingsService.getAllSettings();
  res.json({
    server_name: settings.server_name || 'OpenMyChat Enterprise Server',
    company_name: settings.company_name || 'Корпоративная сеть',
    allow_registration: settings.allow_registration === 'true',
    version: config.SERVER_VERSION
  });
}));

// Только названия подразделений и только пока включена самостоятельная
// регистрация: форме регистрации этот список нужен до всякой авторизации, но
// полное дерево — сотрудники, контакты, структура — не должно читаться
// анонимным вызовом.
router.get('/settings/departments', route(async (req, res) => {
  const allowRegistration = (await SettingsService.getSetting('allow_registration', 'false')) === 'true';
  if (!allowRegistration) return res.json({ departments: [] });

  const departments = await identity().all(
    'SELECT id, name FROM departments ORDER BY sort_order ASC, name ASC'
  );
  res.json({ departments });
}));

// ── ЗАЯВКИ НА РЕГИСТРАЦИЮ ──
// Сотрудник регистрируется сам, но пользоваться системой начинает только после
// подтверждения. Администратору не нужно заводить каждого руками, при этом
// посторонний в корпоративный чат не попадает.
router.get('/admin/registrations', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  const rows = await identity().all(`
    SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title,
           u.department_id, d.name AS department_name, u.registered_at
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.approval_status = 'pending'
    ORDER BY u.registered_at ASC
  `);

  // Администратор подразделения, у которого подразделение сняли (например,
  // его удалили), не видит ничего — а не заявки всей компании.
  if (isScopedAdmin(req.user) && !req.user.admin_scope_dept_id) return res.json([]);
  if (isScopedAdmin(req.user) && req.user.admin_scope_dept_id) {
    const allowed = new Set(await OrgService.getSubtreeDepartmentIds(req.user.admin_scope_dept_id));
    return res.json(rows.filter((row) => allowed.has(Number(row.department_id))));
  }
  res.json(rows);
}));

router.post('/admin/registrations/:id/approve', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    const user = await AuthService.approveUser(Number(req.params.id));
    AuditService.log({
      userId: req.user.id,
      action: 'registration_approved',
      ip: getClientIp(req),
      details: { approvedUserId: Number(req.params.id), username: user?.username }
    });
    wsServer.broadcast({ type: 'user_created', user: UserService.toPublicUser(user) });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/registrations/:id/reject', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    await AuthService.rejectUser(Number(req.params.id));
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
}));

// Журнал действий. Читать может только суперадминистратор.
router.get('/admin/audit', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json(await AuditService.list({ action: req.query.action || null, limit: req.query.limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Полные настройки содержат токен Telegram-бота и чёрный список адресов —
// только администратору. Сотрудникам нужное отдаёт /settings/info.
router.get('/settings', requireAuth, requireAdmin, route(async (req, res) => {
  res.json(await SettingsService.getAllSettings());
}));

router.put('/settings', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json(await SettingsService.updateSettings(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/channels', requireAuth, (req, res) => {
  try {
    const { name, topic, type = 'public' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Укажите название канала' });
    if (!req.user.permissions?.can_create_channels && !req.user.permissions?.is_admin) {
      return res.status(403).json({ error: 'Создание каналов не разрешено для вашей роли' });
    }
    const channel = MessageService.createChannel(name, topic, type, req.user.id);
    wsServer.broadcast({ type: 'channel_created', channel });
    res.status(201).json(channel);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 8. ФАЙЛЫ ──
// Право проверяется до приёма тела: иначе сотрудник без права загрузки всё
// равно заставлял сервер держать в памяти до 100 МБ, прежде чем получить 403.
function requireUploadPermission(req, res, next) {
  if (!req.user.permissions?.can_upload_files && !req.user.permissions?.is_admin) {
    return res.status(403).json({ error: 'Загрузка файлов не разрешена для вашей роли' });
  }
  next();
}

function acceptUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'Файл больше 100 МБ — такой файл загрузить нельзя' : `Файл не принят: ${err.message}`
    });
  });
}

router.post('/files/upload', requireAuth, requireUploadPermission, acceptUpload, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не прикреплен' });
    res.status(201).json(FileService.saveUploadedFile({
      uploaderId: req.user.id,
      originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      buffer: req.file.buffer,
      mimeType: req.file.mimetype
    }));
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
  // Тип файла назвал тот, кто его загрузил. Отданный «inline» HTML или SVG
  // исполнился бы в контексте приложения — поэтому только как вложение.
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  fs.createReadStream(file.path).pipe(res);
});

router.get('/files/recent', requireAuth, route(async (req, res) => {
  res.json(await FileService.getRecentFiles(req.user.id));
}));

// ── 9. СТУДИЯ БАЗЫ ДАННЫХ ──
// Работает только с базой переписки: учётные записи лежат в другом хранилище и
// произвольным SQL отсюда недостижимы — см. db-studio.service.js.
router.get('/admin/db/stats', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json({ ...DbStudioService.getDatabaseStats(), identity: await DbStudioService.getIdentityStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

router.get('/admin/db/tables', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(DbStudioService.getTables());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/db/tables/:name/schema', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(DbStudioService.getTableSchema(req.params.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/db/tables/:name/data', requireAuth, requireAdmin, (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    res.json(DbStudioService.getTableData(req.params.name, limit, offset));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/db/query', requireAuth, requireAdmin, (req, res) => {
  try {
    const result = DbStudioService.executeCustomSql(req.body?.sql);
    AuditService.log({
      userId: req.user.id,
      action: 'db_query_executed',
      ip: getClientIp(req),
      details: { sql: String(req.body?.sql || '').slice(0, 500) }
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/db/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(DbStudioService.backupDatabase());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/db/backups', requireAuth, requireAdmin, (req, res) => {
  res.json(DbStudioService.listBackups());
});

router.get('/admin/db/backups/:filename', requireAuth, requireAdmin, (req, res) => {
  const safeName = path.basename(req.params.filename);
  const file = path.join(config.BACKUPS_DIR, safeName);
  if (!fs.existsSync(file)) return res.status(404).send('Бэкап не найден');
  AuditService.log({
    userId: req.user.id,
    action: 'db_backup_downloaded',
    ip: getClientIp(req),
    details: { fileName: safeName }
  });
  res.download(file);
});

// ── ПРИВЯЗКА УСТРОЙСТВ ──
router.get('/admin/devices/pending', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    res.json(await DeviceService.getPendingDevices(req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

router.post('/admin/devices/bind', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    const result = await DeviceService.bindDevice({ ...req.body, adminUser: req.user });
    AuditService.log({
      userId: req.user.id,
      action: 'device_bound',
      ip: getClientIp(req),
      details: { deviceId: req.body?.device_id, targetUserId: req.body?.user_id }
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/devices/auto-match', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    res.json(await DeviceService.autoMatchByIp(req.user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/devices/unbind', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    res.json(await DeviceService.unbindDevice(req.body?.device_id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── ПАКЕТНЫЙ ИМПОРТ ОРГСТРУКТУРЫ ──
router.post('/admin/org/preview-import', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const { text, format } = req.body || {};
    res.json({ success: true, preview: OrgParserService.parseRawText(text, format || 'auto') });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/org/batch-import', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    const { text, format, defaultPassword } = req.body || {};
    const parsed = OrgParserService.parseRawText(text, format || 'auto');
    const result = await OrgParserService.applyImport({
      parsedData: parsed,
      defaultPassword: defaultPassword || UserService.generateTempPassword(),
      adminScopeDeptId: req.user.admin_scope_dept_id
    });
    AuditService.log({
      userId: req.user.id,
      action: 'org_batch_import',
      ip: getClientIp(req),
      details: { createdUsers: result.createdUsers, createdDepts: result.createdDepts }
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
