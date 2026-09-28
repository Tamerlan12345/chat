// Фильтр типов вложений — клиентская часть. Логика имени и расширения
// намеренно повторяет сервер (server/src/services/file-policy.service.js):
// человек должен увидеть тот же отказ сразу при выборе файла, а не после
// того, как сервер ответит 415 через несколько секунд загрузки. Проверку
// сигнатуры содержимого клиент не повторяет — она требует чтения байт файла
// и всё равно обязательна на сервере, здесь была бы лишь имитацией защиты.

export function extensionOf(name) {
  const s = String(name || '');
  const idx = s.lastIndexOf('.');
  if (idx <= 0 || idx === s.length - 1) return '';
  return s.slice(idx + 1).toLowerCase();
}

// U+202E (Right-to-Left Override) и изолирующие управляющие символы
// U+2066–U+2069 переворачивают отображаемое имя файла — расширение
// подделывается визуально, само имя остаётся прежним.
// eslint-disable-next-line no-control-regex
const NAME_RISK_RE = /[‮⁦-⁩\u0000-\u001F\u007F-\u009F]/;

export function checkName(name) {
  if (NAME_RISK_RE.test(String(name || ''))) {
    return 'Имя файла содержит недопустимые символы';
  }
  return null;
}

// Расширения, которые администратор видит с предупреждением в любом списке
// (общем или личном) — потенциально исполняемый код или ссылка на него.
export const RISKY_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'scr', 'com', 'dll', 'lnk', 'hta'
]);

export function isRiskyExtension(ext) {
  return RISKY_EXTENSIONS.has(String(ext || '').toLowerCase());
}

// Значение атрибута accept поля выбора файла: '.pdf,.png,…'.
export function acceptAttr(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map((e) => String(e || '').toLowerCase().trim())
    .filter(Boolean)
    .map((e) => `.${e}`)
    .join(',');
}

/**
 * Предпроверка при выборе файла в чате: null — можно отправлять, иначе текст
 * ошибки для показа рядом с полем ввода. policy — ответ GET /api/files/policy
 * ({ enabled, allowed }); отсутствующая политика (сервер недоступен) проверку
 * по расширению не блокирует — сервер всё равно проверит сам при отправке.
 */
export function checkFileAgainstPolicy(file, policy) {
  const name = file?.name || '';
  const nameProblem = checkName(name);
  if (nameProblem) return nameProblem;

  if (!policy || policy.enabled === false) return null;

  const ext = extensionOf(name);
  if (!ext) return 'У файла нет расширения — такой файл сервер не примет';

  const allowed = Array.isArray(policy.allowed) ? policy.allowed : [];
  if (!allowed.includes(ext)) return `Файлы .${ext} к отправке не разрешены`;
  return null;
}
