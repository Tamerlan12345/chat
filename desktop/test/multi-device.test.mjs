import test from 'node:test';
import assert from 'node:assert';
import { viewingKey, viewingFrame, applyConversationRead, shouldNotify } from '../src/renderer/src/lib/multi-device.mjs';

// Один сотрудник на нескольких устройствах (mobile/contracts/multi-device.md):
// какой чат «смотрит» это окно, что делать с conversation_read и когда
// показывать уведомление о новом сообщении.

const chat = { type: 'direct', id: 5 };

test('viewing: только открытый чат в видимом разделе, окно в фокусе, связь есть, присутствие online', () => {
  const base = { chat, chatVisible: true, focused: true, connected: true, presence: 'online' };
  assert.strictEqual(viewingKey(base), 'direct:5');
  assert.strictEqual(viewingKey({ ...base, chat: { type: 'channel', id: 7 } }), 'channel:7');
  assert.strictEqual(viewingKey({ ...base, chat: null }), null);
  assert.strictEqual(viewingKey({ ...base, chatVisible: false }), null, 'раздел «Важное» — чат не виден');
  assert.strictEqual(viewingKey({ ...base, focused: false }), null, 'окно свёрнуто или без фокуса');
  assert.strictEqual(viewingKey({ ...base, connected: false }), null);
  assert.strictEqual(viewingKey({ ...base, presence: 'away' }), null, 'простой');
});

test('viewingFrame: ключ → кадр сервера; null → снять', () => {
  assert.deepStrictEqual(viewingFrame('direct:5'), { type: 'viewing', conversationType: 'direct', targetId: 5 });
  assert.deepStrictEqual(viewingFrame('channel:7'), { type: 'viewing', conversationType: 'channel', targetId: 7 });
  assert.deepStrictEqual(viewingFrame(null), { type: 'viewing', conversationType: null });
});

test('conversation_read обнуляет счётчик своей переписки и не трогает остальные', () => {
  const state = { unreadMap: { 5: 3, 6: 1 }, channelUnread: { 5: 2 } };
  const direct = applyConversationRead(state, { type: 'conversation_read', conversationType: 'direct', targetId: 5 });
  assert.deepStrictEqual(direct.unreadMap, { 5: 0, 6: 1 });
  assert.strictEqual(direct.channelUnread, state.channelUnread, 'каналы — тот же объект');
  const channel = applyConversationRead(state, { type: 'conversation_read', conversationType: 'channel', targetId: 5 });
  assert.deepStrictEqual(channel.channelUnread, { 5: 0 });
  assert.strictEqual(channel.unreadMap, state.unreadMap, 'канал №5 и сотрудник №5 — разные счётчики');
});

test('conversation_read: личный без счётчика ставит явный 0 (иначе бейдж берётся из списка); канал без счётчика — без изменений', () => {
  const state = { unreadMap: {}, channelUnread: {} };
  assert.deepStrictEqual(applyConversationRead(state, { conversationType: 'direct', targetId: 9 }).unreadMap, { 9: 0 });
  assert.strictEqual(applyConversationRead(state, { conversationType: 'channel', targetId: 9 }).channelUnread, state.channelUnread);
  const zero = { unreadMap: { 9: 0 }, channelUnread: {} };
  assert.strictEqual(applyConversationRead(zero, { conversationType: 'direct', targetId: 9 }).unreadMap, zero.unreadMap, 'без лишней перерисовки');
});

test('conversation_read с мусором — ничего не меняет', () => {
  const state = { unreadMap: { 5: 1 }, channelUnread: {} };
  for (const bad of [{}, { conversationType: 'group', targetId: 5 }, { conversationType: 'direct', targetId: 'x' }, null]) {
    const next = applyConversationRead(state, bad);
    assert.strictEqual(next.unreadMap, state.unreadMap);
    assert.strictEqual(next.channelUnread, state.channelUnread);
  }
});

