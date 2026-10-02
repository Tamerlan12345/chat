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
  wsServer.pendingOffers.clear();
  wsServer.endedPushOffers?.clear();
  // Предел частоты регистрации (30/мин на сотрудника) — свой в каждом тесте:
  // иначе регистрации предыдущих тестов молча оставляли бы без токена.
  const limiter = require('../src/services/rate-limiter');
  for (const p of Object.values(people)) if (p && p.id) limiter.resetLimit(`push-token:${p.id}`);
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
  const end = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(end.reason, 'cancelled');
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

// ══ Исправления ревью (раунд 1) ════════════════════════════════════════════

async function waitCalls(provider, n, timeoutMs = 2000) {
  const started = Date.now();
  while (provider.calls.length < n && Date.now() - started < timeoutMs) await sleep(5);
  assert.ok(provider.calls.length >= n, `ожидалось ${n} вызовов поставщика, было ${provider.calls.length}`);
}

test('Повтор доставки перепроверяет владельца: токен перешёл к другому сотруднику — повтора нет', async () => {
  configurePush({ baseDelayMs: 150 });
  await android('alice', 130);
  fcm.reply = () => ({ status: 'retry', reason: 'HTTP_503' });
  await restSend('bob', 'direct', people.alice.id, 'Алисе', 'push-recheck-owner');
  await waitCalls(fcm, 1);
  await android('bob', 130); // тот же телефон теперь у Боба
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1, 'уведомление Алисы не ушло на телефон Боба');
});

test('Повтор доставки перепроверяет сеанс: сотрудник вышел — повтора нет', async () => {
  configurePush({ baseDelayMs: 150 });
  const session = await tokenFor(people.alice.id);
  await register('alice', { platform: 'android', token: ANDROID(131), environment: 'production' }, session);
  fcm.reply = () => ({ status: 'retry', reason: 'HTTP_503' });
  await restSend('bob', 'direct', people.alice.id, 'Алисе', 'push-recheck-logout');
  await waitCalls(fcm, 1);
  assert.strictEqual((await api('POST', '/api/auth/logout', { token: session, body: {} })).status, 200);
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1);
});

test('Ошибка настройки поставщика не удаляет токены (громкая запись в журнал)', async () => {
  await android('bob', 132);
  fcm.reply = () => ({ status: 'config', reason: 'SENDER_ID_MISMATCH' });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await restSend('alice', 'direct', people.bob.id, 'Раз', 'push-config-1');
    await restSend('alice', 'direct', people.bob.id, 'Два', 'push-config-2');
    await push.idle();
  } finally {
    console.error = original;
  }
  assert.deepStrictEqual(tokensOf('bob'), [ANDROID(132)]);
  assert.strictEqual(errors.filter((e) => e.includes('ОШИБКА НАСТРОЙКИ')).length, 1, 'одна запись на причину');
});

test('Звонок: вызывающий сбросил — повтор уведомления не уходит, а телефон при входе получает call_end', async () => {
  configurePush({ baseDelayMs: 150 });
  await android('bob', 140);
  fcm.reply = () => ({ status: 'retry', reason: 'HTTP_503' });
  const a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.bob.id }));
  await waitCalls(fcm, 1);
  a.sock.send(JSON.stringify({ type: 'call_end', targetUserId: people.bob.id }));
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1, 'после сброса повтора нет');
  const b = await connect('bob');
  const end = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(end.senderId, people.alice.id);
  assert.strictEqual(end.reason, 'cancelled');
  assert.ok(!b.inbox.some((m) => m.type === 'call_offer'));
});

test('Звонок: срок у поставщика — от времени вызова; повтор за окно звонка не планируется', async () => {
  configurePush({ baseDelayMs: 20 });
  await android('bob', 141);
  let n = 0;
  fcm.reply = () => (++n === 1 ? { status: 'retry', reason: 'HTTP_503' } : { status: 'ok' });
  const a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.bob.id }));
  await push.idle();
  assert.strictEqual(fcm.calls.length, 2);
  const [first, second] = fcm.calls.map((c) => c.notification);
  assert.strictEqual(first.expiresAtMs, second.expiresAtMs, 'одна и та же граница');
  assert.ok(first.ttlSeconds <= 30 && second.ttlSeconds <= first.ttlSeconds);
  a.sock.send(JSON.stringify({ type: 'call_end', targetUserId: people.bob.id }));

  // Пауза повтора длиннее окна звонка (30 с): вызывающему сразу call_unavailable.
  configurePush({ baseDelayMs: 40000 });
  await android('bob', 141);
  fcm.reply = () => ({ status: 'retry', reason: 'HTTP_503' });
  a.inbox.length = 0;
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.bob.id }));
  const unavailable = await waitFor(a, (m) => m.type === 'call_unavailable');
  assert.strictEqual(unavailable.reason, 'Сотрудник сейчас не в сети');
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1);
});

