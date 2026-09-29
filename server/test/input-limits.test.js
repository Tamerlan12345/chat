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

// Настоящий принятый сеанс удалённого стола между operatorName (нужно право
// can_remote_control — в чистой установке оно есть только у суперадминистратора)
// и targetName. Нужен, чтобы у отправителя было то самое серверное состояние
// (findOpenSessionsForUser), от которого теперь зависит разбор крупного кадра
// — а не для проверки самого RD-протокола (это покрыто в ws-security.test.js).
async function openRdSession(operatorName, targetName, accessLevel = 'full') {
  const operator = await connect(operatorName);
  const target = await connect(targetName);
  operator.sock.send(JSON.stringify({ type: 'rd_request', targetUserId: people[targetName].id }));
  const requested = await waitFor(operator, (m) => m.type === 'rd_requested');
  await waitFor(target, (m) => m.type === 'rd_prompt');
  target.sock.send(JSON.stringify({ type: 'rd_response', sessionId: requested.sessionId, accepted: true, accessLevel }));
  await waitFor(operator, (m) => m.type === 'rd_response' && m.accepted);
  return { operator, target, sessionId: requested.sessionId };
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

// Раунд 1 ревью (критическая находка): исключение по размеру раньше решалось
// подстрокой в НАЧАЛЕ сырых байт кадра — а JSON допускает повторяющийся ключ
// "type" (JSON.parse оставляет ПОСЛЕДНЕЕ значение, не первое, которое видела
// подстрока) и экранированные ключи. Кадр вида
// {"type":"rd_file","targetId":X,"type":"send_message","text":"<300 КБ>"}
// показывал в начале "rd_file", а на деле был обычным send_message сверх
// лимита — предел обходился целиком. Три сценария ниже — ровно то, что
// проверяет исправленную логику: решение «разбирать ли кадр» зависит от
// серверного состояния (открытый сеанс/разговор), а не от кадра, и
// разобранный тип (а не подстрока) проверяется отдельно уже после разбора.

test('кадр с двумя "type" (без активного сеанса) отклоняется по размеру до разбора JSON', async () => {
  const client = await connect('ivanov');
  const before = (await MessageService.getMessages('direct', people.petrova.id, people.ivanov.id, 500)).length;

  const filler = 'д'.repeat(300 * 1024);
  const poison = `{"type":"rd_file","targetId":${people.petrova.id},"type":"send_message","text":"${filler}"}`;
  assert.ok(Buffer.byteLength(poison) > 256 * 1024);
  client.sock.send(poison);

  const code = await waitClosed(client);
  assert.strictEqual(code, 1009, 'у ivanov нет ни сеанса, ни разговора — крупный кадр отклоняется, не дожидаясь разбора');

  const after = (await MessageService.getMessages('direct', people.petrova.id, people.ivanov.id, 500)).length;
  assert.strictEqual(after, before, 'подложенный send_message не должен был сохраниться');
});

test('кадр с двумя "type" при активном сеансе удалённого стола всё равно отклоняется — по разобранному типу', async () => {
  const { operator, target, sessionId } = await openRdSession('admin', 'ivanov');
  try {
    const before = (await MessageService.getMessages('direct', people.petrova.id, people.ivanov.id, 500)).length;
    const filler = 'е'.repeat(300 * 1024);
    const poison = `{"type":"rd_file","sessionId":"${sessionId}","type":"send_message","text":"${filler}"}`;
    assert.ok(Buffer.byteLength(poison) > 256 * 1024);
    operator.sock.send(poison);

    const code = await waitClosed(operator);
    assert.strictEqual(code, 1008, 'активный сеанс разрешает РАЗБОР, но не отменяет проверку итогового типа');

    const after = (await MessageService.getMessages('direct', people.petrova.id, people.ivanov.id, 500)).length;
    assert.strictEqual(after, before, 'подложенный send_message не должен был сохраниться и здесь');
  } finally {
    try { target.sock.close(); } catch {}
  }
});

test('настоящий крупный кадр rd_file при активном сеансе по-прежнему доходит до второго участника', async () => {
  const { operator, target, sessionId } = await openRdSession('admin', 'petrova');
  try {
    const filler = 'ж'.repeat(300 * 1024);
    const big = JSON.stringify({ type: 'rd_file', sessionId, fileName: 'test.bin', data: filler });
    assert.ok(Buffer.byteLength(big) > 256 * 1024);
    operator.sock.send(big);

    const relayed = await waitFor(target, (m) => m.type === 'rd_file');
    assert.strictEqual(relayed.fileName, 'test.bin');
    assert.strictEqual(operator.closeCode, undefined, 'легитимный крупный кадр не должен закрывать соединение отправителя');
  } finally {
    try { operator.sock.close(); } catch {}
    try { target.sock.close(); } catch {}
  }
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

// Ревью (задача 7): успешный вход обязан снимать накопленные неудачи по паре
// адрес+логин — иначе они продолжают копиться к следующей блокировке, хотя
// подбора после успешного входа никто не вёл.
test('успешный вход сбрасывает счётчик неудачных попыток по паре адрес+логин', async () => {
  const ip = '198.51.100.99';
  const created = await UserService.createUser({
    username: 'resetcheck', full_name: 'Сброс Счётчика', password: 'Рабочий-пароль-1'
  });
  await UserService.setMustChangePassword(created.id, false);

  for (let i = 0; i < config.LOGIN_MAX_FAILED_ATTEMPTS - 1; i++) {
    await assert.rejects(() => AuthService.login('resetcheck', 'неверный', { ip }));
  }
  // Порог ещё не достигнут — верный пароль проходит и обязан сбросить счётчик.
  const ok = await AuthService.login('resetcheck', 'Рабочий-пароль-1', { ip });
  assert.ok(ok.token);

  // Без сброса эта вторая серия сложилась бы с первой и заблокировала бы вход
  // раньше, чем наберётся LOGIN_MAX_FAILED_ATTEMPTS попыток после успеха.
  for (let i = 0; i < config.LOGIN_MAX_FAILED_ATTEMPTS - 1; i++) {
    await assert.rejects(() => AuthService.login('resetcheck', 'неверный', { ip }));
  }
  const stillOk = await AuthService.login('resetcheck', 'Рабочий-пароль-1', { ip });
  assert.ok(stillOk.token, 'счётчик обязан быть сброшен успешным входом, а не продолжать копиться между сериями');
});

// Раунд 1 ревью (важная находка): панель администратора (DbStudioService.
// getIdentityStats → lockedAccounts) раньше читала users.locked_until,
// которую блокировка по IP+логину больше не пишет — счётчик был бы всегда
// нулевым либо, на старой базе, безнадёжно устаревшим.
test('lockedAccounts в панели администратора считается по новому состоянию блокировки, не по users.locked_until', async () => {
  const DbStudioService = require('../src/services/db-studio.service');
  const identityDb = require('../src/db/identity').identity();

  const created = await UserService.createUser({
    username: 'lockstat', full_name: 'Статистика Блокировки', password: 'Рабочий-пароль-1'
  });
  await UserService.setMustChangePassword(created.id, false);

  const before = await DbStudioService.getIdentityStats();

  const attackerIp = '198.51.100.201';
  for (let i = 0; i < config.LOGIN_MAX_FAILED_ATTEMPTS; i++) {
    await assert.rejects(() => AuthService.login('lockstat', 'неверный', { ip: attackerIp }));
  }

  const after = await DbStudioService.getIdentityStats();
  assert.strictEqual(after.lockedAccounts, before.lockedAccounts + 1, 'заблокированный логин должен попасть в счётчик');

  const row = await identityDb.get('SELECT locked_until FROM users WHERE id = $1', [created.id]);
  assert.strictEqual(row.locked_until, null, 'locked_until в базе этим путём больше не заполняется — счётчик не мог прийти оттуда');
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
