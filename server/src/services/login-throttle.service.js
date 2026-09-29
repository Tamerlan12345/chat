// Задержка входа по учётной записи — независимо от адреса.
//
// Пределы «на адрес» (30 неудач за 10 минут на сеть /64) и «на адрес + логин»
// (10 неудач, LOGIN_LOCKOUT_MINUTES) не мешают подбирать пароль к одной учётной
// записи сразу со многих адресов: каждый новый адрес начинает свой отсчёт
// заново (аудит, раунд 4, находка Р4-01). Здесь неудачи считаются по самому
// логину, со всех адресов вместе, — так распределённый подбор становится
// виден и получает задержку.
//
// Что мы обещаем (проверка раунда 4, ПР-I4 — честная формулировка):
//   1. Пока неудач меньше LOGIN_ACCOUNT_SOFT_LIMIT — ничего не меняется. Порог
//      выше предела «адрес + логин», так что один сотрудник, ошибающийся со
//      своего компьютера, сюда не доходит: нужны неудачи с нескольких адресов.
//   2. Знакомый адрес НИКОГДА не задерживается. Знакомый — это адрес (сеть
//      /64), с которого сотрудник уже проходил проверку личности: вход по
//      паролю, «стук» устройства, продление токена, WebSocket. Отметка
//      переживает перезапуск (таблица trusted_login_sources). Привязанные
//      устройства входят «стуком» и этой задержке не подчиняются вовсе.
//   3. Задержка ведётся ПО ПАРЕ (учётная запись, адрес источника), а не одной
//      общей очередью на учётную запись. Поэтому поток атакующего с его
//      адресов не занимает «окно» настоящего сотрудника с ЕГО адреса: у того
//      своя очередь, и первая попытка с нового адреса проходит без ожидания.
//      Повторные неудачи с одного источника растят задержку этого источника
//      (1, 2, 4… с, но не дольше LOGIN_ACCOUNT_MAX_DELAY_SECONDS) — с разбросом,
//      чтобы атакующий не попадал ровно в момент открытия окна.
//   4. Счёт затухает: после LOGIN_LOCKOUT_MINUTES без неудач обнуляется.
//
// Чего задержка НЕ делает: не останавливает распределённый подбор, меняющий
// адрес на каждую догадку, — с этим борется предел неудач на сеть /64 и
// оповещение центру безопасности, а в пределе — список разрешённых адресов
// (ALLOWED_CLIENT_IPS). Задержка нужна ровно для того, чтобы под таким
// подбором настоящий сотрудник всё равно мог войти. Навсегда запереть учётную
// запись этот механизм не может — ни извне, ни изнутри.
//
// Одинаково для существующих и несуществующих логинов: неудачи считаются по
// имени, до и после поиска в базе, — иначе по тому, наступает ли задержка,
// узнавали бы, какие логины заведены.
//
// Состояние в памяти процесса; после перезапуска отсчёт начинается заново — для
// временной задержки приемлемо (знакомые адреса при этом восстанавливаются из
// таблицы, см. trusted-sources.service.js).

const config = require('../config');

// Потолки карт. Переполнение НИКОГДА не отказывает живому входу: вытесняется
// самый старый ключ (порядок вставки Map), а вход допускается (fail open,
// ПР-01). Ключи содержат логин из запроса, поэтому потолок не даёт потоку
// выдуманных логинов съесть память (Р4-04), но и не превращается в отказ.
const DEFAULT_MAX_ENTRIES = 50000;
let maxEntries = DEFAULT_MAX_ENTRIES;

const KNOWN_SOURCES_PER_ACCOUNT = 5;
const KNOWN_SOURCE_TTL_MS = 30 * 86400000;
const ENGAGED_BASE_DELAY_MS = 1000;

const accounts = new Map(); // nameKey -> { failures, lastFailureAt, engagedAt }
const sources = new Map();  // `${nameKey}\u0000${ipKey}` -> { failures, nextAllowedAt, lastAt }
const knownSources = new Map(); // nameKey -> Map(ipKey -> время удачного входа) — «горячий» кэш поверх таблицы

function softLimit() {
  return config.LOGIN_ACCOUNT_SOFT_LIMIT;
}
function maxDelayMs() {
  return config.LOGIN_ACCOUNT_MAX_DELAY_SECONDS * 1000;
}
function quietWindowMs() {
  return config.LOGIN_LOCKOUT_MINUTES * 60000;
}

/**
 * Единая форма логина для всех ключей входа: NFKC, без пробелов по краям, в
 * нижнем регистре. Все варианты написания, находящие одну учётную запись,
 * попадают в один счётчик (Р4-06).
 */
function canonicalUsername(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().normalize('NFKC').trim().toLowerCase();
}

