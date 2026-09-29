import test from 'node:test';
import assert from 'node:assert';
import { postLoginWithRetry, retryDelayMs, RETRYABLE_LOGIN_CODES } from '../src/renderer/src/lib/login-retry.mjs';

// Клиент повторяет вход на 503 LOGIN_BUSY/PASSWORD_HASH_BUSY в пределах общего
// бюджета (~45 с) с экспоненциальной выдержкой и разбросом, соблюдая
// Retry-After; 429 (задержка) и 503 без нашего JSON не повторяются; отмена
// пользователем прекращает повтор (третий раунд проверки, пункт 4).

function makeRes(status, body, retryAfter, { badJson = false } = {}) {
  return {
    status,
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: async () => { if (badJson) throw new Error('not json'); return body; }
  };
}

test('retryDelayMs: не меньше Retry-After и экспоненты, с разбросом, в пределах потолка', () => {
  // attempt 0: экспонента 1000, Retry-After 2000 → база 2000, +до 50% разброса.
  const d0 = retryDelayMs('2', 0);
  assert.ok(d0 >= 2000 && d0 <= 3000, `${d0}`);
  // Экспонента растёт с номером попытки: attempt 3 → база ≥ 8000.
  const d3 = retryDelayMs(null, 3);
  assert.ok(d3 >= 8000 && d3 <= 12000, `${d3}`);
  // Потолок на одну паузу.
  assert.ok(retryDelayMs('999', 6) <= 12000);
  // Пол 0.5 с.
  assert.ok(retryDelayMs('0', 0) >= 500);
});

test('коды повтора — только LOGIN_BUSY и PASSWORD_HASH_BUSY', () => {
  assert.ok(RETRYABLE_LOGIN_CODES.has('LOGIN_BUSY'));
  assert.ok(RETRYABLE_LOGIN_CODES.has('PASSWORD_HASH_BUSY'));
  assert.ok(!RETRYABLE_LOGIN_CODES.has('ACCOUNT_THROTTLED'));
});

test('503 LOGIN_BUSY повторяется и в итоге входит', async () => {
  const seq = [
    makeRes(503, { error: 'busy', code: 'LOGIN_BUSY' }, '1'),
    makeRes(503, { error: 'busy', code: 'PASSWORD_HASH_BUSY' }, '2'),
    makeRes(200, { token: 'T', user: { id: 1 } })
  ];
  let calls = 0;
  const waits = [];
  const { res, data, cancelled } = await postLoginWithRetry({
    fetchImpl: async () => seq[calls++],
    sleep: async (ms) => waits.push(ms),
    url: 'https://x/api/auth/login',
    body: { username: 'u', password: 'p' },
    onRetry: () => {}
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.token, 'T');
  assert.strictEqual(cancelled, false);
  assert.strictEqual(calls, 3, 'две паузы, затем успех');
  assert.strictEqual(waits.length, 2);
});

test('бюджет ограничивает суммарное ожидание (~45 с) и в итоге отдаёт 503', async () => {
  let calls = 0;
  let total = 0;
  const { res, cancelled } = await postLoginWithRetry({
    fetchImpl: async () => { calls++; return makeRes(503, { code: 'LOGIN_BUSY' }, null); },
    sleep: async (ms) => { total += ms; },
    url: 'u', body: {}, budgetMs: 45000
  });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(cancelled, false);
  assert.ok(total <= 45000, `суммарное ожидание ${total} мс в пределах бюджета`);
  assert.ok(calls >= 2 && calls <= 12, `разумное число попыток: ${calls}`);
});

test('400 (неверный пароль) не повторяется', async () => {
  let calls = 0;
  const { res } = await postLoginWithRetry({
    fetchImpl: async () => { calls++; return makeRes(400, { error: 'Неверный логин или пароль' }); },
    sleep: async () => { throw new Error('спать не должны'); },
    url: 'u', body: {}
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(calls, 1);
});

test('429 ACCOUNT_THROTTLED не повторяется (это не «занят», а задержка)', async () => {
  let calls = 0;
  const { res } = await postLoginWithRetry({
    fetchImpl: async () => { calls++; return makeRes(429, { code: 'ACCOUNT_THROTTLED' }, '30'); },
    sleep: async () => {},
    url: 'u', body: {}
  });
  assert.strictEqual(res.status, 429);
  assert.strictEqual(calls, 1);
});

test('503 без нашего JSON (сбой прокси) не повторяется', async () => {
  let calls = 0;
  const { res } = await postLoginWithRetry({
    fetchImpl: async () => { calls++; return makeRes(503, null, '1', { badJson: true }); },
    sleep: async () => { throw new Error('спать не должны'); },
    url: 'u', body: {}
  });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(calls, 1, 'без валидного JSON-кода повтора нет');
});

test('отмена пользователем прекращает повтор', async () => {
  let calls = 0;
  let cancel = false;
  const { cancelled } = await postLoginWithRetry({
    fetchImpl: async () => { calls++; return makeRes(503, { code: 'LOGIN_BUSY' }, '1'); },
    sleep: async () => { cancel = true; }, // пользователь вмешался во время паузы
    url: 'u', body: {},
    shouldCancel: () => cancel
  });
  assert.strictEqual(cancelled, true);
  assert.strictEqual(calls, 1, 'после отмены новых запросов нет');
});
