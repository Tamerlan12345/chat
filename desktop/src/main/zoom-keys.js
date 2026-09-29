// Масштаб главного окна с клавиатуры: Ctrl+= / Ctrl+Plus / Ctrl+NumpadAdd —
// крупнее, Ctrl+- — мельче, Ctrl+0 — как было.
//
// В собранной сборке меню приложения убрано: через «Вид → Инструменты
// разработчика» и его сочетание открывались DevTools поверх страницы
// сервера. Вместе с меню пропали и его сочетания масштаба — а для тех, кому
// мелко, это единственный быстрый способ. Здесь только они, без DevTools.

// Шаг и пределы — как у Chromium: уровень 0 = 100 %, каждый шаг ×1.2^0.5.
const ZOOM_STEP = 0.5;
const ZOOM_MIN_LEVEL = -4; // ≈ 48 %
const ZOOM_MAX_LEVEL = 6; // ≈ 300 %

/**
 * Событие before-input-event → 'in' | 'out' | 'reset' | null.
 * Клавиша определяется и по физическому коду (раскладка не важна), и по
 * символу («+» бывает на другой клавише). Ctrl+Alt — это AltGr: такие
 * сочетания печатают символы и масштабом не считаются. Numpad0 без NumLock —
 * это Insert (Ctrl+Insert — копирование), поэтому для сброса нужен символ «0»
 * или цифровая клавиша основного ряда.
 */
function zoomCommandForInput(input) {
  if (!input || input.type !== 'keyDown') return null;
  if (!(input.control || input.meta) || input.alt) return null;
  const key = String(input.key || '');
  const code = String(input.code || '');
  if (code === 'Equal' || code === 'NumpadAdd' || key === '=' || key === '+') return 'in';
  if (code === 'Minus' || code === 'NumpadSubtract' || key === '-') return 'out';
  if (code === 'Digit0' || key === '0') return 'reset';
  return null;
}

function nextZoomLevel(level, command) {
  const current = Number.isFinite(level) ? level : 0;
  if (command === 'reset') return 0;
  if (command === 'in') return Math.min(ZOOM_MAX_LEVEL, current + ZOOM_STEP);
  if (command === 'out') return Math.max(ZOOM_MIN_LEVEL, current - ZOOM_STEP);
  return current;
}

module.exports = { ZOOM_STEP, ZOOM_MIN_LEVEL, ZOOM_MAX_LEVEL, zoomCommandForInput, nextZoomLevel };
