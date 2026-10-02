const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Push-уведомления для мобильных клиентов (задача 18). Решение владельца:
// через Google и Apple идут ТОЛЬКО идентификаторы — ни текста сообщения, ни
// имени отправителя. Поставщики здесь поддельные: каждый вызов send
// записывается, ответ задаётся тестом.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let chat;
let wsServer;
let push;
let PushTokens;
let UserService;
let AuthService;
let MessageService;
let identity;
const people = {};
const sockets = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Поддельный поставщик: { calls, reply } — reply(call) возвращает результат
// отправки или обещание; по умолчанию — успех.
function fakeProvider() {
  const p = { calls: [], reply: () => ({ status: 'ok' }) };
  p.send = async (args) => {
    p.calls.push(JSON.parse(JSON.stringify(args)));
    return p.reply(args);
  };
  return p;
}
let fcm;
let apns;

function configurePush(options = {}) {
  fcm = fakeProvider();
  apns = fakeProvider();
  push.configure({ providers: { fcm, apns }, baseDelayMs: 20, ...options });
}

const allCalls = () => [...fcm.calls, ...apns.calls];

test.before(async () => {
  const booted = await freshBoot();
  chat = booted.chat;
  identity = booted.identity;
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  MessageService = require('../src/services/message.service');
  push = require('../src/push/push.service');
  PushTokens = require('../src/push/token-store');
  const app = require('../src/app');
  wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  for (const [username, full_name] of [
    ['alice', 'Алиса Тестова'],
    ['bob', 'Боб Тестов'],
    ['carol', 'Карина Тестова'],
    ['dave', 'Давид Тестов']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: await tokenFor(created.id) };
  }
  const admin = await identity.get("SELECT id FROM users WHERE username = 'admin'");
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, token: await tokenFor(admin.id) };

  const team = MessageService.createChannel('Пуш-команда', '', 'public', people.alice.id);
  people.teamId = Number(team.id);
  for (const name of ['bob', 'carol']) {
    chat.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(people.teamId, people[name].id, 'member', new Date().toISOString());
  }
});

