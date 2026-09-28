const { identity } = require('../db/identity');

// Учёт установленных клиентов: какая версия, как установлена, какая ошибка
// обновления была последней. Нужен администратору, чтобы видеть, как идёт
// раздача, — и ничего больше: installId случаен и с человеком не связан.
//
// Маршруты /updates открыты без входа, поэтому запись ограничена со всех
// сторон: не чаще раза в 10 минут на installId (учёт в памяти), не больше
// 50 000 строк (новые id сверх — не записываются), очередь записи конечна,
// строки старше 90 дней удаляются при запуске.

const THROTTLE_MS = 10 * 60 * 1000;
const MAX_ROWS = 50000;
const RETENTION_DAYS = 90;
const MAX_PENDING = 1000;

function createInstallRecorder({ throttleMs = THROTTLE_MS, maxRows = MAX_ROWS, maxTracked = 100000, now = () => Date.now() } = {}) {
  const lastWrite = new Map();
  let queue = Promise.resolve();
  let pending = 0;

  function forgetStale(t) {
    for (const [id, at] of lastWrite) {
      if (t - at >= throttleMs) lastWrite.delete(id);
    }
    if (lastWrite.size >= maxTracked) lastWrite.clear();
  }

  async function write(entry, at) {
    const db = identity();
    const values = [entry.clientVersion, entry.kind, entry.channel, entry.ip, entry.lastError, at];
    const updated = await db.run(
      `UPDATE client_installs
          SET client_version = $1, install_kind = $2, channel = $3, ip_address = $4, last_error = $5, last_check_at = $6
        WHERE install_id = $7`,
      [...values, entry.installId]
    );
    if (Number(updated?.changes) > 0) return;
    const count = await db.get('SELECT COUNT(*) AS n FROM client_installs');
    if (Number(count?.n) >= maxRows) return;
    await db.run(
      `INSERT INTO client_installs
         (install_id, client_version, install_kind, channel, ip_address, last_error, first_seen_at, last_check_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (install_id) DO NOTHING`,
      [entry.installId, entry.clientVersion, entry.kind, entry.channel, entry.ip, entry.lastError, at]
    );
  }

  /**
   * Ставит запись в очередь, если этот installId не отмечался последние
   * throttleMs. Ничего не ждёт: ответ клиенту от учёта не зависит.
   */
  function record(entry) {
    if (!entry?.installId) return false;
    const t = now();
    const prev = lastWrite.get(entry.installId);
    if (prev !== undefined && t - prev < throttleMs) return false;
    if (pending >= MAX_PENDING) return false;
    if (lastWrite.size >= maxTracked) forgetStale(t);
    lastWrite.set(entry.installId, t);

    const clean = {
      installId: entry.installId,
      clientVersion: entry.clientVersion ?? null,
      kind: entry.kind ?? null,
      channel: entry.channel ?? null,
      ip: entry.ip ? String(entry.ip).slice(0, 64) : null,
      lastError: entry.lastError ?? null
    };
    pending += 1;
    queue = queue
      .then(() => write(clean, new Date(t).toISOString()))
      .catch((err) => console.warn('[Updates] учёт установки не записан:', err.message))
      .finally(() => {
        pending -= 1;
      });
    return true;
  }

  return { record, idle: () => queue };
}

async function pruneClientInstalls({ days = RETENTION_DAYS } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = await identity().run('DELETE FROM client_installs WHERE last_check_at < $1', [cutoff]);
  const removed = Number(result?.changes || 0);
  if (removed) console.log(`[DB] Удалено устаревших записей об установках клиента: ${removed}`);
  return removed;
}

async function groupCount(column, where = '') {
  const rows = await identity().all(
    `SELECT ${column} AS k, COUNT(*) AS n FROM client_installs ${where} GROUP BY ${column}`
  );
  const out = {};
  for (const row of rows) out[row.k ?? 'unknown'] = Number(row.n);
  return out;
}

/** Сводка по парку для консоли администратора. */
async function fleetSummary() {
  const total = await identity().get('SELECT COUNT(*) AS n FROM client_installs');
  return {
    total: Number(total?.n || 0),
    byVersion: await groupCount('client_version'),
    byKind: await groupCount('install_kind'),
    errors: await groupCount('last_error', 'WHERE last_error IS NOT NULL')
  };
}

module.exports = { createInstallRecorder, pruneClientInstalls, fleetSummary, THROTTLE_MS, MAX_ROWS };
