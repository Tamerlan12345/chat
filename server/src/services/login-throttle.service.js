// Задержка входа по учётной записи — независимо от адреса.
//
// Пределы «на адрес» (30 неудач за 10 минут на сеть /64) и «на адрес + логин»
// (10 неудач, LOGIN_LOCKOUT_MINUTES) не мешают подбирать пароль к одной учётной
// записи сразу со многих адресов: каждый новый адрес начинает свой отсчёт
// заново (аудит, раунд 4, находка Р4-01). Здесь неудачи считаются по самому
// логину, со всех адресов вместе.
//
// Что мы обещаем (честная формулировка, проверка раунда 4, ПР-I4 и I-A):
//   1. Пока неудач меньше LOGIN_ACCOUNT_SOFT_LIMIT — ничего не меняется.
//   2. Знакомый адрес НИКОГДА не задерживается и не тратит ничего. Знакомый —
//      это адрес (/64), с которого сотрудник уже проходил проверку личности
//      (вход по паролю или «стук» устройства); отметка переживает перезапуск
//      (таблица trusted_login_sources). Привязанные устройства входят «стуком»
//      и этой защите не подчиняются вовсе.
//   3. Когда защита включена (счёт достиг порога), НЕзнакомые источники, помимо
//      своей персональной задержки, черпают из общего для учётной записи ведра
//      токенов: ёмкость LOGIN_ACCOUNT_UNFAMILIAR_CAP (10), пополнение
//      LOGIN_ACCOUNT_UNFAMILIAR_PER_HOUR в час (по умолчанию 30). Токен берётся
//      при допуске и ВОЗВРАЩАЕТСЯ при успехе, нейтральном исходе или перегрузке
//      очереди хэшей (BUSY); тратит его только подтверждённая неудача. Отсюда
//      жёсткая верхняя граница подбора одной учётной записи со СКОЛЬКИХ УГОДНО
//      адресов: ≈ порог + ёмкость + пополнение·24 ≈ 750 догадок в сутки,
//      независимо от числа адресов. Раньше границей было ≈961·N (I-A).
//   4. Персональная задержка источника (1, 2, 4… с, не дольше
//      LOGIN_ACCOUNT_MAX_DELAY_SECONDS, с разбросом) сохранена: поток атакующего
//      с его адресов не занимает «окно» настоящего сотрудника с его адреса.
//   5. Счёт затухает после LOGIN_LOCKOUT_MINUTES без неудач; сброс пароля
//      администратором очищает состояние учётной записи (clearAccount).
//
// Цена (честно): под активным подбором ИМЕННО этой учётной записи сотрудник с
// по-настоящему нового места может быть задержан (ведро исчерпано атакующим —
// ответ просит войти с рабочего компьютера или обратиться к администратору;
// токен возвращается в ведро ~раз в две минуты). Привязанное устройство и любой
// знакомый адрес не задеты никогда. Навсегда запереть учётную запись нельзя.
//
// Одинаково для существующих и несуществующих логинов: путь один и тот же —
// иначе по тому, наступает ли задержка, узнавали бы, какие логины заведены.
//
// Состояние в памяти процесса; после перезапуска отсчёт начинается заново.

const config = require('../config');

// Потолки карт. Переполнение НИКОГДА не отказывает живому входу: вытесняется
// запись, которая никого не сдерживает (не «включённая»), а при неудаче —
// самая старая; вход при этом допускается (fail open, ПР-01).
const DEFAULT_MAX_ENTRIES = 50000;
let maxEntries = DEFAULT_MAX_ENTRIES;
const EVICTION_SCAN = 200;

const KNOWN_SOURCES_PER_ACCOUNT = 5;
const KNOWN_SOURCE_TTL_MS = 30 * 86400000;
const ENGAGED_BASE_DELAY_MS = 1000;

const accounts = new Map(); // nameKey -> { failures, lastFailureAt, engagedAt } — «включённость», заводится при неудаче
const buckets = new Map();  // nameKey -> { tokens, lastRefill } — ведро для незнакомых, консультируется ВСЕГДА
const sources = new Map();  // `${nameKey}\u0000${ipKey}` -> { failures, nextAllowedAt, lastAt }
const knownSources = new Map(); // nameKey -> Map(ipKey -> время удачного входа) — «горячий» кэш поверх таблицы

