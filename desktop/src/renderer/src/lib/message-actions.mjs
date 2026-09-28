// Правка и удаление своих сообщений (Rocket.Chat: Allow Message Editing/
// Deleting, Block Editing/Deleting After N Minutes). Эти правила решают
// только видимость пункта меню — сервер (MessageService.editMessage/
// deleteMessage) проверяет то же самое ещё раз и не полагается на клиента.

// windowMin — минуты из настройки сервера: -1 — действие выключено,
// 0 — без ограничения по времени, N>0 — разрешено N минут после отправки.
function withinWindow(createdAt, now, windowMin) {
  const minutes = Number(windowMin);
  if (minutes === -1) return false;
  if (minutes === 0) return true;
  if (!Number.isFinite(minutes) || minutes < 0) return true; // настройка не задана — не ограничиваем молча
  const ageMs = now - new Date(createdAt).getTime();
  return ageMs <= minutes * 60 * 1000;
}

export function canEdit(message, { me, now = Date.now(), windowMin = 60 } = {}) {
  if (!message || Number(message.sender_id) !== Number(me)) return false;
  if (message.is_deleted) return false;
  if (message.type !== 'text') return false;
  return withinWindow(message.created_at, now, windowMin);
}

export function canDelete(message, { me, now = Date.now(), windowMin = 60 } = {}) {
  if (!message || Number(message.sender_id) !== Number(me)) return false;
  if (message.is_deleted) return false;
  return withinWindow(message.created_at, now, windowMin);
}

// message_updated: заменяет сообщение в локальном списке по id — тем же
// объектом, что прислал сервер (текст, updated_at и остальные поля).
export function applyUpdate(list, message) {
  if (!message) return list;
  return list.map((m) => (m.id === message.id ? { ...m, ...message } : m));
}

// message_deleted: сервер уже обнулил текст и вложение в своей копии —
// здесь то же самое проделывается с локальным списком, чтобы «Сообщение
// удалено» не мигнуло прежним текстом до следующей перезагрузки истории.
export function applyDelete(list, id) {
  return list.map((m) => (m.id === id ? { ...m, is_deleted: 1, text: '', metadata_json: null } : m));
}
