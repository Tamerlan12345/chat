const test = require('node:test');
const assert = require('node:assert');
const { freshBoot } = require('./helpers/boot');

// Сквозная проверка того, чем администратор пользуется каждый день:
// заведение сотрудника, правка его данных, пароли, отделы и перемещение
// между ними. Проверяется не «маршрут отвечает 200», а что данные реально
// оказались в базе — теперь в той, где им и место: учётные записи хранятся
// отдельно от переписки.

const UserService = require('../src/services/user.service');
const OrgService = require('../src/services/org.service');
const AuthService = require('../src/services/auth.service');
const { verifyPassword } = require('../src/db/identity/password');

let identity;

test.before(async () => {
  ({ identity } = await freshBoot());
});

const roleId = async (name) =>
  (await identity.get('SELECT id FROM roles WHERE name = $1', [name]))?.id;
const raw = (id) => identity.get('SELECT * FROM users WHERE id = $1', [Number(id)]);
const byLogin = (login) => identity.get('SELECT * FROM users WHERE username = $1', [login]);
const passwordMatches = async (password, row) =>
  (await verifyPassword(password, row.password_hash, row.salt)).ok;

test('отделы: создание, переименование и удаление', async () => {
  const created = await OrgService.createDepartment({
    parent_id: null,
    name: 'Отдел тестирования',
    description: 'создан проверкой',
    dept_type: 'department',
    sort_order: 10
  });
  assert.ok(created?.id, 'создание должно возвращать отдел');

  await OrgService.updateDepartment(created.id, { name: 'Отдел испытаний' });
  const renamed = await identity.get('SELECT name FROM departments WHERE id = $1', [created.id]);
  assert.strictEqual(renamed.name, 'Отдел испытаний');

  await OrgService.deleteDepartment(created.id);
  const gone = await identity.get('SELECT COUNT(*) AS n FROM departments WHERE id = $1', [created.id]);
  assert.strictEqual(Number(gone.n), 0);
});

test('отдел нельзя вложить в собственное подразделение', async () => {
  // Иначе дерево превращается в кольцо, а обход по нему — в бесконечный цикл.
  const parent = await OrgService.createDepartment({ name: 'Управление А' });
  const child = await OrgService.createDepartment({ name: 'Отдел А-1', parent_id: parent.id });

  await assert.rejects(
    () => OrgService.updateDepartment(parent.id, { parent_id: child.id }),
    /внутрь его собственного/
  );
});

test('создание сотрудника: все поля формы доходят до базы', async () => {
  const dept = await OrgService.createDepartment({ name: 'Бухгалтерия', dept_type: 'department' });

  const created = await UserService.createUser({
    username: 'sidorov',
    full_name: 'Сидоров Сидор',
    email: 's.sidorov@cic.kz',
    phone: '+7 700 000 00 00',
    job_title: 'Бухгалтер',
    department_id: dept.id,
    role_id: await roleId('Сотрудник'),
    extension: '2415',
    uin: 5150,
    password: 'первичныйпароль'
  });

  const row = await raw(created.id);
  assert.strictEqual(row.full_name, 'Сидоров Сидор');
  assert.strictEqual(row.email, 's.sidorov@cic.kz');
  assert.strictEqual(row.phone, '+7 700 000 00 00', 'телефон не должен теряться');
  assert.strictEqual(row.job_title, 'Бухгалтер');
  assert.strictEqual(row.department_id, dept.id, 'подразделение не должно теряться');
  assert.strictEqual(String(row.extension), '2415', 'внутренний номер не должен теряться');
  assert.strictEqual(row.must_change_password, 1, 'первичный пароль обязан меняться при входе');
});

test('заданный администратором пароль действительно работает', async () => {
  const row = await byLogin('sidorov');
  assert.ok(
    await passwordMatches('первичныйпароль', row),
    'сохранён должен быть именно тот пароль, который ввёл администратор'
  );
});

test('пароль хранится в новом формате, без отдельной колонки соли', async () => {
  const row = await byLogin('sidorov');
  assert.match(row.password_hash, /^scrypt\$N=\d+,r=\d+,p=\d+\$/);
  assert.strictEqual(row.salt, null, 'соль теперь внутри самой записи');
});

test('без заданного пароля выдаётся случайный, а не общеизвестный', async () => {
  // Прежде все новые учётные записи получали «123456»: между заведением и
  // первым входом сотрудника это открытая дверь в его учётную запись.
  const created = await UserService.createUser({ username: 'random_pass', full_name: 'Случайный Пароль' });
  assert.ok(created.initial_password, 'временный пароль должен возвращаться администратору');
  assert.ok(created.initial_password.length >= 12);
  assert.notStrictEqual(created.initial_password, '123456');

  const row = await raw(created.id);
  assert.ok(await passwordMatches(created.initial_password, row));
});

test('правка сотрудника сохраняет изменённые поля', async () => {
  const user = await byLogin('sidorov');
  const otherDept = await OrgService.createDepartment({ name: 'Казначейство', dept_type: 'department' });

  await UserService.adminUpdateUser(user.id, {
    full_name: 'Сидоров Сидор Сидорович',
    job_title: 'Главный бухгалтер',
    department_id: otherDept.id,
    extension: '2416',
    email: 'new@cic.kz',
    phone: '+7 701 111 11 11'
  });

  const after = await raw(user.id);
  assert.strictEqual(after.full_name, 'Сидоров Сидор Сидорович');
  assert.strictEqual(after.job_title, 'Главный бухгалтер');
  assert.strictEqual(after.department_id, otherDept.id);
  assert.strictEqual(String(after.extension), '2416');
  assert.strictEqual(after.email, 'new@cic.kz');
  assert.strictEqual(after.phone, '+7 701 111 11 11');
});

