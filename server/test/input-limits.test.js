const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Задача 3 плана «безопасность раунд 3»: закрывает находки аудита №5, №7,
// №12, №16, №17, №18.
//   №5  — самостоятельное изменение профиля принимало ФИО/должность и
//         email/телефон любой длины и формата (импersonация, амплификация).
//   №7  — текст сообщения и WS-кадр не имели верхней границы.
//   №12 — блокировка входа после серии неудач держалась на учётной записи
//         целиком, и с любого адреса запирала её для всех.
//   №16 — автоимпорт из резервных файлов срабатывал сам по себе, стоило
//         рабочему хранилищу оказаться пустым.
//   №17 — токен старого (миллисекундного) формата принимался бессрочно.
//   №18 — /health отдавал версию и хранилище анонимному запросу; scrypt имел
//         заниженную стоимость; права роли сохранялись без проверки ключей.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let UserService;
let AuthService;
let MessageService;
let config;
const people = {};

test.before(async () => {
  await freshBoot();
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  MessageService = require('../src/services/message.service');
  config = require('../src/config');
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
  people.admin = { id: admin.id };
  people.admin.token = AuthService.generateToken(await UserService.getUserById(admin.id));

  for (const [username, full_name] of [
    ['ivanov', 'Иванов Иван'],
    ['petrova', 'Петрова Анна']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: AuthService.generateToken(await UserService.getUserById(created.id)) };
  }
});

