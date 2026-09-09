const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Имя файла приходит с машины оператора, то есть является недоверенным.
// Здесь проверяется та же очистка, что выполняется в main.js перед записью:
// без неё строка вида "..\..\Windows\System32\x.dll" увела бы запись за
// пределы папки «Загрузки».
const sanitize = (fileName) =>
  path.basename(String(fileName || 'файл')).replace(/[<>:"/\\|?*]/g, '_');

test('обход каталога вверх не проходит', () => {
  assert.strictEqual(sanitize('..\\..\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.strictEqual(sanitize('../../etc/passwd'), 'passwd');
});

test('абсолютный путь сводится к имени файла', () => {
  assert.strictEqual(sanitize('C:\\Windows\\System32\\drivers\\etc\\hosts'), 'hosts');
});

test('запрещённые в Windows символы заменяются', () => {
  assert.strictEqual(sanitize('от*чёт:2026?.xlsx'), 'от_чёт_2026_.xlsx');
});

test('обычное имя не портится', () => {
  assert.strictEqual(sanitize('Договор №12 (правки).docx'), 'Договор №12 (правки).docx');
});

test('пустое имя заменяется запасным', () => {
  assert.strictEqual(sanitize(''), 'файл');
  assert.strictEqual(sanitize(null), 'файл');
});
