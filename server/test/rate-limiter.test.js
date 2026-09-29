const test = require('node:test');
const assert = require('node:assert');

function loadLimiter() {
  delete require.cache[require.resolve('../src/services/rate-limiter')];
  return require('../src/services/rate-limiter').checkRateLimit;
}

function loadFullLimiter() {
  delete require.cache[require.resolve('../src/services/rate-limiter')];
  return require('../src/services/rate-limiter');
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

// ── Находка ревью (задача 7): очистка не должна снимать долгую блокировку
// раньше её собственного окна ────────────────────────────────────────────

test('очистка не снимает блокировку раньше её собственного windowMs, даже если это дольше старого фиксированного предела в 10 минут', () => {
  const { checkRateLimit, isRateLimited, pruneStaleBuckets } = loadFullLimiter();
  const opts = { maxAttempts: 1, windowMs: 15 * 60000 }; // как LOGIN_LOCKOUT_MINUTES=15 по умолчанию

  checkRateLimit('login-lock:1.2.3.4:admin', opts); // единственная попытка — бакет создан
  assert.ok(isRateLimited('login-lock:1.2.3.4:admin', opts), 'предпосылка: ключ заблокирован');

  // «Прошло» 12 минут — дольше прежнего фиксированного предела очистки (10
  // мин), но короче собственного 15-минутного окна этого бакета.
  pruneStaleBuckets(Date.now() + 12 * 60000);

  assert.ok(
    isRateLimited('login-lock:1.2.3.4:admin', opts),
    'блокировка не должна была сняться раньше своего 15-минутного окна'
  );
});

test('очистка удаляет бакет, как только его собственное окно истекло', () => {
  const { checkRateLimit, isRateLimited, pruneStaleBuckets } = loadFullLimiter();
  const opts = { maxAttempts: 1, windowMs: 5 * 60000 };

  checkRateLimit('short-window-key', opts);
  assert.ok(isRateLimited('short-window-key', opts));

  pruneStaleBuckets(Date.now() + 6 * 60000);

  // Бакет удалён очисткой — новая попытка создаёт его заново и снова проходит.
  assert.ok(checkRateLimit('short-window-key', opts), 'после истечения собственного окна бакет должен быть свободен');
});

test('resetLimit снимает накопленные неудачи по ключу (успешный вход сбрасывает счётчик)', () => {
  const { checkRateLimit, isRateLimited, resetLimit } = loadFullLimiter();
  const opts = { maxAttempts: 1, windowMs: 60000 };

  checkRateLimit('reset-me', opts);
  assert.ok(isRateLimited('reset-me', opts), 'предпосылка: ключ исчерпал лимит');

  resetLimit('reset-me');

  assert.ok(!isRateLimited('reset-me', opts), 'после resetLimit ключ обязан снова быть свободным');
  assert.ok(checkRateLimit('reset-me', opts), 'и пропускать новую попытку');
});
