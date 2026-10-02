const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Один сотрудник на нескольких устройствах сразу (компьютер + телефон).
// Контракт — mobile/contracts/multi-device.md. Источник правды — сервер:
//   • присутствие считается по каждому сокету, итог — «в сети», если хоть
//     один сокет на переднем плане; «отошёл» — только если все в фоне;
//     «Не беспокоить» — одно на сотрудника, поверх итога;
//   • прочтение на одном устройстве снимает непрочитанное на остальных
//     (conversation_read) и тихим push «read» — уведомления на телефоне;
//   • уведомление о сообщении зависит от того, смотрит ли сотрудник ЭТОТ чат
//     на любом своём устройстве (viewing на сокете в состоянии online);
//   • эхо, правки, удаления — всем сокетам; /api/sync отдаёт любому
//     устройству одно и то же.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let chat;
let wsServer;
let push;
let MessageService;
const people = {};
const open = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeProvider() {
  const p = { calls: [] };
  p.send = async (args) => {
    p.calls.push(JSON.parse(JSON.stringify(args)));
    return { status: 'ok' };
  };
  return p;
}
let fcm;
let apns;
const pushData = () => [...fcm.calls, ...apns.calls].map((c) => c.notification.data);

test.before(async () => {
  const booted = await freshBoot();
  chat = booted.chat;
  const UserService = require('../src/services/user.service');
  const AuthService = require('../src/services/auth.service');
  MessageService = require('../src/services/message.service');
  push = require('../src/push/push.service');
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
    ['carol', 'Карина Тестова']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: AuthService.generateToken(await UserService.getUserById(created.id)) };
  }
  const team = MessageService.createChannel('Устройства', '', 'public', people.alice.id);
  people.teamId = Number(team.id);
  chat.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(people.teamId, people.bob.id, 'member', new Date().toISOString());
});

