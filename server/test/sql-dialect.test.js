const test = require('node:test');
const assert = require('node:assert');
const { toPositional } = require('../src/db/identity/driver-sqlite');

// Запросы к хранилищу учётных записей написаны с параметрами вида $1, $2 —
// так требует PostgreSQL, где одно и то же значение, использованное в разных
// местах запроса, обязано ссылаться на один номер. Драйвер SQLite переписывает
// их в позиционные «?». Ошибка здесь не видна глазами: запрос выполнится, но
// с чужими значениями в параметрах.

test('нумерованные параметры превращаются в позиционные по порядку', () => {
  const { text, values } = toPositional('SELECT * FROM users WHERE id = $1 AND username = $2', [7, 'admin']);
  assert.strictEqual(text, 'SELECT * FROM users WHERE id = ? AND username = ?');
  assert.deepStrictEqual(values, [7, 'admin']);
});

test('одно значение можно использовать несколько раз', () => {
  // Так написан toggleUserActive: $1 встречается трижды.
  const { text, values } = toPositional(
    "UPDATE users SET is_active = $1, status = CASE WHEN $1 = 0 THEN 'offline' ELSE status END WHERE id = $2",
    [0, 42]
  );
  assert.strictEqual(
    text,
    "UPDATE users SET is_active = ?, status = CASE WHEN ? = 0 THEN 'offline' ELSE status END WHERE id = ?"
  );
  assert.deepStrictEqual(values, [0, 0, 42], 'повторная ссылка должна подставить то же значение');
});

test('параметры, идущие не по порядку, подставляются по номеру', () => {
  const { text, values } = toPositional('SELECT $2, $1, $2', ['первый', 'второй']);
  assert.strictEqual(text, 'SELECT ?, ?, ?');
  assert.deepStrictEqual(values, ['второй', 'первый', 'второй']);
});

test('двузначные номера не путаются с однозначными', () => {
  // $1 и $11 начинаются одинаково: разбор «по первому символу» подставил бы
  // в оба одно значение.
  const params = Array.from({ length: 12 }, (_, i) => i + 1);
  const { values } = toPositional('SELECT $11, $1, $12', params);
  assert.deepStrictEqual(values, [11, 1, 12]);
});

test('запрос без параметров остаётся как есть', () => {
  const { text, values } = toPositional('SELECT COUNT(*) FROM users', []);
  assert.strictEqual(text, 'SELECT COUNT(*) FROM users');
  assert.deepStrictEqual(values, []);
});

test('все запросы к хранилищу написаны в одном диалекте', () => {
  // Позиционный «?» работает в SQLite и молча ломается в PostgreSQL. Такую
  // ошибку не поймает ни один тест, пока он идёт на SQLite, — поэтому она
  // ищется в самом тексте запросов.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '../src');

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;

      const source = fs.readFileSync(full, 'utf8');
      // Обращения к хранилищу учётных записей узнаются по вызовам identity().
      if (!/identity\(\)\s*\.\s*(get|all|run|query)|db\.(get|all|run)\(/.test(source)) continue;

      for (const match of source.matchAll(/identity\(\)\s*\.\s*(?:get|all|run|query)\(\s*(`[^`]*`|'[^']*')/g)) {
        if (match[1].includes('?')) offenders.push(`${path.relative(root, full)}: ${match[1].slice(0, 60)}`);
      }
    }
  };
  walk(root);

  assert.deepStrictEqual(offenders, [], 'в запросах к учётным записям должны быть $1, $2, а не ?');
});
