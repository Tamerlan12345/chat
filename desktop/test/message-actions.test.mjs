import test from 'node:test';
import assert from 'node:assert';
import { canEdit, canDelete, applyUpdate, applyDelete, isValidMessageWindowValue } from '../src/renderer/src/lib/message-actions.mjs';

// Правила «можно ли редактировать/удалить своё сообщение», по которым клиент
// решает, показывать ли пункт меню. Сервер (MessageService.editMessage/
// deleteMessage) проверяет то же самое ещё раз, поэтому ошибка здесь —
// не дыра в безопасности, а лишний пункт в меню, который отклонят.

const ME = 1;
const OTHER = 2;
const NOW = new Date('2026-09-28T12:00:00.000Z').getTime();

function msg(overrides = {}) {
  return {
    id: 1,
    sender_id: ME,
    type: 'text',
    is_deleted: 0,
    created_at: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 минут назад
    text: 'исходный текст',
    ...overrides
  };
}

test('canEdit: чужое сообщение — false', () => {
  assert.strictEqual(canEdit(msg({ sender_id: OTHER }), { me: ME, now: NOW, windowMin: 60 }), false);
});

test('canEdit: удалённое сообщение — false', () => {
  assert.strictEqual(canEdit(msg({ is_deleted: 1 }), { me: ME, now: NOW, windowMin: 60 }), false);
});

test('canEdit: не текстовое сообщение — false', () => {
  assert.strictEqual(canEdit(msg({ type: 'file' }), { me: ME, now: NOW, windowMin: 60 }), false);
});

test('canEdit: время истекло — false', () => {
  const old = msg({ created_at: new Date(NOW - 90 * 60 * 1000).toISOString() });
  assert.strictEqual(canEdit(old, { me: ME, now: NOW, windowMin: 60 }), false);
});

test('canEdit: окно -1 — false, даже для только что отправленного', () => {
  const fresh = msg({ created_at: new Date(NOW - 1000).toISOString() });
  assert.strictEqual(canEdit(fresh, { me: ME, now: NOW, windowMin: -1 }), false);
});

test('canEdit: окно 0 — true без ограничения по времени', () => {
  const old = msg({ created_at: new Date(NOW - 10 * 24 * 3600 * 1000).toISOString() });
  assert.strictEqual(canEdit(old, { me: ME, now: NOW, windowMin: 0 }), true);
});

test('canEdit: своё текстовое, не удалённое, в пределах окна — true', () => {
  assert.strictEqual(canEdit(msg(), { me: ME, now: NOW, windowMin: 60 }), true);
});

test('canDelete: чужое сообщение — false', () => {
  assert.strictEqual(canDelete(msg({ sender_id: OTHER }), { me: ME, now: NOW, windowMin: 60 }), false);
});

test('canDelete: уже удалённое — false', () => {
  assert.strictEqual(canDelete(msg({ is_deleted: 1 }), { me: ME, now: NOW, windowMin: 60 }), false);
});

test('canDelete: время истекло — false', () => {
  const old = msg({ created_at: new Date(NOW - 90 * 60 * 1000).toISOString() });
  assert.strictEqual(canDelete(old, { me: ME, now: NOW, windowMin: 60 }), false);
});

test('canDelete: окно -1 — false', () => {
  assert.strictEqual(canDelete(msg(), { me: ME, now: NOW, windowMin: -1 }), false);
});

test('canDelete: окно 0 — true без ограничения по времени', () => {
  const old = msg({ created_at: new Date(NOW - 10 * 24 * 3600 * 1000).toISOString() });
  assert.strictEqual(canDelete(old, { me: ME, now: NOW, windowMin: 0 }), true);
});

test('canDelete: своё сообщение (не обязательно текстовое) в пределах окна — true', () => {
  assert.strictEqual(canDelete(msg({ type: 'file' }), { me: ME, now: NOW, windowMin: 60 }), true);
});

test('applyUpdate: заменяет сообщение по id, остальные не трогает', () => {
  const list = [msg({ id: 1, text: 'a' }), msg({ id: 2, text: 'b' })];
  const updated = applyUpdate(list, { id: 2, text: 'b обновлено', updated_at: '2026-09-28T12:01:00.000Z' });
  assert.strictEqual(updated[0].text, 'a');
  assert.strictEqual(updated[1].text, 'b обновлено');
  assert.strictEqual(updated[1].updated_at, '2026-09-28T12:01:00.000Z');
  assert.notStrictEqual(updated, list, 'исходный список не должен мутироваться');
});

test('applyUpdate: сообщения с неизвестным id список не меняет', () => {
  const list = [msg({ id: 1 })];
  const updated = applyUpdate(list, { id: 999, text: 'чужое' });
  assert.deepStrictEqual(updated, list);
});

