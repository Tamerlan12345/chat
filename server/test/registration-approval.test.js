const test = require('node:test');
const assert = require('node:assert');
const { freshBoot } = require('./helpers/boot');

let identity;
let chat;
const AuthService = require('../src/services/auth.service');

test.before(async () => {
  ({ identity, chat } = await freshBoot());
});

test('регистрация создаёт заявку, а не готовую учётную запись', async () => {
  const user = await AuthService.register({
    username: 'ivanov',
    password: 'парольпользователя',
    full_name: 'Иванов Иван'
  });
  const row = await identity.get('SELECT approval_status FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(row.approval_status, 'pending');
});

test('пока заявка не подтверждена, войти нельзя даже с верным паролем', async () => {
  await assert.rejects(
    () => AuthService.login('ivanov', 'парольпользователя'),
    /не подтверждена/,
    'неподтверждённый сотрудник не должен попадать в систему'
  );
});

test('неверный пароль проверяется раньше статуса заявки', async () => {
  // Иначе по разнице ответов можно было бы выяснять, какие заявки поданы.
  await assert.rejects(() => AuthService.login('ivanov', 'не тот пароль'), /Неверный логин или пароль/);
});

test('несуществующий логин и неверный пароль неотличимы по ответу', async () => {
  // Разные сообщения превращают форму входа в справочник логинов компании:
  // перебираешь фамилии и смотришь, где ответ «неверный пароль».
  const messageFor = async (username, password) => {
    try {
      await AuthService.login(username, password);
      return null;
    } catch (err) {
      return err.message;
    }
  };
  const unknown = await messageFor('nosuchuser', 'не тот пароль');
  const wrongPassword = await messageFor('ivanov', 'не тот пароль');
  assert.ok(unknown, 'вход несуществующего сотрудника обязан отклоняться');
  assert.strictEqual(unknown, wrongPassword);
});

test('несуществующий логин проверяется так же долго, как существующий', async () => {
  // Без хэширования отказ по неизвестному логину приходит за миллисекунды, а
  // по известному — за время scrypt: та же утечка, только через секундомер.
  const timeOf = async (username) => {
    const started = process.hrtime.bigint();
    await AuthService.login(username, 'не тот пароль').catch(() => {});
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  await timeOf('ivanov');
  const known = await timeOf('ivanov');
  const unknown = await timeOf('nosuchuser');
  assert.ok(unknown > known / 3, `неизвестный: ${unknown.toFixed(1)} мс, известный: ${known.toFixed(1)} мс`);
});

test('заявка не попадает в общие каналы до одобрения', async () => {
  const user = await identity.get(`SELECT id FROM users WHERE username = 'ivanov'`);
  const count = chat.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?').get(user.id);
  assert.strictEqual(count.n, 0);
});

test('после одобрения вход работает и сотрудник добавлен в каналы', async () => {
  const user = await identity.get(`SELECT id FROM users WHERE username = 'ivanov'`);
  await AuthService.approveUser(user.id);

  const result = await AuthService.login('ivanov', 'парольпользователя');
  assert.ok(result.token, 'должен выдаваться токен');
  assert.strictEqual(result.user.username, 'ivanov');

  const count = chat.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?').get(user.id);
  assert.ok(count.n > 0, 'сотрудник должен попасть в системные каналы');
});

test('отклонённая заявка не пускает в систему', async () => {
  await AuthService.register({ username: 'petrov', password: 'другойпароль', full_name: 'Петров Пётр' });
  const user = await identity.get(`SELECT id FROM users WHERE username = 'petrov'`);
  await AuthService.rejectUser(user.id);

  await assert.rejects(() => AuthService.login('petrov', 'другойпароль'));
});

test('регистрация не позволяет назначить себе роль', async () => {
  const admin = await identity.get(`SELECT id FROM roles WHERE name = 'Суперадминистратор'`);
  await AuthService.register({
    username: 'hacker',
    password: 'парольвзломщика',
    full_name: 'Кто-то',
    role_id: admin.id
  });
  const created = await identity.get(`SELECT role_id FROM users WHERE username = 'hacker'`);
  assert.notStrictEqual(created.role_id, admin.id, 'роль из запроса не должна учитываться');
});

test('регистрация не принимает несуществующее подразделение', async () => {
  // Иначе сотрудник оказался бы приписан к подразделению, которого нет, и
  // выпал бы из любого «контура» — в том числе из проверок прав.
  await AuthService.register({
    username: 'nowhere',
    password: 'парольникуда',
    full_name: 'Никто Ниоткуда',
    department_id: 999999
  });
  const created = await identity.get(`SELECT department_id FROM users WHERE username = 'nowhere'`);
  assert.strictEqual(created.department_id, null);
});

test('слабый пароль при регистрации не принимается', async () => {
  await assert.rejects(
    () => AuthService.register({ username: 'weakling', password: '123456', full_name: 'Слабый Пароль' }),
    /слишком простой|не короче/
  );
});

test('существующие учётные записи миграция не ломает', async () => {
  const admin = await identity.get(`SELECT approval_status FROM users WHERE username = 'admin'`);
  assert.strictEqual(admin.approval_status, 'approved', 'админ должен остаться рабочим');
});