function softLimit() {
  return config.LOGIN_ACCOUNT_SOFT_LIMIT;
}
// Ёмкость ведра токенов для незнакомых источников = мягкий порог (третий раунд
// проверки, пункт 2): столько догадок с незнакомых адресов допускается разом,
// дальше — по мере пополнения.
function bucketCap() {
  return softLimit();
}
function maxDelayMs() {
  return config.LOGIN_ACCOUNT_MAX_DELAY_SECONDS * 1000;
}
function quietWindowMs() {
  return config.LOGIN_LOCKOUT_MINUTES * 60000;
}
function unfamiliarPerHour() {
  return config.LOGIN_ACCOUNT_UNFAMILIAR_PER_HOUR;
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

function isEngaged(acc) {
  return Boolean(acc && acc.failures >= softLimit());
}

// Вытеснение под потолок. Предпочитает записи, которые никого не сдерживают
// (не «включённые»): включённую (идёт атака) вытесняем в последнюю очередь,
// иначе поток мусора сбрасывал бы защиту жертвы (I-A). Никогда не отказывает.
function evictAccountIfNeeded(now) {
  if (accounts.size < maxEntries) return;
  let scanned = 0;
  let oldest;
  for (const [key, acc] of accounts) {
    if (oldest === undefined) oldest = key;
    if (!isEngaged(acc)) { accounts.delete(key); return; }
    if (++scanned >= EVICTION_SCAN) break;
  }
  if (oldest !== undefined) accounts.delete(oldest);
}

function setBoundedSource(key, value) {
  if (sources.size >= maxEntries && !sources.has(key)) {
    const oldest = sources.keys().next().value;
    if (oldest !== undefined) sources.delete(oldest);
  }
  sources.set(key, value);
}

// Задержка источника от числа ЕГО собственных неудач при включённой защите.
function sourceDelay(sourceFailures) {
  return Math.min(maxDelayMs(), ENGAGED_BASE_DELAY_MS * 2 ** Math.min(sourceFailures, 20));
}

// «Включённость» учётной записи (счёт неудач) читается, но НЕ создаётся при
// допуске: заводится только при подтверждённой неудаче (settle). Иначе
// перегрузка очереди хэшей (BUSY) плодила бы записи даром и могла вытеснить
// «включённое» состояние жертвы (I-A). Ведро токенов — в ОТДЕЛЬНОЙ карте
// (bucketFor), поэтому консультировать его на допуске можно, не трогая эту.
function accountFor(nameKey, now, { create = false } = {}) {
  let acc = accounts.get(nameKey);
  if (acc && acc.lastFailureAt && now - acc.lastFailureAt >= quietWindowMs()) {
    acc.failures = 0;
    acc.engagedAt = 0;
  }
  if (!acc && create) {
    acc = { failures: 0, lastFailureAt: 0, engagedAt: 0 };
    evictAccountIfNeeded(now);
    accounts.set(nameKey, acc);
  }
  return acc || null;
}

// Ведро токенов учётной записи. Консультируется ВСЕГДА для незнакомых
// источников (не только когда защита «включена»), иначе «пульсирующий» подбор
// (всплеск — тишина на LOGIN_LOCKOUT_MINUTES, чтобы счёт неудач обнулился, —
// снова всплеск) обходил бы предел (третий раунд проверки, пункт 2). Пополнение
// НЕ зависит от обнуления счёта неудач: за сутки доступно не больше
// ёмкость + пополнение·24 ≈ 20 + 30·24 ≈ 740 токенов при любом ритме атаки.
function bucketFor(nameKey, now, { create = false } = {}) {
  let b = buckets.get(nameKey);
  if (!b && create) {
    b = { tokens: bucketCap(), lastRefill: now };
    if (buckets.size >= maxEntries && !buckets.has(nameKey)) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(nameKey, b);
  }
  if (b) refill(b, now);
  return b || null;
}

function refill(b, now) {
  const cap = bucketCap();
  const perHour = unfamiliarPerHour();
  if (perHour <= 0) { b.tokens = cap; b.lastRefill = now; return; }
  const perMs = 3600000 / perHour;
  const gained = (now - b.lastRefill) / perMs;
  if (gained > 0) {
    b.tokens = Math.min(cap, b.tokens + gained);
    b.lastRefill = now;
  } else if (b.tokens > cap) {
    b.tokens = cap; // ёмкость могла уменьшиться при смене настройки
  }
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
    setBoundedSource(key, src);
  }
  return src || null;
}

function jitteredWithin(ms) {
  // Разброс один раз (I-C, minor) и итог в пределах LOGIN_ACCOUNT_MAX_DELAY_SECONDS.
  const spread = Math.max(250, Math.round(ms * 0.3));
  return Math.min(maxDelayMs(), ms + Math.floor(Math.random() * spread));
}

/**
 * Можно ли сейчас проверить пароль под этим логином с этого адреса.
 *
 * @returns {{ ok: true, ticket, engaged } | { ok: false, retryAfterMs, reason }}
 *   reason: 'delay' — персональная задержка источника; 'account' — исчерпано
 *   ведро токенов учётной записи (сообщение просит войти с рабочего места).
 */
