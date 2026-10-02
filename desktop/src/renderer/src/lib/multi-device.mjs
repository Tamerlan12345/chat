// Один сотрудник на нескольких устройствах (mobile/contracts/multi-device.md).
// Чистые функции: какой чат «смотрит» это окно (кадр viewing), что делать с
// conversation_read и показывать ли уведомление о новом сообщении.

// Ключ открытого чата, который человек действительно видит: чат открыт в
// разделе переписок, окно в фокусе (не свёрнуто), связь есть, присутствие
// «в сети». Иначе null — ни один чат не смотрят (§4).
export function viewingKey({ chat, chatVisible, focused, connected, presence }) {
  if (!chat || !chatVisible || !focused || !connected || presence === 'away') return null;
  if (chat.type !== 'direct' && chat.type !== 'channel') return null;
  const id = Number(chat.id);
  return Number.isInteger(id) && id > 0 ? `${chat.type}:${id}` : null;
}

export function viewingFrame(key) {
  if (!key) return { type: 'viewing', conversationType: null };
  const [conversationType, id] = key.split(':');
  return { type: 'viewing', conversationType, targetId: Number(id) };
}

// Переписку прочитали на другом устройстве — обнулить её счётчик. Личный
// счётчик ставится явным 0: без ключа бейдж берётся из списка диалогов, а там
// число могло остаться прежним. Неизменённый словарь возвращается тем же
// объектом — без лишней перерисовки.
export function applyConversationRead(state, event) {
  const id = Number(event?.targetId);
  if (!Number.isInteger(id) || id <= 0) return state;
  if (event.conversationType === 'direct') {
    if (state.unreadMap[id] === 0) return state;
    return { ...state, unreadMap: { ...state.unreadMap, [id]: 0 } };
  }
  if (event.conversationType === 'channel') {
    if (!state.channelUnread[id]) return state;
    return { ...state, channelUnread: { ...state.channelUnread, [id]: 0 } };
  }
  return state;
}

// Уведомление о новом сообщении (§5): своё и открытое здесь в фокусе — нет;
// иначе решает сервер полем notify (чат могут читать на телефоне); старый
// сервер поля не шлёт — тогда уведомлять, как раньше.
export function shouldNotify({ own, activeHere, notify }) {
  if (own || activeHere) return false;
  return notify !== false;
}
