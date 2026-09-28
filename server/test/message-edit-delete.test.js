const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Задача 6 плана «безопасность раунд 3 + правка/удаление»: правка и удаление
// своих сообщений — Rocket.Chat: Allow Message Editing/Deleting, Block
// Editing/Deleting After N Minutes, Keep History.
//
// Ключевое свойство удаления: сама строка в messages обнуляется (text='',
// metadata_json=NULL, is_deleted=1) — поэтому история, поиск и превью ответа
// не могут отдать удалённый текст ни при каком запросе, не заглядывая в
// message_history.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let chat;
let UserService;
let AuthService;
let SettingsService;
let MessageService;
let AuditService;
const people = {};
const sockets = {};

test.before(async () => {
  const booted = await freshBoot();
  chat = booted.chat;
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  SettingsService = require('../src/services/settings.service');
  MessageService = require('../src/services/message.service');
  AuditService = require('../src/services/audit.service');
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  for (const [username, full_name] of [
    ['ivanov', 'Иванов Иван'],
    ['petrova', 'Петрова Анна'],
    ['sidorov', 'Сидоров Пётр']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: AuthService.generateToken(await UserService.getUserById(created.id)) };
  }
  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, token: AuthService.generateToken(await UserService.getUserById(admin.id)) };

  // Канал с тремя участниками — проверить, что message_deleted уходит всем,
  // а не только удалившему.
  const channel = MessageService.createChannel('Отдел', '', 'public', people.ivanov.id);
  people.channelId = Number(channel.id);
  const now = new Date().toISOString();
  for (const name of ['petrova', 'sidorov']) {
    chat
      .prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(people.channelId, people[name].id, 'member', now);
  }

  await connect('ivanov');
  await connect('petrova');
  await connect('sidorov');
  await connect('admin');
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

// Окна времени сбрасываются к значениям по умолчанию перед каждым тестом:
// иначе тест, включивший «-1», ломал бы соседей по файлу.
test.beforeEach(async () => {
  await SettingsService.setSetting('message_edit_window_minutes', '60');
  await SettingsService.setSetting('message_delete_window_minutes', '60');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, urlPath, { body, token, headers = {}, raw } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function openRaw() {
  const sock = new WebSocket(wsUrl);
  const client = { sock, inbox: [] };
  sock.on('message', (raw, isBinary) => {
    if (!isBinary) {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('error', () => {});
  client.opened = new Promise((resolve) => sock.on('open', resolve));
  return client;
}

async function connect(name) {
  const client = openRaw();
  await client.opened;
  client.sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
  await waitFor(client, (m) => m.type === 'auth_success' || m.type === 'auth_error');
  if (sockets[name] && sockets[name] !== client) {
    try { sockets[name].sock.close(); } catch {}
  }
  sockets[name] = client;
  return client;
}

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(15);
  }
  throw new Error('событие не пришло за отведённое время');
}

const send = (name, payload) => sockets[name].sock.send(JSON.stringify(payload));

async function sendAndWait(name, payload, predicate) {
  send(name, payload);
  return waitFor(sockets[name], predicate);
}

// ── Правка ───────────────────────────────────────────────────────────────

test('правка своего сообщения: message_updated обоим участникам ЛС, updated_at задан, история хранит старый текст', async () => {
  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'ПравкаТест: исходный текст' },
    (m) => m.type === 'direct_message' && m.message?.text === 'ПравкаТест: исходный текст'
  );
  const messageId = sent.message.id;
  await waitFor(sockets.petrova, (m) => m.type === 'direct_message' && m.message?.id === messageId);

  send('ivanov', { type: 'edit_message', messageId, text: 'ПравкаТест: исправленный текст' });

  const atIvanov = await waitFor(sockets.ivanov, (m) => m.type === 'message_updated' && m.message?.id === messageId);
  const atPetrova = await waitFor(sockets.petrova, (m) => m.type === 'message_updated' && m.message?.id === messageId);
  assert.strictEqual(atIvanov.message.text, 'ПравкаТест: исправленный текст');
  assert.strictEqual(atPetrova.message.text, 'ПравкаТест: исправленный текст');
  assert.ok(atIvanov.message.updated_at, 'updated_at должен быть проставлен');

  const history = chat.prepare('SELECT * FROM message_history WHERE message_id = ? AND action = ?').all(messageId, 'edit');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].old_text, 'ПравкаТест: исходный текст');
  assert.strictEqual(Number(history[0].actor_id), people.ivanov.id);
});

