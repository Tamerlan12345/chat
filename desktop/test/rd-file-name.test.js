const test = require('node:test');
const assert = require('node:assert');
const {
  sanitizeFileName: sanitize,
  isDangerousFileName,
  planReceivedFileName,
  zoneIdentifierContent,
  formatFileSize
} = require('../src/main/received-file');

// Имя файла приходит с машины оператора, то есть является недоверенным.
// Проверяется та же очистка, что выполняется в main.js перед записью: без неё
// строка вида "..\..\Windows\System32\x.dll" увела бы запись за пределы папки
// «Загрузки», а evil.exe лёг бы молча и без пометки «из интернета».

test('обход каталога вверх не проходит', () => {
  assert.strictEqual(sanitize('..\\..\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.strictEqual(sanitize('../../etc/passwd'), 'passwd');
});

test('абсолютный путь сводится к имени файла', () => {
  assert.strictEqual(sanitize('C:\\Windows\\System32\\drivers\\etc\\hosts'), 'hosts');
});

test('запрещённые в Windows символы заменяются', () => {
  assert.strictEqual(sanitize('от*чёт:2026?.xlsx'), 'от_чёт_2026_.xlsx');
  assert.strictEqual(sanitize('file.txt:Zone.Identifier'), 'file.txt_Zone.Identifier', 'поток NTFS');
});

test('обычное имя не портится', () => {
  assert.strictEqual(sanitize('Договор №12 (правки).docx'), 'Договор №12 (правки).docx');
});

test('пустое имя заменяется запасным', () => {
  assert.strictEqual(sanitize(''), 'файл');
  assert.strictEqual(sanitize(null), 'файл');
  assert.strictEqual(sanitize('...'), 'файл');
  assert.strictEqual(sanitize('..'), 'файл');
});

test('точки и пробелы в конце не прячут расширение', () => {
  assert.strictEqual(sanitize('evil.exe. . '), 'evil.exe');
  assert.strictEqual(planReceivedFileName('evil.exe.').name, 'evil.exe.txt');
});

test('зарезервированные имена Windows не проходят как есть', () => {
  for (const name of ['CON', 'con.txt', 'NUL', 'aux.tar.gz', 'COM1', 'lpt9.log', 'PRN']) {
    assert.ok(sanitize(name).startsWith('_'), name);
  }
  assert.strictEqual(sanitize('console.txt'), 'console.txt');
  assert.strictEqual(sanitize('com10.txt'), 'com10.txt');
});

test('символы направления текста вырезаются', () => {
  // «отчёт\u202Efdp.exe» в проводнике выглядит как «отчётexe.pdf».
  const name = sanitize('отчёт\u202Efdp.exe');
  assert.strictEqual(name, 'отчётfdp.exe');
  assert.strictEqual(isDangerousFileName(name), true);
});

test('исполняемые типы сохраняются с безопасным расширением', () => {
  for (const name of ['setup.exe', 'a.MSI', 'run.bat', 'x.cmd', 'y.ps1', 'z.vbs', 'q.js', 'h.hta', 'link.lnk', 'lib.dll', 'k.reg', 'app.jar', 'p.pif', 's.scr', 'c.cpl', 'w.wsf', 'j.jse', 'disk.iso']) {
    const plan = planReceivedFileName(name);
    assert.strictEqual(plan.renamed, true, name);
    assert.strictEqual(plan.name, `${name}.txt`, name);
  }
});

test('двойное расширение не обманывает проверку', () => {
  assert.strictEqual(planReceivedFileName('invoice.pdf.exe').name, 'invoice.pdf.exe.txt');
  assert.strictEqual(planReceivedFileName('invoice.exe.pdf').renamed, false);
});

test('документы сохраняются под своим именем', () => {
  for (const name of ['отчёт.xlsx', 'скан.pdf', 'фото.jpg', 'архив.zip', 'README']) {
    const plan = planReceivedFileName(name);
    assert.strictEqual(plan.renamed, false, name);
    assert.strictEqual(plan.name, name);
  }
});

test('длинное имя обрезается с сохранением расширения', () => {
  const name = sanitize('а'.repeat(500) + '.exe');
  assert.ok(name.length <= 180);
  assert.ok(name.endsWith('.exe'));
  assert.strictEqual(planReceivedFileName('а'.repeat(500) + '.exe').renamed, true);
});

test('пометка Zone.Identifier — зона «Интернет»', () => {
  assert.strictEqual(zoneIdentifierContent(), '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.strictEqual(
    zoneIdentifierContent('https://chat.example.kz'),
    '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://chat.example.kz\r\n'
  );
  assert.ok(!zoneIdentifierContent('https://x\r\nZoneId=0').includes('ZoneId=0'), 'перевод строки в адресе не добавляет полей');
});

test('размер файла по-русски', () => {
  assert.strictEqual(formatFileSize(512), '512 Б');
  assert.strictEqual(formatFileSize(1536), '1,5 КБ');
  assert.strictEqual(formatFileSize(5 * 1024 * 1024), '5,0 МБ');
});
