const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Доработка безопасности по аудиту от 17.09.2026. Каждый тест воспроизводит
// конкретную атаку, которая до исправления проходила:
//   — вход без пароля по одному лишь номеру устройства;
//   — администратор подразделения сбрасывает пароль главному и становится им;
//   — подмена автора распоряжения;
//   — открытое соединение живёт после смены пароля и отключения;
//   — анонимное соединение шлёт мегабайты до входа;
//   — консоль SQL: ATTACH за комментарием и VACUUM INTO;
//   — разный ответ на неверный пароль и на блокировку выдаёт логины;
//   — сообщения произвольного типа несуществующему адресату;
//   — сотрудник сам включает себе буфер обмена администратора;
//   — администратор подразделения открывает экран кому угодно в компании;
//   — чтение переписки администратором не оставляет следа.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.WS_REVALIDATE_MS = '300';
process.env.RD_REQUEST_TTL_MS = '600';

let baseUrl;
let wsUrl;
let server;
let identity;
let UserService;
let AuthService;
const people = {};

test.before(async () => {
  ({ identity } = await freshBoot());
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, dept: admin.department_id, password: 'парольдлятеста' };

  for (const [username, full_name] of [
    ['ivanov', 'Иванов Иван'],
    ['petrova', 'Петрова Анна'],
    ['scoped', 'Начальник Отдела'],
    ['outsider', 'Сотрудник Другого Отдела']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, password: 'Рабочий-пароль-1' };
  }

  // Администратор подразделения — в том же отделе, где числится главный.
  const scopedRole = await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`);
  // Отдельный филиал вне «Головного офиса» — вне зоны администратора подразделения.
  const otherDept = (await identity.run(
    'INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at) VALUES (NULL, $1, $2, $3, 99, $4) RETURNING id',
    ['Филиал для проверки', '', 'branch', new Date().toISOString()]
  )).rows[0];
  await identity.run('UPDATE users SET role_id = $1, department_id = $2, admin_scope_dept_id = $2 WHERE id = $3', [scopedRole.id, admin.department_id, people.scoped.id]);
  await identity.run('UPDATE users SET department_id = $1 WHERE id = $2', [admin.department_id, people.ivanov.id]);
  await identity.run('UPDATE users SET department_id = $1 WHERE id = $2', [admin.department_id, people.petrova.id]);
  await identity.run('UPDATE users SET department_id = $1 WHERE id = $2', [otherDept.id, people.outsider.id]);

  for (const name of Object.keys(people)) await refreshToken(name);
});

test.after(async () => {
  const wsServer = require('../src/ws/server');
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshToken(name) {
  people[name].token = AuthService.generateToken(await UserService.getUserById(people[name].id));
  return people[name].token;
}

async function api(method, urlPath, { body, token, headers = {} } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function openRaw(options = {}) {
  const sock = new WebSocket(wsUrl, options);
  const client = { sock, inbox: [], closed: false, closeCode: null, rejected: null };
  sock.on('message', (raw, isBinary) => {
    if (!isBinary) {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('close', (code) => { client.closed = true; client.closeCode = code; });
  sock.on('unexpected-response', (req, res) => { client.rejected = res.statusCode; client.closed = true; });
  sock.on('error', () => {});
  client.opened = new Promise((resolve) => {
    sock.on('open', () => resolve(true));
    sock.on('unexpected-response', () => resolve(false));
  });
  return client;
}

async function connect(name) {
  const client = openRaw();
  await client.opened;
  client.sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
  const reply = await waitFor(client, (m) => m.type === 'auth_success' || m.type === 'auth_error');
  if (reply.type === 'auth_error') throw new Error(reply.message);
  return client;
}

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error('событие не пришло за отведённое время');
}

async function closedWithin(client, ms) {
  const started = Date.now();
  while (!client.closed && Date.now() - started < ms) await sleep(20);
  return client.closed;
}

// ── Вход по устройству ─────────────────────────────────────────────────────

test('номер привязанного устройства без секрета токена не даёт', async () => {
  const deviceId = 'dev-ivanov-pc';
  await api('POST', '/api/auth/knock', { body: { device_id: deviceId, device_name: 'ПК Иванова' } });
  const bound = await api('POST', '/api/admin/devices/bind', { token: people.admin.token, body: { device_id: deviceId, user_id: people.ivanov.id } });
  assert.strictEqual(bound.status, 200, bound.text);
  assert.strictEqual(bound.json.token, undefined, 'привязка не выдаёт администратору токен сотрудника');

  const knock = await api('POST', '/api/auth/knock', { body: { device_id: deviceId } });
  assert.strictEqual(knock.json.status, 'login_required');
  assert.strictEqual(knock.json.token, undefined);
});

test('после входа по паролю устройство входит само, а после смены пароля — снова нет', async () => {
  const deviceId = 'dev-ivanov-pc';
  const secret = crypto.randomBytes(32).toString('base64url');

  // Чужой секрет к чужому устройству не прикрепить.
  const foreign = await api('POST', '/api/auth/device/claim', { token: people.petrova.token, body: { device_id: deviceId, device_secret: secret } });
  assert.strictEqual(foreign.json.claimed, false);

  const claim = await api('POST', '/api/auth/device/claim', { token: people.ivanov.token, body: { device_id: deviceId, device_secret: secret } });
  assert.strictEqual(claim.json.claimed, true);

  const wrong = await api('POST', '/api/auth/knock', { body: { device_id: deviceId, device_secret: crypto.randomBytes(32).toString('base64url') } });
  assert.strictEqual(wrong.json.token, undefined, 'подобранный секрет не подходит');

  const ok = await api('POST', '/api/auth/knock', { body: { device_id: deviceId, device_secret: secret } });
  assert.strictEqual(ok.json.status, 'paired');
  assert.ok(ok.json.token);

  const changed = await api('POST', '/api/users/password', {
    token: people.ivanov.token,
    body: { oldPassword: people.ivanov.password, newPassword: 'Новый-пароль-2026' }
  });
  assert.strictEqual(changed.status, 200, changed.text);
  people.ivanov.password = 'Новый-пароль-2026';
  people.ivanov.token = changed.json.token;

  const after = await api('POST', '/api/auth/knock', { body: { device_id: deviceId, device_secret: secret } });
  assert.strictEqual(after.json.token, undefined, 'смена пароля отзывает вход без пароля');
});

// ── Администратор подразделения ────────────────────────────────────────────

test('администратор подразделения не сбрасывает пароль главному администратору', async () => {
  const res = await api('POST', `/api/admin/users/${people.admin.id}/reset-password`, { token: people.scoped.token, body: {} });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /главный администратор/);
  assert.strictEqual(res.json.password, undefined);
});

test('администратор подразделения не отключает, не правит и не привязывает устройство главному', async () => {
  const off = await api('DELETE', `/api/admin/users/${people.admin.id}`, { token: people.scoped.token });
  assert.strictEqual(off.status, 400);
  const edit = await api('PUT', `/api/admin/users/${people.admin.id}`, { token: people.scoped.token, body: { job_title: 'Никто' } });
  assert.strictEqual(edit.status, 400);
  const bind = await api('POST', '/api/admin/devices/bind', { token: people.scoped.token, body: { device_id: 'dev-attacker', user_id: people.admin.id } });
  assert.strictEqual(bind.status, 400);
  assert.strictEqual(bind.json.token, undefined);
});

test('администратор подразделения по-прежнему управляет своими сотрудниками', async () => {
  const res = await api('POST', `/api/admin/users/${people.petrova.id}/reset-password`, { token: people.scoped.token, body: {} });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.password);
  people.petrova.password = res.json.password;
  await UserService.setMustChangePassword(people.petrova.id, false);
  await refreshToken('petrova');
});

// ── Подмена данных ─────────────────────────────────────────────────────────

test('автора распоряжения нельзя подставить', async () => {
  const res = await api('POST', '/api/announcements', {
    token: people.scoped.token,
    body: { title: 'Приказ', content: 'Всем сдать пароли', priority: 'normal', author_id: people.admin.id }
  });
  assert.strictEqual(res.status, 201, res.text);
  const row = await require('../src/db').getDatabase().prepare('SELECT author_id FROM announcements WHERE id = ?').get(res.json.id);
  assert.strictEqual(Number(row.author_id), people.scoped.id);
});

test('сообщение неизвестного типа или несуществующему адресату не сохраняется', async () => {
  const system = await api('POST', `/api/messages/direct/${people.petrova.id}`, { token: people.ivanov.token, body: { text: '', type: 'system' } });
  assert.strictEqual(system.status, 400);
  const ghost = await api('POST', '/api/messages/direct/424242', { token: people.ivanov.token, body: { text: 'кто здесь?' } });
  assert.strictEqual(ghost.status, 400);
});

// ── Сессии ─────────────────────────────────────────────────────────────────

test('смена пароля закрывает уже открытые соединения', async () => {
  // Злоумышленник держит соединение с украденным токеном; сотрудник меняет
  // пароль — соединение должно закрыться, а не продолжать писать от его имени.
  const stolen = await connect('petrova');
  const res = await api('POST', '/api/users/password', {
    token: people.petrova.token,
    body: { oldPassword: people.petrova.password, newPassword: 'Пароль-петровой-2' }
  });
  assert.strictEqual(res.status, 200, res.text);
  people.petrova.password = 'Пароль-петровой-2';
  people.petrova.token = res.json.token;
  assert.ok(await closedWithin(stolen, 2000), 'соединение со старым токеном закрыто');
});

test('понижение роли в обход API закрывает соединение при перепроверке', async () => {
  const sock = await connect('petrova');
  await identity.run('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [people.petrova.id]);
  assert.ok(await closedWithin(sock, 2000), 'перепроверка раз в минуту (здесь — 300 мс) закрыла соединение');
  await refreshToken('petrova');
});

test('отключение сотрудника через правку записи закрывает его соединение', async () => {
  const sock = await connect('outsider');
  const res = await api('PUT', `/api/admin/users/${people.outsider.id}`, { token: people.admin.token, body: { is_active: 0 } });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(await closedWithin(sock, 2000));
  await api('PUT', `/api/admin/users/${people.outsider.id}`, { token: people.admin.token, body: { is_active: 1 } });
  await refreshToken('outsider');
});

test('до входа нельзя прислать ничего, кроме короткого auth', async () => {
  const big = openRaw();
  await big.opened;
  big.sock.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(20000) }));
  assert.ok(await closedWithin(big, 2000), 'большое сообщение до входа закрывает соединение');

  const chatty = openRaw();
  await chatty.opened;
  chatty.sock.send(JSON.stringify({ type: 'typing', targetId: 1 }));
  assert.ok(await closedWithin(chatty, 2000), 'не-auth сообщение до входа закрывает соединение');
});

test('соединение со страницы чужого сайта не принимается', async () => {
  const evil = openRaw({ headers: { Origin: 'https://evil.example' } });
  const opened = await evil.opened;
  assert.strictEqual(opened, false);
  assert.strictEqual(evil.rejected, 403);
});

// ── Консоль SQL ────────────────────────────────────────────────────────────

test('консоль SQL не подключает чужие базы и не пишет файлы', async () => {
  for (const sql of [
    "/**/ ATTACH DATABASE 'data/identity.db' AS i",
    "-- комментарий\nATTACH 'x.db' AS x",
    "VACUUM INTO 'C:/Windows/Temp/leak.db'",
    'PRAGMA journal_mode = DELETE'
  ]) {
    const res = await api('POST', '/api/admin/db/query', { token: people.admin.token, body: { sql } });
    assert.strictEqual(res.status, 400, `${sql} → ${res.text}`);
  }
  const select = await api('POST', '/api/admin/db/query', { token: people.admin.token, body: { sql: 'SELECT COUNT(*) AS n FROM messages' } });
  assert.strictEqual(select.status, 200, select.text);
  const info = await api('POST', '/api/admin/db/query', { token: people.admin.token, body: { sql: 'PRAGMA table_info(messages)' } });
  assert.strictEqual(info.status, 200, info.text);
});

// ── Вход по паролю ─────────────────────────────────────────────────────────

test('блокировка отвечает тем же текстом, что и неверный пароль', async () => {
  const config = require('../src/config');
  const created = await UserService.createUser({ username: 'lockme2', full_name: 'Блок', password: 'Нормальный-пароль-1' });
  await UserService.setMustChangePassword(created.id, false);
  let wrongMessage;
  for (let i = 0; i < config.LOGIN_MAX_FAILED_ATTEMPTS; i++) {
    try { await AuthService.login('lockme2', 'неверный'); } catch (err) { wrongMessage = err.message; }
  }
  let lockedMessage;
  try { await AuthService.login('lockme2', 'Нормальный-пароль-1'); } catch (err) { lockedMessage = err.message; }
  let ghostMessage;
  try { await AuthService.login('нет-такого', 'что-угодно'); } catch (err) { ghostMessage = err.message; }
  assert.ok(lockedMessage, 'заблокированный не входит');
  assert.strictEqual(lockedMessage, wrongMessage);
  assert.strictEqual(ghostMessage, wrongMessage);
});

test('перебор логинов с одного адреса упирается в предел', async () => {
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await api('POST', '/api/auth/login', { body: { username: `user${i}`, password: 'подбор' } });
    if (res.status === 429) limited = true;
  }
  assert.ok(limited, 'после 30 неудач с адреса — отказ');
});

// ── Удалённый стол ─────────────────────────────────────────────────────────

test('администратор подразделения не запрашивает экран сотрудника другого отдела', async () => {
  const operator = await connect('scoped');
  await connect('outsider');
  operator.sock.send(JSON.stringify({ type: 'rd_request', targetUserId: people.outsider.id }));
  const denied = await waitFor(operator, (m) => m.type === 'rd_denied' || m.type === 'rd_requested');
  assert.strictEqual(denied.type, 'rd_denied');
  assert.match(denied.reason, /зоны/);
});

test('неотвеченный запрос удалённого доступа истекает', async () => {
  const operator = await connect('admin');
  const target = await connect('ivanov');
  operator.sock.send(JSON.stringify({ type: 'rd_request', targetUserId: people.ivanov.id }));
  const requested = await waitFor(operator, (m) => m.type === 'rd_requested');
  const ended = await waitFor(target, (m) => m.type === 'rd_end' && m.sessionId === requested.sessionId, 3000);
  assert.match(ended.reason, /истёк/);
  target.sock.send(JSON.stringify({ type: 'rd_response', sessionId: requested.sessionId, accepted: true, accessLevel: 'full' }));
  await sleep(200);
  assert.ok(!operator.inbox.some((m) => m.type === 'rd_response' && m.sessionId === requested.sessionId && m.accepted), 'запоздалое согласие не открывает сеанс');
});

test('сотрудник не включает себе буфер обмена оператора без его запроса', async () => {
  const operator = await connect('admin');
  const target = await connect('petrova');
  operator.sock.send(JSON.stringify({ type: 'rd_request', targetUserId: people.petrova.id }));
  const { sessionId } = await waitFor(operator, (m) => m.type === 'rd_requested');
  target.sock.send(JSON.stringify({ type: 'rd_response', sessionId, accepted: true, accessLevel: 'full' }));
  await waitFor(operator, (m) => m.type === 'rd_response' && m.sessionId === sessionId);

  target.sock.send(JSON.stringify({ type: 'rd_clipboard_mode', sessionId, enabled: true }));
  target.sock.send(JSON.stringify({ type: 'rd_clipboard', sessionId, text: 'от сотрудника' }));
  await sleep(250);
  assert.ok(!operator.inbox.some((m) => m.type === 'rd_clipboard_mode' || m.type === 'rd_clipboard'), 'без запроса оператора не пересылается');

  operator.sock.send(JSON.stringify({ type: 'rd_clipboard_mode', sessionId, enabled: true }));
  await waitFor(target, (m) => m.type === 'rd_clipboard_mode' && m.enabled === true);
  target.sock.send(JSON.stringify({ type: 'rd_clipboard_mode', sessionId, enabled: true }));
  await waitFor(operator, (m) => m.type === 'rd_clipboard_mode' && m.enabled === true);
  target.sock.send(JSON.stringify({ type: 'rd_end', sessionId }));
});

// ── Журнал ─────────────────────────────────────────────────────────────────

test('чтение переписки администратором записывается в журнал, администратору отдела недоступно', async () => {
  const scoped = await api('GET', '/api/admin/audit/messages?q=пароли', { token: people.scoped.token });
  assert.strictEqual(scoped.status, 403);

  const res = await api('GET', '/api/admin/audit/messages?q=кто', { token: people.admin.token });
  assert.strictEqual(res.status, 200, res.text);
  const row = await identity.get(`SELECT user_id, details_json FROM audit_logs WHERE action = 'messages_read_by_admin' ORDER BY id DESC`);
  assert.ok(row, 'событие записано');
  assert.strictEqual(Number(row.user_id), people.admin.id);
});

test('служебный отпечаток аварийного сброса не отдаётся в настройках', async () => {
  const SettingsService = require('../src/services/settings.service');
  await SettingsService.setSetting('last_admin_password_reset', 'abc');
  const res = await api('GET', '/api/admin/settings', { token: people.admin.token });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.last_admin_password_reset, undefined);
});
