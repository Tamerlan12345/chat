// Задержка входа по учётной записи — независимо от адреса.
//
// Пределы «на адрес» (30 неудач за 10 минут) и «на адрес + логин» (10 неудач,
// LOGIN_LOCKOUT_MINUTES) не мешают подбирать пароль к одной учётной записи
// сразу со многих адресов: каждый новый адрес начинает свой отсчёт заново
// (аудит, раунд 4, находка Р4-01). Здесь счёт идёт по самому логину, со всех
// адресов вместе.
//
// Почему задержка, а не блокировка. Жёсткая блокировка учётной записи после N
// неудач — это готовый способ запереть любого сотрудника (в том числе
// администратора), просто набирая неверный пароль к его логину (аудит,
// раунд 3, находка №12). Поэтому:
//
//   1. Пока неудач меньше LOGIN_ACCOUNT_SOFT_LIMIT (20) — ничего не меняется.
//      Порог выше предела «адрес + логин» (10): один человек, ошибившийся
//      паролем со своего компьютера, сюда не дойдёт никогда — только неудачи
//      с нескольких адресов сразу.
//   2. Сверх порога попытки с незнакомых адресов пропускаются по одной и не
//      чаще, чем раз в задержку: 1 с, 2 с, 4 с… но не дольше
//      LOGIN_ACCOUNT_MAX_DELAY_SECONDS (60 с). Пока ждёт очередь, пароль даже
//      не проверяется — ответ 429 с Retry-After.
//   3. С «знакомого» адреса — того, с которого этот логин уже входил успешно
//      (последний вход из базы, last_login_ip, плюс недавние удачные входы в
//      памяти), — задержки нет вовсе. Сотрудник за своим рабочим компьютером
//      или из офиса входит как обычно, сколько бы ни шёл подбор извне. Сам
//      знакомый адрес при этом не бесконтролен: для него действуют пределы
//      «на адрес» и «на адрес + логин».
//   4. Счёт затухает: через LOGIN_LOCKOUT_MINUTES без единой неудачи он
//      обнуляется. Удачный вход счёт не сбрасывает — вход настоящего
//      сотрудника не означает, что подбор с других адресов прекратился.
//
// Цена решения: во время подбора сотрудник с НОВОГО для себя адреса (впервые
// из дома, с мобильного интернета) ждёт не дольше LOGIN_ACCOUNT_MAX_DELAY_SECONDS
// между попытками. Навсегда запереть его нельзя — ни извне, ни изнутри.
//
// Одинаково для существующих и несуществующих логинов: счёт ведётся по
// имени, до поиска в базе, — иначе по тому, наступает ли задержка, можно было
// бы узнавать, какие логины заведены.
//
// Состояние в памяти процесса, как и у остальных ограничителей: после
// перезапуска отсчёт начинается заново — для временной задержки приемлемо.

const config = require('../config');

// Потолок числа отслеживаемых логинов. Логин присылает анонимный клиент, и
// без потолка поток запросов с разными логинами растил бы карту без предела
// (Р4-04). Вытесняется только то, что никого не сдерживает; если места нет —
// новая запись считается уже задержанной (fail closed): знакомые адреса всё
// равно входят, незнакомые ждут.
const DEFAULT_MAX_ENTRIES = 20000;
let maxEntries = DEFAULT_MAX_ENTRIES;
const EVICTION_SCAN_LIMIT = 1000;

// Сколько знакомых адресов помнить на логин и как долго.
const KNOWN_SOURCES_PER_ACCOUNT = 5;
const KNOWN_SOURCE_TTL_MS = 30 * 86400000;

const accounts = new Map(); // логин -> { failures, lastFailureAt, nextAllowedAt, inFlight }
const knownSources = new Map(); // логин -> Map(ключ адреса -> время последнего удачного входа)

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
 * нижнем регистре. Поиск в базе идёт по точному логину без пробелов по краям
 * (trim) — эта форма получается из него однозначно, поэтому все варианты
 * написания, которые находят одну и ту же учётную запись, попадают в один и
 * тот же счётчик. Обратное неверно и не нужно: «ADMIN» и «admin» делят
 * счётчик, даже если это две разные записи, — это строже, а не слабее.
 * Раньше предел «5 в минуту» строился без trim, и « admin», «admin » давали
 * новые ключи для одной и той же учётной записи (Р4-06).
 */
function canonicalUsername(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().normalize('NFKC').trim().toLowerCase();
}

function delayFor(pressure) {
  const over = pressure - softLimit();
  if (over < 0) return 0;
  return Math.min(maxDelayMs(), 1000 * 2 ** Math.min(over, 30));
}

function isThrottling(entry, now) {
  return entry.failures + entry.inFlight >= softLimit() || now < entry.nextAllowedAt;
}

function isStale(entry, now) {
  return entry.inFlight === 0 && now >= entry.nextAllowedAt && now - entry.lastFailureAt >= quietWindowMs();
}