test('уведомление: открытый в фокусе чат — нет; иначе — по notify сервера, без поля — по-старому', () => {
  assert.strictEqual(shouldNotify({ own: false, activeHere: true, notify: true }), false);
  assert.strictEqual(shouldNotify({ own: true, activeHere: false, notify: undefined }), false);
  assert.strictEqual(shouldNotify({ own: false, activeHere: false, notify: undefined }), true, 'старый сервер');
  assert.strictEqual(shouldNotify({ own: false, activeHere: false, notify: true }), true);
  assert.strictEqual(shouldNotify({ own: false, activeHere: false, notify: false }), false, 'чат открыт на телефоне');
});

test('auth: настоящее присутствие и открытый чат; без чата — без поля viewing', async () => {
  const { authFrame } = await import('../src/renderer/src/lib/multi-device.mjs');
  assert.deepStrictEqual(authFrame({ token: 't', presence: 'online', viewing: 'direct:5' }),
    { type: 'auth', token: 't', platform: 'desktop', presence: 'online', viewing: { conversationType: 'direct', targetId: 5 } });
  assert.deepStrictEqual(authFrame({ token: 't', presence: 'away', viewing: null }),
    { type: 'auth', token: 't', platform: 'desktop', presence: 'away' });
});

test('conversation_read снимает карточки только своей переписки', async () => {
  const { toastIsForConversation } = await import('../src/renderer/src/lib/multi-device.mjs');
  const dm = { type: 'chat', data: { user: { id: 5 } } };
  const ch = { type: 'channel', data: { channel: { id: 5 } } };
  const wake = { type: 'wake', data: { user: { id: 5 } } };
  assert.ok(toastIsForConversation(dm, { conversationType: 'direct', targetId: 5 }));
  assert.ok(!toastIsForConversation(ch, { conversationType: 'direct', targetId: 5 }));
  assert.ok(toastIsForConversation(ch, { conversationType: 'channel', targetId: 5 }));
  assert.ok(!toastIsForConversation(dm, { conversationType: 'direct', targetId: 6 }));
  assert.ok(!toastIsForConversation(wake, { conversationType: 'direct', targetId: 5 }), 'побудку не трогаем');
});

// ── Fix wave (Task 11, parity P16) ─────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_DIR = path.join(here, '..', '..', 'mobile', 'contracts', 'fixtures', 'notify');

test('isViewingHere: открытая в фокусе переписка при присутствии online; простой (away) — не смотрит', async () => {
  const { isViewingHere } = await import('../src/renderer/src/lib/multi-device.mjs');
  const view = { chat: { type: 'direct', id: 5 }, chatVisible: true, focused: true, presence: 'online' };
  assert.strictEqual(isViewingHere(view, 'direct', 5), true);
  assert.strictEqual(isViewingHere(view, 'direct', '5'), true, 'id строкой из кадра');
  assert.strictEqual(isViewingHere(view, 'direct', 6), false, 'другой собеседник');
  assert.strictEqual(isViewingHere(view, 'channel', 5), false, 'канал №5 — не сотрудник №5');
  assert.strictEqual(isViewingHere({ ...view, presence: 'away' }, 'direct', 5), false, 'вектор 05: компьютер простаивает');
  assert.strictEqual(isViewingHere({ ...view, focused: false }, 'direct', 5), false);
  assert.strictEqual(isViewingHere({ ...view, chatVisible: false }, 'direct', 5), false);
  assert.strictEqual(isViewingHere({ ...view, chat: null }, 'direct', 5), false);
});

