import test from 'node:test';
import assert from 'node:assert';
import { postLoginWithRetry, retryDelayMs, RETRYABLE_LOGIN_CODES } from '../src/renderer/src/lib/login-retry.mjs';

// Проверка раунда 4, задача 4: клиент повторяет вход на 503 LOGIN_BUSY/
// PASSWORD_HASH_BUSY, соблюдая Retry-After (потолок ~5 с), до двух раз, и
// может быть отменён вмешательством пользователя.

function makeRes(status, body, retryAfter) {
  return {
    status,
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: async () => body
  };
}

test('retryDelayMs: Retry-After в пределах потолка, не короче 0.5 с', () => {
  assert.strictEqual(retryDelayMs('2', 5000), 2000);
  assert.strictEqual(retryDelayMs('99', 5000), 5000, 'обрезается по потолку');
  assert.strictEqual(retryDelayMs(null, 5000), 1000, 'без заголовка — 1 с');
  assert.strictEqual(retryDelayMs('0', 5000), 1000, '0/невалидное — запасная 1 с');
  assert.strictEqual(retryDelayMs('0.2', 5000), 500, 'валидное, но крошечное — не короче 0.5 с');
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
  assert.strictEqual(calls, 3, 'две попытки повтора, затем успех');
  assert.deepStrictEqual(waits, [1000, 2000]);
});

test('не больше двух повторов: третий 503 отдаётся как есть', async () => {
  let calls = 0;
  const { res, cancelled } = await postLoginWithRetry({
    fetchImpl: async () => { calls++; return makeRes(503, { code: 'LOGIN_BUSY' }, '1'); },
    sleep: async () => {},
    url: 'u', body: {}, maxRetries: 2
  });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(cancelled, false);
  assert.strictEqual(calls, 3, 'исходный запрос + два повтора');
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
