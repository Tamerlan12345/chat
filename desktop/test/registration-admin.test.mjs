import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const here = path.dirname(fileURLToPath(import.meta.url));

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

// ── Fix wave (Task 11) ─────────────────────────────────────────────────────

test('reportReasonLabel — коды причин с телефонов показываются по-русски, как в iOS', async () => {
  const { reportReasonLabel } = await import('../src/renderer/src/lib/registration-admin.mjs');
  assert.strictEqual(reportReasonLabel('spam'), 'Спам или реклама');
  assert.strictEqual(reportReasonLabel('abuse'), 'Оскорбления или травля');
  assert.strictEqual(reportReasonLabel('inappropriate'), 'Недопустимое содержимое');
  assert.strictEqual(reportReasonLabel('threat'), 'Угрозы или опасные действия');
  assert.strictEqual(reportReasonLabel('other'), 'Другое');
  assert.strictEqual(reportReasonLabel(' SPAM '), 'Спам или реклама', 'регистр и пробелы не мешают');
});

test('reportReasonLabel — свободный текст старых клиентов показывается как есть, пустое — прочерк', async () => {
  const { reportReasonLabel } = await import('../src/renderer/src/lib/registration-admin.mjs');
  assert.strictEqual(reportReasonLabel('Хамит в общем канале'), 'Хамит в общем канале');
  assert.strictEqual(reportReasonLabel('constructor'), 'constructor', 'не наследуемые свойства объекта');
  assert.strictEqual(reportReasonLabel(''), '—');
  assert.strictEqual(reportReasonLabel(null), '—');
  assert.strictEqual(reportReasonLabel(undefined), '—');
});

test('reporterName — автор жалобы без имени показывается прочерком, а не «undefined»', async () => {
  const { reporterName } = await import('../src/renderer/src/lib/registration-admin.mjs');
  assert.strictEqual(reporterName({ reporter: { name: 'Анна' } }), 'Анна');
  assert.strictEqual(reporterName({ reporter: null }), '—');
  assert.strictEqual(reporterName({}), '—');
});

test('allowlistErrorMessage — без тела ответа берётся текст конкретного действия (загрузка, удаление)', () => {
  assert.strictEqual(
    allowlistErrorMessage(null, 500, 'Не удалось загрузить список разрешённых адресов'),
    'Не удалось загрузить список разрешённых адресов'
  );
  assert.strictEqual(allowlistErrorMessage({}, 502, 'Не удалось убрать запись'), 'Не удалось убрать запись');
  assert.strictEqual(allowlistErrorMessage({ error: 'Запись не найдена' }, 404, 'Не удалось убрать запись'), 'Запись не найдена');
  assert.strictEqual(allowlistErrorMessage(null, 403, 'Не удалось убрать запись'), 'Недостаточно прав для этого действия');
  assert.strictEqual(allowlistErrorMessage(null, 500), 'Не удалось выполнить действие', 'без текста действия — общий');
});

test('useAdminApi передаёт explain текст действия (fallback), иначе он терялся', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', 'components', 'useAdminApi.js'), 'utf8');
  assert.match(src, /\(data, res\.status, fallback\)/);
});

test('сводка «Жалобы» показывает причину через reportReasonLabel, а автора — через reporterName', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', 'components', 'ReportsAdmin.jsx'), 'utf8');
  assert.ok(!/\{report\.reason\}/.test(src), 'сырой код причины не выводится');
  assert.match(src, /reportReasonLabel\(report\.reason\)/);
  assert.ok(!/report\.reporter\?\.name/.test(src), 'имя автора — только через reporterName');
});

test('шаблон адреса совпадает с сервером (ALLOWLIST_PATTERN_RE) — без дрейфа', async () => {
  const { ALLOWLIST_PATTERN_SOURCE } = await import('../src/renderer/src/lib/registration-admin.mjs');
  const server = fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'services', 'registration.service.js'), 'utf8');
  const match = server.match(/const ALLOWLIST_PATTERN_RE = \/(.+)\/;\r?\n/);
  assert.ok(match, 'на сервере найден ALLOWLIST_PATTERN_RE');
  assert.strictEqual(ALLOWLIST_PATTERN_SOURCE, match[1]);
});

// ── Решение Q: allow_registration — главный выключатель самостоятельной
// регистрации (и формой с компьютера, и кодом из письма с телефона; выключен —
// сервер отвечает 403 REGISTRATION_DISABLED). Консоль говорит ровно это.

test('тексты выключателя регистрации говорят правду о решении Q', async () => {
  const { REGISTRATION_SWITCH } = await import('../src/renderer/src/lib/registration-admin.mjs');
  assert.strictEqual(REGISTRATION_SWITCH.label, 'Самостоятельная регистрация сотрудников');
  assert.match(REGISTRATION_SWITCH.hint, /кодом из письма/);
  assert.match(REGISTRATION_SWITCH.hint, /«Разрешённые адреса»/);
  assert.match(REGISTRATION_SWITCH.offTitle, /выключена/);
  assert.match(REGISTRATION_SWITCH.offBody, /ни с компьютера, ни с телефона/);
  assert.match(REGISTRATION_SWITCH.offBody, /в том числе с адресов из списка «Разрешённые адреса»/);
  assert.match(REGISTRATION_SWITCH.offBody, /разделе «Настройки»/);
  assert.match(REGISTRATION_SWITCH.allowlistOff, /не действует/);
});

test('консоль: в «Настройках» есть выключатель allow_registration; «Заявки» и «Разрешённые адреса» берут тексты из REGISTRATION_SWITCH', () => {
  const modal = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', 'components', 'AdminUserModal.jsx'), 'utf8');
  assert.match(modal, /allow_registration: e\.target\.checked \? 'true' : 'false'/, 'галочка в «Настройках»');
  assert.match(modal, /REGISTRATION_SWITCH\.offTitle/);
  assert.ok(!/новых заявок не появится/.test(modal), 'прежний текст убран');
  assert.match(modal, /<RegistrationAllowlistAdmin[^>]*allowRegistration=\{sysSettings\.allow_registration === 'true' \|\| !settingsLoaded\}/);
  const allowlist = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', 'components', 'RegistrationAllowlistAdmin.jsx'), 'utf8');
  assert.match(allowlist, /!allowRegistration && [\s\S]{0,200}REGISTRATION_SWITCH\.allowlistOff/);
});
