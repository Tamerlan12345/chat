const test = require('node:test');
const assert = require('node:assert');

// Ревью (задача 7, находка №20): LEGACY_TOKEN_CUTOFF и DEVICE_SECRET_TTL_DAYS
// приходят из окружения оператора — опечатка не должна превращать проверку в
// fail-open (NaN-дата принимает старый токен вечно) или ронять claim с 500
// (NaN-дни при построении expiresAt). Config читает process.env один раз при
// первом require — на каждый сценарий модуль перезагружается заново, как и в
// test/ip-access.test.js.

// Аудит, раунд 4 (Р4-07 и новые переменные): пределы защиты от подбора.
const ROUND4_KEYS = [
  'LOGIN_MAX_FAILED_ATTEMPTS', 'LOGIN_LOCKOUT_MINUTES', 'LOGIN_ACCOUNT_SOFT_LIMIT',
  'LOGIN_ACCOUNT_MAX_DELAY_SECONDS', 'PASSWORD_HASH_CONCURRENCY', 'ANON_RATE_LIMIT_PER_MINUTE',
  'UPLOAD_MAX_MB_PER_HOUR', 'UPLOAD_MIN_FREE_DISK_MB'
];

function loadConfig(env = {}) {
  for (const key of ['LEGACY_TOKEN_CUTOFF', 'DEVICE_SECRET_TTL_DAYS', ...ROUND4_KEYS]) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/config')];
  return require('../src/config');
}

test('нераспознаваемый LEGACY_TOKEN_CUTOFF откатывается к дате по умолчанию, а не к NaN (fail-open)', () => {
  const config = loadConfig({ LEGACY_TOKEN_CUTOFF: 'вот-это-не-дата' });
  assert.ok(
    !Number.isNaN(new Date(config.LEGACY_TOKEN_CUTOFF).getTime()),
    'значение обязано быть корректной датой'
  );
  assert.notStrictEqual(config.LEGACY_TOKEN_CUTOFF, 'вот-это-не-дата');
});

test('пустой LEGACY_TOKEN_CUTOFF тоже откатывается к значению по умолчанию', () => {
  const config = loadConfig({ LEGACY_TOKEN_CUTOFF: '' });
  assert.ok(!Number.isNaN(new Date(config.LEGACY_TOKEN_CUTOFF).getTime()));
});

test('корректный LEGACY_TOKEN_CUTOFF используется как задано оператором', () => {
  const config = loadConfig({ LEGACY_TOKEN_CUTOFF: '2030-01-01T00:00:00Z' });
  assert.strictEqual(config.LEGACY_TOKEN_CUTOFF, '2030-01-01T00:00:00Z');
});

test('нечисловой DEVICE_SECRET_TTL_DAYS откатывается к 30, а не к NaN (иначе claim падает с 500)', () => {
  const config = loadConfig({ DEVICE_SECRET_TTL_DAYS: 'abc' });
  assert.strictEqual(config.DEVICE_SECRET_TTL_DAYS, 30);
});

test('отрицательный или нулевой DEVICE_SECRET_TTL_DAYS тоже откатывается к 30', () => {
  assert.strictEqual(loadConfig({ DEVICE_SECRET_TTL_DAYS: '-5' }).DEVICE_SECRET_TTL_DAYS, 30);
  assert.strictEqual(loadConfig({ DEVICE_SECRET_TTL_DAYS: '0' }).DEVICE_SECRET_TTL_DAYS, 30);
});

test('корректный DEVICE_SECRET_TTL_DAYS используется как задано оператором', () => {
  const config = loadConfig({ DEVICE_SECRET_TTL_DAYS: '10' });
  assert.strictEqual(config.DEVICE_SECRET_TTL_DAYS, 10);
});

// ── Раунд 4, находка Р4-07: пределы входа не превращаются в NaN ─────────────

test('нечисловые LOGIN_MAX_FAILED_ATTEMPTS / LOGIN_LOCKOUT_MINUTES откатываются к 10 и 15, а не к NaN (fail-open)', () => {
  const config = loadConfig({ LOGIN_MAX_FAILED_ATTEMPTS: 'abc', LOGIN_LOCKOUT_MINUTES: '15m' });
  assert.strictEqual(config.LOGIN_MAX_FAILED_ATTEMPTS, 10);
  assert.strictEqual(config.LOGIN_LOCKOUT_MINUTES, 15);
});