test.after(async () => {
  const wsServer = require('../src/ws/server');
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(name) {
  const sock = new WebSocket(wsUrl);
  const client = { sock, inbox: [] };
  sock.on('message', (raw, isBinary) => {
    if (!isBinary) {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('close', (code) => { client.closeCode = code; });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.on('open', resolve));
  sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
  await waitFor(client, (m) => m.type === 'auth_success');
  return client;
}

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    if (client.closeCode !== undefined) break;
    await sleep(15);
  }
  throw new Error('событие не пришло за отведённое время');
}

async function waitClosed(client, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (client.closeCode !== undefined) return client.closeCode;
    await sleep(15);
  }
  throw new Error('соединение не закрылось за отведённое время');
}

// ── Находка №5: профиль ─────────────────────────────────────────────────

test('PUT /api/users/profile игнорирует full_name — меняет только администратор', async () => {
  const before = await UserService.getUserById(people.ivanov.id);
  const res = await api('PUT', '/api/users/profile', {
    token: people.ivanov.token,
    body: { full_name: 'Директор' }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.full_name, before.full_name, 'ФИО не должно было измениться');

  const after = await UserService.getUserById(people.ivanov.id);
  assert.strictEqual(after.full_name, before.full_name);
});

test('PUT /api/users/profile игнорирует job_title', async () => {
  const before = await UserService.getUserById(people.ivanov.id);
  const res = await api('PUT', '/api/users/profile', {
    token: people.ivanov.token,
    body: { job_title: 'Генеральный директор' }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.job_title, before.job_title);
});

test('PUT /api/users/profile: неверный email — 400', async () => {
  const res = await api('PUT', '/api/users/profile', { token: people.ivanov.token, body: { email: 'x' } });
  assert.strictEqual(res.status, 400, res.text);
  assert.match(res.json.error, /email/i);
});

test('PUT /api/users/profile: неверный телефон — 400', async () => {
  const res = await api('PUT', '/api/users/profile', { token: people.ivanov.token, body: { phone: 'abc' } });
  assert.strictEqual(res.status, 400, res.text);
});

test('PUT /api/users/profile: email длиной 300 символов — 400', async () => {
  const longEmail = `${'a'.repeat(290)}@x.kz`;
  assert.ok(longEmail.length > 254);
  const res = await api('PUT', '/api/users/profile', { token: people.ivanov.token, body: { email: longEmail } });
  assert.strictEqual(res.status, 400, res.text);
});

test('PUT /api/users/profile: корректные email и телефон принимаются', async () => {
  const res = await api('PUT', '/api/users/profile', {
    token: people.ivanov.token,
    body: { email: 'ivanov@example.kz', phone: '+7 (701) 123-45-67' }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.email, 'ivanov@example.kz');
});

test('PUT /admin/users/:id: администратор тоже упирается в предел длины ФИО/должности', async () => {
  const res = await api('PUT', `/api/admin/users/${people.ivanov.id}`, {
    token: people.admin.token,
    body: { full_name: 'A'.repeat(121) }
  });
  assert.strictEqual(res.status, 400, res.text);
});

test('PUT /admin/users/:id: администратор по-прежнему меняет ФИО в пределах длины', async () => {
  const res = await api('PUT', `/api/admin/users/${people.ivanov.id}`, {
    token: people.admin.token,
    body: { full_name: 'Иванов Иван Иванович' }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.full_name, 'Иванов Иван Иванович');
});

// ── Находка №7 (текст сообщения): MessageService.MAX_TEXT_LENGTH ──────────

test('MessageService.MAX_TEXT_LENGTH экспортирована и равна 16000', () => {
  assert.strictEqual(MessageService.MAX_TEXT_LENGTH, 16000);
});

test('сообщение длиной 16001 символ отклоняется', async () => {
  await assert.rejects(
    () => MessageService.sendMessage({
      conversationType: 'direct',
      targetId: people.petrova.id,
      senderId: people.ivanov.id,
      text: 'а'.repeat(16001)
    }),
    /не больше 16000/
  );
});

test('сообщение длиной 16000 символов доставляется', async () => {
  const saved = await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: people.petrova.id,
    senderId: people.ivanov.id,
    text: 'б'.repeat(16000)
  });
  assert.strictEqual(saved.text.length, 16000);
});

// ── Находка №7 (WS-кадр): предел 256 КБ до JSON.parse ──────────────────────

test('WS-кадр 300 КБ типа send_message закрывает соединение, сообщение не сохраняется', async () => {
  const client = await connect('ivanov');
  const before = (await MessageService.getMessages('direct', people.petrova.id, people.ivanov.id, 500)).length;

  const oversized = JSON.stringify({
    type: 'send_message',
    conversationType: 'direct',
    targetId: people.petrova.id,
    text: 'в'.repeat(300 * 1024)
  });
  assert.ok(Buffer.byteLength(oversized) > 300 * 1024 - 100);
  client.sock.send(oversized);

  const code = await waitClosed(client);
  assert.strictEqual(code, 1009, 'соединение должно закрыться кодом «кадр слишком большой»');

  const after = (await MessageService.getMessages('direct', people.petrova.id, people.ivanov.id, 500)).length;
  assert.strictEqual(after, before, 'сообщение не должно было сохраниться');
});

test('крупный кадр rd_file не отклоняется предельным размером обычных кадров', async () => {
  // Прямой сеанс удалённого стола здесь не поднимается — важно только то, что
  // кадр за 256 КБ с типом rd_file не закрывает соединение сразу же, как это
  // происходит для send_message. Сервер довалидирует его дальше по смыслу
  // (нет такого сеанса) и просто промолчит, а не закроет по размеру.
  const client = await connect('petrova');
  const big = JSON.stringify({
    type: 'rd_file',
    sessionId: 'нет-такого-сеанса',
    fileName: 'test.bin',
    data: 'г'.repeat(300 * 1024)
  });
  assert.ok(Buffer.byteLength(big) > 256 * 1024);
  client.sock.send(big);
  await sleep(300);
  assert.strictEqual(client.closeCode, undefined, 'большой кадр разрешённого типа не должен закрывать соединение');
  client.sock.close();
});

// ── Находка №17: старые токены отклоняются после отсечки ───────────────────

function signLegacyToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

test('токен с exp в миллисекундах после LEGACY_TOKEN_CUTOFF — 401', async () => {
  const originalCutoff = config.LEGACY_TOKEN_CUTOFF;
  config.LEGACY_TOKEN_CUTOFF = '2000-01-01T00:00:00Z'; // отсечка уже наступила
  try {
    const legacyToken = signLegacyToken({
      userId: people.ivanov.id,
      username: 'ivanov',
      roleId: null,
      tv: 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Date.now() + 7 * 86400000, // формат в миллисекундах — признак старого токена
      amr: 'pwd'
    });
    const res = await api('GET', '/api/auth/me', { token: legacyToken });
    assert.strictEqual(res.status, 401, res.text);
  } finally {
    config.LEGACY_TOKEN_CUTOFF = originalCutoff;
  }
});

test('тот же токен до отсечки всё ещё принимается (обратная совместимость)', async () => {
  const originalCutoff = config.LEGACY_TOKEN_CUTOFF;
  config.LEGACY_TOKEN_CUTOFF = '2099-01-01T00:00:00Z'; // отсечка далеко впереди
  try {
    const legacyToken = signLegacyToken({
      userId: people.ivanov.id,
      username: 'ivanov',
      roleId: null,
      tv: 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Date.now() + 7 * 86400000,
      amr: 'pwd'
    });
    const res = await api('GET', '/api/auth/me', { token: legacyToken });
    assert.strictEqual(res.status, 200, res.text);
  } finally {
    config.LEGACY_TOKEN_CUTOFF = originalCutoff;
  }
});

// ── Находка №12: блокировка по IP+имени, не по учётной записи ──────────────

test('11 неудачных входов с одного адреса для admin не запирают вход с другого адреса', async () => {
  const attackerIp = '198.51.100.77';
  for (let i = 0; i < 11; i++) {
    await assert.rejects(() => AuthService.login('admin', 'неверный-пароль', { ip: attackerIp }));
  }
  const fromElsewhere = await AuthService.login('admin', 'парольдлятеста', { ip: '203.0.113.44' });
  assert.ok(fromElsewhere.token, 'с другого адреса верный пароль администратора должен пройти');
});

// ── Находка №18 (/health): анонимному запросу — только status ──────────────

test('анонимный GET /health отдаёт только status', async () => {
  const res = await api('GET', '/health');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(Object.keys(res.json), ['status']);
});

test('GET /health с токеном супер-администратора отдаёт версию и хранилище', async () => {
  const res = await api('GET', '/health', { token: people.admin.token });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.version);
  assert.ok(['postgres', 'sqlite'].includes(res.json.identityStore));
});

test('GET /health с токеном обычного сотрудника — тоже только status', async () => {
  const res = await api('GET', '/health', { token: people.ivanov.token });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(Object.keys(res.json), ['status']);
});

// ── Находка №18 (scrypt): N поднят до 2^17 ──────────────────────────────────

test('новый хеш пароля несёт параметр N=131072', async () => {
  const { hashPassword, CURRENT_PARAMS } = require('../src/db/identity/password');
  assert.strictEqual(CURRENT_PARAMS.N, 131072);
  const encoded = await hashPassword('проверочный-пароль-1');
  assert.match(encoded, /N=131072/);
});

// ── Находка №18 (права роли): только известные ключи, только boolean ───────

test('PUT /admin/roles/:id отклоняет неизвестный ключ права', async () => {
  const roles = await api('GET', '/api/admin/roles', { token: people.admin.token });
  const employeeRole = roles.json.find((r) => r.name === 'Сотрудник');
  assert.ok(employeeRole, 'роль «Сотрудник» должна существовать в чистой установке');

  const res = await api('PUT', `/api/admin/roles/${employeeRole.id}`, {
    token: people.admin.token,
    body: { permissions: { ...employeeRole.permissions, is_god: true } }
  });
  assert.strictEqual(res.status, 400, res.text);
});

test('PUT /admin/roles/:id отклоняет не-boolean значение права', async () => {
  const roles = await api('GET', '/api/admin/roles', { token: people.admin.token });
  const employeeRole = roles.json.find((r) => r.name === 'Сотрудник');

  const res = await api('PUT', `/api/admin/roles/${employeeRole.id}`, {
    token: people.admin.token,
    body: { permissions: { ...employeeRole.permissions, can_broadcast: 'yes' } }
  });
  assert.strictEqual(res.status, 400, res.text);
});

test('PUT /admin/roles/:id по-прежнему принимает только известные булевы права', async () => {
  const roles = await api('GET', '/api/admin/roles', { token: people.admin.token });
  const employeeRole = roles.json.find((r) => r.name === 'Сотрудник');

  const res = await api('PUT', `/api/admin/roles/${employeeRole.id}`, {
    token: people.admin.token,
    body: { permissions: { ...employeeRole.permissions, can_broadcast: true } }
  });
  assert.strictEqual(res.status, 200, res.text);
});

// ── Находка №16: автоимпорт из резервных файлов требует явного флага ───────

test('findImportSource пропускает резервный файл без IDENTITY_AUTO_IMPORT и находит его с флагом', () => {
  const { findImportSource } = require('../src/db/identity');
  const { buildLegacyDatabase } = require('./helpers/legacy-db');

  const snapshotPath = path.join(config.DATA_DIR, 'pre-identity-split.db');
  fs.rmSync(snapshotPath, { force: true });
  fs.rmSync(`${snapshotPath}-wal`, { force: true });
  fs.rmSync(`${snapshotPath}-shm`, { force: true });
  buildLegacyDatabase(snapshotPath);

  const originalFlag = config.IDENTITY_AUTO_IMPORT;
  try {
    config.IDENTITY_AUTO_IMPORT = false;
    const skipped = findImportSource({ dialect: 'sqlite', legacyDb: null });
    assert.strictEqual(skipped, null, 'без флага резервный файл не должен использоваться как источник');

    config.IDENTITY_AUTO_IMPORT = true;
    const found = findImportSource({ dialect: 'sqlite', legacyDb: null });
    assert.ok(found, 'с флагом резервный файл должен находиться');
    assert.match(found.label, /pre-identity-split/);
    found.close();
  } finally {
    config.IDENTITY_AUTO_IMPORT = originalFlag;
    fs.rmSync(snapshotPath, { force: true });
    fs.rmSync(`${snapshotPath}-wal`, { force: true });
    fs.rmSync(`${snapshotPath}-shm`, { force: true });
  }
});
