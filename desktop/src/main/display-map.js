// Куда на экране сотрудника попадает точка, указанная оператором.
//
// Оператор видит ОДИН монитор — тот, что сейчас транслируется. Раньше доля
// кадра растягивалась на весь виртуальный экран (все мониторы вместе), и на
// двух мониторах щелчок в центр картинки приходился на стык экранов.
//
// Про масштаб (125 %, 150 % и смешанные мониторы):
//   Electron описывает мониторы в DIP — логических точках. Захват экрана же
//   идёт в физических пикселях, и SetCursorPos в процессе, осведомлённом о
//   DPI каждого монитора (так настроен PowerShell, см. remote-input.js), тоже
//   ждёт физические пиксели. Переводить DIP в пиксели умножением на
//   scaleFactor верно только для основного монитора: у соседнего с другим
//   масштабом начало координат в DIP сдвинуто иначе. Поэтому на Windows
//   используется screen.dipToScreenRect, а умножение — только запасной путь.

function isValidRect(rect) {
  return Boolean(rect) &&
    [rect.x, rect.y, rect.width, rect.height].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    rect.width > 0 && rect.height > 0;
}

// display_id у источника захвата — строка, id монитора в Electron — число.
function findCapturedDisplay(displays, displayId, fallback) {
  const list = Array.isArray(displays) ? displays : [];
  if (displayId !== null && displayId !== undefined && displayId !== '') {
    const found = list.find((d) => d && String(d.id) === String(displayId));
    if (found) return found;
  }
  return fallback || list[0] || null;
}

function physicalRect(display, dipToScreenRect) {
  if (!display || !isValidRect(display.bounds)) return null;

  if (typeof dipToScreenRect === 'function') {
    try {
      const rect = dipToScreenRect(display.bounds);
      if (isValidRect(rect)) {
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      }
    } catch {
      // Ниже — приближение, которого достаточно для одного монитора.
    }
  }

  const scale = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
  const b = display.bounds;
  return {
    x: Math.round(b.x * scale),
    y: Math.round(b.y * scale),
    width: Math.round(b.width * scale),
    height: Math.round(b.height * scale)
  };
}

// Доля (0..1) → пиксель внутри прямоугольника. Правый и нижний край — это
// последний пиксель монитора, а не первый пиксель соседнего.
function mapToRect(nx, ny, rect) {
  if (typeof nx !== 'number' || typeof ny !== 'number' || !Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  if (!isValidRect(rect)) return null;
  const cx = Math.min(1, Math.max(0, nx));
  const cy = Math.min(1, Math.max(0, ny));
  return {
    x: rect.x + Math.round(cx * (rect.width - 1)),
    y: rect.y + Math.round(cy * (rect.height - 1))
  };
}

module.exports = { findCapturedDisplay, physicalRect, mapToRect, isValidRect };
