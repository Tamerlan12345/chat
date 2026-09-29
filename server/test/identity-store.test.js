const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { resetDatabaseFiles, resetPostgresSchema, DATA_DIR, closeAll } = require('./helpers/boot');
const { buildLegacyDatabase, LEGACY_PASSWORD } = require('./helpers/legacy-db');

// Переезд учётных записей в отдельное хранилище — операция, которая на рабочей
// установке выполняется ровно один раз и на настоящих данных компании.
// Проверяется она здесь на базе прежней формы: схема со всеми внешними ключами
// на users и пароли старого формата.

const LEGACY_TABLES = ['users', 'roles', 'departments', 'device_pairings', 'pending_devices', 'audit_logs', 'server_settings'];

let identity;
let chat;

test.before(async () => {
  resetDatabaseFiles();
  await resetPostgresSchema();
  buildLegacyDatabase(path.join(DATA_DIR, 'mychat.db'));

  const { bootstrap } = require('../src/bootstrap');
  await bootstrap();

  identity = require('../src/db/identity').identity();
  chat = require('../src/db').getDatabase();
});

test.after(async () => {
  await closeAll();
});

test('учётные записи перенесены с сохранением идентификаторов', async () => {
  // На эти номера ссылаются сообщения, участники каналов и объявления —
  // сместиться они не могут даже на единицу.
  const users = await identity.all('SELECT id, username, full_name, role_id, department_id FROM users ORDER BY id');
  assert.strictEqual(users.length, 2);
  assert.deepStrictEqual(
    users.map((u) => [u.id, u.username]),
    [[1, 'admin'], [2, 'petrov']]
  );
  assert.strictEqual(users[1].department_id, 2, 'привязка к отделу должна сохраниться');
  assert.strictEqual(users[1].role_id, 2, 'роль должна сохраниться');
});

test('роли, подразделения, устройства и журнал переехали целиком', async () => {
  assert.strictEqual(Number((await identity.get('SELECT COUNT(*) n FROM roles')).n), 3, 'две прежние плюс контурный администратор');
  assert.ok(Number((await identity.get('SELECT COUNT(*) n FROM departments')).n) >= 2);
  assert.strictEqual(Number((await identity.get('SELECT COUNT(*) n FROM audit_logs')).n), 1);

  const pairing = await identity.get(`SELECT user_id FROM device_pairings WHERE device_id = 'dev-1'`);
  assert.strictEqual(pairing.user_id, 2);

  const company = await identity.get(`SELECT value FROM server_settings WHERE key = 'company_name'`);
  assert.strictEqual(company.value, 'АО СК Сентрас Иншуранс', 'настройки не должны сбрасываться к значениям по умолчанию');
});

test('иерархия подразделений не рассыпается при переносе', async () => {
  // Подразделения ссылаются сами на себя: строку со ссылкой на ещё не
  // вставленного родителя внешний ключ отвергнет, поэтому связи проставляются
  // вторым проходом. Проверяется, что этот проход отработал.
  const buhgalteria = await identity.get(`SELECT parent_id FROM departments WHERE name = 'Бухгалтерия'`);
  const headOffice = await identity.get(`SELECT id FROM departments WHERE name = 'Головной Офис'`);
  assert.strictEqual(buhgalteria.parent_id, headOffice.id);
});

test('таблицы учётных записей удалены из базы переписки', async () => {
  // Пока они там, хэши паролей лежат в файле, который админ-панель умеет
  // читать произвольным SQL и отдавать на скачивание как резервную копию.
  const tables = chat
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

  for (const table of LEGACY_TABLES) {
    assert.ok(!tables.includes(table), `таблица ${table} не должна оставаться в базе переписки`);
  }
  assert.ok(tables.includes('messages'), 'а переписка — на месте');
});

test('снимок базы до разделения сохранён рядом, а не в скачиваемых копиях', async () => {
  const snapshot = path.join(DATA_DIR, 'pre-identity-split.db');
  assert.ok(fs.existsSync(snapshot), 'откатиться должно быть куда');

  const backups = path.join(DATA_DIR, 'backups');
  const inBackups = fs.existsSync(backups) ? fs.readdirSync(backups) : [];
  assert.ok(
    !inBackups.some((f) => f.includes('pre-identity-split')),
    'этот файл ещё содержит пароли — в каталог, отдаваемый по HTTP, он попасть не должен'
  );
});