test.after(async () => {
  for (const s of Object.values(sockets)) {
    try { s.sock.close(); } catch {}
  }
  push.reset();
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

test.beforeEach(() => {
  configurePush();
  chat.prepare('DELETE FROM push_tokens').run();
  wsServer.dndUsers.clear();
});

test.afterEach(async () => {
  await push.idle();
  delete process.env.PUSH_MAX_TOKENS_PER_USER;
  for (const name of Object.keys(sockets)) await disconnect(name);
});

async function tokenFor(userId) {
  return AuthService.generateToken(await UserService.getUserById(userId));
}

async function api(method, urlPath, { body, token } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function connect(name, token = people[name].token) {
  await disconnect(name);
  const sock = new WebSocket(wsUrl);
  const client = { sock, inbox: [] };
  sock.on('message', (raw, isBinary) => {
    if (!isBinary) {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.on('open', resolve));
  sock.send(JSON.stringify({ type: 'auth', token }));
  await waitFor(client, (m) => m.type === 'auth_success');
  sockets[name] = client;
  return client;
}

async function disconnect(name) {
  const client = sockets[name];
  if (!client) return;
  delete sockets[name];
  await new Promise((resolve) => {
    if (client.sock.readyState === WebSocket.CLOSED) return resolve();
    client.sock.once('close', resolve);
    client.sock.close();
  });
  for (let i = 0; i < 100 && wsServer.isUserOnline(people[name].id); i += 1) await sleep(10);
}

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(10);
  }
  throw new Error('событие не пришло за отведённое время');
}

const ANDROID = (n) => `fcm-${n}-ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij:0123456789`;
const IOS = (n) => n.toString(16).padStart(2, '0').repeat(32);

async function register(name, body, token = people[name].token) {
  return api('POST', '/api/devices/push-token', { token, body });
}
const android = (name, n, extra = {}) => register(name, { platform: 'android', token: ANDROID(n), environment: 'production', app_version: '1.4.0', ...extra });
const ios = (name, n, extra = {}) => register(name, { platform: 'ios', token: IOS(n), environment: 'sandbox', app_version: '1.4.0', ...extra });
const tokensOf = (name) => chat.prepare('SELECT token FROM push_tokens WHERE user_id = ? ORDER BY token').all(people[name].id).map((r) => r.token);

async function restSend(from, conversation, targetId, text, clientMsgId) {
  const path = conversation === 'channel' ? `/api/messages/channels/${targetId}` : `/api/messages/direct/${targetId}`;
  const res = await api('POST', path, { token: people[from].token, body: { text, client_msg_id: clientMsgId } });
  assert.ok(res.status === 201 || res.status === 200, `${res.status} ${res.text}`);
  return res.json;
}

// ══ Регистрация токена ═════════════════════════════════════════════════════

test('Регистрация: только с сеансом; проверка полей; повтор идемпотентен', async () => {
  assert.strictEqual((await api('POST', '/api/devices/push-token', { body: { platform: 'android', token: ANDROID(1) } })).status, 401);
  const bad = [
    [{ platform: 'windows', token: ANDROID(1) }, 'INVALID_PLATFORM'],
    [{ platform: 'android', token: 'короткий' }, 'INVALID_TOKEN'],
    [{ platform: 'android', token: 'x'.repeat(5000) }, 'INVALID_TOKEN'],
    [{ platform: 'ios', token: 'zz'.repeat(32), environment: 'sandbox' }, 'INVALID_TOKEN'],
    [{ platform: 'ios', token: IOS(1) }, 'INVALID_ENVIRONMENT'],
    [{ platform: 'ios', token: IOS(1), environment: 'staging' }, 'INVALID_ENVIRONMENT'],
    [{ platform: 'android', token: ANDROID(1), kind: 'voip' }, 'INVALID_KIND'],
    [{ platform: 'android', token: ANDROID(1), app_version: '<script>' }, 'INVALID_APP_VERSION'],
    [{ platform: 'android', token: ANDROID(1), device_id: 'x'.repeat(200) }, 'INVALID_DEVICE_ID'],
    [[1, 2], 'INVALID_PLATFORM']
  ];
  for (const [body, code] of bad) {
    const res = await register('alice', body);
    assert.strictEqual(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.strictEqual(res.json.code, code, JSON.stringify(body).slice(0, 80));
  }
  const first = await android('alice', 1);
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(first.json, { registered: true, push_enabled: true });
  assert.ok(!first.text.includes(ANDROID(1)), 'токен в ответ не возвращается');
  assert.strictEqual((await android('alice', 1)).status, 200);
  assert.deepStrictEqual(tokensOf('alice'), [ANDROID(1)]);
  assert.strictEqual((await ios('alice', 2, { kind: 'voip' })).status, 200);
  const row = chat.prepare('SELECT * FROM push_tokens WHERE token = ?').get(IOS(2));
  assert.strictEqual(row.kind, 'voip');
  assert.strictEqual(row.environment, 'sandbox');
  assert.strictEqual(row.user_id, people.alice.id);
});

test('Регистрация: не больше N токенов на сотрудника — лишний вытесняет самый старый', async () => {
  process.env.PUSH_MAX_TOKENS_PER_USER = '3';
  for (const n of [1, 2, 3]) {
    await android('bob', n);
    await sleep(5);
  }
  await android('bob', 4);
  assert.deepStrictEqual(tokensOf('bob'), [ANDROID(2), ANDROID(3), ANDROID(4)].sort());
});

test('Регистрация: предел частоты на сотрудника', async () => {
  let limited = null;
  for (let i = 0; i < 40 && !limited; i += 1) {
    const res = await android('admin', 100 + i);
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, '429 не наступил');
  assert.strictEqual(limited.json.code, 'RATE_LIMITED');
});

test('Чужие токены: удалить нельзя (ответ тот же, что для несуществующего); тот же токен у другого — переходит к нему', async () => {
  await android('alice', 5);
  const foreign = await api('DELETE', '/api/devices/push-token', { token: people.bob.token, body: { token: ANDROID(5) } });
  assert.strictEqual(foreign.status, 200);
  assert.deepStrictEqual(foreign.json, { removed: false });
  assert.deepStrictEqual(tokensOf('alice'), [ANDROID(5)]);
  const missing = await api('DELETE', '/api/devices/push-token', { token: people.bob.token, body: { token: ANDROID(99) } });
  assert.deepStrictEqual(missing.json, { removed: false });

  // Тем же телефоном теперь пользуется Боб: уведомления Алисы на него больше не идут.
  await android('bob', 5);
  assert.deepStrictEqual(tokensOf('alice'), []);
  assert.deepStrictEqual(tokensOf('bob'), [ANDROID(5)]);
  await restSend('carol', 'direct', people.alice.id, 'Алисе', 'push-cross-1');
  await push.idle();
  assert.strictEqual(allCalls().length, 0, 'Алисе на телефон Боба ничего не уходит');

  const own = await api('DELETE', '/api/devices/push-token', { token: people.bob.token, body: { token: ANDROID(5) } });
  assert.deepStrictEqual(own.json, { removed: true });
  assert.deepStrictEqual(tokensOf('bob'), []);
});

test('Выход и отвязка: logout снимает токены своего сеанса, unbind — токены устройства, refresh сохраняет привязку', async () => {
  const session1 = await tokenFor(people.carol.id);
  const session2 = await tokenFor(people.carol.id);
  await register('carol', { platform: 'android', token: ANDROID(10), environment: 'production' }, session1);
  await register('carol', { platform: 'android', token: ANDROID(11), environment: 'production' }, session2);
  await register('carol', { platform: 'ios', token: IOS(12), environment: 'production', device_id: 'ios-device-12' }, session2);

  // Продление токена сеанса 1: привязка переносится на новый токен.
  const refreshed = await api('POST', '/api/auth/refresh', { token: session1 });
  assert.strictEqual(refreshed.status, 200);
  const logout1 = await api('POST', '/api/auth/logout', { token: refreshed.json.token, body: {} });
  assert.strictEqual(logout1.status, 200);
  assert.deepStrictEqual(tokensOf('carol'), [ANDROID(11), IOS(12)].sort(), 'снят токен сеанса 1 (после продления)');

  // Отвязка секрета устройства — токены этого устройства.
  const unbind = await api('POST', '/api/auth/device/unbind', { token: session2, body: { device_id: 'ios-device-12' } });
  assert.strictEqual(unbind.status, 200);
  assert.deepStrictEqual(tokensOf('carol'), [ANDROID(11)]);

  // logout с device_id — и токены сеанса, и устройства.
  await register('carol', { platform: 'android', token: ANDROID(13), environment: 'production', device_id: 'android-13' }, session2);
  await api('POST', '/api/auth/logout', { token: session2, body: { device_id: 'android-13' } });
  assert.deepStrictEqual(tokensOf('carol'), []);
});

test('Отвязка устройства администратором снимает его токены', async () => {
  await register('dave', { platform: 'android', token: ANDROID(20), environment: 'production', device_id: 'android-dave' });
  const res = await api('POST', '/api/admin/devices/unbind', { token: people.admin.token, body: { device_id: 'android-dave' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(tokensOf('dave'), []);
});

// ══ Что и кому уходит ══════════════════════════════════════════════════════

test('Получатель не в сети: ровно одно уведомление на сообщение, только id — без текста и имени', async () => {
  await android('bob', 30);
  await ios('bob', 31);
  const message = await restSend('alice', 'direct', people.bob.id, 'Секретный текст договора', 'push-direct-1');
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1);
  assert.strictEqual(apns.calls.length, 1);
  const expected = { type: 'message', conversationType: 'direct', targetId: people.alice.id, messageId: message.id };
  assert.deepStrictEqual(fcm.calls[0].notification.data, expected, 'targetId — собеседник с точки зрения получателя');
  assert.deepStrictEqual(apns.calls[0].notification.data, expected);
  assert.strictEqual(fcm.calls[0].token, ANDROID(30));
  assert.strictEqual(apns.calls[0].token, IOS(31));
  assert.strictEqual(apns.calls[0].environment, 'sandbox');
  const wire = JSON.stringify(allCalls());
  for (const leak of ['Секретный', 'договора', 'Алиса', 'alice']) assert.ok(!wire.includes(leak), `в уведомлении есть «${leak}»`);

  // Повтор отправки с тем же client_msg_id — не новое сообщение.
  await restSend('alice', 'direct', people.bob.id, 'Секретный текст договора', 'push-direct-1');
  await push.idle();
  assert.strictEqual(allCalls().length, 2, 'повтор не даёт второго уведомления');
});

test('Канал: уведомление каждому участнику не в сети, кроме автора и тех, кто в сети', async () => {
  await android('bob', 40);
  await android('carol', 41);
  await android('alice', 42);
  await connect('carol');
  const message = await restSend('alice', 'channel', people.teamId, 'Всем привет', 'push-channel-1');
  await push.idle();
  assert.deepStrictEqual(fcm.calls.map((c) => c.token), [ANDROID(40)]);
  assert.deepStrictEqual(fcm.calls[0].notification.data, { type: 'message', conversationType: 'channel', targetId: people.teamId, messageId: message.id });
});

test('Получатель в сети (любое устройство на сокете) — уведомления нет; отправка по WS — так же, как по REST', async () => {
  await android('bob', 50);
  await connect('bob');
  await restSend('alice', 'direct', people.bob.id, 'Онлайн', 'push-online-1');
  await push.idle();
  assert.strictEqual(allCalls().length, 0);
  await disconnect('bob');
  const a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'По сокету', client_msg_id: 'push-ws-1' }));
  await waitFor(a, (m) => m.type === 'direct_message' && m.message?.client_msg_id === 'push-ws-1');
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1);
});

test('«Не беспокоить»: уведомлений о сообщениях нет (режим переживает отключение сокета)', async () => {
  await android('bob', 60);
  const b = await connect('bob');
  b.sock.send(JSON.stringify({ type: 'set_dnd', enabled: true }));
  for (let i = 0; i < 100 && !wsServer.dndUsers.has(people.bob.id); i += 1) await sleep(10);
  await disconnect('bob');
  await restSend('alice', 'direct', people.bob.id, 'Не беспокоить', 'push-dnd-1');
  await push.idle();
  assert.strictEqual(allCalls().length, 0);
});

test('Сеанс, выдавший токен, больше не действует (смена пароля) — уведомления нет, токен удалён', async () => {
  const session = await tokenFor(people.dave.id);
  await register('dave', { platform: 'android', token: ANDROID(70), environment: 'production' }, session);
  await identity.run('UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1', [people.dave.id]);
  await restSend('alice', 'direct', people.dave.id, 'После смены пароля', 'push-revoked-1');
  await push.idle();
  assert.strictEqual(allCalls().length, 0);
  assert.deepStrictEqual(tokensOf('dave'), []);
  people.dave.token = await tokenFor(people.dave.id);
});

test('Недействительный токен (ответ поставщика) удаляется; временная ошибка — повтор с паузой', async () => {
  await android('bob', 80);
  await android('bob', 81);
  fcm.reply = (args) => (args.token === ANDROID(80) ? { status: 'invalid', reason: 'UNREGISTERED' } : { status: 'ok' });
  await restSend('alice', 'direct', people.bob.id, 'Первое', 'push-invalid-1');
  await push.idle();
  assert.deepStrictEqual(tokensOf('bob'), [ANDROID(81)]);

  fcm.calls.length = 0;
  let attempts = 0;
  fcm.reply = () => (++attempts < 3 ? { status: 'retry', reason: 'HTTP_503' } : { status: 'ok' });
  await restSend('alice', 'direct', people.bob.id, 'Второе', 'push-retry-1');
  await push.idle();
  assert.strictEqual(fcm.calls.length, 3, 'две временные ошибки и успех');
  assert.deepStrictEqual(tokensOf('bob'), [ANDROID(81)], 'временная ошибка токен не удаляет');

  fcm.calls.length = 0;
  fcm.reply = () => ({ status: 'retry', reason: 'HTTP_503' });
  await restSend('alice', 'direct', people.bob.id, 'Третье', 'push-retry-2');
  await push.idle();
  assert.strictEqual(fcm.calls.length, 4, 'не больше maxAttempts попыток');
});

test('Очередь не задерживает отправку: поставщик завис — ответ REST и эхо приходят сразу; параллельность ограничена', async () => {
  configurePush({ concurrency: 2 });
  let release;
  const held = new Promise((r) => { release = r; });
  let inFlight = 0;
  let peak = 0;
  fcm.reply = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await held;
    inFlight -= 1;
    return { status: 'ok' };
  };
  for (const n of [90, 91, 92, 93]) await android('bob', n);
  const started = Date.now();
  await restSend('alice', 'direct', people.bob.id, 'Не жду поставщика', 'push-queue-1');
  await restSend('alice', 'direct', people.bob.id, 'И это тоже', 'push-queue-2');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `REST ждал поставщика: ${elapsed} мс`);
  await sleep(50);
  assert.ok(peak <= 2, `одновременно ${peak} отправок при пределе 2`);
  release();
  await push.idle();
  assert.strictEqual(fcm.calls.length, 8);
});

