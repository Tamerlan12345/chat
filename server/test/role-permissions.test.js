const test = require('node:test');
const assert = require('node:assert');
const { freshBoot } = require('./helpers/boot');

let identity;

test.before(async () => {
  ({ identity } = await freshBoot());
});

// Повторяет проверку из маршрута PUT /admin/roles/:id. Она решает, можно ли
// снять права администратора, не оставив систему без управления вовсе —
// восстановить такое можно было бы только правкой базы напрямую.
async function wouldLockEveryoneOut(roleId, nextPermissions) {
  const role = await identity.get('SELECT * FROM roles WHERE id = $1', [roleId]);
  const current = JSON.parse(role.permissions_json || '{}');
  const hadFullAdmin = Boolean(current.is_admin) && !current.is_scoped_admin;
  const grantsFullAdmin = Boolean(nextPermissions.is_admin) && !nextPermissions.is_scoped_admin;
  if (!hadFullAdmin || grantsFullAdmin) return false;

  const remaining = await identity.get(
    `SELECT COUNT(*) AS n
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = 1 AND u.role_id <> $1
       AND r.permissions_json LIKE '%"is_admin":true%'
       AND r.permissions_json NOT LIKE '%"is_scoped_admin":true%'`,
    [roleId]
  );
  return !Number(remaining.n);
}

const roleId = async (name) => (await identity.get('SELECT id FROM roles WHERE name = $1', [name])).id;

test('снятие прав у единственной администраторской роли запрещено', async () => {
  const superId = await roleId('Суперадминистратор');
  assert.strictEqual(
    await wouldLockEveryoneOut(superId, { is_admin: false, can_call: true }),
    true,
    'иначе систему можно необратимо оставить без администратора'
  );
});

test('прочие права у администраторской роли менять можно', async () => {
  const superId = await roleId('Суперадминистратор');
  assert.strictEqual(
    await wouldLockEveryoneOut(superId, { is_admin: true, can_remote_control: false }),
    false,
    'признак администратора сохраняется — правка безопасна'
  );
});

test('права обычной роли меняются свободно', async () => {
  const memberId = await roleId('Сотрудник');
  assert.strictEqual(await wouldLockEveryoneOut(memberId, { is_admin: false, can_call: false }), false);
});

test('роль администратора подразделения не считается заменой суперадминистратору', async () => {
  // У неё стоит is_admin, но с is_scoped_admin — полными правами она не даёт.
  const scopedId = await roleId('Контурный администратор');
  const superId = await roleId('Суперадминистратор');

  // Переводим администратора на контурную роль: полноправных не остаётся.
  await identity.run('UPDATE users SET role_id = $1 WHERE username = $2', [scopedId, 'admin']);
  assert.strictEqual(
    await wouldLockEveryoneOut(superId, { is_admin: false }),
    true,
    'контурный администратор не заменяет полноправного'
  );
});

test('при наличии второго полноправного администратора правка разрешена', async () => {
  const superId = await roleId('Суперадминистратор');
  await identity.run('UPDATE users SET role_id = $1 WHERE username = $2', [superId, 'admin']);

  // Заводим вторую полноправную роль и сотрудника на ней.
  const second = await identity.run(
    `INSERT INTO roles (name, description, permissions_json)
     VALUES ('Второй администратор', '', $1) RETURNING id`,
    [JSON.stringify({ is_admin: true, can_manage_users: true })]
  );
  const secondId = Number(second.rows[0].id);

  await identity.run(
    `INSERT INTO users (username, password_hash, full_name, role_id, uin, created_at, is_active)
     VALUES ('backup_admin', 'scrypt$N=32768,r=8,p=1$AA==$AA==', 'Запасной администратор', $1, 9999, $2, 1)`,
    [secondId, new Date().toISOString()]
  );

  assert.strictEqual(
    await wouldLockEveryoneOut(superId, { is_admin: false }),
    false,
    'запасной администратор остаётся — правка допустима'
  );
});