test('новое чужое сообщение: смотрит — mark_read сразу (§4 п. 4), без счётчика и уведомления; не смотрит — счётчик и решение сервера', async () => {
  const { incomingMessagePlan } = await import('../src/renderer/src/lib/multi-device.mjs');
  assert.deepStrictEqual(incomingMessagePlan({ own: false, viewingHere: true, notify: false }),
    { markRead: true, countUnread: false, notify: false });
  assert.deepStrictEqual(incomingMessagePlan({ own: false, viewingHere: false, notify: true }),
    { markRead: false, countUnread: true, notify: true });
  assert.deepStrictEqual(incomingMessagePlan({ own: false, viewingHere: false, notify: false }),
    { markRead: false, countUnread: true, notify: false }, 'читают на телефоне: счётчик от notify не зависит');
  assert.deepStrictEqual(incomingMessagePlan({ own: false, viewingHere: false, notify: undefined }),
    { markRead: false, countUnread: true, notify: true }, 'старый сервер');
  assert.deepStrictEqual(incomingMessagePlan({ own: true, viewingHere: false, notify: true }),
    { markRead: false, countUnread: false, notify: false });
});

test('векторы fixtures/notify: сокет компьютера (desk) показывает ровно то, что решил сервер, и читает, пока смотрит', async () => {
  const { isViewingHere, incomingMessagePlan } = await import('../src/renderer/src/lib/multi-device.mjs');
  const files = fs.readdirSync(NOTIFY_DIR).filter((f) => /^\d\d-.*\.json$/.test(f));
  let checked = 0;
  for (const file of files) {
    const vector = JSON.parse(fs.readFileSync(path.join(NOTIFY_DIR, file), 'utf8'));
    if (vector.decision !== 'message') continue;
    const { recipientId, message, sockets } = vector.input;
    for (const socket of sockets.filter((s) => s.deviceId === null && /^desk/.test(s.id))) {
      const chat = socket.viewing ? { type: socket.viewing.conversationType, id: socket.viewing.targetId } : null;
      // Окно в фокусе и раздел переписок открыт; присутствие — как у сокета.
      const view = { chat, chatVisible: true, focused: true, presence: socket.presence };
      // Переписка с точки зрения получателя: личная — собеседник (автор), канал — канал.
      const convoId = message.conversationType === 'direct' ? message.senderId : message.targetId;
      const viewingHere = isViewingHere(view, message.conversationType, convoId);
      const notify = vector.expected.banner.includes(socket.id);
      const plan = incomingMessagePlan({ own: message.senderId === recipientId, viewingHere, notify });
      assert.strictEqual(plan.notify, notify, `${vector.name}: баннер на компьютере`);
      const serverSaysViewing = socket.presence === 'online' && socket.viewing &&
        socket.viewing.conversationType === message.conversationType && socket.viewing.targetId === convoId;
      assert.strictEqual(plan.markRead, Boolean(serverSaysViewing) && message.senderId !== recipientId, `${vector.name}: mark_read`);
      checked += 1;
    }
  }
  assert.ok(checked >= 5, `проверено сокетов компьютера: ${checked}`);
  const v05 = JSON.parse(fs.readFileSync(path.join(NOTIFY_DIR, '05-desktop-away-while-viewing.json'), 'utf8'));
  assert.deepStrictEqual(v05.expected.banner, ['desk'], 'вектор 05 на месте');
});

test('App.jsx: уведомление, счётчик и mark_read нового сообщения решает incomingMessagePlan; отметка прочтения учитывает присутствие', () => {
  const app = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', 'App.jsx'), 'utf8');
  assert.ok(!/const isCurrentActive =/.test(app), 'прежнее правило без присутствия убрано');
  assert.strictEqual((app.match(/incomingMessagePlan\(/g) || []).length, 2, 'личные и каналы');
  const mark = app.slice(app.indexOf('const markConversationRead'), app.indexOf('const markConversationRead') + 400);
  assert.match(mark, /isViewingHere\(/, 'mark_read — только пока окно «смотрит» переписку');
  const presence = app.slice(app.indexOf('const updateMyPresence'), app.indexOf('const updateMyPresence') + 700);
  assert.match(presence, /markConversationRead\(\)/, 'вернулись «в сети» — открытая переписка прочитана (§4 п. 4)');
});
