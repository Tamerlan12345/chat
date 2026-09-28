// Настройка машины, которую раскладывает ИТ: адрес сервера компании и
// выключатель обновлений.
//
// В собранной сборке адрес сервера был зашит константой, а переменные
// окружения там намеренно не читаются (см. server-url.js). Серверу в
// локальной сети нужен свой адрес — он берётся из
// %ProgramData%\OpenMyChat Enterprise\client.json. Папку создаёт
// installer/configure-client.ps1 с правами «пишут только администраторы»:
// файл в профиле пользователя или переменная окружения позволили бы любой
// программе сотрудника увести приложение со всеми его возможностями на чужой
// сервер.
//
// Файл не обязателен. Любая ошибка в нём — файл (или его часть)
// игнорируется, причина уходит в журнал: приложение, которое не запускается
// из-за опечатки в конфигурации, хуже приложения со старым адресом.

const path = require('node:path');
const { isAllowedServerUrl, resolveServerUrl } = require('./server-url');

const CONFIG_DIR_NAME = 'OpenMyChat Enterprise';
const CONFIG_FILE_NAME = 'client.json';
const CHANNELS = Object.freeze(['stable', 'beta']);
const DEFAULT_PROGRAM_DATA = 'C:\\ProgramData';

function clientConfigPath(programData) {
  if (typeof programData !== 'string' || !programData) return null;
  return path.win32.join(programData, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

// %ProgramData% — переменная окружения, её можно подменить при запуске.
// Принимается только корень диска вида «C:\ProgramData»: папку с таким именем
// в корне системного диска обычный пользователь не создаёт, а увести чтение в
// свой профиль или на сетевую папку подменой переменной не выйдет.
function programDataDir(env = {}) {
  const value = typeof env.ProgramData === 'string' ? env.ProgramData.trim() : '';
  if (/^[A-Za-z]:\\ProgramData\\?$/i.test(value)) return value.replace(/\\$/, '');
  return DEFAULT_PROGRAM_DATA;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Читает client.json машины.
 * → { serverUrl|null, updates: { enabled, channel }, source: 'programdata'|'none', problems: [строки для журнала] }
 * В разработке обновления выключены всегда: electron-updater там всё равно
 * не работает, а запросы к боевому серверу из рабочей копии ни к чему.
 */
function readClientConfig({ programData, readFile, isPackaged } = {}) {
  const result = {
    serverUrl: null,
    updates: { enabled: Boolean(isPackaged), channel: 'stable' },
    source: 'none',
    problems: []
  };

  const file = clientConfigPath(programData);
  if (!file) {
    result.problems.push('папка ProgramData не определена — client.json не читается');
    return result;
  }

  let text;
  try {
    text = String(readFile(file));
  } catch (err) {
    result.problems.push(
      err && err.code === 'ENOENT'
        ? `${file} не найден — адрес сервера по умолчанию`
        : `${file} не прочитан (${err && (err.code || err.message)}) — файл пропущен`
    );
    return result;
  }

  let raw;
  try {
    // PowerShell 5.1 (Set-Content -Encoding UTF8) пишет BOM.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    result.problems.push(`${file}: не JSON — файл пропущен`);
    return result;
  }
  if (!isPlainObject(raw)) {
    result.problems.push(`${file}: ожидался объект JSON — файл пропущен`);
    return result;
  }
  result.source = 'programdata';

  if (raw.serverUrl !== undefined) {
    if (typeof raw.serverUrl === 'string' && isAllowedServerUrl(raw.serverUrl, { isPackaged: true })) {
      result.serverUrl = raw.serverUrl;
    } else {
      // Сам адрес в журнал не пишется целиком: в нём могли оказаться учётные данные.
      result.problems.push('serverUrl отклонён: нужен адрес https:// без имени и пароля');
    }
  }

  const updates = raw.updates;
  if (updates !== undefined && !isPlainObject(updates)) {
    result.problems.push('updates: ожидался объект — значения по умолчанию');
  } else if (updates) {
    if (updates.enabled !== undefined) {
      if (typeof updates.enabled !== 'boolean') {
        // Выключатель с опечаткой («"false"») — скорее всего, хотели выключить.
        result.problems.push('updates.enabled: ожидалось true или false — обновления выключены');
        result.updates.enabled = false;
      } else if (updates.enabled === false) {
        result.updates.enabled = false;
      }
    }
    if (updates.channel !== undefined) {
      if (CHANNELS.includes(updates.channel)) {
        result.updates.channel = updates.channel;
      } else {
        result.problems.push(`updates.channel: неизвестный канал ${JSON.stringify(String(updates.channel)).slice(0, 40)} — stable`);
      }
    }
  }

  if (!isPackaged) result.updates.enabled = false;
  return result;
}

/**
 * Адрес сервера, который загружает приложение.
 * Собранная сборка: client.json → зашитая константа (переменные окружения не
 * читаются). Разработка: как раньше — переменные окружения, затем client.json,
 * затем константа.
 * → { url, source: 'env'|'client.json'|'default', ignored }
 */
function resolveEffectiveServerUrl({ config, hardDefault, isPackaged, env = {} } = {}) {
  const fromFile = config && typeof config.serverUrl === 'string' ? config.serverUrl : null;
  if (isPackaged) {
    return fromFile
      ? { url: fromFile, source: 'client.json', ignored: null }
      : { url: hardDefault, source: 'default', ignored: null };
  }
  const fallback = fromFile || hardDefault;
  const choice = resolveServerUrl({ isPackaged: false, env, defaultUrl: fallback });
  const fromEnv = choice.url !== fallback || Boolean((env.VITE_DEV_SERVER_URL || env.MYCHAT_SERVER_URL) && !choice.ignored);
  return {
    url: choice.url,
    source: fromEnv ? 'env' : fromFile ? 'client.json' : 'default',
    ignored: choice.ignored
  };
}

module.exports = {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  CHANNELS,
  clientConfigPath,
  programDataDir,
  readClientConfig,
  resolveEffectiveServerUrl
};
