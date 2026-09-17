// Подписи и форматирование для раздела «Безопасность» консоли управления.
// Чистые функции без React: их проверяют тесты, а компонент только рисует.

import { parseIceServers } from './rd-config.mjs';

// Действия журнала аудита по-русски. Неизвестное действие показывается как
// есть: сервер может добавить новое раньше, чем обновится клиент.
export const AUDIT_ACTION_LABELS = Object.freeze({
  login: 'Вход по паролю',
  login_failed: 'Неудачный вход',
  device_login: 'Вход с привязанного устройства',
  device_secret_claimed: 'Устройство подтверждено паролем',
  device_bound: 'Устройство привязано',
  device_unbound: 'Устройство отвязано',
  password_changed: 'Смена пароля',
  password_reset_by_admin: 'Сброс пароля администратором',
  user_created: 'Создан сотрудник',
  user_updated_by_admin: 'Карточка сотрудника изменена',
  user_activated: 'Учётная запись включена',
  user_deactivated: 'Учётная запись отключена',
  registration_approved: 'Заявка одобрена',
  registration_rejected: 'Заявка отклонена',
  role_permissions_changed: 'Изменены права роли',
  org_batch_import: 'Импорт оргструктуры',
  settings_changed: 'Изменены настройки сервера',
  ip_blacklist_changed: 'Изменён чёрный список IP',
  channel_deleted: 'Удалён канал',
  announcement_created: 'Опубликовано объявление',
  messages_read_by_admin: 'Администратор читал переписку',
  db_table_viewed: 'Просмотр таблицы БД',
  db_query_executed: 'Выполнен SQL-запрос',
  db_backup_downloaded: 'Скачана резервная копия',
  db_backup_created: 'Создана резервная копия',
  db_vacuum: 'Сжатие базы данных',
  remote_desktop_request: 'Запрос удалённого доступа',
  remote_desktop_accepted: 'Удалённый доступ разрешён',
  remote_desktop_rejected: 'Удалённый доступ отклонён',
  remote_desktop_file_sent: 'Файл передан в удалённом сеансе',
  remote_desktop_ended: 'Удалённый сеанс завершён',
  logout: 'Выход',
  security_alert: 'Оповещение безопасности',
  audit_verified: 'Проверка целостности журнала'
});

export function actionLabel(action) {
  const key = String(action ?? '');
  return Object.prototype.hasOwnProperty.call(AUDIT_ACTION_LABELS, key) ? AUDIT_ACTION_LABELS[key] : key || '—';
}

// Варианты фильтра по действию — в порядке подписи, чтобы искать глазами.
export function auditActionOptions() {
  return Object.keys(AUDIT_ACTION_LABELS)
    .map((value) => ({ value, label: AUDIT_ACTION_LABELS[value] }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

// ── Оповещения ──────────────────────────────────────────────────────────────

export const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2 });

const SEVERITY_LABELS = Object.freeze({ critical: 'Критично', high: 'Высокий', medium: 'Средний' });

export function normalizeSeverity(value) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, value) ? value : 'medium';
}

export function severityLabel(value) {
  return SEVERITY_LABELS[normalizeSeverity(value)];
}

// Сервер хранит время строкой: ISO с зоной или «ГГГГ-ММ-ДД ЧЧ:ММ:СС» в UTC
// (так пишет SQLite). Без явной зоны браузер счёл бы её местным временем и
// сдвинул бы события на пять часов.
export function parseServerTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) text = text.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function formatServerTime(value) {
  const ms = parseServerTime(value);
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// Новые сверху; при равном времени — более серьёзные выше.
export function sortAlerts(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    const dt = (parseServerTime(b?.created_at) ?? 0) - (parseServerTime(a?.created_at) ?? 0);
    if (dt !== 0) return dt;
    return SEVERITY_ORDER[normalizeSeverity(a?.severity)] - SEVERITY_ORDER[normalizeSeverity(b?.severity)];
  });
}

