import test from 'node:test';
import assert from 'node:assert';
import { compareVersions, describeRollout, validatePolicyDraft } from '../src/renderer/src/lib/update-admin.mjs';

// Задача 10: помощники вкладки «Обновления» консоли администратора
// (components/UpdatesAdmin.jsx). validatePolicyDraft зеркалит
// server/src/services/update-policy.service.js — общий алгоритм с сервером
// и с главным процессом клиента, общие тестовые векторы.

test('compareVersions — общие векторы', () => {
  const vectors = [
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['1.2.0-beta.1', '1.2.0', -1],
    ['1.2.0-beta.2', '1.2.0-beta.10', -1],
    ['1.2.0', '1.2.0', 0]
  ];
  for (const [a, b, expected] of vectors) {
    assert.strictEqual(compareVersions(a, b), expected, `${a} vs ${b}`);
  }
});

test('compareVersions — неразборчивые строки не бросают исключение', () => {
  assert.strictEqual(compareVersions('мусор', '1.0.0'), -1);
  assert.strictEqual(compareVersions('1.0.0', 'мусор'), 1);
  assert.strictEqual(compareVersions('мусор', 'мусор'), 0);
});

test('describeRollout(25) содержит «25%»', () => {
  assert.match(describeRollout(25), /25%/);
});

test('describeRollout — 0% и 100% особые случаи', () => {
  assert.match(describeRollout(0), /0%/);
  assert.match(describeRollout(100), /100%/);
});

const RELEASES = [{ version: '1.1.0' }, { version: '1.2.0' }];

test('validatePolicyDraft — корректный черновик не даёт ошибок', () => {
  const draft = {
    enabled: true,
    channels: { stable: { target: '1.2.0', rolloutPercent: 25 }, beta: { target: null, rolloutPercent: 0 } },
    minVersion: '1.1.0',
    checkIntervalMinutes: 240,
    message: 'Плановое обновление'
  };
  assert.deepStrictEqual(validatePolicyDraft(draft, RELEASES), []);
});

test('validatePolicyDraft — minVersion больше target', () => {
  const problems = validatePolicyDraft(
    { channels: { stable: { target: '1.1.0', rolloutPercent: 10 } }, minVersion: '1.2.0' },
    RELEASES
  );
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => /minVersion/.test(p)));
});

test('validatePolicyDraft — раздача вне 0..100', () => {
  for (const bad of [-1, 101, 50.5, '50']) {
    const problems = validatePolicyDraft({ channels: { stable: { target: '1.1.0', rolloutPercent: bad } } }, RELEASES);
    assert.ok(problems.length > 0, `rolloutPercent=${bad}`);
    assert.ok(problems.some((p) => /rolloutPercent/.test(p)), `rolloutPercent=${bad}`);
  }
});

test('validatePolicyDraft — неизвестный target', () => {
  const problems = validatePolicyDraft({ channels: { stable: { target: '9.9.9', rolloutPercent: 10 } } }, RELEASES);
  assert.ok(problems.some((p) => /не найдена среди загруженных релизов/.test(p)));
});

test('validatePolicyDraft — target без списка релизов не проверяется на существование', () => {
  const problems = validatePolicyDraft({ channels: { stable: { target: '9.9.9', rolloutPercent: 10 } } }, null);
  assert.deepStrictEqual(problems, []);
});

test('validatePolicyDraft — интервал вне 30..1440', () => {
  for (const bad of [29, 1441, 60.5]) {
    const problems = validatePolicyDraft({ checkIntervalMinutes: bad }, RELEASES);
    assert.ok(problems.some((p) => /checkIntervalMinutes/.test(p)), `interval=${bad}`);
  }
});

test('validatePolicyDraft — неизвестное поле политики', () => {
  const problems = validatePolicyDraft({ enabled: true, extra: 1 }, RELEASES);
  assert.ok(problems.some((p) => /Неизвестное поле/.test(p)));
});

test('validatePolicyDraft — не объект', () => {
  assert.ok(validatePolicyDraft(null, RELEASES).length > 0);
  assert.ok(validatePolicyDraft('x', RELEASES).length > 0);
});
