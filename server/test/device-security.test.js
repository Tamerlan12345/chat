const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { freshBoot, closeAll } = require('./helpers/boot');

// Задача 1 плана «безопасность раунд 3»: закрывает находки аудита №1, №8, №9.
//   №1 — перепривязка устройства другому сотруднику наследовала секрет
//        прежнего владельца, и knock с этим секретом выдавал токен нового.
//   №8 — анонимный knock раздувал pending_devices без предела и заваливал
//        администраторов уведомлениями.
//   №9 — секрет устройства не истекал, переживал «выход», и вход по нему
//        обнулял auth_time, из-за чего SESSION_MAX_DAYS не срабатывал.
// Каждый тест воспроизводит конкретный сценарий атаки или отказа, который до
// исправления проходил бы.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let server;
let identity;
let UserService;
let AuthService;
let DeviceService;
const people = {};

test.before(async () => {
  ({ identity } = await freshBoot());
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  DeviceService = require('../src/services/device.service');
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id };
  people.admin.token = AuthService.generateToken(await UserService.getUserById(admin.id));

  for (const [username, full_name] of [
    ['ivanov', 'Иванов Иван'],
    ['petrova', 'Петрова Анна'],
    ['scoped', 'Начальник Отдела']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id };
    people[username].token = AuthService.generateToken(await UserService.getUserById(created.id));
  }

  // Контурный администратор — тот, кому по находке №1 (в связке с видимым
  // token_version) секрет чужого устройства открывал бы вход без пароля.
  const scopedRole = await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`);
  await identity.run('UPDATE users SET role_id = $1, admin_scope_dept_id = $2 WHERE id = $3', [
    scopedRole.id,
    admin.department_id,
    people.scoped.id
  ]);
  await identity.run('UPDATE users SET department_id = $1 WHERE id = $2', [admin.department_id, people.ivanov.id]);
  await identity.run('UPDATE users SET department_id = $1 WHERE id = $2', [admin.department_id, people.petrova.id]);
  people.scoped.token = AuthService.generateToken(await UserService.getUserById(people.scoped.id));
});

test.after(async () => {
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

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

async function pairingRow(deviceId) {
  return identity.get('SELECT * FROM device_pairings WHERE device_id = $1', [deviceId]);
}

// ── Находка №1: секрет привязан к владельцу ────────────────────────────────

test('перепривязка устройства другому сотруднику стирает старый секрет: knock со старым секретом не даёт токен', async () => {
  const deviceId = 'dev-rebind-1';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  const claimed = await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });
  assert.strictEqual(claimed.claimed, true);

  // Секрет claim'ил Иванов — knock под старым секретом сейчас проходит.
  const beforeRebind = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(beforeRebind.status, 'paired');
  assert.strictEqual(beforeRebind.user.id, people.ivanov.id);

  // Администратор (или контурный администратор) перепривязывает устройство
  // Петровой — обычная операция вроде передачи компьютера другому сотруднику.
  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.petrova.id, adminUser: people.admin });

  const row = await pairingRow(deviceId);
  assert.strictEqual(row.secret_hash, null, 'перепривязка обязана стереть secret_hash');
  assert.strictEqual(row.secret_token_version, null);
  assert.strictEqual(row.secret_user_id, null);

  // Старый секрет Иванова не должен впустить под именем Петровой.
  const afterRebind = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(afterRebind.status, 'login_required');
  assert.strictEqual(afterRebind.token, undefined);
});

test('autoMatchByIp тоже стирает старый секрет при смене владельца устройства', async () => {
  const deviceId = 'dev-rebind-automatch';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });

  await identity.run('UPDATE users SET bound_ip = $1 WHERE id = $2', ['10.20.30.40', people.petrova.id]);
  await identity.run(
    `INSERT INTO pending_devices (device_id, device_name, ip_address, platform, client_version, status, first_knock_at, last_knock_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)`,
    [deviceId, 'ПК', '10.20.30.40', 'Windows', '1.0.0', new Date().toISOString()]
  );

  await DeviceService.autoMatchByIp(people.admin);

  const row = await pairingRow(deviceId);
  assert.strictEqual(row.user_id, people.petrova.id);
  assert.strictEqual(row.secret_hash, null, 'autoMatchByIp обязан стереть secret_hash при смене владельца');

  const knock = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(knock.status, 'login_required');
});

// ── Находка №9: auth_time переносится из claim, секрет истекает ───────────

test('токен по устройству несёт auth_time из момента claim, а не время knock', async () => {
  const deviceId = 'dev-authtime-1';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });

  // Симулируется claim, случившийся пять дней назад — так проверка не зависит
  // от того, сколько миллисекунд ушло на сам тест.
  const claimedAt = new Date(Date.now() - 5 * 86400000);
  await identity.run('UPDATE device_pairings SET secret_auth_time = $1 WHERE device_id = $2', [
    claimedAt.toISOString(),
    deviceId
  ]);

  const knock = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(knock.status, 'paired');
  assert.ok(knock.token);

  const payload = AuthService.verifyToken(knock.token);
  assert.ok(payload, 'токен обязан проходить проверку подписи');
  const expectedAuthTime = Math.floor(claimedAt.getTime() / 1000);
  assert.strictEqual(payload.auth_time, expectedAuthTime, 'auth_time обязан быть временем claim, а не knock');
  assert.notStrictEqual(payload.auth_time, payload.iat, 'iat (сейчас) не должен совпасть с перенесённым auth_time');
});

test('истёкший секрет устройства требует пароль (login_required)', async () => {
  const deviceId = 'dev-expired-1';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });

  await identity.run('UPDATE device_pairings SET secret_expires_at = $1 WHERE device_id = $2', [
    new Date(Date.now() - 1000).toISOString(),
    deviceId
  ]);

  const knock = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(knock.status, 'login_required');
  assert.strictEqual(knock.token, undefined);
});

// ── Выход отвязывает секрет (POST /api/auth/device/unbind) ────────────────

test('выход (unbind) стирает секрет своего устройства: knock после этого требует пароль', async () => {
  const deviceId = 'dev-unbind-own';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });

  const res = await api('POST', '/api/auth/device/unbind', { token: people.ivanov.token, body: { device_id: deviceId } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.ok, true);

  const row = await pairingRow(deviceId);
  assert.strictEqual(row.secret_hash, null);
  assert.strictEqual(row.secret_token_version, null);
  assert.strictEqual(row.secret_user_id, null);
  // Привязка устройства к сотруднику остаётся — unbind при выходе снимает
  // только секрет («это не моё устройство больше»), не саму пару device↔user,
  // которой распоряжается администратор через /api/admin/devices/unbind.
  assert.strictEqual(row.user_id, people.ivanov.id);

  const knock = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(knock.status, 'login_required');
});

test('unbind чужого устройства не стирает секрет владельца', async () => {
  const deviceId = 'dev-unbind-foreign';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });

  // Петрова просит отвязать чужое устройство. Ответ не должен подтверждать
  // или опровергать существование чужой привязки, но и менять её не должен.
  const res = await api('POST', '/api/auth/device/unbind', { token: people.petrova.token, body: { device_id: deviceId } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.ok, true);

  const row = await pairingRow(deviceId);
  assert.ok(row.secret_hash, 'чужой unbind не должен был стереть secret_hash владельца');

  const knock = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(knock.status, 'paired', 'чужой unbind не должен был затронуть секрет Иванова');
  assert.strictEqual(knock.user.id, people.ivanov.id);
});

// ── Исправление №1 (раунд ревью): реальный порядок клиента ────────────────
//
// Клиент раньше звал /auth/logout (отзывает токен), а ПОТОМ отдельным
// запросом /api/auth/device/unbind тем же, уже отозванным токеном — второй
// запрос получал 401 ещё до DeviceService, и он молча проглатывался. Секрет
// оставался действующим после обычного выхода (находка №9б). Исправление:
// /auth/logout сам отвязывает секрет, если ему передан device_id, — одним
// запросом, порядок вызовов клиента больше не имеет значения.

test('/auth/logout с device_id в теле (как реально шлёт клиент) отвязывает секрет тем же запросом, что отзывает токен', async () => {
  const deviceId = 'dev-logout-order';
  const secret = randomSecret();
  // Отдельный токен: этот тест его отзовёт, остальные тесты файла своими
  // токенами людей из people не должны от этого пострадать.
  const freshToken = AuthService.generateToken(await UserService.getUserById(people.ivanov.id));

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });

  // Именно так, как отправляет desktop/App.jsx: один запрос на /auth/logout,
  // device_id — в теле, без отдельного похода на /api/auth/device/unbind.
  const logout = await api('POST', '/api/auth/logout', { token: freshToken, body: { device_id: deviceId } });
  assert.strictEqual(logout.status, 200, logout.text);

  // Токен действительно отозван — это не подмена проверки.
  const me = await api('GET', '/api/auth/me', { token: freshToken });
  assert.strictEqual(me.status, 401, 'токен обязан быть отозван, как и раньше');

  const row = await pairingRow(deviceId);
  assert.strictEqual(row.secret_hash, null, 'логаут обязан был отвязать секрет тем же запросом');
  assert.strictEqual(row.secret_user_id, null);

  const knock = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '127.0.0.1' });
  assert.strictEqual(knock.status, 'login_required', 'старый секрет не должен впускать после выхода');
});

test('сотрудник с обязательной сменой пароля тоже может отвязать секрет устройства (не 403)', async () => {
  // Новая учётная запись по умолчанию создаётся с must_change_password = 1 —
  // тем самым режимом, в котором PASSWORD_CHANGE_ALLOWLIST раньше не пускал
  // /api/auth/device/unbind, и запрос отвечал 403, который клиент молча
  // проглатывал (второй корень находки №9б).
  const created = await UserService.createUser({
    username: 'mustchange-unbind',
    full_name: 'Обязан Сменить Пароль',
    password: 'Рабочий-пароль-1'
  });
  const forcedUser = await UserService.getUserById(created.id);
  assert.strictEqual(Number(forcedUser.must_change_password), 1, 'предпосылка теста: пароль ещё не менялся');
  const token = AuthService.generateToken(forcedUser);

  const deviceId = 'dev-mustchange-unbind';
  const secret = randomSecret();
  await DeviceService.bindDevice({ device_id: deviceId, user_id: created.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: created.id, device_id: deviceId, device_secret: secret });

  const res = await api('POST', '/api/auth/device/unbind', { token, body: { device_id: deviceId } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.ok, true);

  const row = await pairingRow(deviceId);
  assert.strictEqual(row.secret_hash, null, 'обязательная смена пароля не должна мешать отвязке секрета');
});

// ── Находка №8: knock ограничен ────────────────────────────────────────────

test('21-й knock с новым device_id с одного IP получает 429, в pending_devices остаётся 20 строк', async () => {
  const ip = '10.77.77.77';
  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await DeviceService.knock({ device_id: `dev-flood-${i}`, ip_address: ip, device_name: 'ПК' });
    assert.strictEqual(last.status, 'pending', `узел ${i} обязан встать в очередь`);
  }

  const count20 = await identity.get('SELECT COUNT(*) AS c FROM pending_devices WHERE ip_address = $1', [ip]);
  assert.strictEqual(Number(count20.c), 20);

  const overflow = await DeviceService.knock({ device_id: 'dev-flood-20', ip_address: ip, device_name: 'ПК' });
  assert.strictEqual(overflow.status, 'too_many_pending');

  const count21 = await identity.get('SELECT COUNT(*) AS c FROM pending_devices WHERE ip_address = $1', [ip]);
  assert.strictEqual(Number(count21.c), 20, 'лишняя строка вставлена не быть должна');

  // Тот же самый (уже известный) device_id продолжает обновлять свою строку —
  // предел считает только НОВЫЕ идентификаторы, не повторные "стуки".
  const repeat = await DeviceService.knock({ device_id: 'dev-flood-0', ip_address: ip, device_name: 'ПК' });
  assert.strictEqual(repeat.status, 'pending');
  const countRepeat = await identity.get('SELECT COUNT(*) AS c FROM pending_devices WHERE ip_address = $1', [ip]);
  assert.strictEqual(Number(countRepeat.c), 20);
});

test('маршрут /api/auth/knock превращает too_many_pending в HTTP 429', async () => {
  // Настоящий HTTP-запрос с этого тестового процесса всегда приходит с
  // 127.0.0.1 (локальный сокет) — очередь для этого адреса заполняется
  // напрямую через сервис, а последний «стук» идёт по-настоящему через HTTP,
  // чтобы проверить именно перевод too_many_pending в код ответа 429.
  for (let i = 0; i < 20; i++) {
    await DeviceService.knock({ device_id: `dev-http-flood-${i}`, ip_address: '127.0.0.1' });
  }
  const res = await api('POST', '/api/auth/knock', { body: { device_id: 'dev-http-flood-20' } });
  assert.strictEqual(res.status, 429, res.text);
});

test('device_name длиной 10000 символов обрезается до ≤128 в базе (или отклоняется)', async () => {
  const deviceId = 'dev-longname-1';
  const longName = 'А'.repeat(10000);
  const result = await DeviceService.knock({ device_id: deviceId, device_name: longName, ip_address: '10.99.99.99' });

  if (result.status === 'pending') {
    const row = await identity.get('SELECT device_name FROM pending_devices WHERE device_id = $1', [deviceId]);
    assert.ok(row, 'узел обязан быть сохранён (или запрос отклонён отдельно)');
    assert.ok(row.device_name.length <= 128, `device_name в базе длиной ${row.device_name.length}, ожидалось ≤128`);
  } else {
    assert.strictEqual(result.status, 'rejected');
  }
});

// ── Задача 10 (интерфейс автообновления): версия клиента живая ────────────
//
// Раньше уже привязанное устройство обновляло в pending_devices только
// last_knock_at/ip_address/status при каждом «стуке» — client_version
// оставался тем, что было записано при самом первом (ещё не привязанном)
// обращении. Консоль «Обновления» (fleet.byVersion) показывала бы старую
// версию сколько угодно долго после того, как клиент обновился.

test('повторный knock уже привязанного устройства обновляет client_version в pending_devices', async () => {
  const deviceId = 'dev-clientversion-1';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });

  // Первый knock уже был неявно (bindDevice не пишет client_version), поэтому
  // строка в pending_devices у этого устройства ещё не существует. Заводим
  // её так, как реально сделал бы первый анонимный «стук» со старой версией.
  await identity.run(
    `INSERT INTO pending_devices (device_id, device_name, ip_address, platform, client_version, status, first_knock_at, last_knock_at)
     VALUES ($1, $2, $3, $4, $5, 'paired', $6, $6)`,
    [deviceId, 'ПК', '127.0.0.1', 'Windows', '1.0.0', new Date().toISOString()]
  );

  const knock = await DeviceService.knock({
    device_id: deviceId,
    device_secret: secret,
    ip_address: '127.0.0.1',
    client_version: '1.2.0'
  });
  assert.strictEqual(knock.status, 'paired');

  const row = await identity.get('SELECT client_version FROM pending_devices WHERE device_id = $1', [deviceId]);
  assert.strictEqual(row.client_version, '1.2.0', 'client_version обязан обновиться и на уже привязанном устройстве');
});

test('client_version у привязанного устройства обрезается тем же пределом (32 символа), что и у ещё не привязанного', async () => {
  const deviceId = 'dev-clientversion-cap';
  const secret = randomSecret();

  await DeviceService.bindDevice({ device_id: deviceId, user_id: people.ivanov.id, adminUser: people.admin });
  await DeviceService.claimDeviceSecret({ userId: people.ivanov.id, device_id: deviceId, device_secret: secret });
  await identity.run(
    `INSERT INTO pending_devices (device_id, device_name, ip_address, platform, client_version, status, first_knock_at, last_knock_at)
     VALUES ($1, $2, $3, $4, $5, 'paired', $6, $6)`,
    [deviceId, 'ПК', '127.0.0.1', 'Windows', '1.0.0', new Date().toISOString()]
  );

  const longVersion = '9'.repeat(10000);
  const knock = await DeviceService.knock({
    device_id: deviceId,
    device_secret: secret,
    ip_address: '127.0.0.1',
    client_version: longVersion
  });
  assert.strictEqual(knock.status, 'paired');

  const row = await identity.get('SELECT client_version FROM pending_devices WHERE device_id = $1', [deviceId]);
  assert.ok(row.client_version.length <= 32, `client_version в базе длиной ${row.client_version.length}, ожидалось ≤32`);
});

// ── Находка №1 (продолжение): token_version не для контурных администраторов ─

test('GET /api/admin/users: контурный администратор не видит token_version, суперадминистратор — видит', async () => {
  const scoped = await api('GET', '/api/admin/users', { token: people.scoped.token });
  assert.strictEqual(scoped.status, 200, scoped.text);
  assert.ok(scoped.json.length > 0);
  for (const user of scoped.json) {
    assert.ok(!('token_version' in user), `контурному администратору отдано token_version у ${user.username}`);
  }

  const full = await api('GET', '/api/admin/users', { token: people.admin.token });
  assert.strictEqual(full.status, 200, full.text);
  const ivanovRow = full.json.find((u) => u.id === people.ivanov.id);
  assert.ok(ivanovRow);
  assert.ok('token_version' in ivanovRow, 'суперадминистратору token_version нужен для диагностики');
});
