const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Самостоятельная регистрация по коду из письма, удаление аккаунта, жалобы и
// блокировки. Контракт: mobile/contracts/registration.md.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let chat;
let identity;
let Registration;
let UserService;
let AuthService;
let MessageService;
let rateLimiter;
let SettingsService;
const outbox = [];
const people = {};
const PASSWORD = 'Надёжный-пароль-77';

const { createMailer } = require('../src/services/mailer.service');
const silent = { log() {}, warn() {}, error() {} };
const testMailer = createMailer({
  config: { SMTP_HOST: 'smtp.test', SMTP_FROM: 'noreply@test.kz' },
  transport: { sendMail: async (m) => { outbox.push(m); return { messageId: `<${outbox.length}@test>` }; } },
  logger: silent
});

test.before(async () => {
  ({ identity, chat } = await freshBoot());
  Registration = require('../src/services/registration.service');
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  MessageService = require('../src/services/message.service');
  rateLimiter = require('../src/services/rate-limiter');
  SettingsService = require('../src/services/settings.service');
  // Самостоятельная регистрация — только при включённом allow_registration
  // (решение Q). Тесты ниже проверяют включённый режим; выключенный — отдельно.
  await SettingsService.setSetting('allow_registration', 'true');
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  for (const [username, full_name] of [['alice', 'Алиса Иванова'], ['bob', 'Борис Петров'], ['carol', 'Карина Сидорова']]) {
    const created = await UserService.createUser({ username, full_name, password: PASSWORD });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: AuthService.generateToken(await UserService.getUserById(created.id)) };
  }
  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, token: AuthService.generateToken(await UserService.getUserById(admin.id)) };
});

test.after(async () => {
  const wsServer = require('../src/ws/server');
  wsServer.wss?.clients.forEach((client) => client.terminate());
  Registration.setMailer(null);
  server?.close();
  await closeAll();
});

test.beforeEach(() => {
  // Пределы по адресу не должны мешать соседним тестам (кроме теста пределов).
  rateLimiter.resetLimit(`reg-req-ip:${require('../src/services/ip-access.service').rateLimitIpKey('127.0.0.1')}`);
  rateLimiter.resetLimit(`reg-verify-ip:${require('../src/services/ip-access.service').rateLimitIpKey('127.0.0.1')}`);
  rateLimiter.resetLimit('reg-req-global');
  rateLimiter.resetLimit('reg-verify-fail-global');
  Registration.configureLimits?.(null);
  Registration.setMailer(testMailer);
});

async function api(method, urlPath, { body, token } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}

const lastCode = () => /(\d{6})/.exec(outbox[outbox.length - 1].text)[1];
const wrongCode = (code) => (code === '000000' ? '111111' : '000000');

async function requestCode({ email, username, displayName = 'Новый Сотрудник', password = PASSWORD }) {
  return api('POST', '/api/auth/register/request', { body: { email, username, displayName, password } });
}

function wsAuth(token) {
  return new Promise((resolve) => {
    const sock = new WebSocket(wsUrl);
    const timer = setTimeout(() => { sock.terminate(); resolve({ type: 'timeout' }); }, 3000);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'auth', token })));
    sock.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.type === 'auth_success' || msg.type === 'auth_error') {
        clearTimeout(timer);
        sock.close();
        resolve(msg);
      }
    });
    sock.on('error', () => {});
  });
}

// ── Регистрация ──

test('почта не настроена — 503 и честный текст, заявка не создаётся', async () => {
  Registration.setMailer(null); // стандартный почтовик: SMTP в окружении теста пуст
  const before = Number((await identity.get('SELECT COUNT(*) AS n FROM registration_requests')).n);
  const res = await requestCode({ email: 'nomail@test.kz', username: 'nomail' });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.json.error, 'Отправка почты не настроена');
  // Клиенты ветвятся по code (registration.md §1.1), а не по «503 без кода».
  assert.strictEqual(res.json.code, 'EMAIL_NOT_CONFIGURED');
  assert.strictEqual(Number((await identity.get('SELECT COUNT(*) AS n FROM registration_requests')).n), before);
});

