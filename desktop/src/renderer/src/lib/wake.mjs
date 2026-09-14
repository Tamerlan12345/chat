// Побудка собеседника: что показать сейчас.
//
// Сигнал уходит сразу по нажатию. После него у отправителя минута паузы —
// общая, кого бы он ни будил. Сервер присылает wake_sent / wake_error /
// wake_state; клиент хранит одно состояние и по текущему времени решает,
// какой вид у кнопки в шапке конкретного чата.

export const WAKE_COOLDOWN_MS = 60000;
const ERROR_VISIBLE_MS = 6000;

// «0:59», «1:00». Больше минуты пауза не бывает.
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const initialWake = { retryAt: 0, at: 0, targetUserId: null, pendingTarget: null, error: null };

// Применяет событие к состоянию. wake_request — локальное: нажали кнопку,
// ответа сервера ещё нет.
export function reduceWake(state = initialWake, event, now = Date.now()) {
  switch (event.type) {
    case 'wake_request':
      return { ...state, pendingTarget: Number(event.targetUserId), error: null };
    case 'wake_sent':
      return { retryAt: event.retryAt, at: event.at, targetUserId: Number(event.targetUserId), pendingTarget: null, error: null };
    case 'wake_state':
      if (!event.retryAt || event.retryAt <= now) return { ...initialWake };
      return { ...initialWake, retryAt: event.retryAt, at: event.at || event.retryAt - WAKE_COOLDOWN_MS, targetUserId: event.targetUserId ?? null };
    case 'wake_error': {
      const base = { ...state, pendingTarget: null };
      const error = { targetUserId: Number(event.targetUserId), code: event.code, message: event.message, at: now };
      if (event.code === 'cooldown' && event.retryAt > (state.retryAt || 0)) {
        return { ...base, retryAt: event.retryAt, at: state.at || event.retryAt - WAKE_COOLDOWN_MS, error };
      }
      return { ...base, error };
    }
    case 'wake_disconnected':
      return state.pendingTarget == null ? state : { ...state, pendingTarget: null };
    default:
      return state;
  }
}

// Вид кнопки в шапке чата с собеседником peerId:
//   ready    — можно будить;
//   sending  — нажали, ждём сервер;
//   sent     — этого собеседника разбудили, идёт пауза;
//   cooldown — пауза после побудки другого собеседника.
export function wakeView(state = initialWake, peerId, now = Date.now()) {
  const id = Number(peerId);
  const retryIn = Math.max(0, (state.retryAt || 0) - now);
  const duration = Math.max(1, (state.retryAt || 0) - (state.at || 0)) || WAKE_COOLDOWN_MS;
  const error = state.error && state.error.targetUserId === id && now - state.error.at < ERROR_VISIBLE_MS && state.error.code !== 'cooldown'
    ? state.error
    : null;

  if (state.pendingTarget != null) return { phase: 'sending', retryIn, progress: 0, error: null };
  if (retryIn > 0) {
    return {
      phase: state.targetUserId === id ? 'sent' : 'cooldown',
      retryIn,
      // Сколько паузы уже прошло: 0 сразу после сигнала, 1 — снова можно.
      progress: Math.min(1, Math.max(0, 1 - retryIn / duration)),
      at: state.at,
      error
    };
  }
  return { phase: 'ready', retryIn: 0, progress: 1, error };
}