// Кладёт ключ, вытесняя самый старый при переполнении (никогда не отказывает).
function setBounded(map, key, value) {
  if (map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

// Задержка источника от числа ЕГО собственных неудач при включённой защите.
function sourceDelay(sourceFailures) {
  return Math.min(maxDelayMs(), ENGAGED_BASE_DELAY_MS * 2 ** Math.min(sourceFailures, 20));
}

function accountFor(nameKey, now, create) {
  let acc = accounts.get(nameKey);
  if (acc && acc.lastFailureAt && now - acc.lastFailureAt >= quietWindowMs()) {
    // Затишье — счёт с нуля.
    acc.failures = 0;
    acc.engagedAt = 0;
  }
  if (!acc && create) {
    acc = { failures: 0, lastFailureAt: 0, engagedAt: 0 };
    setBounded(accounts, nameKey, acc);
  }
  return acc || null;
}

function sourceKey(nameKey, ipKey) {
  return `${nameKey}\u0000${ipKey || 'unknown'}`;
}
function sourceEntryFor(nameKey, ipKey, now, create) {
  const key = sourceKey(nameKey, ipKey);
  let src = sources.get(key);
  if (src && now - src.lastAt >= quietWindowMs() && now >= src.nextAllowedAt) {
    sources.delete(key);
    src = undefined;
  }
  if (!src && create) {
    src = { failures: 0, nextAllowedAt: 0, lastAt: now };
    setBounded(sources, key, src);
  }
  return src || null;
}

function jitter(ms) {
  // ± до 30% и не меньше 250 мс разброса — чтобы точный Retry-After не давал
  // атакующему попадать ровно в момент открытия окна (ПР-I4).
  const spread = Math.max(250, Math.round(ms * 0.3));
  return ms + Math.floor(Math.random() * spread);
}

/**
 * Можно ли сейчас проверить пароль под этим логином с этого адреса.
 *
 * @returns {{ ok: true, ticket, engaged } | { ok: false, retryAfterMs }}
 */
function admit(nameKey, { ipKey = null, trusted = false, now = Date.now() } = {}) {
  // Знакомый адрес — никаких задержек и никакого влияния на счётчики.
  if (trusted) return { ok: true, ticket: { nameKey, ipKey, trusted: true }, engaged: false };

  const acc = accountFor(nameKey, now, true);
  const engaged = acc.failures >= softLimit();
  if (!engaged) {
    return { ok: true, ticket: { nameKey, ipKey, trusted: false }, engaged: false };
  }

  // Защита включена. Очередь — своя у каждого адреса источника: поток
  // атакующего не съедает окно настоящего сотрудника (ПР-I4).
  const src = sourceEntryFor(nameKey, ipKey, now, true);
  if (now < src.nextAllowedAt) {
    return { ok: false, retryAfterMs: jitter(src.nextAllowedAt - now) };
  }
  // Первая попытка нового источника проходит сразу; следующая — не раньше
  // задержки этого источника. Так настоящий сотрудник с нового адреса входит
  // с первой попытки даже под атакой.
  const firstEngage = !acc.engagedAt;
  if (firstEngage) acc.engagedAt = now;
  src.nextAllowedAt = now + sourceDelay(src.failures + 1);
  return { ok: true, ticket: { nameKey, ipKey, trusted: false }, engaged: firstEngage };
}

/**
 * Итог допущенной попытки.
 *   'failure' — пароль проверен и не подошёл (или логина нет);
 *   'success' / 'neutral' — на счётчики не влияет.
 */
function settle(ticket, outcome, { now = Date.now() } = {}) {
  if (!ticket || ticket.trusted || outcome !== 'failure') return;
  const acc = accountFor(ticket.nameKey, now, true);
  acc.failures += 1;
  acc.lastFailureAt = now;
  // Свежую запись — в конец очереди вытеснения.
  accounts.delete(ticket.nameKey);
  accounts.set(ticket.nameKey, acc);

  const key = sourceKey(ticket.nameKey, ticket.ipKey);
  const src = sources.get(key) || { failures: 0, nextAllowedAt: 0, lastAt: now };
  src.failures += 1;
  src.lastAt = now;
  if (acc.failures >= softLimit()) {
    src.nextAllowedAt = Math.max(src.nextAllowedAt, now + sourceDelay(src.failures));
  }
  sources.delete(key);
  setBounded(sources, key, src);
}

function rememberSuccess(nameKey, ipKey, now = Date.now()) {
  if (!nameKey || !ipKey) return;
  let m = knownSources.get(nameKey);
  if (!m) {
    m = new Map();
  } else {
    knownSources.delete(nameKey);
  }
  m.delete(ipKey);
  m.set(ipKey, now);
  while (m.size > KNOWN_SOURCES_PER_ACCOUNT) m.delete(m.keys().next().value);
  setBounded(knownSources, nameKey, m);
}

function isKnownSource(nameKey, ipKey, now = Date.now()) {
  const at = knownSources.get(nameKey)?.get(ipKey);
  return Boolean(at && now - at < KNOWN_SOURCE_TTL_MS);
}

function prune(now = Date.now()) {
  for (const [key, acc] of accounts) {
    if (acc.lastFailureAt && now - acc.lastFailureAt >= quietWindowMs()) accounts.delete(key);
  }
  for (const [key, src] of sources) {
    if (now - src.lastAt >= quietWindowMs() && now >= src.nextAllowedAt) sources.delete(key);
  }
}
setInterval(() => prune(), 5 * 60000).unref();

// Для тестов.
function resetThrottle({ maxEntries: max } = {}) {
  accounts.clear();
  sources.clear();
  knownSources.clear();
  maxEntries = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_ENTRIES;
}

function throttleSize() {
  return accounts.size;
}

module.exports = {
  canonicalUsername,
  admit,
  settle,
  rememberSuccess,
  isKnownSource,
  resetThrottle,
  throttleSize
};