test('адрес из списка разрешённых: код -> 200 как при входе, токен рабочий', async () => {
  await Registration.addAllowlist('@test.kz');
  const res = await requestCode({ email: 'Ivan@Test.KZ', username: 'ivan.s' });
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.json.status, 'code_sent');
  assert.strictEqual(res.json.expiresInSec, 600);
  assert.ok(res.json.registrationId);
  assert.deepStrictEqual(Object.keys(res.json).sort(), ['expiresInSec', 'registrationId', 'status']);
  assert.strictEqual(outbox[outbox.length - 1].to, 'ivan@test.kz');
  // В базе нет самого кода и пароля открытым текстом.
  const row = await identity.get('SELECT * FROM registration_requests WHERE id = $1', [res.json.registrationId]);
  assert.ok(!JSON.stringify(row).includes(lastCode()) || row.code_hash.length === 64);
  assert.notStrictEqual(row.password_hash, PASSWORD);

  const verified = await api('POST', '/api/auth/register/verify', { body: { registrationId: res.json.registrationId, code: lastCode() } });
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.json.user.username, 'ivan.s');
  assert.ok(verified.json.token);
  assert.strictEqual(verified.json.user.password_hash, undefined);
  const me = await api('GET', '/api/auth/me', { token: verified.json.token });
  assert.strictEqual(me.status, 200);
  const login = await api('POST', '/api/auth/login', { body: { username: 'ivan.s', password: PASSWORD } });
  assert.strictEqual(login.status, 200);
  assert.deepStrictEqual(Object.keys(login.json).sort(), Object.keys(verified.json).sort());
});

test('адрес вне списка: 202 pending, вход 403 ACCOUNT_PENDING, токена и сокета нет', async () => {
  const res = await requestCode({ email: 'stranger@other.org', username: 'stranger' });
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.json.status, 'code_sent'); // ответ не выдаёт, что адреса нет в списке
  const verified = await api('POST', '/api/auth/register/verify', { body: { registrationId: res.json.registrationId, code: lastCode() } });
  assert.strictEqual(verified.status, 202);
  assert.deepStrictEqual(verified.json, { status: 'pending' });

  const login = await api('POST', '/api/auth/login', { body: { username: 'stranger', password: PASSWORD } });
  assert.strictEqual(login.status, 403);
  assert.deepStrictEqual(login.json, { error: 'Заявка на рассмотрении', code: 'ACCOUNT_PENDING' });
  // Неверный пароль не выдаёт статус заявки.
  const bad = await api('POST', '/api/auth/login', { body: { username: 'stranger', password: 'неверный-пароль-1' } });
  assert.notStrictEqual(bad.status, 403);

  // Даже подписанный токен pending-пользователя не работает ни в REST, ни в WebSocket.
  const row = await UserService.getUserByUsername('stranger');
  const token = AuthService.generateToken(row);
  assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 401);
  assert.strictEqual((await api('GET', '/api/users', { token })).status, 401);
  const ws = await wsAuth(token);
  assert.strictEqual(ws.type, 'auth_error');
});

