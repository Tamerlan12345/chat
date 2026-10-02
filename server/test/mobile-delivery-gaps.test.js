const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');
const { freshBoot, closeAll, DATA_DIR } = require('./helpers/boot');

// Серверные пробелы доставки, которые описал контракт mobile/contracts/
// delivery-state.md §10 (задача 16 плана мобильного релиза). Всё — дополнение:
// кадры и поля, которые уже читает настольный клиент (error.message/text,
// message_deleted.messageId…), остаются как были.
//
//   G1 — кадры одного сокета обрабатываются по очереди (порядок сохранения =
//        порядок отправки), другие сокеты не ждут; очередь ограничена.
//   G2 — кадр, отброшенный пределом частоты, получает error RATE_LIMITED.
//   G3 — у каждого отказа send_message есть code и retryable; сбой после
//        записи возвращает сохранённое сообщение, а не ошибку.
//   G4 — ошибки edit_message/delete_message несут messageId и code; удаление
//        уже удалённого — успех (надгробие), а не ошибка.
//   G7 — last_message_id в GET /api/channels.
//   G8 — updated_at в message_deleted.
//   G9 — cancel_message {client_msg_id}: отзыв отправки по ключу.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let chat;
let wsServer;
let UserService;
let AuthService;
let MessageService;
let SettingsService;
const people = {};
const sockets = {};

test.before(async () => {
  const booted = await freshBoot();
  chat = booted.chat;
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  MessageService = require('../src/services/message.service');
  SettingsService = require('../src/services/settings.service');
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
  const team = MessageService.createChannel('Команда', '', 'public', people.alice.id);
  people.teamId = Number(team.id);
  const empty = MessageService.createChannel('Пустой', '', 'public', people.alice.id);
  people.emptyId = Number(empty.id);
  const secret = MessageService.createChannel('Тайный', '', 'private', people.carol.id);
  people.secretId = Number(secret.id);
  chat.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(people.teamId, people.bob.id, 'member', new Date().toISOString());
  await SettingsService.setSetting('message_edit_window_minutes', '60');
  await SettingsService.setSetting('message_delete_window_minutes', '60');
});

