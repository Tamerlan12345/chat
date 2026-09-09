const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

const AuthService = require('../src/services/auth.service');

test('регистрация создаёт заявку, а не готовую учётную запись', () => {
  database();
  const user = AuthService.register({
    username: 'ivanov',
    password: 'парольпользователя',
    full_name: 'Иванов Иван'
  });
  const row = database().prepare('SELECT approval_status FROM users WHERE id = ?').get(user.id);
  assert.strictEqual(row.approval_status, 'pending');
});

test('пока заявка не подтверждена, войти нельзя даже с верным паролем', () => {
  database();
  assert.throws(
    () => AuthService.login('ivanov', 'парольпользователя'),
    /не подтверждена/,
    'неподтверждённый сотрудник не должен попадать в систему'
  );
});

test('неверный пароль проверяется раньше статуса заявки', () => {
  // Иначе по разнице ответов можно было бы выяснять, какие логины заведены.
  database();
  assert.throws(() => AuthService.login('ivanov', 'не тот пароль'), /Неверный пароль/);
});

test('заявка не попадает в общие каналы до одобрения', () => {
  const d = database();
  const user = d.prepare("SELECT id FROM users WHERE username = 'ivanov'").get();
  const count = d
    .prepare('SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?')
    .get(user.id);
  assert.strictEqual(count.n, 0);
});

test('после одобрения вход работает и сотрудник добавлен в каналы', () => {
  const d = database();
  const user = d.prepare("SELECT id FROM users WHERE username = 'ivanov'").get();
  AuthService.approveUser(user.id);

  const result = AuthService.login('ivanov', 'парольпользователя');
  assert.ok(result.token, 'должен выдаваться токен');
  assert.strictEqual(result.user.username, 'ivanov');

  const count = d.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?').get(user.id);
  assert.ok(count.n > 0, 'сотрудник должен попасть в системные каналы');
});

test('отклонённая заявка не пускает в систему', () => {
  const d = database();
  AuthService.register({ username: 'petrov', password: 'другойпароль', full_name: 'Петров Пётр' });
  const user = d.prepare("SELECT id FROM users WHERE username = 'petrov'").get();
  AuthService.rejectUser(user.id);

  assert.throws(() => AuthService.login('petrov', 'другойпароль'));
});

test('регистрация не позволяет назначить себе роль', () => {
  const d = database();
  const admin = d.prepare("SELECT id FROM roles WHERE name = 'Суперадминистратор'").get();
  AuthService.register({
    username: 'hacker',
    password: 'парольвзломщика',
    full_name: 'Кто-то',
    role_id: admin.id
  });
  const created = d
    .prepare("SELECT role_id FROM users WHERE username = 'hacker'")
    .get();
  assert.notStrictEqual(created.role_id, admin.id, 'роль из запроса не должна учитываться');
});

test('существующие учётные записи миграция не ломает', () => {
  const d = database();
  const admin = d.prepare("SELECT approval_status FROM users WHERE username = 'admin'").get();
  assert.strictEqual(admin.approval_status, 'approved', 'админ должен остаться рабочим');
});
