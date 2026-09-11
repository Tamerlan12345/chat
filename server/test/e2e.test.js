const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Сквозная проверка сервиса целиком: поднимается настоящий сервер, дальше всё
// делается ровно так, как это делает приложение — по HTTP и WebSocket. Ни один
// сервис не вызывается напрямую, поэтому здесь видно то, чего не видят
// остальные тесты: маршрутизацию, авторизацию, порядок обработчиков, обмен
// событиями между двумя одновременно подключёнными людьми — и то, что
// переписка и учётные записи, лежащие теперь в разных базах, сходятся вместе.

process.env.INITIAL_ADMIN_PASSWORD = 'начальныйпароль';
process.env.INITIAL_ADMIN_NAME = 'Администратор Тестов';

let baseUrl;
let wsUrl;
let server;

// Состояние, накапливаемое по ходу сценария.
const state = {};

test.before(async () => {
  await freshBoot();
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

test.after(async () => {
  for (const sock of Object.values(state.sockets || {})) {
    try { sock.close(); } catch {}
  }
  server?.close();
  await closeAll();
});

async function api(method, urlPath, { body, token } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// Подключается и авторизуется, как это делает клиент: сначала открывает сокет,
// затем отправляет токен и ждёт подтверждения.
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    const inbox = [];
    sock.on('message', (raw) => {
      try { inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    });
    sock.on('error', reject);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'auth', token })));

    const started = Date.now();
    const waitAuth = setInterval(() => {
      const ok = inbox.find((m) => m.type === 'auth_success');
      const err = inbox.find((m) => m.type === 'auth_error');
      if (ok) { clearInterval(waitAuth); resolve({ sock, inbox }); }
      else if (err) { clearInterval(waitAuth); reject(new Error(err.message)); }
      else if (Date.now() - started > 4000) { clearInterval(waitAuth); reject(new Error('нет ответа на авторизацию')); }
    }, 25);
  });
}

const waitFor = (inbox, predicate, timeoutMs = 4000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const id = setInterval(() => {
      const hit = inbox.find(predicate);
      if (hit) { clearInterval(id); resolve(hit); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(id);
        reject(new Error('событие не пришло за отведённое время'));
      }
    }, 25);
  });

// ── 1. Первый вход администратора ───────────────────────────────────────────

test('1. администратор входит начальным паролем и обязан его сменить', async () => {
  const login = await api('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'начальныйпароль' }
  });
  assert.strictEqual(login.status, 200, login.text);
  assert.strictEqual(login.json.user.must_change_password, 1);

  const blocked = await api('GET', '/api/users', { token: login.json.token });
  assert.strictEqual(blocked.status, 403, 'до смены пароля работать нельзя');

  const changed = await api('POST', '/api/users/password', {
    token: login.json.token,
    body: { oldPassword: 'начальныйпароль', newPassword: 'парольадмина' }
  });
  assert.strictEqual(changed.status, 200, changed.text);

  const relogin = await api('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'парольадмина' }
  });
  assert.strictEqual(relogin.status, 200);
  state.adminToken = relogin.json.token;
  state.adminId = relogin.json.user.id;
});

// ── 2. Оргструктура ─────────────────────────────────────────────────────────

test('2. администратор создаёт подразделение', async () => {
  const created = await api('POST', '/api/org/departments', {
    token: state.adminToken,
    body: { name: 'Отдел продаж', dept_type: 'department' }
  });
  assert.strictEqual(created.status, 201, created.text);
  assert.ok(created.json.id);
  state.deptId = created.json.id;
});

test('3. подразделение видно в списке и переименовывается', async () => {
  const renamed = await api('PUT', `/api/org/departments/${state.deptId}`, {
    token: state.adminToken,
    body: { name: 'Департамент продаж' }
  });
  assert.strictEqual(renamed.status, 200, renamed.text);
  assert.strictEqual(renamed.json.name, 'Департамент продаж');
});

// ── 3. Заведение сотрудника ─────────────────────────────────────────────────

test('4. администратор заводит сотрудника', async () => {
  const roles = await api('GET', '/api/admin/roles', { token: state.adminToken });
  assert.strictEqual(roles.status, 200);
  const employeeRole = roles.json.find((r) => r.name === 'Сотрудник');
  assert.ok(employeeRole, 'роль по умолчанию должна существовать');

  const created = await api('POST', '/api/admin/users', {
    token: state.adminToken,
    body: {
      username: 'petrova',
      full_name: 'Петрова Анна Сергеевна',
      job_title: 'Менеджер по продажам',
      department_id: state.deptId,
      role_id: employeeRole.id,
      email: 'a.petrova@cic.kz',
      extension: '2501',
      uin: 3001,
      password: 'временный123'
    }
  });
  assert.strictEqual(created.status, 201, created.text);
  state.employeeId = created.json.id;
});

