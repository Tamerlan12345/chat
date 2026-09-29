// Суточный предел неверных попыток входа на учётную запись (требование
// владельца, sec5): не больше ~15–20 неудачных проверок пароля на учётную
// запись за скользящие 24 часа. Считаем неудачи в ТРЁХ раздельных корзинах,
// чтобы один класс не съедал бюджет другого:
//
//   U — вход с НЕзнакомых адресов          (LOGIN_DAILY_FAILURES_UNFAMILIAR, 5)
//   F — вход со ЗНАКОМЫХ адресов (офис/свои) (LOGIN_DAILY_FAILURES_FAMILIAR, 10)
//   P — неверный текущий пароль при смене    (PASSWORD_CHANGE_DAILY_FAILURES, 5)
//
// Итого не больше 20 за 24 часа. Когда корзина исчерпана, дальнейшие попытки
// этого класса отклоняются БЕЗ проверки пароля (429, даже для верного пароля),
// пока самая старая неудача не выйдет из окна 24 ч или администратор не сбросит
// пароль. Считается только ПОДТВЕРЖДЁННАЯ неудача (реально неверный пароль или
// несуществующий логин); BUSY и нейтральные исходы не считаются.
//
// Персистентность: неудачи существующих сотрудников переживают перезапуск
// (таблица login_failure_log; Railway передеплоивает часто). Несуществующие
// логины держатся только в памяти (ограниченная карта) — перезапуск сбрасывает
// лишь выдуманные имена; это ничтожный оракул, отмеченный в документации.
//
// Успех сбрасывает ТОЛЬКО свою корзину: удачный вход со знакомого адреса чистит
// F, с незнакомого — U (и адрес становится знакомым), удачная смена пароля —
// P. Иначе ежедневный вход сотрудника из офиса дарил бы внешнему подбору свежий
// бюджет U.
//
// Знакомость и привязанные устройства: «стук» устройства этой защите не
// подчиняется вовсе (идёт мимо этого модуля). Знакомый адрес — тот, с которого
// уже был проверенный вход (см. auth.service.isTrustedSource): его неудачи идут
// в F, а не в U.
//
// Исчерпание корзины сотрудника — событие login_daily_budget_exhausted в журнале
// аудита; по нему центр безопасности поднимает оповещение с классом корзины.
//
// Ниже — вторичные слои, оставленные как были: персональная задержка источника
// (progressive delay для незнакомых адресов; как и в исходном дизайне Р4-01 —
// только при подборе с нескольких адресов, см. engageAt), «горячий» кэш
// знакомых адресов.
// Пределы «на адрес» (login-fail /64), «адрес+логин» (pair lock) и число
// одновременных проверок живут вне этого модуля.

const config = require('../config');

const DAY_MS = 24 * 3600 * 1000;
const MAX_ENTRIES = 50000; // потолок карты в памяти (в т. ч. выдуманные имена)
const RETRY_AFTER_CAP_MS = 3600 * 1000; // разумный потолок заголовка Retry-After
const ENGAGED_BASE_DELAY_MS = 1000;
const KNOWN_SOURCES_PER_ACCOUNT = 5;
const KNOWN_SOURCE_TTL_MS = 30 * 86400000;
const CLASSES = ['U', 'F', 'P'];

// accountKey -> { U:[ms], F:[ms], P:[ms], persistent, loaded }
// accountKey: `u:<userId>` (в базе) или `n:<nameKey>` (только память).
const daily = new Map();
const loading = new Map(); // userId -> Promise загрузки из базы (защита от гонки)
const sources = new Map(); // `${nameKey}\u0000${ipKey}` -> { failures, nextAllowedAt, lastAt }
const knownSources = new Map(); // nameKey -> Map(ipKey -> время удачного входа)