function admit(nameKey, { ipKey = null, trusted = false, now = Date.now() } = {}) {
  // Знакомый адрес — никаких задержек, вёдер и влияния на счётчики.
  if (trusted) return { ok: true, ticket: { nameKey, ipKey, trusted: true, tookToken: false }, engaged: false };

  const acc = accountFor(nameKey, now, { create: false });
  const engaged = isEngaged(acc);

  // Персональная задержка источника — только когда защита включена
  // (справедливость между адресами). Проверяется ДО ведра: задержанный источник
  // токен не тратит.
  if (engaged) {
    const src = sourceEntryFor(nameKey, ipKey, now, true);
    if (now < src.nextAllowedAt) {
      return { ok: false, retryAfterMs: jitteredWithin(src.nextAllowedAt - now), reason: 'delay' };
    }
  }

  // Общее ведро токенов на учётную запись для незнакомых источников —
  // консультируется ВСЕГДА (пункт 2): именно оно, а не обнуляемый счёт неудач,
  // держит суточную границу подбора при любом ритме.
  let tookToken = false;
  if (unfamiliarPerHour() > 0) {
    const b = bucketFor(nameKey, now, { create: true });
    if (b.tokens < 1) {
      const perMs = 3600000 / unfamiliarPerHour();
      return { ok: false, retryAfterMs: jitteredWithin(perMs), reason: 'account' };
    }
    b.tokens -= 1;
    tookToken = true;
  }

  let firstEngage = false;
  if (engaged) {
    firstEngage = !acc.engagedAt;
    if (firstEngage) acc.engagedAt = now;
    const src = sourceEntryFor(nameKey, ipKey, now, true);
    src.nextAllowedAt = now + sourceDelay(src.failures + 1);
  }
  return { ok: true, ticket: { nameKey, ipKey, trusted: false, tookToken }, engaged: firstEngage };
}

/**
 * Итог допущенной попытки.
 *   'failure' — пароль проверен и не подошёл (или логина нет): тратит токен;
 *   'success' / 'neutral' — токен возвращается, на счётчики не влияет.
 * BUSY (перегрузка очереди хэшей) приходит сюда как 'neutral'.
 */
function settle(ticket, outcome, { now = Date.now() } = {}) {
  if (!ticket || ticket.trusted) return;

  if (outcome !== 'failure') {
    // Возврат токена: попытка не была подтверждённой неудачей (успех, нейтраль,
    // BUSY) — легитимный пользователь тратит токен только на реальную ошибку.
    if (ticket.tookToken) {
      const b = buckets.get(ticket.nameKey);
      if (b) b.tokens = Math.min(bucketCap(), b.tokens + 1);
    }
    return;
  }

  // Подтверждённая неудача — только теперь заводим/поднимаем запись.
  const acc = accountFor(ticket.nameKey, now, { create: true });
  acc.failures += 1;
  acc.lastFailureAt = now;
  accounts.delete(ticket.nameKey);
  accounts.set(ticket.nameKey, acc); // свежую — в конец очереди вытеснения

  const key = sourceKey(ticket.nameKey, ticket.ipKey);
  const src = sources.get(key) || { failures: 0, nextAllowedAt: 0, lastAt: now };
  src.failures += 1;
  src.lastAt = now;
  if (isEngaged(acc)) {
    src.nextAllowedAt = Math.max(src.nextAllowedAt, now + sourceDelay(src.failures));
  }
  sources.delete(key);
  setBoundedSource(key, src);
}

// Сброс пароля администратором (и разблокировка, если появится) снимает
// наказание с учётной записи: сотрудник снова входит откуда угодно (I-A).
function clearAccount(nameKey) {
  const key = canonicalUsername(nameKey);
  if (!key) return;
  accounts.delete(key);
  buckets.delete(key);
  const prefix = `${key}\u0000`;
  for (const sk of sources.keys()) if (sk.startsWith(prefix)) sources.delete(sk);
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
  if (knownSources.size >= maxEntries && !knownSources.has(nameKey)) {
    knownSources.delete(knownSources.keys().next().value);
  }
  knownSources.set(nameKey, m);
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
  // Полное ведро держать незачем; недополненное — оставляем (иначе тишина
  // сбрасывала бы наказание, ровно чего «пульс» и добивается).
  for (const [key, b] of buckets) {
    refill(b, now);
    if (b.tokens >= bucketCap()) buckets.delete(key);
  }
}
setInterval(() => prune(), 5 * 60000).unref();

// Для тестов.
function resetThrottle({ maxEntries: max } = {}) {
  accounts.clear();
  buckets.clear();
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
  clearAccount,
  rememberSuccess,
  isKnownSource,
  resetThrottle,
  throttleSize
};
