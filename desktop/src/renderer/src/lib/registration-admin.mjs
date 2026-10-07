// Чистые правила для вкладок «Разрешённые адреса» и «Жалобы» консоли
// администратора (components/RegistrationAllowlistAdmin.jsx, ReportsAdmin.jsx).
// Сервер остаётся источником истины; проверка здесь даёт немедленную обратную
// связь в форме и повторяет то, что принимает
// server/src/services/registration.service.js (normalizePattern).

const PATTERN_MAX = 254;
// Тот же шаблон, что ALLOWLIST_PATTERN_RE на сервере: user@domain.kz или @domain.kz.
// Совпадение с сервером проверяет тест (test/registration-admin.test.mjs).
const PATTERN_RE = /^(?:[a-z0-9._%+-]{1,64})?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const ALLOWLIST_PATTERN_SOURCE = PATTERN_RE.source;

export const ALLOWLIST_FORMAT_ERROR = 'Укажите адрес (user@domain.kz) или домен (@domain.kz)';

export function validateAllowlistPattern(value) {
  const pattern = String(value ?? '').trim().toLowerCase();
  if (pattern.length > PATTERN_MAX || !PATTERN_RE.test(pattern)) {
    return { ok: false, error: ALLOWLIST_FORMAT_ERROR };
  }
  return { ok: true, pattern };
}

export function describeAllowlistEntry(pattern) {
  const text = String(pattern ?? '');
  if (text.startsWith('@')) return { kind: 'domain', label: 'Весь домен', target: text.slice(1) };
  return { kind: 'address', label: 'Один адрес', target: text };
}

// Сервер отвечает по-русски в поле error; если тела нет, подставляется
// понятная замена (после 401/403 — единые для консоли формулировки), а иначе —
// текст конкретного действия (fallback: «Не удалось загрузить список…»).
export function allowlistErrorMessage(data, status, fallback) {
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  if (status === 409) return 'Такая запись уже есть';
  if (status === 401) return 'Сессия истекла — войдите заново';
  if (status === 403) return 'Недостаточно прав для этого действия';
  return fallback || 'Не удалось выполнить действие';
}

// ── Выключатель самостоятельной регистрации (allow_registration) ─────────
// Решение владельца Q: это главный выключатель. Выключен — сервер не
// принимает заявки ни формой с компьютера, ни кодом из письма с телефона
// (403 REGISTRATION_DISABLED), в том числе с разрешённых адресов. Включён —
// разрешённые адреса активируются сразу, остальные заявки ждут решения.

export const REGISTRATION_SWITCH = Object.freeze({
  label: 'Самостоятельная регистрация сотрудников',
  hint:
    'Сотрудник сам подаёт заявку: на компьютере — формой на экране входа, на телефоне — с подтверждением почты кодом из письма. ' +
    'Адреса из списка «Разрешённые адреса» получают доступ сразу, остальные заявки ждут решения во вкладке «Заявки». ' +
    'Выключите, если сервер доступен не только из сети компании.',
  offTitle: 'Самостоятельная регистрация выключена — новых заявок не будет.',
  offBody:
    'Сервер не принимает заявки ни с компьютера, ни с телефона, в том числе с адресов из списка «Разрешённые адреса». ' +
    'Уже поданные заявки остаются здесь. Включить регистрацию можно в разделе «Настройки».',
  allowlistOff:
    'Самостоятельная регистрация сейчас выключена, поэтому список не действует: заявки не принимаются ни с каких адресов. ' +
    'Включить регистрацию можно в разделе «Настройки».'
});

// ── Жалобы ─────────────────────────────────────────────────────────────────

export const REPORT_FILTERS = [
  { id: 'open', label: 'Открытые' },
  { id: 'closed', label: 'Закрытые' },
  { id: 'all', label: 'Все' }
];

export function reportsPath(filter) {
  if (filter === 'all') return '/api/admin/reports';
  return `/api/admin/reports?status=${filter === 'closed' ? 'closed' : 'open'}`;
}

const STATUS_LABELS = { open: 'Открыта', closed: 'Закрыта' };

export function reportStatusLabel(status) {
  return STATUS_LABELS[status] || String(status ?? '');
}

// Телефоны присылают причину кодом (Android ReportController, iOS
// Registration.swift); названия — те же, что видит сотрудник на iOS. Старые
// клиенты присылали свободный текст — он показывается как есть.
const REASON_LABELS = new Map([
  ['spam', 'Спам или реклама'],
  ['abuse', 'Оскорбления или травля'],
  ['inappropriate', 'Недопустимое содержимое'],
  ['threat', 'Угрозы или опасные действия'],
  ['other', 'Другое']
]);

export function reportReasonLabel(reason) {
  const text = String(reason ?? '').trim();
  if (!text) return '—';
  return REASON_LABELS.get(text.toLowerCase()) || text;
}

export function reporterName(report) {
  return report?.reporter?.name || '—';
}

// На кого или на что жалоба: у сообщения показываем автора и текст (если его
// не удалили), у пользователя — его имя.
export function describeReportTarget(report) {
  const who = report?.reportedUser?.name || `Пользователь №${report?.targetId}`;
  if (report?.targetType === 'message') {
    return { kind: 'Сообщение', who, text: report.messageText || null };
  }
  return { kind: 'Пользователь', who, text: null };
}

export function previewText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatAdminDate(iso, timeZone) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(timeZone ? { timeZone } : {})
  });
}
