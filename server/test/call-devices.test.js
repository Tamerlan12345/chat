const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Звонок на сотрудника с несколькими устройствами (задача 20): ответить
// может только одно. Повторный ответ того же сокета ничего не меняет; ответ
// другого сокета того же сотрудника получает call_end «answered_elsewhere»,
// остальные его сокеты перестают звонить. Звук идёт только между сокетами,
// которые позвонили и ответили. Вызовы через push различаются номером
// (offerSeq), а не временем вызова.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let wsServer;
let push;
let UserService;
let AuthService;
const people = {};
const open = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeProvider() {
  const p = { calls: [], reply: () => ({ status: 'ok' }) };
  p.send = async (args) => {
    p.calls.push(JSON.parse(JSON.stringify(args)));
    return p.reply(args);
  };
  return p;
}
let fcm;

test.before(async () => {
  await freshBoot();
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  push = require('../src/push/push.service');
  const app = require('../src/app');
  wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  for (const [username, full_name] of [['calls-alice', 'Алиса Звонкова'], ['calls-bob', 'Боб Звонков']]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username.slice(6)] = { id: created.id, token: await AuthService.generateToken(await UserService.getUserById(created.id)) };
  }
});

test.after(async () => {
  push.reset();
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

test.beforeEach(() => {
  fcm = fakeProvider();
  push.configure({ providers: { fcm, apns: fakeProvider() }, baseDelayMs: 20 });
  require('../src/db').getDatabase().prepare('DELETE FROM push_tokens').run();
  wsServer.pendingOffers.clear();
  wsServer.endedPushOffers?.clear();
});

test.afterEach(async () => {
  await push.idle();
  for (const client of [...open]) await close(client);
  for (let i = 0; i < 100 && (wsServer.isUserOnline(people.alice.id) || wsServer.isUserOnline(people.bob.id)); i += 1) await sleep(10);
});

// Одно устройство — один сокет; у сотрудника их может быть несколько.
async function device(name) {
  const sock = new WebSocket(wsUrl);
  const client = { name, sock, inbox: [], audio: [] };
  sock.on('message', (raw, isBinary) => {
    if (isBinary) client.audio.push(Buffer.from(raw));
    else {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.on('open', resolve));
  sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
  await waitFor(client, (m) => m.type === 'auth_success');
  open.add(client);
  return client;
}

async function close(client) {
  open.delete(client);
  await new Promise((resolve) => {
    if (client.sock.readyState === WebSocket.CLOSED) return resolve();
    client.sock.once('close', resolve);
    client.sock.close();
  });
}

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(10);
  }
  throw new Error(`${client.name}: событие не пришло за отведённое время`);
}

const send = (client, type, to, extra = {}) => client.sock.send(JSON.stringify({ type, targetUserId: people[to].id, ...extra }));
const count = (client, type) => client.inbox.filter((m) => m.type === type).length;

function audioTo(client, to, byte) {
  const frame = Buffer.alloc(8, byte);
  frame.writeUInt32BE(people[to].id, 0);
  client.sock.send(frame, { binary: true });
}

async function ringBobOnTwoDevices() {
  const alice = await device('alice');
  const bobDesk = await device('bob');
  const bobPhone = await device('bob');
  send(alice, 'call_offer', 'bob');
  await waitFor(bobDesk, (m) => m.type === 'call_offer');
  await waitFor(bobPhone, (m) => m.type === 'call_offer');
  return { alice, bobDesk, bobPhone };
}

test('Ответил телефон: остальные устройства получают call_end answered_elsewhere; вызывающему — один call_answer', async () => {
  const { alice, bobDesk, bobPhone } = await ringBobOnTwoDevices();
  send(bobPhone, 'call_answer', 'alice');
  await waitFor(alice, (m) => m.type === 'call_answer');
  const elsewhere = await waitFor(bobDesk, (m) => m.type === 'call_end');
  assert.strictEqual(elsewhere.reason, 'answered_elsewhere');
  assert.strictEqual(elsewhere.senderId, people.alice.id);
  assert.strictEqual(elsewhere.senderName, 'Алиса Звонкова');
  await sleep(80);
  assert.strictEqual(count(bobPhone, 'call_end'), 0, 'ответившему call_end не приходит');
  assert.strictEqual(count(alice, 'call_end'), 0);
});

test('Ответ второго устройства после первого: call_end answered_elsewhere, разговор не перехвачен; повтор ответившего — молча', async () => {
  const { alice, bobDesk, bobPhone } = await ringBobOnTwoDevices();
  send(bobPhone, 'call_answer', 'alice');
  await waitFor(alice, (m) => m.type === 'call_answer');
  await waitFor(bobDesk, (m) => m.type === 'call_end');
  bobDesk.inbox.length = 0;

  send(bobDesk, 'call_answer', 'alice'); // нажали «Принять» на компьютере чуть позже
  const late = await waitFor(bobDesk, (m) => m.type === 'call_end');
  assert.strictEqual(late.reason, 'answered_elsewhere');
  send(bobPhone, 'call_answer', 'alice'); // CallKit и экран приложения ответили оба
  await sleep(100);
  assert.strictEqual(count(alice, 'call_answer'), 1, 'вызывающему ответ не пересылается повторно');
  assert.strictEqual(count(bobPhone, 'call_end'), 0, 'повтор ответившего идемпотентен');
  assert.strictEqual(wsServer.activeCalls.get(people.bob.id), people.alice.id);
});

test('Звук: только между сокетом вызова и ответившим сокетом; другие устройства не слышат и не вещают', async () => {
  const { alice, bobDesk, bobPhone } = await ringBobOnTwoDevices();
  const aliceTablet = await device('alice');
  send(bobPhone, 'call_answer', 'alice');
  await waitFor(alice, (m) => m.type === 'call_answer');

  audioTo(bobDesk, 'alice', 0x11); // не отвечавшее устройство
  audioTo(aliceTablet, 'bob', 0x22); // не звонившее устройство
  await sleep(80);
  assert.strictEqual(alice.audio.length + aliceTablet.audio.length, 0, 'чужой сокет Боба не вещает');
  assert.strictEqual(bobPhone.audio.length + bobDesk.audio.length, 0, 'чужой сокет Алисы не вещает');

  audioTo(bobPhone, 'alice', 0x33);
  audioTo(alice, 'bob', 0x44);
  for (let i = 0; i < 100 && (alice.audio.length < 1 || bobPhone.audio.length < 1); i += 1) await sleep(10);
  assert.strictEqual(alice.audio.length, 1);
  assert.strictEqual(alice.audio[0].readUInt32BE(0), people.bob.id);
  assert.strictEqual(alice.audio[0][4], 0x33);
  assert.strictEqual(aliceTablet.audio.length, 0, 'звук идёт только на сокет вызова');
  assert.strictEqual(bobPhone.audio.length, 1);
  assert.strictEqual(bobPhone.audio[0][4], 0x44);
  assert.strictEqual(bobDesk.audio.length, 0, 'звук идёт только на ответивший сокет');
});

test('Отказ и сброс с другого устройства того же сотрудника не обрывают разговор', async () => {
  const { alice, bobDesk, bobPhone } = await ringBobOnTwoDevices();
  send(bobPhone, 'call_answer', 'alice');
  await waitFor(alice, (m) => m.type === 'call_answer');
  send(bobDesk, 'call_rejected', 'alice');
  send(bobDesk, 'call_end', 'alice');
  send(bobDesk, 'ice_candidate', 'alice', { candidate: { c: 1 } });
  await sleep(100);
  assert.strictEqual(count(alice, 'call_rejected') + count(alice, 'call_end') + count(alice, 'ice_candidate'), 0);
  assert.strictEqual(wsServer.activeCalls.get(people.bob.id), people.alice.id, 'разговор идёт');
  send(bobPhone, 'call_end', 'alice');
  await waitFor(alice, (m) => m.type === 'call_end');
  assert.ok(!wsServer.activeCalls.has(people.bob.id));
});

test('Ответивший сокет отключился (другие устройства на связи) — разговор окончен, собеседнику call_end connection_lost', async () => {
  const { alice, bobDesk, bobPhone } = await ringBobOnTwoDevices();
  send(bobPhone, 'call_answer', 'alice');
  await waitFor(alice, (m) => m.type === 'call_answer');
  await close(bobPhone);
  const end = await waitFor(alice, (m) => m.type === 'call_end');
  assert.strictEqual(end.reason, 'connection_lost');
  assert.strictEqual(end.senderId, people.bob.id);
  assert.ok(!wsServer.activeCalls.has(people.alice.id));
  assert.ok(wsServer.isUserOnline(people.bob.id), bobDesk.name);
});

test('Сокет, с которого звонили, отключился (у звонящего есть другие) — вызов снят, вызываемому call_end connection_lost', async () => {
  const alice = await device('alice');
  await device('alice'); // второе устройство Алисы остаётся на связи
  const bob = await device('bob');
  send(alice, 'call_offer', 'bob');
  await waitFor(bob, (m) => m.type === 'call_offer');
  await close(alice);
  const end = await waitFor(bob, (m) => m.type === 'call_end');
  assert.strictEqual(end.reason, 'connection_lost');
  assert.ok(!wsServer.pendingOffers.has(people.alice.id));
});

test('Устройство, вошедшее во время разговора на другом устройстве, получает call_end answered_elsewhere', async () => {
  const { alice, bobPhone } = await ringBobOnTwoDevices();
  send(bobPhone, 'call_answer', 'alice');
  await waitFor(alice, (m) => m.type === 'call_answer');
  const woken = await device('bob'); // второй телефон, разбуженный тем же push
  const end = await waitFor(woken, (m) => m.type === 'call_end');
  assert.strictEqual(end.reason, 'answered_elsewhere');
  assert.strictEqual(end.senderId, people.alice.id);
  await sleep(50);
  assert.strictEqual(count(bobPhone, 'call_end'), 0);
  assert.strictEqual(count(alice, 'call_end'), 0);
  assert.strictEqual(wsServer.activeCalls.get(people.bob.id), people.alice.id);
});

// ══ offerSeq ═══════════════════════════════════════════════════════════════

test('offerSeq: вызовы той же пары в одну миллисекунду различаются — провал доставки прежнего не снимает новый', async () => {
  await fetch(`${baseUrl}/api/devices/push-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${people.bob.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'android', token: 'fcm-200-ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij:0123456789', environment: 'production' })
  });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let n = 0;
  fcm.reply = () => (++n === 1 ? held : { status: 'ok' });
  const alice = await device('alice');
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen; // оба вызова — в одну и ту же миллисекунду
  try {
    send(alice, 'call_offer', 'bob');
    for (let i = 0; i < 200 && fcm.calls.length < 1; i += 1) await sleep(5);
    send(alice, 'call_end', 'bob');
    await sleep(30);
    send(alice, 'call_offer', 'bob'); // перезвонил
    for (let i = 0; i < 200 && fcm.calls.length < 2; i += 1) await sleep(5);
    assert.strictEqual(fcm.calls.length, 2);
    release({ status: 'failed', reason: 'InternalServerError' });
    await push.idle();
    await sleep(30);
    assert.ok(!alice.inbox.some((m) => m.type === 'call_unavailable'), 'старый провал не сказал «не в сети»');
    assert.ok(wsServer.pendingOffers.has(people.alice.id), 'новый вызов ждёт');
  } finally {
    Date.now = realNow;
  }
});

test('offerSeq растёт монотонно с каждым вызовом', async () => {
  const alice = await device('alice');
  const bob = await device('bob');
  send(alice, 'call_offer', 'bob');
  await waitFor(bob, (m) => m.type === 'call_offer');
  const a = wsServer.pendingOffers.get(people.alice.id).seq;
  send(alice, 'call_end', 'bob');
  await waitFor(bob, (m) => m.type === 'call_end');
  send(alice, 'call_offer', 'bob');
  for (let i = 0; i < 100 && !wsServer.pendingOffers.has(people.alice.id); i += 1) await sleep(10);
  const b = wsServer.pendingOffers.get(people.alice.id).seq;
  assert.ok(b > a, `${b} > ${a}`);
});