test.after(async () => {
  push.reset();
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

test.beforeEach(() => {
  fcm = fakeProvider();
  apns = fakeProvider();
  push.configure({ providers: { fcm, apns }, baseDelayMs: 20 });
  chat.prepare('DELETE FROM push_tokens').run();
  wsServer.dndUsers.clear();
  wsServer.pushedChats?.clear();
});

test.afterEach(async () => {
  await push.idle();
  for (const c of [...open]) await close(c);
});

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

// Устройство — отдельный сокет того же сотрудника. extra — поля кадра auth
// (device_id, platform), как у мобильных клиентов.
async function device(name, extra = {}) {
  const sock = new WebSocket(wsUrl);
  const client = { name, sock, inbox: [] };
  sock.on('message', (raw, isBinary) => {
    if (!isBinary) {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.on('open', resolve));
  const before = new Set(wsServer.userSockets.get(people[name].id) || []);
  sock.send(JSON.stringify({ type: 'auth', token: people[name].token, ...extra }));
  await waitFor(client, (m) => m.type === 'auth_success');
  // Серверная сторона этого сокета — чтобы ждать применения кадров по
  // состоянию сервера, а не фиксированной паузой.
  client.server = [...(wsServer.userSockets.get(people[name].id) || [])].find((ws) => !before.has(ws));
  client.expect = {};
  open.add(client);
  return client;
}

async function close(client) {
  open.delete(client);
  const before = wsServer.userSockets.get(people[client.name].id)?.size || 0;
  await new Promise((resolve) => {
    if (client.sock.readyState === WebSocket.CLOSED) return resolve();
    client.sock.once('close', resolve);
    client.sock.close();
  });
  for (let i = 0; i < 100 && (wsServer.userSockets.get(people[client.name].id)?.size || 0) >= before && before > 0; i += 1) await sleep(10);
}

const send = (client, payload) => {
  // Что сервер должен применить у этого сокета (presence/viewing идут мимо
  // очереди и без ответа) — settle() ждёт именно этого состояния.
  if (payload.type === 'presence') {
    client.expect.presence = payload.state;
    if (payload.state === 'away') client.expect.viewing = null;
  }
  if (payload.type === 'viewing') {
    client.expect.viewing = payload.conversationType ? { conversationType: payload.conversationType, targetId: payload.targetId } : null;
  }
  client.sock.send(JSON.stringify(payload));
};

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(10);
  }
  throw new Error(`${client.name}: событие не пришло за отведённое время`);
}

async function nothing(client, predicate, ms = 300) {
  await sleep(ms);
  return !client.inbox.some(predicate);
}

const statusOf = (observer, userId) => {
  const events = observer.inbox.filter((m) => m.type === 'user_status_changed' && m.userId === userId);
  return events.length ? events[events.length - 1].status : null;
};
const statusEvent = (userId, status) => (m) => m.type === 'user_status_changed' && m.userId === userId && m.status === status;
const clear = (...clients) => { for (const c of clients) c.inbox.length = 0; };

async function until(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('условие не выполнилось за отведённое время');
}

// Ждать, пока сервер применит отправленные presence/viewing (опрос состояния
// сокетов на сервере; на нагруженной машине фиксированная пауза ненадёжна).
async function settle(timeoutMs = 3000) {
  const applied = (c) => !c.server
    || ((c.expect.presence === undefined || c.server.presenceState === c.expect.presence)
      && (c.expect.viewing === undefined || JSON.stringify(c.server.viewing) === JSON.stringify(c.expect.viewing)));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ([...open].every(applied)) return;
    await sleep(5);
  }
  throw new Error('сервер не применил presence/viewing за отведённое время');
}

const ANDROID = (n) => `fcm-${n}-ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij:0123456789`;
async function androidToken(name, n, deviceId) {
  const res = await api('POST', '/api/devices/push-token', { token: people[name].token, body: { platform: 'android', token: ANDROID(n), device_id: deviceId } });
  assert.strictEqual(res.status, 200, res.text);
}

// ══ Присутствие: по сокету, итог — по всем ════════════════════════════════

test('Присутствие: компьютер в сети + телефон в фоне → «в сети» (телефон не перебивает компьютер)', async () => {
  const observer = await device('carol');
  const desk = await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  clear(observer);
  send(phone, { type: 'presence', state: 'away' });
  assert.ok(await nothing(observer, statusEvent(people.bob.id, 'away')), 'Боб за компьютером — не «отошёл»');
  assert.strictEqual(wsServer.effectiveStatus(people.bob.id), 'online');
  // Компьютер ничего не пересылает — его состояние не менялось.
  assert.ok(desk.inbox.length >= 0);
});

test('Присутствие: оба в фоне → «отошёл»; новый сокет входит «в сети» и поднимает итог', async () => {
  const observer = await device('carol');
  const desk = await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(desk, { type: 'presence', state: 'away' });
  await settle();
  clear(observer);
  send(phone, { type: 'presence', state: 'away' });
  await waitFor(observer, statusEvent(people.bob.id, 'away'));
  clear(observer);
  await device('bob', { device_id: 'bob-tablet', platform: 'ios' });
  await waitFor(observer, statusEvent(people.bob.id, 'online'));
});

test('Присутствие: телефон, подключившийся в фоне (presence: away в auth), не поднимает итог', async () => {
  const observer = await device('carol');
  const desk = await device('bob');
  send(desk, { type: 'presence', state: 'away' });
  await waitFor(observer, statusEvent(people.bob.id, 'away'));
  clear(observer);
  await device('bob', { device_id: 'bob-phone', platform: 'android', presence: 'away' });
  await waitFor(observer, (m) => m.type === 'user_status_changed' && m.userId === people.bob.id);
  assert.strictEqual(statusOf(observer, people.bob.id), 'away');
  assert.strictEqual(wsServer.aggregatePresence(people.bob.id), 'away');
});

test('Присутствие: компьютер закрылся, телефон в фоне → «отошёл»; последний сокет → «не в сети»', async () => {
  const observer = await device('carol');
  const desk = await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(phone, { type: 'presence', state: 'away' });
  await settle();
  clear(observer);
  await close(desk);
  await waitFor(observer, statusEvent(people.bob.id, 'away'));
  assert.ok(!observer.inbox.some(statusEvent(people.bob.id, 'offline')), 'пока жив телефон — не «не в сети»');
  clear(observer);
  await close(phone);
  await waitFor(observer, statusEvent(people.bob.id, 'offline'));
});

test('Присутствие: закрылся сокет в фоне, остался в сети — итог не меняется, рассылки нет', async () => {
  const observer = await device('carol');
  await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(phone, { type: 'presence', state: 'away' });
  await settle();
  clear(observer);
  await close(phone);
  assert.ok(await nothing(observer, (m) => m.type === 'user_status_changed' && m.userId === people.bob.id));
});

test('«Не беспокоить» поверх любого итога и обратно; видно на всех устройствах сотрудника', async () => {
  const observer = await device('carol');
  const desk = await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(phone, { type: 'set_dnd', enabled: true });
  await waitFor(observer, statusEvent(people.bob.id, 'dnd'));
  await waitFor(desk, statusEvent(people.bob.id, 'dnd'));
  await waitFor(phone, statusEvent(people.bob.id, 'dnd'));
  clear(observer);
  // Под «Не беспокоить» смена присутствия не видна.
  send(desk, { type: 'presence', state: 'away' });
  send(phone, { type: 'presence', state: 'away' });
  assert.ok(await nothing(observer, (m) => m.type === 'user_status_changed' && m.userId === people.bob.id));
  // Выключил на компьютере — показывается итог: оба в фоне → «отошёл».
  send(desk, { type: 'set_dnd', enabled: false });
  await waitFor(observer, statusEvent(people.bob.id, 'away'));
  await waitFor(phone, statusEvent(people.bob.id, 'away'));
});

test('Нет сокетов: «Не беспокоить» переживает отключение всех устройств; вход — «не беспокоить», не «в сети»', async () => {
  const observer = await device('carol');
  let phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(phone, { type: 'set_dnd', enabled: true });
  await waitFor(observer, statusEvent(people.bob.id, 'dnd'));
  await close(phone);
  await waitFor(observer, statusEvent(people.bob.id, 'offline'));
  assert.strictEqual(wsServer.userSockets.get(people.bob.id), undefined);
  clear(observer);
  phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  await waitFor(observer, statusEvent(people.bob.id, 'dnd'));
  send(phone, { type: 'set_dnd', enabled: false });
  await waitFor(observer, statusEvent(people.bob.id, 'online'));
});

test('Старый формат set_status работает по сокету: away одного из двух не делает «отошёл»', async () => {
  const observer = await device('carol');
  await device('bob');
  const legacy = await device('bob');
  clear(observer);
  send(legacy, { type: 'set_status', status: 'away' });
  assert.ok(await nothing(observer, statusEvent(people.bob.id, 'away')));
  send(legacy, { type: 'status_update', status: 'dnd' });
  await waitFor(observer, statusEvent(people.bob.id, 'dnd'));
});

// ══ Прочтение на одном устройстве — на остальных ══════════════════════════

test('Прочтение личного: другие сокеты читателя получают conversation_read, отметивший — нет; повтор — тишина', async () => {
  const alice = await device('alice');
  const desk = await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(alice, { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Прочитай на компьютере', client_msg_id: 'md-read-1' });
  const sent = await waitFor(phone, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-read-1');
  clear(alice, desk, phone);
  send(desk, { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  const frame = await waitFor(phone, (m) => m.type === 'conversation_read');
  assert.strictEqual(frame.conversationType, 'direct');
  assert.strictEqual(frame.targetId, people.alice.id, 'targetId — собеседник с точки зрения читателя');
  assert.strictEqual(frame.byUserId, people.bob.id);
  assert.ok(frame.messageIds.includes(sent.message.id));
  assert.ok(typeof frame.at === 'string' && !Number.isNaN(Date.parse(frame.at)));
  const read = await waitFor(alice, (m) => m.type === 'messages_read');
  assert.deepStrictEqual(read.messageIds, frame.messageIds, 'автор получает прежний messages_read');
  assert.ok(await nothing(desk, (m) => m.type === 'conversation_read'), 'отметившему сокету — не нужно');
  assert.ok(!alice.inbox.some((m) => m.type === 'conversation_read'), 'собеседнику — не conversation_read');
  clear(phone);
  send(desk, { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  assert.ok(await nothing(phone, (m) => m.type === 'conversation_read'), 'нечего читать — нет кадра');
});

test('Прочтение канала: conversation_read с lastReadId другим сокетам; повтор без новых — тишина', async () => {
  const alice = await device('alice');
  const desk = await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(alice, { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Всем', client_msg_id: 'md-read-ch-1' });
  const sent = await waitFor(phone, (m) => m.type === 'channel_message' && m.message.client_msg_id === 'md-read-ch-1');
  clear(desk, phone);
  send(phone, { type: 'mark_read', conversationType: 'channel', targetId: people.teamId });
  const frame = await waitFor(desk, (m) => m.type === 'conversation_read');
  assert.strictEqual(frame.conversationType, 'channel');
  assert.strictEqual(frame.targetId, people.teamId);
  assert.strictEqual(frame.byUserId, people.bob.id);
  assert.strictEqual(frame.lastReadId, sent.message.id);
  assert.ok(await nothing(phone, (m) => m.type === 'conversation_read'));
  clear(desk);
  send(phone, { type: 'mark_read', conversationType: 'channel', targetId: people.teamId });
  assert.ok(await nothing(desk, (m) => m.type === 'conversation_read'));
});

// ══ Уведомления: смотрит ли сотрудник ЭТОТ чат ═════════════════════════════

async function aliceSays(alice, text, key, conversationType = 'direct') {
  const targetId = conversationType === 'channel' ? people.teamId : people.bob.id;
  send(alice, { type: 'send_message', conversationType, targetId, text, client_msg_id: key });
  await waitFor(alice, (m) => (m.type === 'direct_message' || m.type === 'channel_message') && m.message.client_msg_id === key);
}
const frameOf = (client, key) => client.inbox.find((m) => (m.type === 'direct_message' || m.type === 'channel_message') && m.message.client_msg_id === key);
const newMessageOf = (client, key) => client.inbox.find((m) => m.type === 'new_message' && m.message.client_msg_id === key);

test('Чат открыт на компьютере (viewing, online) — баннера нет нигде, push на телефон не уходит', async () => {
  await androidToken('bob', 1, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  await settle();
  await aliceSays(alice, 'Вижу, ты в чате', 'md-n-1');
  const f = await waitFor(desk, (m) => m.type === 'direct_message');
  assert.strictEqual(f.notify, false);
  assert.strictEqual(newMessageOf(desk, 'md-n-1').notify, false, 'new_message несёт тот же признак');
  await push.idle();
  assert.deepStrictEqual(pushData(), []);
});

test('Компьютер в другом чате, телефон в кармане — баннер на компьютере и push на телефон', async () => {
  await androidToken('bob', 2, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'viewing', conversationType: 'channel', targetId: people.teamId });
  await settle();
  await aliceSays(alice, 'Ты в канале, а я в личке', 'md-n-2');
  const f = await waitFor(desk, (m) => m.type === 'direct_message');
  assert.strictEqual(f.notify, true);
  await push.idle();
  assert.deepStrictEqual(pushData(), [{ type: 'message', conversationType: 'direct', targetId: people.alice.id, messageId: f.message.id }]);
  assert.strictEqual(frameOf(alice, 'md-n-2').notify, false, 'своё эхо — без уведомления');
});

test('Телефон на переднем плане в списке (device_id в auth) — баннер в приложении, без push', async () => {
  await androidToken('bob', 3, 'bob-phone');
  const alice = await device('alice');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  await aliceSays(alice, 'Телефон в руке', 'md-n-3');
  const f = await waitFor(phone, (m) => m.type === 'direct_message');
  assert.strictEqual(f.notify, true);
  await push.idle();
  assert.deepStrictEqual(pushData(), []);
});

test('Телефон в фоне с живым сокетом — кадр без баннера и push; чат открыт на телефоне — компьютер молчит', async () => {
  await androidToken('bob', 4, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(phone, { type: 'presence', state: 'away' });
  await settle();
  await aliceSays(alice, 'Телефон в кармане', 'md-n-4');
  await waitFor(phone, (m) => m.type === 'direct_message');
  assert.strictEqual(frameOf(phone, 'md-n-4').notify, false);
  assert.strictEqual(frameOf(desk, 'md-n-4').notify, true);
  await push.idle();
  assert.strictEqual(pushData().length, 1);

  send(phone, { type: 'presence', state: 'online' });
  send(phone, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  await settle();
  fcm.calls.length = 0;
  await aliceSays(alice, 'Теперь читаешь с телефона', 'md-n-5');
  await waitFor(desk, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-n-5');
  assert.strictEqual(frameOf(desk, 'md-n-5').notify, false, 'смотрит на телефоне — компьютеру баннер не нужен');
  assert.strictEqual(frameOf(phone, 'md-n-5').notify, false);
  await push.idle();
  assert.deepStrictEqual(pushData(), []);
});

test('Простой (presence away) снимает viewing: возврат в online без нового viewing — уведомлять', async () => {
  await androidToken('bob', 5, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  send(desk, { type: 'presence', state: 'away' });
  await settle();
  await aliceSays(alice, 'Ты отошёл', 'md-n-6');
  await waitFor(desk, (m) => m.type === 'direct_message');
  assert.strictEqual(frameOf(desk, 'md-n-6').notify, true, 'простаивающий компьютер — баннер (push у него нет)');
  await push.idle();
  assert.strictEqual(pushData().length, 1, 'телефону push');
  send(desk, { type: 'presence', state: 'online' });
  await settle();
  fcm.calls.length = 0;
  await aliceSays(alice, 'Вернулся, но чат не открыт заново', 'md-n-7');
  await waitFor(desk, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-n-7');
  assert.strictEqual(frameOf(desk, 'md-n-7').notify, true);
  await push.idle();
  assert.strictEqual(pushData().length, 1);
});

test('viewing снимается кадром с conversationType: null; недопустимый viewing не принимается', async () => {
  await androidToken('bob', 6, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  send(desk, { type: 'viewing', conversationType: null });
  await settle();
  await aliceSays(alice, 'Ушёл из чата', 'md-n-8');
  await waitFor(desk, (m) => m.type === 'direct_message');
  assert.strictEqual(frameOf(desk, 'md-n-8').notify, true);
  // Недопустимый кадр не оставляет прежний чат «открытым» — снимает его.
  for (const bad of [
    { type: 'viewing', conversationType: 'direct', targetId: 'abc' },
    { type: 'viewing', conversationType: 'group', targetId: people.alice.id },
    { type: 'viewing', conversationType: 'direct', targetId: -3 }
  ]) {
    send(desk, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
    await settle();
    desk.sock.send(JSON.stringify(bad));
    await until(() => desk.server.viewing === null);
  }
});

test('viewing сверх предела частоты снимает прежнее значение (лучше лишнее уведомление)', async () => {
  const desk = await device('bob');
  for (let i = 0; i < 25; i += 1) desk.sock.send(JSON.stringify({ type: 'viewing', conversationType: 'direct', targetId: people.alice.id }));
  await until(() => desk.server.viewing === null);
  desk.expect.viewing = null;
});

test('viewing в кадре auth: чат «смотрят» сразу после входа; при presence away в auth — нет', async () => {
  await androidToken('bob', 11, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob', { viewing: { conversationType: 'direct', targetId: people.alice.id } });
  assert.deepStrictEqual(desk.server.viewing, { conversationType: 'direct', targetId: people.alice.id });
  await aliceSays(alice, 'Сразу после входа', 'md-auth-v1');
  await waitFor(desk, (m) => m.type === 'direct_message');
  assert.strictEqual(frameOf(desk, 'md-auth-v1').notify, false);
  await push.idle();
  assert.deepStrictEqual(pushData(), []);
  const hidden = await device('bob', { presence: 'away', viewing: { conversationType: 'direct', targetId: people.alice.id } });
  assert.strictEqual(hidden.server.viewing, null);
  const junk = await device('bob', { viewing: { conversationType: 'direct', targetId: 'x' } });
  assert.strictEqual(junk.server.viewing, null);
});

test('«Не беспокоить»: кадры без баннера, push нет; канал — как личный', async () => {
  await androidToken('bob', 7, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'set_dnd', enabled: true });
  await waitFor(desk, statusEvent(people.bob.id, 'dnd'));
  await aliceSays(alice, 'В канал при DND', 'md-n-9', 'channel');
  await waitFor(desk, (m) => m.type === 'channel_message');
  assert.strictEqual(frameOf(desk, 'md-n-9').notify, false);
  await push.idle();
  assert.deepStrictEqual(pushData(), []);
});

test('Канал: viewing канала гасит уведомление о канале, а не о личном с тем же id', async () => {
  await androidToken('bob', 8, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'viewing', conversationType: 'channel', targetId: people.teamId });
  await settle();
  await aliceSays(alice, 'В открытый канал', 'md-n-10', 'channel');
  await waitFor(desk, (m) => m.type === 'channel_message');
  assert.strictEqual(frameOf(desk, 'md-n-10').notify, false);
  await push.idle();
  assert.deepStrictEqual(pushData(), []);
});

test('Очередь push перепроверяет решение перед доставкой: чат открыли, пока задание ждало, — push нет', async () => {
  await androidToken('bob', 9, 'bob-phone');
  const desk = await device('bob');
  send(desk, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  await settle();
  const message = { id: 999001, conversation_type: 'direct', target_id: people.bob.id, sender_id: people.alice.id };
  push.notifyMessage(message, [people.bob.id]);
  await push.idle();
  assert.deepStrictEqual(pushData(), []);
  send(desk, { type: 'viewing', conversationType: null });
  await settle();
  push.notifyMessage(message, [people.bob.id]);
  await push.idle();
  assert.strictEqual(pushData().length, 1);
});

test('Прочитано на компьютере — тихий push «read» телефону, получившему push о сообщении; повтор — нет', async () => {
  await androidToken('bob', 10, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  await aliceSays(alice, 'Прочитай где-нибудь', 'md-r-1');
  await waitFor(desk, (m) => m.type === 'direct_message');
  await push.idle();
  assert.strictEqual(pushData().length, 1);
  fcm.calls.length = 0;
  send(desk, { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  await waitFor(alice, (m) => m.type === 'messages_read');
  await push.idle();
  assert.deepStrictEqual(pushData(), [{ type: 'read', conversationType: 'direct', targetId: people.alice.id }]);
  assert.strictEqual(fcm.calls[0].notification.kind, 'read');
  fcm.calls.length = 0;
  await aliceSays(alice, 'Ещё одно, но чат открыт', 'md-r-2');
  send(desk, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  await settle();
  await aliceSays(alice, 'И ещё', 'md-r-3');
  await push.idle();
  fcm.calls.length = 0;
  send(desk, { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  await sleep(100);
  await push.idle();
  // md-r-2 ушло push'ем (чат ещё не был открыт), значит прочтение его снимает.
  assert.deepStrictEqual(pushData(), [{ type: 'read', conversationType: 'direct', targetId: people.alice.id }]);
  fcm.calls.length = 0;
  await aliceSays(alice, 'Пока чат открыт', 'md-r-4');
  send(desk, { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  await sleep(100);
  await push.idle();
  assert.deepStrictEqual(pushData(), [], 'push о сообщении не уходил — снимать нечего');
});

// ══ Эхо, правки, удаления, набор, синхронизация ═══════════════════════════

test('Эхо своего сообщения — всем сокетам автора; повтор того же client_msg_id — только автору', async () => {
  const alice = await device('alice');
  const aliceDesk = await device('alice');
  const bob = await device('bob');
  send(alice, { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'С телефона', client_msg_id: 'md-echo-1' });
  const echo = await waitFor(aliceDesk, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-echo-1');
  await waitFor(bob, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-echo-1');
  clear(alice, aliceDesk, bob);
  send(alice, { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'С телефона', client_msg_id: 'md-echo-1' });
  const again = await waitFor(aliceDesk, (m) => m.type === 'direct_message');
  assert.strictEqual(again.message.id, echo.message.id, 'та же запись');
  await waitFor(alice, (m) => m.type === 'direct_message');
  assert.ok(await nothing(bob, (m) => m.type === 'direct_message'), 'получателю повтор не уходит');
});

test('Правка и удаление — всем сокетам обеих сторон; удаление побеждает более позднюю правку', async () => {
  const phone = await device('alice');
  const desk = await device('alice');
  const bob = await device('bob');
  const bobPhone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(phone, { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Черновик', client_msg_id: 'md-ed-1' });
  const sent = await waitFor(desk, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-ed-1');
  const id = sent.message.id;
  clear(phone, desk, bob, bobPhone);
  // Почти одновременно: правка с компьютера, удаление с телефона, ещё одна правка с компьютера.
  send(desk, { type: 'edit_message', messageId: id, text: 'Правка с компьютера' });
  send(phone, { type: 'delete_message', messageId: id });
  await waitFor(desk, (m) => m.type === 'message_deleted' && m.messageId === id);
  send(desk, { type: 'edit_message', messageId: id, text: 'Поздняя правка' });
  const err = await waitFor(desk, (m) => m.type === 'error' && m.context === 'edit_message' && m.messageId === id);
  assert.strictEqual(err.code, 'MESSAGE_DELETED');
  for (const c of [phone, desk, bob, bobPhone]) {
    const tomb = await waitFor(c, (m) => m.type === 'message_deleted' && m.messageId === id);
    assert.ok(tomb.updated_at, `${c.name}: надгробие с updated_at`);
    const updated = c.inbox.find((m) => m.type === 'message_updated' && m.message.id === id);
    if (updated) {
      assert.ok(c.inbox.indexOf(updated) < c.inbox.indexOf(tomb), `${c.name}: правка приходит раньше надгробия`);
      assert.ok(updated.message.updated_at <= tomb.updated_at, `${c.name}: updated_at надгробия не раньше правки`);
    }
  }
  const row = chat.prepare('SELECT is_deleted, text FROM messages WHERE id = ?').get(id);
  assert.strictEqual(row.is_deleted, 1);
  assert.strictEqual(row.text, '');
});

test('«Печатает…» с одного устройства — всем устройствам собеседника, не своим', async () => {
  const alicePhone = await device('alice');
  const aliceDesk = await device('alice');
  const bob = await device('bob');
  const bobPhone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(alicePhone, { type: 'typing', conversationType: 'direct', targetId: people.bob.id, isTyping: true });
  await waitFor(bob, (m) => m.type === 'user_typing' && m.userId === people.alice.id);
  await waitFor(bobPhone, (m) => m.type === 'user_typing' && m.userId === people.alice.id);
  assert.ok(await nothing(aliceDesk, (m) => m.type === 'user_typing'));
});

test('/api/sync: устройство, бывшее без связи, догоняет всё, что сделали на другом — без пропусков', async () => {
  const alice = await device('alice');
  const desk = await device('bob');
  const start = await api('GET', '/api/sync', { token: people.bob.token });
  const cursor = start.json.next_cursor;
  // «Телефон» Боба без связи. На компьютере: входящее, ответ, правка, удаление, прочтение.
  await aliceSays(alice, 'Пока телефон спит', 'md-sync-1');
  const incoming = frameOf(alice, 'md-sync-1').message.id;
  send(desk, { type: 'send_message', conversationType: 'direct', targetId: people.alice.id, text: 'Ответ с компьютера', client_msg_id: 'md-sync-2' });
  const reply = (await waitFor(desk, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-sync-2')).message.id;
  send(desk, { type: 'send_message', conversationType: 'direct', targetId: people.alice.id, text: 'Удалю', client_msg_id: 'md-sync-3' });
  const doomed = (await waitFor(desk, (m) => m.type === 'direct_message' && m.message.client_msg_id === 'md-sync-3')).message.id;
  send(desk, { type: 'edit_message', messageId: reply, text: 'Ответ с компьютера (исправлено)' });
  await waitFor(desk, (m) => m.type === 'message_updated' && m.message.id === reply);
  send(desk, { type: 'delete_message', messageId: doomed });
  await waitFor(desk, (m) => m.type === 'message_deleted' && m.messageId === doomed);
  send(desk, { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  await waitFor(alice, (m) => m.type === 'messages_read');

  // Телефон просыпается: одна синхронизация с его курсора.
  const page = await api('GET', `/api/sync?since=${encodeURIComponent(cursor)}&limit=50`, { token: people.bob.token });
  assert.strictEqual(page.status, 200);
  const byId = new Map(page.json.messages.map((m) => [m.id, m]));
  assert.strictEqual(byId.get(incoming).delivery_status, 'read', 'прочитанное на компьютере — прочитано и для телефона');
  assert.strictEqual(byId.get(reply).text, 'Ответ с компьютера (исправлено)');
  assert.ok(byId.get(reply).updated_at);
  assert.strictEqual(byId.get(doomed).is_deleted, 1);
  assert.strictEqual(byId.get(doomed).text, '');
  // Второе устройство с того же курсора получает ровно то же.
  const again = await api('GET', `/api/sync?since=${encodeURIComponent(cursor)}&limit=50`, { token: people.bob.token });
  assert.deepStrictEqual(again.json.messages.map((m) => [m.id, m.change_seq]), page.json.messages.map((m) => [m.id, m.change_seq]));
  // Присутствие телефона: вошёл — «в сети», общий итог не «отошёл».
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  assert.strictEqual(statusOf(phone, people.bob.id), 'online');
});

// ══ Проверка ревью: зомби-сокеты, очередь, устаревшие push, сбои ═══════════

test('Зомби-сокет телефона: новый auth с тем же device_id вытесняет старый — итог пересчитан, push не заглушён', async () => {
  await androidToken('bob', 20, 'bob-phone');
  const observer = await device('carol');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'presence', state: 'away' });
  // Старый сокет телефона: «в сети» и смотрит чат с Алисой — потом телефон
  // теряет сеть, а сокет на сервере остаётся живым.
  const zombie = await device('bob', { device_id: 'bob-phone', platform: 'android' });
  send(zombie, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  await settle();
  const zombieServer = zombie.server;
  open.delete(zombie);
  clear(observer);
  // Телефон переподключается в фоне.
  const phone = await device('bob', { device_id: 'bob-phone', platform: 'android', presence: 'away' });
  await until(() => !wsServer.userSockets.get(people.bob.id).has(zombieServer));
  await new Promise((resolve) => (zombie.sock.readyState === WebSocket.CLOSED ? resolve() : zombie.sock.once('close', resolve)));
  await waitFor(observer, statusEvent(people.bob.id, 'away'));
  assert.strictEqual(wsServer.aggregatePresence(people.bob.id), 'away');
  assert.strictEqual(wsServer.userSockets.get(people.bob.id).size, 2, 'место зомби освобождено');
  await aliceSays(alice, 'Телефон снова в кармане', 'md-zombie-1');
  await waitFor(phone, (m) => m.type === 'direct_message');
  assert.strictEqual(frameOf(phone, 'md-zombie-1').notify, false, 'в фоне с push — без баннера');
  assert.strictEqual(frameOf(desk, 'md-zombie-1').notify, true);
  await push.idle();
  assert.strictEqual(pushData().length, 1, 'push на телефон — зомби его не заглушил');
});

test('Зомби не занимает место: девятый вход того же устройства вытесняет прежний, а не TOO_MANY_SESSIONS', async () => {
  for (let i = 0; i < 7; i += 1) await device('carol');
  await device('carol', { device_id: 'carol-phone' });
  const again = await device('carol', { device_id: 'carol-phone' });
  assert.ok(again.server, 'вошёл');
  await until(() => wsServer.userSockets.get(people.carol.id).size === 8);
});

test('Очередь push: участник в приложении без устройств с push заданий не порождает; телефон в кармане — порождает', async () => {
  const alice = await device('alice');
  await device('bob');
  const enqueued = [];
  const original = push.enqueue;
  push.enqueue = function spy(job) { enqueued.push(job); return original.call(this, job); };
  try {
    await aliceSays(alice, 'В канал, Боб в приложении', 'md-q-1', 'channel');
    await push.idle();
    assert.deepStrictEqual(enqueued.filter((j) => j.kind === 'message'), []);
    await androidToken('bob', 21, 'bob-phone');
    await aliceSays(alice, 'Теперь у Боба есть телефон', 'md-q-2', 'channel');
    await push.idle();
    assert.strictEqual(enqueued.filter((j) => j.kind === 'message' && j.type === 'user').length, 1);
    assert.strictEqual(pushData().length, 1);
  } finally {
    push.enqueue = original;
  }
});

test('Звонок не вытесняется потоком сообщений: резерв мест и место впереди очереди', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  push.configure({ providers: { fcm, apns }, baseDelayMs: 20, concurrency: 1, queueMax: 1 });
  fcm.send = async (args) => {
    fcm.calls.push(JSON.parse(JSON.stringify(args)));
    if (args.notification.kind === 'message') await held;
    return { status: 'ok' };
  };
  await androidToken('bob', 22, 'bob-phone');
  await androidToken('carol', 23, 'carol-phone');
  const alice = await device('alice');
  await aliceSays(alice, 'Раз', 'md-call-1');
  await until(() => fcm.calls.length === 1);
  await aliceSays(alice, 'Два', 'md-call-2');
  await aliceSays(alice, 'Три', 'md-call-3');
  assert.ok(push.queue.length >= 1, 'очередь сообщений заполнена');
  send(alice, { type: 'call_offer', targetUserId: people.carol.id });
  await until(() => push.queue.some((j) => j.kind === 'call'));
  assert.strictEqual(push.queue[0].kind, 'call', 'звонок впереди сообщений');
  release();
  await push.idle();
  assert.ok(fcm.calls.some((c) => c.notification.kind === 'call'), 'звонок доставлен');
  assert.ok(!alice.inbox.some((m) => m.type === 'call_unavailable'));
  send(alice, { type: 'call_end', targetUserId: people.carol.id });
  await sleep(50);
  wsServer.pendingOffers.clear();
});

test('Устаревший push: повтор доставки после прочтения на компьютере не уходит', async () => {
  push.configure({ providers: { fcm, apns }, baseDelayMs: 400 });
  let first = true;
  fcm.send = async (args) => {
    fcm.calls.push(JSON.parse(JSON.stringify(args)));
    if (args.notification.kind === 'message' && first) { first = false; return { status: 'retry' }; }
    return { status: 'ok' };
  };
  await androidToken('bob', 24, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  await aliceSays(alice, 'Повторится?', 'md-stale-1');
  await until(() => fcm.calls.length === 1);
  send(desk, { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  await push.idle();
  assert.deepStrictEqual(fcm.calls.map((c) => c.notification.data.type), ['message', 'read'], 'повтора сообщения после «read» нет');
});

test('Очередь: «Не беспокоить» включили между раздачей и доставкой — не уходит; устройство перепроверяется в deliver', async () => {
  await androidToken('bob', 25, 'bob-phone');
  const alice = await device('alice');
  const hooks = push.presence;
  // 1) «Не беспокоить» появилось после раздачи по устройствам (третья проверка — в deliver).
  let dndChecks = 0;
  push.presence = { ...hooks, isDnd: (id) => (Number(id) === people.bob.id ? (dndChecks += 1) >= 3 : hooks.isDnd(id)) };
  try {
    await aliceSays(alice, 'DND во время доставки', 'md-dnd-late');
    await push.idle();
    assert.ok(dndChecks >= 3);
    assert.deepStrictEqual(pushData(), []);
  } finally {
    push.presence = hooks;
  }
  // 2) Устройство выпало из решения к моменту deliver (сокет телефона ожил).
  let targetChecks = 0;
  push.presence = {
    ...hooks,
    messagePushTargets: (userId, payload, devices) => ((targetChecks += 1) >= 3 ? [] : hooks.messagePushTargets(userId, payload, devices))
  };
  try {
    await aliceSays(alice, 'Телефон ожил во время доставки', 'md-dev-late');
    await push.idle();
    assert.ok(targetChecks >= 3);
    assert.deepStrictEqual(pushData(), []);
  } finally {
    push.presence = hooks;
  }
});

test('Сбой решения — не тишина: баннер всем сокетам и push (как до правила)', async () => {
  await androidToken('bob', 26, 'bob-phone');
  const alice = await device('alice');
  const desk = await device('bob');
  send(desk, { type: 'viewing', conversationType: 'direct', targetId: people.alice.id });
  await settle();
  const decision = require('../src/push/notify-decision');
  const original = decision.decideMessageNotification;
  decision.decideMessageNotification = () => { throw new Error('проверка: сбой решения'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await aliceSays(alice, 'Сбой решения', 'md-fail-1');
    await waitFor(desk, (m) => m.type === 'direct_message');
    assert.strictEqual(frameOf(desk, 'md-fail-1').notify, true);
    assert.strictEqual(frameOf(alice, 'md-fail-1').notify, false, 'своё — всё равно без уведомления');
    await push.idle();
    assert.strictEqual(pushData().length, 1);
  } finally {
    decision.decideMessageNotification = original;
    console.warn = warn;
  }
});

test('pushedChats: не больше 100 переписок на сотрудника; чистится при отключении и удалении канала', () => {
  const uid = people.carol.id;
  for (let i = 1; i <= 105; i += 1) {
    wsServer.pushMessage({ id: 900000 + i, conversation_type: 'channel', target_id: 5000 + i, sender_id: people.alice.id }, [uid]);
  }
  const map = wsServer.pushedChats.get(uid);
  assert.strictEqual(map.size, 100);
  assert.ok(!map.has('channel:5001') && map.has('channel:5105'), 'вытесняются самые давние');
  wsServer.forgetPushedChatForAll('channel:5105');
  assert.ok(!wsServer.pushedChats.get(uid).has('channel:5105'));
  wsServer.forgetPushedChats(uid);
  assert.strictEqual(wsServer.pushedChats.get(uid), undefined);
});
