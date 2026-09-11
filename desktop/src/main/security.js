// Проверки происхождения для главного процесса.
//
// Интерфейс приходит с сервера, то есть это удалённый код. Возможности
// главного процесса — ввод мыши и клавиатуры, буфер обмена, запись файлов —
// доступны только верхнему кадру страницы этого сервера: не странице, на
// которую окно ушло по ссылке, и не встроенному в неё iframe.

function originOf(url) {
  try {
    const origin = new URL(String(url)).origin;
    // У file:, data:, javascript: источника нет — URL возвращает строку 'null'.
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

function isSameOrigin(url, origin) {
  if (!origin) return false;
  const actual = originOf(url);
  return actual !== null && actual === origin;
}

function isTrustedFrame(frame, origin) {
  if (!frame) return false;
  let url;
  let parent;
  try {
    url = frame.url;
    parent = frame.parent;
  } catch {
    // Кадр уже уничтожен — доверять нечему.
    return false;
  }
  if (typeof url !== 'string' || parent) return false;
  return isSameOrigin(url, origin);
}

// Во внешний браузер уходят только веб-ссылки. file:, smb:, ms-msdt: и прочие
// схемы запускают на машине программы — по ссылке из чата этого быть не должно.
function isExternalLink(url) {
  try {
    const { protocol } = new URL(String(url));
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = { originOf, isSameOrigin, isTrustedFrame, isExternalLink };
