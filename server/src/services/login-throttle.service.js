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
// Параллельные попытки (проверка sec5, п.1): допуск смотрит не только на уже
// записанные неудачи, но и на попытки «в полёте» того же класса — иначе пачка
// одновременных запросов проходила бы проверку разом, пока ни одна неудача ещё
// не записана (30 параллельных → 30 проверок). Слот берётся при допуске и
// освобождается в settle при ЛЮБОМ исходе; потерянный слот (ошибка в коде
// вызывающего) сам истекает через INFLIGHT_STALE_MS.
//
// Ключ корзины — логин в единой форме (canonicalUsername) для ВСЕХ, и для
// существующих, и для несуществующих (проверка sec5, п.2): иначе «IVAN.PETROV»
// (поиск строки в базе точный, строка не находится) получал бы свежую корзину
// выдуманного имени, а у существующего «ivan.petrov» она исчерпана — оракул
// перечисления. Неудачи существующего сотрудника подгружаются из базы в тот же
// ключ. Логины, различающиеся лишь регистром/NFKC, делят одну корзину — как и
// блокировка пары адрес+логин (Р4-06).
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
// подчиняется вовсе (идёт мимо этого модуля). Какой корзине отнести попытку,
// решает auth.service (знакомый адрес — F; см. там же правило для новичка в
// офисе).
//
// Исчерпание корзины сотрудника — событие login_daily_budget_exhausted в журнале
// аудита; по нему центр безопасности поднимает оповещение с классом корзины.
//
// Ниже — вторичные слои, оставленные как были: персональная задержка источника
// (progressive delay для незнакомых адресов; как и в исходном дизайне Р4-01 —
// только при подборе с нескольких адресов, см. engageAt), «горячий» кэш
// знакомых адресов.
// Пределы «на адрес» (login-fail /64), «адрес+логин» (pair lock) и число
// одновременных проверок с адреса живут вне этого модуля.

const config = require('../config');

const DAY_MS = 24 * 3600 * 1000;
const MAX_ENTRIES = 50000; // потолок карты в памяти (в т. ч. выдуманные имена)
const RETRY_AFTER_CAP_MS = 3600 * 1000; // разумный потолок заголовка Retry-After
const ENGAGED_BASE_DELAY_MS = 1000;
const KNOWN_SOURCES_PER_ACCOUNT = 5;
const KNOWN_SOURCE_TTL_MS = 30 * 86400000;
// Проверка пароля (scrypt с очередью) укладывается в секунды; слот, который не
// вернули за две минуты, считаем потерянным — чтобы ошибка вызывающего кода не
// заперла учётную запись навсегда.
const INFLIGHT_STALE_MS = 2 * 60000;
const PENDING_RETRY_MS = 2000;
const CLASSES = ['U', 'F', 'P'];

// nameKey (единая форма логина) -> { U:[ms], F:[ms], P:[ms], userId, loaded }
//   userId — сотрудник, чьи неудачи пишутся в базу (null — выдуманное имя или
//   ещё не подгружено); loaded — строки из базы уже слиты в память.
const daily = new Map();
const loading = new Map(); // nameKey -> Promise загрузки из базы (защита от гонки)
const inflight = new Map(); // `${nameKey}|${cls}` -> Map(slotId -> since)
let slotSeq = 0;
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

