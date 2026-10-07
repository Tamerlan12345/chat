import test from 'node:test';
import assert from 'node:assert';
import { conversationSnippet, registrationToast } from '../src/renderer/src/lib/live-events.mjs';

test('превью беседы без записей — приглашение', () => {
  assert.strictEqual(conversationSnippet(undefined), 'Нажмите для беседы');
  assert.strictEqual(conversationSnippet({ last_message_text: null, last_message_time: null }), 'Нажмите для беседы');
});

test('превью показывает текст последнего сообщения', () => {
  assert.strictEqual(conversationSnippet({ last_message_text: 'Привет', last_message_time: 't' }), 'Привет');
});

test('после удаления последнего сообщения (text пуст) превью — «Сообщение удалено»', () => {
  const convo = { last_message_text: '', last_message_time: '2026-10-04 10:00:00', last_message_type: 'text' };
  assert.strictEqual(conversationSnippet(convo), 'Сообщение удалено');
});

test('удалённое вложение (type сохраняется, text пуст) — тоже «Сообщение удалено», как в ChatView', () => {
  for (const type of ['file', 'image']) {
    const convo = { last_message_text: '', last_message_time: 't', last_message_type: type };
    assert.strictEqual(conversationSnippet(convo), 'Сообщение удалено');
  }
});

test('registration_pending превращается в уведомление с именем заявителя', () => {
  const t = registrationToast({ type: 'registration_pending', username: 'ivanov', fullName: 'Иван Иванов' });
  assert.strictEqual(t.title, 'Новая заявка на регистрацию');
  assert.ok(t.body.includes('Иван Иванов'));
  assert.ok(registrationToast({ username: 'ivanov' }).body.includes('ivanov'));
  assert.ok(registrationToast({}).body.length > 0);
});

// ── Fix wave (Task 11, M6) ─────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', ...p), 'utf8');

test('уведомление о заявке ведёт в консоль, во вкладку «Заявки»', async () => {
  const { toastTarget } = await import('../src/renderer/src/lib/live-events.mjs');
  const t = registrationToast({ username: 'ivanov' });
  assert.deepStrictEqual(t.data, { admin: 'registrations' });
  assert.deepStrictEqual(toastTarget(t.data), { kind: 'admin', tab: 'registrations' });
});

test('toastTarget: личный чат, канал, консоль; прочее — некуда открывать', async () => {
  const { toastTarget } = await import('../src/renderer/src/lib/live-events.mjs');
  const user = { id: 5 };
  const channel = { id: 7 };
  assert.deepStrictEqual(toastTarget({ user }), { kind: 'direct', user });
  assert.deepStrictEqual(toastTarget({ channel }), { kind: 'channel', channel });
  assert.strictEqual(toastTarget({ admin: 'server' }), null, 'в консоль — только известные вкладки');
  assert.strictEqual(toastTarget(null), null);
  assert.strictEqual(toastTarget({}), null);
});

test('клик по карточке и по системному уведомлению открывает цель через openToastTarget; карточка знает, что открывать есть что', () => {
  const app = read('App.jsx');
  assert.match(app, /onAction=\{\(t\) => openToastTarget\(t\.data\)\}/);
  assert.match(app, /onToastAction\(\(toastData\) => \{\s*openToastTargetRef\.current\(toastData\?\.data\)/);
  const stack = read('components', 'ToastNotificationStack.jsx');
  assert.match(stack, /toastTarget\(toast\.data\)/);
  const modal = read('components', 'AdminUserModal.jsx');
  assert.match(modal, /focusTab/, 'консоль переключается на вкладку по запросу');
});
