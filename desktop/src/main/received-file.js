// Имя файла, который оператор передал в ходе сеанса удалённого доступа.
//
// Имя приходит с чужой машины. Раньше в «Загрузки» молча ложилось что угодно:
// .exe, .lnk, .hta — без пометки «из интернета», так что SmartScreen такой
// файл при запуске не проверял. Здесь только чистая логика имени; запись и
// пометка Zone.Identifier — в main.js.

const path = require('node:path');

const FALLBACK_NAME = 'файл';
const MAX_NAME_LENGTH = 180;

// Типы, которые Windows запускает или исполняет по двойному щелчку, и
// контейнеры, из которых пометка «из интернета» не переходит на содержимое.
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'msc', 'dll', 'ocx', 'sys', 'drv',
  'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller',
  'application', 'appref-ms', 'gadget',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'sct', 'hta', 'mshta',
  'lnk', 'url', 'scf', 'inf', 'reg', 'jar', 'chm', 'hlp',
  'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms',
  'iso', 'img', 'vhd', 'vhdx', 'xll', 'diagcab', 'cab'
]);

const RESERVED_BASENAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

// Управляющие символы и символы направления текста: «отчёт‮fdp.exe»
// выглядит в проводнике как «отчётexe.pdf».
function stripInvisible(value) {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) continue;
    out += ch;
  }
  return out;
}

// Только имя, без пути и без символов, запрещённых в Windows.
function sanitizeFileName(fileName) {
  let name = stripInvisible(String(fileName ?? ''));
  name = name.split(/[\\/]/).pop() || '';
  name = name.replace(/[<>:"|?*]/g, '_');
  if (name.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  // Windows отбрасывает точки и пробелы в конце: «evil.exe. » стал бы
  // «evil.exe» уже после всех проверок.
  name = name.replace(/[. ]+$/g, '').trim();
  if (!name) name = FALLBACK_NAME;

  // CON, NUL.txt, COM1.tar.gz — имя до первой точки зарезервировано.
  const stem = name.split('.')[0];
  if (RESERVED_BASENAMES.test(stem.trim())) name = `_${name}`;
  return name;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isDangerousFileName(name) {
  return DANGEROUS_EXTENSIONS.has(extensionOf(String(name || '')));
}

// Исполняемый файл сохраняется с добавочным «.txt»: открыть его двойным
// щелчком нельзя, а сотрудник, которому он действительно нужен, переименует
// его сознательно.
function planReceivedFileName(fileName) {
  const original = sanitizeFileName(fileName);
  if (!isDangerousFileName(original)) return { name: original, original, renamed: false };
  return { name: `${original}.txt`, original, renamed: true };
}

// Пометка «файл из интернета» (Mark of the Web) для SmartScreen и Office.
function zoneIdentifierContent(hostUrl) {
  let text = '[ZoneTransfer]\r\nZoneId=3\r\n';
  if (typeof hostUrl === 'string' && /^https?:\/\/[^\s]+$/i.test(hostUrl)) text += `HostUrl=${hostUrl}\r\n`;
  return text;
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

module.exports = {
  DANGEROUS_EXTENSIONS,
  sanitizeFileName,
  isDangerousFileName,
  planReceivedFileName,
  zoneIdentifierContent,
  formatFileSize
};
