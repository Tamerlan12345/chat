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

// Кадр auth: настоящее присутствие окна (свёрнуто/простой — away) и открытый
// чат сразу, без окна до первого viewing (multi-device.md §3). Старый сервер
// лишние поля игнорирует.
export function authFrame({ token, presence, viewing }) {
  const frame = { type: 'auth', token, platform: 'desktop', presence: presence === 'away' ? 'away' : 'online' };
  const v = viewingFrame(viewing);
  if (v.conversationType) frame.viewing = { conversationType: v.conversationType, targetId: v.targetId };
  return frame;
}

// Карточка уведомления относится к прочитанной переписке: личный — по
// собеседнику (data.user), канал — по каналу (data.channel).
export function toastIsForConversation(toast, event) {
  const id = Number(event?.targetId);
  if (!toast || !Number.isInteger(id)) return false;
  if (event.conversationType === 'channel') return toast.type === 'channel' && Number(toast.data?.channel?.id) === id;
  if (event.conversationType === 'direct') return toast.type === 'chat' && Number(toast.data?.user?.id) === id;
  return false;
}
