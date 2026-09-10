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

// Повторяет проверку из маршрута PUT /admin/roles/:id. Она решает, можно ли
// снять права администратора, не оставив систему без управления вовсе —
// восстановить такое можно было бы только правкой базы напрямую.
function wouldLockEveryoneOut(roleId, nextPermissions) {
  const d = database();
  const role = d.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  const current = JSON.parse(role.permissions_json || '{}');
  const hadFullAdmin = Boolean(current.is_admin) && !current.is_scoped_admin;
  const grantsFullAdmin = Boolean(nextPermissions.is_admin) && !nextPermissions.is_scoped_admin;
  if (!hadFullAdmin || grantsFullAdmin) return false;

  const remaining = d
    .prepare(`
      SELECT COUNT(*) AS n
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND u.role_id != ?
        AND r.permissions_json LIKE '%"is_admin":true%'
        AND r.permissions_json NOT LIKE '%"is_scoped_admin":true%'
    `)
    .get(roleId);
  return !remaining.n;
}

const roleId = (name) => database().prepare('SELECT id FROM roles WHERE name = ?').get(name).id;

test('снятие прав у единственной администраторской роли запрещено', () => {
  database();
  const superId = roleId('Суперадминистратор');
  assert.strictEqual(
    wouldLockEveryoneOut(superId, { is_admin: false, can_call: true }),
    true,
    'иначе систему можно необратимо оставить без администратора'
  );
});

test('прочие права у администраторской роли менять можно', () => {
  const superId = roleId('Суперадминистратор');
  assert.strictEqual(
    wouldLockEveryoneOut(superId, { is_admin: true, can_remote_control: false }),
    false,
    'признак администратора сохраняется — правка безопасна'
  );
});

test('права обычной роли меняются свободно', () => {
  const memberId = roleId('Сотрудник');
  assert.strictEqual(
    wouldLockEveryoneOut(memberId, { is_admin: false, can_call: false }),
    false
  );
});

test('роль администратора подразделения не считается заменой суперадминистратору', () => {
  // У неё стоит is_admin, но с is_scoped_admin — полными правами она не даёт.
  const d = database();
  const scopedId = roleId('Контурный администратор');
  const superId = roleId('Суперадминистратор');

  // Переводим администратора на контурную роль: полноправных не остаётся.
  d.prepare('UPDATE users SET role_id = ? WHERE username = ?').run(scopedId, 'admin');
  assert.strictEqual(
    wouldLockEveryoneOut(superId, { is_admin: false }),
    true,
    'контурный администратор не заменяет полноправного'
  );
});

test('при наличии второго полноправного администратора правка разрешена', () => {
  const d = database();
  const superId = roleId('Суперадминистратор');
  d.prepare('UPDATE users SET role_id = ? WHERE username = ?').run(superId, 'admin');

  // Заводим вторую полноправную роль и сотрудника на ней.
  const second = d.prepare(
    "INSERT INTO roles (name, description, permissions_json) VALUES ('Второй администратор', '', ?)"
  ).run(JSON.stringify({ is_admin: true, can_manage_users: true }));
  const secondId = Number(second.lastInsertRowid);

  d.prepare(`
    INSERT INTO users (username, password_hash, salt, full_name, role_id, uin, created_at, is_active)
    VALUES ('backup_admin', 'x', 'y', 'Запасной администратор', ?, 9999, ?, 1)
  `).run(secondId, new Date().toISOString());

  assert.strictEqual(
    wouldLockEveryoneOut(superId, { is_admin: false }),
    false,
    'запасной администратор остаётся — правка допустима'
  );
});
