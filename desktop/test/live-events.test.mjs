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

test('вложение без подписи не выдаётся за удалённое', () => {
  const convo = { last_message_text: '', last_message_time: 't', last_message_type: 'file' };
  assert.strictEqual(conversationSnippet(convo), 'Вложение');
});

test('registration_pending превращается в уведомление с именем заявителя', () => {
  const t = registrationToast({ type: 'registration_pending', username: 'ivanov', fullName: 'Иван Иванов' });
  assert.strictEqual(t.title, 'Новая заявка на регистрацию');
  assert.ok(t.body.includes('Иван Иванов'));
  assert.ok(registrationToast({ username: 'ivanov' }).body.includes('ivanov'));
  assert.ok(registrationToast({}).body.length > 0);
});
