// Побудка собеседника: что показать сейчас.
//
// Сервер присылает события (wake_scheduled, wake_result, wake_cancelled,
// wake_error, wake_state); клиент хранит по каждому собеседнику последнее
// из них и по текущему времени решает, какой вид у кнопки.

export const WAKE_MINUTES = [1, 2, 3, 5, 10, 15, 30];

// «4:05», «12:00», «0:07». Часов не бывает: самый долгий отсчёт — 30 минут.
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// «1 минуту», «3 минуты», «5 минут».
export function minutesLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} минуту`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} минуты`;
  return `${n} минут`;
}

// Применяет событие сервера к состоянию { [targetUserId]: entry }.
export function reduceWake(state, event, now = Date.now()) {
  const id = Number(event.targetUserId);
  switch (event.type) {
    case 'wake_state': {
      const next = {};
      for (const c of event.cooldowns || []) next[c.targetUserId] = { phase: 'cooldown', retryAt: c.retryAt };
      for (const s of event.scheduled || []) next[s.targetUserId] = { phase: 'scheduled', fireAt: s.fireAt, minutes: s.minutes, startedAt: s.fireAt - s.minutes * 60000 };
      return next;
    }
    case 'wake_scheduled':
      return { ...state, [id]: { phase: 'scheduled', fireAt: event.fireAt, minutes: event.minutes, startedAt: now } };
    case 'wake_cancelled':
      return { ...state, [id]: { phase: 'cooldown', retryAt: event.retryAt, cancelled: true } };
    case 'wake_result':
      return { ...state, [id]: { phase: 'result', outcome: event.outcome, at: event.at, retryAt: event.retryAt } };
    case 'wake_error':
      if (event.code === 'cooldown') return { ...state, [id]: { ...(state[id] || {}), phase: state[id]?.phase === 'result' ? 'result' : 'cooldown', retryAt: event.retryAt, error: event.message } };
      return { ...state, [id]: { ...(state[id] || { phase: 'idle' }), error: event.message, errorCode: event.code } };
    default:
      return state;
  }
}

// Вид для кнопки: idle | scheduled | result | cooldown.
export function wakeView(entry, now = Date.now()) {
  if (!entry || entry.phase === 'idle') return { phase: 'idle', error: entry?.error || null };
  if (entry.phase === 'scheduled') {
    const remaining = entry.fireAt - now;
    const duration = entry.minutes * 60000;
    return {
      phase: 'scheduled',
      remaining: Math.max(0, remaining),
      progress: duration > 0 ? Math.min(1, Math.max(0, 1 - remaining / duration)) : 1,
      minutes: entry.minutes
    };
  }
  const retryIn = (entry.retryAt || 0) - now;
  if (entry.phase === 'result') {
    // Итог держится, пока нельзя поставить новую побудку, и ещё немного после.
    if (retryIn > -5000) return { phase: 'result', outcome: entry.outcome, at: entry.at, retryIn: Math.max(0, retryIn) };
    return { phase: 'idle', error: null };
  }
  if (retryIn > 0) return { phase: 'cooldown', retryIn, error: entry.error || null };
  return { phase: 'idle', error: null };
}