function limitFor(cls) {
  if (cls === 'U') return config.LOGIN_DAILY_FAILURES_UNFAMILIAR;
  if (cls === 'F') return config.LOGIN_DAILY_FAILURES_FAMILIAR;
  return config.PASSWORD_CHANGE_DAILY_FAILURES; // 'P'
}
function maxDelayMs() {
  return config.LOGIN_ACCOUNT_MAX_DELAY_SECONDS * 1000;
}

/**
 * Единая форма логина: NFKC, без пробелов по краям, нижний регистр. Все
 * написания, находящие одну учётную запись, попадают в один счётчик (Р4-06).
 */
function canonicalUsername(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().normalize('NFKC').trim().toLowerCase();
}

function keyFor(userId, nameKey) {
  return userId ? `u:${Number(userId)}` : `n:${canonicalUsername(nameKey)}`;
}

function entryFor(key, { create = false } = {}) {
  let e = daily.get(key);
  if (!e && create) {
    e = { U: [], F: [], P: [], persistent: key.startsWith('u:'), loaded: !key.startsWith('u:') };
    if (daily.size >= MAX_ENTRIES && !daily.has(key)) {
      const oldest = daily.keys().next().value; // fail open: вытесняем самый старый
      if (oldest !== undefined) daily.delete(oldest);
    }
    daily.set(key, e);
  }
  return e || null;
}

function pruneArr(arr, now) {
  const cutoff = now - DAY_MS;
  while (arr.length && arr[0] <= cutoff) arr.shift();
  return arr;
}

function classBlocked(e, cls, now) {
  const lim = limitFor(cls);
  if (lim <= 0) return false; // 0 — корзина выключена (документируется)
  pruneArr(e[cls], now);
  return e[cls].length >= lim;
}

function classRetryAfterMs(e, cls, now) {
  const arr = e[cls];
  if (!arr.length) return 1000;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(1000, arr[0] + DAY_MS - now));
}

// Порог «включённости» персональной задержки источника. На единицу выше потолка
// одной пары адрес+логин (LOGIN_MAX_FAILED_ATTEMPTS): одиночный источник упирается
// в блокировку пары раньше, чем сработает этот слой, поэтому задержка вступает в
// дело только при подборе с НЕСКОЛЬКИХ адресов. Единичные опечатки сотрудника (в
// т. ч. весь офис за одним NAT) до этого порога не задерживаются. При стандартной
// суточной корзине (U=5) и стандартном LOGIN_MAX_FAILED_ATTEMPTS слой обычно
// дремлет (корзина отклоняет раньше) — он оживает, если корзину ослабить/выключить.
function engageAt() {
  return config.LOGIN_MAX_FAILED_ATTEMPTS + 1;
}
function isEngaged(e, now) {
  pruneArr(e.U, now);
  return e.U.length >= engageAt();
}

// ── Персистентность (существующие сотрудники) ───────────────────────────────

function identityDb() {
  const { identity, isIdentityReady } = require('../db/identity');
  return isIdentityReady() ? identity() : null;
}

