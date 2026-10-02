const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Надёжная доставка для мобильных клиентов (задача 5 плана мобильного релиза):
//
//   S1 — идемпотентная отправка: client_msg_id, уникальный на отправителя.
//        Повтор той же отправки (после обрыва связи) не создаёт вторую строку.
//   S2 — догрузка пропущенного: GET /api/messages?afterId (вперёд, по
//        возрастанию) и GET /api/sync?since=<курсор> — все созданные,
//        изменённые и удалённые сообщения во ВСЕХ видимых пользователю
//        переписках после курсора.
//   S3 — «доставлено» после переподключения: когда получатель входит в сокет,
//        его недоставленные личные сообщения отмечаются доставленными, а
//        авторам, кто на связи, уходит message_status_updated.
//
// Всё это — дополнение: настольный клиент client_msg_id не шлёт и /api/sync не
// вызывает, и его поведение остаться обязано прежним.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let chat;
let UserService;
let AuthService;
let MessageService;
const people = {};
const sockets = {};

test.before(async () => {
  const booted = await freshBoot();
  chat = booted.chat;
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  MessageService = require('../src/services/message.service');
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
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
    ['dave', 'Давид Тестов'],
    ['erin', 'Эрин Тестова'],
    ['frank', 'Франк Тестов'],
    ['grace', 'Грейс Тестова'],
    ['heidi', 'Хайди Тестова']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: AuthService.generateToken(await UserService.getUserById(created.id)) };
  }

  // Канал alice + bob; закрытый канал carol + dave — alice его не видит.
  const team = MessageService.createChannel('Команда', '', 'public', people.alice.id);
  people.teamId = Number(team.id);
  const secret = MessageService.createChannel('Тайный', '', 'private', people.carol.id);
  people.secretId = Number(secret.id);
  const now = new Date().toISOString();
  const addMember = chat.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
  addMember.run(people.teamId, people.bob.id, 'member', now);
  addMember.run(people.secretId, people.dave.id, 'member', now);
});

test.after(async () => {
  for (const s of Object.values(sockets)) {
    try { s.sock.close(); } catch {}
  }
  const wsServer = require('../src/ws/server');
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

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
  return { status: res.status, json, text, headers: res.headers };
}

async function connect(name) {
  // Один сокет на имя: прежний закрывается, иначе человек остался бы в сети.
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
  // Сервер снимает сокет в своём обработчике close — дать ему отработать.
  const wsServer = require('../src/ws/server');
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
const countRows = (where, ...params) => Number(chat.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...params).n);

// ══ S1. Идемпотентная отправка ═══════════════════════════════════════════

test('S1 WS: повтор send_message с тем же client_msg_id — одна строка, эхо той же записи с client_msg_id', async () => {
  await connect('alice');
  await connect('bob');
  const cid = 'ws-dup-0001';

  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Идемпотентность WS', client_msg_id: cid });
  const first = await waitFor(sockets.alice, (m) => m.type === 'direct_message' && m.message?.client_msg_id === cid);
  const firstNew = await waitFor(sockets.alice, (m) => m.type === 'new_message' && m.message?.client_msg_id === cid);
  await waitFor(sockets.bob, (m) => m.type === 'direct_message' && m.message?.id === first.message.id);
  assert.strictEqual(firstNew.message.id, first.message.id);
  assert.strictEqual(first.message.client_msg_id, cid);

  sockets.alice.inbox.length = 0;
  sockets.bob.inbox.length = 0;
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Идемпотентность WS', client_msg_id: cid });
  const again = await waitFor(sockets.alice, (m) => m.type === 'direct_message' && m.message?.client_msg_id === cid);
  await waitFor(sockets.alice, (m) => m.type === 'new_message' && m.message?.client_msg_id === cid);
  assert.strictEqual(again.message.id, first.message.id, 'повтор возвращает уже сохранённую запись');
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ?', people.alice.id, cid), 1);

  // Получатель второй раз уведомление не получает: повтор — не новое сообщение.
  await sleep(150);
  assert.ok(!sockets.bob.inbox.some((m) => m.type === 'direct_message' || m.type === 'new_message'),
    'повтор не должен снова рассылаться получателю');
});

test('S1 WS: тот же client_msg_id в канале — одна строка, channel_message эхом', async () => {
  const cid = 'ws-chan-dup-1';
  send('alice', { type: 'channel_message', channel_id: people.teamId, text: 'Канал, идемпотентно', client_msg_id: cid });
  const first = await waitFor(sockets.alice, (m) => m.type === 'channel_message' && m.message?.client_msg_id === cid);
  sockets.alice.inbox.length = 0;
  send('alice', { type: 'channel_message', channel_id: people.teamId, text: 'Канал, идемпотентно', client_msg_id: cid });
  const again = await waitFor(sockets.alice, (m) => m.type === 'channel_message' && m.message?.client_msg_id === cid);
  assert.strictEqual(again.message.id, first.message.id);
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ?', people.alice.id, cid), 1);
});

test('S1 REST direct: 201 на первую отправку, 200 и та же запись на повтор; одна строка', async () => {
  const cid = 'rest-direct-0001';
  const first = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'REST идемпотентно', client_msg_id: cid } });
  assert.strictEqual(first.status, 201, first.text);
  assert.strictEqual(first.json.client_msg_id, cid);

  const again = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'REST идемпотентно', client_msg_id: cid } });
  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(again.json.id, first.json.id);
  assert.strictEqual(again.json.client_msg_id, cid);
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ?', people.alice.id, cid), 1);
});