test('перемещение сотрудника между отделами', async () => {
  const user = await byLogin('sidorov');
  const target = await OrgService.createDepartment({ name: 'Отдел кадров', dept_type: 'department' });

  await OrgService.moveUser(user.id, target.id);
  assert.strictEqual((await raw(user.id)).department_id, target.id);
});

test('сброс пароля администратором ставит новый пароль и требует смены', async () => {
  const user = await byLogin('sidorov');

  await UserService.adminResetPassword(user.id, 'выданныйпароль');
  const after = await raw(user.id);

  assert.ok(await passwordMatches('выданныйпароль', after));
  assert.ok(!(await passwordMatches('первичныйпароль', after)), 'старый должен перестать работать');
  assert.strictEqual(after.must_change_password, 1);
});

test('сброс без пароля генерирует временный и возвращает его один раз', async () => {
  const user = await byLogin('random_pass');
  const { password, generated } = await UserService.adminResetPassword(user.id);

  assert.strictEqual(generated, true);
  assert.ok(password.length >= 12);
  assert.ok(await passwordMatches(password, await raw(user.id)));
});

test('сотрудник меняет пароль сам: старый проверяется, флаг снимается', async () => {
  const user = await byLogin('sidorov');

  await assert.rejects(
    () => UserService.changePassword(user.id, 'неверный старый', 'какойтоновый'),
    /Старый пароль неверен/
  );

  await UserService.changePassword(user.id, 'выданныйпароль', 'мойличныйпароль');
  const after = await raw(user.id);
  assert.ok(await passwordMatches('мойличныйпароль', after));
  assert.strictEqual(after.must_change_password, 0, 'после самостоятельной смены требование снимается');
});

test('смена пароля обрывает ранее выданные токены', async () => {
  // Иначе смена пароля защищает только на словах: чужая сессия доживает
  // свои семь дней как ни в чём не бывало.
  const before = await AuthService.login('sidorov', 'мойличныйпароль');
  assert.ok(await AuthService.resolveSession(before.token), 'свежий токен должен работать');

  await UserService.changePassword(before.user.id, 'мойличныйпароль', 'ещёодинпароль');
  assert.strictEqual(
    await AuthService.resolveSession(before.token),
    null,
    'старый токен обязан перестать действовать сразу'
  );
});

test('слишком простой пароль сотрудник поставить себе не может', async () => {
  const user = await byLogin('sidorov');
  await assert.rejects(() => UserService.changePassword(user.id, 'ещёодинпароль', 'корот'), /не короче/);
  await assert.rejects(() => UserService.changePassword(user.id, 'ещёодинпароль', 'qwerty123'), /слишком простой/);
  await assert.rejects(
    () => UserService.changePassword(user.id, 'ещёодинпароль', 'ещёодинпароль'),
    /должен отличаться/
  );
});

test('изменённый пароль переживает вход', async () => {
  const result = await AuthService.login('sidorov', 'ещёодинпароль');
  assert.ok(result.token);
  assert.strictEqual(result.user.username, 'sidorov');
});

test('назначение администратора подразделения сохраняется', async () => {
  const user = await byLogin('sidorov');
  const dept = await identity.get(`SELECT id FROM departments WHERE name = 'Отдел кадров'`);

  await UserService.adminUpdateUser(user.id, {
    role_id: await roleId('Контурный администратор'),
    admin_scope_dept_id: dept.id
  });

  const after = await raw(user.id);
  assert.strictEqual(after.role_id, await roleId('Контурный администратор'));
  assert.strictEqual(after.admin_scope_dept_id, dept.id, 'без этого поля контурный админ ничем не управляет');
});

test('отключение и включение сотрудника', async () => {
  const user = await byLogin('sidorov');

  await UserService.toggleUserActive(user.id, false);
  assert.strictEqual((await raw(user.id)).is_active, 0);
  // Отключённый отвечает так же, как неверный пароль: иначе по разнице
  // ответов видно, какие учётные записи существуют.
  await assert.rejects(() => AuthService.login('sidorov', 'ещёодинпароль'), /Неверный логин или пароль/);

  await UserService.toggleUserActive(user.id, true);
  assert.strictEqual((await raw(user.id)).is_active, 1);
  assert.ok((await AuthService.login('sidorov', 'ещёодинпароль')).token);
});

test('серия неудачных входов временно запирает учётную запись', async () => {
  // Ограничитель по IP живёт в памяти процесса: перезапуск сервера или смена
  // адреса возобновляют подбор с нуля. Счётчик в базе — нет.
  const config = require('../src/config');
  const created = await UserService.createUser({
    username: 'lockme',
    full_name: 'Заблокируй Меня',
    password: 'нормальныйпароль'
  });

  for (let i = 0; i < config.LOGIN_MAX_FAILED_ATTEMPTS; i++) {
    await assert.rejects(() => AuthService.login('lockme', 'неверный пароль'));
  }

  await assert.rejects(
    () => AuthService.login('lockme', 'нормальныйпароль'),
    /заблокирована/,
    'после порога не пускает даже с верным паролем'
  );

  const row = await raw(created.id);
  assert.ok(row.locked_until, 'срок блокировки должен быть записан');
});