// Оповещения из WebSocket дописываются к загруженному списку. Одно и то же
// оповещение может прийти и так, и так — берётся более свежая запись
// (с отметкой о просмотре, если она есть).
export function mergeAlerts(base, incoming) {
  const byId = new Map();
  for (const alert of [...(base || []), ...(incoming || [])]) {
    if (!alert || alert.id === undefined || alert.id === null) continue;
    const prev = byId.get(alert.id);
    byId.set(alert.id, prev && prev.acknowledged_at && !alert.acknowledged_at ? prev : { ...prev, ...alert });
  }
  return sortAlerts([...byId.values()]);
}

export function countUnacknowledged(list) {
  return (list || []).filter((a) => a && !a.acknowledged_at).length;
}

// ── Подробности ────────────────────────────────────────────────────────────

const VALUE_LIMIT = 500;

function valueToText(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Подробности — только строки «ключ: значение». Никакого HTML: в них попадают
// имена, адреса и тексты, которые присылают посторонние (например, логин при
// неудачном входе).
export function formatDetails(details) {
  if (details === null || details === undefined || details === '') return [];
  let data = details;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return [{ key: 'текст', value: data.slice(0, VALUE_LIMIT) }];
    }
  }
  if (typeof data !== 'object' || data === null) return [{ key: 'значение', value: valueToText(data) }];
  return Object.keys(data).map((key) => {
    const text = valueToText(data[key]);
    return { key: String(key), value: text.length > VALUE_LIMIT ? text.slice(0, VALUE_LIMIT) + '…' : text };
  });
}

export function summarizeDetails(details, limit = 120) {
  const text = formatDetails(details).map(({ key, value }) => `${key}: ${value}`).join('; ');
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

// ── Состояние сервера ──────────────────────────────────────────────────────

const CHECK_STATUS = Object.freeze({
  ok: { label: 'В порядке', icon: 'circleCheck' },
  warn: { label: 'Внимание', icon: 'alert' },
  fail: { label: 'Проблема', icon: 'circleX' }
});

export function checkStatusMeta(status) {
  return CHECK_STATUS[status] || CHECK_STATUS.warn;
}

// Проблемы — наверх: администратор открывает раздел, чтобы увидеть именно их.
export function sortChecks(list) {
  const rank = { fail: 0, warn: 1, ok: 2 };
  return [...(Array.isArray(list) ? list : [])]
    .map((check, index) => ({ check, index }))
    .sort((a, b) => ((rank[a.check?.status] ?? 1) - (rank[b.check?.status] ?? 1)) || a.index - b.index)
    .map(({ check }) => check);
}

// ── Серверы соединения удалённого рабочего стола ───────────────────────────

// Текст из поля консоли -> { ok, value, error }. value — нормализованный JSON
// для настройки rd_ice_servers. Пусто — список пустой (только локальная сеть).
// Запись, которую клиент отбросил бы, — ошибка: иначе администратор сохранил
// бы сервер, который молча не используется.
export function validateIceServersText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, value: '[]', servers: [] };
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Это не JSON. Ожидается список, например [{"urls":"stun:stun.company.kz:3478"}]' };
  }
  if (!Array.isArray(list)) return { ok: false, error: 'Ожидается список в квадратных скобках […]' };
  if (list.length === 0) return { ok: true, value: '[]', servers: [] };
  for (let i = 0; i < list.length; i++) {
    const one = parseIceServers([list[i]]);
    const entry = list[i];
    const urlsCount = Array.isArray(entry?.urls) ? entry.urls.length : 1;
    if (!one || (Array.isArray(one[0].urls) && one[0].urls.length !== urlsCount)) {
      return { ok: false, error: `Запись ${i + 1}: адрес должен начинаться с stun:, stuns:, turn: или turns:` };
    }
  }
  const servers = parseIceServers(list);
  return { ok: true, value: JSON.stringify(servers), servers };
}

export function formatIceServersText(value) {
  if (Array.isArray(value)) return value.length ? JSON.stringify(value, null, 2) : '';
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return list.length ? JSON.stringify(list, null, 2) : '';
  } catch {
    // Показываем как есть: администратор сам увидит и исправит.
  }
  return raw;
}
