const test = require('node:test');
const assert = require('node:assert');

// Ревью (задача 7, находка №20): LEGACY_TOKEN_CUTOFF и DEVICE_SECRET_TTL_DAYS
// приходят из окружения оператора — опечатка не должна превращать проверку в
// fail-open (NaN-дата принимает старый токен вечно) или ронять claim с 500
// (NaN-дни при построении expiresAt). Config читает process.env один раз при
// первом require — на каждый сценарий модуль перезагружается заново, как и в
// test/ip-access.test.js.

function loadConfig(env = {}) {
  for (const key of ['LEGACY_TOKEN_CUTOFF', 'DEVICE_SECRET_TTL_DAYS']) delete process.env[key];
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
