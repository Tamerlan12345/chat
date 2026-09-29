// Где на диске лежит профиль приложения (userData).
//
// Electron называет папку профиля по имени приложения, а имя берёт из
// package.json внутри сборки: productName верхнего уровня, если он есть, иначе
// name. productName у нас задан только в разделе build (его читает
// electron-builder, а не Electron), и в собранный package.json он не попадает.
// Поэтому уже установленные у сотрудников версии (1.0.0 «OpenMyChat
// Enterprise») держат профиль в %APPDATA%\mychat-desktop — по имени пакета.
// Там токен входа, идентификатор устройства (без него — повторная привязка),
// настройки, cookie с ключом шифрования в «Local State», журналы (logs) и
// блокировка единственного экземпляра.
//
// Папка закреплена явно, чтобы профиль не переехал ни при каком
// переименовании: ни когда productName стал «CentyChat», ни если кто-то
// добавит productName в корень package.json или сменит name. Не «исправлять»
// на CentyChat — сотрудники потеряют вход и привязку устройства.
//
// Закреплять нужно до всего, что читает userData, журналы или сессии, и до
// requestSingleInstanceLock: поэтому pinUserData вызывается первой строкой
// main.js. Electron переносит вслед за userData и sessionData, logs и
// crashDumps, если путь задан до события ready.

const path = require('node:path');

const LEGACY_USER_DATA_DIR = 'mychat-desktop';

function userDataPath(appDataDir) {
  return path.join(appDataDir, LEGACY_USER_DATA_DIR);
}

function pinUserData(app) {
  const dir = userDataPath(app.getPath('appData'));
  app.setPath('userData', dir);
  return dir;
}

module.exports = { LEGACY_USER_DATA_DIR, userDataPath, pinUserData };
