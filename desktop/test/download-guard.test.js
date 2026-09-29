const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { safeDownloadName, isDangerousExtension } = require('../src/main/download-guard');

// ── Имя файла, скачиваемого из обычной переписки ────────────────────────────
// Модуль чистый (без 'electron'): вся логика повторно использует
// received-file.js — второго списка опасных расширений тут нет.

test('символы направления текста вырезаны, расширение под ними всё равно опасное', () => {
  const withRtlOverride = 'отчёт‮fdp.exe';
  assert.strictEqual(isDangerousExtension(withRtlOverride), true);
  const safe = safeDownloadName(withRtlOverride);
  assert.ok(!safe.includes('‮'), 'U+202E не должен остаться в итоговом имени');
});

test('двойное расширение остаётся опасным, обычный документ — нет', () => {
  assert.strictEqual(isDangerousExtension('invoice.pdf.exe'), true);
  assert.strictEqual(isDangerousExtension('report.pdf'), false);
});

test('опасное расширение получает добавочный .txt при сохранении', () => {
  const name = safeDownloadName('invoice.pdf.exe');
  assert.match(name, /\.txt$/);
  assert.match(name, /invoice\.pdf\.exe/i, 'исходное имя видно внутри — просто не исполняется двойным щелчком');
});

test('зарезервированное имя Windows и хвостовые точки/пробелы обезврежены', () => {
  const con = safeDownloadName('CON.txt');
  assert.doesNotMatch(con, /^con\.txt$/i);
  assert.strictEqual(isDangerousExtension(con), false);

  const trailing = safeDownloadName('file. ');
  assert.strictEqual(trailing, 'file');
  assert.doesNotMatch(trailing, /[. ]$/);
});

// ── Статические проверки собранной сборки ───────────────────────────────────
// По образцу test/client-hardening.test.js (main.js читается как текст).

test('electronFuses запрещают дополнительные привилегии протокола file:', () => {
  const pkg = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  assert.match(pkg, /grantFileProtocolExtraPrivileges"?\s*:\s*false/);
});

test('main.js закрывает меню приложения и обрабатывает скачивания', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /setApplicationMenu\(null\)/, 'меню приложения отключено в собранной сборке');
  assert.match(main, /will-download/, 'скачивания обрабатываются в main.js');
  assert.match(main, /devtools-opened/, 'DevTools закрываются, если их всё же открыли');
  assert.match(main, /before-input-event/, 'F12/Ctrl+Shift+I перехватываются до открытия DevTools');
});