test('S1 REST channel: повтор возвращает ту же запись; client_msg_id в ответе', async () => {
  const cid = 'rest-channel-0001';
  const first = await api('POST', `/api/messages/channels/${people.teamId}`, { token: people.bob.token, body: { text: 'REST канал', client_msg_id: cid } });
  assert.strictEqual(first.status, 201, first.text);
  assert.strictEqual(first.json.client_msg_id, cid);
  const again = await api('POST', `/api/messages/channels/${people.teamId}`, { token: people.bob.token, body: { text: 'REST канал', client_msg_id: cid } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.id, first.json.id);
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ?', people.bob.id, cid), 1);
});

test('S1: одинаковый client_msg_id у РАЗНЫХ отправителей — разные сообщения; чужое по id не достать', async () => {
  const cid = 'shared-id-42';
  const fromAlice = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'Секрет Алисы', client_msg_id: cid } });
  assert.strictEqual(fromAlice.status, 201);

  // Carol угадала id Алисы и шлёт с ним — получает СВОЁ новое сообщение,
  // а не запись Алисы.
  const fromCarol = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.carol.token, body: { text: 'Сообщение Карины', client_msg_id: cid } });
  assert.strictEqual(fromCarol.status, 201, 'для другого отправителя это новая отправка');
  assert.notStrictEqual(fromCarol.json.id, fromAlice.json.id);
  assert.strictEqual(fromCarol.json.sender_id, people.carol.id);
  assert.strictEqual(fromCarol.json.text, 'Сообщение Карины');
  assert.ok(!JSON.stringify(fromCarol.json).includes('Секрет Алисы'));

  // И Bob в ответ Алисе с тем же id — тоже своё.
  const fromBob = await api('POST', `/api/messages/direct/${people.alice.id}`, { token: people.bob.token, body: { text: 'Ответ Боба', client_msg_id: cid } });
  assert.strictEqual(fromBob.status, 201);
  assert.strictEqual(fromBob.json.sender_id, people.bob.id);
  assert.strictEqual(countRows('client_msg_id = ?', cid), 3);
});

test('S1: недопустимый client_msg_id отклоняется (REST 400, WS error с кодом), строка не создаётся', async () => {
  const before = countRows('1 = 1');
  const bad = ['x'.repeat(65), '', 'с пробелом', '../../etc', 'кириллица', 'a;DROP', 12345, { a: 1 }, ['x'], true];
  for (const value of bad) {
    const res = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'не должно сохраниться', client_msg_id: value } });
    assert.strictEqual(res.status, 400, `client_msg_id=${JSON.stringify(value)} → ${res.status} ${res.text}`);
    assert.strictEqual(res.json.code, 'INVALID_CLIENT_MSG_ID');
  }
  const okMax = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'ровно 64', client_msg_id: 'A-z_0'.repeat(12) + 'abcd' } });
  assert.strictEqual(okMax.status, 201, '64 символа допустимого набора — можно');

  sockets.alice.inbox.length = 0;
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'WS плохой id', client_msg_id: 'y'.repeat(65) });
  const err = await waitFor(sockets.alice, (m) => m.type === 'error' && m.context === 'send_message');
  assert.strictEqual(err.code, 'INVALID_CLIENT_MSG_ID');
  assert.strictEqual(err.text, 'WS плохой id', 'текст возвращается для восстановления поля ввода');
  assert.strictEqual(err.client_msg_id, undefined, 'недопустимое значение не отражается обратно');
  assert.strictEqual(countRows('1 = 1'), before + 1);
});

