// Превью последней записи беседы в списке диалогов. Сервер при удалении
// сообщения обнуляет text, поэтому пустой текст у существующей записи —
// это удалённое сообщение (или вложение без подписи), а не «нет беседы».
export function conversationSnippet(convo) {
  if (!convo) return 'Нажмите для беседы';
  if (convo.last_message_text) return convo.last_message_text;
  if (!convo.last_message_time) return 'Нажмите для беседы';
  const type = convo.last_message_type;
  return type && type !== 'text' ? 'Вложение' : 'Сообщение удалено';
}

// Кадр registration_pending: { type, username, fullName } — уведомление
// администратору о новой заявке на регистрацию.
export function registrationToast(event) {
  const who = event?.fullName || event?.username;
  return {
    title: 'Новая заявка на регистрацию',
    body: who ? `Заявку подал(а) ${who}` : 'Откройте консоль администратора',
    type: 'system'
  };
}
