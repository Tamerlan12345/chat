import test from 'node:test';
import assert from 'node:assert';
import {
  validateAllowlistPattern,
  describeAllowlistEntry,
  allowlistErrorMessage,
  reportsPath,
  REPORT_FILTERS,
  reportStatusLabel,
  describeReportTarget,
  previewText,
  formatAdminDate
} from '../src/renderer/src/lib/registration-admin.mjs';

// Зеркало server/src/services/registration.service.js (normalizePattern):
// адрес user@domain.kz или домен @domain.kz, нижний регистр, до 254 символов.

test('validateAllowlistPattern — адрес и домен принимаются, регистр и пробелы нормализуются', () => {
  assert.deepStrictEqual(validateAllowlistPattern('  Ivan.Petrov@Company.KZ '), { ok: true, pattern: 'ivan.petrov@company.kz' });
  assert.deepStrictEqual(validateAllowlistPattern('@company.kz'), { ok: true, pattern: '@company.kz' });
  assert.deepStrictEqual(validateAllowlistPattern('a+tag@sub.company.co.uk'), { ok: true, pattern: 'a+tag@sub.company.co.uk' });
});

test('validateAllowlistPattern — то, что сервер отклонит, отклоняется сразу', () => {
  const bad = [
    '', '   ', 'company.kz', '@company', '@', 'ivan@', 'ivan@company', 'ivan@@company.kz',
    'ivan company@company.kz', '@-company.kz', '@company.k', '@company.kz,@other.kz',
    '*@company.kz', 'иван@company.kz', `${'a'.repeat(65)}@company.kz`, `@${'a'.repeat(250)}.kz`
  ];
  for (const value of bad) {
    const result = validateAllowlistPattern(value);
    assert.strictEqual(result.ok, false, `должно быть отклонено: ${JSON.stringify(value)}`);
    assert.match(result.error, /user@domain\.kz/);
  }
  assert.strictEqual(validateAllowlistPattern(undefined).ok, false);
  assert.strictEqual(validateAllowlistPattern(null).ok, false);
});

test('describeAllowlistEntry — домен или отдельный адрес', () => {
  assert.deepStrictEqual(describeAllowlistEntry('@company.kz'), { kind: 'domain', label: 'Весь домен', target: 'company.kz' });
  assert.deepStrictEqual(describeAllowlistEntry('ivan@company.kz'), { kind: 'address', label: 'Один адрес', target: 'ivan@company.kz' });
});

test('allowlistErrorMessage — ответ сервера по-русски, иначе понятная замена', () => {
  assert.strictEqual(allowlistErrorMessage({ error: 'Такая запись уже есть' }, 409), 'Такая запись уже есть');
  assert.strictEqual(allowlistErrorMessage({}, 409), 'Такая запись уже есть');
  assert.strictEqual(allowlistErrorMessage(null, 403), 'Недостаточно прав для этого действия');
  assert.strictEqual(allowlistErrorMessage(null, 500), 'Не удалось выполнить действие');
});

test('reportsPath — фильтр превращается в параметр сервера', () => {
  assert.strictEqual(reportsPath('open'), '/api/admin/reports?status=open');
  assert.strictEqual(reportsPath('closed'), '/api/admin/reports?status=closed');
  assert.strictEqual(reportsPath('all'), '/api/admin/reports');
  assert.strictEqual(reportsPath('что-то'), '/api/admin/reports?status=open');
  assert.deepStrictEqual(REPORT_FILTERS.map((f) => f.id), ['open', 'closed', 'all']);
});

test('reportStatusLabel и describeReportTarget', () => {
  assert.strictEqual(reportStatusLabel('open'), 'Открыта');
  assert.strictEqual(reportStatusLabel('closed'), 'Закрыта');
  assert.strictEqual(reportStatusLabel('???'), '???');
  assert.deepStrictEqual(
    describeReportTarget({ targetType: 'message', targetId: 41, reportedUser: { id: 3, name: 'Пётр' }, messageText: 'текст' }),
    { kind: 'Сообщение', who: 'Пётр', text: 'текст' }
  );
  assert.deepStrictEqual(
    describeReportTarget({ targetType: 'message', targetId: 41, reportedUser: { id: 3, name: 'Пётр' }, messageText: null }),
    { kind: 'Сообщение', who: 'Пётр', text: null }
  );
  assert.deepStrictEqual(
    describeReportTarget({ targetType: 'user', targetId: 3, reportedUser: { id: 3, name: 'Пётр' } }),
    { kind: 'Пользователь', who: 'Пётр', text: null }
  );
  assert.strictEqual(describeReportTarget({ targetType: 'user', targetId: 3, reportedUser: null }).who, 'Пользователь №3');
});

test('previewText — обрезает длинное и сворачивает переводы строк', () => {
  assert.strictEqual(previewText('коротко', 10), 'коротко');
  assert.strictEqual(previewText('а\n\nб', 10), 'а б');
  assert.strictEqual(previewText('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
  assert.strictEqual(previewText(null, 10), '');
});

test('formatAdminDate — дата по-русски, мусор даёт прочерк', () => {
  assert.strictEqual(formatAdminDate('2026-10-05T09:07:00.000Z', 'UTC'), '05.10.2026, 09:07');
  assert.strictEqual(formatAdminDate('', 'UTC'), '—');
  assert.strictEqual(formatAdminDate('не дата', 'UTC'), '—');
  assert.strictEqual(formatAdminDate(undefined, 'UTC'), '—');
});