test('Выключено (нет учётных данных): регистрация работает, отправок нет, сообщения идут как раньше', async () => {
  push.reset();
  const res = await android('bob', 95);
  assert.deepStrictEqual(res.json, { registered: true, push_enabled: false });
  await restSend('alice', 'direct', people.bob.id, 'Без push', 'push-disabled-1');
  await push.idle();
  assert.strictEqual(allCalls().length, 0);
});

// ══ Звонки ═════════════════════════════════════════════════════════════════

test('Звонок сотруднику не в сети с токеном: VoIP/высокоприоритетное уведомление, вызов ждёт; при входе вызов доставляется', async () => {
  await android('bob', 100);
  await ios('bob', 101, { kind: 'voip' });
  await ios('bob', 102); // alert-токен iOS для звонков не годится
  const a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.bob.id }));
  await push.idle();
  await sleep(50);
  assert.ok(!a.inbox.some((m) => m.type === 'call_unavailable'), 'вызывающему не сказали «не в сети»');
  assert.deepStrictEqual(fcm.calls.map((c) => c.notification.data), [{ type: 'call', callerId: people.alice.id }]);
  assert.deepStrictEqual(apns.calls.map((c) => c.token), [IOS(101)]);
  assert.strictEqual(apns.calls[0].notification.kind, 'call');
  assert.ok(!JSON.stringify(allCalls()).includes('Алиса'), 'имени звонящего нет');

  // Телефон проснулся и подключился: ждущий вызов доставляется ему по сокету.
  const b = await connect('bob');
  const offer = await waitFor(b, (m) => m.type === 'call_offer');
  assert.strictEqual(offer.senderId, people.alice.id);
  b.sock.send(JSON.stringify({ type: 'call_answer', targetUserId: people.alice.id }));
  await waitFor(a, (m) => m.type === 'call_answer');
  a.sock.send(JSON.stringify({ type: 'call_end', targetUserId: people.bob.id }));
  await waitFor(b, (m) => m.type === 'call_end');
});

