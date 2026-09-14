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
// Побудка: сигнал собеседнику через 1–30 минут. Одна на пару, не чаще раза
// в минуту, и не тем, у кого «Не беспокоить». Всё это проверяет сервер —
// кнопку в интерфейсе обойти просто.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
// «Минута» и пауза между побудками в тестах — доли секунды.
process.env.WAKE_MINUTE_MS = '150';
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

test('побудка срабатывает через выбранное время', async () => {
  const sender = sockets.ivanov;
  const target = sockets.petrova;
  send('ivanov', { type: 'wake_schedule', targetUserId: people.petrova.id, minutes: 1 });
  const scheduled = await waitFor(sender, (m) => m.type === 'wake_scheduled' && m.targetUserId === people.petrova.id);
  assert.strictEqual(scheduled.minutes, 1);
  assert.ok(scheduled.fireAt > Date.now());

  const ring = await waitFor(target, (m) => m.type === 'wake_ring');
  assert.strictEqual(ring.fromUserId, people.ivanov.id);
  assert.strictEqual(ring.fromName, 'Иванов Иван');
  const result = await waitFor(sender, (m) => m.type === 'wake_result' && m.targetUserId === people.petrova.id);
  assert.strictEqual(result.outcome, 'delivered');
  assert.ok(result.retryAt > Date.now(), 'сразу видно, когда можно снова');
});

test('следующая побудка — не раньше чем через минуту', async () => {
  const sender = sockets.ivanov;
  sender.inbox.length = 0;
  send('ivanov', { type: 'wake_schedule', targetUserId: people.petrova.id, minutes: 1 });
  const err = await waitFor(sender, (m) => m.type === 'wake_error');
  assert.strictEqual(err.code, 'cooldown');
  assert.ok(err.retryAt > Date.now());

  await sleep(Math.max(0, err.retryAt - Date.now()) + 50);
  sender.inbox.length = 0;
  send('ivanov', { type: 'wake_schedule', targetUserId: people.petrova.id, minutes: 2 });
  await waitFor(sender, (m) => m.type === 'wake_scheduled');
});

test('на одного собеседника — один отсчёт', async () => {
  const sender = sockets.ivanov;
  sender.inbox.length = 0;
  send('ivanov', { type: 'wake_schedule', targetUserId: people.petrova.id, minutes: 5 });
  const err = await waitFor(sender, (m) => m.type === 'wake_error');
  assert.strictEqual(err.code, 'already_scheduled');
});

test('отмена останавливает отсчёт, и сигнал не приходит', async () => {
  const sender = sockets.ivanov;
  const target = sockets.petrova;
  target.inbox.length = 0;
  send('ivanov', { type: 'wake_cancel', targetUserId: people.petrova.id });
  const cancelled = await waitFor(sender, (m) => m.type === 'wake_cancelled' && m.targetUserId === people.petrova.id);
  assert.ok(cancelled.retryAt > Date.now(), 'после отмены тоже действует пауза');
  assert.ok(await nothingArrives(target, (m) => m.type === 'wake_ring', 450));
});

test('допустимы только 1, 2, 3, 5, 10, 15 или 30 минут', async () => {
  const sender = await connect('sidorov');
  for (const minutes of [0, 4, 31, 120, -1, 'пять', null]) {
    sender.inbox.length = 0;
    send('sidorov', { type: 'wake_schedule', targetUserId: people.petrova.id, minutes });
    const err = await waitFor(sender, (m) => m.type === 'wake_error');
    assert.strictEqual(err.code, 'invalid_minutes', String(minutes));
  }
});

test('разбудить себя или несуществующего сотрудника нельзя', async () => {
  const sender = sockets.sidorov;
  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_schedule', targetUserId: people.sidorov.id, minutes: 1 });
  assert.strictEqual((await waitFor(sender, (m) => m.type === 'wake_error')).code, 'invalid_target');
  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_schedule', targetUserId: 999999, minutes: 1 });
  assert.strictEqual((await waitFor(sender, (m) => m.type === 'wake_error')).code, 'invalid_target');
});

test('того, у кого «Не беспокоить», разбудить нельзя', async () => {
  await connect('orlova');
  send('orlova', { type: 'set_dnd', enabled: true });
  await waitFor(sockets.sidorov, (m) => m.type === 'user_status_changed' && m.userId === people.orlova.id && m.status === 'dnd');
  const sender = sockets.sidorov;
  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_schedule', targetUserId: people.orlova.id, minutes: 1 });
  assert.strictEqual((await waitFor(sender, (m) => m.type === 'wake_error')).code, 'dnd');
  send('orlova', { type: 'set_dnd', enabled: false });
  await waitFor(sender, (m) => m.type === 'user_status_changed' && m.userId === people.orlova.id && m.status === 'online');
});

test('включённое во время отсчёта «Не беспокоить» гасит сигнал, и отправитель видит причину', async () => {
  const sender = sockets.sidorov;
  const target = sockets.orlova;
  sender.inbox.length = 0;
  target.inbox.length = 0;
  send('sidorov', { type: 'wake_schedule', targetUserId: people.orlova.id, minutes: 2 });
  await waitFor(sender, (m) => m.type === 'wake_scheduled');
  send('orlova', { type: 'set_dnd', enabled: true });
  const result = await waitFor(sender, (m) => m.type === 'wake_result', 3000);
  assert.strictEqual(result.outcome, 'dnd');
  assert.ok(!target.inbox.some((m) => m.type === 'wake_ring'));
  send('orlova', { type: 'set_dnd', enabled: false });
});

test('если собеседник не в сети к моменту сигнала, отправитель узнаёт об этом', async () => {
  await sleep(700);
  const sender = sockets.sidorov;
  sender.inbox.length = 0;
  send('sidorov', { type: 'wake_schedule', targetUserId: people.orlova.id, minutes: 1 });
  await waitFor(sender, (m) => m.type === 'wake_scheduled');
  await disconnect('orlova');
  const result = await waitFor(sender, (m) => m.type === 'wake_result');
  assert.strictEqual(result.outcome, 'offline');
});

test('после переподключения отправитель видит свой идущий отсчёт', async () => {
  await sleep(700);
  send('sidorov', { type: 'wake_schedule', targetUserId: people.ivanov.id, minutes: 30 });
  await waitFor(sockets.sidorov, (m) => m.type === 'wake_scheduled' && m.targetUserId === people.ivanov.id);
  const again = await connect('sidorov');
  const state = await waitFor(again, (m) => m.type === 'wake_state');
  const entry = state.scheduled.find((s) => s.targetUserId === people.ivanov.id);
  assert.ok(entry, 'отсчёт на месте');
  assert.strictEqual(entry.minutes, 30);
  send('sidorov', { type: 'wake_cancel', targetUserId: people.ivanov.id });
  await waitFor(again, (m) => m.type === 'wake_cancelled');
});
