const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Статус сотрудника и побудка собеседника.
//
// Статус выставляет система: «в сети», «отошёл» (компьютер простаивает или
// заблокирован), «не в сети» (нет соединения). Сам человек может только
// включить или выключить «Не беспокоить» — выбрать «не в сети», оставаясь на
// связи, больше нельзя.
//
// Побудка: сигнал собеседнику уходит сразу. Не чаще раза в минуту от одного
// человека (кого бы он ни будил), не тем, у кого «Не беспокоить», и не тем,
// кого нет в сети. Всё это проверяет сервер — кнопку в интерфейсе обойти просто.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
// Пауза между побудками в тестах — доли секунды.
process.env.WAKE_COOLDOWN_MS = '600';

let wsUrl;
let server;
const people = {};
const sockets = {};

test.before(async () => {
  await freshBoot();
  const UserService = require('../src/services/user.service');
  const AuthService = require('../src/services/auth.service');
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;

  for (const [username, full_name] of [
    ['ivanov', 'Иванов Иван'],
    ['petrova', 'Петрова Анна'],
    ['sidorov', 'Сидоров Пётр'],
    ['orlova', 'Орлова Ольга']
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(name) {
  const sock = new WebSocket(wsUrl);
  const client = { sock, inbox: [] };
  sock.on('message', (raw, isBinary) => {
    if (!isBinary) {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.on('open', resolve));
  sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
  await waitFor(client, (m) => m.type === 'auth_success');
  if (sockets[name]) {
    try { sockets[name].sock.close(); } catch {}
  }
  sockets[name] = client;
  return client;
}

function disconnect(name) {
  const client = sockets[name];
  delete sockets[name];
  return new Promise((resolve) => {
    client.sock.on('close', resolve);
    client.sock.close();
  });
}

const send = (name, payload) => sockets[name].sock.send(JSON.stringify(payload));

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(15);
  }
  throw new Error('событие не пришло за отведённое время');
}

async function nothingArrives(client, predicate, ms = 400) {
  await sleep(ms);
  return !client.inbox.some(predicate);
}

const statusOf = (client, userId) => {
  const events = client.inbox.filter((m) => m.type === 'user_status_changed' && m.userId === userId);
  return events.length ? events[events.length - 1].status : null;
};

// ── Статус ────────────────────────────────────────────────────────────────

test('выставить себе «не в сети», оставаясь на связи, нельзя', async () => {
  await connect('ivanov');
  const observer = await connect('petrova');
  send('ivanov', { type: 'set_status', status: 'offline' });
  assert.ok(await nothingArrives(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'offline'));
});

test('«Не беспокоить» включается и выключается самим сотрудником', async () => {
  const observer = sockets.petrova;
  send('ivanov', { type: 'set_dnd', enabled: true });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'dnd');

  observer.inbox.length = 0;
  send('ivanov', { type: 'set_dnd', enabled: false });
  const back = await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id);
  assert.strictEqual(back.status, 'online');
});

test('простой компьютера не снимает «Не беспокоить», а после выключения режима виден «отошёл»', async () => {
  const observer = sockets.petrova;
  send('ivanov', { type: 'set_dnd', enabled: true });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'dnd');

  observer.inbox.length = 0;
  send('ivanov', { type: 'presence', state: 'away' });
  await sleep(300);
  assert.notStrictEqual(statusOf(observer, people.ivanov.id), 'away', 'пока включён режим, виден «Не беспокоить»');

  send('ivanov', { type: 'set_dnd', enabled: false });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'away');
  send('ivanov', { type: 'presence', state: 'online' });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'online');
});

test('«Не беспокоить» сохраняется после переподключения', async () => {
  send('ivanov', { type: 'set_dnd', enabled: true });
  await waitFor(sockets.petrova, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'dnd');
  await disconnect('ivanov');
  const observer = sockets.petrova;
  observer.inbox.length = 0;
  const me = await connect('ivanov');
  assert.strictEqual(me.inbox.find((m) => m.type === 'auth_success').user.status, 'dnd');
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'dnd');
  send('ivanov', { type: 'set_dnd', enabled: false });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'online');
});

test('ручной выбор «отошёл» старым способом приходит как сигнал системы, а не как произвольный статус', async () => {
  const observer = sockets.petrova;
  observer.inbox.length = 0;
  send('ivanov', { type: 'set_status', status: 'away' });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'away');
  send('ivanov', { type: 'set_status', status: 'online' });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'online');
});

// ── Побудка ───────────────────────────────────────────────────────────────

const cooldownPassed = async (name) => {
  send(name, { type: 'wake_send', targetUserId: 0 });
  const err = await waitFor(sockets[name], (m) => m.type === 'wake_error' && m.targetUserId === 0);
  sockets[name].inbox.length = 0;
  if (err.code === 'cooldown') await sleep(Math.max(0, err.retryAt - Date.now()) + 50);
};