test('S1: тот же client_msg_id в ДРУГОЙ переписке — 409 / CLIENT_MSG_ID_CONFLICT, без новой строки', async () => {
  const cid = 'conflict-0001';
  const first = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'в диалог с Бобом', client_msg_id: cid } });
  assert.strictEqual(first.status, 201);
  const other = await api('POST', `/api/messages/direct/${people.carol.id}`, { token: people.alice.token, body: { text: 'в диалог с Кариной', client_msg_id: cid } });
  assert.strictEqual(other.status, 409, other.text);
  assert.strictEqual(other.json.code, 'CLIENT_MSG_ID_CONFLICT');
  assert.ok(!JSON.stringify(other.json).includes('в диалог с Бобом'), 'в отказе нет чужой записи');
  const chan = await api('POST', `/api/messages/channels/${people.teamId}`, { token: people.alice.token, body: { text: 'в канал', client_msg_id: cid } });
  assert.strictEqual(chan.status, 409);

  sockets.alice.inbox.length = 0;
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.carol.id, text: 'WS конфликт', client_msg_id: cid });
  const err = await waitFor(sockets.alice, (m) => m.type === 'error' && m.context === 'send_message');
  assert.strictEqual(err.code, 'CLIENT_MSG_ID_CONFLICT');
  assert.strictEqual(err.client_msg_id, cid);
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ?', people.alice.id, cid), 1);
});

test('S1: без client_msg_id всё как раньше — каждая отправка новая строка, поле null (настольный клиент)', async () => {
  const a = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'без id' } });
  const b = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'без id' } });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 201);
  assert.notStrictEqual(a.json.id, b.json.id);
  assert.strictEqual(a.json.client_msg_id, null);
  assert.ok(!('change_seq' in a.json), 'служебная последовательность наружу не отдаётся');

  sockets.alice.inbox.length = 0;
  sockets.bob.inbox.length = 0;
  // Ровно тот кадр, что шлёт desktop/src/renderer/src/App.jsx.
  send('alice', { type: 'direct_message', conversationType: 'direct', targetId: people.bob.id, recipient_id: people.bob.id, channel_id: people.bob.id, text: 'как desktop', msgType: 'text', replyToId: null, metadata: null });
  const dm = await waitFor(sockets.alice, (m) => m.type === 'direct_message' && m.message?.text === 'как desktop');
  assert.strictEqual(dm.message.client_msg_id, null);
  await waitFor(sockets.bob, (m) => m.type === 'direct_message' && m.message?.id === dm.message.id);
  await waitFor(sockets.bob, (m) => m.type === 'new_message' && m.message?.id === dm.message.id);
});

test('S1: повтор после удаления возвращает надгробие, а не создаёт сообщение заново', async () => {
  const cid = 'deleted-then-retry';
  const first = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'удалю', client_msg_id: cid } });
  await MessageService.deleteMessage({ messageId: first.json.id, actorId: people.alice.id });
  const again = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'удалю', client_msg_id: cid } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.id, first.json.id);
  assert.strictEqual(again.json.is_deleted, 1);
  assert.strictEqual(again.json.text, '');
  assert.strictEqual(countRows('sender_id = ? AND client_msg_id = ?', people.alice.id, cid), 1);
});

// ══ S2. Догрузка: afterId и /api/sync ════════════════════════════════════

