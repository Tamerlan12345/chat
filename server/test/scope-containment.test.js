const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Задача 2 плана «безопасность раунд 3»: закрывает находки аудита №2, №3, №4,
// №10, №11.
//   №2  — администратор подразделения мог сам снять с себя область
//         (admin_scope_dept_id: null) и импортом задеть кого угодно, включая
//         администраторов и сотрудников вне области.
//   №3  — адресное оповещение при создании уходило полным текстом всем
//         подключённым сокетам, а не только адресатам.
//   №4  — проверка is_admin (а не can_broadcast) пускала контурного
//         администратора рассылать оповещения и читать чужой журнал
//         ознакомления.
//   №10 — подтверждение ознакомления принималось для несуществующего или не
//         адресованного оповещения и рассылалось всем.
//   №11 — создание приватного канала объявлялось всем сокетам.
// Каждый тест воспроизводит конкретный сценарий, который до исправления
// проходил бы.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let wsUrl;
let server;
let identity;
let UserService;
let AuthService;
let OrgParserService;
const people = {};
const sockets = {};

test.before(async () => {
  ({ identity } = await freshBoot());
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  OrgParserService = require('../src/services/org-parser.service');
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, dept: admin.department_id };

  const scopedRoleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;

  // Отдельная роль: контурный администратор, но с правом рассылки — такой
  // роли из коробки нет (у Контурного администратора can_broadcast:false), а
  // находка №4 как раз про различение "is_admin вообще" и "can_broadcast".
  const broadcasterRoleId = Number(
    (
      await identity.run(
        `INSERT INTO roles (name, description, permissions_json) VALUES ($1, $2, $3) RETURNING id`,
        [
          'Контурный администратор с рассылкой',
          'Тестовая роль',
          JSON.stringify({ is_admin: true, is_scoped_admin: true, can_broadcast: true, can_manage_users: true })
        ]
      )
    ).rows[0].id
  );

  // Область для обычного контурного администратора — тот же отдел, что и у
  // других тестов набора (не top-level: id=2, parent=1 в чистой установке).
  people.scoped = await UserService.createUser({
    username: 'scoped', full_name: 'Начальник Отдела', password: 'Рабочий-пароль-1',
    role_id: scopedRoleId, department_id: admin.department_id, admin_scope_dept_id: admin.department_id
  });
  await UserService.setMustChangePassword(people.scoped.id, false);

  people.broadcaster = await UserService.createUser({
    username: 'broadcaster', full_name: 'Начальник С Рассылкой', password: 'Рабочий-пароль-1',
    role_id: broadcasterRoleId, department_id: admin.department_id, admin_scope_dept_id: admin.department_id
  });
  await UserService.setMustChangePassword(people.broadcaster.id, false);

  for (const [username, full_name] of [
    ['ivanov', 'Иванов Иван'],
    ['petrova', 'Петрова Анна'],
    ['sidorov', 'Сидоров Пётр']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = created;
  }

  for (const name of Object.keys(people)) {
    people[name].token = AuthService.generateToken(await UserService.getUserById(people[name].id));
  }
});