function entryFor(nameKey, { create = false } = {}) {
  const key = canonicalUsername(nameKey);
  let e = daily.get(key);
  if (!e && create) {
    e = { U: [], F: [], P: [], userId: null, loaded: false };
    if (daily.size >= MAX_ENTRIES) {
      // Fail open: вытесняем самую старую запись. Для существующего сотрудника
      // это не обнуление — следующий вход снова подгрузит его неудачи из базы.
      const oldest = daily.keys().next().value;
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

function classRetryAfterMs(e, cls, now) {
  const arr = e[cls];
  if (!arr.length) return 1000;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(1000, arr[0] + DAY_MS - now));
}

// ── Попытки «в полёте» ───────────────────────────────────────────────────────

function inflightKey(name, cls) {
  return `${name}|${cls}`;
}
function inflightCount(name, cls, now) {
  const m = inflight.get(inflightKey(name, cls));
  if (!m) return 0;
  for (const [id, since] of m) if (now - since >= INFLIGHT_STALE_MS) m.delete(id);
  if (!m.size) inflight.delete(inflightKey(name, cls));
  return m.size;
}
function takeSlot(name, cls, now) {
  const k = inflightKey(name, cls);
  let m = inflight.get(k);
  if (!m) { m = new Map(); inflight.set(k, m); }
  slotSeq += 1;
  m.set(slotSeq, now);
  return slotSeq;
}
function releaseSlot(name, cls, id) {
  const k = inflightKey(name, cls);
  const m = inflight.get(k);
  if (!m) return;
  m.delete(id);
  if (!m.size) inflight.delete(k);
}

// Решение по корзине: null — можно; иначе отказ.
//   'daily'   — корзина исчерпана записанными неудачами;
//   'pending' — записанные + «в полёте» уже покрывают предел: ждём исхода.
function budgetRefusal(e, name, cls, now) {
  const lim = limitFor(cls);
  if (lim <= 0) return null; // 0 — корзина выключена (документируется)
  pruneArr(e[cls], now);
  if (e[cls].length >= lim) {
    return { ok: false, reason: 'daily', cls, retryAfterMs: classRetryAfterMs(e, cls, now) };
  }
  if (e[cls].length + inflightCount(name, cls, now) >= lim) {
    return { ok: false, reason: 'pending', cls, retryAfterMs: PENDING_RETRY_MS + Math.floor(Math.random() * 1000) };
  }
  return null;
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

// Слияние памяти и базы как мультимножеств: одна и та же неудача может быть и
// там, и там (запись в базу ещё не дошла) — считается один раз; две РАЗНЫЕ
// неудачи в одну миллисекунду — дважды (проверка sec5, п.5: Set их склеивал).
function mergeTimes(a, b) {
  const count = (arr) => arr.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const out = [];
  for (const t of new Set([...ca.keys(), ...cb.keys()])) {
    for (let i = 0; i < Math.max(ca.get(t) || 0, cb.get(t) || 0); i++) out.push(t);
  }
  return out.sort((x, y) => x - y);
}

// Подгрузка неудач сотрудника из базы в корзину его логина. Гонка закрыта:
// конкурентные вызовы ждут одно обещание; результат сливается с памятью.
function ensureLoaded(userId, nameKey) {
  const name = canonicalUsername(nameKey);
  if (!userId || !name) return Promise.resolve();
  const e = daily.get(name);
  if (e && e.loaded && e.userId === Number(userId)) return Promise.resolve();
  if (loading.has(name)) return loading.get(name);
  const p = (async () => {
    try {
      const db = identityDb();
      if (!db) return;
      const cutoff = new Date(Date.now() - DAY_MS).toISOString();
      const rows = await db.all(
        'SELECT class, at FROM login_failure_log WHERE user_id = $1 AND at >= $2 ORDER BY at ASC, id ASC',
        [Number(userId), cutoff]
      );
      const target = entryFor(name, { create: true });
      for (const cls of CLASSES) {
        const fromDb = rows.filter((r) => r.class === cls).map((r) => new Date(r.at).getTime());
        target[cls] = mergeTimes(target[cls], fromDb);
        const lim = limitFor(cls);
        if (lim > 0 && target[cls].length > lim) target[cls] = target[cls].slice(-lim);
      }
      target.userId = Number(userId);
      target.loaded = true;
    } catch {
      /* на очень старой базе таблицы может ещё не быть — наполнится по ходу */
    } finally {
      loading.delete(name);
    }
  })();
  loading.set(name, p);
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
      // Оставляем не больше lim самых свежих строк на (сотрудник, класс) —
      // по суррогатному id, чтобы совпавшие по времени строки не ускользали.
      return db.run(
        `DELETE FROM login_failure_log
         WHERE user_id = $1 AND class = $2 AND id NOT IN (
           SELECT id FROM login_failure_log WHERE user_id = $1 AND class = $2 ORDER BY at DESC, id DESC LIMIT $3)`,
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
function recordFailure(name, userId, cls, nowMs) {
  const e = entryFor(name, { create: true });
  const uid = userId || e.userId; // вариант написания существующего логина — тоже в его журнал
  pruneArr(e[cls], nowMs);
  const lim = limitFor(cls);
  const wasBlocked = lim > 0 && e[cls].length >= lim;
  e[cls].push(nowMs);
  if (lim > 0 && e[cls].length > lim) e[cls] = e[cls].slice(-lim);
  if (uid) persistFailure(uid, cls, nowMs);
  // Исчерпание корзины (один раз на переход) — событие в журнале аудита, по нему
  // центр безопасности поднимает оповещение с учётной записью и классом
  // (security-monitor, правило login_daily_budget_exhausted, с дедупликацией).
  // Только для реального сотрудника: выдуманное имя — шум.
  if (uid && !wasBlocked && lim > 0 && e[cls].length >= lim) {
    try {
      require('./audit.service').log({
        userId: Number(uid), action: 'login_daily_budget_exhausted', details: { class: cls, limit: lim }
      });
    } catch { /* журнал недоступен — не критично для отказа */ }
  }
}

function clearClass(name, userId, cls) {
  const e = daily.get(canonicalUsername(name));
  const uid = userId || e?.userId;
  // В базу идём, только если там может что-то быть: иначе каждый удачный вход
  // (утром — весь офис разом) стоил бы лишней записи DELETE.
  const mayHaveRows = !e || !e.loaded || e[cls].length > 0;
  if (e) e[cls] = [];
  if (uid && mayHaveRows) persistClear(uid, cls);
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
 * Можно ли сейчас проверить пароль под этим логином. Для существующего
 * сотрудника перед вызовом нужно await ensureLoaded(userId, nameKey).
 *
 * cls — корзина: 'U' (незнакомый адрес), 'F' (знакомый), 'P' (смена пароля);
 * по умолчанию выводится из trusted. Каждый допущенный билет ОБЯЗАН вернуться
 * в settle — при любом исходе, в том числе при исключении.
 *
 * @returns {{ ok:true, ticket } | { ok:false, retryAfterMs, reason, cls }}
 *   reason: 'daily' — корзина исчерпана; 'pending' — вместе с попытками «в
 *   полёте» предел уже покрыт; 'delay' — персональная задержка источника.
 */
function admit(nameKey, { ipKey = null, trusted = false, cls = null, userId = null, now = Date.now() } = {}) {
  const name = canonicalUsername(nameKey);
  const klass = cls || (trusted ? 'F' : 'U');
  const e = entryFor(name, { create: true });
  const refusal = budgetRefusal(e, name, klass, now);
  if (refusal) return refusal;
  // Персональная задержка — только для корзины незнакомых адресов (офис не
  // задерживаем) и только когда защита «включена» (распределённый подбор, см.
  // isEngaged): иначе единичная опечатка сотрудника задержала бы его же
  // следующий верный вход, а блокировку пары адрес+логин (проверяется в
  // auth.service ПОСЛЕ admit) не давала бы набрать одиночному источнику.
  if (klass === 'U' && isEngaged(e, now)) {
    const src = sourceEntryFor(name, ipKey, now, true);
    if (now < src.nextAllowedAt) {
      return { ok: false, reason: 'delay', cls: klass, retryAfterMs: jitteredWithin(src.nextAllowedAt - now) };
    }
  }
  const slot = takeSlot(name, klass, now);
  return { ok: true, ticket: { name, userId: userId ? Number(userId) : null, ipKey, cls: klass, slot, settled: false } };
}

/**
 * Итог допущенной попытки. Слот «в полёте» освобождается всегда.
 *   'failure' — пароль подтверждённо неверен (или логина нет): +1 в корзину cls;
 *   'success' — сброс ТОЛЬКО корзины cls;
 *   'neutral' — ничего (BUSY, отказ по паре адрес+логин, исключение и т. п.).
 */
function settle(ticket, outcome, { now = Date.now() } = {}) {
  if (!ticket || ticket.settled) return;
  ticket.settled = true;
  releaseSlot(ticket.name, ticket.cls, ticket.slot);
  if (outcome === 'failure') {
    recordFailure(ticket.name, ticket.userId, ticket.cls, now);
    if (ticket.cls === 'U') {
      const src = sourceEntryFor(ticket.name, ticket.ipKey, now, true);
      src.failures += 1;
      src.lastAt = now;
      // Растущая задержка источника взводится только во «включённом» состоянии
      // (распределённый подбор) — до порога единичные ошибки её не копят.
      const e = daily.get(ticket.name);
      if (e && isEngaged(e, now)) {
        src.nextAllowedAt = Math.max(src.nextAllowedAt, now + sourceDelay(src.failures));
      }
    }
  } else if (outcome === 'success') {
    clearClass(ticket.name, ticket.userId, ticket.cls);
  }
}

// ── Смена пароля (корзина P) ─────────────────────────────────────────────────

function admitPasswordChange(nameKey, { userId = null, now = Date.now() } = {}) {
  return admit(nameKey, { cls: 'P', userId, now });
}
function clearPasswordChange(nameKey, { userId = null } = {}) {
  clearClass(nameKey, userId, 'P');
}

// ── Сброс всего наказания учётной записи (сброс пароля администратором) ───────
function clearAccount(nameKey, { userId = null } = {}) {
  const name = canonicalUsername(nameKey);
  if (userId) persistClear(userId, null);
  if (name) {
    daily.delete(name);
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
    // Пустую запись можно забыть: у сотрудника следующий вход подгрузит журнал.
    if (!any) daily.delete(key);
  }
  for (const [k, m] of inflight) {
    for (const [id, since] of m) if (now - since >= INFLIGHT_STALE_MS) m.delete(id);
    if (!m.size) inflight.delete(k);
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
  inflight.clear();
  sources.clear();
  knownSources.clear();
}
function dailyCount(nameKey, cls, now = Date.now()) {
  const e = daily.get(canonicalUsername(nameKey));
  if (!e) return 0;
  return pruneArr(e[cls], now).length;
}
function inflightTotal() {
  let n = 0;
  for (const m of inflight.values()) n += m.size;
  return n;
}

module.exports = {
  canonicalUsername,
  ensureLoaded,
  admit,
  settle,
  admitPasswordChange,
  clearPasswordChange,
  clearAccount,
  exhaustedUsernames,
  rememberSuccess,
  isKnownSource,
  resetThrottle,
  dailyCount,
  inflightTotal
};
