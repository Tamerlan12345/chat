const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildFixture, renderFixtureYml, writeReleaseDir, tempDir } = require('./helpers/update-fixtures');
const { createUpdateStore, readYml, renderYml } = require('../src/services/update-store.service');

// Хранилище релизов автообновления: единственное место, где файлы попадают в
// раздачу. Проверяется всё, что обещает спецификация: строгий разбор
// latest.yml, имена только по шаблону версии, MZ, размер и sha512, атомарный
// перенос и отсутствие хвостов после неудачи, поиск файла только по индексу.

const actor = { id: 1, username: 'admin' };

function newStore(opts = {}) {
  const dir = tempDir();
  const store = createUpdateStore({ dir, maxFileBytes: 1024 * 1024, ...opts });
  store.init();
  return { dir, store };
}

function putInbox(dir, name, fixture, extra) {
  return writeReleaseDir(path.join(dir, 'inbox', name), fixture, extra);
}

function tmpEntries(dir) {
  return fs.readdirSync(path.join(dir, '.tmp'));
}

async function rejectsWith(promise, { status, message }) {
  await assert.rejects(promise, (err) => {
    if (status !== undefined) assert.strictEqual(err.status, status, `ожидался код ${status}, получено ${err.status}: ${err.message}`);
    if (message) assert.match(err.message, message);
    return true;
  });
}

test('init создаёт каталоги releases, inbox и .tmp', () => {
  const { dir } = newStore();
  for (const sub of ['releases', 'inbox', '.tmp']) {
    assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), sub);
  }
});

test('импорт из inbox: релиз появляется, папка inbox убирается, аудит-сводка верна', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0', { withPortable: true });
  putInbox(dir, 'rel-1.2.0', fx);

  const summary = await store.importFromDir('rel-1.2.0', { actor, notes: 'Исправлена передача файлов' });
  assert.strictEqual(summary.version, '1.2.0');
  assert.strictEqual(summary.sha512, fx.sha512);
  assert.strictEqual(summary.size, fx.setup.length);
  assert.deepStrictEqual(
    summary.files.map((f) => f.name).sort(),
    [fx.blockmapName, fx.setupName, fx.portableName].sort()
  );

  const rel = store.getRelease('1.2.0');
  assert.strictEqual(rel.importedBy, 'admin');
  assert.strictEqual(rel.notes, 'Исправлена передача файлов');
  assert.ok(rel.importedAt);
  assert.ok(fs.existsSync(path.join(dir, 'releases', '1.2.0', 'release.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'releases', '1.2.0', 'README.txt')), 'лишние файлы не переносятся');
  assert.ok(!fs.existsSync(path.join(dir, 'inbox', 'rel-1.2.0')), 'импортированная папка убрана из inbox');
  assert.deepStrictEqual(tmpEntries(dir), []);

  assert.strictEqual(store.resolveFile(fx.setupName), path.join(dir, 'releases', '1.2.0', fx.setupName));
  assert.deepStrictEqual(store.listReleases().map((r) => r.version), ['1.2.0']);
});

test('импорт загрузки: файлы из временной папки становятся релизом', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.3.0-beta.1');
  const up = store.createTempDir();
  fs.writeFileSync(path.join(up, 'yml'), fx.yml);
  fs.writeFileSync(path.join(up, 'setup'), fx.setup);
  fs.writeFileSync(path.join(up, 'blockmap'), fx.blockmap);

  const summary = await store.importUpload(
    { yml: path.join(up, 'yml'), setup: path.join(up, 'setup'), blockmap: path.join(up, 'blockmap') },
    { actor, notes: '' }
  );
  assert.strictEqual(summary.version, '1.3.0-beta.1');
  assert.ok(store.resolveFile(fx.blockmapName));
  fs.rmSync(up, { recursive: true, force: true });
  assert.deepStrictEqual(tmpEntries(dir), []);
});

test('загрузка принимает файлы только из собственной временной папки', async () => {
  const { store } = newStore();
  const fx = buildFixture('1.2.0');
  const outside = tempDir('omc-outside-');
  fs.writeFileSync(path.join(outside, 'yml'), fx.yml);
  fs.writeFileSync(path.join(outside, 'setup'), fx.setup);
  await rejectsWith(
    store.importUpload({ yml: path.join(outside, 'yml'), setup: path.join(outside, 'setup') }, { actor }),
    { status: 400 }
  );
});

test('несовпадение sha512 → отказ с текстом про переподпись', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0');
  fx.setup[100] ^= 0xff; // «переподписали» после сборки
  putInbox(dir, 'x', fx);
  await rejectsWith(store.importFromDir('x', { actor }), {
    status: 400,
    message: /Файл переподписан после сборки — загрузите файл из desktop\/release/
  });
  assert.ok(!fs.existsSync(path.join(dir, 'releases', '1.2.0')), 'частичного релиза нет');
  assert.deepStrictEqual(tmpEntries(dir), [], 'временная папка убрана');
  assert.ok(fs.existsSync(path.join(dir, 'inbox', 'x')), 'inbox остаётся для исправления');
});

