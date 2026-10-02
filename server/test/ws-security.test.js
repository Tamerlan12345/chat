const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Граница доверия шлюза реального времени и соседних маршрутов. Каждый тест —
// конкретный способ, которым сотрудник (или вовсе не вошедший посетитель из
// разрешённой сети) получал чужое: токен коллеги через стук устройства, файлы
// чужих переписок, секреты настроек, звук чужого разговора, согласие на
// удалённый доступ за другого человека.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.WS_AUTH_TIMEOUT_MS = '1500';

let baseUrl;
let wsUrl;
let server;
let UserService;
let AuthService;
let SettingsService;
const people = {};
const sockets = {};

test.before(async () => {
  await freshBoot();
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  SettingsService = require('../src/services/settings.service');
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
});

test.after(async () => {
  for (const s of Object.values(sockets)) {
    try { s.sock.close(); } catch {}
  }
  // Любое оставшееся соединение держит процесс живым, и прогон зависает
  // вместо того, чтобы завершиться.
  const wsServer = require('../src/ws/server');
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
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
  return { status: res.status, json, text, headers: res.headers };
}

function openRaw() {
  const sock = new WebSocket(wsUrl);
  const client = { sock, inbox: [], binary: [], closed: false, closeCode: null };
  sock.on('message', (raw, isBinary) => {
    if (isBinary) client.binary.push(Buffer.from(raw));
    else {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('close', (code) => { client.closed = true; client.closeCode = code; });
  sock.on('error', () => {});
  client.opened = new Promise((resolve) => sock.on('open', resolve));
  return client;
}

async function connect(name) {
  const client = openRaw();
  await client.opened;
  client.sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
  await waitFor(client, (m) => m.type === 'auth_success' || m.type === 'auth_error');
  const err = client.inbox.find((m) => m.type === 'auth_error');
  if (err) throw new Error(err.message);
  // Прежнее соединение того же сотрудника закрывается: перезаписанное, оно
  // оставалось бы открытым до конца прогона.
  if (sockets[name] && sockets[name] !== client && !sockets[name].closed) {
    try { sockets[name].sock.close(); } catch {}
  }
  sockets[name] = client;
  return client;
}

const send = (name, payload) => sockets[name].sock.send(JSON.stringify(payload));

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error('событие не пришло за отведённое время');
}

function audioFrame(targetId) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(targetId, 0);
  buf.write('звук', 4);
  return buf;
}

async function audioReaches(from, toName) {
  const before = sockets[toName].binary.length;
  sockets[from].sock.send(audioFrame(people[toName].id), { binary: true });
  await sleep(250);
  return sockets[toName].binary.length > before;
}

// ── Неавторизованные соединения ─────────────────────────────────────────────

test('соединение без авторизации не получает общих рассылок', async () => {
  await connect('petrova');
  const anonymous = openRaw();
  await anonymous.opened;

  await connect('ivanov'); // рассылает всем «Иванов в сети»
  await waitFor(sockets.petrova, (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id);
  await sleep(200);

  assert.deepStrictEqual(
    anonymous.inbox.filter((m) => m.type !== 'error'),
    [],
    'события сотрудников не должны доходить до того, кто не вошёл'
  );
  anonymous.sock.close();
});

test('соединение, так и не прошедшее авторизацию, закрывается сервером', async () => {
  const anonymous = openRaw();
  await anonymous.opened;
  const started = Date.now();
  while (!anonymous.closed && Date.now() - started < 4000) await sleep(50);
  const closedByServer = anonymous.closed;
  anonymous.sock.close();
  assert.ok(closedByServer, 'висящий без авторизации сокет — бесплатный слушатель');
});

test('успешные подключения из одной сети не упираются в ограничение попыток', async () => {
  // Офис выходит в интернет с одного адреса. После перезапуска сервера все
  // переподключаются разом, и считать удачные входы попытками подбора нельзя.
  const extra = [];
  try {
    for (let i = 0; i < 14; i += 1) {
      const client = openRaw();
      await client.opened;
      // Разные сотрудники: у одного человека число окон ограничено отдельно.
      const person = Object.values(people)[i % Object.keys(people).length];
      client.sock.send(JSON.stringify({ type: 'auth', token: person.token }));
      const reply = await waitFor(client, (m) => m.type === 'auth_success' || m.type === 'auth_error');
      extra.push(client);
      assert.strictEqual(reply.type, 'auth_success', `подключение №${i + 1}: ${reply.message || ''}`);
    }
  } finally {
    for (const c of extra) c.sock.close();
  }
  await sleep(200);
});

// ── Рассылки и справочник ───────────────────────────────────────────────────

test('стук нового устройства видит только администратор, сотрудникам он не рассылается', async () => {
  await connect('admin');
  const knock = await api('POST', '/api/auth/knock', { body: { device_id: 'dev-секрет-777', device_name: 'ПК-777' } });
  assert.strictEqual(knock.status, 200, knock.text);

  await waitFor(sockets.admin, (m) => m.type === 'device_knock_received');
  await sleep(150);
  const leaked = sockets.ivanov.inbox.filter((m) => JSON.stringify(m).includes('dev-секрет-777'));
  assert.deepStrictEqual(leaked, [], 'по идентификатору устройства после связывания выдаётся токен');
});

test('рассылка об изменении сотрудника не раскрывает служебных полей', async () => {
  const edited = await api('PUT', `/api/admin/users/${people.sidorov.id}`, {
    token: people.admin.token,
    body: { job_title: 'Ведущий специалист', bound_ip: '10.0.0.77' }
  });
  assert.strictEqual(edited.status, 200, edited.text);

  const event = await waitFor(sockets.petrova, (m) => m.type === 'user_updated' && m.user?.id === people.sidorov.id);
  for (const field of ['bound_ip', 'last_login_ip', 'token_version', 'must_change_password', 'approval_status', 'admin_scope_dept_id']) {
    assert.ok(!(field in event.user), `в рассылке оказалось поле ${field}`);
  }
  // Токен Сидорова стал недействительным вместе с правкой? Нет — должность не
  // права. Но на случай, если поколение сдвинулось, обновим.
  people.sidorov.token = AuthService.generateToken(await UserService.getUserById(people.sidorov.id));
});

test('заявку на регистрацию видят администраторы, а не все подряд', async () => {
  await SettingsService.updateSettings({ allow_registration: 'true' });
  const reg = await api('POST', '/api/auth/register', {
    body: { username: 'novichok', password: 'Парольновичка-1', full_name: 'Новичков Нил' }
  });
  assert.strictEqual(reg.status, 201, reg.text);

  await waitFor(sockets.admin, (m) => m.type === 'registration_pending');
  await sleep(150);
  assert.ok(!sockets.petrova.inbox.some((m) => m.type === 'registration_pending'));
});

test('карточка коллеги по /api/users/:id — без служебных полей', async () => {
  const res = await api('GET', `/api/users/${people.sidorov.id}`, { token: people.ivanov.token });
  assert.strictEqual(res.status, 200, res.text);
  for (const field of ['bound_ip', 'last_login_ip', 'token_version', 'must_change_password', 'approval_status']) {
    assert.ok(!(field in res.json), `сотруднику отдано поле ${field}`);
  }
});

test('настройки сервера не отдают сотруднику секреты', async () => {
  await SettingsService.updateSettings({ telegram_bot_token: '123456:СЕКРЕТНЫЙ-ТОКЕН' });
  const asEmployee = await api('GET', '/api/settings', { token: people.ivanov.token });
  assert.ok(!asEmployee.text.includes('СЕКРЕТНЫЙ-ТОКЕН'), 'токен бота доступен любому сотруднику');

  const asAdmin = await api('GET', '/api/settings', { token: people.admin.token });
  assert.strictEqual(asAdmin.status, 200);
  assert.ok(asAdmin.text.includes('СЕКРЕТНЫЙ-ТОКЕН'), 'администратору настройки нужны целиком');
});

test('чужие сайты не получают разрешение CORS', async () => {
  const res = await api('GET', '/api/settings/info', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
});

// ── Файлы ───────────────────────────────────────────────────────────────────

test('файл больше 100 МБ отклоняется по заявленному размеру, не дожидаясь загрузки', async () => {
  const declared = 150 * 1024 * 1024;
  const started = Date.now();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/api/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${people.petrova.token}`,
        'Content-Type': 'multipart/form-data; boundary=x',
        'Content-Length': declared
      }
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
      req.destroy();
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
    // Тело не отправляется вовсе: ответ должен прийти по одним заголовкам.
    req.flushHeaders();
  });
  assert.strictEqual(status, 413);
  assert.ok(Date.now() - started < 2000, 'ответ пришёл сразу');
});

test('ссылка на чужой файл в собственном сообщении не открывает к нему доступ', async () => {
  const form = new FormData();
  form.append('file', new Blob(['квартальный отчёт'], { type: 'text/plain' }), 'otchet.txt');
  const up = await api('POST', '/api/files/upload', { token: people.petrova.token, raw: form });
  assert.strictEqual(up.status, 201, up.text);
  const fileId = up.json.id;

  send('ivanov', {
    type: 'direct_message',
    targetId: people.sidorov.id,
    text: 'otchet.txt',
    msgType: 'file',
    metadata: { file_id: fileId }
  });
  await sleep(300);

  const download = await api('GET', `/api/files/download/${fileId}`, { token: people.ivanov.token });
  assert.strictEqual(download.status, 403, 'файл чужой переписки скачан по подставленному номеру');

  // Законный путь по-прежнему работает: владелец пересылает файл Иванову.
  send('petrova', {
    type: 'direct_message',
    targetId: people.ivanov.id,
    text: 'otchet.txt',
    msgType: 'file',
    metadata: { file_id: fileId }
  });
  await waitFor(sockets.ivanov, (m) => m.type === 'direct_message' && m.message?.sender_id === people.petrova.id);
  const allowed = await api('GET', `/api/files/download/${fileId}`, { token: people.ivanov.token });
  assert.strictEqual(allowed.status, 200, allowed.text);
  assert.match(allowed.headers.get('content-disposition') || '', /^attachment/);
});

test('ссылка на файл №12 не даёт доступа к файлу №1', async () => {
  const FileService = require('../src/services/file.service');
  const { getDatabase } = require('../src/db');
  const db = getDatabase();
  const owner = db.prepare('SELECT id FROM files ORDER BY id LIMIT 1').get();
  const lookalike = Number(`${owner.id}2`);
  db.prepare(`
    INSERT INTO messages (conversation_type, target_id, sender_id, text, type, metadata_json, created_at)
    VALUES ('direct', ?, ?, 'x', 'file', ?, ?)
  `).run(people.sidorov.id, people.sidorov.id, JSON.stringify({ file_id: lookalike }), new Date().toISOString());

  assert.strictEqual(FileService.canUserAccessFile(people.sidorov.id, owner.id), false);
});

// ── Отметки о прочтении ─────────────────────────────────────────────────────

test('повторная отметка о прочтении ничего не рассылает', async () => {
  send('ivanov', { type: 'direct_message', targetId: people.petrova.id, text: 'Добрый день' });
  await waitFor(sockets.petrova, (m) => m.type === 'direct_message' && m.message?.text === 'Добрый день');

  send('petrova', { type: 'mark_read', conversationType: 'direct', targetId: people.ivanov.id });
  const first = await waitFor(sockets.ivanov, (m) => m.type === 'messages_read');
  assert.ok(first.messageIds.length >= 1);

  sockets.ivanov.inbox.length = 0;
  send('petrova', { type: 'mark_read', conversationType: 'direct', targetId: people.ivanov.id });
  await sleep(300);
  assert.ok(
    !sockets.ivanov.inbox.some((m) => m.type === 'messages_read'),
    'пустая отметка порождает встречную — так и зацикливались два открытых чата'
  );
});

// ── Звонки ──────────────────────────────────────────────────────────────────

test('ответ без вызова и отказ третьему не обрывают идущий разговор', async () => {
  await connect('sidorov');
  send('ivanov', { type: 'call_offer', targetUserId: people.petrova.id, sdp: 'relay' });
  await waitFor(sockets.petrova, (m) => m.type === 'call_offer');
  send('petrova', { type: 'call_answer', targetUserId: people.ivanov.id });
  await waitFor(sockets.ivanov, (m) => m.type === 'call_answer');
  assert.ok(await audioReaches('ivanov', 'petrova'), 'разговор должен начаться');

  // Сидоров «отвечает» Иванову, которому никто не звонил.
  send('sidorov', { type: 'call_answer', targetUserId: people.ivanov.id });
  await sleep(150);
  assert.ok(await audioReaches('ivanov', 'petrova'), 'ответ без вызова перехватил разговор');
  assert.ok(!(await audioReaches('ivanov', 'sidorov')), 'звук ушёл постороннему');

  // Сидоров звонит Иванову, тот занят и отказывает.
  send('sidorov', { type: 'call_offer', targetUserId: people.ivanov.id, sdp: 'relay' });
  await waitFor(sockets.ivanov, (m) => m.type === 'call_offer' && m.senderId === people.sidorov.id);
  send('ivanov', { type: 'call_rejected', targetUserId: people.sidorov.id });
  await sleep(150);
  assert.ok(await audioReaches('ivanov', 'petrova'), 'отказ третьему оборвал звук текущего разговора');
});

test('при обрыве связи собеседник узнаёт, что разговор окончен', async () => {
  sockets.petrova.inbox.length = 0;
  sockets.ivanov.sock.close();
  const ended = await waitFor(sockets.petrova, (m) => m.type === 'call_end');
  assert.strictEqual(ended.senderId, people.ivanov.id);
  await connect('ivanov');
});

// ── Удалённый рабочий стол ──────────────────────────────────────────────────

test('согласие на удалённый доступ может дать только сам сотрудник', async () => {
  send('admin', { type: 'rd_request', targetUserId: people.ivanov.id });
  const requested = await waitFor(sockets.admin, (m) => m.type === 'rd_requested');
  await waitFor(sockets.ivanov, (m) => m.type === 'rd_prompt');
  people.rdSession = requested.sessionId;

  send('admin', { type: 'rd_response', sessionId: requested.sessionId, accepted: true, accessLevel: 'full' });
  await sleep(250);
  assert.ok(
    !sockets.admin.inbox.some((m) => m.type === 'rd_response' && m.accepted),
    'оператор сам себе подтвердил доступ'
  );

  send('ivanov', { type: 'rd_response', sessionId: requested.sessionId, accepted: true, accessLevel: 'view_only' });
  const response = await waitFor(sockets.admin, (m) => m.type === 'rd_response');
  assert.strictEqual(response.accepted, true);
  assert.strictEqual(response.accessLevel, 'view_only');

  // Повторное «согласие» на уже решённый запрос ничего не меняет.
  sockets.admin.inbox.length = 0;
  send('ivanov', { type: 'rd_response', sessionId: requested.sessionId, accepted: true, accessLevel: 'full' });
  await sleep(200);
  assert.ok(!sockets.admin.inbox.some((m) => m.type === 'rd_response'));
});

test('сообщения сеанса доходят только второму участнику, а в режиме просмотра ввода нет вовсе', async () => {
  sockets.sidorov.inbox.length = 0;
  send('admin', {
    type: 'rd_webrtc_offer',
    sessionId: people.rdSession,
    targetUserId: people.sidorov.id,
    sdp: 'offer'
  });
  await waitFor(sockets.ivanov, (m) => m.type === 'rd_webrtc_offer');
  await sleep(150);
  assert.ok(!sockets.sidorov.inbox.some((m) => m.type === 'rd_webrtc_offer'), 'сообщение сеанса направлено постороннему');

  // Сотрудник разрешил только просмотр — управление с сервера не пропускается,
  // даже если клиент оператора его отправит.
  send('admin', {
    type: 'rd_input_event',
    sessionId: people.rdSession,
    targetUserId: people.ivanov.id,
    event: { type: 'mousemove', x: 0.5, y: 0.5 }
  });
  await sleep(250);
  assert.ok(!sockets.ivanov.inbox.some((m) => m.type === 'rd_input_event'), 'ввод прошёл при доступе «только просмотр»');
});

test('уход участника завершает сеанс у второго', async () => {
  sockets.admin.inbox.length = 0;
  sockets.ivanov.sock.close();
  const ended = await waitFor(sockets.admin, (m) => m.type === 'rd_end');
  assert.strictEqual(ended.sessionId, people.rdSession);
  await connect('ivanov');
});

test('оператор узнаёт причину отказа, а не просто «отказал»', async () => {
  send('admin', { type: 'rd_request', targetUserId: people.ivanov.id });
  const requested = await waitFor(sockets.admin, (m) => m.type === 'rd_requested' && m.sessionId !== people.rdSession);
  sockets.admin.inbox.length = 0;
  send('ivanov', { type: 'rd_response', sessionId: requested.sessionId, accepted: false, reason: 'busy' });
  const response = await waitFor(sockets.admin, (m) => m.type === 'rd_response');
  assert.strictEqual(response.accepted, false);
  assert.strictEqual(response.reason, 'busy');
});

// ── Поля и размеры ──────────────────────────────────────────────────────────

test('неизвестный статус и сверхдлинная подпись не принимаются', async () => {
  send('ivanov', { type: 'set_status', status: 'взломщик' });
  send('ivanov', { type: 'set_status', status: 'away', customStatus: 'ж'.repeat(5000) });
  const event = await waitFor(
    sockets.petrova,
    (m) => m.type === 'user_status_changed' && m.userId === people.ivanov.id && m.status === 'away'
  );
  assert.ok(String(event.customStatus || '').length <= 200, 'подпись не обрезана');
  assert.ok(
    !sockets.petrova.inbox.some((m) => m.type === 'user_status_changed' && m.status === 'взломщик'),
    'недопустимый статус разослан всем'
  );
});

test('слишком большое сообщение закрывает соединение, а не память сервера', async () => {
  const client = await connect('sidorov');
  client.sock.send(JSON.stringify({ type: 'typing', padding: 'x'.repeat(20 * 1024 * 1024) }));
  const started = Date.now();
  while (!client.closed && Date.now() - started < 4000) await sleep(50);
  assert.ok(client.closed);
  assert.strictEqual(client.closeCode, 1009);
});

// ── Границы администратора подразделения ────────────────────────────────────

test('администратор подразделения не выводит сотрудника из своего контура «пустым» отделом', async () => {
  const OrgService = require('../src/services/org.service');
  const { identity } = require('../src/db/identity');
  const dept = await OrgService.createDepartment({ name: 'Отдел урегулирования' });
  const scopedRole = await identity().get('SELECT id FROM roles WHERE name = $1', ['Контурный администратор']);

  const boss = await UserService.createUser({ username: 'nachalnik', full_name: 'Начальник Отдела', password: 'Парольначальника-1' });
  await UserService.adminUpdateUser(boss.id, { role_id: scopedRole.id, admin_scope_dept_id: dept.id, department_id: dept.id });
  await UserService.setMustChangePassword(boss.id, false);
  const bossToken = AuthService.generateToken(await UserService.getUserById(boss.id));

  const inScope = await UserService.createUser({ username: 'podchinenny', full_name: 'Подчинённый Павел', password: 'Парольподчинённого-1', department_id: dept.id });

  const unassign = await api('PUT', `/api/admin/users/${inScope.id}`, { token: bossToken, body: { department_id: null } });
  assert.strictEqual(unassign.status, 400, 'сотрудник выведен из контура');
  assert.strictEqual((await UserService.getUserById(inScope.id)).department_id, dept.id);

  const noDept = await api('POST', '/api/admin/users', {
    token: bossToken,
    body: { username: 'bezotdela', full_name: 'Без Отдела', password: 'Парольбезотдела-1' }
  });
  assert.strictEqual(noDept.status, 400, 'заведён сотрудник вне чьего-либо контура');

  const ok = await api('POST', '/api/admin/users', {
    token: bossToken,
    body: { username: 'vkonture', full_name: 'В Контуре', password: 'Парольвконтуре-1', department_id: dept.id }
  });
  assert.strictEqual(ok.status, 201, ok.text);
});

test('фотография профиля: новая проверяется, прежняя не мешает сохранению', async () => {
  const { identity } = require('../src/db/identity');
  await identity().run('UPDATE users SET avatar_url = $1 WHERE id = $2', ['https://old.example/photo.png', people.petrova.id]);

  // Форма отправляет прежнюю фотографию обратно вместе с новым телефоном.
  const saved = await UserService.updateProfile(people.petrova.id, {
    phone: '2101',
    avatar_url: 'https://old.example/photo.png'
  });
  assert.strictEqual(saved.phone, '2101');

  await assert.rejects(
    () => UserService.updateProfile(people.petrova.id, { avatar_url: 'javascript:alert(1)' }),
    /изображением/
  );
  await assert.rejects(
    () => UserService.updateProfile(people.petrova.id, { avatar_url: `data:image/png;base64,${'A'.repeat(800 * 1024)}` }),
    /слишком большая/
  );
  // Одна сигнатура PNG без картинки — не фотография (задача 20: фото
  // перекодируется, и то, что не декодируется, не сохраняется).
  await assert.rejects(
    () => UserService.updateProfile(people.petrova.id, { avatar_url: 'data:image/png;base64,iVBORw0KGgo=' }),
    /изображением/
  );
  const png = await require('sharp')({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer();
  const small = `data:image/png;base64,${png.toString('base64')}`;
  const updated = await UserService.updateProfile(people.petrova.id, { avatar_url: small });
  // Сохраняется перекодированная копия — тем же data URL (JPEG без метаданных).
  assert.match(updated.avatar_url, /^data:image\/jpeg;base64,/);
});

// ── Общие каналы ────────────────────────────────────────────────────────────

test('сотрудник, заведённый администратором, сразу состоит в общих каналах', async () => {
  // Найдено стендом: заведённый через консоль видел «Общий» в списке, а сервер
  // отвечал 403 на чтение и не принимал его сообщения. В каналы добавляли
  // только при одобрении заявки и при импорте.
  const created = await api('POST', '/api/admin/users', {
    token: people.admin.token,
    body: { username: 'novyi', full_name: 'Новый Сотрудник', password: 'Парольнового-1' }
  });
  assert.strictEqual(created.status, 201, created.text);
  await UserService.setMustChangePassword(created.json.id, false);
  const token = AuthService.generateToken(await UserService.getUserById(created.json.id));

  const channels = await api('GET', '/api/channels', { token });
  const general = channels.json.find((c) => c.type === 'system');
  assert.ok(general, 'системный канал должен быть в списке');

  const history = await api('GET', `/api/messages/channels/${general.id}`, { token });
  assert.strictEqual(history.status, 200, history.text);
});

test('при запуске уже заведённые сотрудники получают членство в общих каналах', async () => {
  const { getDatabase } = require('../src/db');
  const db = getDatabase();
  db.prepare(`DELETE FROM channel_members WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE type = 'system')`)
    .run(people.sidorov.id);

  const { syncDefaultChannelMembers } = require('../src/bootstrap');
  const added = await syncDefaultChannelMembers();
  assert.ok(added >= 1, `добавлено ${added}`);

  const systemCount = db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE type = 'system'`).get().n;
  const memberCount = db
    .prepare(`SELECT COUNT(*) AS n FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE c.type = 'system' AND cm.user_id = ?`)
    .get(people.sidorov.id).n;
  assert.strictEqual(memberCount, systemCount);

  // Повторный запуск ничего не дублирует.
  assert.strictEqual(await syncDefaultChannelMembers(), 0);
});

test('журнал ознакомления с распоряжением сотруднику недоступен', async () => {
  const created = await api('POST', '/api/announcements', {
    token: people.admin.token,
    body: { title: 'Приказ', content: 'Ознакомиться', priority: 'normal' }
  });
  assert.strictEqual(created.status, 201, created.text);

  const asEmployee = await api('GET', `/api/announcements/${created.json.id}/audit`, { token: people.petrova.token });
  assert.strictEqual(asEmployee.status, 403);

  const asAdmin = await api('GET', `/api/announcements/${created.json.id}/audit`, { token: people.admin.token });
  assert.strictEqual(asAdmin.status, 200, asAdmin.text);
});