test('applyDelete: ставит is_deleted и очищает текст и вложение по id', () => {
  const list = [msg({ id: 1, text: 'секрет', metadata_json: '{"file_id":5}' }), msg({ id: 2, text: 'другое' })];
  const updated = applyDelete(list, 1);
  assert.strictEqual(updated[0].is_deleted, 1);
  assert.strictEqual(updated[0].text, '');
  assert.strictEqual(updated[0].metadata_json, null);
  assert.strictEqual(updated[1].text, 'другое', 'соседнее сообщение не тронуто');
});

// ── Фикс раунд 1 (ревью Задачи 6): испорченное окно не «отказывает открыто» ─
//
// windowMin приходит с сервера (serverInfo.message_edit_window_minutes) как
// строка. Раньше "abc" или "" превращались через Number(...) в NaN/0 и
// withinWindow трактовала их как «без ограничения» — то есть недогруженная
// или испорченная настройка молча открывала правку задним числом.

test('canEdit: windowMin "abc" — тот же результат, что у окна по умолчанию (60 минут)', () => {
  const recent = msg({ created_at: new Date(NOW - 5 * 60 * 1000).toISOString() }); // 5 минут назад
  const old = msg({ created_at: new Date(NOW - 90 * 60 * 1000).toISOString() }); // 90 минут назад
  assert.strictEqual(canEdit(recent, { me: ME, now: NOW, windowMin: 'abc' }), true, 'в пределах отката по умолчанию');
  assert.strictEqual(canEdit(old, { me: ME, now: NOW, windowMin: 'abc' }), false, 'за пределами отката по умолчанию');
});

test('canEdit: windowMin "" (пустая строка) — тот же результат, что у окна по умолчанию', () => {
  const recent = msg({ created_at: new Date(NOW - 5 * 60 * 1000).toISOString() });
  const old = msg({ created_at: new Date(NOW - 90 * 60 * 1000).toISOString() });
  assert.strictEqual(canEdit(recent, { me: ME, now: NOW, windowMin: '' }), true);
  assert.strictEqual(canEdit(old, { me: ME, now: NOW, windowMin: '' }), false);
});

test('canEdit: дробное значение "1.5" отклоняется как формат — откат на 60 минут', () => {
  const recent = msg({ created_at: new Date(NOW - 5 * 60 * 1000).toISOString() });
  assert.strictEqual(canEdit(recent, { me: ME, now: NOW, windowMin: '1.5' }), true);
});

test('canDelete: windowMin "abc"/"" ведёт себя как окно по умолчанию (60 минут)', () => {
  const recent = msg({ created_at: new Date(NOW - 5 * 60 * 1000).toISOString() });
  const old = msg({ created_at: new Date(NOW - 90 * 60 * 1000).toISOString() });
  assert.strictEqual(canDelete(recent, { me: ME, now: NOW, windowMin: 'abc' }), true);
  assert.strictEqual(canDelete(old, { me: ME, now: NOW, windowMin: 'abc' }), false);
  assert.strictEqual(canDelete(recent, { me: ME, now: NOW, windowMin: '' }), true);
  assert.strictEqual(canDelete(old, { me: ME, now: NOW, windowMin: '' }), false);
});

test('canEdit: настоящие -1 и 0 не путаются с испорченным значением', () => {
  const fresh = msg({ created_at: new Date(NOW - 1000).toISOString() });
  const ancient = msg({ created_at: new Date(NOW - 365 * 24 * 3600 * 1000).toISOString() });
  assert.strictEqual(canEdit(fresh, { me: ME, now: NOW, windowMin: '-1' }), false, '-1 по-прежнему выключает правку');
  assert.strictEqual(canEdit(ancient, { me: ME, now: NOW, windowMin: '0' }), true, '0 по-прежнему означает «без ограничения»');
});

test('isValidMessageWindowValue: формат и границы', () => {
  assert.strictEqual(isValidMessageWindowValue('-1'), true);
  assert.strictEqual(isValidMessageWindowValue('0'), true);
  assert.strictEqual(isValidMessageWindowValue('60'), true);
  assert.strictEqual(isValidMessageWindowValue(60), true);
  assert.strictEqual(isValidMessageWindowValue('abc'), false);
  assert.strictEqual(isValidMessageWindowValue(''), false);
  assert.strictEqual(isValidMessageWindowValue(null), false);
  assert.strictEqual(isValidMessageWindowValue(undefined), false);
  assert.strictEqual(isValidMessageWindowValue('1.5'), false);
  assert.strictEqual(isValidMessageWindowValue('-2'), false);
  assert.strictEqual(isValidMessageWindowValue('525601'), false, 'больше года в минутах');
  assert.strictEqual(isValidMessageWindowValue('525600'), true, 'ровно год в минутах — ещё допустимо');
});
