const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  compareVersions,
  bucketOf,
  validatePolicy,
  decide,
  DEFAULT_POLICY
} = require('../src/services/update-policy.service');

// Политика раздачи: кому и какую версию предлагать. Корзина должна быть
// детерминированной (один и тот же компьютер не «мигает» между «есть
// обновление» и «нет»), равномерной (25% — это действительно четверть парка),
// а minVersion — обходить раздачу: устаревшие клиенты обязаны обновиться.

const releases = [{ version: '1.1.0' }, { version: '1.2.0' }, { version: '1.3.0-beta.1' }];

function policy(overrides = {}) {
  return {
    enabled: true,
    channels: {
      stable: { target: '1.2.0', rolloutPercent: 25 },
      beta: { target: '1.3.0-beta.1', rolloutPercent: 100 }
    },
    minVersion: null,
    checkIntervalMinutes: 240,
    message: null,
    ...overrides
  };
}

// Общие векторы с клиентским update-policy.js (Задача 9): оба сравнения
// обязаны давать одинаковый ответ, иначе сервер и клиент разойдутся в том,
// что считать «новее».
test('compareVersions: общие векторы с клиентом', () => {
  const vectors = [
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['1.2.0-beta.1', '1.2.0', -1],
    ['1.2.0-beta.2', '1.2.0-beta.10', -1],
    ['1.2.0', '1.2.0', 0]
  ];
  for (const [a, b, expected] of vectors) {
    assert.strictEqual(compareVersions(a, b), expected, `${a} vs ${b}`);
    assert.strictEqual(compareVersions(b, a), -expected || 0, `${b} vs ${a}`);
  }
});

test('compareVersions: правила пререлизов semver', () => {
  assert.strictEqual(compareVersions('1.2.0-alpha', '1.2.0-alpha.1'), -1);
  assert.strictEqual(compareVersions('1.2.0-alpha.1', '1.2.0-alpha.beta'), -1);
  assert.strictEqual(compareVersions('1.2.0-beta', '1.2.0-rc.1'), -1);
  assert.strictEqual(compareVersions('2.0.0', '10.0.0'), -1);
  // Неразборчивое значение меньше любого настоящего и равно другому такому же.
  assert.strictEqual(compareVersions('мусор', '0.0.1'), -1);
  assert.strictEqual(compareVersions('0.0.1', null), 1);
  assert.strictEqual(compareVersions(undefined, 'x'), 0);
});

test('bucketOf детерминирована и лежит в 0..99; без installId — 99', () => {
  const id = crypto.randomUUID();
  const b = bucketOf(id, '1.2.0');
  assert.ok(Number.isInteger(b) && b >= 0 && b < 100);
  assert.strictEqual(bucketOf(id, '1.2.0'), b);
  assert.strictEqual(bucketOf(id.toUpperCase(), '1.2.0'), b, 'регистр uuid не меняет корзину');

  const expected = crypto.createHash('sha256').update(`${id}:1.2.0`).digest().readUInt32BE(0) % 100;
  assert.strictEqual(b, expected, 'формула из спецификации');

  for (const bad of [undefined, null, '', 'не-uuid', '../../etc', `${id}x`]) {
    assert.strictEqual(bucketOf(bad, '1.2.0'), 99, String(bad));
  }
});

test('из 10 000 случайных id при 25% подходят 25% ± 3', () => {
  const p = policy();
  let eligible = 0;
  for (let i = 0; i < 10000; i += 1) {
    const d = decide({ channel: 'stable', installId: crypto.randomUUID(), clientVersion: '1.1.0', policy: p, releases });
    if (d.eligible) eligible += 1;
  }
  assert.ok(eligible >= 2200 && eligible <= 2800, `подошло ${eligible}`);
});

test('раздача 0 → только обход по minVersion; 100 → все', () => {
  const zero = policy({ channels: { stable: { target: '1.2.0', rolloutPercent: 0 }, beta: { target: null, rolloutPercent: 0 } }, minVersion: '1.1.0' });
  for (let i = 0; i < 200; i += 1) {
    const id = crypto.randomUUID();
    assert.strictEqual(decide({ channel: 'stable', installId: id, clientVersion: '1.1.0', policy: zero, releases }).eligible, false);
    const old = decide({ channel: 'stable', installId: id, clientVersion: '1.0.0', policy: zero, releases });
    assert.strictEqual(old.eligible, true, 'устаревший клиент обходит корзину');
    assert.strictEqual(old.mandatory, true);
  }

  const all = policy({ channels: { stable: { target: '1.2.0', rolloutPercent: 100 }, beta: { target: null, rolloutPercent: 0 } } });
  for (let i = 0; i < 200; i += 1) {
    assert.strictEqual(decide({ channel: 'stable', installId: crypto.randomUUID(), clientVersion: '1.1.0', policy: all, releases }).eligible, true);
  }
  // Без installId корзина 99 — при 100% всё равно подходит.
  assert.strictEqual(decide({ channel: 'stable', installId: null, clientVersion: '1.1.0', policy: all, releases }).eligible, true);
  const d = decide({ channel: 'stable', installId: null, clientVersion: '1.1.0', policy: policy(), releases });
  assert.strictEqual(d.eligible, false, 'без installId при 25% — нет');
});