test.after(async () => {
  const wsServer = require('../src/ws/server');
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, urlPath, { body, token, headers = {} } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

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

// ── Находка №2 (дефект A): scoped-админ не снимает с себя область ─────────

test('scoped-админ не может снять с себя область через admin_scope_dept_id: null', async () => {
  const res = await api('PUT', `/api/admin/users/${people.scoped.id}`, {
    token: people.scoped.token,
    body: { admin_scope_dept_id: null }
  });
  // Тот же код ответа, что и у остальных нарушений assertWithinAdminScope в
  // этом файле (см. security-hardening.test.js) — маршрут ловит исключение и
  // всегда отвечает 400, отдельного пути на 403 здесь нет.
  assert.strictEqual(res.status, 400, res.text);

  const after = await UserService.getUserById(people.scoped.id);
  assert.strictEqual(after.admin_scope_dept_id, people.admin.dept);
});

test('scoped-админ не может подменить себе область и любым другим значением ключа', async () => {
  const res = await api('PUT', `/api/admin/users/${people.scoped.id}`, {
    token: people.scoped.token,
    body: { admin_scope_dept_id: 999999 }
  });
  assert.strictEqual(res.status, 400, res.text);
  const after = await UserService.getUserById(people.scoped.id);
  assert.strictEqual(after.admin_scope_dept_id, people.admin.dept);
});

// ── Находка №2 (дефект B): импорт не выходит за область ────────────────────

test('applyImport: scoped-админ без назначенной области — отказ без изменений', async () => {
  const before = await identity.all('SELECT id FROM users');
  await assert.rejects(
    () => OrgParserService.applyImport({
      parsedData: { departments: [], employees: [{ full_name: 'Кто-то Новый', username: 'ktoto', department_path: undefined }] },
      defaultPassword: 'Рабочий-пароль-1',
      adminScopeDeptId: null,
      actorIsScopedAdmin: true
    }),
    /подразделение/
  );
  const after = await identity.all('SELECT id FROM users');
  assert.strictEqual(after.length, before.length, 'ни одной строки не должно было появиться');
});

test('маршрут /admin/org/batch-import: у контурного администратора без области импорт отклоняется', async () => {
  const noScope = await UserService.createUser({
    username: 'scoped-noscope', full_name: 'Без Области', password: 'Рабочий-пароль-1',
    role_id: (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id
  });
  await UserService.setMustChangePassword(noScope.id, false);
  const token = AuthService.generateToken(await UserService.getUserById(noScope.id));

  const res = await api('POST', '/api/admin/org/batch-import', {
    token,
    body: { text: 'Отдел / Тестовый Тестов | testtestov', format: 'auto' }
  });
  assert.strictEqual(res.status, 400, res.text);
  const row = await identity.get('SELECT id FROM users WHERE username = $1', ['testtestov']);
  assert.ok(!row, 'сотрудник не должен был появиться');
});

test('applyImport: строка, совпадающая с сотрудником вне области, не меняет его', async () => {
  const scopeDept = (await identity.run(
    `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
     VALUES (NULL, $1, '', 'branch', 70, $2) RETURNING id`,
    ['Контур Импорта А', new Date().toISOString()]
  )).rows[0];

  const outsider = await UserService.createUser({
    username: 'import-outsider', full_name: 'Вне Области Импорта', password: 'Рабочий-пароль-1',
    job_title: 'Старая должность', department_id: people.admin.dept
  });

  const parsedData = {
    departments: [{ full_path: 'Контур Импорта А', parent_path: null, name: 'Контур Импорта А', dept_type: 'branch' }],
    employees: [{
      full_name: outsider.full_name, username: outsider.username,
      department_path: 'Контур Импорта А', job_title: 'Новая должность', email: 'new@example.com'
    }]
  };

  const result = await OrgParserService.applyImport({
    parsedData, defaultPassword: 'Рабочий-пароль-1', adminScopeDeptId: Number(scopeDept.id), actorIsScopedAdmin: true
  });
  assert.strictEqual(result.updatedUsers, 0);
  assert.ok(result.skippedOutOfScope >= 1);

  const after = await identity.get('SELECT job_title, email, department_id FROM users WHERE id = $1', [outsider.id]);
  assert.strictEqual(after.job_title, 'Старая должность');
  assert.strictEqual(after.email, outsider.email, 'email не должен был перезаписаться новым из строки импорта');
  assert.notStrictEqual(after.email, 'new@example.com');
  assert.strictEqual(Number(after.department_id), Number(people.admin.dept));
});

test('applyImport: строка, совпадающая с администратором внутри области, не меняет его', async () => {
  const scopeDept = (await identity.run(
    `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
     VALUES (NULL, $1, '', 'branch', 71, $2) RETURNING id`,
    ['Контур Импорта Б', new Date().toISOString()]
  )).rows[0];

  const scopedRoleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;
  const adminInside = await UserService.createUser({
    username: 'import-admin-inside', full_name: 'Администратор В Контуре', password: 'Рабочий-пароль-1',
    role_id: scopedRoleId, department_id: Number(scopeDept.id), job_title: 'Начальник'
  });

  const parsedData = {
    departments: [{ full_path: 'Контур Импорта Б', parent_path: null, name: 'Контур Импорта Б', dept_type: 'branch' }],
    employees: [{
      full_name: adminInside.full_name, username: adminInside.username,
      department_path: 'Контур Импорта Б', job_title: 'Понижен импортом'
    }]
  };

  const result = await OrgParserService.applyImport({
    parsedData, defaultPassword: 'Рабочий-пароль-1', adminScopeDeptId: Number(scopeDept.id), actorIsScopedAdmin: true
  });
  assert.strictEqual(result.updatedUsers, 0, 'администратора импорт трогать не должен, даже если он внутри области');

  const after = await identity.get('SELECT job_title FROM users WHERE id = $1', [adminInside.id]);
  assert.strictEqual(after.job_title, 'Начальник');
});

test('applyImport: обычного сотрудника внутри области импорт по-прежнему обновляет', async () => {
  const scopeDept = (await identity.run(
    `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
     VALUES (NULL, $1, '', 'branch', 72, $2) RETURNING id`,
    ['Контур Импорта В', new Date().toISOString()]
  )).rows[0];

  const ordinary = await UserService.createUser({
    username: 'import-ordinary', full_name: 'Обычный Сотрудник Импорта', password: 'Рабочий-пароль-1',
    department_id: Number(scopeDept.id), job_title: 'Специалист'
  });

  const parsedData = {
    departments: [],
    employees: [{ full_name: ordinary.full_name, username: ordinary.username, job_title: 'Старший специалист' }]
  };

  const result = await OrgParserService.applyImport({
    parsedData, defaultPassword: 'Рабочий-пароль-1', adminScopeDeptId: Number(scopeDept.id), actorIsScopedAdmin: true
  });
  assert.strictEqual(result.updatedUsers, 1, 'без ограничивающих находок обновление внутри области должно проходить');

  const after = await identity.get('SELECT job_title FROM users WHERE id = $1', [ordinary.id]);
  assert.strictEqual(after.job_title, 'Старший специалист');
});

// ── Находка №4: create/audit требуют can_broadcast, не просто is_admin ─────

test('контурный администратор с can_broadcast:false получает 403 на создание оповещения и на журнал', async () => {
  const create = await api('POST', '/api/announcements', {
    token: people.scoped.token,
    body: { title: 'Приказ', content: 'Текст', priority: 'normal' }
  });
  assert.strictEqual(create.status, 403, create.text);

  // Журнал произвольного (созданного суперадминистратором) оповещения —
  // отдельно от вопроса авторства, сюда контурного администратора без права
  // рассылки пускать нельзя вовсе.
  const created = await api('POST', '/api/announcements', {
    token: people.admin.token,
    body: { title: 'Чужой приказ', content: 'Текст', priority: 'normal' }
  });
  assert.strictEqual(created.status, 201, created.text);

  const audit = await api('GET', `/api/announcements/${created.json.id}/audit`, { token: people.scoped.token });
  assert.strictEqual(audit.status, 403, audit.text);
});

test('контурный администратор с can_broadcast:true видит в журнале только свои оповещения', async () => {
  const own = await api('POST', '/api/announcements', {
    token: people.broadcaster.token,
    body: { title: 'Моё оповещение', content: 'Текст', priority: 'normal' }
  });
  assert.strictEqual(own.status, 201, own.text);

  const foreign = await api('POST', '/api/announcements', {
    token: people.admin.token,
    body: { title: 'Оповещение суперадминистратора', content: 'Текст', priority: 'normal' }
  });
  assert.strictEqual(foreign.status, 201, foreign.text);

  const ownAudit = await api('GET', `/api/announcements/${own.json.id}/audit`, { token: people.broadcaster.token });
  assert.strictEqual(ownAudit.status, 200, ownAudit.text);

  const foreignAudit = await api('GET', `/api/announcements/${foreign.json.id}/audit`, { token: people.broadcaster.token });
  assert.strictEqual(foreignAudit.status, 403, foreignAudit.text);

  // Суперадминистратор по-прежнему видит журнал чужого оповещения — только
  // контурные администраторы ограничены своими.
  const superSeesForeign = await api('GET', `/api/announcements/${foreign.json.id}/audit`, { token: people.admin.token });
  assert.strictEqual(superSeesForeign.status, 200, superSeesForeign.text);
});

// ── Находка №3: адресное оповещение не уходит всем сокетам ─────────────────

test('оповещение с target_type:users уходит по сокету только адресату, а не постороннему', async () => {
  await connect('ivanov');
  await connect('petrova');
  sockets.ivanov.inbox.length = 0;
  sockets.petrova.inbox.length = 0;

  const res = await api('POST', '/api/announcements', {
    token: people.admin.token,
    body: {
      title: 'Секретный приказ', content: 'Только для Иванова', priority: 'urgent',
      target_type: 'users', target_ids: [people.ivanov.id]
    }
  });
  assert.strictEqual(res.status, 201, res.text);

  const received = await waitFor(sockets.ivanov, (m) => m.type === 'new_announcement' && m.announcement.id === res.json.id);
  assert.strictEqual(received.announcement.content, 'Только для Иванова', 'адресат должен получить полный текст');

  assert.ok(
    await nothingArrives(sockets.petrova, (m) => m.type === 'new_announcement' && m.announcement.id === res.json.id),
    'посторонний сокет не должен был получить это оповещение вовсе'
  );
});

// ── Находка №10: подтверждение проверяется, событие адресное ───────────────

test('подтверждение несуществующего оповещения — 404', async () => {
  const res = await api('POST', '/api/announcements/999999/acknowledge', { token: people.ivanov.token });
  assert.strictEqual(res.status, 404, res.text);
});

test('подтверждение не адресованного сотруднику оповещения — 403, запись не создаётся', async () => {
  const res = await api('POST', '/api/announcements', {
    token: people.admin.token,
    body: {
      title: 'Только Сидорову', content: 'Текст', priority: 'normal',
      target_type: 'users', target_ids: [people.sidorov.id]
    }
  });
  assert.strictEqual(res.status, 201, res.text);

  const ack = await api('POST', `/api/announcements/${res.json.id}/acknowledge`, { token: people.petrova.token });
  assert.strictEqual(ack.status, 403, ack.text);

  const row = await require('../src/db').getDatabase()
    .prepare('SELECT * FROM announcement_receipts WHERE announcement_id = ? AND user_id = ?')
    .get(res.json.id, people.petrova.id);
  assert.strictEqual(row, undefined, 'запись подтверждения не должна была появиться');
});

test('подтверждение реального адресата рассылается только адресатам и автору, не постороннему', async () => {
  await connect('sidorov');
  await connect('petrova');

  const res = await api('POST', '/api/announcements', {
    token: people.admin.token,
    body: {
      title: 'Снова Сидорову', content: 'Текст', priority: 'normal',
      target_type: 'users', target_ids: [people.sidorov.id]
    }
  });
  assert.strictEqual(res.status, 201, res.text);
  sockets.petrova.inbox.length = 0;
  sockets.sidorov.inbox.length = 0;

  const ack = await api('POST', `/api/announcements/${res.json.id}/acknowledge`, { token: people.sidorov.token });
  assert.strictEqual(ack.status, 200, ack.text);

  // Адресату (он же подтвердивший) событие приходит — рассылка не отключена
  // целиком, она просто больше не идёт посторонним.
  await waitFor(sockets.sidorov, (m) => m.type === 'announcement_acknowledged' && m.announcementId == res.json.id);

  assert.ok(
    await nothingArrives(sockets.petrova, (m) => m.type === 'announcement_acknowledged' && m.announcementId == res.json.id),
    'постороннему сокету событие подтверждения приходить не должно'
  );
});

// ── Находка №11: приватный канал не объявляется всем ────────────────────────

test('приватный канал с участниками [A,B] не объявляется постороннему C, но приходит создателю A', async () => {
  await connect('ivanov');
  await connect('petrova');
  await connect('sidorov');
  sockets.ivanov.inbox.length = 0;
  sockets.petrova.inbox.length = 0;
  sockets.sidorov.inbox.length = 0;

  const res = await api('POST', '/api/channels', {
    token: people.ivanov.token,
    body: { name: 'Приватный канал', topic: 'Секретная тема', type: 'private' }
  });
  assert.strictEqual(res.status, 201, res.text);

  // POST /channels больше не принимает список участников (раунд ревью №1:
  // это была незапрошенная и непроверенная возможность — любой сотрудник с
  // can_create_channels мог принудительно добавить произвольные id без
  // проверки, что это реальные/активные учётные записи, и без согласия
  // добавляемого). Второй участник канала [A,B] заводится напрямую в базе
  // переписки — так же, как это делает административный маршрут
  // /admin/channels (см. api/index.js) и другие тесты этого набора.
  const { getDatabase } = require('../src/db');
  getDatabase()
    .prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(res.json.id, people.petrova.id, 'member', new Date().toISOString());

  // Петрову добавили УЖЕ ПОСЛЕ создания — событие channel_created рассылается
  // ровно в момент POST, поэтому её сокет его не получит (это ожидаемо и не
  // проверяется здесь). Проверяется главное по находке №11: создатель канал
  // видит, посторонний (не участник ни на момент создания, ни после) — нет.
  const seenByCreator = await waitFor(sockets.ivanov, (m) => m.type === 'channel_created' && m.channel.id === res.json.id);
  assert.strictEqual(seenByCreator.channel.topic, 'Секретная тема');

  assert.ok(
    await nothingArrives(sockets.sidorov, (m) => m.type === 'channel_created' && m.channel.id === res.json.id),
    'посторонний сокет не должен был узнать о приватном канале вовсе'
  );

  const members = await require('../src/services/message.service').getChannelMemberIds(res.json.id);
  assert.ok(members.includes(people.ivanov.id) && members.includes(people.petrova.id), 'в канале должны состоять оба участника — A и B');
});

test('публичный канал по-прежнему объявляется всем (без изменений в поведении)', async () => {
  sockets.sidorov.inbox.length = 0;

  const res = await api('POST', '/api/channels', {
    token: people.ivanov.token,
    body: { name: 'Публичный канал', topic: 'Открытая тема', type: 'public' }
  });
  assert.strictEqual(res.status, 201, res.text);

  await waitFor(sockets.sidorov, (m) => m.type === 'channel_created' && m.channel.id === res.json.id);
});

// Two sibling branches make a scope failure observable even when both have a
// legitimate employee, registration and device operation.
test('scoped admin cannot list or mutate sibling users, registrations or devices', async () => {
  const now = new Date().toISOString();
  const addDept = async (name, sortOrder) => Number((await identity.run(
    `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
     VALUES (NULL, $1, '', 'branch', $2, $3) RETURNING id`, [name, sortOrder, now]
  )).rows[0].id);
  const deptA = await addDept('Scope A', 81);
  const deptB = await addDept('Scope B', 82);
  const roleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;
  const scoped = await UserService.createUser({ username: 'scope-a-admin', full_name: 'Scope A Admin', password: 'Рабочий-пароль-1', role_id: roleId, department_id: deptA, admin_scope_dept_id: deptA });
  await UserService.setMustChangePassword(scoped.id, false);
  const token = AuthService.generateToken(await UserService.getUserById(scoped.id));
  const inA = await UserService.createUser({ username: 'scope-a-employee', full_name: 'Scope A Employee', password: 'Рабочий-пароль-1', department_id: deptA, job_title: 'Original A' });
  const inB = await UserService.createUser({ username: 'scope-b-employee', full_name: 'Scope B Employee', password: 'Рабочий-пароль-1', department_id: deptB, job_title: 'Original B' });
  const regA = await UserService.createUser({ username: 'scope-a-registration', full_name: 'Scope A Registration', password: 'Рабочий-пароль-1', department_id: deptA });
  const regB = await UserService.createUser({ username: 'scope-b-registration', full_name: 'Scope B Registration', password: 'Рабочий-пароль-1', department_id: deptB });
  await identity.run(`UPDATE users SET approval_status = 'pending', registered_at = $1 WHERE id IN ($2, $3)`, [now, regA.id, regB.id]);
  await identity.run(`INSERT INTO device_pairings (device_id, user_id, paired_at, is_active) VALUES ($1, $2, $3, 1)`, ['scope-b-paired', inB.id, now]);
  await identity.run(`INSERT INTO device_pairings (device_id, user_id, paired_at, is_active) VALUES ($1, $2, $3, 1)`, ['scope-a-paired', inA.id, now]);
  for (const [deviceId, ip] of [['scope-a-pending', '10.81.0.1'], ['scope-b-pending', '10.82.0.1'], ['scope-b-paired', '10.81.0.1'], ['scope-a-paired', '10.82.0.1']]) {
    await identity.run(`INSERT INTO pending_devices (device_id, device_name, ip_address, status, first_knock_at, last_knock_at)
      VALUES ($1, $2, $3, 'pending', $4, $4)`, [deviceId, deviceId, ip, now]);
  }
  await identity.run('UPDATE users SET bound_ip = $1 WHERE id = $2', ['10.81.0.1', inA.id]);
  await identity.run('UPDATE users SET bound_ip = $1 WHERE id = $2', ['10.82.0.1', inB.id]);

  const users = await api('GET', '/api/admin/users', { token });
  assert.strictEqual(users.status, 200, users.text);
  assert.ok(users.json.some((u) => u.id === inA.id));
  assert.ok(!users.json.some((u) => u.id === inB.id));
  const registrations = await api('GET', '/api/admin/registrations', { token });
  assert.strictEqual(registrations.status, 200, registrations.text);
  assert.ok(registrations.json.some((u) => u.id === regA.id));
  assert.ok(!registrations.json.some((u) => u.id === regB.id));
  const devices = await api('GET', '/api/admin/devices/pending', { token });
  assert.strictEqual(devices.status, 200, devices.text);
  assert.ok(devices.json.some((d) => d.device_id === 'scope-a-pending'));
  const aPaired = devices.json.find((d) => d.device_id === 'scope-a-paired');
  assert.ok(aPaired);
  assert.strictEqual(aPaired.suggested_user, null, 'B suggested identity must not leak through A-owned device');
  assert.ok(!devices.json.some((d) => d.device_id === 'scope-b-pending'));
  assert.ok(!devices.json.some((d) => d.device_id === 'scope-b-paired'));

  const bBefore = await identity.get('SELECT job_title, is_active, approval_status, registered_at FROM users WHERE id = $1', [inB.id]);
  for (const [method, path, body] of [
    ['PUT', `/api/admin/users/${inB.id}`, { job_title: 'Changed B' }],
    ['DELETE', `/api/admin/users/${inB.id}`],
    ['POST', `/api/admin/registrations/${regB.id}/approve`],
    ['POST', `/api/admin/registrations/${regB.id}/reject`, { reason: 'outside' }],
    ['POST', '/api/admin/devices/bind', { device_id: 'scope-b-pending', user_id: inB.id }],
    ['POST', '/api/admin/devices/bind', { device_id: 'scope-b-paired', user_id: inA.id }],
    ['POST', '/api/admin/devices/unbind', { device_id: 'scope-b-paired' }]
  ]) {
    const denied = await api(method, path, { token, body });
    assert.strictEqual(denied.status, 400, `${method} ${path}: ${denied.text}`);
  }
  assert.deepStrictEqual(await identity.get('SELECT job_title, is_active, approval_status, registered_at FROM users WHERE id = $1', [inB.id]), bBefore);
  assert.strictEqual((await identity.get('SELECT approval_status FROM users WHERE id = $1', [regB.id])).approval_status, 'pending');
  assert.strictEqual(await identity.get('SELECT * FROM device_pairings WHERE device_id = $1', ['scope-b-pending']), null);
  const bPairing = await identity.get('SELECT user_id, is_active FROM device_pairings WHERE device_id = $1', ['scope-b-paired']);
  assert.strictEqual(Number(bPairing.user_id), inB.id);
  assert.strictEqual(Number(bPairing.is_active), 1);
  assert.strictEqual((await identity.get('SELECT status FROM pending_devices WHERE device_id = $1', ['scope-b-pending'])).status, 'pending');

  assert.strictEqual((await api('PUT', `/api/admin/users/${inA.id}`, { token, body: { job_title: 'Changed A' } })).status, 200);
  assert.strictEqual((await identity.get('SELECT job_title FROM users WHERE id = $1', [inA.id])).job_title, 'Changed A');
  assert.strictEqual((await api('POST', `/api/admin/registrations/${regA.id}/approve`, { token })).status, 200);
  assert.strictEqual((await identity.get('SELECT approval_status FROM users WHERE id = $1', [regA.id])).approval_status, 'approved');
  assert.strictEqual((await api('POST', '/api/admin/devices/bind', { token, body: { device_id: 'scope-a-pending', user_id: inA.id } })).status, 200);
  assert.strictEqual(Number((await identity.get('SELECT user_id FROM device_pairings WHERE device_id = $1', ['scope-a-pending'])).user_id), inA.id);
  assert.strictEqual((await api('POST', '/api/admin/devices/unbind', { token, body: { device_id: 'scope-a-pending' } })).status, 200);
  assert.strictEqual(await identity.get('SELECT * FROM device_pairings WHERE device_id = $1', ['scope-a-pending']), null);
  assert.strictEqual((await identity.get('SELECT status FROM pending_devices WHERE device_id = $1', ['scope-a-pending'])).status, 'pending');
});

test('registration limit applies after department scope', async () => {
  const now = new Date().toISOString();
  const deptA = Number((await identity.run(`INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
    VALUES (NULL, 'Scope Pagination A', '', 'branch', 83, $1) RETURNING id`, [now])).rows[0].id);
  const deptB = Number((await identity.run(`INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
    VALUES (NULL, 'Scope Pagination B', '', 'branch', 84, $1) RETURNING id`, [now])).rows[0].id);
  const roleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;
  const scoped = await UserService.createUser({ username: 'scope-pagination-admin', full_name: 'Scope Pagination Admin', password: 'Рабочий-пароль-1', role_id: roleId, department_id: deptA, admin_scope_dept_id: deptA });
  await UserService.setMustChangePassword(scoped.id, false);
  const token = AuthService.generateToken(await UserService.getUserById(scoped.id));
  const earlier = new Date(Date.now() - 86400000).toISOString();
  const later = new Date(Date.now() + 86400000).toISOString();
  for (let i = 0; i < 500; i++) {
    await identity.run(`INSERT INTO users (username, full_name, password_hash, role_id, department_id, approval_status, registered_at, created_at)
      SELECT $1, $2, password_hash, role_id, $3, 'pending', $4, $5 FROM users WHERE id = $6`,
    [`scope-b-bulk-${i}`, `Scope B Bulk ${i}`, deptB, earlier, now, scoped.id]);
  }
  const inScope = await UserService.createUser({ username: 'scope-a-late', full_name: 'Scope A Late', password: 'Рабочий-пароль-1', department_id: deptA });
  await identity.run(`UPDATE users SET approval_status = 'pending', registered_at = $1 WHERE id = $2`, [later, inScope.id]);
  const listed = await api('GET', '/api/admin/registrations', { token });
  assert.strictEqual(listed.status, 200, listed.text);
  assert.ok(listed.json.some((row) => row.id === inScope.id), 'in-scope registration must survive the 500-row limit');
});

test('scoped auto-match preserves an existing sibling device owner', async () => {
  const now = new Date().toISOString();
  const addDept = async (name, sortOrder) => Number((await identity.run(
    `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
     VALUES (NULL, $1, '', 'branch', $2, $3) RETURNING id`, [name, sortOrder, now]
  )).rows[0].id);
  const deptA = await addDept('Auto Scope A', 85);
  const deptB = await addDept('Auto Scope B', 86);
  const roleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;
  const scoped = await UserService.createUser({ username: 'auto-scope-admin', full_name: 'Auto Scope Admin', password: 'Рабочий-пароль-1', role_id: roleId, department_id: deptA, admin_scope_dept_id: deptA });
  await UserService.setMustChangePassword(scoped.id, false);
  const token = AuthService.generateToken(await UserService.getUserById(scoped.id));
  const inA = await UserService.createUser({ username: 'auto-scope-a', full_name: 'Auto Scope A', password: 'Рабочий-пароль-1', department_id: deptA });
  const inB = await UserService.createUser({ username: 'auto-scope-b', full_name: 'Auto Scope B', password: 'Рабочий-пароль-1', department_id: deptB });
  const adminA = await UserService.createUser({ username: 'auto-other-admin-a', full_name: 'Auto Other Admin A', password: 'Рабочий-пароль-1', role_id: roleId, department_id: deptA, admin_scope_dept_id: deptA });
  const superRoleId = Number((await identity.run(`INSERT INTO roles (name, description, permissions_json)
    VALUES ($1, $2, $3) RETURNING id`, ['Formatted Super Admin', 'Role JSON with spaces', '{ "is_admin": true, "can_manage_users": true }'])).rows[0].id);
  const superA = await UserService.createUser({ username: 'auto-super-a', full_name: 'Auto Super A', password: 'Рабочий-пароль-1', role_id: superRoleId, department_id: deptA });
  const stringRoleId = Number((await identity.run(`INSERT INTO roles (name, description, permissions_json)
    VALUES ($1, $2, $3) RETURNING id`, ['String Super Admin', 'Truthy string permission', '{ "is_admin": "true" }'])).rows[0].id);
  const stringAdminA = await UserService.createUser({ username: 'auto-string-admin-a', full_name: 'Auto String Admin A', password: 'Рабочий-пароль-1', role_id: stringRoleId, department_id: deptA });
  await identity.run('UPDATE users SET bound_ip = $1 WHERE id = $2', ['10.85.0.1', inA.id]);
  await identity.run('UPDATE users SET bound_ip = $1 WHERE id = $2', ['10.85.0.2', adminA.id]);
  await identity.run('INSERT INTO device_pairings (device_id, user_id, paired_at, is_active) VALUES ($1, $2, $3, 1)', ['auto-owned-b', inB.id, now]);
  await identity.run('INSERT INTO device_pairings (device_id, user_id, paired_at, is_active) VALUES ($1, $2, $3, 1)', ['auto-owned-super', superA.id, now]);
  await identity.run('INSERT INTO device_pairings (device_id, user_id, paired_at, is_active) VALUES ($1, $2, $3, 1)', ['auto-owned-string-admin', stringAdminA.id, now]);
  for (const [deviceId, ip] of [['auto-owned-b', '10.85.0.1'], ['auto-local', '10.85.0.1'], ['auto-other-admin', '10.85.0.2'], ['auto-owned-super', '10.85.0.1'], ['auto-owned-string-admin', '10.85.0.1']]) {
    await identity.run(`INSERT INTO pending_devices (device_id, device_name, ip_address, status, first_knock_at, last_knock_at)
      VALUES ($1, $2, $3, 'pending', $4, $4)`, [deviceId, deviceId, ip, now]);
  }

  const before = await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['auto-owned-b']);
  const beforeSuper = await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['auto-owned-super']);
  const beforeStringAdmin = await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['auto-owned-string-admin']);
  const result = await api('POST', '/api/admin/devices/auto-match', { token });
  assert.strictEqual(result.status, 200, result.text);
  assert.strictEqual(result.json.matched_count, 1, result.text);
  assert.deepStrictEqual(await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['auto-owned-b']), before);
  assert.deepStrictEqual(await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['auto-owned-super']), beforeSuper);
  assert.deepStrictEqual(await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['auto-owned-string-admin']), beforeStringAdmin);
  assert.strictEqual((await identity.get('SELECT status FROM pending_devices WHERE device_id = $1', ['auto-owned-b'])).status, 'pending');
  assert.strictEqual((await identity.get('SELECT status FROM pending_devices WHERE device_id = $1', ['auto-owned-super'])).status, 'pending');
  assert.strictEqual((await identity.get('SELECT status FROM pending_devices WHERE device_id = $1', ['auto-owned-string-admin'])).status, 'pending');
  assert.strictEqual(Number((await identity.get('SELECT user_id FROM device_pairings WHERE device_id = $1', ['auto-local'])).user_id), inA.id);
  assert.strictEqual(await identity.get('SELECT * FROM device_pairings WHERE device_id = $1', ['auto-other-admin']), null);
  assert.strictEqual((await identity.get('SELECT status FROM pending_devices WHERE device_id = $1', ['auto-other-admin'])).status, 'pending');
});