test('несовпадение размера → отказ', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0');
  const yml = renderFixtureYml({
    version: '1.2.0', url: fx.setupName, sha512: fx.sha512, size: fx.setup.length + 1,
    path: fx.setupName, releaseDate: '2026-09-28T10:00:00.000Z'
  });
  putInbox(dir, 'x', fx, { yml });
  await rejectsWith(store.importFromDir('x', { actor }), { status: 400, message: /размер/i });
  assert.deepStrictEqual(tmpEntries(dir), []);
});

test('файл без сигнатуры MZ → отказ', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0', { exe: Buffer.from('#!/bin/sh\necho не exe\n') });
  putInbox(dir, 'x', fx);
  await rejectsWith(store.importFromDir('x', { actor }), { status: 400, message: /MZ|исполняем/i });
  assert.deepStrictEqual(tmpEntries(dir), []);
});

test('файл больше предела → отказ', async () => {
  const { dir, store } = newStore({ maxFileBytes: 1000 });
  const fx = buildFixture('1.2.0');
  putInbox(dir, 'x', fx);
  await rejectsWith(store.importFromDir('x', { actor }), { status: 400, message: /предел|больше/i });
  assert.deepStrictEqual(tmpEntries(dir), []);
});

test('неверная версия → отказ', async () => {
  for (const bad of ['1.2', 'v1.2.0', '1.2.0+build.5', '01.2.0-', '1.2.0-бета', '1.2.0 ', '1.2.0-a..b/']) {
    const { dir, store } = newStore();
    const fx = buildFixture('1.2.0');
    const yml = fx.yml.replace('version: 1.2.0', `version: '${bad}'`);
    putInbox(dir, 'x', fx, { yml });
    await rejectsWith(store.importFromDir('x', { actor }), { status: 400 });
  }
});

test('повтор версии → 409, существующий релиз не тронут', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0');
  putInbox(dir, 'a', fx);
  await store.importFromDir('a', { actor });

  const again = buildFixture('1.2.0');
  putInbox(dir, 'b', again);
  await rejectsWith(store.importFromDir('b', { actor }), { status: 409 });
  const onDisk = fs.readFileSync(path.join(dir, 'releases', '1.2.0', fx.setupName));
  assert.ok(onDisk.equals(fx.setup), 'первый релиз не перезаписан');
  assert.deepStrictEqual(tmpEntries(dir), []);
});