test('правка чужого сообщения отклоняется', async () => {
  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'ЧужаяПравка: текст' },
    (m) => m.type === 'direct_message' && m.message?.text === 'ЧужаяПравка: текст'
  );
  const messageId = sent.message.id;

  const err = await sendAndWait(
    'petrova',
    { type: 'edit_message', messageId, text: 'подмена' },
    (m) => m.type === 'error' && m.context === 'edit_message'
  );
  assert.ok(err.message);
  const row = chat.prepare('SELECT text FROM messages WHERE id = ?').get(messageId);
  assert.strictEqual(row.text, 'ЧужаяПравка: текст');
});

test('правка вне временного окна отклоняется', async () => {
  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'ОкноПравки: старое сообщение' },
    (m) => m.type === 'direct_message' && m.message?.text === 'ОкноПравки: старое сообщение'
  );
  const messageId = sent.message.id;
  const past = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  chat.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(past, messageId);

  const err = await sendAndWait(
    'ivanov',
    { type: 'edit_message', messageId, text: 'поздно' },
    (m) => m.type === 'error' && m.context === 'edit_message'
  );
  assert.ok(err.message);
});

test('правка удалённого сообщения отклоняется', async () => {
  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'БудетУдалено: текст' },
    (m) => m.type === 'direct_message' && m.message?.text === 'БудетУдалено: текст'
  );
  const messageId = sent.message.id;
  await sendAndWait('ivanov', { type: 'delete_message', messageId }, (m) => m.type === 'message_deleted' && m.messageId === messageId);

  const err = await sendAndWait(
    'ivanov',
    { type: 'edit_message', messageId, text: 'после удаления' },
    (m) => m.type === 'error' && m.context === 'edit_message'
  );
  assert.ok(err.message);
});

test('правка на 16001 символ отклоняется', async () => {
  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'ДлинаПравки: нормальный текст' },
    (m) => m.type === 'direct_message' && m.message?.text === 'ДлинаПравки: нормальный текст'
  );
  const messageId = sent.message.id;
  const tooLong = 'а'.repeat(16001);
  const err = await sendAndWait(
    'ivanov',
    { type: 'edit_message', messageId, text: tooLong },
    (m) => m.type === 'error' && m.context === 'edit_message'
  );
  assert.ok(err.message);
});

test('окно правки -1 отключает правку даже сразу после отправки', async () => {
  await SettingsService.setSetting('message_edit_window_minutes', '-1');
  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'ПравкаВыключена: текст' },
    (m) => m.type === 'direct_message' && m.message?.text === 'ПравкаВыключена: текст'
  );
  const messageId = sent.message.id;
  const err = await sendAndWait(
    'ivanov',
    { type: 'edit_message', messageId, text: 'всё равно правлю' },
    (m) => m.type === 'error' && m.context === 'edit_message'
  );
  assert.ok(err.message);
});

// ── Удаление ─────────────────────────────────────────────────────────────

test('удаление своего сообщения в канале: message_deleted всем участникам, текст в выдаче пуст', async () => {
  const sent = await sendAndWait(
    'ivanov',
    { type: 'channel_message', targetId: people.channelId, text: 'УдалениеКанал: сообщение' },
    (m) => m.type === 'channel_message' && m.message?.text === 'УдалениеКанал: сообщение'
  );
  const messageId = sent.message.id;
  await waitFor(sockets.petrova, (m) => m.type === 'channel_message' && m.message?.id === messageId);
  await waitFor(sockets.sidorov, (m) => m.type === 'channel_message' && m.message?.id === messageId);

  send('ivanov', { type: 'delete_message', messageId });

  const atPetrova = await waitFor(sockets.petrova, (m) => m.type === 'message_deleted' && m.messageId === messageId);
  await waitFor(sockets.sidorov, (m) => m.type === 'message_deleted' && m.messageId === messageId);
  assert.strictEqual(atPetrova.conversationType, 'channel');
  assert.strictEqual(atPetrova.targetId, people.channelId);

  const history = await MessageService.getMessages('channel', people.channelId, people.ivanov.id, 50);
  const row = history.find((m) => m.id === messageId);
  assert.strictEqual(row.text, '');
  assert.strictEqual(Number(row.is_deleted), 1);
  assert.strictEqual(row.metadata_json, null);
});

test('удаление чужого сообщения обычным пользователем отклоняется', async () => {
  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'НельзяУдалитьЧужое: текст' },
    (m) => m.type === 'direct_message' && m.message?.text === 'НельзяУдалитьЧужое: текст'
  );
  const messageId = sent.message.id;

  const err = await sendAndWait(
    'petrova',
    { type: 'delete_message', messageId },
    (m) => m.type === 'error' && m.context === 'delete_message'
  );
  assert.ok(err.message);
  const row = chat.prepare('SELECT is_deleted FROM messages WHERE id = ?').get(messageId);
  assert.strictEqual(Number(row.is_deleted), 0);
});