test.after(async () => {
  for (const s of Object.values(sockets)) {
    try { s.sock.close(); } catch {}
  }
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

// Каждый тест сам ставит заглушки; здесь они гарантированно снимаются.
const restore = [];
test.afterEach(async () => {
  while (restore.length) restore.pop()();
  delete process.env.WS_MAX_QUEUED_FRAMES;
  delete process.env.WS_FRAME_TIMEOUT_MS;
  delete process.env.CANCELLED_KEYS_PER_SENDER;
  await SettingsService.setSetting('message_edit_window_minutes', '60');
  await SettingsService.setSetting('message_delete_window_minutes', '60');
});

function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl(original);
  restore.push(() => { obj[name] = original; });
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function connect(name) {
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
  sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
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

const send = (name, payload) => sockets[name].sock.send(JSON.stringify(payload));
const row = (where, ...params) => chat.prepare(`SELECT * FROM messages WHERE ${where}`).get(...params);
const countRows = (where, ...params) => Number(chat.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...params).n);
const historyRows = (id) => Number(chat.prepare('SELECT COUNT(*) AS n FROM message_history WHERE message_id = ?').get(id).n);
const echoOf = (name, key) => waitFor(sockets[name], (m) => (m.type === 'direct_message' || m.type === 'channel_message') && m.message?.client_msg_id === key);
const errorFor = (name, pred) => waitFor(sockets[name], (m) => m.type === 'error' && pred(m));
let keySeq = 0;
const freshKey = (tag) => `${tag}-${Date.now().toString(36)}-${(keySeq += 1)}`;

// Задержка/зависание проверки получателя личного сообщения — единственный
// await перед записью у личной отправки. Канальная отправка его не делает.
function delayRecipientLookup(ms) {
  stub(UserService, 'getUserById', (orig) => async (id) => {
    if (Number(id) === people.bob.id) await sleep(ms);
    return orig.call(UserService, id);
  });
}

function holdRecipientLookup() {
  const g = gate();
  stub(UserService, 'getUserById', (orig) => async (id) => {
    if (Number(id) === people.bob.id) await g.promise;
    return orig.call(UserService, id);
  });
  return g;
}

async function storeDirect(name, key, text = 'Сообщение') {
  send(name, { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text, client_msg_id: key });
  return (await echoOf(name, key)).message;
}

// ══ G1. Кадры одного сокета — по очереди ══════════════════════════════════

test('G1: два быстрых send_message одного сокета сохраняются в порядке отправки (id по возрастанию)', async () => {
  await connect('alice');
  delayRecipientLookup(80); // первый кадр «медленный», второй (канал) — без ожидания
  const k1 = freshKey('g1-first');
  const k2 = freshKey('g1-second');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Первое', client_msg_id: k1 });
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Второе', client_msg_id: k2 });
  const first = await echoOf('alice', k1);
  const second = await echoOf('alice', k2);
  assert.ok(first.message.id < second.message.id, `порядок сохранения ${first.message.id} > ${second.message.id}`);
});

test('G1: медленный кадр одного сокета не задерживает другие сокеты и кадры вне очереди', async () => {
  await connect('alice');
  await connect('bob');
  const held = holdRecipientLookup();
  const slow = freshKey('g1-slow');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Жду', client_msg_id: slow });
  await sleep(30);
  const fast = freshKey('g1-other-socket');
  send('bob', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Другой сокет', client_msg_id: fast });
  await echoOf('bob', fast);
  // «печатает…» не стоит в очереди сообщений: доходит, пока отправка ждёт.
  send('alice', { type: 'typing', conversationType: 'direct', targetId: people.bob.id, isTyping: true });
  await waitFor(sockets.bob, (m) => m.type === 'user_typing' && m.userId === people.alice.id);
  assert.ok(!sockets.alice.inbox.some((m) => m.message?.client_msg_id === slow), 'отправка ещё ждёт');
  held.open();
  await echoOf('alice', slow);
});

test('G1: очередь сокета ограничена — лишние кадры получают RATE_LIMITED, а не копятся в памяти', async () => {
  process.env.WS_MAX_QUEUED_FRAMES = '2';
  await connect('alice');
  const held = holdRecipientLookup();
  const keys = [1, 2, 3, 4].map((i) => freshKey(`g1-q${i}`));
  for (const key of keys) {
    send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: key, client_msg_id: key });
  }
  for (const key of keys.slice(2)) {
    const err = await errorFor('alice', (m) => m.client_msg_id === key);
    assert.strictEqual(err.context, 'send_message');
    assert.strictEqual(err.code, 'RATE_LIMITED');
    assert.strictEqual(err.retryable, true);
    assert.ok(Number.isInteger(err.retry_after_ms) && err.retry_after_ms > 0, 'retry_after_ms');
    assert.ok(typeof err.message === 'string' && err.message.length > 0, 'message для настольного клиента');
  }
  const lane = [...wsServer.userSockets.get(people.alice.id)][0].lane;
  assert.ok(lane.pending <= 2, `в очереди ${lane.pending} кадров`);
  held.open();
  const a = await echoOf('alice', keys[0]);
  const b = await echoOf('alice', keys[1]);
  assert.ok(a.message.id < b.message.id);
  assert.strictEqual(countRows('client_msg_id IN (?, ?)', keys[2], keys[3]), 0, 'отброшенные кадры не сохранены');
});

test('G1: зависший обработчик не останавливает очередь сокета навсегда', async () => {
  process.env.WS_FRAME_TIMEOUT_MS = '200';
  await connect('alice');
  const held = holdRecipientLookup();
  const stuck = freshKey('g1-stuck');
  const next = freshKey('g1-next');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Зависло', client_msg_id: stuck });
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Следующее', client_msg_id: next });
  await echoOf('alice', next);
  held.open();
  await echoOf('alice', stuck);
});

// ══ G2. Предел частоты — ответом, а не молчанием ══════════════════════════

test('G2: поток send_message с одного сокета — 10 сохранено, отброшенным RATE_LIMITED с client_msg_id; соседний сокет не страдает', async () => {
  await connect('alice');
  await connect('bob');
  const keys = Array.from({ length: 40 }, (_, i) => freshKey(`g2-flood${i}`));
  for (const key of keys) {
    send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: key, client_msg_id: key });
  }
  const probe = freshKey('g2-bob');
  send('bob', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Боб пишет', client_msg_id: probe });
  await echoOf('bob', probe);
  await echoOf('alice', keys[9]);
  await sleep(200);
  const stored = keys.filter((k) => countRows('client_msg_id = ?', k) === 1);
  assert.deepStrictEqual(stored, keys.slice(0, 10), 'сохранены ровно первые 10, по порядку');
  const limited = sockets.alice.inbox.filter((m) => m.type === 'error' && m.code === 'RATE_LIMITED');
  assert.ok(limited.length >= 1, 'хотя бы один ответ RATE_LIMITED');
  assert.ok(limited.length <= 10, `ответов ${limited.length}: сервер не отвечает на каждый кадр потока`);
  for (const err of limited) {
    assert.strictEqual(err.context, 'send_message');
    assert.ok(keys.slice(10).includes(err.client_msg_id), 'ответ — только на отброшенный кадр');
    assert.strictEqual(err.retryable, true);
    assert.ok(err.retry_after_ms > 0 && err.retry_after_ms <= 1000, `retry_after_ms ${err.retry_after_ms}`);
  }
  await sleep(1000);
  const after = freshKey('g2-after');
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'После паузы', client_msg_id: after });
  await echoOf('alice', after);
});

