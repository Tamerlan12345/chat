import test from 'node:test';
import assert from 'node:assert';
import {
  isSuperAdmin,
  isScopedAdmin,
  canOpenAdminConsole,
  canBroadcast,
  validateAdminPassword,
  formatPing,
  errorMessageFrom,
  readError,
  limitRows,
  resultColumns,
  createRequestSequence,
  toDepartmentId
} from '../src/renderer/src/lib/admin-access.mjs';

// Консоль показывала администратору подразделения кнопки суперадминистратора:
// клиент решал по role_id и имени «admin», а сервер — по флагам роли.

test('суперадминистратор определяется по флагам роли', () => {
  const user = { permissions: { is_admin: true } };
  assert.strictEqual(isSuperAdmin(user), true);
  assert.strictEqual(isScopedAdmin(user), false);
  assert.strictEqual(canOpenAdminConsole(user), true);
});

test('администратор подразделения не суперадминистратор, хоть и несёт is_admin', () => {
  const user = { permissions: { is_admin: true, is_scoped_admin: true } };
  assert.strictEqual(isSuperAdmin(user), false);
  assert.strictEqual(isScopedAdmin(user), true);
  assert.strictEqual(canOpenAdminConsole(user), true);
});

test('role_id и имя учётной записи прав не дают', () => {
  const user = { role_id: 1, username: 'admin', role_name: 'Суперадминистратор' };
  assert.strictEqual(isSuperAdmin(user), false);
  assert.strictEqual(canOpenAdminConsole(user), false);
  assert.strictEqual(isSuperAdmin(null), false);
});

test('оповещения публикует администратор или сотрудник с can_broadcast', () => {
  assert.strictEqual(canBroadcast({ permissions: { can_broadcast: true } }), true);
  assert.strictEqual(canBroadcast({ permissions: { is_admin: true } }), true);
  assert.strictEqual(canBroadcast({ permissions: { can_call: true } }), false);
  assert.strictEqual(canBroadcast(undefined), false);
});

test('пустой пароль — просьба сгенерировать, короткий — ошибка', () => {
  assert.strictEqual(validateAdminPassword(''), null);
  assert.strictEqual(validateAdminPassword(undefined), null);
  assert.match(validateAdminPassword('1234567'), /не короче 8/);
  assert.strictEqual(validateAdminPassword('12345678'), null);
});

test('неизвестный пинг показывается прочерком, а не « мс»', () => {
  assert.strictEqual(formatPing(null), '—');
  assert.strictEqual(formatPing(undefined), '—');
  assert.strictEqual(formatPing('abc'), '—');
  assert.strictEqual(formatPing(0), '0 мс');
  assert.strictEqual(formatPing(12.6), '13 мс');
});

test('текст ошибки берётся с сервера, иначе — по коду ответа', () => {
  assert.strictEqual(errorMessageFrom({ error: 'Этот сотрудник относится к другому подразделению' }, 400, 'x'),
    'Этот сотрудник относится к другому подразделению');
  assert.match(errorMessageFrom(null, 403, 'x'), /прав/);
  assert.match(errorMessageFrom({}, 401, 'x'), /Сессия/);
  assert.strictEqual(errorMessageFrom({ error: '  ' }, 500, 'запасной'), 'запасной');
});

test('ответ не в JSON не роняет разбор ошибки', async () => {
  const res = { status: 404, json: async () => { throw new SyntaxError('Unexpected token'); } };
  assert.strictEqual(await readError(res, 'Не удалось скачать копию'), 'Не удалось скачать копию');
});

test('огромная выборка обрезается для отрисовки, общее число сохраняется', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i }));
  const shown = limitRows(rows, 500);
  assert.strictEqual(shown.rows.length, 500);
  assert.strictEqual(shown.total, 1200);
  assert.strictEqual(shown.truncated, true);
  assert.deepStrictEqual(limitRows({ error: 'x' }, 500), { rows: [], total: 0, truncated: false });
  assert.strictEqual(limitRows(rows.slice(0, 3), 500).truncated, false);
});

test('колонки результата берутся из ответа или из первой строки', () => {
  assert.deepStrictEqual(resultColumns({ columns: ['a'], rows: [{ a: 1, b: 2 }] }), ['a']);
  assert.deepStrictEqual(resultColumns({ rows: [{ a: 1, b: 2 }] }), ['a', 'b']);
  assert.deepStrictEqual(resultColumns({ changes: 3 }), []);
  assert.deepStrictEqual(resultColumns(null), []);
});

test('учитывается только последний запрос', () => {
  const seq = createRequestSequence();
  const first = seq.next();
  const second = seq.next();
  assert.strictEqual(seq.isCurrent(first), false);
  assert.strictEqual(seq.isCurrent(second), true);
});

test('«Без подразделения» сохраняется как null, а не как первый отдел', () => {
  assert.strictEqual(toDepartmentId(''), null);
  assert.strictEqual(toDepartmentId(null), null);
  assert.strictEqual(toDepartmentId('abc'), null);
  assert.strictEqual(toDepartmentId('7'), 7);
  assert.strictEqual(toDepartmentId(3), 3);
});

test('httpError — русский текст отказа и код ответа (по 404 консоль перечитывает список)', async () => {
  const { httpError } = await import('../src/renderer/src/lib/admin-access.mjs');
  const err = httpError('Жалоба не найдена', 404);
  assert.ok(err instanceof Error);
  assert.strictEqual(err.message, 'Жалоба не найдена');
  assert.strictEqual(err.status, 404);
  assert.strictEqual(httpError('Нет связи с сервером').status, undefined);
});
