const SettingsService = require('./settings.service');
const UserService = require('./user.service');

// Фильтр типов вложений (Rocket.Chat: File Upload → Accepted Media Types),
// расширенный требованием владельца: список разрешённых расширений задаётся
// и глобально, и дополнительно — для отдельных сотрудников (исключения).
// Закрывает серверную часть находки аудита №6: раньше сервер принимал файл
// любого типа под любым именем.
//
// Настройка лежит в server_settings под ключом file_policy как один JSON —
// как и остальные составные настройки (rd_ice_servers). Ключ добавлен в
// INTERNAL_SETTING (server/src/api/index.js): общий PUT /api/admin/settings
// его не трогает, чтобы черновик без валидации перечня расширений не мог
// затереть фильтр.

const SETTING_KEY = 'file_policy';

// Значение по умолчанию, пока администратор ни разу не сохранял настройку.
const DEFAULT_ALLOWED = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'odt', 'ods',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'zip', '7z', 'rar',
  'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'mov',
  'eml', 'msg', 'xml', 'json'
];

const MAX_ALLOWED_ENTRIES = 200;
const MAX_PER_USER_ENTRIES = 50;

// Расширение — только строчные латинские буквы и цифры, до 10 символов.
// Отсекает и точки, и слэши: значение вида '../x' в черновике списка не
// пройдёт этот шаблон и не попадёт ни в путь, ни в сравнение.
const EXT_RE = /^[a-z0-9]{1,10}$/;

// U+202E (Right-to-Left Override) и изолирующие управляющие символы
// U+2066–U+2069 переворачивают отображение имени файла — «tool.exe»
// показывается как «elif.exe» или наоборот, пряча настоящее расширение от
// глаза. Обычные управляющие символы (включая C0/C1) в имени файла тоже не
// нужны ни для чего легитимного.
// eslint-disable-next-line no-control-regex
const NAME_RISK_RE = /[‮⁦-⁩\u0000-\u001F\u007F-\u009F]/;

// Расширения, для которых заголовок «MZ» (исполняемый DOS/PE) не считается
// подделкой имени — это их законный формат.
const MZ_ALLOWED_EXT = new Set(['exe', 'dll', 'sys', 'scr', 'com']);

function mismatch() {
  return { code: 'content-mismatch', message: 'Содержимое файла не соответствует расширению' };
}

function startsWith(buf, bytes) {
  if (!buf || buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

// Проверка сигнатуры (магических байт) содержимого против заявленного
// расширения. Переименованный файл — самый дешёвый обход фильтра по
// расширению, и как раз он же самый опасный (исполняемый файл под видом
// картинки или документа).
function checkSignature(ext, headBytes) {
  const buf = Buffer.isBuffer(headBytes) ? headBytes : Buffer.from(headBytes || []);
  const isMz = startsWith(buf, [0x4d, 0x5a]);

  // Любой файл, начинающийся с MZ, при расширении не из «легитимно
  // исполняемых» — переименованный исполняемый файл, вне зависимости от того,
  // проверяется ли сигнатура именно этого расширения ниже.
  if (isMz && !MZ_ALLOWED_EXT.has(ext)) return mismatch();

  switch (ext) {
    case 'png':
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47]) ? null : mismatch();
    case 'jpg':
    case 'jpeg':
      return startsWith(buf, [0xff, 0xd8, 0xff]) ? null : mismatch();
    case 'gif':
      return buf.subarray(0, 4).toString('latin1') === 'GIF8' ? null : mismatch();
    case 'webp':
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
        ? null
        : mismatch();
    case 'pdf':
      return buf.subarray(0, 4).toString('latin1') === '%PDF' ? null : mismatch();
    case 'zip':
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'odt':
    case 'ods':
      return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) ? null : mismatch();
    case 'exe':
    case 'dll':
      return isMz ? null : mismatch();
    case 'msi':
      return startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0]) ? null : mismatch();
    default:
      // Для остальных расширений (txt, mp3, sys, scr, com, …) сигнатура не
      // определена — довольствуемся проверкой расширения и имени.
      return null;
  }
}

function validateAllowedList(list) {
  if (list === undefined || list === null) return [...DEFAULT_ALLOWED];
  if (!Array.isArray(list)) throw new Error('Список разрешённых расширений должен быть массивом');
  if (list.length > MAX_ALLOWED_ENTRIES) {
    throw new Error(`В общем списке не может быть больше ${MAX_ALLOWED_ENTRIES} расширений`);
  }
  const clean = [];
  for (const raw of list) {
    const ext = String(raw).toLowerCase();
    if (!EXT_RE.test(ext)) throw new Error(`Недопустимое расширение: «${raw}»`);
    if (!clean.includes(ext)) clean.push(ext);
  }
  return clean;
}

async function validatePerUser(perUser) {
  if (perUser === undefined || perUser === null) return {};
  if (typeof perUser !== 'object' || Array.isArray(perUser)) {
    throw new Error('Исключения для сотрудников должны быть объектом');
  }
  const clean = {};
  for (const [key, list] of Object.entries(perUser)) {
    const userId = Number(key);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error(`Недопустимый идентификатор сотрудника: «${key}»`);
    }
    const user = await UserService.getUserById(userId);
    if (!user || !user.is_active) {
      throw new Error(`Сотрудник №${userId} не найден или отключён`);
    }
    if (!Array.isArray(list)) throw new Error(`Список расширений для сотрудника №${userId} должен быть массивом`);
    if (list.length > MAX_PER_USER_ENTRIES) {
      throw new Error(`Не больше ${MAX_PER_USER_ENTRIES} дополнительных расширений на сотрудника`);
    }
    const cleanList = [];
    for (const raw of list) {
      const ext = String(raw).toLowerCase();
      if (!EXT_RE.test(ext)) throw new Error(`Недопустимое расширение: «${raw}»`);
      if (!cleanList.includes(ext)) cleanList.push(ext);
    }
    // Пустой список исключений — не ошибка, но и не нужен как ключ.
    if (cleanList.length) clean[String(userId)] = cleanList;
  }
  return clean;
}