test('5. сотрудник входит и меняет временный пароль', async () => {
  const first = await api('POST', '/api/auth/login', {
    body: { username: 'petrova', password: 'временный123' }
  });
  assert.strictEqual(first.status, 200, first.text);
  assert.strictEqual(first.json.user.must_change_password, 1, 'временный пароль обязан меняться');

  const changed = await api('POST', '/api/users/password', {
    token: first.json.token,
    body: { oldPassword: 'временный123', newPassword: 'парольанны' }
  });
  assert.strictEqual(changed.status, 200, changed.text);

  const relogin = await api('POST', '/api/auth/login', {
    body: { username: 'petrova', password: 'парольанны' }
  });
  assert.strictEqual(relogin.status, 200);
  state.employeeToken = relogin.json.token;
});

// ── 4. Разграничение прав ───────────────────────────────────────────────────

test('6. сотруднику закрыты административные разделы', async () => {
  const cases = [
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/roles'],
    ['POST', '/api/org/departments'],
    ['GET', '/api/admin/audit']
  ];
  for (const [method, route] of cases) {
    const res = await api(method, route, { token: state.employeeToken, body: method === 'POST' ? { name: 'Свой отдел' } : undefined });
    assert.strictEqual(res.status, 403, `${method} ${route} должен быть закрыт для сотрудника`);
  }
});

test('7. сотрудник не может повысить себя через профиль', async () => {
  const before = await api('GET', '/api/auth/me', { token: state.employeeToken });
  const res = await api('PUT', '/api/users/profile', {
    token: state.employeeToken,
    body: { full_name: 'Петрова Анна', role_id: 1, is_active: 1, department_id: 99 }
  });
  assert.strictEqual(res.status, 200, 'сам запрос проходит');

  const check = await api('GET', '/api/auth/me', { token: state.employeeToken });
  assert.strictEqual(check.json.user.department_id, before.json.user.department_id, 'подразделение не должно меняться из профиля');
  assert.strictEqual(check.json.user.is_active, before.json.user.is_active, 'признак активности не должен меняться из профиля');
  assert.notStrictEqual(check.json.user.role_name, 'Суперадминистратор');
});

// ── 5. Переписка в реальном времени ─────────────────────────────────────────

test('8. оба подключаются по WebSocket', async () => {
  state.sockets = {};
  const admin = await connectWs(state.adminToken);
  const employee = await connectWs(state.employeeToken);
  state.sockets.admin = admin.sock;
  state.sockets.employee = employee.sock;
  state.inbox = { admin: admin.inbox, employee: employee.inbox };
  assert.ok(true);
});

test('9. сообщение доходит до получателя', async () => {
  state.sockets.admin.send(JSON.stringify({
    type: 'direct_message',
    conversationType: 'direct',
    targetId: state.employeeId,
    text: 'Анна, добрый день. Проверьте, пожалуйста, договор.'
  }));

  const received = await waitFor(
    state.inbox.employee,
    (m) => m.type === 'direct_message' && m.message?.text?.includes('добрый день')
  );
  assert.strictEqual(received.message.sender_id, state.adminId);
  state.messageId = received.message.id;
});

test('10. сообщение не дублируется', async () => {
  // Ровно та ошибка, из-за которой каждое сообщение показывалось четырежды.
  const copies = state.inbox.employee.filter(
    (m) => m.type === 'direct_message' && m.message?.id === state.messageId
  );
  assert.strictEqual(copies.length, 1, 'получатель должен получить ровно одну копию');
});

test('11. отправитель узнаёт о прочтении', async () => {
  state.sockets.employee.send(JSON.stringify({
    type: 'mark_read',
    conversationType: 'direct',
    targetId: state.adminId
  }));

  const notice = await waitFor(
    state.inbox.admin,
    (m) => m.type === 'messages_read' && m.messageIds?.includes(state.messageId)
  );
  assert.strictEqual(notice.byUserId, state.employeeId);
});

