// Знакомые адреса входа сотрудника, пережившие перезапуск.
//
// Задержка входа по учётной записи под распределённым подбором не должна
// задевать настоящего сотрудника с его обычного адреса (проверка раунда 4,
// ПР-I4). «Обычный» — это адрес (сеть /64), с которого он уже проходил
// проверку личности: вход по паролю, «стук» устройства, продление токена,
// подключение WebSocket. Раньше такие адреса помнились только в памяти
// (терялись при перезапуске) и только для входа по паролю (last_login_ip);
// поэтому после перезапуска или у сотрудника, входящего «стуком», знакомых
// адресов не было вовсе, и под атакой он попадал под задержку.
//
// Здесь адреса хранятся в таблице trusted_login_sources и обновляются при
// ЛЮБОМ подтверждённом действии. Запись в базу — не чаще раза в час на пару
// (сотрудник, адрес): утренний вход всего офиса не должен превращаться в поток
// запросов к базе. В памяти держится «горячий» кэш, чтобы проверка на входе
// не ходила в базу на каждый запрос.

const { identity, isIdentityReady } = require('../db/identity');

const MAX_PER_USER = 8;
const TTL_MS = 60 * 86400000; // 60 дней
const REWRITE_MS = 60 * 60000; // не чаще раза в час писать в базу
const MAX_DEDUP_KEYS = 50000;

const cache = new Map(); // userId -> Map(ipKey -> lastSeenMs)
const loaded = new Set(); // userId, уже подгруженные из базы
const lastWrite = new Map(); // `${userId}|${ipKey}` -> ms последней записи в базу

async function ensureLoaded(userId) {
  if (loaded.has(userId) || !isIdentityReady()) return;
  loaded.add(userId);
  try {
    const rows = await identity().all(
      'SELECT ip_key, last_seen_at FROM trusted_login_sources WHERE user_id = $1',
      [Number(userId)]
    );
    const m = new Map();
    for (const r of rows) m.set(r.ip_key, new Date(r.last_seen_at).getTime());
    cache.set(Number(userId), m);
  } catch {
    // На очень старой базе таблицы может ещё не быть — не критично: знакомые
    // адреса просто восстановятся при следующем подтверждённом действии.
    loaded.delete(userId);
  }
}

async function isTrusted(userId, ipKey) {
  if (!userId || !ipKey) return false;
  await ensureLoaded(userId);
  const at = cache.get(Number(userId))?.get(ipKey);
  return Boolean(at && Date.now() - at < TTL_MS);
}

// Отметить адрес знакомым. Обновляет кэш всегда, базу — не чаще REWRITE_MS.
async function record(userId, ipKey) {
  if (!userId || !ipKey || !isIdentityReady()) return;
  await ensureLoaded(userId);
  const uid = Number(userId);
  const now = Date.now();

  let m = cache.get(uid);
  if (!m) {
    m = new Map();
    cache.set(uid, m);
  }
  m.delete(ipKey);
  m.set(ipKey, now);
  while (m.size > MAX_PER_USER) m.delete(m.keys().next().value);

  const wkey = `${uid}|${ipKey}`;
  if (now - (lastWrite.get(wkey) || 0) < REWRITE_MS) return; // дедуп записи в базу
  if (lastWrite.size > MAX_DEDUP_KEYS) lastWrite.clear(); // дедуп — лишь оптимизация
  lastWrite.set(wkey, now);

  try {
    await identity().run(
      `INSERT INTO trusted_login_sources (user_id, ip_key, last_seen_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, ip_key) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [uid, ipKey, new Date(now).toISOString()]
    );
    // Подрезаем до последних MAX_PER_USER, чтобы таблица не росла на каждого,
    // кто изредка входит из новых мест.
    await identity().run(
      `DELETE FROM trusted_login_sources
       WHERE user_id = $1 AND ip_key NOT IN (
         SELECT ip_key FROM trusted_login_sources WHERE user_id = $1
         ORDER BY last_seen_at DESC LIMIT $2)`,
      [uid, MAX_PER_USER]
    );
  } catch (err) {
    lastWrite.delete(wkey); // не записалось — позволим попробовать снова
    console.warn('[TrustedSources] не удалось запомнить адрес:', err.message);
  }
}

// Записать, ничего не ожидая (для мест, где задержка ответа нежелательна:
// «стук», продление, WebSocket).
function recordAsync(userId, ipKey) {
  record(userId, ipKey).catch(() => {});
}

// Для тестов.
function _reset() {
  cache.clear();
  loaded.clear();
  lastWrite.clear();
}

module.exports = { isTrusted, record, recordAsync, _reset };