test('супер-администратор удаляет чужое сообщение без ограничения окна, событие в аудите', async () => {
  await SettingsService.setSetting('message_delete_window_minutes', '-1'); // даже выключенное окно не мешает модерации

  const sent = await sendAndWait(
    'petrova',
    { type: 'direct_message', targetId: people.sidorov.id, text: 'МодерацияАдмином: сообщение' },
    (m) => m.type === 'direct_message' && m.message?.text === 'МодерацияАдмином: сообщение'
  );
  const messageId = sent.message.id;
  await waitFor(sockets.sidorov, (m) => m.type === 'direct_message' && m.message?.id === messageId);

  // Получатели уведомления — те же, что при отправке (участники личной
  // переписки petrova/sidorov), а не сам администратор: он не адресат этой
  // переписки, только модератор со стороны.
  send('admin', { type: 'delete_message', messageId });
  await waitFor(sockets.petrova, (m) => m.type === 'message_deleted' && m.messageId === messageId);
  await waitFor(sockets.sidorov, (m) => m.type === 'message_deleted' && m.messageId === messageId);

  // AuditService.log() не дожидается записи (см. audit.service.js) — цепочка
  // хэшей пишется в фоне, поэтому проверка ждёт короткое время вместо того,
  // чтобы полагаться на порядок событий сокета.
  let found = null;
  const deadline = Date.now() + 2000;
  while (!found && Date.now() < deadline) {
    const logs = await AuditService.list({ action: 'message_deleted_by_admin', limit: 20 });
    found = logs.find((l) => l.details?.messageId === messageId);
    if (!found) await sleep(30);
  }
  assert.ok(found, 'запись аудита message_deleted_by_admin не найдена');
  assert.strictEqual(Number(found.user_id), people.admin.id);
});

// ── Файлы и удалённые сообщения ─────────────────────────────────────────

test('после удаления сообщения с вложением получатель теряет доступ к файлу, загрузивший — нет', async () => {
  const form = new FormData();
  form.append('file', new Blob(['содержимое файла'], { type: 'text/plain' }), 'report.txt');
  const up = await api('POST', '/api/files/upload', { token: people.ivanov.token, raw: form });
  assert.strictEqual(up.status, 201, up.text);
  const fileId = up.json.id;

  const sent = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'report.txt', msgType: 'file', metadata: { file_id: fileId } },
    (m) => m.type === 'direct_message' && m.message?.metadata_json?.includes(String(fileId))
  );
  const messageId = sent.message.id;
  await waitFor(sockets.petrova, (m) => m.type === 'direct_message' && m.message?.id === messageId);

  const beforeDelete = await api('GET', `/api/files/download/${fileId}`, { token: people.petrova.token });
  assert.strictEqual(beforeDelete.status, 200, beforeDelete.text);

  await sendAndWait('ivanov', { type: 'delete_message', messageId }, (m) => m.type === 'message_deleted' && m.messageId === messageId);

  const afterDelete = await api('GET', `/api/files/download/${fileId}`, { token: people.petrova.token });
  assert.strictEqual(afterDelete.status, 403, 'получатель всё ещё скачивает файл удалённого сообщения');

  const uploaderStill = await api('GET', `/api/files/download/${fileId}`, { token: people.ivanov.token });
  assert.strictEqual(uploaderStill.status, 200, 'загрузивший файл потерял доступ к собственному файлу');
});

test('ответ на удалённое сообщение не показывает его текст в выдаче', async () => {
  const original = await sendAndWait(
    'ivanov',
    { type: 'direct_message', targetId: people.petrova.id, text: 'СекретныйИсходныйТекст' },
    (m) => m.type === 'direct_message' && m.message?.text === 'СекретныйИсходныйТекст'
  );
  const originalId = original.message.id;
  await waitFor(sockets.petrova, (m) => m.type === 'direct_message' && m.message?.id === originalId);

  await sendAndWait('ivanov', { type: 'delete_message', messageId: originalId }, (m) => m.type === 'message_deleted' && m.messageId === originalId);

  await sendAndWait(
    'petrova',
    { type: 'direct_message', targetId: people.ivanov.id, text: 'ОтветНаУдалённое', replyToId: originalId },
    (m) => m.type === 'direct_message' && m.message?.text === 'ОтветНаУдалённое'
  );

  const history = await MessageService.getMessages('direct', people.petrova.id, people.ivanov.id, 50);
  const originalInHistory = history.find((m) => m.id === originalId);
  assert.strictEqual(originalInHistory.text, '', 'текст удалённого сообщения не должен отдаваться даже через ответ на него');
});