test('minVersion обходит корзину и делает обновление обязательным', () => {
  const p = policy({ minVersion: '1.1.0', channels: { stable: { target: '1.2.0', rolloutPercent: 0 }, beta: { target: null, rolloutPercent: 0 } } });
  const d = decide({ channel: 'stable', installId: null, clientVersion: '1.0.9', policy: p, releases });
  assert.deepStrictEqual({ eligible: d.eligible, mandatory: d.mandatory, version: d.release?.version }, { eligible: true, mandatory: true, version: '1.2.0' });

  const same = decide({ channel: 'stable', installId: null, clientVersion: '1.1.0', policy: p, releases });
  assert.strictEqual(same.mandatory, false);
  assert.strictEqual(same.eligible, false);

  // Неизвестная версия клиента не делает обновление обязательным.
  const unknown = decide({ channel: 'stable', installId: null, clientVersion: null, policy: p, releases });
  assert.strictEqual(unknown.mandatory, false);
});

test('выключено (политика или env) → ничего', () => {
  const off = decide({ channel: 'stable', installId: crypto.randomUUID(), clientVersion: '1.0.0', policy: policy({ enabled: false, minVersion: '1.1.0' }), releases });
  assert.deepStrictEqual(off, { release: null, eligible: false, mandatory: false });

  const env = decide({ channel: 'stable', installId: crypto.randomUUID(), clientVersion: '1.0.0', policy: policy({ minVersion: '1.1.0' }), releases, disabledByEnv: true });
  assert.deepStrictEqual(env, { release: null, eligible: false, mandatory: false });

  const noTarget = decide({ channel: 'stable', installId: null, clientVersion: '1.0.0', policy: policy({ channels: { stable: { target: null, rolloutPercent: 100 }, beta: { target: null, rolloutPercent: 0 } } }), releases });
  assert.strictEqual(noTarget.release, null);
  assert.strictEqual(noTarget.eligible, false);

  const missingRelease = decide({ channel: 'stable', installId: null, clientVersion: '1.0.0', policy: policy({ channels: { stable: { target: '5.0.0', rolloutPercent: 100 }, beta: { target: null, rolloutPercent: 0 } } }), releases });
  assert.strictEqual(missingRelease.eligible, false);

  const badChannel = decide({ channel: '__proto__', installId: null, clientVersion: '1.0.0', policy: policy(), releases });
  assert.strictEqual(badChannel.eligible, false);
});

test('validatePolicy: верная политика нормализуется', () => {
  const clean = validatePolicy(policy({ minVersion: '1.1.0', message: 'Исправлена передача файлов' }), releases);
  assert.strictEqual(clean.enabled, true);
  assert.strictEqual(clean.channels.stable.target, '1.2.0');
  assert.strictEqual(clean.message, 'Исправлена передача файлов');

  const minimal = validatePolicy({ enabled: false }, releases);
  assert.deepStrictEqual(minimal, { ...DEFAULT_POLICY, enabled: false });
  assert.strictEqual(validatePolicy(policy({ message: '' }), releases).message, null);
});

test('validatePolicy: ошибки', () => {
  const cases = [
    [null, /политик/i],
    [[], /политик/i],
    [{ ...policy(), extra: 1 }, /extra/],
    [{ ...policy(), enabled: 'true' }, /enabled/],
    [policy({ channels: { stable: { target: '1.2', rolloutPercent: 25 } } }), /верси/i],
    [policy({ channels: { stable: { target: '9.9.9', rolloutPercent: 25 } } }), /9\.9\.9/],
    [policy({ channels: { stable: { target: '1.2.0', rolloutPercent: 25.5 } } }), /rolloutPercent/],
    [policy({ channels: { stable: { target: '1.2.0', rolloutPercent: 101 } } }), /rolloutPercent/],
    [policy({ channels: { stable: { target: '1.2.0', rolloutPercent: -1 } } }), /rolloutPercent/],
    [policy({ channels: { stable: { target: '1.2.0', rolloutPercent: '25' } } }), /rolloutPercent/],
    [policy({ channels: { nightly: { target: null, rolloutPercent: 0 } } }), /nightly/],
    [policy({ channels: { stable: { target: '1.2.0', rolloutPercent: 25, x: 1 } } }), /x/],
    [policy({ minVersion: '1.3.0' }), /minVersion/],
    [policy({ minVersion: '1.1.0', channels: { stable: { target: null, rolloutPercent: 0 } } }), /minVersion/],
    [policy({ minVersion: 'abc' }), /minVersion/],
    [policy({ checkIntervalMinutes: 29 }), /checkIntervalMinutes/],
    [policy({ checkIntervalMinutes: 1441 }), /checkIntervalMinutes/],
    [policy({ checkIntervalMinutes: 60.5 }), /checkIntervalMinutes/],
    [policy({ message: 'я'.repeat(501) }), /message/],
    [policy({ message: 42 }), /message/]
  ];
  for (const [draft, re] of cases) {
    assert.throws(() => validatePolicy(draft, releases), (err) => {
      assert.strictEqual(err.status, 400);
      assert.match(err.message, re);
      return true;
    }, JSON.stringify(draft));
  }
});