test('внешние ключи на users сняты, внутренние — сохранены', async () => {
  for (const table of ['messages', 'channel_members', 'announcements', 'files']) {
    const refs = chat.prepare(`PRAGMA foreign_key_list("${table}")`).all().map((f) => f.table);
    assert.ok(!refs.includes('users'), `${table} не должна ссылаться на таблицу в другой базе`);
  }

  // Целостность внутри самой переписки при этом никуда не делась.
  const statusRefs = chat.prepare('PRAGMA foreign_key_list("message_statuses")').all().map((f) => f.table);
  assert.ok(statusRefs.includes('messages'), 'ссылка на сообщения должна остаться');

  const dangling = chat.prepare('PRAGMA foreign_key_check').all();
  assert.strictEqual(dangling.length, 0, 'после перестроения висящих ссылок быть не должно');
});

test('индексы переписки уцелели при перестроении таблиц', async () => {
  // Индекс уходит вместе со сброшенной таблицей. Если его не пересоздать,
  // выборка сообщений тихо становится полным перебором.
  const indexes = chat
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
    .all()
    .map((r) => r.name);
  assert.ok(indexes.includes('idx_messages_direct'));
  assert.ok(indexes.includes('idx_messages_channel'));
});

test('переписка сохранилась и собирается из двух баз', async () => {
  const MessageService = require('../src/services/message.service');

  const messages = await MessageService.getMessages('direct', 1, 2);
  assert.strictEqual(messages.length, 2);
  assert.deepStrictEqual(
    messages.map((m) => `${m.sender_name}: ${m.text}`),
    ['Прежний Админ: Привет, Пётр', 'Петров Пётр: Здравствуйте']
  );

  const convos = await MessageService.getDirectConversations(2);
  assert.strictEqual(convos.length, 1);
  assert.strictEqual(convos[0].full_name, 'Прежний Админ');
});

test('прежний пароль работает и переписывается в новый формат при входе', async () => {
  const AuthService = require('../src/services/auth.service');

  const before = await identity.get(`SELECT password_hash, salt FROM users WHERE username = 'petrov'`);
  assert.ok(before.salt, 'до входа запись ещё в прежнем формате');
  assert.ok(!before.password_hash.startsWith('scrypt$'));

  const result = await AuthService.login('petrov', LEGACY_PASSWORD);
  assert.strictEqual(result.user.username, 'petrov');
  assert.strictEqual(result.user.department_name, 'Бухгалтерия');

  const after = await identity.get(`SELECT password_hash, salt FROM users WHERE username = 'petrov'`);
  // Значение N — из password.js, а не захардкожено здесь: задача 3 подняла
  // его до 2^17, и этот тест проверяет сам факт пересчёта в текущий формат,
  // а не конкретную цифру стоимости.
  const { CURRENT_PARAMS } = require('../src/db/identity/password');
  assert.match(
    after.password_hash,
    new RegExp(`^scrypt\\$N=${CURRENT_PARAMS.N}`),
    'вход — единственный момент, когда пароль известен открытым'
  );
  assert.strictEqual(after.salt, null);

  // И, разумеется, продолжает работать после пересчёта.
  assert.ok((await AuthService.login('petrov', LEGACY_PASSWORD)).token);
});

test('новый сотрудник может писать: внешний ключ больше не мешает', async () => {
  // Раньше отправка упиралась в REFERENCES users(id): отправителя в базе
  // переписки нет и быть не может.
  const UserService = require('../src/services/user.service');
  const MessageService = require('../src/services/message.service');

  const created = await UserService.createUser({ username: 'novikov', full_name: 'Новиков Новик' });
  const sent = await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: 2,
    senderId: created.id,
    text: 'Первое сообщение'
  });

  assert.strictEqual(sent.sender_name, 'Новиков Новик');
  assert.strictEqual(sent.text, 'Первое сообщение');
});

test('повторный запуск ничего не переносит заново', async () => {
  // bootstrap выполняется при каждом старте. Второй проход не должен ни
  // задваивать строки, ни затирать уже изменённые данные.
  const { identity: getIdentity } = require('../src/db/identity');
  const before = Number((await getIdentity().get('SELECT COUNT(*) n FROM users')).n);

  await require('../src/bootstrap').bootstrap();

  const after = Number((await getIdentity().get('SELECT COUNT(*) n FROM users')).n);
  assert.strictEqual(after, before);
});
