import test from 'node:test';
import assert from 'node:assert';
import {
  extensionOf,
  checkName,
  isRiskyExtension,
  acceptAttr,
  checkFileAgainstPolicy
} from '../src/renderer/src/lib/file-policy.mjs';

test('расширение — по последней точке, в нижнем регистре', () => {
  assert.strictEqual(extensionOf('A.PDF'), 'pdf');
  assert.strictEqual(extensionOf('archive.tar.gz'), 'gz');
  assert.strictEqual(extensionOf('без_расширения'), '');
  assert.strictEqual(extensionOf('.gitignore'), '');
  assert.strictEqual(extensionOf('trailing.'), '');
});

test('checkName ловит подмену направления письма (U+202E)', () => {
  assert.match(checkName('a' + '\u202E' + 'fdp.exe'), /символ/i);
  assert.strictEqual(checkName('report.pdf'), null);
  assert.match(checkName('a' + '\u2066' + 'b.txt'), /символ/i);
});

test('checkName ловит всю группу bidi-control (LRO/LRE и т.п.), не только RLO', () => {
  assert.match(checkName('a' + '\u202D' + 'fdp.exe'), /символ/i); // LRO
  assert.match(checkName('a' + '\u202A' + 'fdp.exe'), /символ/i); // LRE
});

test('рискованные расширения помечены для предупреждения администратору', () => {
  assert.strictEqual(isRiskyExtension('ps1'), true);
  assert.strictEqual(isRiskyExtension('EXE'), true);
  assert.strictEqual(isRiskyExtension('pdf'), false);
});

test('acceptAttr собирает строку для <input accept>', () => {
  assert.strictEqual(acceptAttr(['pdf', 'png']), '.pdf,.png');
  assert.strictEqual(acceptAttr([]), '');
  assert.strictEqual(acceptAttr(undefined), '');
});

test('checkFileAgainstPolicy: расширение вне списка отклоняется', () => {
  const policy = { enabled: true, allowed: ['pdf', 'png'] };
  assert.strictEqual(checkFileAgainstPolicy({ name: 'report.pdf' }, policy), null);
  assert.match(checkFileAgainstPolicy({ name: 'tool.exe' }, policy), /не разрешены/);
});

test('checkFileAgainstPolicy: выключенный фильтр пропускает любое расширение, но не подмену имени', () => {
  const policy = { enabled: false, allowed: ['pdf'] };
  assert.strictEqual(checkFileAgainstPolicy({ name: 'data.bin' }, policy), null);
  assert.match(checkFileAgainstPolicy({ name: 'a' + '\u202E' + 'fdp.exe' }, policy), /символ/i);
});

test('checkFileAgainstPolicy: без политики (сервер недоступен) не блокирует по расширению', () => {
  assert.strictEqual(checkFileAgainstPolicy({ name: 'tool.exe' }, null), null);
});
