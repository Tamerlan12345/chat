// Настройки соединения удалённого рабочего стола — в одном месте.
//
// Картинка идёт напрямую между компьютерами (WebRTC). Серверы STUN помогают
// узнать внешний адрес, но в сетях с жёстким NAT или VPN этого мало — нужен
// TURN, который пересылает поток сам.
//
// Список серверов задаёт администратор в консоли («Безопасность»), клиент
// получает его с сервера (GET /api/settings/rd). Пустой список — осознанный
// выбор: только локальная сеть, адреса компьютеров не уходят внешним STUN.
// JSON в localStorage под ключом RD_ICE_STORAGE_KEY остаётся лишь запасным
// вариантом для разработки, когда сервер список не прислал, например
//   [{"urls":"turn:turn.company.kz:3478","username":"u","credential":"p"}]

export const RD_DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun1.l.google.com:19302' })
]);

// Сколько оператор ждёт картинку, прежде чем ему честно скажут, что
// соединение не установится само.
export const RD_CONNECT_TIMEOUT_MS = 20000;
// У сотрудника чуть дольше: пусть первым причину увидит оператор, а экран
// сотрудника не транслируется в пустоту бесконечно.
export const RD_HOST_CONNECT_TIMEOUT_MS = 30000;

export const RD_ICE_STORAGE_KEY = 'mychat_rd_ice_servers';

const ICE_SCHEMES = /^(stun|stuns|turn|turns):/i;

// Принимает строку JSON или уже разобранный массив (ответ сервера): данные
// сервера проверяются так же строго, как ручная настройка.
export function parseIceServers(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;

  const servers = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const urls = Array.isArray(entry.urls)
      ? entry.urls.filter((u) => typeof u === 'string' && ICE_SCHEMES.test(u))
      : (typeof entry.urls === 'string' && ICE_SCHEMES.test(entry.urls) ? entry.urls : null);
    if (!urls || (Array.isArray(urls) && urls.length === 0)) continue;

    const server = { urls };
    if (typeof entry.username === 'string') server.username = entry.username;
    if (typeof entry.credential === 'string') server.credential = entry.credential;
    servers.push(server);
  }
  return servers.length ? servers : null;
}

// serverServers — список с сервера: массив, если сервер ответил, иначе
// null/undefined. Ответ сервера главнее всего остального, и пустой ответ
// не заменяется серверами Google: иначе запрет внешних серверов молча
// обходился бы.
export function getRdIceServers(serverServers = null, storage = globalThis.localStorage) {
  if (Array.isArray(serverServers)) {
    return parseIceServers(serverServers) || [];
  }
  try {
    const custom = storage ? parseIceServers(storage.getItem(RD_ICE_STORAGE_KEY)) : null;
    if (custom) return custom;
  } catch {
    // Хранилище недоступно (приватный режим, запрет) — берём значения по умолчанию.
  }
  // Сервер старой версии настройку не отдаёт — прежнее поведение.
  return RD_DEFAULT_ICE_SERVERS.map((s) => ({ ...s }));
}
