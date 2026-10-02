const { getDatabase } = require('../db');

// Хранилище токенов push-уведомлений (таблица push_tokens базы переписки).
// Токен принадлежит ровно одному сотруднику: тот же токен, зарегистрированный
// другим (тот же телефон, другой вход), переходит к нему — уведомления
// прежнего владельца на чужое теперь устройство не идут. Удалить токен можно
// только свой.

const PLATFORMS = new Set(['ios', 'android']);
const KINDS = new Set(['alert', 'voip']);
const ENVIRONMENTS = new Set(['sandbox', 'production']);

/** Предел токенов на сотрудника (PUSH_MAX_TOKENS_PER_USER, по умолчанию 10). Читается при каждом вызове. */
function maxTokensPerUser() {
  const n = Number(process.env.PUSH_MAX_TOKENS_PER_USER);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 10;
}

function withSavepoint(db, fn) {
  db.exec('SAVEPOINT push_tokens');
  try {
    const result = fn();
    db.exec('RELEASE push_tokens');
    return result;
  } catch (err) {
    db.exec('ROLLBACK TO push_tokens');
    db.exec('RELEASE push_tokens');
    throw err;
  }
}

/**
 * Регистрирует (или обновляет) токен. Возвращает { previousUserId } — id
 * прежнего владельца, если токен перешёл от другого сотрудника, иначе null.
 * Тот же device_id + платформа + вид с новым токеном заменяет прежний токен
 * этого устройства (поставщики меняют токены). Сверх предела вытесняются
 * самые давно обновлённые токены сотрудника.
 */
function register({ userId, token, platform, kind, environment, deviceId = null, appVersion = null, session = {} }) {
  if (!PLATFORMS.has(platform) || !KINDS.has(kind) || !ENVIRONMENTS.has(environment)) throw new Error('Недопустимая регистрация токена');
  const db = getDatabase();
  const now = new Date().toISOString();
  return withSavepoint(db, () => {
    const prev = db.prepare('SELECT user_id FROM push_tokens WHERE token = ?').get(token);
    if (deviceId) {
      db.prepare('DELETE FROM push_tokens WHERE user_id = ? AND device_id = ? AND platform = ? AND kind = ? AND token <> ?')
        .run(Number(userId), deviceId, platform, kind, token);
    }
    db.prepare(`
      INSERT INTO push_tokens (token, user_id, platform, kind, environment, device_id, session_jti, token_version, auth_time, app_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        user_id = excluded.user_id, platform = excluded.platform, kind = excluded.kind,
        environment = excluded.environment, device_id = excluded.device_id,
        session_jti = excluded.session_jti, token_version = excluded.token_version,
        auth_time = excluded.auth_time, app_version = excluded.app_version,
        created_at = CASE WHEN push_tokens.user_id = excluded.user_id THEN push_tokens.created_at ELSE excluded.created_at END,
        updated_at = excluded.updated_at
    `).run(
      token, Number(userId), platform, kind, environment, deviceId,
      currentJti(userId, session.jti),
      Number.isInteger(session.tokenVersion) ? session.tokenVersion : null,
      Number.isFinite(session.authTime) ? Math.floor(session.authTime) : null,
      appVersion, now, now
    );
    db.prepare(`
      DELETE FROM push_tokens WHERE user_id = ? AND token NOT IN (
        SELECT token FROM push_tokens WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?
      )
    `).run(Number(userId), Number(userId), maxTokensPerUser());
    const previousUserId = prev && Number(prev.user_id) !== Number(userId) ? Number(prev.user_id) : null;
    return { previousUserId };
  });
}

/** Удаляет СВОЙ токен. true — удалён; чужой и несуществующий неразличимы (false). */
function remove(userId, token) {
  const res = getDatabase().prepare('DELETE FROM push_tokens WHERE user_id = ? AND token = ?').run(Number(userId), String(token));
  return Number(res.changes || 0) > 0;
}

/**
 * Выход: токены этого сеанса (jti) и, если назван, этого устройства. Сеанс
 * старого формата (без jti) не опознать по номеру — тогда снимаются токены
 * сотрудника, зарегистрированные без jti (на этом устройстве, если оно названо).
 */
function removeForLogout({ userId, jti = null, deviceId = null }) {
  const res = getDatabase().prepare(`
    DELETE FROM push_tokens
    WHERE user_id = ? AND (
      (? IS NOT NULL AND session_jti = ?)
      OR (? IS NOT NULL AND device_id = ?)
      OR (? IS NULL AND session_jti IS NULL AND (? IS NULL OR device_id = ?))
    )
  `).run(Number(userId), jti, jti, deviceId, deviceId, jti, deviceId, deviceId);
  return Number(res.changes || 0);
}

// Продлённые сеансы: старый jti → новый. Старый токен ещё действует паузу
// после продления, и регистрация, пришедшая с ним в эту паузу, должна
// привязаться к новому сеансу — иначе после паузы её строка считалась бы
// мёртвой, а выход новым токеном её бы не нашёл. В памяти, на 10 минут.
const REBIND_MEMORY_MS = 10 * 60 * 1000;
const rebound = new Map(); // oldJti -> { userId, newJti, at }

function currentJti(userId, jti) {
  let value = jti;
  for (let hops = 0; value && hops < 5; hops += 1) {
    const next = rebound.get(value);
    if (!next || next.userId !== Number(userId) || Date.now() - next.at > REBIND_MEMORY_MS) break;
    value = next.newJti;
  }
  return value || null;
}

/** Отвязка устройства: его токены — у сотрудника (userId) или у всех (администратор). */
function removeForDevice({ deviceId, userId = null }) {
  if (!deviceId) return 0;
  const db = getDatabase();
  const res = userId === null
    ? db.prepare('DELETE FROM push_tokens WHERE device_id = ?').run(String(deviceId))
    : db.prepare('DELETE FROM push_tokens WHERE device_id = ? AND user_id = ?').run(String(deviceId), Number(userId));
  return Number(res.changes || 0);
}

/** Продление токена сеанса: привязка переходит на новый jti. */
function rebindSession(userId, oldJti, newJti) {
  if (!oldJti || !newJti) return 0;
  const now = Date.now();
  for (const [key, entry] of rebound) if (now - entry.at > REBIND_MEMORY_MS) rebound.delete(key);
  rebound.set(oldJti, { userId: Number(userId), newJti, at: now });
  const res = getDatabase().prepare('UPDATE push_tokens SET session_jti = ? WHERE user_id = ? AND session_jti = ?')
    .run(newJti, Number(userId), oldJti);
  return Number(res.changes || 0);
}

function forUser(userId) {
  return getDatabase().prepare('SELECT * FROM push_tokens WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC').all(Number(userId));
}

function get(token) {
  return getDatabase().prepare('SELECT * FROM push_tokens WHERE token = ?').get(String(token)) || null;
}

function deleteToken(token) {
  getDatabase().prepare('DELETE FROM push_tokens WHERE token = ?').run(String(token));
}

/** Удаляет токен, только если он всё ещё принадлежит этому сотруднику. */
function deleteOwned(token, userId) {
  getDatabase().prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').run(String(token), Number(userId));
}

function deleteForUser(userId) {
  getDatabase().prepare('DELETE FROM push_tokens WHERE user_id = ?').run(Number(userId));
}

module.exports = {
  register,
  remove,
  removeForLogout,
  removeForDevice,
  rebindSession,
  currentJti,
  forUser,
  get,
  deleteToken,
  deleteOwned,
  deleteForUser,
  maxTokensPerUser,
  PLATFORMS,
  KINDS,
  ENVIRONMENTS
};
