const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LAUNCH_ARG,
  launcherPath,
  loginItemOptions,
  wasLaunchedAtLogin,
  readPreference,
  writePreference,
  resolveEnabled,
  applyAutostart
} = require('../src/main/autostart');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mychat-autostart-'));

test('установленная версия прописывает свой exe с ключом автозапуска', () => {
  const options = loginItemOptions(true, { execPath: 'C:\\Apps\\OpenMyChat.exe', env: {} });
  assert.deepStrictEqual(options, { openAtLogin: true, path: 'C:\\Apps\\OpenMyChat.exe', args: [LAUNCH_ARG] });
});

test('переносная версия прописывает сам файл, а не временную папку распаковки', () => {
  // Временная папка исчезает после выхода — Windows запускала бы пустоту.
  const env = { PORTABLE_EXECUTABLE_FILE: 'D:\\Загрузки\\OpenMyChat-Portable.exe' };
  assert.strictEqual(launcherPath({ execPath: 'C:\\Temp\\2abc\\OpenMyChat.exe', env }), env.PORTABLE_EXECUTABLE_FILE);
});

test('запуск системой узнаётся по ключу или по отметке Windows', () => {
  assert.strictEqual(wasLaunchedAtLogin(['app.exe', LAUNCH_ARG]), true);
  assert.strictEqual(wasLaunchedAtLogin(['app.exe'], { wasOpenedAtLogin: true }), true);
  assert.strictEqual(wasLaunchedAtLogin(['app.exe'], { wasOpenedAtLogin: false }), false);
  assert.strictEqual(wasLaunchedAtLogin(['app.exe']), false);
});

test('при первом запуске автозапуск включён', () => {
  assert.strictEqual(resolveEnabled(tempDir()), true);
});

test('снятая сотрудником галочка не возвращается при следующем запуске', () => {
  const dir = tempDir();
  writePreference(dir, false);
  assert.strictEqual(readPreference(dir), false);
  assert.strictEqual(resolveEnabled(dir), false);
  writePreference(dir, true);
  assert.strictEqual(resolveEnabled(dir), true);
});

test('испорченный файл настроек не роняет запуск', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'autostart.json'), '{не json');
  assert.strictEqual(readPreference(dir), null);
  assert.strictEqual(resolveEnabled(dir), true);
});

test('в режиме разработки автозагрузка системы не трогается', () => {
  let called = false;
  const app = { isPackaged: false, setLoginItemSettings: () => { called = true; } };
  assert.strictEqual(applyAutostart(app, { enabled: true }), false);
  assert.strictEqual(called, false);
});

test('собранное приложение передаёт настройки системе', { skip: process.platform !== 'win32' }, () => {
  let received = null;
  const app = { isPackaged: true, setLoginItemSettings: (o) => { received = o; } };
  applyAutostart(app, { enabled: false, execPath: 'C:\\Apps\\OpenMyChat.exe', env: {} });
  assert.deepStrictEqual(received, { openAtLogin: false, path: 'C:\\Apps\\OpenMyChat.exe', args: [LAUNCH_ARG] });
});