// Место под новую запись: сначала устаревшие, потом любая, что никого не
// задерживает. false — места нет.
function ensureRoom(now) {
  if (accounts.size < maxEntries) return true;
  let scanned = 0;
  for (const [key, entry] of accounts) {
    if (++scanned > EVICTION_SCAN_LIMIT) break;
    if (isStale(entry, now) || (!isThrottling(entry, now) && entry.inFlight === 0)) {
      accounts.delete(key);
      return true;
    }
  }
  return false;
}

function entryFor(nameKey, now, { create }) {
  let entry = accounts.get(nameKey);
  if (entry && isStale(entry, now)) {
    accounts.delete(nameKey);
    entry = undefined;
  }
  if (entry || !create) return entry || null;
  if (!ensureRoom(now)) return null;
  entry = { failures: 0, lastFailureAt: 0, nextAllowedAt: 0, inFlight: 0 };
  accounts.set(nameKey, entry);
  return entry;
}

/**
 * Можно ли сейчас проверить пароль этого логина.
 *
 * @returns {{ ok: true, ticket: object, engaged: boolean } | { ok: false, retryAfterMs: number }}
 *   engaged — задержка только что включилась впервые (повод для записи в журнал).
 */
function admit(nameKey, { trusted = false, now = Date.now() } = {}) {
  const entry = entryFor(nameKey, now, { create: true });
  if (!entry) {
    // Карта забита задержанными записями — новая считается задержанной тоже.
    if (trusted) return { ok: true, ticket: { nameKey, entry: null }, engaged: false };
    return { ok: false, retryAfterMs: maxDelayMs() };
  }

  if (trusted) {
    entry.inFlight += 1;
    return { ok: true, ticket: { nameKey, entry }, engaged: false };
  }

  const pressure = entry.failures + entry.inFlight;
  if (pressure < softLimit()) {
    entry.inFlight += 1;
    return { ok: true, ticket: { nameKey, entry }, engaged: false };
  }

  if (now < entry.nextAllowedAt) {
    return { ok: false, retryAfterMs: entry.nextAllowedAt - now };
  }
  // Сверх порога — по одной попытке за раз: следующая допускается не раньше
  // чем через задержку, даже если эта ещё не закончилась. Иначе сотня
  // одновременных запросов прошла бы в одно и то же открывшееся «окно».
  const engaged = !entry.engagedAt;
  if (engaged) entry.engagedAt = now;
  entry.inFlight += 1;
  entry.nextAllowedAt = now + delayFor(pressure + 1);
  return { ok: true, ticket: { nameKey, entry }, engaged };
}

/**
 * Итог допущенной попытки.
 *   'failure' — пароль проверен и не подошёл (или логина нет);
 *   'success' — пароль подошёл;
 *   'neutral' — пароль не проверялся (например, отказ по пределу адреса).
 */
function settle(ticket, outcome, { now = Date.now() } = {}) {
  const entry = ticket?.entry;
  if (!entry) return;
  if (entry.inFlight > 0) entry.inFlight -= 1;
  if (outcome !== 'failure') {
    // Логин без единой неудачи держать в памяти незачем.
    if (entry.failures === 0 && entry.inFlight === 0 && now >= entry.nextAllowedAt &&
        accounts.get(ticket.nameKey) === entry) {
      accounts.delete(ticket.nameKey);
    }
    return;
  }
  // Долгое затишье перед этой неудачей — счёт с нуля, а не с прошлой атаки.
  if (entry.lastFailureAt && now - entry.lastFailureAt >= quietWindowMs()) {
    entry.failures = 0;
    entry.engagedAt = 0;
  }
  entry.failures += 1;
  entry.lastFailureAt = now;
  const delay = delayFor(entry.failures);
  if (delay > 0) entry.nextAllowedAt = Math.max(entry.nextAllowedAt, now + delay);
  // Запись поднимается в конец очереди вытеснения: она свежая.
  if (accounts.get(ticket.nameKey) === entry) {
    accounts.delete(ticket.nameKey);
    accounts.set(ticket.nameKey, entry);
  }
}

function rememberSuccess(nameKey, ipKey, now = Date.now()) {
  if (!nameKey || !ipKey) return;
  let sources = knownSources.get(nameKey);
  if (!sources) {
    // Логинов с удачным входом не больше, чем учётных записей, но потолок
    // всё равно нужен: самый давний знакомый адрес забывается первым.
    if (knownSources.size >= maxEntries) {
      const oldest = knownSources.keys().next().value;
      knownSources.delete(oldest);
    }
    sources = new Map();
  } else {
    knownSources.delete(nameKey);
  }
  sources.delete(ipKey);
  sources.set(ipKey, now);
  while (sources.size > KNOWN_SOURCES_PER_ACCOUNT) sources.delete(sources.keys().next().value);
  knownSources.set(nameKey, sources);
}

function isKnownSource(nameKey, ipKey, now = Date.now()) {
  const at = knownSources.get(nameKey)?.get(ipKey);
  return Boolean(at && now - at < KNOWN_SOURCE_TTL_MS);
}

// Для тестов.
function resetThrottle({ maxEntries: max } = {}) {
  accounts.clear();
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