test('администратор: список заявок, одобрение и отклонение', async () => {
  const list = await api('GET', '/api/admin/registrations?status=pending', { token: people.admin.token });
  assert.strictEqual(list.status, 200);
  const stranger = list.json.find((r) => r.username === 'stranger');
  assert.ok(stranger);
  assert.strictEqual(stranger.email, 'stranger@other.org');
  assert.strictEqual((await api('GET', '/api/admin/registrations?status=bogus', { token: people.admin.token })).status, 400);
  assert.strictEqual((await api('GET', '/api/admin/registrations', { token: people.alice.token })).status, 403);

  const rejected = await api('POST', `/api/admin/registrations/${stranger.id}/reject`, { token: people.admin.token, body: { reason: 'не сотрудник' } });
  assert.strictEqual(rejected.status, 200);
  const login = await api('POST', '/api/auth/login', { body: { username: 'stranger', password: PASSWORD } });
  assert.strictEqual(login.status, 403);
  assert.deepStrictEqual(login.json, { error: 'Заявка отклонена', code: 'ACCOUNT_REJECTED' });
  const rejectedList = await api('GET', '/api/admin/registrations?status=rejected', { token: people.admin.token });
  assert.ok(rejectedList.json.some((r) => r.username === 'stranger'));

  const approved = await api('POST', `/api/admin/registrations/${stranger.id}/approve`, { token: people.admin.token });
  assert.strictEqual(approved.status, 200);
  const ok = await api('POST', '/api/auth/login', { body: { username: 'stranger', password: PASSWORD } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.json.token);
});

test('код: 5 попыток, затем 410; верный код после исчерпания не помогает', async () => {
  const res = await requestCode({ email: 'tries@test.kz', username: 'tries' });
  const code = lastCode();
  for (let i = 1; i <= 4; i++) {
    const bad = await api('POST', '/api/auth/register/verify', { body: { registrationId: res.json.registrationId, code: wrongCode(code) } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.code, 'CODE_INVALID');
    assert.strictEqual(bad.json.attemptsLeft, 5 - i);
  }
  const fifth = await api('POST', '/api/auth/register/verify', { body: { registrationId: res.json.registrationId, code: wrongCode(code) } });
  assert.strictEqual(fifth.status, 410);
  const good = await api('POST', '/api/auth/register/verify', { body: { registrationId: res.json.registrationId, code } });
  assert.strictEqual(good.status, 410);
  assert.strictEqual(good.json.code, 'CODE_EXPIRED');
  assert.strictEqual(await UserService.getUserByUsername('tries'), null);
});

test('код одноразовый и истекает через 10 минут', async () => {
  const res = await requestCode({ email: 'once@test.kz', username: 'once.user' });
  const code = lastCode();
  assert.strictEqual((await api('POST', '/api/auth/register/verify', { body: { registrationId: res.json.registrationId, code } })).status, 200);
  const again = await api('POST', '/api/auth/register/verify', { body: { registrationId: res.json.registrationId, code } });
  assert.strictEqual(again.status, 410);

  const res2 = await requestCode({ email: 'late@test.kz', username: 'late.user' });
  await identity.run('UPDATE registration_requests SET expires_at = $1 WHERE id = $2', [new Date(Date.now() - 1000).toISOString(), res2.json.registrationId]);
  const late = await api('POST', '/api/auth/register/verify', { body: { registrationId: res2.json.registrationId, code: lastCode() } });
  assert.strictEqual(late.status, 410);
  assert.strictEqual((await api('POST', '/api/auth/register/verify', { body: { registrationId: 'нет-такого-id-совсем', code: '123456' } })).status, 400);
  assert.strictEqual((await api('POST', '/api/auth/register/verify', { body: { registrationId: 'AAAAAAAAAAAAAAAAAAAA', code: '123456' } })).status, 410);
});

test('повторная заявка на тот же адрес отменяет прежний код', async () => {
  const first = await requestCode({ email: 'twice@test.kz', username: 'twice.user' });
  const firstCode = lastCode();
  const second = await requestCode({ email: 'twice@test.kz', username: 'twice.user' });
  const stale = await api('POST', '/api/auth/register/verify', { body: { registrationId: first.json.registrationId, code: firstCode } });
  assert.strictEqual(stale.status, 410);
  assert.strictEqual((await api('POST', '/api/auth/register/verify', { body: { registrationId: second.json.registrationId, code: lastCode() } })).status, 200);
});

test('занятые логин и email — 409; невалидные поля — 400', async () => {
  const dupName = await requestCode({ email: 'fresh@test.kz', username: 'ALICE' });
  assert.strictEqual(dupName.status, 409);
  assert.strictEqual(dupName.json.code, 'USERNAME_TAKEN');
  const dupMail = await requestCode({ email: 'ivan@test.kz', username: 'ivan.other' });
  assert.strictEqual(dupMail.status, 409);
  assert.strictEqual(dupMail.json.code, 'EMAIL_TAKEN');
  for (const bad of [
    { email: 'не-почта', username: 'validname' },
    { email: 'ok@test.kz', username: 'a' },
    { email: 'ok@test.kz', username: 'valid name' },
    { email: 'ok@test.kz', username: 'validname', password: '123' },
    { email: 'ok@test.kz', username: 'validname', displayName: ' ' },
    { email: 'ok@test.kz', username: 'validname', displayName: 'я'.repeat(101) }
  ]) {
    assert.strictEqual((await requestCode(bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await api('POST', '/api/auth/register/request', { body: { email: ['a@b.kz'] } })).status, 400);
});

test('пределы: на адрес почты — 3 заявки в час, на IP — 10', async () => {
  for (let i = 0; i < 3; i++) assert.strictEqual((await requestCode({ email: 'flood@test.kz', username: 'flood.user' })).status, 202);
  const blocked = await requestCode({ email: 'flood@test.kz', username: 'flood.user' });
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));

  rateLimiter.resetLimit(`reg-req-ip:${require('../src/services/ip-access.service').rateLimitIpKey('127.0.0.1')}`);
  let last;
  for (let i = 0; i < 11; i++) last = await requestCode({ email: `ip${i}@test.kz`, username: `ip.user${i}` });
  assert.strictEqual(last.status, 429);
});

test('список разрешённых: API администратора, точный адрес и @домен', async () => {
  assert.strictEqual((await api('POST', '/api/admin/registration-allowlist', { token: people.alice.token, body: { pattern: 'x@y.kz' } })).status, 403);
  const added = await api('POST', '/api/admin/registration-allowlist', { token: people.admin.token, body: { pattern: 'Exact@Company.KZ' } });
  assert.strictEqual(added.status, 201);
  assert.strictEqual(added.json.pattern, 'exact@company.kz');
  assert.strictEqual((await api('POST', '/api/admin/registration-allowlist', { token: people.admin.token, body: { pattern: 'exact@company.kz' } })).status, 409);
  assert.strictEqual((await api('POST', '/api/admin/registration-allowlist', { token: people.admin.token, body: { pattern: 'нет' } })).status, 400);
  assert.strictEqual(await Registration.isAllowed('EXACT@company.kz'), true);
  assert.strictEqual(await Registration.isAllowed('other@company.kz'), false);
  assert.strictEqual(await Registration.isAllowed('a@sub.test.kz'), false); // поддомен — не тот же домен
  assert.strictEqual(await Registration.isAllowed('a@test.kz'), true);
  const list = await api('GET', '/api/admin/registration-allowlist', { token: people.admin.token });
  assert.ok(list.json.some((e) => e.pattern === '@test.kz'));
  const del = await api('DELETE', `/api/admin/registration-allowlist/${added.json.id}`, { token: people.admin.token });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(await Registration.isAllowed('exact@company.kz'), false);
  assert.strictEqual((await api('DELETE', `/api/admin/registration-allowlist/${added.json.id}`, { token: people.admin.token })).status, 404);
});

test('REGISTRATION_ALLOWED_EMAILS пополняет список, ничего не удаляя', async () => {
  const added = await Registration.seedAllowlistFromEnv('seed1@env.kz, @envdomain.kz ,  ,мусор');
  assert.strictEqual(added, 2);
  assert.strictEqual(await Registration.isAllowed('seed1@env.kz'), true);
  assert.strictEqual(await Registration.isAllowed('anyone@envdomain.kz'), true);
  assert.strictEqual(await Registration.seedAllowlistFromEnv('seed1@env.kz'), 0);
});

// ── Решение Q: allow_registration — главный выключатель ──

const DISABLED = { error: 'Регистрация сейчас закрыта. Обратитесь к администратору.', code: 'REGISTRATION_DISABLED' };
const verifyCode = (registrationId, code) => api('POST', '/api/auth/register/verify', { body: { registrationId, code } });
const requestsFor = async (email) => Number((await identity.get('SELECT COUNT(*) AS n FROM registration_requests WHERE email = $1', [email])).n);

test('allow_registration выключена: request и verify — 403 REGISTRATION_DISABLED, письма и учётной записи нет', async () => {
  const live = await requestCode({ email: 'switch@test.kz', username: 'switch.user' });
  assert.strictEqual(live.status, 202);
  const code = lastCode();
  const sent = outbox.length;
  await SettingsService.setSetting('allow_registration', 'false');
  try {
    const req = await requestCode({ email: 'closed@test.kz', username: 'closed.user' });
    assert.strictEqual(req.status, 403);
    assert.deepStrictEqual(req.json, DISABLED);
    assert.strictEqual(outbox.length, sent, 'письмо не отправляется');
    assert.strictEqual(await requestsFor('closed@test.kz'), 0);
    // Выключатель важнее всего прочего: почты нет, тело пустое — всё равно 403.
    assert.deepStrictEqual((await api('POST', '/api/auth/register/request', { body: {} })).json, DISABLED);
    Registration.setMailer(null);
    assert.strictEqual((await requestCode({ email: 'closed2@test.kz', username: 'closed.two' })).status, 403);
    Registration.setMailer(testMailer);

    // Код, выданный до выключения, учётную запись не создаёт.
    const verified = await verifyCode(live.json.registrationId, code);
    assert.strictEqual(verified.status, 403);
    assert.deepStrictEqual(verified.json, DISABLED);
    assert.strictEqual(await UserService.getUserByUsername('switch.user'), null);
  } finally {
    await SettingsService.setSetting('allow_registration', 'true');
  }
  // Отказ по выключателю не тратит попытку и не гасит код.
  const again = await verifyCode(live.json.registrationId, code);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.user.username, 'switch.user');
});

test('allow_registration включена: прежнее поведение (разрешённый — сразу, остальные — на рассмотрение)', async () => {
  assert.strictEqual(await SettingsService.getSetting('allow_registration'), 'true');
  const res = await requestCode({ email: 'open@elsewhere.org', username: 'open.user' });
  assert.strictEqual(res.status, 202);
  assert.strictEqual((await verifyCode(res.json.registrationId, lastCode())).status, 202);
});

// ── Решение R: общие (на весь сервер) пределы ──

test('общий предел заявок на коды: с любых адресов и почт не больше заданного в час', async () => {
  Registration.configureLimits({ globalRequestsPerHour: 3 });
  const ipKey = `reg-req-ip:${require('../src/services/ip-access.service').rateLimitIpKey('127.0.0.1')}`;
  for (let i = 0; i < 3; i++) {
    rateLimiter.resetLimit(ipKey); // как будто каждая заявка — с нового адреса
    assert.strictEqual((await requestCode({ email: `glob${i}@spray.org`, username: `glob.user${i}` })).status, 202);
  }
  rateLimiter.resetLimit(ipKey);
  const sent = outbox.length;
  const over = await requestCode({ email: 'glob3@spray.org', username: 'glob.user3' });
  assert.strictEqual(over.status, 429);
  assert.strictEqual(over.json.code, 'RATE_LIMITED');
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  assert.strictEqual(outbox.length, sent, 'письмо не отправляется');
  assert.strictEqual(await requestsFor('glob3@spray.org'), 0);
});

test('общий бюджет неудачных проверок кода: после него — 429 для всех и оповещение безопасности', async () => {
  const a = await requestCode({ email: 'gfail.a@spray.org', username: 'gfail.a' });
  const codeA = lastCode();
  const b = await requestCode({ email: 'gfail.b@spray.org', username: 'gfail.b' });
  const codeB = lastCode();
  Registration.configureLimits({ globalFailedVerifiesPerHour: 3 });
  assert.strictEqual((await verifyCode(a.json.registrationId, wrongCode(codeA))).status, 400);
  assert.strictEqual((await verifyCode(a.json.registrationId, wrongCode(codeA))).status, 400);
  assert.strictEqual((await verifyCode(b.json.registrationId, wrongCode(codeB))).status, 400);
  // Бюджет исчерпан: даже верный код ждёт, попытка не тратится.
  const blocked = await verifyCode(b.json.registrationId, codeB);
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.json.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  await new Promise((r) => setTimeout(r, 200));
  const alert = await identity.get(`SELECT rule, severity FROM security_alerts WHERE rule = 'registration_code_bruteforce'`);
  assert.ok(alert, 'оповещение безопасности записано');

  rateLimiter.resetLimit('reg-verify-fail-global');
  Registration.configureLimits(null);
  const ok = await verifyCode(b.json.registrationId, codeB);
  assert.strictEqual(ok.status, 202);
  const row = await identity.get('SELECT attempts FROM registration_requests WHERE id = $1', [b.json.registrationId]);
  assert.strictEqual(Number(row.attempts), 2, 'отказ по общему бюджету попытку не тратит');
});

test('verify: отказ по пределу ожидающих заявок не гасит верный код', async () => {
  const res = await requestCode({ email: 'cap@spray.org', username: 'cap.user' });
  const code = lastCode();
  const pending = Number((await identity.get(`SELECT COUNT(*) AS n FROM users WHERE approval_status = 'pending'`)).n);
  Registration.configureLimits({ maxPendingAccounts: pending });
  const capped = await verifyCode(res.json.registrationId, code);
  assert.strictEqual(capped.status, 429);
  assert.strictEqual(capped.json.code, 'RATE_LIMITED');
  Registration.configureLimits(null);
  const ok = await verifyCode(res.json.registrationId, code);
  assert.strictEqual(ok.status, 202);
});

test('verify: ошибка базы при создании учётной записи — 500, а не «логин занят»; код не сгорает', async () => {
  const res = await requestCode({ email: 'dberr@spray.org', username: 'dberr.user' });
  const code = lastCode();
  const db = require('../src/db/identity').identity();
  const original = db.run;
  const failWith = (err) => {
    db.run = async function (sql, params) {
      if (/INSERT INTO users/.test(sql)) throw err;
      return original.call(this, sql, params);
    };
  };
  try {
    failWith(Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 }));
    const broken = await verifyCode(res.json.registrationId, code);
    assert.strictEqual(broken.status, 500);
    assert.notStrictEqual(broken.json.code, 'USERNAME_TAKEN');

    failWith(Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505', constraint: 'users_email_key' }));
    const raced = await verifyCode(res.json.registrationId, code);
    assert.strictEqual(raced.status, 409);
    assert.strictEqual(raced.json.code, 'EMAIL_TAKEN');

    failWith(Object.assign(new Error('UNIQUE constraint failed: users.username'), { code: 'ERR_SQLITE_ERROR', errcode: 2067 }));
    const racedName = await verifyCode(res.json.registrationId, code);
    assert.strictEqual(racedName.status, 409);
    assert.strictEqual(racedName.json.code, 'USERNAME_TAKEN');
  } finally {
    db.run = original;
  }
  assert.strictEqual((await verifyCode(res.json.registrationId, code)).status, 202);
});

