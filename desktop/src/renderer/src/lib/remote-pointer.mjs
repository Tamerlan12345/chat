// Арифметика указателя для сеанса удалённого управления.
//
// Вынесена из компонента отдельно, потому что проверить её вживую нельзя:
// промах курсора видно только на чужом экране, вдвоём, и «кажется, немного
// левее» — не тот способ находить ошибки.

/**
 * Переводит точку окна оператора в долю кадра (0..1).
 *
 * Видео вписано с сохранением пропорций, поэтому по краям остаются поля.
 * Считать от размеров элемента напрямую нельзя: курсор уезжал бы тем сильнее,
 * чем сильнее отличаются пропорции экранов. Точки на полях отбрасываются —
 * экрана сотрудника там нет, и приводить их к краю значит утаскивать курсор
 * в угол.
 *
 * @returns {{x: number, y: number} | null}
 */
export function pointToFrame(clientX, clientY, rect, videoWidth, videoHeight) {
  if (!rect || !videoWidth || !videoHeight || !rect.width || !rect.height) return null;

  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const shownWidth = videoWidth * scale;
  const shownHeight = videoHeight * scale;
  const offsetX = (rect.width - shownWidth) / 2;
  const offsetY = (rect.height - shownHeight) / 2;

  const x = (clientX - rect.left - offsetX) / shownWidth;
  const y = (clientY - rect.top - offsetY) / shownHeight;

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Придерживает поток движений мыши.
 *
 * Мышь порождает больше сотни событий в секунду, и каждое уходило отдельным
 * сообщением JSON по тому же соединению, что несёт видео сеанса и звук
 * разговора. Достаточно частоты около 30 в секунду: быстрее человек движение
 * всё равно не различает, а канал остаётся свободным.
 */
export class MoveThrottle {
  constructor({ intervalMs = 33, now = () => Date.now() } = {}) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.lastSentAt = -Infinity;
    this.lastPoint = null;
    this.pending = null;
  }

  push(point, send) {
    if (!point) return;
    // Курсор не сдвинулся — сообщать не о чем.
    if (this.lastPoint && samePoint(this.lastPoint, point)) return;

    const now = this.now();
    if (now - this.lastSentAt >= this.intervalMs) {
      this.lastSentAt = now;
      this.lastPoint = point;
      this.pending = null;
      send(point);
      return;
    }
    // Слишком рано: точка придерживается и уйдёт следующей — или по flush,
    // если мышь остановилась. Иначе курсор замирал бы не там, где его
    // отпустили.
    this.pending = point;
  }

  flush(send) {
    if (!this.pending) return;
    const point = this.pending;
    this.pending = null;
    this.lastPoint = point;
    this.lastSentAt = this.now();
    send(point);
  }

  reset() {
    this.lastSentAt = -Infinity;
    this.lastPoint = null;
    this.pending = null;
  }
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

