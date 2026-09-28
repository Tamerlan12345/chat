// Правка и удаление своих сообщений (Rocket.Chat: Allow Message Editing/
// Deleting, Block Editing/Deleting After N Minutes). Эти правила решают
// только видимость пункта меню — сервер (MessageService.editMessage/
// deleteMessage) проверяет то же самое ещё раз и не полагается на клиента.

// Год в минутах — тот же потолок, что у MAX_MESSAGE_WINDOW_MINUTES на
// сервере (server/src/services/message.service.js). Оба места держат
// одинаковую проверку формата намеренно: сервер отклоняет мусор на записи,
// клиент — на чтении (вдруг настройка испорчена в обход /admin/settings).
const MAX_WINDOW_MINUTES = 525600;
const DEFAULT_WINDOW_MINUTES = 60;

// Только «-1», «0» или целое положительное число (как строка или как число)
// — валидное значение окна. Раньше пустая строка или «abc» превращались
// через Number(...) в NaN/0 и трактовались как «без ограничения» — то есть
// испорченная или незаполненная настройка молча снимала защиту, а не
// включала её (находка ревью раунда 1).
// Экспортируется: AdminUserModal.jsx использует ту же проверку, чтобы не
// отправлять пустое или нечисловое поле в PUT /admin/settings (сервер его
// всё равно отклонит 400 — но тогда пропадали бы и остальные, исправные,
// настройки того же сохранения).
export function isValidMessageWindowValue(raw) {
  if (raw === null || raw === undefined) return false;
  const str = String(raw).trim();
  if (!/^-?\d+$/.test(str)) return false;
  const n = Number(str);
  return n >= -1 && n <= MAX_WINDOW_MINUTES;
}

function parseWindowMinutes(raw) {
  return isValidMessageWindowValue(raw) ? Number(raw) : DEFAULT_WINDOW_MINUTES;
}

// windowMin — минуты из настройки сервера: -1 — действие выключено,
// 0 — без ограничения по времени, N>0 — разрешено N минут после отправки.
function withinWindow(createdAt, now, windowMinRaw) {
  const minutes = parseWindowMinutes(windowMinRaw);
  if (minutes === -1) return false;
  if (minutes === 0) return true;
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
