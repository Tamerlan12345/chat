// Тема по времени суток: с 6:00 до 15:00 — светлая, с 15:00 до 6:00 — тёмная.
// Время берётся локальное, с компьютера сотрудника.

export const DAY_STARTS_AT = 6;
export const EVENING_STARTS_AT = 15;

export function themeForDate(date = new Date()) {
  const h = date.getHours();
  return h >= DAY_STARTS_AT && h < EVENING_STARTS_AT ? 'light' : 'dark';
}

// Ставит тему на <html>. При смене на глазах у человека старый кадр плавно
// растворяется поверх нового — без вспышки.
export function applyTheme(theme, { animate = false } = {}) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const set = () => {
    root.dataset.theme = theme;
  };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!animate || reduced || typeof document.startViewTransition !== 'function' || !root.dataset.theme) {
    set();
    return;
  }
  root.classList.add('theme-switching');
  const t = document.startViewTransition(set);
  t.finished.finally(() => root.classList.remove('theme-switching'));
}

// Следит за часами. Проверка раз в минуту, а не один таймер до 15:00: таймер
// не переживает сон компьютера, а после пробуждения тема должна быть верной.
export function startThemeClock(now = () => new Date()) {
  applyTheme(themeForDate(now()));
  const tick = () => applyTheme(themeForDate(now()), { animate: document.visibilityState === 'visible' });
  const id = setInterval(tick, 60 * 1000);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', tick);
  };
}
