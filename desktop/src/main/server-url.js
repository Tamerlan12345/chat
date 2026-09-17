// Адрес сервера, с которого приложение загружает интерфейс.
//
// Раньше переменные окружения VITE_DEV_SERVER_URL и MYCHAT_SERVER_URL
// переопределяли адрес и в рабочей сборке, а http принимался для любого
// адреса. Достаточно было выставить переменную в ярлыке — и приложение со
// всеми своими возможностями (ввод, буфер, файлы) слушалось чужой страницы
// или открытого канала, который подменяется в той же сети.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(String(hostname || '').toLowerCase());
}

// https — всегда; http — только для своей машины и только в разработке.
function isAllowedServerUrl(url, { isPackaged } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return !isPackaged && isLocalHost(u.hostname);
  return false;
}

function resolveServerUrl({ isPackaged, env = {}, defaultUrl } = {}) {
  if (isPackaged) return { url: defaultUrl, ignored: null };
  const candidate = env.VITE_DEV_SERVER_URL || env.MYCHAT_SERVER_URL;
  if (!candidate) return { url: defaultUrl, ignored: null };
  if (isAllowedServerUrl(candidate, { isPackaged })) return { url: candidate, ignored: null };
  return { url: defaultUrl, ignored: candidate };
}

// Незащищённые запросы (http:, ws:) в рабочей сборке не уходят вовсе: даже
// если интерфейс попросит сервер по http, канал не откроется.
function isInsecureRequestBlocked(url, { isPackaged } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return false;
  if (!isPackaged && isLocalHost(u.hostname)) return false;
  return true;
}

module.exports = { isLocalHost, isAllowedServerUrl, resolveServerUrl, isInsecureRequestBlocked };
