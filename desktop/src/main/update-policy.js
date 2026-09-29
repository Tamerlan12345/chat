// Чистые правила автообновления: версии, вид установки, адреса, заголовки и
// расписание проверок. Без Electron — тестируется в обычном Node.

const path = require('node:path');

const CHANNELS = Object.freeze(['stable', 'beta']);
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALL_KINDS = new Set(['nsis', 'nsis-machine', 'portable', 'copy']);
const ERROR_CODE = /^[a-z0-9-]{1,32}$/;

// Имя деинсталлятора, который NSIS (electron-builder) кладёт рядом с exe:
// «Uninstall ${productName}.exe». До переименования в CentyChat продукт
// назывался «OpenMyChat Enterprise», и прежнее имя тоже признаётся установкой
// через NSIS: установка, обновлённая поверх 1.0.0, может хранить старый
// деинсталлятор рядом с exe, если его не удалось убрать (см.
// build/installer.nsh, customInstall).
const UNINSTALLER_NAME = 'Uninstall CentyChat.exe';
const LEGACY_UNINSTALLER_NAME = 'Uninstall OpenMyChat Enterprise.exe';
const UNINSTALLER_NAMES = Object.freeze([UNINSTALLER_NAME, LEGACY_UNINSTALLER_NAME]);

const MINUTE = 60_000;
const FIRST_CHECK_MIN_MS = 60_000;
const FIRST_CHECK_MAX_MS = 300_000;
const DEFAULT_INTERVAL_MIN = 240;
const MIN_INTERVAL_MIN = 30;
const MAX_INTERVAL_MIN = 1440;
const INTERVAL_JITTER = 0.15;
const BACKOFF_BASE_MS = 5 * MINUTE;
const MAX_BACKOFF_MS = 6 * 60 * MINUTE;

// ── Версии ─────────────────────────────────────────────────────────────────
// Тот же алгоритм, что в server/src/services/update-policy.service.js: сервер
// и клиент обязаны одинаково понимать, что «новее» (общие векторы — в тестах
// обеих сторон).

function parseVersion(v) {
  if (typeof v !== 'string' || v.length > 64 || !SEMVER.test(v)) return null;
  const dash = v.indexOf('-');
  const core = (dash === -1 ? v : v.slice(0, dash)).split('.');
  const pre = dash === -1 ? [] : v.slice(dash + 1).split('.');
  return { core, pre };
}

function isValidVersion(v) {
  const parsed = parseVersion(v);
  return Boolean(parsed) && parsed.pre.every((id) => id.length > 0);
}

