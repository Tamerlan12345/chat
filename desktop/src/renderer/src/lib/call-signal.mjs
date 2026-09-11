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
      if (phase === 'calling') return { action: 'fail', error: msg.reason || 'Сотрудник отклонил звонок' };
      return { action: 'fail', error: msg.reason || 'Звонок завершён' };

    case 'call_end':
      if (phase === 'ringing') return { action: 'dismiss' };
      if (phase === 'calling') return { action: 'fail', error: msg.reason || 'Сотрудник завершил вызов' };
      if (phase === 'connecting') return { action: 'fail', error: msg.reason || 'Собеседник завершил звонок' };
      // Разговор закончен как обычно — панель просто закрывается. Причина
      // приходит, когда разговор оборвался (собеседник отключился): её
      // стоит показать, иначе непонятно, куда он пропал.
      return msg.reason ? { action: 'fail', error: msg.reason } : { action: 'close' };

    case 'call_unavailable':
    case 'call_denied':
      if (phase !== 'calling') return ignore;
      if (msg.targetUserId !== undefined && msg.targetUserId !== peerId) return ignore;
      return {
        action: 'fail',
        error: msg.reason || (msg.type === 'call_denied' ? 'Звонки недоступны для вашей роли' : 'Сотрудник недоступен')
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