test('S2 afterId: страницы вперёд по возрастанию, предел 200, проверка параметра', async () => {
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await api('POST', `/api/messages/direct/${people.erin.id}`, { token: people.dave.token, body: { text: `afterId ${i}` } });
    ids.push(r.json.id);
  }
  const page1 = await api('GET', `/api/messages?conversationType=direct&targetId=${people.erin.id}&afterId=${ids[0]}&limit=2`, { token: people.dave.token });
  assert.strictEqual(page1.status, 200, page1.text);
  assert.deepStrictEqual(page1.json.map((m) => m.id), [ids[1], ids[2]]);
  const page2 = await api('GET', `/api/messages?conversationType=direct&targetId=${people.erin.id}&afterId=${ids[2]}&limit=2`, { token: people.dave.token });
  assert.deepStrictEqual(page2.json.map((m) => m.id), [ids[3], ids[4]]);
  const page3 = await api('GET', `/api/messages?conversationType=direct&targetId=${people.erin.id}&afterId=${ids[4]}&limit=2`, { token: people.dave.token });
  assert.deepStrictEqual(page3.json, []);

  const fromZero = await api('GET', `/api/messages?conversationType=direct&targetId=${people.dave.id}&afterId=0&limit=1000`, { token: people.erin.token });
  assert.deepStrictEqual(fromZero.json.map((m) => m.id), ids, 'с нуля — вся переписка по возрастанию (предел 200)');
  assert.ok(fromZero.json.every((m) => 'delivery_status' in m));

  for (const bad of ['abc', '-1', '1.5', '1e3']) {
    const r = await api('GET', `/api/messages?conversationType=direct&targetId=${people.erin.id}&afterId=${bad}`, { token: people.dave.token });
    assert.strictEqual(r.status, 400, `afterId=${bad}`);
  }

  // Канал, где пользователь не участник, — 403, как и без afterId.
  const forbidden = await api('GET', `/api/messages?conversationType=channel&targetId=${people.secretId}&afterId=0`, { token: people.alice.token });
  assert.strictEqual(forbidden.status, 403);
});

test('S2 sync: без since — пустая выборка и курсор «голова»; новое, правка и удаление — по одному разу в последнем состоянии', async () => {
  const boot = await api('GET', '/api/sync', { token: people.frank.token });
  assert.strictEqual(boot.status, 200, boot.text);
  assert.deepStrictEqual(boot.json.messages, []);
  assert.strictEqual(boot.json.has_more, false);
  assert.match(boot.json.next_cursor, /^\d+$/);
  const cursor = boot.json.next_cursor;

  const kept = await api('POST', `/api/messages/direct/${people.frank.id}`, { token: people.grace.token, body: { text: 'Новое' } });
  const edited = await api('POST', `/api/messages/direct/${people.frank.id}`, { token: people.grace.token, body: { text: 'До правки' } });
  const removed = await api('POST', `/api/messages/direct/${people.grace.id}`, { token: people.frank.token, body: { text: 'Будет удалено', metadata: null } });
  await MessageService.editMessage({ messageId: edited.json.id, actorId: people.grace.id, text: 'После правки' });
  await MessageService.deleteMessage({ messageId: removed.json.id, actorId: people.frank.id });

  const res = await api('GET', `/api/sync?since=${cursor}`, { token: people.frank.token });
  assert.strictEqual(res.status, 200);
  const byId = new Map(res.json.messages.map((m) => [m.id, m]));
  assert.strictEqual(res.json.messages.length, 3, 'каждое сообщение один раз, в последнем состоянии');
  assert.strictEqual(byId.get(kept.json.id).text, 'Новое');
  assert.strictEqual(byId.get(edited.json.id).text, 'После правки');
  assert.ok(byId.get(edited.json.id).updated_at);
  const tomb = byId.get(removed.json.id);
  assert.strictEqual(tomb.is_deleted, 1);
  assert.strictEqual(tomb.text, '');
  assert.strictEqual(tomb.metadata_json, null);
  // Порядок — по изменению: правка и удаление позже создания третьего.
  assert.deepStrictEqual(res.json.messages.map((m) => m.id), [kept.json.id, edited.json.id, removed.json.id]);
  for (const m of res.json.messages) {
    assert.ok('delivery_status' in m && 'client_msg_id' in m && !('change_seq' in m));
  }
  assert.strictEqual(res.json.has_more, false);
  assert.ok(Number(res.json.next_cursor) > Number(cursor));

  const after = await api('GET', `/api/sync?since=${res.json.next_cursor}`, { token: people.frank.token });
  assert.deepStrictEqual(after.json.messages, []);
  assert.strictEqual(after.json.next_cursor, res.json.next_cursor, 'пустая выборка курсор не сдвигает назад');
});

