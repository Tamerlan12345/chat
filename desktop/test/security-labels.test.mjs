import test from 'node:test';
import assert from 'node:assert';
import {
  AUDIT_ACTION_LABELS,
  actionLabel,
  auditActionOptions,
  severityLabel,
  normalizeSeverity,
  parseServerTime,
  sortAlerts,
  mergeAlerts,
  countUnacknowledged,
  formatDetails,
  summarizeDetails,
  checkStatusMeta,
  sortChecks,
  validateIceServersText,
  formatIceServersText
} from '../src/renderer/src/lib/security-labels.mjs';

test('действия журнала: подпись по-русски, неизвестное — как есть', () => {
  for (const action of ['login', 'login_failed', 'device_secret_claimed', 'db_query_executed', 'remote_desktop_file_sent', 'logout', 'audit_verified']) {
    assert.ok(/[а-яё]/i.test(actionLabel(action)), action);
  }
  assert.strictEqual(Object.keys(AUDIT_ACTION_LABELS).length, 34);
  assert.strictEqual(actionLabel('brand_new_action'), 'brand_new_action');
  assert.strictEqual(actionLabel(''), '—');
  assert.strictEqual(actionLabel('toString'), 'toString', 'свойства прототипа не подписи');
  const options = auditActionOptions();
  assert.strictEqual(options.length, 34);
  assert.ok(options.every((o, i) => i === 0 || options[i - 1].label.localeCompare(o.label, 'ru') <= 0));
});

test('серьёзность: подписи и неизвестное значение', () => {
  assert.strictEqual(severityLabel('critical'), 'Критично');
  assert.strictEqual(severityLabel('high'), 'Высокий');
  assert.strictEqual(normalizeSeverity('extreme'), 'medium');
});

test('время сервера без зоны считается UTC', () => {
  assert.strictEqual(parseServerTime('2026-09-17 10:00:00'), Date.UTC(2026, 8, 17, 10, 0, 0));
  assert.strictEqual(parseServerTime('2026-09-17T10:00:00.000Z'), Date.UTC(2026, 8, 17, 10, 0, 0));
  assert.strictEqual(parseServerTime('2026-09-17T15:00:00+05:00'), Date.UTC(2026, 8, 17, 10, 0, 0));
  assert.strictEqual(parseServerTime('мусор'), null);
  assert.strictEqual(parseServerTime(null), null);
});

test('оповещения: новые сверху, при равном времени — серьёзные выше', () => {
  const list = sortAlerts([
    { id: 1, severity: 'medium', created_at: '2026-09-17 10:00:00' },
    { id: 2, severity: 'critical', created_at: '2026-09-17 10:00:00' },
    { id: 3, severity: 'medium', created_at: '2026-09-17 11:00:00' }
  ]);
  assert.deepStrictEqual(list.map((a) => a.id), [3, 2, 1]);
});

test('оповещения из WebSocket сливаются без дублей и не теряют отметку', () => {
  const base = [{ id: 1, title: 'a', created_at: '2026-09-17 10:00:00', acknowledged_at: '2026-09-17 10:05:00' }];
  const merged = mergeAlerts(base, [
    { id: 1, title: 'a', created_at: '2026-09-17 10:00:00', acknowledged_at: null },
    { id: 2, title: 'b', created_at: '2026-09-17 12:00:00' },
    null
  ]);
  assert.deepStrictEqual(merged.map((a) => a.id), [2, 1]);
  assert.ok(merged[1].acknowledged_at, 'просмотренное не становится снова новым');
  assert.strictEqual(countUnacknowledged(merged), 1);
});

test('подробности — строки ключ: значение, без HTML-разбора', () => {
  const rows = formatDetails({ ip: '10.0.0.1', attempts: 12, nested: { a: 1 }, html: '<img src=x onerror=alert(1)>' });
  assert.deepStrictEqual(rows, [
    { key: 'ip', value: '10.0.0.1' },
    { key: 'attempts', value: '12' },
    { key: 'nested', value: '{"a":1}' },
    { key: 'html', value: '<img src=x onerror=alert(1)>' }
  ]);
  assert.deepStrictEqual(formatDetails(null), []);
  assert.deepStrictEqual(formatDetails('{"x":"y"}'), [{ key: 'x', value: 'y' }]);
  assert.deepStrictEqual(formatDetails('просто текст'), [{ key: 'текст', value: 'просто текст' }]);
  assert.strictEqual(formatDetails({ long: 'x'.repeat(900) })[0].value.length, 501);
  assert.strictEqual(summarizeDetails({ a: 'b', c: 'd' }), 'a: b; c: d');
  assert.ok(summarizeDetails({ a: 'x'.repeat(300) }, 50).length <= 50);
});

test('проверки состояния: значок и подпись у каждого статуса, проблемы — наверх', () => {
  assert.strictEqual(checkStatusMeta('ok').icon, 'circleCheck');
  assert.strictEqual(checkStatusMeta('fail').label, 'Проблема');
  assert.strictEqual(checkStatusMeta('weird').label, 'Внимание');
  const sorted = sortChecks([{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }, { id: 'c', status: 'fail' }, { id: 'd', status: 'ok' }]);
  assert.deepStrictEqual(sorted.map((c) => c.id), ['c', 'b', 'a', 'd']);
});

test('поле ICE-серверов: пусто — локальная сеть, мусор — понятная ошибка', () => {
  assert.deepStrictEqual(validateIceServersText('  '), { ok: true, value: '[]', servers: [] });
  assert.strictEqual(validateIceServersText('[]').value, '[]');
  const good = validateIceServersText('[{"urls":"turn:t.kz:3478","username":"u","credential":"p"}]');
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(JSON.parse(good.value), [{ urls: 'turn:t.kz:3478', username: 'u', credential: 'p' }]);
  assert.strictEqual(validateIceServersText('{oops').ok, false);
  assert.strictEqual(validateIceServersText('{"urls":"stun:a"}').ok, false);
  const bad = validateIceServersText('[{"urls":"stun:a.kz"},{"urls":"http://evil"}]');
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.error.startsWith('Запись 2'));
  assert.strictEqual(validateIceServersText('[{"urls":["stun:a.kz","javascript:x"]}]').ok, false, 'частично негодный список — ошибка');
  assert.strictEqual(formatIceServersText('[]'), '');
  assert.strictEqual(formatIceServersText([{ urls: 'stun:a' }]), '[\n  {\n    "urls": "stun:a"\n  }\n]');
  assert.strictEqual(formatIceServersText('{broken'), '{broken');
});