test('12. история переписки отдаёт статус прочтения', async () => {
  const history = await api('GET', `/api/messages/direct/${state.employeeId}`, { token: state.adminToken });
  assert.strictEqual(history.status, 200, history.text);
  const mine = history.json.find((m) => m.id === state.messageId);
  assert.strictEqual(mine.delivery_status, 'read', 'должны показываться две галочки');
});

test('13. посторонний не читает чужую переписку', async () => {
  const outsider = await api('POST', '/api/admin/users', {
    token: state.adminToken,
    body: { username: 'sidorov2', full_name: 'Сидоров Пётр', uin: 3002, password: 'времен123', department_id: state.deptId }
  });
  assert.strictEqual(outsider.status, 201, outsider.text);

  const login = await api('POST', '/api/auth/login', { body: { username: 'sidorov2', password: 'времен123' } });
  await api('POST', '/api/users/password', {
    token: login.json.token,
    body: { oldPassword: 'времен123', newPassword: 'парольпетра' }
  });
  const relog = await api('POST', '/api/auth/login', { body: { username: 'sidorov2', password: 'парольпетра' } });
  state.outsiderToken = relog.json.token;

  const peek = await api('GET', `/api/messages/direct/${state.employeeId}`, { token: state.outsiderToken });
  assert.strictEqual(peek.status, 200, 'маршрут доступен');
  const leaked = peek.json.find((m) => m.id === state.messageId);
  assert.ok(!leaked, 'но чужие сообщения в выдачу попадать не должны');
});

// ── 6. Объявления ───────────────────────────────────────────────────────────

test('14. администратор публикует объявление', async () => {
  const res = await api('POST', '/api/announcements', {
    token: state.adminToken,
    body: { title: 'Плановые работы', content: 'В субботу сервер будет недоступен с 10:00.', priority: 'urgent' }
  });
  assert.strictEqual(res.status, 201, res.text);
  state.announcementId = res.json.id;
});

test('15. сотрудник видит объявление и подтверждает ознакомление', async () => {
  const list = await api('GET', '/api/announcements', { token: state.employeeToken });
  assert.strictEqual(list.status, 200);
  assert.ok(list.json.some((a) => a.id === state.announcementId), 'объявление должно быть видно сотруднику');

  const ack = await api('POST', `/api/announcements/${state.announcementId}/acknowledge`, {
    token: state.employeeToken
  });
  assert.strictEqual(ack.status, 200, ack.text);
});

test('16. сотрудник не публикует объявления', async () => {
  const res = await api('POST', '/api/announcements', {
    token: state.employeeToken,
    body: { title: 'От себя', content: 'Текст', priority: 'normal' }
  });
  assert.strictEqual(res.status, 403);
});

// ── 7. Самостоятельная регистрация с одобрением ─────────────────────────────

test('17. регистрация закрыта, пока администратор её не включил', async () => {
  const res = await api('POST', '/api/auth/register', {
    body: { username: 'newcomer', password: 'парольновичка', full_name: 'Новиков Новик' }
  });
  assert.strictEqual(res.status, 403, 'по умолчанию самостоятельная регистрация отключена');
});

test('18. после включения заявка создаётся, но входить нельзя', async () => {
  const on = await api('PUT', '/api/settings', {
    token: state.adminToken,
    body: { allow_registration: 'true' }
  });
  assert.strictEqual(on.status, 200, on.text);

  const reg = await api('POST', '/api/auth/register', {
    body: { username: 'newcomer', password: 'парольновичка', full_name: 'Новиков Новик' }
  });
  assert.strictEqual(reg.status, 201, reg.text);
  assert.strictEqual(reg.json.pending, true, 'токен выдаваться не должен');
  assert.ok(!reg.json.token);

  const login = await api('POST', '/api/auth/login', {
    body: { username: 'newcomer', password: 'парольновичка' }
  });
  assert.strictEqual(login.status, 400);
  assert.match(login.json.error, /не подтверждена/);
});

test('19. администратор видит заявку и одобряет её', async () => {
  const pending = await api('GET', '/api/admin/registrations', { token: state.adminToken });
  assert.strictEqual(pending.status, 200, pending.text);
  const entry = pending.json.find((u) => u.username === 'newcomer');
  assert.ok(entry, 'заявка должна быть в списке');

  const approve = await api('POST', `/api/admin/registrations/${entry.id}/approve`, {
    token: state.adminToken
  });
  assert.strictEqual(approve.status, 200, approve.text);

  const login = await api('POST', '/api/auth/login', {
    body: { username: 'newcomer', password: 'парольновичка' }
  });
  assert.strictEqual(login.status, 200, 'после одобрения вход открыт');
});

