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

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isAllowedServerUrl, resolveServerUrl } = require('./server-url');

const CONFIG_DIR_NAME = 'OpenMyChat Enterprise';
const CONFIG_FILE_NAME = 'client.json';
const CHANNELS = Object.freeze(['stable', 'beta']);
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';
const DEFAULT_PROGRAM_DATA = 'C:\\ProgramData';

// Символическая ссылка \SystemRoot в корне пространства имён объектов ядра:
// создаёт её система при загрузке, пользователь не может ни создать, ни
// подменить её (в отличие от переменной окружения или буквы диска через
// subst — те живут в его собственном пространстве \??).
const KERNEL_SYSTEM_ROOT = '\\\\?\\GLOBALROOT\\SystemRoot';
const PROFILE_LIST_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList';

// Обычный локальный путь «X:\…» без «..», подстановок и запрещённых символов.
function isLocalDirPath(value) {
  return typeof value === 'string'
    && /^[A-Za-z]:\\[^\\/:*?"<>|%\r\n]+(\\[^\\/:*?"<>|%\r\n]+)*\\?$/.test(value)
    && !value.split('\\').some((part) => part === '..' || part === '.');
}

function clientConfigPath(programData) {
  if (typeof programData !== 'string' || !programData) return null;
  return path.win32.join(programData, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function trustedSystemRoot({ realpath = (p) => fs.realpathSync.native(p) } = {}) {
  try {
    const resolved = String(realpath(KERNEL_SYSTEM_ROOT)).replace(/^\\\\\?\\/, '').replace(/\\+$/, '');
    return isLocalDirPath(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

// Вывод «reg.exe query <ключ> /v <имя>»: строка «    имя    REG_SZ    значение».
function parseRegValue(stdout, name) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s+(\S.*?)\s{2,}(REG_SZ|REG_EXPAND_SZ)\s{2,}(.*?)\s*$/);
    if (m && m[1].toLowerCase() === String(name).toLowerCase()) return m[3];
  }
  return null;
}

// «%SystemDrive%\ProgramData» из реестра → «C:\ProgramData». Раскрываются
// только %SystemDrive% и %SystemRoot% — из доверенного корня системы, а не
// из переменных окружения.
function expandSystemPath(raw, systemRoot) {
  if (typeof raw !== 'string' || !isLocalDirPath(systemRoot)) return null;
  const drive = systemRoot.slice(0, 2);
  const expanded = raw
    .trim()
    .replace(/%SystemDrive%/gi, drive)
    .replace(/%SystemRoot%/gi, systemRoot.replace(/\\+$/, ''));
  return isLocalDirPath(expanded) ? expanded.replace(/\\+$/, '') : null;
}

function defaultRegQuery(exe, key, name) {
  return execFileSync(exe, ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
}

function sameDir(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase();
}

/**
 * Папки Windows, от которых зависит доверие: где лежит client.json
 * (ProgramData) и откуда запускать PowerShell (корень системы).
 *
 * В собранной сборке переменные окружения здесь не читаются: пользовательская
 * переменная (HKCU\Environment) перекрывает системную, и
 * «ProgramData=Q:\ProgramData» вместе с subst Q: на папку профиля увела бы
 * приложение на любой https-сервер, а «SystemRoot» подсунула бы поддельный
 * powershell.exe, печатающий «Valid». Корень системы берётся из ядра
 * (\SystemRoot), ProgramData — из HKLM\…\ProfileList (пишет только
 * администратор) через reg.exe из того же корня. Не вышло — C:\Windows и
 * C:\ProgramData. В разработке — как раньше, из окружения.
 * → { systemRoot, programData, problems: [строки для журнала] }
 */
function resolveSystemDirs({ isPackaged, env = {}, realpath, regQuery = defaultRegQuery } = {}) {
  const problems = [];
  const envRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : '';
  const envProgramData = typeof env.ProgramData === 'string' ? env.ProgramData.trim() : '';

  if (!isPackaged) {
    return {
      systemRoot: isLocalDirPath(envRoot) ? envRoot.replace(/\\+$/, '') : trustedSystemRoot({ realpath }) || DEFAULT_SYSTEM_ROOT,
      programData: isLocalDirPath(envProgramData) ? envProgramData.replace(/\\+$/, '') : DEFAULT_PROGRAM_DATA,
      problems
    };
  }

  let systemRoot = trustedSystemRoot({ realpath });
  if (!systemRoot) {
    problems.push(`корень Windows не определён через ядро — ${DEFAULT_SYSTEM_ROOT}`);
    systemRoot = DEFAULT_SYSTEM_ROOT;
  }

  let programData = null;
  try {
    const raw = parseRegValue(regQuery(`${systemRoot}\\System32\\reg.exe`, PROFILE_LIST_KEY, 'ProgramData'), 'ProgramData');
    programData = expandSystemPath(raw, systemRoot);
    if (!programData) problems.push(`ProgramData в HKLM не разобран (${JSON.stringify(String(raw)).slice(0, 80)}) — ${DEFAULT_PROGRAM_DATA}`);
  } catch (err) {
    problems.push(`ProgramData из HKLM не прочитан (${err && (err.code || err.message)}) — ${DEFAULT_PROGRAM_DATA}`);
  }
  if (!programData) programData = DEFAULT_PROGRAM_DATA;

  if (envProgramData && !sameDir(envProgramData, programData)) {
    problems.push(`переменная ProgramData (${envProgramData.slice(0, 80)}) не совпадает с HKLM — не используется`);
  }
  if (envRoot && !sameDir(envRoot, systemRoot)) {
    problems.push(`переменная SystemRoot (${envRoot.slice(0, 80)}) не совпадает с корнем системы — не используется`);
  }
  return { systemRoot, programData, problems };
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
  DEFAULT_SYSTEM_ROOT,
  DEFAULT_PROGRAM_DATA,
  clientConfigPath,
  trustedSystemRoot,
  parseRegValue,
  expandSystemPath,
  resolveSystemDirs,
  readClientConfig,
  resolveEffectiveServerUrl
};