function compareDigits(a, b) {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareIdentifier(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return compareDigits(a, b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * semver с пререлизами: 1.10.0 > 1.9.0, 1.2.0-beta.1 < 1.2.0,
 * 1.2.0-beta.2 < 1.2.0-beta.10. Неразборчивая строка младше любой версии,
 * две неразборчивые равны; исключений нет.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    const c = compareDigits(pa.core[i], pb.core[i]);
    if (c) return c;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i += 1) {
    if (i >= pa.pre.length) return -1;
    if (i >= pb.pre.length) return 1;
    const c = compareIdentifier(pa.pre[i], pb.pre[i]);
    if (c) return c;
  }
  return 0;
}

// ── Вид установки ──────────────────────────────────────────────────────────

function isInside(file, dir) {
  if (typeof dir !== 'string' || !dir.trim()) return false;
  const base = path.win32.normalize(dir.trim()).replace(/\\+$/, '').toLowerCase();
  return file.toLowerCase().startsWith(base + '\\');
}

/**
 * dev — не собранная сборка;
 * portable — переносная (electron-builder передаёт PORTABLE_EXECUTABLE_FILE);
 * nsis-machine — установка «для всех» в Program Files: обновлять её может
 *   только администратор, поэтому — лишь уведомление;
 * nsis — установка для пользователя (рядом деинсталлятор);
 * copy — папка, скопированная вручную или install.ps1.
 */
function detectInstallKind({ isPackaged, execPath, env = {}, exists = () => false, programFiles = [] } = {}) {
  if (!isPackaged) return 'dev';
  if (env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  const exe = path.win32.normalize(String(execPath || ''));
  const roots = Array.isArray(programFiles) ? programFiles : [programFiles];
  if (roots.some((dir) => isInside(exe, dir))) return 'nsis-machine';
  const dir = path.win32.dirname(exe);
  const hasUninstaller = UNINSTALLER_NAMES.some((name) => {
    try {
      return Boolean(exists(path.win32.join(dir, name)));
    } catch {
      return false;
    }
  });
  return hasUninstaller ? 'nsis' : 'copy';
}

function updateCapability(kind) {
  if (kind === 'nsis') return 'auto';
  if (kind === 'portable' || kind === 'copy' || kind === 'nsis-machine') return 'notify';
  return 'none';
}

// ── Адреса ─────────────────────────────────────────────────────────────────

function httpsOrigin(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.origin;
}

function normalizeChannel(channel) {
  return CHANNELS.includes(channel) ? channel : 'stable';
}

function updateBaseUrl({ serverOrigin, channel } = {}) {
  const origin = httpsOrigin(serverOrigin);
  if (!origin) return null;
  return `${origin}/updates/${normalizeChannel(channel)}/`;
}

// useMultipleRangeRequest: false — сервер (Express sendFile) на запрос с
// несколькими диапазонами отвечает полным 200, и дифференциальная загрузка
// electron-updater на нём ломается.
function feedOptions({ baseUrl } = {}) {
  return { provider: 'generic', url: baseUrl, channel: 'latest', useMultipleRangeRequest: false };
}

/**
 * Адрес скачивания из policy.json. Сервер отдаёт его относительным; он
 * достраивается от адреса сервера, которому приложение уже доверяет, и
 * принимается только на тот же https-источник — policy.json не может
 * отправить сотрудника качать установщик с чужого сайта.
 */
function resolveDownloadUrl({ url, serverOrigin } = {}) {
  const origin = httpsOrigin(serverOrigin);
  if (!origin || typeof url !== 'string' || !url) return null;
  let u;
  try {
    u = new URL(url, origin + '/');
  } catch {
    return null;
  }
  return u.protocol === 'https:' && u.origin === origin ? u.toString() : null;
}

/**
 * Фильтр раздела electron-updater: запросы только по https и только к
 * источнику обновлений. Ни перенаправление, ни адрес из latest.yml не уведут
 * загрузку установщика на другой сервер.
 */
function isUpdaterRequestAllowed(url, updateOrigin) {
  const origin = httpsOrigin(updateOrigin);
  if (!origin) return false;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.origin === origin && !u.username && !u.password;
}

// ── Заголовки ──────────────────────────────────────────────────────────────

// Всё, что не по формату сервера, не отправляется: сервер его всё равно
// отбросит, а перевод строки в значении заголовка уронил бы запрос.
function requestHeaders({ installId, version, kind, lastError } = {}) {
  const headers = {};
  if (typeof installId === 'string' && UUID.test(installId)) headers['X-MyChat-Install-Id'] = installId;
  if (isValidVersion(version)) headers['X-MyChat-Client-Version'] = version;
  if (INSTALL_KINDS.has(kind)) headers['X-MyChat-Install-Kind'] = kind;
  if (typeof lastError === 'string' && ERROR_CODE.test(lastError)) headers['X-MyChat-Update-Error'] = lastError;
  return headers;
}

// ── Расписание ─────────────────────────────────────────────────────────────

function unit(rand) {
  const r = Number(typeof rand === 'function' ? rand() : Math.random());
  if (!Number.isFinite(r) || r < 0) return 0;
  return r >= 1 ? 0.999999 : r;
}

function clampInterval(intervalMin) {
  const n = Number(intervalMin);
  if (typeof intervalMin !== 'number' || !Number.isFinite(n)) return DEFAULT_INTERVAL_MIN;
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, n));
}

/**
 * Через сколько миллисекунд следующая проверка.
 * first — первая после старта: 60–300 с, чтобы утренний запуск всего офиса
 *   не бил в сервер одновременно;
 * attempt 0 — обычный интервал политики ± 15%;
 * attempt N > 0 — N-я ошибка подряд: 5 мин · 2^(N-1), не больше 6 ч, со
 *   сдвигом вниз до 15% (парк, упавший вместе с сервером, возвращается
 *   вразнобой).
 */
function nextCheckDelay({ intervalMin, attempt = 0, rand = Math.random, first = false } = {}) {
  const r = unit(rand);
  if (first) return Math.round(FIRST_CHECK_MIN_MS + r * (FIRST_CHECK_MAX_MS - FIRST_CHECK_MIN_MS));
  const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  if (n === 0) {
    const interval = clampInterval(intervalMin) * MINUTE;
    return Math.round(interval * (1 + (2 * r - 1) * INTERVAL_JITTER));
  }
  const exp = Math.min(n - 1, 30);
  const base = Math.min(BACKOFF_BASE_MS * 2 ** exp, MAX_BACKOFF_MS);
  return Math.max(FIRST_CHECK_MIN_MS, Math.round(base * (1 - r * INTERVAL_JITTER)));
}

module.exports = {
  CHANNELS,
  UNINSTALLER_NAME,
  UNINSTALLER_NAMES,
  FIRST_CHECK_MIN_MS,
  FIRST_CHECK_MAX_MS,
  MAX_BACKOFF_MS,
  compareVersions,
  isValidVersion,
  detectInstallKind,
  updateCapability,
  normalizeChannel,
  updateBaseUrl,
  feedOptions,
  resolveDownloadUrl,
  isUpdaterRequestAllowed,
  requestHeaders,
  nextCheckDelay
};