test('просроченные заявки чистятся по ходу работы, а не только при запуске', async () => {
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  await identity.run(
    `INSERT INTO registration_requests (id, email, username, display_name, password_hash, code_hash, attempts, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)`,
    ['stale-request-id-0001', 'stale@spray.org', 'stale.user', 'Старый', 'x', 'y', old]
  );
  Registration.resetPurgeClock();
  assert.strictEqual((await requestCode({ email: 'trigger@spray.org', username: 'trigger.user' })).status, 202);
  assert.strictEqual(await requestsFor('stale@spray.org'), 0);
});

// ── Блокировки и жалобы ──

async function sendDirect(from, to, text) {
  return api('POST', `/api/messages/direct/${people[to].id}`, { token: people[from].token, body: { text } });
}

test('блокировка: сообщения скрыты у блокирующего, отправка закрыта в обе стороны', async () => {
  const sent = await sendDirect('bob', 'alice', 'привет до блокировки');
  assert.strictEqual(sent.status, 201);
  const mine = await sendDirect('alice', 'bob', 'мой ответ');
  assert.strictEqual(mine.status, 201);

  assert.strictEqual((await api('POST', '/api/blocks', { token: people.alice.token, body: { userId: people.alice.id } })).status, 400);
  assert.strictEqual((await api('POST', '/api/blocks', { token: people.alice.token, body: { userId: 999999 } })).status, 404);
  const blocked = await api('POST', '/api/blocks', { token: people.alice.token, body: { userId: people.bob.id } });
  assert.strictEqual(blocked.status, 201);
  assert.deepStrictEqual(blocked.json, { userId: people.bob.id });
  assert.strictEqual((await api('POST', '/api/blocks', { token: people.alice.token, body: { userId: people.bob.id } })).status, 201);

  const listed = await api('GET', '/api/blocks', { token: people.alice.token });
  assert.strictEqual(listed.json.blocks.length, 1);
  assert.strictEqual(listed.json.blocks[0].userId, people.bob.id);
  assert.strictEqual(listed.json.blocks[0].displayName, 'Борис Петров');
  assert.strictEqual((await api('GET', '/api/blocks', { token: people.bob.token })).json.blocks.length, 0);

  // Не виден ни в истории, ни в списке переписок, ни в синхронизации.
  const history = await api('GET', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token });
  assert.deepStrictEqual(history.json, []);
  const convs = await api('GET', '/api/conversations/direct', { token: people.alice.token });
  assert.ok(!convs.json.some((c) => c.user_id === people.bob.id));
  const sync = await MessageService.syncSince(people.alice.id, MessageService.syncHeadCursor().replace(/\.\d+$/, '.0'));
  assert.ok(!sync.messages.some((m) => m.text === 'привет до блокировки'));
  const found = await MessageService.searchMessages('блокировки', people.alice.id);
  assert.strictEqual(found.length, 0);
  // Для заблокированного история на месте.
  const bobHistory = await api('GET', `/api/messages/direct/${people.alice.id}`, { token: people.bob.token });
  assert.ok(bobHistory.json.length >= 2);

  // Отправка: заблокированный -> блокирующему и обратно — 403 DM_NOT_ALLOWED без слова «блок».
  const denied = await sendDirect('bob', 'alice', 'можно?');
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.json.code, 'DM_NOT_ALLOWED');
  assert.ok(!/блок/i.test(denied.json.error));
  assert.strictEqual((await sendDirect('alice', 'bob', 'и я не могу')).status, 403);
  // Другие переписки не затронуты.
  assert.strictEqual((await sendDirect('bob', 'carol', 'привет, Карина')).status, 201);

  // Разблокировка возвращает всё.
  assert.strictEqual((await api('DELETE', `/api/blocks/${people.bob.id}`, { token: people.alice.token })).status, 200);
  assert.strictEqual((await api('DELETE', `/api/blocks/${people.bob.id}`, { token: people.alice.token })).status, 200);
  const restored = await api('GET', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token });
  assert.ok(restored.json.some((m) => m.text === 'привет до блокировки'));
  assert.strictEqual((await sendDirect('bob', 'alice', 'снова на связи')).status, 201);
});

