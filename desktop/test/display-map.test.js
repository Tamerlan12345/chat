const test = require('node:test');
const assert = require('node:assert');
const { findCapturedDisplay, physicalRect, mapToRect } = require('../src/main/display-map');

// Оператор видит ОДИН монитор сотрудника, а курсор раньше разносился по всему
// виртуальному экрану (все мониторы вместе): на двух мониторах щелчок в центр
// картинки попадал на стык экранов. Здесь проверяется перевод доли кадра в
// пиксели именно того монитора, который транслируется.

const primary = { id: 101, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
// Второй монитор 2560×1440 при масштабе 150 %: в DIP он 1707×960.
const second = { id: 202, bounds: { x: 1920, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 };
const dipToScreen = (b) => (b === second.bounds
  ? { x: 1920, y: 0, width: 2560, height: 1440 }
  : { x: b.x, y: b.y, width: b.width, height: b.height });

test('монитор находится по display_id источника захвата (строка против числа)', () => {
  assert.strictEqual(findCapturedDisplay([primary, second], '202', primary), second);
  assert.strictEqual(findCapturedDisplay([primary, second], 101, primary), primary);
});

test('неизвестный монитор — основной, а без основного — первый', () => {
  assert.strictEqual(findCapturedDisplay([primary, second], '999', primary), primary);
  assert.strictEqual(findCapturedDisplay([second, primary], null, primary), primary);
  assert.strictEqual(findCapturedDisplay([second, primary], '', undefined), second);
  assert.strictEqual(findCapturedDisplay([], '1', undefined), null);
  assert.strictEqual(findCapturedDisplay(null, '1', undefined), null);
});

test('доля кадра попадает в пиксели захваченного монитора, а не всего рабочего стола', () => {
  const rect = physicalRect(second, dipToScreen);
  assert.deepStrictEqual(rect, { x: 1920, y: 0, width: 2560, height: 1440 });
  assert.deepStrictEqual(mapToRect(0, 0, rect), { x: 1920, y: 0 });
  assert.deepStrictEqual(mapToRect(1, 1, rect), { x: 4479, y: 1439 }, 'последний пиксель, а не за краем');
  assert.deepStrictEqual(mapToRect(0.5, 0.5, rect), { x: 3200, y: 720 });
});

test('монитор левее основного — отрицательные координаты', () => {
  const rect = { x: -1280, y: 0, width: 1280, height: 1024 };
  assert.deepStrictEqual(mapToRect(0, 0, rect), { x: -1280, y: 0 });
  assert.deepStrictEqual(mapToRect(1, 0, rect), { x: -1, y: 0 });
});

test('без пересчёта DIP в пиксели — по коэффициенту масштаба', () => {
  const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 };
  assert.deepStrictEqual(physicalRect(laptop, null), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepStrictEqual(
    physicalRect(laptop, () => { throw new Error('нет такого вызова'); }),
    { x: 0, y: 0, width: 1920, height: 1080 },
    'сбой пересчёта не роняет управление'
  );
  assert.strictEqual(physicalRect(null, dipToScreen), null);
});

test('выход за диапазон зажимается, мусор отбрасывается', () => {
  const rect = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepStrictEqual(mapToRect(5, -1, rect), { x: 1919, y: 0 });
  assert.strictEqual(mapToRect(NaN, 0.5, rect), null);
  assert.strictEqual(mapToRect('0.5', 0.5, rect), null);
  assert.strictEqual(mapToRect(0.5, 0.5, null), null);
  assert.strictEqual(mapToRect(0.5, 0.5, { x: 0, y: 0, width: 0, height: 1080 }), null);
});