class FilePolicyService {
  // Расширение — по последней точке, в нижнем регистре, без самой точки.
  // Имя без точки, скрытый файл (точка первым символом) или точка последним
  // символом — расширения нет.
  static extensionOf(originalName) {
    const name = String(originalName || '');
    const idx = name.lastIndexOf('.');
    if (idx <= 0 || idx === name.length - 1) return '';
    return name.slice(idx + 1).toLowerCase();
  }

  static checkName(originalName) {
    const name = String(originalName || '');
    if (NAME_RISK_RE.test(name)) {
      return { code: 'name-invalid', message: 'Имя файла содержит недопустимые символы' };
    }
    return null;
  }

  static async getPolicy() {
    const raw = await SettingsService.getSetting(SETTING_KEY, null);
    if (!raw) return { enabled: true, allowed: [...DEFAULT_ALLOWED], perUser: {}, maxPerUserEntries: MAX_PER_USER_ENTRIES };
    try {
      const parsed = JSON.parse(raw);
      return {
        enabled: parsed.enabled !== false,
        allowed: Array.isArray(parsed.allowed) ? parsed.allowed : [...DEFAULT_ALLOWED],
        perUser: parsed.perUser && typeof parsed.perUser === 'object' && !Array.isArray(parsed.perUser) ? parsed.perUser : {},
        maxPerUserEntries: MAX_PER_USER_ENTRIES
      };
    } catch {
      // Испорченное значение в базе — не повод отказывать всем загрузкам.
      return { enabled: true, allowed: [...DEFAULT_ALLOWED], perUser: {}, maxPerUserEntries: MAX_PER_USER_ENTRIES };
    }
  }

  static async setPolicy(draft, actor) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('Не передана политика файлов');
    }
    const enabled = draft.enabled !== false;
    const allowed = validateAllowedList(draft.allowed);
    const perUser = await validatePerUser(draft.perUser);
    const next = { enabled, allowed, perUser, maxPerUserEntries: MAX_PER_USER_ENTRIES };
    void actor; // сохранён в сигнатуре по интерфейсу задачи; запись в аудит — в маршруте (там есть IP запроса).
    await SettingsService.setSetting(SETTING_KEY, JSON.stringify(next));
    return next;
  }

  // Разница между старой и новой политикой — для записи в журнал аудита.
  static diffPolicy(before, after) {
    const beforeAllowed = new Set(before?.allowed || []);
    const afterAllowed = new Set(after?.allowed || []);
    const diff = {};
    if (Boolean(before?.enabled) !== Boolean(after?.enabled)) {
      diff.enabled = { from: Boolean(before?.enabled), to: Boolean(after?.enabled) };
    }
    const added = (after?.allowed || []).filter((e) => !beforeAllowed.has(e));
    const removed = (before?.allowed || []).filter((e) => !afterAllowed.has(e));
    if (added.length) diff.allowedAdded = added;
    if (removed.length) diff.allowedRemoved = removed;
    const beforeUsers = Object.keys(before?.perUser || {});
    const afterUsers = Object.keys(after?.perUser || {});
    if (JSON.stringify(before?.perUser || {}) !== JSON.stringify(after?.perUser || {})) {
      diff.perUserChanged = { before: beforeUsers, after: afterUsers };
    }
    return diff;
  }

  // Действующий список пользователя = общий список ∪ его личные исключения.
  static async effectiveAllowed(userId) {
    const policy = await this.getPolicy();
    const perUser = (userId !== null && userId !== undefined && policy.perUser[String(userId)]) || [];
    return [...new Set([...policy.allowed, ...perUser])];
  }

  /**
   * Полная проверка загружаемого файла: имя → расширение (если фильтр
   * включён) → сигнатура содержимого. Порядок важен: имя с трюком RTL
   * отклоняется раньше, чем сервер вообще посмотрит на расширение, а сигнатура
   * проверяется всегда — даже когда фильтр расширений выключен (иначе
   * enabled:false стало бы способом протащить переименованный исполняемый
   * файл под видом картинки).
   */
  static async check({ userId, originalName, headBytes }) {
    const nameProblem = this.checkName(originalName);
    if (nameProblem) return nameProblem;

    const ext = this.extensionOf(originalName);
    const policy = await this.getPolicy();

    if (policy.enabled) {
      if (!ext) return { code: 'ext-missing', message: 'У файла нет расширения' };
      const allowed = await this.effectiveAllowed(userId);
      if (!allowed.includes(ext)) {
        return { code: 'ext-not-allowed', message: `Файлы .${ext} к отправке не разрешены` };
      }
    }

    return checkSignature(ext, headBytes);
  }
}

FilePolicyService.DEFAULT_ALLOWED = DEFAULT_ALLOWED;
FilePolicyService.MAX_ALLOWED_ENTRIES = MAX_ALLOWED_ENTRIES;
FilePolicyService.MAX_PER_USER_ENTRIES = MAX_PER_USER_ENTRIES;

module.exports = FilePolicyService;
