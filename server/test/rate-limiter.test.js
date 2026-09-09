const test = require('node:test');
const assert = require('node:assert');

function loadLimiter() {
  delete require.cache[require.resolve('../src/services/rate-limiter')];
  return require('../src/services/rate-limiter').checkRateLimit;
}

test('пропускает ровно maxAttempts попыток, затем отказывает', () => {
  const checkRateLimit = loadLimiter();
  const opts = { maxAttempts: 5, windowMs: 60000 };

  for (let i = 1; i <= 5; i++) {
    assert.ok(checkRateLimit('login:203.0.113.9:admin', opts), `попытка ${i} должна пройти`);
  }
  assert.ok(!checkRateLimit('login:203.0.113.9:admin', opts), 'шестая должна быть отклонена');
});

test('ключи не пересекаются: блокировка одного не задевает другого', () => {
  // Сегодняшняя авария: ключ строился по адресу прокси, одинаковому у всех,
  // поэтому пятью попытками можно было закрыть вход вообще всем.
  const checkRateLimit = loadLimiter();
  const opts = { maxAttempts: 5, windowMs: 60000 };

  for (let i = 0; i < 5; i++) checkRateLimit('login:203.0.113.9:admin', opts);
  assert.ok(!checkRateLimit('login:203.0.113.9:admin', opts), 'первый клиент исчерпал лимит');

  assert.ok(
    checkRateLimit('login:198.51.100.7:admin', opts),
    'другой клиент с тем же логином должен входить свободно'
  );
  assert.ok(
    checkRateLimit('login:203.0.113.9:ivanov', opts),
    'тот же клиент с другим логином тоже не должен быть заблокирован'
  );
});

test('окно истекает по времени и счётчик обнуляется', async () => {
  const checkRateLimit = loadLimiter();
  const opts = { maxAttempts: 2, windowMs: 60 };

  assert.ok(checkRateLimit('k', opts));
  assert.ok(checkRateLimit('k', opts));
  assert.ok(!checkRateLimit('k', opts), 'лимит исчерпан внутри окна');

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(checkRateLimit('k', opts), 'после истечения окна доступ восстанавливается');
});

test('отказы не продлевают блокировку', () => {
  // Если бы отклонённые попытки продлевали окно, частые повторы держали бы
  // пользователя заблокированным бесконечно.
  const checkRateLimit = loadLimiter();
  const opts = { maxAttempts: 1, windowMs: 200 };

  assert.ok(checkRateLimit('k2', opts));
  const start = Date.now();
  while (Date.now() - start < 120) checkRateLimit('k2', opts); // непрерывные отказы

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.ok(checkRateLimit('k2', opts), 'окно должно истечь несмотря на поток отказов');
      resolve();
    }, 120);
  });
});