test('блокировка по WebSocket: отправка отклоняется, получатель ничего не получает', async () => {
  await api('POST', '/api/blocks', { token: people.carol.token, body: { userId: people.bob.id } });
  const inbox = [];
  const carolSock = new WebSocket(wsUrl);
  carolSock.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString('utf8'))); } catch {} });
  await new Promise((resolve) => carolSock.on('open', resolve));
  carolSock.send(JSON.stringify({ type: 'auth', token: people.carol.token }));
  const bobInbox = [];
  const bobSock = new WebSocket(wsUrl);
  bobSock.on('message', (raw) => { try { bobInbox.push(JSON.parse(raw.toString('utf8'))); } catch {} });
  await new Promise((resolve) => bobSock.on('open', resolve));
  bobSock.send(JSON.stringify({ type: 'auth', token: people.bob.token }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  bobSock.send(JSON.stringify({ type: 'send_message', conversationType: 'direct', targetId: people.carol.id, text: 'через сокет', client_msg_id: 'ws-blocked-1' }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const err = bobInbox.find((m) => m.type === 'error' || m.code === 'DM_NOT_ALLOWED');
  assert.ok(err, JSON.stringify(bobInbox.map((m) => m.type)));
  assert.strictEqual(err.code, 'DM_NOT_ALLOWED');
  assert.ok(!inbox.some((m) => m.type === 'new_message' || m.type === 'direct_message'));
  carolSock.close();
  bobSock.close();
  await api('DELETE', `/api/blocks/${people.bob.id}`, { token: people.carol.token });
});

test('жалобы: сообщение и пользователь, дубликат, чужая цель, список для администратора', async () => {
  const msg = await sendDirect('bob', 'alice', 'грубое сообщение');
  const hidden = await sendDirect('bob', 'carol', 'личное для Карины');
  const report = await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'message', targetId: msg.json.id, reason: 'Оскорбление', details: 'подробности' } });
  assert.strictEqual(report.status, 201);
  assert.strictEqual(report.json.status, 'open');
  const dup = await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'message', targetId: msg.json.id, reason: 'Оскорбление' } });
  assert.strictEqual(dup.status, 201);
  assert.strictEqual(dup.json.id, report.json.id);
  // Чужое личное сообщение недоступно жалобщику.
  assert.strictEqual((await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'message', targetId: hidden.json.id, reason: 'x' } })).status, 404);
  assert.strictEqual((await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'user', targetId: people.bob.id, reason: 'Спам' } })).status, 201);
  assert.strictEqual((await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'user', targetId: 999999, reason: 'Спам' } })).status, 404);
  assert.strictEqual((await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'file', targetId: 1, reason: 'Спам' } })).status, 400);
  assert.strictEqual((await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'user', targetId: people.bob.id } })).status, 400);
  assert.strictEqual((await api('POST', '/api/reports', { body: { targetType: 'user', targetId: 1, reason: 'a' } })).status, 401);

  const list = await api('GET', '/api/admin/reports?status=open', { token: people.admin.token });
  assert.strictEqual(list.status, 200);
  const row = list.json.find((r) => r.id === report.json.id);
  assert.strictEqual(row.reportedUser.id, people.bob.id);
  assert.strictEqual(row.messageText, 'грубое сообщение');
  assert.strictEqual((await api('GET', '/api/admin/reports', { token: people.alice.token })).status, 403);
  assert.strictEqual((await api('POST', `/api/admin/reports/${report.json.id}/close`, { token: people.admin.token })).status, 200);
  assert.ok(!(await api('GET', '/api/admin/reports?status=open', { token: people.admin.token })).json.some((r) => r.id === report.json.id));
});