test('нулевые и отрицательные пределы входа тоже откатываются к значениям по умолчанию', () => {
  const config = loadConfig({ LOGIN_MAX_FAILED_ATTEMPTS: '0', LOGIN_LOCKOUT_MINUTES: '-3', LOGIN_ACCOUNT_SOFT_LIMIT: '1' });
  assert.strictEqual(config.LOGIN_MAX_FAILED_ATTEMPTS, 10);
  assert.strictEqual(config.LOGIN_LOCKOUT_MINUTES, 15);
  assert.strictEqual(config.LOGIN_ACCOUNT_SOFT_LIMIT, 20, 'порог 1 бессмыслен — задержка с первой же опечатки');
});

test('новые переменные раунда 4: значения по умолчанию', () => {
  const config = loadConfig();
  assert.strictEqual(config.LOGIN_ACCOUNT_SOFT_LIMIT, 20);
  assert.strictEqual(config.LOGIN_ACCOUNT_MAX_DELAY_SECONDS, 60);
  assert.strictEqual(config.PASSWORD_HASH_CONCURRENCY, 2);
  assert.strictEqual(config.ANON_RATE_LIMIT_PER_MINUTE, 12000);
  assert.strictEqual(config.UPLOAD_MAX_MB_PER_HOUR, 2048);
  assert.strictEqual(config.UPLOAD_MIN_FREE_DISK_MB, 1024);
});

test('проверка раунда 4: пол потолка анонимных запросов (1..599 → умолчание, 0 — выключено, ≥600 — как задано)', () => {
  assert.strictEqual(loadConfig({ ANON_RATE_LIMIT_PER_MINUTE: '50' }).ANON_RATE_LIMIT_PER_MINUTE, 12000, 'ниже пола — умолчание');
  assert.strictEqual(loadConfig({ ANON_RATE_LIMIT_PER_MINUTE: '0' }).ANON_RATE_LIMIT_PER_MINUTE, 0, '0 — выключено');
  assert.strictEqual(loadConfig({ ANON_RATE_LIMIT_PER_MINUTE: '600' }).ANON_RATE_LIMIT_PER_MINUTE, 600);
  assert.strictEqual(loadConfig({ ANON_RATE_LIMIT_PER_MINUTE: '20000' }).ANON_RATE_LIMIT_PER_MINUTE, 20000);
});

test('проверка раунда 4 (M5): LOGIN_ACCOUNT_SOFT_LIMIT ниже LOGIN_MAX_FAILED_ATTEMPTS откатывается к умолчаниям', () => {
  const bad = loadConfig({ LOGIN_MAX_FAILED_ATTEMPTS: '30', LOGIN_ACCOUNT_SOFT_LIMIT: '10' });
  assert.strictEqual(bad.LOGIN_MAX_FAILED_ATTEMPTS, 10);
  assert.strictEqual(bad.LOGIN_ACCOUNT_SOFT_LIMIT, 20);
  const ok = loadConfig({ LOGIN_MAX_FAILED_ATTEMPTS: '8', LOGIN_ACCOUNT_SOFT_LIMIT: '25' });
  assert.strictEqual(ok.LOGIN_MAX_FAILED_ATTEMPTS, 8);
  assert.strictEqual(ok.LOGIN_ACCOUNT_SOFT_LIMIT, 25);
});

test('новые переменные раунда 4: корректные значения принимаются, вне диапазона — по умолчанию', () => {
  const ok = loadConfig({
    LOGIN_ACCOUNT_SOFT_LIMIT: '50', LOGIN_ACCOUNT_MAX_DELAY_SECONDS: '300', PASSWORD_HASH_CONCURRENCY: '4',
    ANON_RATE_LIMIT_PER_MINUTE: '0', UPLOAD_MAX_MB_PER_HOUR: '0'
  });
  assert.strictEqual(ok.LOGIN_ACCOUNT_SOFT_LIMIT, 50);
  assert.strictEqual(ok.LOGIN_ACCOUNT_MAX_DELAY_SECONDS, 300);
  assert.strictEqual(ok.PASSWORD_HASH_CONCURRENCY, 4);
  assert.strictEqual(ok.ANON_RATE_LIMIT_PER_MINUTE, 0, '0 — потолок выключен осознанно');
  assert.strictEqual(ok.UPLOAD_MAX_MB_PER_HOUR, 0, '0 — без предела осознанно');

  const bad = loadConfig({
    LOGIN_ACCOUNT_MAX_DELAY_SECONDS: '99999', PASSWORD_HASH_CONCURRENCY: '64',
    UPLOAD_MAX_MB_PER_HOUR: 'много'
  });
  assert.strictEqual(bad.LOGIN_ACCOUNT_MAX_DELAY_SECONDS, 60);
  assert.strictEqual(bad.PASSWORD_HASH_CONCURRENCY, 2);
  assert.strictEqual(bad.UPLOAD_MAX_MB_PER_HOUR, 2048);
});
