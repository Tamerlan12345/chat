import test from 'node:test';
import assert from 'node:assert';
import { pointToFrame, MoveThrottle } from '../src/renderer/src/lib/remote-pointer.mjs';

// Перевод точки окна оператора в долю кадра. Ошибка здесь не заметна на глаз
// сразу: курсор просто «не попадает», и тем сильнее, чем больше расходятся
// пропорции экранов. Проверяется поэтому арифметикой, а не вживую.

const rect = { left: 100, top: 50, width: 800, height: 600 };

test('центр области — центр кадра, когда пропорции совпадают', () => {
  const point = pointToFrame(500, 350, rect, 1600, 1200);
  assert.ok(Math.abs(point.x - 0.5) < 1e-9);
  assert.ok(Math.abs(point.y - 0.5) < 1e-9);
});

test('поля по краям учитываются при разных пропорциях', () => {
  // Кадр 16:9 в области 4:3 — сверху и снизу остаются поля.
  // Высота вписанного изображения: 800 / (1920/1080) = 450, поля по 75 сверху и снизу.
  const wide = pointToFrame(100 + 400, 50 + 300, rect, 1920, 1080);
  assert.ok(Math.abs(wide.x - 0.5) < 1e-9, 'по горизонтали ровно центр');
  assert.ok(Math.abs(wide.y - 0.5) < 1e-9, 'по вертикали тоже — поля симметричны');

  // Точка у верхнего края видимой картинки.
  const top = pointToFrame(100 + 400, 50 + 75, rect, 1920, 1080);
  assert.ok(Math.abs(top.y) < 1e-9, 'верх изображения — это ноль, а не верх области');
});

test('точка на поле отбрасывается, а не приводится к краю', () => {
  // Там экрана сотрудника нет. Приведение к краю утащило бы курсор в угол.
  assert.strictEqual(pointToFrame(100 + 400, 50 + 10, rect, 1920, 1080), null);
  assert.strictEqual(pointToFrame(100 + 400, 50 + 590, rect, 1920, 1080), null);
});

test('точка вне области отбрасывается', () => {
  assert.strictEqual(pointToFrame(50, 350, rect, 1600, 1200), null);
  assert.strictEqual(pointToFrame(1000, 350, rect, 1600, 1200), null);
});

test('неизвестные размеры кадра не дают ложных координат', () => {
  assert.strictEqual(pointToFrame(500, 350, rect, 0, 0), null);
  assert.strictEqual(pointToFrame(500, 350, { left: 0, top: 0, width: 0, height: 0 }, 1600, 1200), null);
});

// ── Ограничение потока событий ──────────────────────────────────────────────

test('движения мыши не отправляются чаще заданной частоты', () => {
  // Мышь порождает больше сотни событий в секунду. Каждое — отдельное
  // сообщение JSON по тому же соединению, что несёт видео и звук: без
  // ограничения канал забивается движениями курсора.
  let clock = 0;
  const sent = [];
  const throttle = new MoveThrottle({ intervalMs: 30, now: () => clock });

  throttle.push({ x: 0.1, y: 0.1 }, (p) => sent.push(p));
  assert.strictEqual(sent.length, 1, 'первое движение уходит сразу');

  clock = 10;
  throttle.push({ x: 0.2, y: 0.2 }, (p) => sent.push(p));
  assert.strictEqual(sent.length, 1, 'слишком рано');

  clock = 40;
  throttle.push({ x: 0.3, y: 0.3 }, (p) => sent.push(p));
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[1], { x: 0.3, y: 0.3 }, 'уходит самая свежая точка');
});

test('последняя точка не теряется при остановке мыши', () => {
  // Иначе курсор замирает не там, где его отпустили: последнее движение
  // приходится на паузу и отбрасывается навсегда.
  let clock = 0;
  const sent = [];
  const throttle = new MoveThrottle({ intervalMs: 30, now: () => clock });

  throttle.push({ x: 0.1, y: 0.1 }, (p) => sent.push(p));
  clock = 5;
  throttle.push({ x: 0.9, y: 0.9 }, (p) => sent.push(p));
  assert.strictEqual(sent.length, 1, 'пока придержано');

  throttle.flush((p) => sent.push(p));
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[1], { x: 0.9, y: 0.9 }, 'придержанная точка должна дойти');
});

test('повторная отправка той же точки не делается', () => {
  let clock = 0;
  const sent = [];
  const throttle = new MoveThrottle({ intervalMs: 30, now: () => clock });

  throttle.push({ x: 0.5, y: 0.5 }, (p) => sent.push(p));
  clock = 100;
  throttle.push({ x: 0.5, y: 0.5 }, (p) => sent.push(p));
  assert.strictEqual(sent.length, 1, 'курсор не двигался — сообщать не о чем');
});

test('flush без накопленной точки ничего не отправляет', () => {
  const sent = [];
  const throttle = new MoveThrottle({ intervalMs: 30, now: () => 0 });
  throttle.flush((p) => sent.push(p));
  assert.strictEqual(sent.length, 0);
});