test('G2: поток delete_message — RATE_LIMITED с messageId; поток typing — молча, как раньше', async () => {
  await connect('alice');
  await connect('bob');
  const msg = await storeDirect('alice', freshKey('g2-del'));
  for (let i = 0; i < 12; i += 1) send('alice', { type: 'delete_message', messageId: 999000 + i });
  const err = await errorFor('alice', (m) => m.code === 'RATE_LIMITED');
  assert.strictEqual(err.context, 'delete_message');
  assert.ok(err.messageId >= 999010, 'messageId отброшенного кадра');
  for (let i = 0; i < 20; i += 1) send('alice', { type: 'typing', conversationType: 'direct', targetId: people.bob.id, isTyping: true });
  await sleep(200);
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'error' && m.context === 'typing'), 'typing без ответа');
  assert.ok(msg.id > 0);
});

// ══ G3. code и retryable у каждого отказа send_message ═══════════════════

test('G3: отказы send_message несут машинный code и retryable=false; message и text — как раньше', async () => {
  await connect('alice');
  const cases = [
    [{ conversationType: 'direct', targetId: 999999, text: 'Никому' }, 'RECIPIENT_NOT_FOUND', 'Получатель не найден'],
    [{ conversationType: 'direct', targetId: people.bob.id, text: '   ' }, 'EMPTY_TEXT', 'Пустое сообщение не отправляется'],
    [{ conversationType: 'direct', targetId: people.bob.id, text: 'x'.repeat(16001) }, 'TEXT_TOO_LONG', null],
    [{ conversationType: 'channel', targetId: people.secretId, text: 'Чужой канал' }, 'NOT_CHANNEL_MEMBER', 'Вы не участник этого канала'],
    [{ conversationType: 'direct', targetId: people.bob.id, text: 'Тип', msgType: 'system' }, 'INVALID_MESSAGE_TYPE', 'Недопустимый тип сообщения'],
    [{ conversationType: 'direct', targetId: people.bob.id, text: 'Файл', msgType: 'file', metadata: { file_id: 987654 } }, 'ATTACHMENT_NOT_ACCESSIBLE', null]
  ];
  for (const [frame, code, message] of cases) {
    const key = freshKey(`g3-${code}`);
    send('alice', { type: 'send_message', ...frame, client_msg_id: key });
    const err = await errorFor('alice', (m) => m.client_msg_id === key);
    assert.strictEqual(err.context, 'send_message', code);
    assert.strictEqual(err.code, code);
    assert.strictEqual(err.retryable, false, code);
    if (message) assert.strictEqual(err.message, message);
    assert.strictEqual(err.text, frame.text, 'text возвращается для поля ввода');
    assert.strictEqual(countRows('client_msg_id = ?', key), 0);
  }
});

test('G3: ключ в другую переписку — CLIENT_MSG_ID_CONFLICT, retryable=false', async () => {
  await connect('alice');
  const key = freshKey('g3-conflict');
  await storeDirect('alice', key);
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Тот же ключ', client_msg_id: key });
  const err = await errorFor('alice', (m) => m.client_msg_id === key);
  assert.strictEqual(err.code, 'CLIENT_MSG_ID_CONFLICT');
  assert.strictEqual(err.retryable, false);
});

test('G3: внутренний сбой до записи — INTERNAL_ERROR, retryable=true, подробности не утекают', async () => {
  await connect('alice');
  stub(UserService, 'getUserById', (orig) => async (id) => {
    if (Number(id) === people.bob.id) throw new Error('SQLITE_BUSY: database is locked (секрет устройства)');
    return orig.call(UserService, id);
  });
  const key = freshKey('g3-internal');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Повторю', client_msg_id: key });
  const err = await errorFor('alice', (m) => m.client_msg_id === key);
  assert.strictEqual(err.code, 'INTERNAL_ERROR');
  assert.strictEqual(err.retryable, true);
  assert.ok(!/SQLITE|секрет/.test(err.message), err.message);
  assert.strictEqual(countRows('client_msg_id = ?', key), 0);
});

test('G3: сбой ПОСЛЕ записи — автору эхо сохранённой записи, а не ошибка; повтор отдаёт ту же запись', async () => {
  await connect('alice');
  stub(UserService, 'getDirectory', () => async () => { throw new Error('identity store unavailable'); });
  const key = freshKey('g3-after-insert');
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Сохранено', client_msg_id: key });
  const echo = await echoOf('alice', key);
  assert.strictEqual(echo.message.sender_name, 'Алиса Тестова', 'отправитель известен из сокета');
  assert.strictEqual(echo.message.text, 'Сохранено');
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'error' && m.client_msg_id === key), 'ошибки нет');
  restore.pop()();
  sockets.alice.inbox.length = 0;
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Сохранено', client_msg_id: key });
  const again = await echoOf('alice', key);
  assert.strictEqual(again.message.id, echo.message.id);
});