test('Звонок: живого устройства нет (сеанс токена закончился) — call_unavailable сразу, без отправки', async () => {
  const session = await tokenFor(people.carol.id);
  await register('carol', { platform: 'android', token: ANDROID(142), environment: 'production' }, session);
  await identity.run('UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1', [people.carol.id]);
  try {
    const a = await connect('alice');
    a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.carol.id }));
    const unavailable = await waitFor(a, (m) => m.type === 'call_unavailable');
    assert.strictEqual(unavailable.targetUserId, people.carol.id);
    await push.idle();
    assert.strictEqual(allCalls().length, 0);
    assert.deepStrictEqual(tokensOf('carol'), [], 'мёртвый токен удалён');
  } finally {
    people.carol.token = await tokenFor(people.carol.id);
  }
});

test('Звонок: все доставки не удались — вызывающему call_unavailable, вызов снят', async () => {
  await android('bob', 143);
  await ios('bob', 144, { kind: 'voip' });
  fcm.reply = () => ({ status: 'invalid', reason: 'UNREGISTERED' });
  apns.reply = () => ({ status: 'failed', reason: 'PayloadTooLarge' });
  const a = await connect('alice');
  a.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people.bob.id }));
  const unavailable = await waitFor(a, (m) => m.type === 'call_unavailable');
  assert.strictEqual(unavailable.targetUserId, people.bob.id);
  assert.ok(!wsServer.pendingOffers.has(people.alice.id), 'ждущий вызов снят');
  const b = await connect('bob');
  const end = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(end.reason, 'unavailable');
});

test('Ответ на вызов, которого нет, — отвечающему call_end', async () => {
  await connect('alice');
  const b = await connect('bob');
  b.sock.send(JSON.stringify({ type: 'call_answer', targetUserId: people.alice.id }));
  const end = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(end.senderId, people.alice.id);
  assert.strictEqual(end.reason, 'no_call');
  assert.strictEqual(end.senderName, 'Алиса Тестова');
  assert.ok(!wsServer.activeCalls.has(people.bob.id), 'разговор не начался');
});

test('Продление: регистрация старым токеном в паузу после продления привязывается к новому сеансу', async () => {
  const old = await tokenFor(people.dave.id);
  const refreshed = await api('POST', '/api/auth/refresh', { token: old });
  assert.strictEqual(refreshed.status, 200);
  const late = await register('dave', { platform: 'android', token: ANDROID(150), environment: 'production' }, old);
  assert.strictEqual(late.status, 200, late.text);
  await api('POST', '/api/auth/logout', { token: refreshed.json.token, body: {} });
  assert.deepStrictEqual(tokensOf('dave'), []);
});

test('Выход сеансом старого формата (без jti) снимает токены без jti этого сотрудника/устройства', () => {
  const session = { jti: null, tokenVersion: 1, authTime: Math.floor(Date.now() / 1000) };
  PushTokens.register({ userId: people.dave.id, token: ANDROID(151), platform: 'android', kind: 'alert', environment: 'production', deviceId: 'legacy-1', session });
  PushTokens.register({ userId: people.dave.id, token: ANDROID(152), platform: 'android', kind: 'alert', environment: 'production', deviceId: 'other', session: { ...session, jti: 'a'.repeat(32) } });
  PushTokens.removeForLogout({ userId: people.dave.id, jti: null, deviceId: null });
  assert.deepStrictEqual(tokensOf('dave'), [ANDROID(152)]);
});

// ══ Задача 19: доводка жизненного цикла звонка через push ═══════════════════

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}
const offerTo = (client, name) => client.sock.send(JSON.stringify({ type: 'call_offer', targetUserId: people[name].id }));
const endTo = (client, name) => client.sock.send(JSON.stringify({ type: 'call_end', targetUserId: people[name].id }));
const answerTo = (client, name) => client.sock.send(JSON.stringify({ type: 'call_answer', targetUserId: people[name].id }));

