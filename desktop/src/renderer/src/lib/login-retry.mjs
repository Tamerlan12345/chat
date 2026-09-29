// Повтор входа при перегрузке сервера (проверка раунда 4, задача 4).
//
// Сервер под утренним наплывом входов отвечает 503 с кодом LOGIN_BUSY (занята
// очередь одновременных проверок с адреса) или PASSWORD_HASH_BUSY (переполнена
// очередь хэшей) и заголовком Retry-After. Это не отказ, а просьба повторить —
// заметки для администратора это обещают. Здесь — сама логика повтора, вынесена
// из компонента, чтобы её можно было проверить юнит-тестом (fetch и sleep
// внедряются).

export const RETRYABLE_LOGIN_CODES = new Set(['LOGIN_BUSY', 'PASSWORD_HASH_BUSY']);

const BASE_BACKOFF_MS = 1000;
const PER_WAIT_CAP_MS = 12000;

// Пауза до следующей попытки: не меньше того, что просит сервер (Retry-After),
// не меньше экспоненциальной выдержки (1, 2, 4… с) и с добавочным случайным
// разбросом до +50% — чтобы клиенты, отбитые одновременно, расходились во
// времени. Ограничена сверху PER_WAIT_CAP_MS.
export function retryDelayMs(retryAfterHeader, attempt = 0) {
  const secs = Number(retryAfterHeader);
  const serverMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
  const backoff = BASE_BACKOFF_MS * 2 ** Math.min(attempt, 6);
  const base = Math.max(serverMs, backoff);
  const jittered = base + Math.floor(Math.random() * base * 0.5);
  return Math.min(Math.max(jittered, 500), PER_WAIT_CAP_MS);
}

/**
 * POST /api/auth/login с автоповтором на 503 LOGIN_BUSY/PASSWORD_HASH_BUSY.
 * Повторяет, пока суммарное ожидание укладывается в бюджет (~45 с), с
 * экспоненциальной выдержкой и разбросом; 429 (задержка) и 503 без нашего
 * JSON-кода не повторяются.
 *
 * @param {object} opts
 * @param {function} opts.fetchImpl   как fetch(url, init)
 * @param {function} opts.sleep       (ms) => Promise
 * @param {string}   opts.url         полный адрес /api/auth/login
 * @param {object}   opts.body        тело запроса
 * @param {number}   [opts.budgetMs=45000]
 * @param {function} [opts.onRetry]   (attempt, waitMs) => void — показать «повторяю»
 * @param {function} [opts.shouldCancel] () => boolean — пользователь вмешался
 * @returns {Promise<{ res, data, cancelled }>}
 */
export async function postLoginWithRetry({
  fetchImpl, sleep, url, body, budgetMs = 45000, onRetry, shouldCancel
}) {
  let attempt = 0;
  let spent = 0;
  for (;;) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let data = {};
    let jsonOk = true;
    try { data = await res.json(); } catch { data = {}; jsonOk = false; }

    // Повтор — только на 503 с НАШИМ кодом занятости и валидным JSON. 429
    // (задержка/подбор) финально; 503 без JSON (сбой прокси) не повторяем.
    const retryable = res.status === 503 && jsonOk && RETRYABLE_LOGIN_CODES.has(data && data.code);
    if (!retryable) return { res, data, cancelled: false };
    if (shouldCancel && shouldCancel()) return { res, data, cancelled: true };

    const waitMs = retryDelayMs(res.headers && res.headers.get && res.headers.get('retry-after'), attempt);
    if (spent + waitMs > budgetMs) return { res, data, cancelled: false }; // бюджет исчерпан — отдаём 503
    attempt += 1;
    spent += waitMs;
    if (onRetry) onRetry(attempt, waitMs);
    await sleep(waitMs);
    if (shouldCancel && shouldCancel()) return { res, data, cancelled: true };
  }
}
