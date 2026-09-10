const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Сквозная проверка того, чем администратор пользуется каждый день:
// заведение сотрудника, правка его данных, пароли, отделы и перемещение
// между ними. Проверяется не «маршрут отвечает 200», а что данные реально
// оказались в базе.
const DB_PATH = path.resolve(__dirname, '../data/mychat.db');

let db;
function database() {
  if (!db) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch {}
    }
    db = require('../src/db').getDatabase();
  }
  return db;
}

const UserService = require('../src/services/user.service');
const OrgService = require('../src/services/org.service');
const AuthService = require('../src/services/auth.service');
const { verifyPassword } = require('../src/db');

const roleId = (name) => database().prepare('SELECT id FROM roles WHERE name = ?').get(name)?.id;
const raw = (id) => database().prepare('SELECT * FROM users WHERE id = ?').get(id);

test('отделы: создание, переименование и удаление', () => {
  const d = database();
  const created = OrgService.createDepartment({
    parent_id: null,
    name: 'Отдел тестирования',
    description: 'создан проверкой',
    dept_type: 'department',
    sort_order: 10
  });
  assert.ok(created?.id, 'создание должно возвращать отдел');

  OrgService.updateDepartment(created.id, { name: 'Отдел испытаний' });
  assert.strictEqual(
    d.prepare('SELECT name FROM departments WHERE id = ?').get(created.id).name,
    'Отдел испытаний'
  );

  OrgService.deleteDepartment(created.id);
  assert.strictEqual(
    d.prepare('SELECT COUNT(*) AS n FROM departments WHERE id = ?').get(created.id).n,
    0
  );
});

test('создание сотрудника: все поля формы доходят до базы', () => {
  const d = database();
  const dept = OrgService.createDepartment({ name: 'Бухгалтерия', dept_type: 'department' });

  const created = UserService.createUser({
    username: 'sidorov',
    full_name: 'Сидоров Сидор',
    email: 's.sidorov@cic.kz',
    phone: '+7 700 000 00 00',
    job_title: 'Бухгалтер',
    department_id: dept.id,
    role_id: roleId('Сотрудник'),
    extension: '2415',
    uin: 5150,
    password: 'первичныйпароль'
  });

  const row = raw(created.id);
  assert.strictEqual(row.full_name, 'Сидоров Сидор');
  assert.strictEqual(row.email, 's.sidorov@cic.kz');
  assert.strictEqual(row.phone, '+7 700 000 00 00', 'телефон не должен теряться');
  assert.strictEqual(row.job_title, 'Бухгалтер');
  assert.strictEqual(row.department_id, dept.id, 'подразделение не должно теряться');
  assert.strictEqual(String(row.extension), '2415', 'внутренний номер не должен теряться');
  assert.strictEqual(row.must_change_password, 1, 'первичный пароль обязан меняться при входе');
});

test('заданный администратором пароль действительно работает', () => {
  const d = database();
  const row = d.prepare("SELECT * FROM users WHERE username = 'sidorov'").get();
  assert.ok(
    verifyPassword('первичныйпароль', row.password_hash, row.salt),
    'сохранён должен быть именно тот пароль, который ввёл администратор'
  );
});

test('правка сотрудника сохраняет изменённые поля', () => {
  const d = database();
  const user = d.prepare("SELECT * FROM users WHERE username = 'sidorov'").get();
  const otherDept = OrgService.createDepartment({ name: 'Казначейство', dept_type: 'department' });

  UserService.adminUpdateUser(user.id, {
    full_name: 'Сидоров Сидор Сидорович',
    job_title: 'Главный бухгалтер',
    department_id: otherDept.id,
    extension: '2416',
    email: 'new@cic.kz',
    phone: '+7 701 111 11 11'
  });

  const after = raw(user.id);
  assert.strictEqual(after.full_name, 'Сидоров Сидор Сидорович');
  assert.strictEqual(after.job_title, 'Главный бухгалтер');
  assert.strictEqual(after.department_id, otherDept.id);
  assert.strictEqual(String(after.extension), '2416');
  assert.strictEqual(after.email, 'new@cic.kz');
  assert.strictEqual(after.phone, '+7 701 111 11 11');
});

test('перемещение сотрудника между отделами', () => {
  const d = database();
  const user = d.prepare("SELECT * FROM users WHERE username = 'sidorov'").get();
  const target = OrgService.createDepartment({ name: 'Отдел кадров', dept_type: 'department' });

  OrgService.moveUser(user.id, target.id);
  assert.strictEqual(raw(user.id).department_id, target.id);
});

test('сброс пароля администратором ставит новый пароль и требует смены', () => {
  const d = database();
  const user = d.prepare("SELECT * FROM users WHERE username = 'sidorov'").get();

  UserService.adminResetPassword(user.id, 'выданныйпароль');
  const after = raw(user.id);

  assert.ok(verifyPassword('выданныйпароль', after.password_hash, after.salt));
  assert.ok(!verifyPassword('первичныйпароль', after.password_hash, after.salt), 'старый должен перестать работать');
  assert.strictEqual(after.must_change_password, 1);
});

test('сотрудник меняет пароль сам: старый проверяется, флаг снимается', () => {
  const d = database();
  const user = d.prepare("SELECT * FROM users WHERE username = 'sidorov'").get();

  assert.throws(
    () => UserService.changePassword(user.id, 'неверный старый', 'какойтоновый'),
    /Старый пароль неверен/
  );

  UserService.changePassword(user.id, 'выданныйпароль', 'мойличныйпароль');
  const after = raw(user.id);
  assert.ok(verifyPassword('мойличныйпароль', after.password_hash, after.salt));
  assert.strictEqual(after.must_change_password, 0, 'после самостоятельной смены требование снимается');
});

test('изменённый пароль переживает вход', () => {
  const result = AuthService.login('sidorov', 'мойличныйпароль');
  assert.ok(result.token);
  assert.strictEqual(result.user.username, 'sidorov');
});

test('назначение администратора подразделения сохраняется', () => {
  const d = database();
  const user = d.prepare("SELECT * FROM users WHERE username = 'sidorov'").get();
  const dept = d.prepare("SELECT id FROM departments WHERE name = 'Отдел кадров'").get();

  UserService.adminUpdateUser(user.id, {
    role_id: roleId('Контурный администратор'),
    admin_scope_dept_id: dept.id
  });

  const after = raw(user.id);
  assert.strictEqual(after.role_id, roleId('Контурный администратор'));
  assert.strictEqual(after.admin_scope_dept_id, dept.id, 'без этого поля контурный админ ничем не управляет');
});

test('отключение и включение сотрудника', () => {
  const d = database();
  const user = d.prepare("SELECT * FROM users WHERE username = 'sidorov'").get();

  UserService.toggleUserActive(user.id, false);
  assert.strictEqual(raw(user.id).is_active, 0);
  assert.throws(() => AuthService.login('sidorov', 'мойличныйпароль'), /не найден или деактивирован/);

  UserService.toggleUserActive(user.id, true);
  assert.strictEqual(raw(user.id).is_active, 1);
  assert.ok(AuthService.login('sidorov', 'мойличныйпароль').token);
});