test('G3 REST: отказ с code (400/403), внутренний сбой — 503 INTERNAL_ERROR', async () => {
  const empty = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: ' ', client_msg_id: freshKey('g3r') } });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.json.code, 'EMPTY_TEXT');
  const member = await api('POST', `/api/messages/channels/${people.secretId}`, { token: people.alice.token, body: { text: 'Нет' } });
  assert.strictEqual(member.status, 403);
  assert.strictEqual(member.json.code, 'NOT_CHANNEL_MEMBER');
  stub(UserService, 'getUserById', (orig) => async (id) => {
    if (Number(id) === people.bob.id) throw new Error('connection refused 10.0.0.5:5432');
    return orig.call(UserService, id);
  });
  const internal = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'Позже', client_msg_id: freshKey('g3r') } });
  assert.strictEqual(internal.status, 503);
  assert.strictEqual(internal.json.code, 'INTERNAL_ERROR');
  assert.ok(!internal.text.includes('10.0.0.5'));
});

// ══ G4. Правка и удаление: messageId, code, идемпотентное удаление ════════

test('G4: ошибки edit_message несут messageId и code', async () => {
  await connect('alice');
  await connect('bob');
  const bobs = await storeDirect('bob', freshKey('g4-bob'), 'Сообщение Боба');
  send('alice', { type: 'edit_message', messageId: bobs.id, text: 'Чужое' });
  let err = await errorFor('alice', (m) => m.context === 'edit_message' && m.messageId === bobs.id);
  assert.strictEqual(err.code, 'NOT_OWNER');
  assert.strictEqual(err.retryable, false);
  assert.strictEqual(err.message, 'Нельзя редактировать чужое сообщение');

  send('alice', { type: 'edit_message', messageId: 987654321, text: 'Нет такого' });
  err = await errorFor('alice', (m) => m.context === 'edit_message' && m.messageId === 987654321);
  assert.strictEqual(err.code, 'NOT_FOUND');

  const old = await storeDirect('alice', freshKey('g4-old'));
  chat.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 3600 * 1000).toISOString(), old.id);
  send('alice', { type: 'edit_message', messageId: old.id, text: 'Поздно' });
  err = await errorFor('alice', (m) => m.context === 'edit_message' && m.messageId === old.id);
  assert.strictEqual(err.code, 'EDIT_WINDOW_EXPIRED');

  send('alice', { type: 'delete_message', messageId: old.id });
  err = await errorFor('alice', (m) => m.context === 'delete_message' && m.messageId === old.id);
  assert.strictEqual(err.code, 'DELETE_WINDOW_EXPIRED');
  assert.strictEqual(err.retryable, false);

  send('alice', { type: 'delete_message', messageId: bobs.id });
  err = await errorFor('alice', (m) => m.context === 'delete_message' && m.messageId === bobs.id);
  assert.strictEqual(err.code, 'NOT_OWNER');

  const fresh = await storeDirect('alice', freshKey('g4-empty'));
  send('alice', { type: 'edit_message', messageId: fresh.id, text: '  ' });
  err = await errorFor('alice', (m) => m.context === 'edit_message' && m.messageId === fresh.id);
  assert.strictEqual(err.code, 'EMPTY_TEXT');
});

test('G4: удаление уже удалённого — надгробие автору (idempotent), без новой истории, сдвига и рассылки', async () => {
  await connect('alice');
  await connect('bob');
  const msg = await storeDirect('alice', freshKey('g4-twice'));
  send('alice', { type: 'delete_message', messageId: msg.id });
  const first = await waitFor(sockets.alice, (m) => m.type === 'message_deleted' && m.messageId === msg.id);
  await waitFor(sockets.bob, (m) => m.type === 'message_deleted' && m.messageId === msg.id);
  const seqBefore = row('id = ?', msg.id).change_seq;
  const historyBefore = historyRows(msg.id);
  sockets.alice.inbox.length = 0;
  sockets.bob.inbox.length = 0;

  send('alice', { type: 'delete_message', messageId: msg.id });
  const again = await waitFor(sockets.alice, (m) => m.type === 'message_deleted' && m.messageId === msg.id);
  assert.strictEqual(again.updated_at, first.updated_at, 'то же надгробие');
  await sleep(150);
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'error'), 'не ошибка');
  assert.ok(!sockets.bob.inbox.some((m) => m.type === 'message_deleted'), 'собеседнику повторно не рассылается');
  assert.strictEqual(row('id = ?', msg.id).change_seq, seqBefore, 'change_seq не сдвигается');
  assert.strictEqual(historyRows(msg.id), historyBefore, 'история не растёт');
});