test('имена файлов в yml: обход пути и чужие имена отвергаются', async () => {
  const names = [
    '../CentyChat-Setup-1.2.0.exe',
    '..\\CentyChat-Setup-1.2.0.exe',
    '%2e%2e%2fCentyChat-Setup-1.2.0.exe',
    '/etc/CentyChat-Setup-1.2.0.exe',
    'C:\\CentyChat-Setup-1.2.0.exe',
    'CentyChat-Setup-1.2.0.exe\u0000.txt',
    `${'A'.repeat(130)}.exe`,
    'CentyChat-Setup-1.1.0.exe',
    // Имя сборок до переименования в CentyChat — тоже чужое.
    'OpenMyChat-Enterprise-Setup-1.2.0.exe',
    'Setup.exe'
  ];
  for (const name of names) {
    const { dir, store } = newStore();
    const fx = buildFixture('1.2.0');
    const yml = renderFixtureYml({
      version: '1.2.0', url: JSON.stringify(name), sha512: fx.sha512, size: fx.setup.length,
      path: JSON.stringify(name), releaseDate: '2026-09-28T10:00:00.000Z'
    });
    putInbox(dir, 'x', fx, { yml });
    await rejectsWith(store.importFromDir('x', { actor }), { status: 400 });
    assert.deepStrictEqual(tmpEntries(dir), [], name);
    assert.ok(!fs.existsSync(path.join(dir, 'releases', '1.2.0')), name);
  }
});

test('имя папки inbox: обход пути и мусор отвергаются', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0');
  // Настоящий релиз лежит уровнем выше inbox — до него нельзя дотянуться.
  writeReleaseDir(path.join(dir, 'outside'), fx);
  for (const name of ['..', '.', '../outside', '..\\outside', '%2e%2e', path.join(dir, 'outside'), 'a\u0000b', 'x'.repeat(65), '']) {
    await rejectsWith(store.importFromDir(name, { actor }), {});
  }
  assert.deepStrictEqual(store.listReleases(), []);
  await rejectsWith(store.importFromDir('no-such-dir', { actor }), { status: 404 });
});

test('resolveFile ищет только по индексу', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0');
  putInbox(dir, 'x', fx);
  await store.importFromDir('x', { actor });
  fs.writeFileSync(path.join(dir, 'releases', '1.2.0', 'stray.exe'), 'MZ');

  assert.ok(store.resolveFile(fx.setupName));
  for (const name of [
    'release.json', 'stray.exe', 'latest.yml', `../1.2.0/${fx.setupName}`, `..\\${fx.setupName}`,
    '%2e%2e', '/etc/passwd', 'C:\\Windows\\win.ini', `${fx.setupName}\u0000`, 'a'.repeat(200),
    '__proto__', 'constructor', 'toString', ''
  ]) {
    assert.strictEqual(store.resolveFile(name), null, JSON.stringify(name));
  }
});

test('индекс находит blockmap старой версии и переживает перезапуск', async () => {
  const { dir, store } = newStore();
  const old = buildFixture('1.0.0');
  const cur = buildFixture('1.1.0');
  putInbox(dir, 'old', old);
  putInbox(dir, 'cur', cur);
  await store.importFromDir('old', { actor });
  await store.importFromDir('cur', { actor });

  assert.strictEqual(store.resolveFile(old.blockmapName), path.join(dir, 'releases', '1.0.0', old.blockmapName));

  const again = createUpdateStore({ dir, maxFileBytes: 1024 * 1024 });
  again.init();
  assert.ok(again.resolveFile(old.blockmapName));
  assert.ok(again.resolveFile(cur.setupName));
  assert.deepStrictEqual(again.listReleases().map((r) => r.version), ['1.1.0', '1.0.0']);
});

test('удаление: target отказ 409, иначе релиз и его файлы уходят из индекса', async () => {
  const { dir, store } = newStore();
  const fx = buildFixture('1.2.0');
  putInbox(dir, 'x', fx);
  await store.importFromDir('x', { actor });

  const policy = { channels: { stable: { target: null, rolloutPercent: 0 }, beta: { target: '1.2.0', rolloutPercent: 100 } } };
  await rejectsWith(store.deleteRelease('1.2.0', policy), { status: 409 });
  assert.ok(store.getRelease('1.2.0'));

  await store.deleteRelease('1.2.0', { channels: { stable: { target: null }, beta: { target: null } } });
  assert.strictEqual(store.getRelease('1.2.0'), null);
  assert.strictEqual(store.resolveFile(fx.setupName), null);
  assert.ok(!fs.existsSync(path.join(dir, 'releases', '1.2.0')));
  assert.deepStrictEqual(tmpEntries(dir), []);

  await rejectsWith(store.deleteRelease('9.9.9', {}), { status: 404 });
  await rejectsWith(store.deleteRelease('../1.2.0', {}), { status: 400 });
});

