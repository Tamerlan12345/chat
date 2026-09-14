import test from 'node:test';
import assert from 'node:assert';
import { formatCountdown, initialWake, reduceWake, wakeView } from '../src/renderer/src/lib/wake.mjs';

test('обратный отсчёт в минутах и секундах, с округлением вверх', () => {
  assert.strictEqual(formatCountdown(60000), '1:00');
  assert.strictEqual(formatCountdown(59001), '1:00');
  assert.strictEqual(formatCountdown(999), '0:01');
  assert.strictEqual(formatCountdown(-10), '0:00');
});

test('до нажатия будить можно', () => {
  assert.strictEqual(wakeView(initialWake, 7).phase, 'ready');
});

test('нажали — кнопка ждёт ответа сервера во всех чатах', () => {
  const state = reduceWake(initialWake, { type: 'wake_request', targetUserId: 7 });
  assert.strictEqual(wakeView(state, 7).phase, 'sending');
  assert.strictEqual(wakeView(state, 8).phase, 'sending');
});

test('после сигнала у этого собеседника виден таймер, у остальных — пауза', () => {
  const now = 1_000_000;
  const sent = reduceWake(reduceWake(initialWake, { type: 'wake_request', targetUserId: 7 }), { type: 'wake_sent', targetUserId: 7, at: now, retryAt: now + 60000 });
  const here = wakeView(sent, 7, now + 15000);
  assert.strictEqual(here.phase, 'sent');
  assert.strictEqual(here.retryIn, 45000);
  assert.strictEqual(here.progress, 0.25);
  assert.strictEqual(wakeView(sent, 8, now + 15000).phase, 'cooldown');
  assert.strictEqual(wakeView(sent, 7, now + 60001).phase, 'ready');
});

test('отказ из-за «Не беспокоить» или «не в сети» показывается и не запускает паузу', () => {
  const now = 2_000_000;
  const state = reduceWake(initialWake, { type: 'wake_error', targetUserId: 7, code: 'offline', message: 'Собеседник не в сети' }, now);
  const view = wakeView(state, 7, now + 1000);
  assert.strictEqual(view.phase, 'ready');
  assert.strictEqual(view.error.code, 'offline');
  assert.strictEqual(wakeView(state, 8, now + 1000).error, null, 'в другом чате ошибки нет');
  assert.strictEqual(wakeView(state, 7, now + 7000).error, null, 'ошибка гаснет сама');
});

test('отказ по паузе от сервера обновляет таймер', () => {
  const now = 3_000_000;
  const state = reduceWake(initialWake, { type: 'wake_error', targetUserId: 7, code: 'cooldown', retryAt: now + 30000 }, now);
  const view = wakeView(state, 7, now);
  assert.strictEqual(view.phase, 'cooldown');
  assert.strictEqual(view.retryIn, 30000);
  assert.strictEqual(view.error, null);
});

test('после переподключения пауза восстанавливается', () => {
  const now = 4_000_000;
  const state = reduceWake(initialWake, { type: 'wake_state', targetUserId: 3, at: now - 20000, retryAt: now + 40000 }, now);
  assert.strictEqual(wakeView(state, 3, now).phase, 'sent');
  assert.strictEqual(wakeView(state, 4, now).phase, 'cooldown');
  assert.strictEqual(reduceWake(state, { type: 'wake_state', retryAt: 0 }, now).retryAt, 0);
});

test('обрыв связи во время нажатия не оставляет кнопку в ожидании', () => {
  const state = reduceWake(reduceWake(initialWake, { type: 'wake_request', targetUserId: 7 }), { type: 'wake_disconnected' });
  assert.strictEqual(wakeView(state, 7).phase, 'ready');
});