test('S2 sync: постраничный обход при одинаковых временных метках — без пропусков и повторов', async () => {
  const start = (await api('GET', '/api/sync', { token: people.heidi.token })).json.next_cursor;
  const ids = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await api('POST', `/api/messages/direct/${people.heidi.id}`, { token: people.grace.token, body: { text: `страница ${i}` } });
    ids.push(r.json.id);
  }
  // Одна и та же метка времени у всех — курсор не должен на неё опираться.
  const same = '2026-10-02T09:00:00.000Z';
  chat.prepare(`UPDATE messages SET created_at = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(same, same, ...ids);

  const seen = [];
  let cursor = start;
  let pages = 0;
  for (;;) {
    const r = await api('GET', `/api/sync?since=${cursor}&limit=3`, { token: people.heidi.token });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.messages.length <= 3);
    seen.push(...r.json.messages.map((m) => m.id));
    cursor = r.json.next_cursor;
    pages += 1;
    if (!r.json.has_more) break;
    assert.ok(pages < 10);
  }
  assert.deepStrictEqual(seen, ids);
  assert.strictEqual(pages, 3);
});

test('S2 sync: чужие личные переписки и каналы без участия не попадают в выборку', async () => {
  const start = (await api('GET', '/api/sync', { token: people.alice.token })).json.next_cursor;
  const foreignDirect = await api('POST', `/api/messages/direct/${people.dave.id}`, { token: people.carol.token, body: { text: 'Чужая личка' } });
  const foreignChannel = await api('POST', `/api/messages/channels/${people.secretId}`, { token: people.carol.token, body: { text: 'Тайный канал' } });
  const visibleChannel = await api('POST', `/api/messages/channels/${people.teamId}`, { token: people.bob.token, body: { text: 'Командный канал' } });
  const visibleDirect = await api('POST', `/api/messages/direct/${people.alice.id}`, { token: people.dave.token, body: { text: 'Алисе лично' } });
  assert.strictEqual(foreignChannel.status, 201);

  const res = await api('GET', `/api/sync?since=${start}&limit=200`, { token: people.alice.token });
  const ids = res.json.messages.map((m) => m.id);
  assert.ok(!ids.includes(foreignDirect.json.id), 'личка carol→dave не видна alice');
  assert.ok(!ids.includes(foreignChannel.json.id), 'закрытый канал без участия не виден');
  assert.ok(ids.includes(visibleChannel.json.id));
  assert.ok(ids.includes(visibleDirect.json.id));
  assert.ok(!JSON.stringify(res.json).includes('Тайный канал') && !JSON.stringify(res.json).includes('Чужая личка'));
});

test('S2 sync: проверка курсора и предела; без токена 401; курсор из будущего — 410', async () => {
  for (const bad of ['abc', '-1', '1.5', '1e3', '1'.repeat(16), '']) {
    const r = await api('GET', `/api/sync?since=${bad}`, { token: people.alice.token });
    assert.strictEqual(r.status, 400, `since=${JSON.stringify(bad)} → ${r.status}`);
  }
  for (const bad of ['0', '-5', 'x']) {
    const r = await api('GET', `/api/sync?since=0&limit=${bad}`, { token: people.alice.token });
    assert.strictEqual(r.status, 400, `limit=${bad}`);
  }
  const big = await api('GET', '/api/sync?since=0&limit=100000', { token: people.alice.token });
  assert.strictEqual(big.status, 200);
  assert.ok(big.json.messages.length <= 200, 'предел страницы — 200');

  const anon = await api('GET', '/api/sync?since=0');
  assert.strictEqual(anon.status, 401);

  const future = await api('GET', '/api/sync?since=999999999', { token: people.alice.token });
  assert.strictEqual(future.status, 410);
  assert.strictEqual(future.json.code, 'SYNC_CURSOR_INVALID');
});

test('S2 sync: прочтение собеседником возвращает сообщение в выборку автора со статусом read', async () => {
  await connect('carol');
  const sent = await api('POST', `/api/messages/direct/${people.carol.id}`, { token: people.alice.token, body: { text: 'Прочти меня' } });
  const cursor = (await api('GET', '/api/sync', { token: people.alice.token })).json.next_cursor;
  send('carol', { type: 'mark_read', conversationType: 'direct', targetId: people.alice.id });
  await waitFor(sockets.alice, (m) => m.type === 'messages_read' && m.messageIds?.includes(sent.json.id));
  const res = await api('GET', `/api/sync?since=${cursor}`, { token: people.alice.token });
  const row = res.json.messages.find((m) => m.id === sent.json.id);
  assert.ok(row, 'смена статуса двигает сообщение в синхронизации');
  assert.strictEqual(row.delivery_status, 'read');
  await disconnect('carol');
});

// ══ S3. «Доставлено» после переподключения ═══════════════════════════════

test('S3: получатель вошёл в сокет — недоставленные отмечаются, автор получает message_status_updated', async () => {
  await disconnect('bob');
  sockets.alice.inbox.length = 0;
  send('alice', { type: 'send_message', conversationType: 'direct', targetId: people.bob.id, text: 'Пока Боба нет 1', client_msg_id: 'offline-1' });
  const m1 = await waitFor(sockets.alice, (m) => m.type === 'direct_message' && m.message?.client_msg_id === 'offline-1');
  const r2 = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'Пока Боба нет 2' } });
  await sleep(100);
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'message_status_updated' && (m.messageId === m1.message.id || m.messageId === r2.json.id)),
    'пока получатель не в сети — «доставлено» не ставится');
  const delivered = (id) => chat.prepare("SELECT 1 FROM message_statuses WHERE message_id = ? AND user_id = ? AND status = 'delivered'").get(id, people.bob.id);
  assert.ok(!delivered(m1.message.id));

  await connect('bob');
  for (const id of [m1.message.id, r2.json.id]) {
    const ev = await waitFor(sockets.alice, (m) => m.type === 'message_status_updated' && m.messageId === id);
    assert.strictEqual(ev.status, 'delivered');
    assert.strictEqual(ev.userId, people.bob.id);
    assert.ok(ev.timestamp);
    assert.ok(delivered(id));
  }
  const page = await api('GET', `/api/messages/direct/${people.bob.id}?limit=200`, { token: people.alice.token });
  assert.strictEqual(page.json.find((m) => m.id === m1.message.id).delivery_status, 'delivered');

  // Повторный вход ничего не дублирует.
  sockets.alice.inbox.length = 0;
  await disconnect('bob');
  await connect('bob');
  await sleep(150);
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'message_status_updated'), 'уже доставленные повторно не объявляются');
});

test('S3: прочитанное не откатывается в «доставлено», удалённое не отмечается', async () => {
  await disconnect('bob');
  const read = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'прочитано без доставки' } });
  const gone = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'удалено до входа' } });
  MessageService.markAsRead('direct', people.alice.id, people.bob.id);
  await MessageService.deleteMessage({ messageId: gone.json.id, actorId: people.alice.id });

  sockets.alice.inbox.length = 0;
  await connect('bob');
  await sleep(150);
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'message_status_updated' && (m.messageId === read.json.id || m.messageId === gone.json.id)));
  const page = await api('GET', `/api/messages/direct/${people.bob.id}?limit=200`, { token: people.alice.token });
  assert.strictEqual(page.json.find((m) => m.id === read.json.id).delivery_status, 'read');
});

test('S3: REST-отправка получателю в сети — «доставлено» сразу и message_status_updated автору', async () => {
  await connect('bob');
  sockets.alice.inbox.length = 0;
  const sent = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'REST онлайн' } });
  assert.strictEqual(sent.status, 201);
  const ev = await waitFor(sockets.alice, (m) => m.type === 'message_status_updated' && m.messageId === sent.json.id);
  assert.strictEqual(ev.status, 'delivered');
  assert.strictEqual(ev.userId, people.bob.id);

  await disconnect('bob');
  sockets.alice.inbox.length = 0;
  const offline = await api('POST', `/api/messages/direct/${people.bob.id}`, { token: people.alice.token, body: { text: 'REST офлайн' } });
  await sleep(100);
  assert.ok(!sockets.alice.inbox.some((m) => m.type === 'message_status_updated' && m.messageId === offline.json.id));
});

test('S2 sync: предел частоты — 429 с Retry-After', async () => {
  let limited = null;
  for (let i = 0; i < 80 && !limited; i += 1) {
    const r = await api('GET', '/api/sync?since=0&limit=1', { token: people.grace.token });
    if (r.status === 429) limited = r;
    else assert.strictEqual(r.status, 200);
  }
  assert.ok(limited, 'предел должен сработать');
  assert.strictEqual(limited.headers.get('retry-after'), '60');
  assert.ok(limited.json.error);
});