test('listInbox показывает папки с проблемами без импорта', async () => {
  const { dir, store } = newStore();
  const good = buildFixture('1.2.0');
  putInbox(dir, 'good', good);
  fs.mkdirSync(path.join(dir, 'inbox', 'empty'));
  const inbox = store.listInbox();
  const byName = Object.fromEntries(inbox.map((e) => [e.name, e]));
  assert.deepStrictEqual(byName.good.problems, []);
  assert.strictEqual(byName.good.version, '1.2.0');
  assert.ok(byName.empty.problems.length > 0);
});

test('readYml разбирает формат electron-builder', () => {
  const text = [
    'version: 1.2.0',
    'files:',
    '  - url: CentyChat-Setup-1.2.0.exe',
    '    sha512: abc+/=',
    '    size: 12345',
    '    blockMapSize: 777',
    'path: CentyChat-Setup-1.2.0.exe',
    'sha512: abc+/=',
    "releaseDate: '2026-09-28T10:00:00.000Z'",
    ''
  ].join('\r\n');
  assert.deepStrictEqual(readYml(text), {
    version: '1.2.0',
    files: [{ url: 'CentyChat-Setup-1.2.0.exe', sha512: 'abc+/=', size: 12345, blockMapSize: 777 }],
    path: 'CentyChat-Setup-1.2.0.exe',
    sha512: 'abc+/=',
    releaseDate: '2026-09-28T10:00:00.000Z'
  });
});

test('readYml отвергает неожиданную форму', () => {
  const good = buildFixture('1.2.0').yml;
  const bad = [
    good + 'stagingPercentage: 10\n', // неизвестный ключ
    good.replace('version: 1.2.0', 'version: &a 1.2.0'), // якорь
    good.replace('files:', 'files: []'), // поточная форма
    good.replace('    size: ', '\tsize: '), // табуляция
    good.replace(/  - url: .*\n/, ''), // элемент без url
    good.replace(/path: .*\n/, ''), // нет path
    good.replace(/    size: \d+/, '    size: 12.5'), // размер не целое
    good.replace(/    size: \d+/, '    size: -1'),
    good.replace(/    size: \d+/, '    size: "10"'),
    good + 'version: 9.9.9\n', // повтор ключа
    good.replace('files:', 'files:\n  nested: 1'),
    good.replace("releaseDate: '", 'releaseDate: |\n  '),
    good.replace(/    sha512: .*\n/, '    sha512: x\n    evil: 1\n'),
    'просто текст',
    '',
    'version: 1.2.0\n'.repeat(1) + 'x'.repeat(70000)
  ];
  for (const text of bad) {
    assert.throws(() => readYml(text), (err) => err.status === 400, JSON.stringify(text.slice(0, 120)));
  }
});

test('renderYml → readYml даёт исходное', () => {
  const feed = {
    version: '1.3.0-beta.2',
    files: [{ url: 'CentyChat-Setup-1.3.0-beta.2.exe', sha512: 'q+w/e=r==', size: 987654 }],
    path: 'CentyChat-Setup-1.3.0-beta.2.exe',
    sha512: 'q+w/e=r==',
    releaseDate: '2026-09-28T10:00:00.000Z',
    releaseNotes: "Строка с 'кавычками', \"двойными\", двоеточием: и # решёткой\nи переводом строки"
  };
  assert.deepStrictEqual(readYml(renderYml(feed)), feed);
  const withBlockmap = { ...feed, files: [{ ...feed.files[0], blockMapSize: 42 }] };
  delete withBlockmap.releaseNotes;
  assert.deepStrictEqual(readYml(renderYml(withBlockmap)), withBlockmap);
});
