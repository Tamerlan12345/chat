// Знакомые адреса входа сотрудника, пережившие перезапуск.
//
// Задержка входа по учётной записи под распределённым подбором не должна
// задевать настоящего сотрудника с его обычного адреса (проверка раунда 4,
// ПР-I4). «Обычный» — адрес (сеть /64), с которого он уже проходил проверку
// личности. Хранятся в таблице trusted_login_sources.
//
// КТО может ЗАВЕСТИ знакомый адрес (проверка раунда 4, I-2): только вход по
// паролю или «стук» привязанного устройства — то есть предъявление секрета,
// которого у постороннего нет. Продление токена и авторизация WebSocket могут
// лишь ОБНОВИТЬ уже известный адрес, но не завести новый: иначе украденный
// живой токен позволил бы посадить в «знакомые» до восьми адресов атакующего.
// Сверх того — суточный предел на число НОВЫХ адресов у одного сотрудника.
//
// Запись в базу дедуплицируется (не чаще раза в час на пару «сотрудник+адрес»),
// но по-настоящему НОВЫЙ адрес пишется сразу.

const { identity, isIdentityReady } = require('../db/identity');

const MAX_PER_USER = 8;
const MAX_NEW_PER_DAY = 5; // сколько новых адресов сотрудник может завести за сутки
const TTL_MS = 60 * 86400000; // 60 дней
const REWRITE_MS = 60 * 60000; // не чаще раза в час обновлять существующий в базе
const MAX_DEDUP_KEYS = 50000;
const MAX_FAMILIAR_IPS = 20000;

const cache = new Map(); // userId -> Map(ipKey -> lastSeenMs)
const loading = new Map(); // userId -> Promise (защита от гонки загрузки, I-2)
const lastWrite = new Map(); // `${userId}|${ipKey}` -> ms последней записи в базу
const newToday = new Map(); // userId -> { day, count } — суточный предел новых адресов
const familiarIps = new Map(); // ipKey -> последний раз замечен: знаком хотя бы одной учётной записи (I-C)
let reverseLoaded = false;
let reverseLoading = null;

// Загрузка адресов сотрудника из базы. Гонка закрыта: конкурентные вызовы ждут
// одно обещание; результат СЛИВАЕТСЯ с тем, что уже успел записать record(), а
// не затирает его (I-2). Флаг «загружено» = наличие записи в cache.
function ensureLoaded(userId) {
  const uid = Number(userId);
  if (cache.has(uid) || !isIdentityReady()) return Promise.resolve();
  if (loading.has(uid)) return loading.get(uid);
  const p = (async () => {
    try {
      const rows = await identity().all(
        'SELECT ip_key, last_seen_at FROM trusted_login_sources WHERE user_id = $1',
        [uid]
      );
      const m = cache.get(uid) || new Map();
      for (const r of rows) {
        if (!m.has(r.ip_key)) m.set(r.ip_key, new Date(r.last_seen_at).getTime());
        touchFamiliar(r.ip_key);
      }
      cache.set(uid, m);
    } catch {
      // На очень старой базе таблицы может ещё не быть — знакомые адреса
      // восстановятся при следующем подтверждённом действии.
    } finally {
      loading.delete(uid);
    }
  })();
  loading.set(uid, p);
  return p;
}

async function isTrusted(userId, ipKey) {
  if (!userId || !ipKey) return false;
  await ensureLoaded(userId);
  const at = cache.get(Number(userId))?.get(ipKey);
  return Boolean(at && Date.now() - at < TTL_MS);
}

// Есть ли у сотрудника хоть один действующий знакомый адрес (для правила
// «новичок в офисе» суточного предела, sec5). Загрузка — та же, что у isTrusted,
// поэтому на входе лишнего запроса нет.
async function hasAnyFamiliar(userId, now = Date.now()) {
  if (!userId) return false;
  await ensureLoaded(userId);
  const m = cache.get(Number(userId));
  if (!m) return false;
  for (const at of m.values()) if (now - at < TTL_MS) return true;
  return false;
}

function touchFamiliar(ipKey) {
  if (!ipKey) return;
  familiarIps.delete(ipKey);
  familiarIps.set(ipKey, Date.now());
  if (familiarIps.size > MAX_FAMILIAR_IPS) familiarIps.delete(familiarIps.keys().next().value);
}