test('scoped admin without a department cannot list or auto-match devices', async () => {
  const now = new Date().toISOString();
  const roleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;
  const scoped = await UserService.createUser({ username: 'auto-noscope-admin', full_name: 'Auto No Scope Admin', password: 'Рабочий-пароль-1', role_id: roleId });
  await UserService.setMustChangePassword(scoped.id, false);
  const token = AuthService.generateToken(await UserService.getUserById(scoped.id));
  const deptB = Number((await identity.run(`INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
    VALUES (NULL, 'No Scope B', '', 'branch', 87, $1) RETURNING id`, [now])).rows[0].id);
  const ownerB = await UserService.createUser({ username: 'noscope-owner-b', full_name: 'No Scope Owner B', password: 'Рабочий-пароль-1', department_id: deptB });
  const candidateB = await UserService.createUser({ username: 'noscope-candidate-b', full_name: 'No Scope Candidate B', password: 'Рабочий-пароль-1', department_id: deptB });
  await identity.run('UPDATE users SET bound_ip = $1 WHERE id = $2', ['10.87.0.1', candidateB.id]);
  await identity.run('INSERT INTO device_pairings (device_id, user_id, paired_at, is_active) VALUES ($1, $2, $3, 1)', ['noscope-b-pairing', ownerB.id, now]);
  await identity.run(`INSERT INTO pending_devices (device_id, device_name, ip_address, status, first_knock_at, last_knock_at)
    VALUES ($1, $2, $3, 'pending', $4, $4)`, ['noscope-b-pairing', 'No Scope B Device', '10.87.0.1', now]);

  const beforePairing = await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['noscope-b-pairing']);
  const beforePending = await identity.get('SELECT status, last_knock_at FROM pending_devices WHERE device_id = $1', ['noscope-b-pairing']);
  const matched = await api('POST', '/api/admin/devices/auto-match', { token });
  assert.strictEqual(matched.status, 400, matched.text);
  assert.deepStrictEqual(await identity.get('SELECT user_id, is_active, paired_at FROM device_pairings WHERE device_id = $1', ['noscope-b-pairing']), beforePairing);
  assert.deepStrictEqual(await identity.get('SELECT status, last_knock_at FROM pending_devices WHERE device_id = $1', ['noscope-b-pairing']), beforePending);
  const listed = await api('GET', '/api/admin/devices/pending', { token });
  assert.strictEqual(listed.status, 200, listed.text);
  assert.deepStrictEqual(listed.json, []);
});