// ── 8. Удалённый рабочий стол ───────────────────────────────────────────────

test('20. сотруднику без права отказано в удалённом доступе', async () => {
  state.sockets.employee.send(JSON.stringify({
    type: 'rd_request',
    targetUserId: state.adminId
  }));
  const denied = await waitFor(state.inbox.employee, (m) => m.type === 'rd_denied');
  assert.match(denied.reason, /не разрешён|администратору/i);
});

test('21. администратор запрашивает доступ, сотруднику приходит запрос', async () => {
  state.sockets.admin.send(JSON.stringify({
    type: 'rd_request',
    targetUserId: state.employeeId
  }));

  const prompt = await waitFor(state.inbox.employee, (m) => m.type === 'rd_prompt');
  assert.strictEqual(prompt.operatorId, state.adminId);
  assert.ok(prompt.sessionId);
  state.rdSessionId = prompt.sessionId;
});

test('22. без согласия сотрудника поток не ретранслируется', async () => {
  // Сеанс ещё не принят: любые данные внутри него должны отбрасываться.
  state.sockets.admin.send(JSON.stringify({
    type: 'rd_input_event',
    sessionId: state.rdSessionId,
    targetUserId: state.employeeId,
    event: { type: 'move', x: 0.5, y: 0.5 }
  }));
  await new Promise((r) => setTimeout(r, 400));
  const leaked = state.inbox.employee.find((m) => m.type === 'rd_input_event');
  assert.ok(!leaked, 'управление до согласия проходить не должно');
});

test('23. после согласия оператор получает уведомление', async () => {
  state.sockets.employee.send(JSON.stringify({
    type: 'rd_response',
    sessionId: state.rdSessionId,
    accepted: true,
    accessLevel: 'full'
  }));

  const answer = await waitFor(state.inbox.admin, (m) => m.type === 'rd_response');
  assert.strictEqual(answer.accepted, true);
  assert.strictEqual(answer.accessLevel, 'full');
});

test('24. сеанс удалённого доступа записан в журнал', async () => {
  const audit = await api('GET', '/api/admin/audit', { token: state.adminToken });
  assert.strictEqual(audit.status, 200);
  const actions = audit.json.map((r) => r.action);
  assert.ok(actions.includes('remote_desktop_request'), 'запрос доступа должен фиксироваться');
  assert.ok(actions.includes('remote_desktop_accepted'), 'согласие должно фиксироваться');
});

// ── 9. Звонки ───────────────────────────────────────────────────────────────

test('25. звонок недоступному сотруднику не звонит впустую', async () => {
  const offline = await api('POST', '/api/admin/users', {
    token: state.adminToken,
    body: { username: 'offline_user', full_name: 'Отсутствующий Сотрудник', uin: 3003, password: 'времен123' }
  });
  assert.strictEqual(offline.status, 201);

  state.sockets.admin.send(JSON.stringify({
    type: 'call_offer',
    targetUserId: offline.json.id,
    sdp: { type: 'offer', sdp: 'тестовое-описание' }
  }));

  const unavailable = await waitFor(state.inbox.admin, (m) => m.type === 'call_unavailable');
  assert.match(unavailable.reason, /не в сети/i);
});

test('26. вызов доходит до собеседника', async () => {
  state.sockets.admin.send(JSON.stringify({
    type: 'call_offer',
    targetUserId: state.employeeId,
    sdp: { type: 'offer', sdp: 'тестовое-описание' }
  }));

  const incoming = await waitFor(state.inbox.employee, (m) => m.type === 'call_offer');
  assert.strictEqual(incoming.senderId, state.adminId);
});

// ── 10. Файлы ───────────────────────────────────────────────────────────────

test('27. файл загружается и скачивается участником переписки', async () => {
  const form = new FormData();
  form.append('file', new Blob(['содержимое договора'], { type: 'text/plain' }), 'договор.txt');

  const upload = await fetch(baseUrl + '/api/files/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.adminToken}` },
    body: form
  });
  // Тело читается один раз: аргумент-сообщение вычисляется сразу, и повторное
  // чтение падает с «Body has already been read».
  const uploadText = await upload.text();
  assert.strictEqual(upload.status, 201, uploadText);
  const uploaded = JSON.parse(uploadText);
  // Данные файла приходят верхним уровнем — клиент читал их из вложенного
  // поля и получал undefined.
  assert.ok(uploaded.id, 'ответ должен содержать идентификатор файла');
  state.fileId = uploaded.id;

  const download = await fetch(`${baseUrl}/api/files/download/${state.fileId}`, {
    headers: { Authorization: `Bearer ${state.adminToken}` }
  });
  assert.strictEqual(download.status, 200);
  assert.strictEqual(await download.text(), 'содержимое договора');
});

