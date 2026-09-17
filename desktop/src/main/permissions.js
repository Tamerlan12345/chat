// Какие разрешения браузера получает страница сервера.
//
// Интерфейс приходит с сервера — это удалённый код. Раньше `media` выдавался
// без разбора, что именно запрошено: страница могла снять экран старым
// способом (chromeMediaSource: 'desktop') или включить камеру, и главный
// процесс соглашался. Приложению нужен ровно микрофон для звонков.

const { isSameOrigin } = require('./security');

// clipboard-read сюда не входит: navigator.clipboard.readText() обходил бы
// проверки rd-clipboard-read, а интерфейс буфер через браузер не читает.
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);

function isAudioOnly(mediaTypes) {
  return Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio';
}

// Запрос разрешения (getUserMedia и т. п.).
function decidePermissionRequest({ permission, mediaTypes, requestingUrl, serverOrigin } = {}) {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (!isSameOrigin(requestingUrl, serverOrigin)) return false;
  if (permission === 'media') return isAudioOnly(mediaTypes);
  return true;
}

// Проверка без запроса. Пустой источник раньше пропускался — так приходят
// проверки не от страницы, и доверять им нечего.
function decidePermissionCheck({ permission, mediaType, requestingOrigin, serverOrigin } = {}) {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (!requestingOrigin || !isSameOrigin(requestingOrigin, serverOrigin)) return false;
  if (permission === 'media') return mediaType === 'audio';
  return true;
}

module.exports = { ALLOWED_PERMISSIONS, decidePermissionRequest, decidePermissionCheck, isAudioOnly };
