import test from 'node:test';
import assert from 'node:assert';
import { WAKE_MINUTES, formatCountdown, minutesLabel, reduceWake, wakeView } from '../src/renderer/src/lib/wake.mjs';

test('выбор минут совпадает с тем, что принимает сервер', () => {
  assert.deepStrictEqual(WAKE_MINUTES, [1, 2, 3, 5, 10, 15, 30]);
});

test('обратный отсчёт в минутах и секундах, с округлением вверх', () => {
  assert.strictEqual(formatCountdown(5 * 60000), '5:00');
  assert.strictEqual(formatCountdown(245500), '4:06');
  assert.strictEqual(formatCountdown(999), '0:01');
  assert.strictEqual(formatCountdown(-10), '0:00');
});

test('минуты склоняются', () => {
  assert.strictEqual(minutesLabel(1), '1 минуту');
  assert.strictEqual(minutesLabel(3), '3 минуты');
  assert.strictEqual(minutesLabel(5), '5 минут');
  assert.strictEqual(minutesLabel(15), '15 минут');
});

test('поставленная побудка показывает отсчёт и долю прошедшего', () => {
  const now = 1_000_000;
  const state = reduceWake({}, { type: 'wake_scheduled', targetUserId: 7, minutes: 2, fireAt: now + 120000 }, now);
  const half = wakeView(state[7], now + 60000);
  assert.strictEqual(half.phase, 'scheduled');
  assert.strictEqual(half.remaining, 60000);
  assert.strictEqual(half.progress, 0.5);
});

test('после срабатывания виден итог, пока нельзя будить снова', () => {
  const now = 2_000_000;
  const state = reduceWake({}, { type: 'wake_result', targetUserId: 7, outcome: 'delivered', at: now, retryAt: now + 60000 }, now);
  const view = wakeView(state[7], now + 20000);
  assert.strictEqual(view.phase, 'result');
  assert.strictEqual(view.outcome, 'delivered');
  assert.strictEqual(view.retryIn, 40000);
  assert.strictEqual(wakeView(state[7], now + 70000).phase, 'idle');
});

test('после отмены — пауза, затем снова можно', () => {
  const now = 3_000_000;
  const state = reduceWake({}, { type: 'wake_cancelled', targetUserId: 7, retryAt: now + 60000 }, now);
  assert.strictEqual(wakeView(state[7], now + 1000).phase, 'cooldown');
  assert.strictEqual(wakeView(state[7], now + 61000).phase, 'idle');
});

test('отказ сервера из-за «Не беспокоить» показывается как ошибка, а не как отсчёт', () => {
  const state = reduceWake({}, { type: 'wake_error', targetUserId: 7, code: 'dnd', message: 'У собеседника включено «Не беспокоить»' });
  const view = wakeView(state[7]);
  assert.strictEqual(view.phase, 'idle');
  assert.match(view.error, /Не беспокоить/);
});

test('состояние после переподключения восстанавливает и отсчёты, и паузы', () => {
  const now = 4_000_000;
  const state = reduceWake({}, {
    type: 'wake_state',
    scheduled: [{ targetUserId: 3, minutes: 5, fireAt: now + 60000 }],
    cooldowns: [{ targetUserId: 4, retryAt: now + 30000 }]
  }, now);
  assert.strictEqual(wakeView(state[3], now).phase, 'scheduled');
  assert.strictEqual(wakeView(state[4], now).phase, 'cooldown');
});