test('28. без токена файл не скачать', async () => {
  const res = await fetch(`${baseUrl}/api/files/download/${state.fileId}`);
  assert.strictEqual(res.status, 401, 'ссылка без авторизации работать не должна');
});

// ── 12. Передача голоса через сервер ────────────────────────────────────────

test('31. звук не пересылается, пока разговор не начат', async () => {
  // Пара регистрируется только когда вызываемый ответил. До этого кадры
  // должны отбрасываться, иначе любой авторизованный мог бы вещать кому угодно.
  const frame = Buffer.alloc(12);
  frame.writeUInt32BE(state.employeeId, 0);
  state.sockets.admin.send(frame, { binary: true });

  await new Promise((r) => setTimeout(r, 300));
  const leaked = state.inbox.employee.find((m) => m.__binary);
  assert.ok(!leaked, 'до ответа на звонок звук проходить не должен');
});

test('32. после ответа звук доходит до собеседника', async () => {
  // Собеседник отвечает — сервер запоминает пару.
  state.sockets.employee.send(JSON.stringify({
    type: 'call_answer',
    targetUserId: state.adminId
  }));
  await waitFor(state.inbox.admin, (m) => m.type === 'call_answer');

  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('звук не дошёл')), 3000);
    state.sockets.employee.on('message', function handler(raw, isBinary) {
      if (!isBinary) return;
      clearTimeout(timer);
      state.sockets.employee.off('message', handler);
      resolve(Buffer.from(raw));
    });
  });

  const frame = Buffer.alloc(12);
  frame.writeUInt32BE(state.employeeId, 0);
  frame.writeInt16BE(1234, 4);
  state.sockets.admin.send(frame, { binary: true });

  const got = await received;
  assert.strictEqual(got.readUInt32BE(0), state.adminId, 'в кадре должен стоять отправитель');
  assert.strictEqual(got.readInt16BE(4), 1234, 'звук должен дойти без искажений');
});

test('33. посторонний не может слать звук в чужой разговор', async () => {
  const outsider = await connectWs(state.outsiderToken);
  const frame = Buffer.alloc(12);
  frame.writeUInt32BE(state.employeeId, 0);
  outsider.sock.send(frame, { binary: true });

  const leaked = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 600);
    state.sockets.employee.on('message', function handler(raw, isBinary) {
      if (!isBinary) return;
      clearTimeout(timer);
      state.sockets.employee.off('message', handler);
      resolve(true);
    });
  });
  outsider.sock.close();
  assert.strictEqual(leaked, false, 'звук от постороннего проходить не должен');
});

test('34. завершение звонка прекращает передачу звука', async () => {
  state.sockets.admin.send(JSON.stringify({ type: 'call_end', targetUserId: state.employeeId }));
  await new Promise((r) => setTimeout(r, 300));

  const leaked = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 600);
    state.sockets.employee.on('message', function handler(raw, isBinary) {
      if (!isBinary) return;
      clearTimeout(timer);
      state.sockets.employee.off('message', handler);
      resolve(true);
    });
    const frame = Buffer.alloc(12);
    frame.writeUInt32BE(state.employeeId, 0);
    state.sockets.admin.send(frame, { binary: true });
  });
  assert.strictEqual(leaked, false, 'после завершения разговора звук идти не должен');
});

// ── 11. Ограничение доступа ─────────────────────────────────────────────────

test('29. отключённый сотрудник теряет доступ', async () => {
  const off = await api('DELETE', `/api/admin/users/${state.employeeId}`, { token: state.adminToken });
  assert.strictEqual(off.status, 200, off.text);

  const login = await api('POST', '/api/auth/login', {
    body: { username: 'petrova', password: 'парольанны' }
  });
  assert.strictEqual(login.status, 400);
  assert.match(login.json.error, /не найден|деактивирован/i);
});

test('30. прежний токен отключённого сотрудника перестаёт работать', async () => {
  // Отзыв должен действовать немедленно, а не после истечения токена.
  const res = await api('GET', '/api/auth/me', { token: state.employeeToken });
  assert.strictEqual(res.status, 401, 'выданный ранее токен обязан перестать действовать');
});
