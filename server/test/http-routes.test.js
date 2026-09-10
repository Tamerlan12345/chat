const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Поднимает настоящий сервер и ходит по нему по HTTP. Остальные тесты
// проверяют сервисы напрямую и не заметят, если сломается маршрутизация,
// разбор тела запроса или порядок промежуточных обработчиков — а именно это
// ломается при смене версии Express.
const DB_PATH = path.resolve(__dirname, '../data/mychat.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch {}
}

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.PORT = '0'; // свободный порт выбирает система

let baseUrl;
let server;

test.before(async () => {
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
});

const request = async (method, urlPath, { body, token, headers = {} } = {}) => {
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
};

test('/health отвечает без авторизации', async () => {
  const res = await request('GET', '/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.status, 'ok');
});

test('/api/settings/info открыт и отдаёт название компании', async () => {
  const res = await request('GET', '/api/settings/info');
  assert.strictEqual(res.status, 200);
  assert.ok(res.json.company_name);
});

test('защищённый маршрут без токена отвечает 401', async () => {
  const res = await request('GET', '/api/users');
  assert.strictEqual(res.status, 401);
});

test('вход разбирает тело запроса и выдаёт токен', async () => {
  // Проверяет express.json(): при смене версии Express это первое, что ломается.
  const res = await request('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'парольдлятеста' }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.token);
  globalThis.__token = res.json.token;
});

test('неверный пароль отвечает 400 с сообщением', async () => {
  const res = await request('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'неверный' }
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /пароль/i);
});

test('токен открывает защищённый маршрут', async () => {
  const res = await request('GET', '/api/auth/me', { token: globalThis.__token });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.user.username, 'admin');
});

test('до смены пароля остальные маршруты закрыты', async () => {
  // Начальный пароль обязателен к смене, и до неё доступны только «кто я» и
  // сама смена. Проверяется, что заслон действительно стоит.
  const res = await request('GET', '/api/users', { token: globalThis.__token });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json.code, 'MUST_CHANGE_PASSWORD');
});

test('смена пароля снимает ограничение', async () => {
  const res = await request('POST', '/api/users/password', {
    token: globalThis.__token,
    body: { oldPassword: 'парольдлятеста', newPassword: 'новыйпарольтеста' }
  });
  assert.strictEqual(res.status, 200, res.text);

  const relogin = await request('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'новыйпарольтеста' }
  });
  assert.strictEqual(relogin.status, 200, relogin.text);
  globalThis.__token = relogin.json.token;

  const users = await request('GET', '/api/users', { token: globalThis.__token });
  assert.strictEqual(users.status, 200, 'после смены пароля доступ открывается');
});

test('параметр в пути маршрута разбирается', async () => {
  const res = await request('GET', '/api/users/1', { token: globalThis.__token });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.id, 1);
});

test('строка запроса разбирается', async () => {
  const res = await request('GET', '/api/admin/audit?limit=5', { token: globalThis.__token });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.json));
});

test('несуществующий маршрут API не притворяется успешным', async () => {
  const res = await request('GET', '/api/такого-нет', { token: globalThis.__token });
  assert.notStrictEqual(res.status, 200);
});

test('заголовки безопасности выставлены', async () => {
  const res = await fetch(baseUrl + '/health');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!res.headers.get('x-powered-by'), 'версия сервера не должна раскрываться');
});
