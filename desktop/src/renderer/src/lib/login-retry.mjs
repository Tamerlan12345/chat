// Повтор входа при перегрузке сервера (проверка раунда 4, задача 4).
//
// Сервер под утренним наплывом входов отвечает 503 с кодом LOGIN_BUSY (занята
// очередь одновременных проверок с адреса) или PASSWORD_HASH_BUSY (переполнена
// очередь хэшей) и заголовком Retry-After. Это не отказ, а просьба повторить —
// заметки для администратора это обещают. Здесь — сама логика повтора, вынесена
// из компонента, чтобы её можно было проверить юнит-тестом (fetch и sleep
// внедряются).

export const RETRYABLE_LOGIN_CODES = new Set(['LOGIN_BUSY', 'PASSWORD_HASH_BUSY']);

// Пауза до следующей попытки: Retry-After сервера, но не дольше потолка (по
// умолчанию 5 с), и не короче 0.5 с, чтобы не молотить сервер.
export function retryDelayMs(retryAfterHeader, capMs = 5000) {
  const secs = Number(retryAfterHeader);
  const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1000;
  return Math.min(Math.max(ms, 500), capMs);
}

/**
 * POST /api/auth/login с автоповтором на 503 LOGIN_BUSY/PASSWORD_HASH_BUSY.
 *
 * @param {object} opts
 * @param {function} opts.fetchImpl   как fetch(url, init)
 * @param {function} opts.sleep       (ms) => Promise
 * @param {string}   opts.url         полный адрес /api/auth/login
 * @param {object}   opts.body        тело запроса
 * @param {number}   [opts.maxRetries=2]
 * @param {number}   [opts.capMs=5000]
 * @param {function} [opts.onRetry]   (attempt, waitMs) => void — показать «повторяю»
 * @param {function} [opts.shouldCancel] () => boolean — пользователь вмешался
 * @returns {Promise<{ res, data, cancelled }>}
 */
export async function postLoginWithRetry({
  fetchImpl, sleep, url, body, maxRetries = 2, capMs = 5000, onRetry, shouldCancel
}) {
  let attempt = 0;
  for (;;) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    const retryable = res.status === 503 && RETRYABLE_LOGIN_CODES.has(data && data.code);
    if (!retryable || attempt >= maxRetries) {
      return { res, data, cancelled: false };
    }
    if (shouldCancel && shouldCancel()) return { res, data, cancelled: true };

    attempt += 1;
    const waitMs = retryDelayMs(res.headers && res.headers.get && res.headers.get('retry-after'), capMs);
    if (onRetry) onRetry(attempt, waitMs);
    await sleep(waitMs);
    if (shouldCancel && shouldCancel()) return { res, data, cancelled: true };
  }
}