test('Т19-1: повторный call_answer при уже начатом разговоре игнорируется — без call_end и без пересылки', async () => {
  const a = await connect('alice');
  const b = await connect('bob');
  offerTo(a, 'bob');
  await waitFor(b, (m) => m.type === 'call_offer');
  answerTo(b, 'alice');
  await waitFor(a, (m) => m.type === 'call_answer');
  answerTo(b, 'alice'); // CallKit и экран приложения ответили оба
  await sleep(100);
  assert.ok(!b.inbox.some((m) => m.type === 'call_end'), 'отвечающему не пришёл call_end');
  assert.strictEqual(a.inbox.filter((m) => m.type === 'call_answer').length, 1, 'вызывающему ответ не пересылается дважды');
  assert.strictEqual(wsServer.activeCalls.get(people.bob.id), people.alice.id, 'разговор продолжается');
  assert.strictEqual(wsServer.activeCalls.get(people.alice.id), people.bob.id);
  endTo(a, 'bob');
  await waitFor(b, (m) => m.type === 'call_end');
});

test('Т19-2: запоздалый провал доставки прежнего вызова не снимает новый вызов той же пары', async () => {
  await android('bob', 160);
  const held = gate();
  let n = 0;
  fcm.reply = () => (++n === 1 ? held.promise : { status: 'ok' });
  const a = await connect('alice');
  offerTo(a, 'bob');
  await waitCalls(fcm, 1);
  endTo(a, 'bob');
  await sleep(20);
  offerTo(a, 'bob'); // перезвонил
  await waitCalls(fcm, 2);
  held.open({ status: 'failed', reason: 'InternalServerError' });
  await push.idle();
  await sleep(30);
  assert.ok(!a.inbox.some((m) => m.type === 'call_unavailable'), 'вызывающему не сказали «не в сети» из-за старого вызова');
  assert.ok(wsServer.pendingOffers.has(people.alice.id), 'новый вызов ждёт');
  const b = await connect('bob');
  await waitFor(b, (m) => m.type === 'call_offer');
  assert.ok(!b.inbox.some((m) => m.type === 'call_end'), 'нового вызова не гасит call_end');
});

test('Т19-3: повтор доставки после продления сеанса идёт по новому jti, а не снимается', async () => {
  configurePush({ baseDelayMs: 400 });
  const session = await tokenFor(people.alice.id);
  await register('alice', { platform: 'android', token: ANDROID(161), environment: 'production' }, session);
  let n = 0;
  fcm.reply = () => (++n === 1 ? { status: 'retry', reason: 'HTTP_503' } : { status: 'ok' });
  await restSend('bob', 'direct', people.alice.id, 'Алисе', 'push-refresh-retry');
  await waitCalls(fcm, 1);
  const refreshed = await api('POST', '/api/auth/refresh', { token: session });
  assert.strictEqual(refreshed.status, 200, refreshed.text);
  await push.idle();
  assert.strictEqual(fcm.calls.length, 2, 'повтор ушёл после продления');
  assert.strictEqual(fcm.calls[1].token, ANDROID(161));
  // Выход новым токеном по-прежнему снимает привязку.
  await api('POST', '/api/auth/logout', { token: refreshed.json.token, body: {} });
  assert.deepStrictEqual(tokensOf('alice'), []);
});

test('Т19-4: вызывающий сбросил или отключился, пока сервер проверял вызов, — вызов не встаёт, телефон не будится', async () => {
  await android('bob', 162);
  const originalCanRing = push.canRing;
  const originalFresh = wsServer.freshUser;
  try {
    // (а) push: сброс во время проверки устройств.
    let checking = gate();
    push.canRing = async (id) => { await checking.promise; return originalCanRing.call(push, id); };
    let a = await connect('alice');
    offerTo(a, 'bob');
    await sleep(40);
    endTo(a, 'bob');
    await sleep(40);
    checking.open();
    await sleep(50);
    await push.idle();
    assert.strictEqual(fcm.calls.length, 0, 'уведомление о сброшенном вызове не ушло');
    assert.ok(!wsServer.pendingOffers.has(people.alice.id), 'вызов не встал');
    assert.ok(!a.inbox.some((m) => m.type === 'call_unavailable'), 'сбросившему отвечать нечего');

    // (б) push: вызывающий отключился во время проверки устройств.
    checking = gate();
    a = await connect('alice');
    offerTo(a, 'bob');
    await sleep(40);
    await disconnect('alice');
    checking.open();
    await sleep(50);
    await push.idle();
    assert.strictEqual(fcm.calls.length, 0, 'отключившийся не будит телефон');
    assert.ok(!wsServer.pendingOffers.has(people.alice.id));
    push.canRing = originalCanRing;

    // (в) вызываемый в сети: сброс во время проверки сеанса вызывающего.
    const b = await connect('bob');
    const verifying = gate();
    wsServer.freshUser = async function (ws) { await verifying.promise; return originalFresh.call(this, ws); };
    a = await connect('alice');
    offerTo(a, 'bob');
    await sleep(40);
    endTo(a, 'bob');
    await sleep(40);
    verifying.open();
    await sleep(80);
    assert.ok(!b.inbox.some((m) => m.type === 'call_offer'), 'после сброса вызываемому не звонит');
    assert.ok(!wsServer.pendingOffers.has(people.alice.id));
  } finally {
    push.canRing = originalCanRing;
    wsServer.freshUser = originalFresh;
  }
  await disconnect('bob');
  const b = await connect('bob');
  await sleep(50);
  assert.ok(!b.inbox.some((m) => m.type === 'call_offer'), 'при входе тоже не звонит');
});