test('сигнал уходит сразу, и отправитель видит, когда можно снова', async () => {
  const sender = sockets.ivanov;
  const target = sockets.petrova;
  sender.inbox.length = 0;
  target.inbox.length = 0;
  const before = Date.now();
  send('ivanov', { type: 'wake_send', targetUserId: people.petrova.id });

  const ring = await waitFor(target, (m) => m.type === 'wake_ring');
  assert.strictEqual(ring.fromUserId, people.ivanov.id);
  assert.strictEqual(ring.fromName, 'Иванов Иван');
  const sent = await waitFor(sender, (m) => m.type === 'wake_sent');
  assert.strictEqual(sent.targetUserId, people.petrova.id);
  assert.ok(sent.at >= before);
  assert.strictEqual(sent.retryAt - sent.at, 600);
});

test('второй сигнал в течение минуты не уходит — даже другому собеседнику', async () => {
  const sender = sockets.ivanov;
  const target = await connect('sidorov');
  sender.inbox.length = 0;
  send('ivanov', { type: 'wake_send', targetUserId: people.sidorov.id });
  const err = await waitFor(sender, (m) => m.type === 'wake_error');
  assert.strictEqual(err.code, 'cooldown');
  assert.ok(err.retryAt > Date.now());
  assert.ok(await nothingArrives(target, (m) => m.type === 'wake_ring', 200));

  await sleep(Math.max(0, err.retryAt - Date.now()) + 50);
  sender.inbox.length = 0;
  send('ivanov', { type: 'wake_send', targetUserId: people.sidorov.id });
  await waitFor(sender, (m) => m.type === 'wake_sent');
  await waitFor(target, (m) => m.type === 'wake_ring');
});

test('два быстрых нажатия дают один сигнал', async () => {
  await cooldownPassed('ivanov');
  const target = sockets.petrova;
  target.inbox.length = 0;
  send('ivanov', { type: 'wake_send', targetUserId: people.petrova.id });
  send('ivanov', { type: 'wake_send', targetUserId: people.petrova.id });
  await waitFor(sockets.ivanov, (m) => m.type === 'wake_sent');
  await waitFor(sockets.ivanov, (m) => m.type === 'wake_error' && m.code === 'cooldown');
  await sleep(150);
  assert.strictEqual(target.inbox.filter((m) => m.type === 'wake_ring').length, 1);
});

test('разбудить себя или несуществующего сотрудника нельзя', async () => {
  const sender = sockets.sidorov;
  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_send', targetUserId: people.sidorov.id });
  assert.strictEqual((await waitFor(sender, (m) => m.type === 'wake_error')).code, 'invalid_target');
  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_send', targetUserId: 999999 });
  assert.strictEqual((await waitFor(sender, (m) => m.type === 'wake_error')).code, 'invalid_target');
});

test('того, у кого «Не беспокоить», разбудить нельзя, и паузы это не запускает', async () => {
  await connect('orlova');
  send('orlova', { type: 'set_dnd', enabled: true });
  await waitFor(sockets.sidorov, (m) => m.type === 'user_status_changed' && m.userId === people.orlova.id && m.status === 'dnd');
  const sender = sockets.sidorov;
  sender.inbox.length = 0;
  sockets.orlova.inbox.length = 0;
  send('sidorov', { type: 'wake_send', targetUserId: people.orlova.id });
  assert.strictEqual((await waitFor(sender, (m) => m.type === 'wake_error')).code, 'dnd');
  assert.ok(await nothingArrives(sockets.orlova, (m) => m.type === 'wake_ring', 150));

  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_send', targetUserId: people.petrova.id });
  await waitFor(sender, (m) => m.type === 'wake_sent');
  send('orlova', { type: 'set_dnd', enabled: false });
});

test('того, кого нет в сети, разбудить нельзя', async () => {
  await cooldownPassed('sidorov');
  const sender = sockets.sidorov;
  await disconnect('orlova');
  await waitFor(sender, (m) => m.type === 'user_status_changed' && m.userId === people.orlova.id && m.status === 'offline');
  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_send', targetUserId: people.orlova.id });
  assert.strictEqual((await waitFor(sender, (m) => m.type === 'wake_error')).code, 'offline');
});

test('после переподключения пауза не сбрасывается', async () => {
  await cooldownPassed('sidorov');
  send('sidorov', { type: 'wake_send', targetUserId: people.ivanov.id });
  const sent = await waitFor(sockets.sidorov, (m) => m.type === 'wake_sent');
  const again = await connect('sidorov');
  const state = await waitFor(again, (m) => m.type === 'wake_state');
  assert.strictEqual(state.retryAt, sent.retryAt);
  assert.strictEqual(state.targetUserId, people.ivanov.id);
  again.inbox.length = 0;
  send('sidorov', { type: 'wake_send', targetUserId: people.petrova.id });
  assert.strictEqual((await waitFor(again, (m) => m.type === 'wake_error')).code, 'cooldown');
});
