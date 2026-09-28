// Чистые правила для вкладки «Обновления» консоли администратора
// (components/UpdatesAdmin.jsx): сравнение версий и проверка черновика
// политики раздачи до отправки на сервер. Сервер (update-policy.service.js)
// проверяет то же самое и остаётся источником истины — эти функции только
// дают немедленную обратную связь в форме, не дожидаясь ответа сети.

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const CHANNELS = ['stable', 'beta'];
const POLICY_KEYS = new Set(['enabled', 'channels', 'minVersion', 'checkIntervalMinutes', 'message']);
const CHANNEL_KEYS = new Set(['target', 'rolloutPercent']);
const MESSAGE_MAX = 500;

// ── Версии ─────────────────────────────────────────────────────────────────
// Тот же алгоритм, что на сервере (update-policy.service.js) и в главном
// процессе клиента (main/update-policy.js): общие тестовые векторы у всех
// трёх сторон.

function parseVersion(v) {
  if (typeof v !== 'string' || v.length > 64 || !SEMVER.test(v)) return null;
  const dash = v.indexOf('-');
  const core = (dash === -1 ? v : v.slice(0, dash)).split('.');
  const pre = dash === -1 ? [] : v.slice(dash + 1).split('.');
  return { core, pre };
}

export function isValidVersion(v) {
  const parsed = parseVersion(v);
  return Boolean(parsed) && parsed.pre.every((id) => id.length > 0);
}

function compareDigits(a, b) {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareIdentifier(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return compareDigits(a, b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * semver с пререлизами: 1.10.0 > 1.9.0, 1.2.0-beta.1 < 1.2.0,
 * 1.2.0-beta.2 < 1.2.0-beta.10. Неразборчивая строка младше любой настоящей
 * версии, две неразборчивые равны.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    const c = compareDigits(pa.core[i], pb.core[i]);
    if (c) return c;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i += 1) {
    if (i >= pa.pre.length) return -1;
    if (i >= pb.pre.length) return 1;
    const c = compareIdentifier(pa.pre[i], pb.pre[i]);
    if (c) return c;
  }
  return 0;
}

// ── Раздача ────────────────────────────────────────────────────────────────

// Готовые ступени раздачи, показанные кнопками 5/25/50/100 в редакторе
// политики — сама раздача принимает любое целое 0..100, это только удобные
// пресеты.
export const ROLLOUT_PRESETS = [5, 25, 50, 100];

/**
 * Короткое описание процента раздачи для подписи у ползунка/поля.
 */
export function describeRollout(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n)) return 'Раздача не задана';
  const clamped = Math.max(0, Math.min(100, Math.round(n)));
  if (clamped === 0) return 'Раздача выключена (0%)';
  if (clamped === 100) return 'Всем компьютерам (100%)';
  return `${clamped}% парка получают эту версию`;
}

// ── Проверка черновика политики ───────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * validatePolicyDraft(draft, releases) → string[] ошибок на русском (пустой
 * массив — черновик годится для отправки). releases — список
 * импортированных релизов ({version, …}) для проверки, что target реально
 * загружен; без списка (null/undefined) наличие target не проверяется.
 * Проверки зеркалят server/src/services/update-policy.service.js —
 * validatePolicy: сервер решает окончательно, это только форма быстрее
 * подсказывает те же самые ошибки.
 */
export function validatePolicyDraft(draft, releases) {
  const problems = [];
  if (!isPlainObject(draft)) return ['Политика обновлений должна быть объектом'];

  const known = Array.isArray(releases) ? new Set(releases.map((r) => r.version)) : null;

  for (const key of Object.keys(draft)) {
    if (!POLICY_KEYS.has(key)) problems.push(`Неизвестное поле политики: ${String(key).slice(0, 64)}`);
  }

  if (draft.enabled !== undefined && typeof draft.enabled !== 'boolean') {
    problems.push('enabled должно быть true или false');
  }

  let stableTarget = null;
  if (draft.channels !== undefined) {
    if (!isPlainObject(draft.channels)) {
      problems.push('channels должно быть объектом');
    } else {
      for (const [name, cfg] of Object.entries(draft.channels)) {
        if (!CHANNELS.includes(name)) {
          problems.push(`Неизвестный канал: ${String(name).slice(0, 64)}`);
          continue;
        }
        if (!isPlainObject(cfg)) {
          problems.push(`Настройки канала ${name} должны быть объектом`);
          continue;
        }
        for (const key of Object.keys(cfg)) {
          if (!CHANNEL_KEYS.has(key)) problems.push(`Неизвестное поле канала ${name}: ${String(key).slice(0, 64)}`);
        }
        const target = cfg.target ?? null;
        if (target !== null) {
          if (!isValidVersion(target)) {
            problems.push(`Неверная версия target канала ${name}: ${String(target).slice(0, 64)}`);
          } else if (known && !known.has(target)) {
            problems.push(`Версия ${target} (канал ${name}) не найдена среди загруженных релизов`);
          } else if (name === 'stable') {
            stableTarget = target;
          }
        }
        const percent = cfg.rolloutPercent ?? 0;
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
          problems.push(`rolloutPercent канала ${name} — целое число от 0 до 100`);
        }
      }
    }
  }

  const minVersion = draft.minVersion ?? null;
  if (minVersion !== null) {
    if (!isValidVersion(minVersion)) {
      problems.push(`minVersion — неверная версия: ${String(minVersion).slice(0, 64)}`);
    } else if (!stableTarget) {
      problems.push('minVersion требует target канала stable');
    } else if (compareVersions(minVersion, stableTarget) > 0) {
      problems.push(`minVersion (${minVersion}) не может быть больше target канала stable (${stableTarget})`);
    }
  }

  if (draft.checkIntervalMinutes !== undefined) {
    const m = draft.checkIntervalMinutes;
    if (!Number.isInteger(m) || m < 30 || m > 1440) problems.push('checkIntervalMinutes — целое число от 30 до 1440');
  }

  const message = draft.message ?? null;
  if (message !== null) {
    if (typeof message !== 'string') problems.push('message должно быть строкой');
    else if (message.length > MESSAGE_MAX) problems.push(`message — не длиннее ${MESSAGE_MAX} символов`);
    else if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(message)) problems.push('message содержит управляющие символы');
  }

  return problems;
}