test('Звонок: без подходящего токена, при «Не беспокоить» или при выключенном push — call_unavailable, как раньше', async () => {
  await ios('carol', 110); // только alert
  let a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.carol.id }));
  const offline = await waitFor(a, (m) => m.type === 'call_unavailable');
  assert.strictEqual(offline.reason, 'Сотрудник сейчас не в сети');

  await android('dave', 111);
  wsServer.dndUsers.add(people.dave.id);
  a.inbox.length = 0;
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.dave.id }));
  const dnd = await waitFor(a, (m) => m.type === 'call_unavailable');
  assert.strictEqual(dnd.reason, 'У сотрудника включено «Не беспокоить»');
  wsServer.dndUsers.delete(people.dave.id);

  push.reset();
  await disconnect('alice');
  a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.dave.id }));
  await waitFor(a, (m) => m.type === 'call_unavailable');
  await push.idle();
  assert.strictEqual(allCalls().length, 0);
});

test('Звонок отменён до входа вызываемого — при подключении ничего не доставляется', async () => {
  await android('bob', 120);
  const a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.bob.id }));
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1);
  a.sock.send(JSON.stringify({ type: 'call_end', targetUserId: people.bob.id }));
  await sleep(50);
  const b = await connect('bob');
  await sleep(100);
  assert.ok(!b.inbox.some((m) => m.type === 'call_offer'));
});

test('Журнал запуска: строка о состоянии push без секретов', () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    push.configureFromEnv({});
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((l) => /push-уведомления выключены/i.test(l)), lines.join(' | '));
  assert.strictEqual(push.enabled, false);
});