test('G4: удалённое чужое сообщение — NOT_OWNER, надгробие постороннему не отдаётся', async () => {
  await connect('alice');
  await connect('carol');
  const msg = await storeDirect('alice', freshKey('g4-foreign'));
  send('alice', { type: 'delete_message', messageId: msg.id });
  await waitFor(sockets.alice, (m) => m.type === 'message_deleted' && m.messageId === msg.id);
  send('carol', { type: 'delete_message', messageId: msg.id });
  const err = await errorFor('carol', (m) => m.context === 'delete_message' && m.messageId === msg.id);
  assert.strictEqual(err.code, 'NOT_OWNER');
  assert.ok(!sockets.carol.inbox.some((m) => m.type === 'message_deleted'));
});

// ══ G7. last_message_id в списке каналов ═════════════════════════════════

test('G7: GET /api/channels — last_message_id последнего сообщения канала (null без сообщений)', async () => {
  await connect('alice');
  const key = freshKey('g7');
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Последнее', client_msg_id: key });
  const echo = await echoOf('alice', key);
  const res = await api('GET', '/api/channels', { token: people.alice.token });
  assert.strictEqual(res.status, 200);
  const team = res.json.find((c) => c.id === people.teamId);
  assert.strictEqual(team.last_message_id, echo.message.id);
  const empty = res.json.find((c) => c.id === people.emptyId);
  assert.ok('last_message_id' in empty);
  assert.strictEqual(empty.last_message_id, null);
});

// ══ G8. updated_at в message_deleted ═════════════════════════════════════

test('G8: message_deleted несёт updated_at надгробия', async () => {
  await connect('alice');
  await connect('bob');
  const msg = await storeDirect('alice', freshKey('g8'));
  send('alice', { type: 'delete_message', messageId: msg.id });
  const frame = await waitFor(sockets.bob, (m) => m.type === 'message_deleted' && m.messageId === msg.id);
  assert.strictEqual(frame.updated_at, row('id = ?', msg.id).updated_at);
  assert.ok(!Number.isNaN(Date.parse(frame.updated_at)));
});

// ══ G9. cancel_message ═══════════════════════════════════════════════════

test('G9: отмена до отправки — message_cancelled без messageId; затем отправка с ключом отклоняется CANCELLED (WS и REST)', async () => {
  await connect('alice');
  const key = freshKey('g9-before');
  send('alice', { type: 'cancel_message', client_msg_id: key });
  const ack = await waitFor(sockets.alice, (m) => m.type === 'message_cancelled' && m.client_msg_id === key);
  assert.strictEqual(ack.messageId, null);
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Поздно', client_msg_id: key });
  const err = await errorFor('alice', (m) => m.client_msg_id === key);
  assert.strictEqual(err.code, 'CANCELLED');
  assert.strictEqual(err.retryable, false);
  const rest = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'Поздно', client_msg_id: key } });
  assert.strictEqual(rest.status, 409);
  assert.strictEqual(rest.json.code, 'CANCELLED');
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ?', people.alice.id, key), 0);
});

test('G9: отмена сохранённого — удаление, message_deleted участникам и message_cancelled с messageId; повтор отмены идемпотентен', async () => {
  await connect('alice');
  await connect('bob');
  const key = freshKey('g9-stored');
  const msg = await storeDirect('alice', key);
  send('alice', { type: 'cancel_message', client_msg_id: key });
  const ack = await waitFor(sockets.alice, (m) => m.type === 'message_cancelled' && m.client_msg_id === key);
  assert.strictEqual(ack.messageId, msg.id);
  const del = await waitFor(sockets.bob, (m) => m.type === 'message_deleted' && m.messageId === msg.id);
  assert.ok(del.updated_at);
  assert.strictEqual(row('id = ?', msg.id).is_deleted, 1);
  const history = historyRows(msg.id);
  sockets.alice.inbox.length = 0;
  sockets.bob.inbox.length = 0;

  send('alice', { type: 'cancel_message', client_msg_id: key });
  const again = await waitFor(sockets.alice, (m) => m.type === 'message_cancelled' && m.client_msg_id === key);
  assert.strictEqual(again.messageId, msg.id);
  await sleep(150);
  assert.ok(!sockets.bob.inbox.some((m) => m.type === 'message_deleted'), 'повторной рассылки нет');
  assert.strictEqual(historyRows(msg.id), history);

  // Повтор отправки уже сохранённого ключа — по-прежнему эхо записи (надгробие).
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Сообщение', client_msg_id: key });
  const echo = await echoOf('alice', key);
  assert.strictEqual(echo.message.is_deleted, 1);
});

