// Права в клиенте выводятся ровно так же, как на сервере (server/src/api/index.js).
// Раньше интерфейс смотрел на role_id и имя учётной записи «admin»: номера ролей
// сдвигаются миграциями, а администратор подразделения тоже несёт is_admin — и
// видел кнопки, на каждую из которых сервер отвечал отказом.

export function isSuperAdmin(user) {
  const permissions = user?.permissions || {};
  return Boolean(permissions.is_admin) && !permissions.is_scoped_admin;
}

export function isScopedAdmin(user) {
  return Boolean(user?.permissions?.is_scoped_admin);
}

export function canOpenAdminConsole(user) {
  return isSuperAdmin(user) || isScopedAdmin(user);
}

// Сервер пускает к публикации оповещений и администратора, и сотрудника с
// отдельным правом can_broadcast.
export function canBroadcast(user) {
  const permissions = user?.permissions || {};
  return Boolean(permissions.is_admin || permissions.can_broadcast);
}

export const MIN_PASSWORD_LENGTH = 8;

// Пустое значение — не ошибка: так администратор просит сервер выдать
// случайный пароль.
export function validateAdminPassword(value) {
  const text = value ?? '';
  if (text === '') return null;
  if (text.length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  }
  return null;
}

export function formatPing(pingMs) {
  if (pingMs === null || pingMs === undefined || pingMs === '') return '—';
  const value = Number(pingMs);
  return Number.isFinite(value) ? `${Math.round(value)} мс` : '—';
}

export function errorMessageFrom(data, status, fallback) {
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  if (status === 401) return 'Сессия истекла — войдите заново';
  if (status === 403) return 'Недостаточно прав для этого действия';
  return fallback;
}

// Отказ сервера: русский текст для человека и код ответа для логики
// (например, по 404 перечитать устаревший список).
export function httpError(message, status) {
  const err = new Error(message);
  if (status !== undefined) err.status = status;
  return err;
}

// Тело отказа бывает и не JSON (например, «Бэкап не найден» простым текстом).
export async function readError(res, fallback) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return errorMessageFrom(data, res?.status, fallback);
}

export function limitRows(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  const truncated = list.length > limit;
  return { rows: truncated ? list.slice(0, limit) : list, total: list.length, truncated };
}

export function resultColumns(result) {
  if (Array.isArray(result?.columns) && result.columns.length > 0) return result.columns;
  const first = Array.isArray(result?.rows) ? result.rows[0] : null;
  return first && typeof first === 'object' ? Object.keys(first) : [];
}

// Ответы на быстрые последовательные запросы приходят в произвольном порядке.
// Учитывается только последний отправленный — иначе на экране смешиваются
// данные разных таблиц или разных объявлений.
export function createRequestSequence() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(id) {
      return id === current;
    }
  };
}

export function toDepartmentId(value) {
  if (value === '' || value === null || value === undefined) return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}
