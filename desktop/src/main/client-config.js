// Настройка машины, которую раскладывает ИТ: адрес сервера компании и
// выключатель обновлений.
//
// В собранной сборке адрес сервера был зашит константой, а переменные
// окружения там намеренно не читаются (см. server-url.js). Серверу в
// локальной сети нужен свой адрес — он берётся из политики реестра
// HKLM\SOFTWARE\Policies\CentyChat (значения ServerUrl,
// UpdatesEnabled, UpdateChannel). Её пишет installer/configure-client.ps1
// или групповая политика домена.
//
// Почему реестр, а не файл в ProgramData. Раньше настройка лежала в
// %ProgramData%\OpenMyChat Enterprise\client.json. Но в ProgramData по
// умолчанию любой пользователь может создать папку и стать её владельцем:
// на ПК, где configure-client.ps1 ещё не запускали, сотрудник клал туда свой
// client.json — и приложение всех остальных пользователей этого ПК уходило
// на его сервер (пароли, удалённый доступ, выключенные обновления). Ключ
// HKLM\SOFTWARE\Policies пишут только администраторы — на любой машине, без
// предварительной подготовки. client.json собранная сборка не читает вовсе.
//
// Политика не обязательна. Ошибка в значении — это значение игнорируется,
// причина уходит в журнал: приложение, которое не запускается из-за опечатки
// в настройке, хуже приложения со старым адресом.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { isAllowedServerUrl, resolveServerUrl } = require('./server-url');

// Ключ появился в выпуске 1.1.0 вместе с переименованием в CentyChat —
// прежнего ключа «OpenMyChat Enterprise» ни одна выпущенная версия не читала,
// поэтому и запасного чтения старого имени нет.
const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\CentyChat';
const POLICY_VALUES = Object.freeze({
  serverUrl: 'ServerUrl',
  updatesEnabled: 'UpdatesEnabled',
  updateChannel: 'UpdateChannel'
});
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