test('G9: отмена чужого ключа ничего не делает с чужим сообщением', async () => {
  await connect('alice');
  await connect('bob');
  const key = freshKey('g9-foreign');
  send('bob', { type: 'send_message', conversationType: 'direct', targetId: people.alice.id, text: 'Боб', client_msg_id: key });
  const bobs = (await echoOf('bob', key)).message;
  send('alice', { type: 'cancel_message', client_msg_id: key });
  const ack = await waitFor(sockets.alice, (m) => m.type === 'message_cancelled' && m.client_msg_id === key);
  assert.strictEqual(ack.messageId, null);
  assert.strictEqual(row('id = ?', bobs.id).is_deleted, 0, 'сообщение Боба на месте');
  sockets.bob.inbox.length = 0;
  send('bob', { type: 'send_message', conversationType: 'direct', targetId: people.alice.id, text: 'Боб', client_msg_id: key });
  const echo = await echoOf('bob', key);
  assert.strictEqual(echo.message.id, bobs.id, 'ключ Боба не отменён');
});

test('G9: отмена, когда удалять уже нельзя — ошибка cancel_message с messageId и code', async () => {
  await connect('alice');
  const key = freshKey('g9-window');
  const msg = await storeDirect('alice', key);
  await SettingsService.setSetting('message_delete_window_minutes', '-1');
  send('alice', { type: 'cancel_message', client_msg_id: key });
  const err = await errorFor('alice', (m) => m.context === 'cancel_message' && m.client_msg_id === key);
  assert.strictEqual(err.code, 'DELETE_WINDOW_EXPIRED');
  assert.strictEqual(err.messageId, msg.id);
  assert.strictEqual(err.retryable, false);
  assert.strictEqual(row('id = ?', msg.id).is_deleted, 0);
});

test('G9: недопустимый ключ — INVALID_CLIENT_MSG_ID без отражения значения', async () => {
  await connect('alice');
  send('alice', { type: 'cancel_message', client_msg_id: 'не годится' });
  const err = await errorFor('alice', (m) => m.context === 'cancel_message');
  assert.strictEqual(err.code, 'INVALID_CLIENT_MSG_ID');
  assert.ok(!('client_msg_id' in err));
});

test('G9: отменённые ключи — в базе (переживают перезапуск), со сроком и пределом на отправителя', async () => {
  await connect('alice');
  const key = freshKey('g9-persist');
  send('alice', { type: 'cancel_message', client_msg_id: key });
  await waitFor(sockets.alice, (m) => m.type === 'message_cancelled' && m.client_msg_id === key);
  // Отдельное соединение с файлом базы — как процесс после перезапуска.
  const other = new DatabaseSync(path.join(DATA_DIR, 'mychat.db'));
  try {
    const saved = other.prepare('SELECT * FROM cancelled_client_msgs WHERE sender_id = ? AND client_msg_id = ?').get(people.alice.id, key);
    assert.ok(saved, 'ключ сохранён в SQLite');
  } finally {
    other.close();
  }

  // Срок: ключ, отменённый больше суток назад, отправку уже не блокирует.
  const stale = freshKey('g9-stale');
  chat.prepare('INSERT INTO cancelled_client_msgs (sender_id, client_msg_id, cancelled_at) VALUES (?, ?, ?)')
    .run(people.alice.id, stale, Date.now() - 25 * 3600 * 1000);
  await storeDirect('alice', stale);

  // Предел: не больше N ключей на отправителя (старые вытесняются).
  process.env.CANCELLED_KEYS_PER_SENDER = '3';
  await connect('carol');
  const keys = Array.from({ length: 5 }, (_, i) => freshKey(`g9-bound${i}`));
  for (const k of keys) {
    send('carol', { type: 'cancel_message', client_msg_id: k });
    await waitFor(sockets.carol, (m) => m.type === 'message_cancelled' && m.client_msg_id === k);
  }
  const left = chat.prepare('SELECT client_msg_id FROM cancelled_client_msgs WHERE sender_id = ? ORDER BY cancelled_at, rowid').all(people.carol.id).map((r) => r.client_msg_id);
  assert.deepStrictEqual(left, keys.slice(2), 'остаются три последних');
});

test('G9: отмена и отправка того же ключа одновременно по разным путям — сообщение не остаётся', async () => {
  await connect('alice');
  delayRecipientLookup(150); // REST-отправка ждёт проверку получателя
  const key = freshKey('g9-race');
  const pending = api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'Гонка', client_msg_id: key } });
  await sleep(40);
  send('alice', { type: 'cancel_message', client_msg_id: key });
  await waitFor(sockets.alice, (m) => m.type === 'message_cancelled' && m.client_msg_id === key);
  const res = await pending;
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.code, 'CANCELLED');
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ? AND is_deleted = 0', people.alice.id, key), 0);
});