test('channel creation and uploads honor scoped capability flags while superadmin retains override', async () => {
  async function tokenForRole(username, permissions) {
    const role = await identity.run(
      'INSERT INTO roles (name, description, permissions_json) VALUES ($1, $2, $3) RETURNING id',
      [`Capability ${username}`, '', JSON.stringify(permissions)]
    );
    const user = await UserService.createUser({
      username, full_name: username, password: 'Рабочий-пароль-1',
      role_id: Number(role.rows[0].id), department_id: people.admin.dept,
      ...(permissions.is_scoped_admin ? { admin_scope_dept_id: people.admin.dept } : {})
    });
    await UserService.setMustChangePassword(user.id, false);
    return AuthService.generateToken(await UserService.getUserById(user.id));
  }

  async function upload(token) {
    const form = new FormData();
    form.set('file', new Blob(['capability check'], { type: 'text/plain' }), 'capability.txt');
    const res = await fetch(baseUrl + '/api/files/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
    });
    return { status: res.status, text: await res.text() };
  }

  const denied = await tokenForRole('capability-scoped-denied', {
    is_admin: true, is_scoped_admin: true,
    can_create_channels: false, can_upload_files: false
  });
  const allowed = await tokenForRole('capability-scoped-allowed', {
    is_admin: true, is_scoped_admin: true,
    can_create_channels: true, can_upload_files: true
  });
  const superadmin = await tokenForRole('capability-superadmin', {
    is_admin: true, is_scoped_admin: false,
    can_create_channels: false, can_upload_files: false
  });

  for (const [label, token, expected] of [
    ['scoped denied', denied, 403],
    ['scoped allowed', allowed, 201],
    ['superadmin', superadmin, 201]
  ]) {
    const channel = await api('POST', '/api/channels', {
      token, body: { name: `Capability ${label}`, type: 'private' }
    });
    assert.strictEqual(channel.status, expected, `${label} channel: ${channel.text}`);
    const file = await upload(token);
    assert.strictEqual(file.status, expected, `${label} upload: ${file.text}`);
  }
});