function trustedSystemRoot({ realpath = (p) => fs.realpathSync.native(p) } = {}) {
  try {
    const resolved = String(realpath(KERNEL_SYSTEM_ROOT)).replace(/^\\\\\?\\/, '').replace(/\\+$/, '');
    return isLocalDirPath(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

// Вывод «reg.exe query <ключ> [/v <имя>]»: строки «    имя    ТИП    значение».
// Имена значений в реестре регистронезависимы.
// → { type: 'REG_SZ'|'REG_DWORD'|…, data: строка как её напечатал reg.exe } | null
function parseRegEntry(stdout, name) {
  const lines = String(stdout || '').split(/\r?\n/);
  const wanted = String(name).toLowerCase();
  for (const line of lines) {
    const m = line.match(/^\s+(\S.*?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*?))?\s*$/);
    if (m && m[1].toLowerCase() === wanted) return { type: m[2], data: m[3] || '' };
  }
  return null;
}

// Строковое значение (REG_SZ или REG_EXPAND_SZ) — как для ProfileList.
function parseRegValue(stdout, name) {
  const entry = parseRegEntry(stdout, name);
  return entry && (entry.type === 'REG_SZ' || entry.type === 'REG_EXPAND_SZ') ? entry.data : null;
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

// name = null — все значения ключа одним запуском reg.exe.
function defaultRegQuery(exe, key, name) {
  const args = name ? ['query', key, '/v', name] : ['query', key];
  return execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function sameDir(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase();
}

/**
 * Папки Windows, от которых зависит доверие: откуда запускать reg.exe и
 * PowerShell (корень системы) и где лежит policy.json удалённого доступа
 * (ProgramData, см. rd-consent.js).
 *
 * В собранной сборке переменные окружения здесь не читаются: пользовательская
 * переменная (HKCU\Environment) перекрывает системную, и «SystemRoot»
 * подсунула бы поддельный reg.exe с чужим адресом сервера или powershell.exe,
 * печатающий «Valid», а «ProgramData=Q:\ProgramData» вместе с subst Q: на
 * папку профиля сняла бы запрет удалённого доступа. Корень системы берётся из
 * ядра (\SystemRoot), ProgramData — из HKLM\…\ProfileList (пишет только
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

// REG_DWORD reg.exe печатает как «0x1».
function parseDword(data) {
  return /^0x[0-9a-f]{1,8}$/i.test(String(data)) ? Number.parseInt(data, 16) : null;
}

/**
 * Читает политику машины HKLM\SOFTWARE\Policies\CentyChat:
 *   ServerUrl      REG_SZ     https://… (без имени и пароля)
 *   UpdatesEnabled REG_DWORD  0 — обновления выключены, 1 — включены
 *   UpdateChannel  REG_SZ     stable | beta
 * Значение другого типа не принимается. reg.exe — из доверенного корня
 * системы (resolveSystemDirs), не из PATH и не из переменной SystemRoot.
 * → { serverUrl|null, updates: { enabled, channel }, source: 'hklm-policy'|'default', problems: [строки для журнала] }
 * В разработке обновления выключены всегда: electron-updater там всё равно
 * не работает, а запросы к боевому серверу из рабочей копии ни к чему.
 */
function readClientConfig({ systemRoot, isPackaged, regQuery = defaultRegQuery } = {}) {
  const result = {
    serverUrl: null,
    updates: { enabled: Boolean(isPackaged), channel: 'stable' },
    source: 'default',
    problems: []
  };
  const finish = () => {
    if (!isPackaged) result.updates.enabled = false;
    return result;
  };

  if (!isLocalDirPath(systemRoot)) {
    result.problems.push('корень Windows не определён — политика машины не читается, адрес сервера по умолчанию');
    return finish();
  }

  let stdout;
  try {
    stdout = regQuery(`${systemRoot.replace(/\\+$/, '')}\\System32\\reg.exe`, POLICY_KEY, null);
  } catch (err) {
    // reg.exe на отсутствующий ключ отвечает кодом 1 — обычный случай для
    // машины, которую ИТ не настраивал.
    result.problems.push(
      err && err.status === 1
        ? `политика ${POLICY_KEY} не задана — адрес сервера по умолчанию`
        : `политика ${POLICY_KEY} не прочитана (${err && (err.code || err.status || err.message)}) — адрес сервера по умолчанию`
    );
    return finish();
  }
  result.source = 'hklm-policy';

  const url = parseRegEntry(stdout, POLICY_VALUES.serverUrl);
  if (url) {
    if (url.type !== 'REG_SZ') {
      result.problems.push(`${POLICY_VALUES.serverUrl}: ожидался REG_SZ, а не ${url.type} — адрес сервера по умолчанию`);
    } else if (isAllowedServerUrl(url.data, { isPackaged: true })) {
      result.serverUrl = url.data;
    } else {
      // Сам адрес в журнал не пишется: в нём могли оказаться учётные данные.
      result.problems.push(`${POLICY_VALUES.serverUrl} отклонён: нужен адрес https:// без имени и пароля`);
    }
  }

  const enabled = parseRegEntry(stdout, POLICY_VALUES.updatesEnabled);
  if (enabled) {
    const value = enabled.type === 'REG_DWORD' ? parseDword(enabled.data) : null;
    if (value === 0) {
      result.updates.enabled = false;
    } else if (value !== 1) {
      // Выключатель с опечаткой (строка «0», число 2) — скорее всего, хотели
      // выключить.
      result.problems.push(`${POLICY_VALUES.updatesEnabled}: ожидался REG_DWORD 0 или 1 — обновления выключены`);
      result.updates.enabled = false;
    }
  }

  const channel = parseRegEntry(stdout, POLICY_VALUES.updateChannel);
  if (channel) {
    if (channel.type === 'REG_SZ' && CHANNELS.includes(channel.data)) {
      result.updates.channel = channel.data;
    } else {
      result.problems.push(`${POLICY_VALUES.updateChannel}: ожидался REG_SZ stable или beta (${channel.type} ${JSON.stringify(channel.data).slice(0, 40)}) — stable`);
    }
  }

  return finish();
}

/**
 * Адрес сервера, который загружает приложение.
 * Собранная сборка: политика HKLM → зашитая константа (переменные окружения
 * не читаются). Разработка: как раньше — переменные окружения, затем
 * политика, затем константа.
 * → { url, source: 'env'|'hklm-policy'|'default', ignored }
 */
function resolveEffectiveServerUrl({ config, hardDefault, isPackaged, env = {} } = {}) {
  const fromPolicy = config && typeof config.serverUrl === 'string' ? config.serverUrl : null;
  if (isPackaged) {
    return fromPolicy
      ? { url: fromPolicy, source: 'hklm-policy', ignored: null }
      : { url: hardDefault, source: 'default', ignored: null };
  }
  const fallback = fromPolicy || hardDefault;
  const choice = resolveServerUrl({ isPackaged: false, env, defaultUrl: fallback });
  const fromEnv = choice.url !== fallback || Boolean((env.VITE_DEV_SERVER_URL || env.MYCHAT_SERVER_URL) && !choice.ignored);
  return {
    url: choice.url,
    source: fromEnv ? 'env' : fromPolicy ? 'hklm-policy' : 'default',
    ignored: choice.ignored
  };
}

module.exports = {
  POLICY_KEY,
  POLICY_VALUES,
  CHANNELS,
  DEFAULT_SYSTEM_ROOT,
  DEFAULT_PROGRAM_DATA,
  trustedSystemRoot,
  parseRegEntry,
  parseRegValue,
  expandSystemPath,
  resolveSystemDirs,
  readClientConfig,
  resolveEffectiveServerUrl
};
