// Что уходит через Google и Apple (решение владельца, задача 18): ТОЛЬКО
// идентификаторы. Ни текста сообщения, ни имени отправителя, ни названия
// канала — приложение само забирает содержимое с нашего сервера, когда
// проснётся (Notification Service Extension на iOS, обработчик FCM на Android).
// Контракт — mobile/contracts/push.md.

// Срок жизни у поставщика: уведомление о сообщении старше суток бесполезно
// (приложение всё равно синхронизируется при открытии), о звонке — 30 с.
const MESSAGE_TTL_SECONDS = 24 * 60 * 60;
const CALL_TTL_SECONDS = 30;

// Общая заглушка APNs до того, как расширение уведомлений подставит текст.
const APNS_ALERT_BODY = 'Новое сообщение';

const positiveInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

/**
 * Уведомление о новом сообщении для одного получателя. targetId — переписка с
 * точки зрения ПОЛУЧАТЕЛЯ: id канала или id собеседника (автора) в личной
 * переписке — ровно то, что клиент передаёт в mark_read и GET /messages.
 */
function messagePayload(message, recipientId) {
  const conversationType = message.conversation_type === 'channel' ? 'channel' : 'direct';
  const targetId = conversationType === 'channel'
    ? Number(message.target_id)
    : (Number(message.sender_id) === Number(recipientId) ? Number(message.target_id) : Number(message.sender_id));
  return { type: 'message', conversationType, targetId, messageId: Number(message.id) };
}

/** Уведомление о входящем звонке. callId — когда в протоколе появится номер звонка. */
function callPayload({ callerId, callId = null }) {
  const payload = { type: 'call', callerId: Number(callerId) };
  if (callId !== null && callId !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(String(callId))) payload.callId = String(callId);
  return payload;
}

/**
 * Тихое уведомление «прочитано на другом устройстве» (multi-device.md §6):
 * приложение снимает показанные уведомления этой переписки. targetId — как у
 * сообщения: с точки зрения получателя (того же сотрудника, что прочитал).
 */
function readPayload({ conversationType, targetId }) {
  return { type: 'read', conversationType: conversationType === 'channel' ? 'channel' : 'direct', targetId: Number(targetId) };
}

/**
 * Описание уведомления, общее для поставщиков: вид, данные (только id), срок
 * жизни и ключ схлопывания. Сообщения одной переписки схлопываются у
 * поставщика (пока устройство недоступно — до последнего); звонки — нет;
 * «read» — свой ключ на переписку (последнее «прочитано» заменяет прежние).
 */
function notificationFor(payload) {
  if (payload.type === 'call') {
    if (!positiveInt(payload.callerId)) throw new Error('callerId обязателен');
    return { kind: 'call', data: { ...payload }, ttlSeconds: CALL_TTL_SECONDS, collapseKey: null };
  }
  if (payload.type === 'read') {
    if (!positiveInt(payload.targetId)) throw new Error('Неверное уведомление о прочтении');
    return {
      kind: 'read',
      data: { ...payload },
      ttlSeconds: MESSAGE_TTL_SECONDS,
      collapseKey: `r-${payload.conversationType}-${payload.targetId}`
    };
  }
  if (payload.type !== 'message' || !positiveInt(payload.targetId) || !positiveInt(payload.messageId)) {
    throw new Error('Неверное уведомление о сообщении');
  }
  return {
    kind: 'message',
    data: { ...payload },
    ttlSeconds: MESSAGE_TTL_SECONDS,
    collapseKey: `m-${payload.conversationType}-${payload.targetId}`
  };
}

module.exports = { messagePayload, callPayload, readPayload, notificationFor, APNS_ALERT_BODY, MESSAGE_TTL_SECONDS, CALL_TTL_SECONDS };
