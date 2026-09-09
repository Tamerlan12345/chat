const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Проверяет допущение, на котором держится разделение прав в api/index.js:
// администратор подразделения тоже имеет is_admin, и отличить его от
// суперадминистратора можно только по is_scoped_admin. Если заполнение базы
// когда-нибудь это изменит, тест упадёт раньше, чем права разъедутся.
const DB_PATH = path.resolve(__dirname, '../data/mychat.db');

// Одно подключение на весь файл: node:sqlite держит файл открытым, поэтому
// пересоздавать базу между тестами нельзя — Windows не даст её удалить.
// Все тесты здесь только читают роли, так что общей базы достаточно.
let db;
function freshDatabase() {
  if (!db) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch {}
    }
    db = require('../src/db').getDatabase();
  }
  return db;
}

// Копии проверок из api/index.js — они там не экспортируются.
const isSuperAdmin = (u) => Boolean(u.permissions.is_admin) && !u.permissions.is_scoped_admin;
const isScopedAdmin = (u) => Boolean(u.permissions.is_scoped_admin);

function roleAsUser(db, roleName) {
  const role = db.prepare('SELECT permissions_json FROM roles WHERE name = ?').get(roleName);
  assert.ok(role, `роль "${roleName}" должна существовать после заполнения базы`);
  return { permissions: JSON.parse(role.permissions_json || '{}') };
}

test('суперадминистратор распознаётся как суперадминистратор', () => {
  const db = freshDatabase();
  const user = roleAsUser(db, 'Суперадминистратор');
  assert.ok(isSuperAdmin(user), 'иначе настоящий администратор потеряет доступ к консоли');
  assert.ok(!isScopedAdmin(user));
});

test('администратор подразделения НЕ проходит как суперадминистратор', () => {
  // Ровно эта дыра и была: проверялся только is_admin, который у него есть,
  // и он получал полный доступ вплоть до произвольного SQL.
  const db = freshDatabase();
  const user = roleAsUser(db, 'Контурный администратор');
  assert.ok(user.permissions.is_admin, 'у него действительно стоит is_admin');
  assert.ok(isScopedAdmin(user));
  assert.ok(!isSuperAdmin(user), 'но полными правами он обладать не должен');
});

test('обычный сотрудник не проходит ни одну из проверок', () => {
  const db = freshDatabase();
  const user = roleAsUser(db, 'Сотрудник');
  assert.ok(!isSuperAdmin(user));
  assert.ok(!isScopedAdmin(user));
});

test('роль "Сотрудник" существует и её id не равен 2', () => {
  // Клиент раньше жёстко слал role_id: 2, из-за чего создание пользователя
  // падало по внешнему ключу. Тест фиксирует, почему нельзя вернуть цифру.
  const db = freshDatabase();
  const role = db.prepare("SELECT id FROM roles WHERE name = 'Сотрудник'").get();
  assert.ok(role, 'роль по умолчанию должна существовать');
  assert.notStrictEqual(role.id, 2, 'id ролей смещается миграцией — полагаться на число нельзя');
});

// Файл базы не удаляется: подключение ещё открыто, а сама база — временные
// данные разработчика и исключена из репозитория.
