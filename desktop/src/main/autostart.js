// Запуск вместе с Windows.
//
// Приложение прописывается в автозагрузку текущего пользователя (раздел Run
// в HKCU — прав администратора не нужно) с ключом --autostart. По этому ключу
// оно понимает, что его запустила система, а не человек, и остаётся в трее:
// окно чата не выскакивает поверх работы при каждом входе в Windows.
//
// Выбор сотрудника запоминается в файле. Без этого галочку, снятую в меню
// трея, приложение ставило бы обратно при следующем же запуске.

const fs = require('node:fs');
const path = require('node:path');

const LAUNCH_ARG = '--autostart';
const PREFS_FILE = 'autostart.json';

// Где лежит exe, который нужно запускать. У переносной сборки process.execPath
// указывает во временную папку распаковки, которая исчезает после выхода, —
// настоящий файл electron-builder передаёт в PORTABLE_EXECUTABLE_FILE.
function launcherPath({ execPath, env = {} }) {
  return env.PORTABLE_EXECUTABLE_FILE || execPath;
}

function loginItemOptions(enabled, { execPath, env }) {
  return {
    openAtLogin: Boolean(enabled),
    path: launcherPath({ execPath, env }),
    args: [LAUNCH_ARG]
  };
}

function wasLaunchedAtLogin(argv = [], loginItemSettings = null) {
  return argv.includes(LAUNCH_ARG) || Boolean(loginItemSettings?.wasOpenedAtLogin);
}

function readPreference(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, PREFS_FILE), 'utf8'));
    return typeof raw?.enabled === 'boolean' ? raw.enabled : null;
  } catch {
    return null;
  }
}

function writePreference(userDataDir, enabled) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, PREFS_FILE),
    JSON.stringify({ enabled: Boolean(enabled), updatedAt: new Date().toISOString() }, null, 2)
  );
}

// Первый запуск — включено: корпоративный мессенджер, который забыли открыть,
// означает пропущенные сообщения. Дальше — как решил сотрудник.
function resolveEnabled(userDataDir) {
  const saved = readPreference(userDataDir);
  return saved === null ? true : saved;
}

// Применяет решение к системе. Вызывается при каждом запуске: после переноса
// папки установки или обновления путь в автозагрузке должен смотреть на
// текущий exe, а не на прежний.
function applyAutostart(app, { enabled, env = process.env, execPath = process.execPath, log = () => {} }) {
  if (!app.isPackaged || process.platform !== 'win32') {
    log('autostart skipped: not a packaged Windows build');
    return false;
  }
  const options = loginItemOptions(enabled, { execPath, env });
  app.setLoginItemSettings(options);
  log(`autostart ${options.openAtLogin ? 'enabled' : 'disabled'}: ${options.path}`);
  return options.openAtLogin;
}

function isAutostartSupported(app) {
  return Boolean(app.isPackaged) && process.platform === 'win32';
}

module.exports = {
  LAUNCH_ARG,
  PREFS_FILE,
  launcherPath,
  loginItemOptions,
  wasLaunchedAtLogin,
  readPreference,
  writePreference,
  resolveEnabled,
  applyAutostart,
  isAutostartSupported
};
