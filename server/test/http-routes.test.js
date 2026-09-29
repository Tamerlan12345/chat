const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { freshBoot, closeAll } = require('./helpers/boot');

// Поднимает настоящий сервер и ходит по нему по HTTP. Остальные тесты
// проверяют сервисы напрямую и не заметят, если сломается маршрутизация,
// разбор тела запроса или порядок промежуточных обработчиков — а именно это
// ломается при смене версии Express.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.PORT = '0'; // свободный порт выбирает система

let baseUrl;
let server;

test.before(async () => {
  await freshBoot();
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await closeAll();
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

test('смена пароля снимает ограничение и выдаёт новый токен', async () => {
  const res = await request('POST', '/api/users/password', {
    token: globalThis.__token,
    body: { oldPassword: 'парольдлятеста', newPassword: 'новыйпарольтеста' }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.token, 'прежний токен только что отозван — без нового работать нечем');

  // Прежний токен обязан перестать действовать сразу, а не через неделю.
  const stale = await request('GET', '/api/auth/me', { token: globalThis.__token });
  assert.strictEqual(stale.status, 401);

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

test('справочник сотрудников не раскрывает адреса рабочих мест', async () => {
  // bound_ip — служебное сведение для привязки устройств, а не часть карточки
  // коллеги. В общем справочнике его быть не должно.
  const res = await request('GET', '/api/users', { token: globalThis.__token });
  assert.strictEqual(res.status, 200);
  for (const user of res.json) {
    assert.ok(!('bound_ip' in user), 'адрес рабочего места не для всех');
    assert.ok(!('password_hash' in user), 'пароль не покидает хранилище ни при каких условиях');
  }
});

test('студия базы данных не видит учётных записей', async () => {
  // Ради этого учётные записи и переехали: произвольный SQL — самое сильное
  // право в панели, и хэши паролей не должны быть в его досягаемости.
  const tables = await request('GET', '/api/admin/db/tables', { token: globalThis.__token });
  assert.strictEqual(tables.status, 200);
  const names = tables.json.map((t) => t.name);
  assert.ok(!names.includes('users'), 'таблицы users в базе переписки быть не должно');
  assert.ok(names.includes('messages'), 'а переписка — на месте');

  const query = await request('POST', '/api/admin/db/query', {
    token: globalThis.__token,
    body: { sql: 'SELECT * FROM users' }
  });
  assert.strictEqual(query.status, 400, 'такой таблицы здесь нет');

  const attach = await request('POST', '/api/admin/db/query', {
    token: globalThis.__token,
    body: { sql: "ATTACH DATABASE 'data/identity.db' AS ident" }
  });
  assert.strictEqual(attach.status, 400);
  assert.match(attach.json.error, /ATTACH/);
});

test('/health без токена не выдаёт подробностей — только статус', async () => {
  const res = await request('GET', '/health');
  assert.deepStrictEqual(Object.keys(res.json), ['status'], 'анонимному запросу — только состояние (аудит, находка №18)');
});

test('/health с токеном супер-администратора сообщает, где хранятся учётные записи', async () => {
  const res = await request('GET', '/health', { token: globalThis.__token });
  assert.ok(['postgres', 'sqlite'].includes(res.json.identityStore));
  assert.strictEqual(res.json.version, require('../src/config').SERVER_VERSION);
});
