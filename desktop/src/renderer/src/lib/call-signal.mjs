// Как панель звонка реагирует на сигналы собеседника.
//
// Вынесено отдельно, потому что вживую эти ветки проверяются только вдвоём и
// с неудачным стечением обстоятельств: звонящий передумал, пока у нас звонит;
// ответ пришёл дважды; собеседник отключился посреди разговора.
//
// Фазы панели: calling (мы звоним), ringing (звонят нам), connecting (трубку
// взяли, включается микрофон), active (разговор), failed (показана причина).
//
// Действия: ignore — ничего; start-audio — включить микрофон; dismiss — тихо
// закрыть панель; close — закрыть после разговора; fail — показать причину.

export const RING_TIMEOUT_MS = 45000;

const RELAYED = new Set(['call_answer', 'call_rejected', 'call_end']);

// Причины конца звонка, которые сервер присылает кодом (mobile/contracts/push.md §3).
const REASON_TEXT = {
  no_call: 'Звонок уже завершён',
  unavailable: 'Не удалось дозвониться: сотрудник недоступен',
  cancelled: 'Вызов отменён',
  timeout: 'Время вызова истекло',
  connection_lost: 'Связь с собеседником прервалась'
};
const REASON_CODE_RE = /^[a-z][a-z0-9_]*$/;

// Текст причины для панели: код сервера — по-русски; причина, которую
// написал собеседник (уже текст), — как есть; неизвестный код или пусто —
// запасной текст, но не сам код.
export function callReasonText(reason, fallback = 'Звонок завершён') {
  if (typeof reason !== 'string' || !reason) return fallback;
  if (Object.prototype.hasOwnProperty.call(REASON_TEXT, reason)) return REASON_TEXT[reason];
  return REASON_CODE_RE.test(reason) ? fallback : reason;
}

export function callSignalAction({ phase, direction, peerId }, msg) {
  const ignore = { action: 'ignore' };
  if (!msg || typeof msg !== 'object' || phase === 'failed') return ignore;

  // Пересланное сервером обязано быть от нашего собеседника: сигнал без
  // отправителя или от другого человека к этому звонку не относится.
  if (RELAYED.has(msg.type) && msg.senderId !== peerId) return ignore;

  switch (msg.type) {
    case 'call_answer':
      return phase === 'calling' && direction === 'outgoing' ? { action: 'start-audio' } : ignore;

    case 'call_rejected':
      if (phase === 'ringing') return { action: 'dismiss' };
      if (phase === 'calling') return { action: 'fail', error: callReasonText(msg.reason, 'Сотрудник отклонил звонок') };
      return { action: 'fail', error: callReasonText(msg.reason, 'Звонок завершён') };

    case 'call_end':
      if (phase === 'ringing') return { action: 'dismiss' };
      if (phase === 'calling') return { action: 'fail', error: callReasonText(msg.reason, 'Сотрудник завершил вызов') };
      if (phase === 'connecting') return { action: 'fail', error: callReasonText(msg.reason, 'Собеседник завершил звонок') };
      // Разговор закончен как обычно — панель просто закрывается. Причина
      // приходит, когда разговор оборвался (собеседник отключился): её
      // стоит показать, иначе непонятно, куда он пропал.
      return msg.reason ? { action: 'fail', error: callReasonText(msg.reason, 'Собеседник завершил звонок') } : { action: 'close' };

    case 'call_unavailable':
    case 'call_denied':
      if (phase !== 'calling') return ignore;
      if (msg.targetUserId !== undefined && msg.targetUserId !== peerId) return ignore;
      return {
        action: 'fail',
        error: callReasonText(msg.reason, msg.type === 'call_denied' ? 'Звонки недоступны для вашей роли' : 'Сотрудник недоступен')
      };

    default:
      return ignore;
  }
}

// Никто не берёт трубку. Звонящий сообщает об отмене (иначе у собеседника
// звонило бы дальше) и видит «Нет ответа»; у вызываемого панель исчезает
// сама — звонящий к этому моменту уже сдался.
export function ringTimeoutAction(direction) {
  return direction === 'outgoing'
    ? { action: 'fail', notify: 'call_end', error: 'Нет ответа' }
    : { action: 'dismiss' };
}
