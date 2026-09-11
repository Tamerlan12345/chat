const test = require('node:test');
const assert = require('node:assert');
const { freshBoot } = require('./helpers/boot');

// Проверяет допущение, на котором держится разделение прав в api/index.js:
// администратор подразделения тоже имеет is_admin, и отличить его от
// суперадминистратора можно только по is_scoped_admin. Если заполнение базы
// когда-нибудь это изменит, тест упадёт раньше, чем права разъедутся.

let identity;

test.before(async () => {
  ({ identity } = await freshBoot());
});

// Копии проверок из api/index.js — они там не экспортируются.
const isSuperAdmin = (u) => Boolean(u.permissions.is_admin) && !u.permissions.is_scoped_admin;
const isScopedAdmin = (u) => Boolean(u.permissions.is_scoped_admin);

async function roleAsUser(roleName) {
  const role = await identity.get('SELECT permissions_json FROM roles WHERE name = $1', [roleName]);
  assert.ok(role, `роль "${roleName}" должна существовать после заполнения базы`);
  return { permissions: JSON.parse(role.permissions_json || '{}') };
}

test('суперадминистратор распознаётся как суперадминистратор', async () => {
  const user = await roleAsUser('Суперадминистратор');
  assert.ok(isSuperAdmin(user), 'иначе настоящий администратор потеряет доступ к консоли');
  assert.ok(!isScopedAdmin(user));
});

test('администратор подразделения НЕ проходит как суперадминистратор', async () => {
  // Ровно эта дыра и была: проверялся только is_admin, который у него есть,
  // и он получал полный доступ вплоть до произвольного SQL.
  const user = await roleAsUser('Контурный администратор');
  assert.ok(user.permissions.is_admin, 'у него действительно стоит is_admin');
  assert.ok(isScopedAdmin(user));
  assert.ok(!isSuperAdmin(user), 'но полными правами он обладать не должен');
});

test('обычный сотрудник не проходит ни одну из проверок', async () => {
  const user = await roleAsUser('Сотрудник');
  assert.ok(!isSuperAdmin(user));
  assert.ok(!isScopedAdmin(user));
});

test('роль "Сотрудник" ищется по названию, а не по номеру', async () => {
  // Клиент раньше жёстко слал role_id: 2, из-за чего создание пользователя
  // падало по внешнему ключу: нумерация ролей смещается миграциями.
  const role = await identity.get(`SELECT id FROM roles WHERE name = 'Сотрудник'`);
  assert.ok(role, 'роль по умолчанию должна существовать');
  assert.ok(Number.isInteger(role.id));
});
