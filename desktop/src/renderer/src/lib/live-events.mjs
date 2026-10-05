// Превью последней записи беседы в списке диалогов. Сервер при удалении
// сообщения обнуляет text и metadata_json, но type оставляет, поэтому по type
// удалённое вложение от обычного не отличить. Десктоп всегда шлёт вложение с
// text = имя файла, так что у существующей записи пустой text — это удалённое
// сообщение, и превью совпадает с ChatView («Сообщение удалено»).
// Известное допущение: сервер разрешает вложения без подписи (пустой text
// запрещён только для type = 'text'), и другой клиент, приславший такое
// вложение, тоже покажется здесь как «Сообщение удалено».
export function conversationSnippet(convo) {
  if (!convo) return 'Нажмите для беседы';
  if (convo.last_message_text) return convo.last_message_text;
  if (!convo.last_message_time) return 'Нажмите для беседы';
  return 'Сообщение удалено';
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