// Подгрузка неудач сотрудника из базы. Гонка закрыта: конкурентные вызовы ждут
// одно обещание; результат сливается с тем, что уже записано в памяти.
function ensureLoaded(userId) {
  if (!userId) return Promise.resolve();
  const key = `u:${Number(userId)}`;
  const e = daily.get(key);
  if (e && e.loaded) return Promise.resolve();
  if (loading.has(key)) return loading.get(key);
  const p = (async () => {
    try {
      const db = identityDb();
      if (!db) return;
      const cutoff = new Date(Date.now() - DAY_MS).toISOString();
      const rows = await db.all(
        'SELECT class, at FROM login_failure_log WHERE user_id = $1 AND at >= $2 ORDER BY at ASC',
        [Number(userId), cutoff]
      );
      const target = entryFor(key, { create: true });
      for (const cls of CLASSES) {
        const fromDb = rows.filter((r) => r.class === cls).map((r) => new Date(r.at).getTime());
        // Слияние с тем, что успели записать в память за время загрузки.
        target[cls] = [...new Set([...target[cls], ...fromDb])].sort((a, b) => a - b);
        const lim = limitFor(cls);
        if (lim > 0 && target[cls].length > lim) target[cls] = target[cls].slice(-lim);
      }
      target.loaded = true;
    } catch {
      /* на очень старой базе таблицы может ещё не быть — наполнится по ходу */
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, p);
  return p;
}

function persistFailure(userId, cls, nowMs) {
  const db = identityDb();
  if (!db) return;
  const iso = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - DAY_MS).toISOString();
  const lim = limitFor(cls);
  Promise.resolve()
    .then(() => db.run('INSERT INTO login_failure_log (user_id, class, at) VALUES ($1, $2, $3)', [Number(userId), cls, iso]))
    .then(() => db.run('DELETE FROM login_failure_log WHERE user_id = $1 AND class = $2 AND at < $3', [Number(userId), cls, cutoff]))
    .then(() => {
      if (lim <= 0) return null;
      // Оставляем не больше lim самых свежих строк на (сотрудник, класс).
      return db.run(
        `DELETE FROM login_failure_log
         WHERE user_id = $1 AND class = $2 AND at NOT IN (
           SELECT at FROM login_failure_log WHERE user_id = $1 AND class = $2 ORDER BY at DESC LIMIT $3)`,
        [Number(userId), cls, lim]
      );
    })
    .catch((err) => console.warn('[LoginThrottle] не удалось записать неудачу входа:', err.message));
}

function persistClear(userId, cls) {
  const db = identityDb();
  if (!db) return;
  const sql = cls
    ? ['DELETE FROM login_failure_log WHERE user_id = $1 AND class = $2', [Number(userId), cls]]
    : ['DELETE FROM login_failure_log WHERE user_id = $1', [Number(userId)]];
  db.run(sql[0], sql[1]).catch((err) => console.warn('[LoginThrottle] не удалось очистить журнал неудач:', err.message));
}

// Регистрация неудачи в корзине класса (+ запись в базу для сотрудников).
function recordFailure(userId, nameKey, cls, nowMs) {
  const key = keyFor(userId, nameKey);
  const e = entryFor(key, { create: true });
  pruneArr(e[cls], nowMs);
  const wasBlocked = classBlocked(e, cls, nowMs);
  e[cls].push(nowMs);
  const lim = limitFor(cls);
  if (lim > 0 && e[cls].length > lim) e[cls] = e[cls].slice(-lim);
  if (userId) persistFailure(userId, cls, nowMs);
  // Исчерпание корзины (один раз на переход) — событие в журнале аудита, по нему
  // центр безопасности поднимает оповещение с учётной записью и классом
  // (security-monitor, правило login_daily_budget_exhausted, с дедупликацией).
  // Только для реального сотрудника: выдуманное имя — шум.
  if (userId && !wasBlocked && lim > 0 && e[cls].length >= lim) {
    try {
      require('./audit.service').log({
        userId: Number(userId), action: 'login_daily_budget_exhausted', details: { class: cls, limit: lim }
      });
    } catch { /* журнал недоступен — не критично для отказа */ }
  }
}

function clearClass(userId, nameKey, cls) {
  const e = daily.get(keyFor(userId, nameKey));
  // В базу идём, только если там может что-то быть: иначе каждый удачный вход
  // (утром — весь офис разом) стоил бы лишней записи DELETE.
  const mayHaveRows = !e || !e.loaded || e[cls].length > 0;
  if (e) e[cls] = [];
  if (userId && mayHaveRows) persistClear(userId, cls);
}

// ── Персональная задержка источника (вторичный слой, для незнакомых) ─────────

function sourceKey(nameKey, ipKey) {
  return `${nameKey}\u0000${ipKey || 'unknown'}`;
}
function sourceDelay(failures) {
  return Math.min(maxDelayMs(), ENGAGED_BASE_DELAY_MS * 2 ** Math.min(failures, 20));
}
function sourceEntryFor(nameKey, ipKey, now, create) {
  const key = sourceKey(nameKey, ipKey);
  let src = sources.get(key);
  if (src && now - src.lastAt >= DAY_MS) { sources.delete(key); src = undefined; }
  if (!src && create) {
    if (sources.size >= MAX_ENTRIES && !sources.has(key)) {
      const oldest = sources.keys().next().value;
      if (oldest !== undefined) sources.delete(oldest);
    }
    src = { failures: 0, nextAllowedAt: 0, lastAt: now };
    sources.set(key, src);
  }
  return src || null;
}
function jitteredWithin(ms) {
  const spread = Math.max(250, Math.round(ms * 0.3));
  return Math.min(maxDelayMs(), ms + Math.floor(Math.random() * spread));
}

// ── Допуск и итог ────────────────────────────────────────────────────────────

/**
 * Можно ли сейчас проверить пароль под этим логином.
 * Для существующих сотрудников перед вызовом нужно await ensureLoaded(userId).
 *
 * @returns {{ ok:true, ticket } | { ok:false, retryAfterMs, reason, cls }}
 *   reason: 'daily' — исчерпана суточная корзина (cls: 'U'|'F'); 'delay' —
 *   персональная задержка незнакомого источника.
 */
function admit(nameKey, { ipKey = null, trusted = false, userId = null, now = Date.now() } = {}) {
  const cls = trusted ? 'F' : 'U';
  const e = entryFor(keyFor(userId, nameKey), { create: true });
  if (classBlocked(e, cls, now)) {
    return { ok: false, reason: 'daily', cls, retryAfterMs: classRetryAfterMs(e, cls, now) };
  }
  // Персональная задержка — только для незнакомых адресов (офис не задерживаем) и
  // только когда защита «включена» (распределённый подбор, см. isEngaged): иначе
  // единичная опечатка сотрудника задержала бы его же следующий верный вход, а
  // блокировку пары адрес+логин (проверяется в auth.service ПОСЛЕ admit) не давала
  // бы набрать одиночному источнику.
  if (!trusted && isEngaged(e, now)) {
    const src = sourceEntryFor(nameKey, ipKey, now, true);
    if (now < src.nextAllowedAt) {
      return { ok: false, reason: 'delay', retryAfterMs: jitteredWithin(src.nextAllowedAt - now) };
    }
  }
  return { ok: true, ticket: { nameKey, userId, ipKey, cls } };
}

/**
 * Итог допущенной попытки.
 *   'failure' — пароль подтверждённо неверен (или логина нет): +1 в корзину cls;
 *   'success' — сброс ТОЛЬКО корзины cls;
 *   'neutral' — ничего (BUSY, отказ по паре адрес+логин и т. п.).
 */
function settle(ticket, outcome, { now = Date.now() } = {}) {
  if (!ticket) return;
  if (outcome === 'failure') {
    recordFailure(ticket.userId, ticket.nameKey, ticket.cls, now);
    if (ticket.cls === 'U') {
      const src = sourceEntryFor(ticket.nameKey, ticket.ipKey, now, true);
      src.failures += 1;
      src.lastAt = now;
      // Растущая задержка источника взводится только во «включённом» состоянии
      // (распределённый подбор) — до порога единичные ошибки её не копят.
      const e = daily.get(keyFor(ticket.userId, ticket.nameKey));
      if (e && isEngaged(e, now)) {
        src.nextAllowedAt = Math.max(src.nextAllowedAt, now + sourceDelay(src.failures));
      }
    }
  } else if (outcome === 'success') {
    clearClass(ticket.userId, ticket.nameKey, ticket.cls);
  }
}

// ── Смена пароля (корзина P) ─────────────────────────────────────────────────

function passwordChangeStatus(userId, now = Date.now()) {
  const e = entryFor(keyFor(userId, null), { create: true });
  if (classBlocked(e, 'P', now)) {
    return { blocked: true, retryAfterMs: classRetryAfterMs(e, 'P', now) };
  }
  return { blocked: false, retryAfterMs: 0 };
}
function recordPasswordChangeFailure(userId, now = Date.now()) {
  recordFailure(userId, null, 'P', now);
}
function clearPasswordChange(userId) {
  clearClass(userId, null, 'P');
}

// ── Сброс всего наказания учётной записи (сброс пароля администратором) ───────
function clearAccount(nameKey, { userId = null } = {}) {
  const name = canonicalUsername(nameKey);
  if (userId) {
    daily.delete(`u:${Number(userId)}`);
    persistClear(userId, null);
  }
  if (name) {
    daily.delete(`n:${name}`);
    const prefix = `${name}\u0000`;
    for (const sk of sources.keys()) if (sk.startsWith(prefix)) sources.delete(sk);
  }
}

// Для панели администратора («заблокировано учётных записей»): логины
// сотрудников, у которых сейчас исчерпана хотя бы одна суточная корзина. Берётся
// из журнала в базе, а не из памяти — переживает перезапуск и не зависит от
// того, подгружена ли запись. Выключенная корзина (0) в счёт не идёт.
async function exhaustedUsernames(now = Date.now()) {
  const db = identityDb();
  if (!db) return [];
  const lim = (cls) => (limitFor(cls) > 0 ? limitFor(cls) : 1e9);
  const rows = await db.all(
    `SELECT u.username AS username FROM users u
     WHERE u.id IN (
       SELECT user_id FROM login_failure_log WHERE at >= $1
       GROUP BY user_id, class
       HAVING (class = 'U' AND COUNT(*) >= $2) OR (class = 'F' AND COUNT(*) >= $3) OR (class = 'P' AND COUNT(*) >= $4))`,
    [new Date(now - DAY_MS).toISOString(), lim('U'), lim('F'), lim('P')]
  );
  return rows.map((r) => canonicalUsername(r.username));
}

// ── Знакомые адреса (горячий кэш поверх trusted_login_sources) ────────────────

function rememberSuccess(nameKey, ipKey, now = Date.now()) {
  if (!nameKey || !ipKey) return;
  let m = knownSources.get(nameKey);
  if (!m) m = new Map();
  else knownSources.delete(nameKey);
  m.delete(ipKey);
  m.set(ipKey, now);
  while (m.size > KNOWN_SOURCES_PER_ACCOUNT) m.delete(m.keys().next().value);
  if (knownSources.size >= MAX_ENTRIES && !knownSources.has(nameKey)) {
    knownSources.delete(knownSources.keys().next().value);
  }
  knownSources.set(nameKey, m);
}
function isKnownSource(nameKey, ipKey, now = Date.now()) {
  const at = knownSources.get(nameKey)?.get(ipKey);
  return Boolean(at && now - at < KNOWN_SOURCE_TTL_MS);
}

function prune(now = Date.now()) {
  for (const [key, e] of daily) {
    let any = false;
    for (const cls of CLASSES) { pruneArr(e[cls], now); if (e[cls].length) any = true; }
    if (!any && e.loaded) daily.delete(key);
  }
  for (const [key, src] of sources) {
    if (now - src.lastAt >= DAY_MS && now >= src.nextAllowedAt) sources.delete(key);
  }
}
setInterval(() => prune(), 5 * 60000).unref();

// Для тестов.
function resetThrottle() {
  daily.clear();
  loading.clear();
  sources.clear();
  knownSources.clear();
}
function dailyCount(userId, nameKey, cls, now = Date.now()) {
  const e = daily.get(keyFor(userId, nameKey));
  if (!e) return 0;
  return pruneArr(e[cls], now).length;
}

module.exports = {
  canonicalUsername,
  ensureLoaded,
  admit,
  settle,
  passwordChangeStatus,
  recordPasswordChangeFailure,
  clearPasswordChange,
  clearAccount,
  exhaustedUsernames,
  rememberSuccess,
  isKnownSource,
  resetThrottle,
  dailyCount
};