test('Т19-5: call_end о закончившемся вызове приходит один раз; запоздалый ответ всё равно получает причину', async () => {
  await android('bob', 163);
  const a = await connect('alice');
  offerTo(a, 'bob');
  await push.idle();
  endTo(a, 'bob');
  await sleep(50);
  let b = await connect('bob');
  const first = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(first.reason, 'cancelled');
  await disconnect('bob');
  b = await connect('bob'); // переподключение в течение минуты
  await sleep(80);
  assert.ok(!b.inbox.some((m) => m.type === 'call_end'), 'повторный вход call_end не повторяет');
  answerTo(b, 'alice');
  const late = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(late.reason, 'cancelled', 'опоздавший ответ узнаёт причину');
});

test('Т19-6: очередь push переполнена при вызове — вызывающему call_unavailable, вызов снят', async () => {
  configurePush({ concurrency: 1, queueMax: 1 });
  await android('bob', 164);
  await android('carol', 165);
  const held = gate();
  fcm.reply = () => held.promise.then(() => ({ status: 'ok' }));
  await restSend('alice', 'direct', people.bob.id, 'Раз', 'push-full-1');
  await waitCalls(fcm, 1); // доставка держит единственный слот
  await restSend('alice', 'direct', people.bob.id, 'Два', 'push-full-2'); // занимает очередь
  assert.strictEqual(push.queue.length, 1);
  const a = await connect('alice');
  offerTo(a, 'carol');
  const unavailable = await waitFor(a, (m) => m.type === 'call_unavailable');
  assert.strictEqual(unavailable.targetUserId, people.carol.id);
  assert.strictEqual(unavailable.reason, 'Сотрудник сейчас не в сети');
  assert.ok(!wsServer.pendingOffers.has(people.alice.id), 'вызов снят');
  held.open();
  await push.idle();
});

test('Т19-7а: вызывающий отключился до входа вызываемого — при входе call_end connection_lost', async () => {
  await android('bob', 166);
  const a = await connect('alice');
  offerTo(a, 'bob');
  await push.idle();
  assert.strictEqual(fcm.calls.length, 1);
  await disconnect('alice');
  const b = await connect('bob');
  const end = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(end.reason, 'connection_lost');
  assert.strictEqual(end.senderId, people.alice.id);
  assert.strictEqual(end.senderName, 'Алиса Тестова');
  assert.ok(!b.inbox.some((m) => m.type === 'call_offer'));
});

test('Т19-7б: вызов истёк до входа вызываемого — при входе call_end timeout, вызов снят', async () => {
  await android('bob', 167);
  const a = await connect('alice');
  offerTo(a, 'bob');
  await push.idle();
  wsServer.pendingOffers.get(people.alice.id).at -= 3 * 60 * 1000; // старше 2 минут
  const b = await connect('bob');
  const end = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(end.reason, 'timeout');
  assert.strictEqual(end.senderId, people.alice.id);
  assert.strictEqual(end.senderName, 'Алиса Тестова');
  assert.ok(!b.inbox.some((m) => m.type === 'call_offer'));
  assert.ok(!wsServer.pendingOffers.has(people.alice.id));
  b.inbox.length = 0;
  answerTo(b, 'alice');
  const late = await waitFor(b, (m) => m.type === 'call_end');
  assert.strictEqual(late.reason, 'timeout');
  assert.ok(!a.inbox.some((m) => m.type === 'call_answer'));
});