test('G9: поток cancel_message ограничен как delete_message — RATE_LIMITED с client_msg_id', async () => {
  await connect('alice');
  const keys = Array.from({ length: 12 }, (_, i) => freshKey(`g9-flood${i}`));
  for (const k of keys) send('alice', { type: 'cancel_message', client_msg_id: k });
  const err = await errorFor('alice', (m) => m.code === 'RATE_LIMITED');
  assert.strictEqual(err.context, 'cancel_message');
  assert.ok(keys.slice(10).includes(err.client_msg_id));
});

// ══ Задача 18: замечания ревью задачи 16 ═══════════════════════════════════

test('Т18: таймаут обработчика — только у кадров очереди; кадр вне очереди таймера не получает', async () => {
  process.env.WS_FRAME_TIMEOUT_MS = '60';
  await connect('alice');
  const warnings = [];
  stub(console, 'warn', (orig) => (...args) => { warnings.push(args.map(String).join(' ')); return orig.apply(console, args); });
  const held = gate();
  stub(UserService, 'updateStatus', (orig) => async (...args) => { await held.promise; return orig.apply(UserService, args); });
  // presence идёт мимо очереди: его медленный обработчик не должен заводить таймер очереди.
  send('alice', { type: 'presence', state: 'away' });
  await sleep(200);
  held.open();
  await sleep(30);
  assert.ok(!warnings.some((w) => w.includes('обрабатывается дольше')), `предупреждение о таймауте вне очереди: ${warnings.join(' | ')}`);

  // Кадр очереди по-прежнему ограничен таймаутом.
  const stuck = holdRecipientLookup();
  const key = freshKey('t18-timeout');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Жду', client_msg_id: key });
  await sleep(200);
  assert.ok(warnings.some((w) => w.includes('send_message обрабатывается дольше')), 'таймаут кадра очереди');
  stuck.open();
  await echoOf('alice', key);
});

test('Т18: запись истории правки — текст на момент записи, а не до ожидания настройки', async () => {
  const msg = await MessageService.sendMessageIdempotent({ conversationType: 'direct', targetId: people.bob.id, senderId: people.alice.id, text: 'Версия 0' });
  const held = gate();
  let first = true;
  stub(SettingsService, 'getSetting', (orig) => async (...args) => {
    if (first && args[0] === 'message_edit_window_minutes') { first = false; await held.promise; }
    return orig.apply(SettingsService, args);
  });
  const slow = MessageService.editMessage({ messageId: msg.message.id, actorId: people.alice.id, text: 'Версия 1' });
  await sleep(20);
  await MessageService.editMessage({ messageId: msg.message.id, actorId: people.alice.id, text: 'Версия 2' });
  held.open();
  await slow;
  const history = chat.prepare('SELECT old_text FROM message_history WHERE message_id = ? ORDER BY id').all(msg.message.id).map((r) => r.old_text);
  assert.deepStrictEqual(history, ['Версия 0', 'Версия 2'], 'вторая запись — текст, который правка заменила на самом деле');
  assert.strictEqual(row('id = ?', msg.message.id).text, 'Версия 1');
});

test('Т18: запись истории удаления — текст на момент удаления (правка во время ожидания не теряется)', async () => {
  const msg = await MessageService.sendMessageIdempotent({ conversationType: 'direct', targetId: people.bob.id, senderId: people.alice.id, text: 'До правки' });
  const held = gate();
  stub(SettingsService, 'getSetting', (orig) => async (...args) => {
    if (args[0] === 'message_delete_window_minutes') await held.promise;
    return orig.apply(SettingsService, args);
  });
  const deleting = MessageService.deleteMessage({ messageId: msg.message.id, actorId: people.alice.id });
  await sleep(20);
  await MessageService.editMessage({ messageId: msg.message.id, actorId: people.alice.id, text: 'После правки' });
  held.open();
  await deleting;
  const history = chat.prepare('SELECT action, old_text FROM message_history WHERE message_id = ? ORDER BY id').all(msg.message.id)
    .map((r) => `${r.action}:${r.old_text}`);
  assert.deepStrictEqual(history, ['edit:До правки', 'delete:После правки']);
});