// ── Удаление аккаунта ──

test('удаление аккаунта: пароль обязателен, токены и сокеты отзываются, данные стёрты, сообщения остались', async () => {
  const doomed = await UserService.createUser({ username: 'doomed', full_name: 'Обречённый Пользователь', email: 'doomed@test.kz', phone: '+7 700 000 00 00', password: PASSWORD });
  await UserService.setMustChangePassword(doomed.id, false);
  const token = AuthService.generateToken(await UserService.getUserById(doomed.id));
  people.doomed = { id: doomed.id, token };
  const sent = await sendDirect('doomed', 'alice', 'сообщение удаляемого');
  assert.strictEqual(sent.status, 201);
  await api('POST', '/api/blocks', { token, body: { userId: people.carol.id } });
  chat.prepare(`INSERT INTO push_tokens (token, user_id, platform, kind, environment, created_at, updated_at) VALUES ('tok-doomed', ?, 'ios', 'alert', 'sandbox', 'x', 'x')`).run(doomed.id);

  const noPass = await api('DELETE', '/api/users/me', { token, body: {} });
  assert.strictEqual(noPass.status, 400);
  const wrong = await api('DELETE', '/api/users/me', { token, body: { password: 'не-тот-пароль-1' } });
  assert.strictEqual(wrong.status, 403);
  assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 200);
  assert.strictEqual((await api('DELETE', '/api/users/me', { body: { password: PASSWORD } })).status, 401);

  const sock = new WebSocket(wsUrl);
  const inbox = [];
  sock.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString('utf8'))); } catch {} });
  const closed = new Promise((resolve) => sock.on('close', resolve));
  await new Promise((resolve) => sock.on('open', resolve));
  sock.send(JSON.stringify({ type: 'auth', token }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(inbox.some((m) => m.type === 'auth_success'));

  const res = await api('DELETE', '/api/users/me', { token, body: { password: PASSWORD } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { success: true });
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  assert.strictEqual(sock.readyState, WebSocket.CLOSED);

  assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 401);
  assert.strictEqual((await api('POST', '/api/auth/login', { body: { username: 'doomed', password: PASSWORD } })).status, 400);
  assert.strictEqual((await wsAuth(token)).type, 'auth_error');

  const row = await identity.get('SELECT * FROM users WHERE id = $1', [doomed.id]);
  assert.strictEqual(row.email, null);
  assert.strictEqual(row.phone, null);
  assert.strictEqual(row.avatar_url, null);
  assert.strictEqual(row.is_active, 0);
  assert.strictEqual(row.full_name, 'Удалённый сотрудник');
  assert.ok(!/doomed/.test(row.username));
  assert.strictEqual(chat.prepare('SELECT COUNT(*) AS n FROM push_tokens WHERE user_id = ?').get(doomed.id).n, 0);
  assert.strictEqual(chat.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = ?').get(doomed.id).n, 0);
  assert.strictEqual(chat.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?').get(doomed.id).n, 0);

  // Сообщение осталось, автор — «Удалённый сотрудник».
  const history = await api('GET', `/api/messages/direct/${doomed.id}`, { token: people.alice.token });
  const kept = history.json.find((m) => m.text === 'сообщение удаляемого');
  assert.ok(kept);
  assert.strictEqual(kept.sender_name, 'Удалённый сотрудник');
  // Логин освободился: на него можно зарегистрироваться заново.
  await Registration.addAllowlist('@again.kz');
  const again = await requestCode({ email: 'doomed@test.kz', username: 'doomed' });
  assert.strictEqual(again.status, 202);
});

test('единственного администратора удалить нельзя', async () => {
  const res = await api('DELETE', '/api/users/me', { token: people.admin.token, body: { password: 'парольдлятеста' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.code, 'LAST_ADMIN');
});

// Находки QA (end-to-end прогон): отклонение не должно отключать действующую
// учётную запись, идентификатор не должен приниматься в виде массива, а
// «печатает…» не должно проходить через блокировку.
test('reject применим только к заявке: действующего администратора отклонить нельзя', async () => {
  const res = await api('POST', `/api/admin/registrations/${people.admin.id}/reject`, { token: people.admin.token, body: {} });
  assert.strictEqual(res.status, 400);
  const me = await api('GET', '/api/auth/me', { token: people.admin.token });
  assert.strictEqual(me.status, 200);
  const row = await identity.get('SELECT approval_status FROM users WHERE id = $1', [people.admin.id]);
  assert.strictEqual(row.approval_status, 'approved');
});

test('блокировка и жалоба: идентификатор — только число или строка цифр', async () => {
  for (const bad of [[people.bob.id], true, { id: 1 }, '1 OR 1=1']) {
    const res = await api('POST', '/api/blocks', { token: people.alice.token, body: { userId: bad } });
    assert.strictEqual(res.status, 400, `userId=${JSON.stringify(bad)}`);
  }
  const rep = await api('POST', '/api/reports', { token: people.alice.token, body: { targetType: 'user', targetId: [people.bob.id], reason: 'x' } });
  assert.strictEqual(rep.status, 400);
  assert.strictEqual((await api('GET', '/api/blocks', { token: people.alice.token })).json.blocks.length, 0);
});

test('«печатает…» не доходит через блокировку в обе стороны', async () => {
  const open = (token) => new Promise((resolve) => {
    const sock = new WebSocket(wsUrl);
    sock.frames = [];
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      sock.frames.push(m);
      if (m.type === 'auth_success') resolve(sock);
    });
    sock.on('open', () => sock.send(JSON.stringify({ type: 'auth', token })));
    sock.on('error', () => {});
  });
  const a = await open(people.alice.token);
  const b = await open(people.bob.token);
  const typing = (from, to) => from.send(JSON.stringify({ type: 'typing', conversationType: 'direct', targetId: to, isTyping: true }));
  try {
    typing(b, people.alice.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(a.frames.some((f) => f.type === 'user_typing'), 'без блокировки «печатает…» доходит');
    a.frames.length = 0;
    await api('POST', '/api/blocks', { token: people.alice.token, body: { userId: people.bob.id } });
    typing(b, people.alice.id);
    typing(a, people.bob.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!a.frames.some((f) => f.type === 'user_typing'), 'заблокированный не должен «печатать» блокировщику');
    assert.ok(!b.frames.some((f) => f.type === 'user_typing'), 'блокировщик не должен «печатать» заблокированному');
  } finally {
    await api('DELETE', `/api/blocks/${people.bob.id}`, { token: people.alice.token });
    a.terminate(); b.terminate();
  }
});