// Загрузка обратного индекса «адрес знаком хотя бы одной учётной записи» —
// один SELECT DISTINCT, лениво и один раз. Пока не загрузился, отвечаем по
// тому, что уже накоплено в памяти (растёт при каждом record/ensureLoaded).
function loadReverseIndex() {
  if (reverseLoaded || !isIdentityReady()) return Promise.resolve();
  if (reverseLoading) return reverseLoading;
  reverseLoading = (async () => {
    try {
      const rows = await identity().all('SELECT DISTINCT ip_key FROM trusted_login_sources');
      for (const r of rows) touchFamiliar(r.ip_key);
      // Плюс последний адрес входа по паролю у сотрудников, входивших за
      // последние 60 дней: он пишется только после проверенного входа по
      // паролю, поэтому безопасен как «знакомый», и после перезапуска адрес
      // офиса становится знакомым ещё до первого входа (третий раунд, пункт 3).
      // ISO-8601 в UTC сравнивается лексикографически — работает и в SQLite, и
      // в PostgreSQL.
      const cutoff = new Date(Date.now() - TTL_MS).toISOString();
      const recent = await identity().all(
        'SELECT last_login_ip FROM users WHERE last_login_ip IS NOT NULL AND last_login_at IS NOT NULL AND last_login_at >= $1',
        [cutoff]
      );
      const { rateLimitIpKey } = require('./ip-access.service');
      for (const r of recent) {
        const key = rateLimitIpKey(r.last_login_ip);
        if (key) touchFamiliar(key);
      }
      reverseLoaded = true;
    } catch (err) {
      // Запуск не останавливается: индекс наполнится по ходу работы, а до
      // первого успешного входа офис просто ограничен меньшим числом
      // одновременных входов. Но причина должна остаться в журнале.
      console.warn("[trusted-sources] не удалось загрузить знакомые адреса при запуске:", err?.message || err);
    } finally {
      reverseLoading = null;
    }
  })();
  return reverseLoading;
}

// Знаком ли адрес хотя бы одной учётной записи. Ответ намеренно «щедрый»:
// адрес попадает сюда только после успешного входа по паролю или «стука»
// (посторонний без учётных данных туда не попадёт), поэтому небольшая
// устарелость безопасна — используется лишь для выбора щедрого предела
// одновременных проверок пароля (I-C).
function isFamiliarToAnyoneSync(ipKey) {
  return Boolean(ipKey && familiarIps.has(ipKey));
}
async function primeReverseIndex() {
  await loadReverseIndex();
}

function overDailyNewCap(uid, now) {
  const day = Math.floor(now / 86400000);
  const rec = newToday.get(uid);
  if (!rec || rec.day !== day) return false;
  return rec.count >= MAX_NEW_PER_DAY;
}
function bumpDailyNew(uid, now) {
  const day = Math.floor(now / 86400000);
  const rec = newToday.get(uid);
  if (!rec || rec.day !== day) newToday.set(uid, { day, count: 1 });
  else rec.count += 1;
}

/**
 * Отметить адрес знакомым.
 * @param {{ allowCreate?: boolean }} opts allowCreate=true — вход по паролю или
 *   «стук» устройства (можно завести новый адрес); false — продление/WebSocket
 *   (можно только обновить уже известный).
 */
async function record(userId, ipKey, { allowCreate = false } = {}) {
  if (!userId || !ipKey || !isIdentityReady()) return;
  await ensureLoaded(userId);
  const uid = Number(userId);
  const now = Date.now();

  let m = cache.get(uid);
  if (!m) {
    m = new Map();
    cache.set(uid, m);
  }
  const isNew = !m.has(ipKey);
  if (isNew && !allowCreate) return; // продление/WebSocket не заводят новых адресов (I-2)
  if (isNew && overDailyNewCap(uid, now)) return; // суточный предел новых адресов (I-2)

  m.delete(ipKey);
  m.set(ipKey, now);
  while (m.size > MAX_PER_USER) m.delete(m.keys().next().value);
  touchFamiliar(ipKey);

  const wkey = `${uid}|${ipKey}`;
  // Существующий адрес пишем в базу не чаще раза в час; новый — сразу.
  if (!isNew && now - (lastWrite.get(wkey) || 0) < REWRITE_MS) return;
  if (lastWrite.size > MAX_DEDUP_KEYS) lastWrite.clear();
  lastWrite.set(wkey, now);
  if (isNew) bumpDailyNew(uid, now);

  try {
    await identity().run(
      `INSERT INTO trusted_login_sources (user_id, ip_key, last_seen_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, ip_key) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [uid, ipKey, new Date(now).toISOString()]
    );
    await identity().run(
      `DELETE FROM trusted_login_sources
       WHERE user_id = $1 AND ip_key NOT IN (
         SELECT ip_key FROM trusted_login_sources WHERE user_id = $1
         ORDER BY last_seen_at DESC LIMIT $2)`,
      [uid, MAX_PER_USER]
    );
  } catch (err) {
    lastWrite.delete(wkey);
    console.warn('[TrustedSources] не удалось запомнить адрес:', err.message);
  }
}

// Записать, ничего не ожидая (для мест, где задержка ответа нежелательна).
function recordAsync(userId, ipKey, opts) {
  record(userId, ipKey, opts).catch(() => {});
}

// Для тестов.
function _reset() {
  cache.clear();
  loading.clear();
  lastWrite.clear();
  newToday.clear();
  familiarIps.clear();
  reverseLoaded = false;
  reverseLoading = null;
}

module.exports = { isTrusted, hasAnyFamiliar, record, recordAsync, isFamiliarToAnyoneSync, primeReverseIndex, _reset };
