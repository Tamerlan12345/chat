// Чистые правила для вкладок «Разрешённые адреса» и «Жалобы» консоли
// администратора (components/RegistrationAllowlistAdmin.jsx, ReportsAdmin.jsx).
// Сервер остаётся источником истины; проверка здесь даёт немедленную обратную
// связь в форме и повторяет то, что принимает
// server/src/services/registration.service.js (normalizePattern).

const PATTERN_MAX = 254;
// Тот же шаблон, что ALLOWLIST_PATTERN_RE на сервере: user@domain.kz или @domain.kz.
const PATTERN_RE = /^(?:[a-z0-9._%+-]{1,64})?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

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
// понятная замена (после 401/403 — единые для консоли формулировки).
export function allowlistErrorMessage(data, status) {
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  if (status === 409) return 'Такая запись уже есть';
  if (status === 401) return 'Сессия истекла — войдите заново';
  if (status === 403) return 'Недостаточно прав для этого действия';
  return 'Не удалось выполнить действие';
}

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