test('Т18: необработанный сбой обработчика — INTERNAL_ERROR с корреляцией для кадров с ответом, общий error для прочих; текст сбоя не утекает', async () => {
  await connect('alice');
  stub(wsServer, 'handleMessage', (orig) => async function (ws, msg, ...rest) {
    if (msg.type === 'send_message' || msg.type === 'typing') throw new Error('SQLITE_CORRUPT секрет');
    return orig.call(this, ws, msg, ...rest);
  });
  const key = freshKey('t18-crash');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Упало', client_msg_id: key });
  const err = await errorFor('alice', (m) => m.client_msg_id === key);
  assert.strictEqual(err.context, 'send_message');
  assert.strictEqual(err.code, 'INTERNAL_ERROR');
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.text, 'Упало');
  assert.ok(!/SQLITE|секрет/.test(JSON.stringify(err)));
  sockets.alice.inbox.length = 0;
  send('alice', { type: 'typing', conversationType: 'direct', targetId: people.bob.id, isTyping: true });
  const generic = await errorFor('alice', () => true);
  assert.deepStrictEqual(generic, { type: 'error', message: 'Ошибка обработки запроса' });
});

test('Т18: сбой рассылки после записи (WS) — автору эхо двумя кадрами, без ошибки', async () => {
  await connect('alice');
  await connect('bob');
  stub(wsServer, 'publishNewMessage', () => () => { throw new Error('рассылка упала'); });
  const key = freshKey('t18-publish');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Сохранено', client_msg_id: key });
  const echo = await echoOf('alice', key);
  await waitFor(sockets.alice, (m) => m.type === 'new_message' && m.message?.client_msg_id === key);
  assert.strictEqual(echo.type, 'direct_message');
  assert.strictEqual(row('id = ?', echo.message.id).text, 'Сохранено');
  await sleep(100);
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'error'), 'ошибки нет');
  assert.ok(!sockets.bob.inbox.some((m) => m.message?.client_msg_id === key), 'получателю эхо автора не уходит');
});

test('Т18: кадры очереди отозванного сокета теряются; обычное закрытие — обрабатываются от имени автора', async () => {
  // Отзыв (revokeSocket): ждущие кадры не обрабатываются.
  await connect('alice');
  let held = holdRecipientLookup();
  const k1 = freshKey('t18-revoked-head');
  const k2 = freshKey('t18-revoked-queued');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Первое', client_msg_id: k1 });
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'В очереди', client_msg_id: k2 });
  await sleep(40);
  wsServer.revokeSocket([...wsServer.userSockets.get(people.alice.id)][0], 'Тест');
  held.open();
  await sleep(150);
  assert.strictEqual(countRows('client_msg_id = ?', k2), 0, 'кадр в очереди отозванного сокета не сохранён');
  delete sockets.alice;
  restore.pop()();

  // Обычное закрытие: всё, что пришло до закрытия, сохраняется.
  await connect('alice');
  held = holdRecipientLookup();
  const k3 = freshKey('t18-closed-head');
  const k4 = freshKey('t18-closed-queued');
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Перед закрытием', client_msg_id: k3 });
  send('alice', { type: 'send_message', conversationType: 'channel', targetId: people.teamId, text: 'Тоже до закрытия', client_msg_id: k4 });
  await sleep(40);
  await disconnect('alice');
  held.open();
  for (let i = 0; i < 50 && countRows('client_msg_id IN (?, ?)', k3, k4) < 2; i += 1) await sleep(20);
  assert.strictEqual(countRows('client_msg_id IN (?, ?) AND sender_id = ?', k3, k4, people.alice.id), 2);
});

test('Т18: граница предела отменённых ключей — ровно N остаются и блокируют отправку, N+1-й вытесняет самый старый', async () => {
  process.env.CANCELLED_KEYS_PER_SENDER = '3';
  const sender = people.bob.id;
  const kept = () => chat.prepare('SELECT client_msg_id FROM cancelled_client_msgs WHERE sender_id = ? ORDER BY cancelled_at, rowid').all(sender).map((r) => r.client_msg_id);
  chat.prepare('DELETE FROM cancelled_client_msgs WHERE sender_id = ?').run(sender);
  const keys = Array.from({ length: 4 }, (_, i) => freshKey(`t18-cap${i}`));
  for (const k of keys.slice(0, 3)) await MessageService.cancelClientMessage({ senderId: sender, clientMsgId: k });
  assert.deepStrictEqual(kept(), keys.slice(0, 3), 'ровно N — никто не вытеснен');
  for (const k of keys.slice(0, 3)) {
    await assert.rejects(
      MessageService.sendMessageIdempotent({ conversationType: 'channel', targetId: people.teamId, senderId: sender, text: 'x', clientMsgId: k }),
      (err) => err.code === 'CANCELLED'
    );
  }
  await MessageService.cancelClientMessage({ senderId: sender, clientMsgId: keys[3] });
  assert.deepStrictEqual(kept(), keys.slice(1), 'вытеснен ровно один — самый старый');
  const revived = await MessageService.sendMessageIdempotent({ conversationType: 'channel', targetId: people.teamId, senderId: sender, text: 'снова можно', clientMsgId: keys[0] });
  assert.strictEqual(revived.duplicate, false);
});
