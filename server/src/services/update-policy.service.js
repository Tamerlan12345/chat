const crypto = require('node:crypto');
const config = require('../config');
const SettingsService = require('./settings.service');
const AuditService = require('./audit.service');

// Политика раздачи обновлений: какая версия предлагается в каждом канале,
// какой доле парка и какие версии обязаны обновиться. Хранится JSON-строкой в
// server_settings.update_policy и меняется только через PUT
// /api/admin/updates/policy — общий PUT настроек её не пропускает
// (INTERNAL_SETTING), потому что без проверки мусор в ней сломал бы раздачу
// всему парку разом.

const CHANNELS = ['stable', 'beta'];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLICY_KEYS = new Set(['enabled', 'channels', 'minVersion', 'checkIntervalMinutes', 'message']);
const CHANNEL_KEYS = new Set(['target', 'rolloutPercent']);
const MESSAGE_MAX = 500;

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  channels: Object.freeze({
    stable: Object.freeze({ target: null, rolloutPercent: 0 }),
    beta: Object.freeze({ target: null, rolloutPercent: 0 })
  }),
  minVersion: null,
  checkIntervalMinutes: 240,
  message: null
});

class UpdatePolicyError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.status = 400;
    this.problems = problems;
  }
}

function clonePolicy(p) {
  return {
    enabled: p.enabled,
    channels: {
      stable: { ...p.channels.stable },
      beta: { ...p.channels.beta }
    },
    minVersion: p.minVersion,
    checkIntervalMinutes: p.checkIntervalMinutes,
    message: p.message
  };
}

// ── Версии ─────────────────────────────────────────────────────────────────
// Тот же алгоритм, что в клиентском desktop/src/main/update-policy.js: сервер
// и клиент обязаны одинаково понимать, что «новее». Числа сравниваются как
// строки цифр (без потери точности на длинных), пререлиз — по правилам semver.

function parseVersion(v) {
  if (typeof v !== 'string' || v.length > 64 || !SEMVER.test(v)) return null;
  const dash = v.indexOf('-');
  const core = (dash === -1 ? v : v.slice(0, dash)).split('.');
  const pre = dash === -1 ? [] : v.slice(dash + 1).split('.');
  return { core, pre };
}

// Строгая проверка для того, что сервер принимает от администратора: к
// регулярке спецификации добавлен запрет пустых частей пререлиза («1.2.0-.»,
// «1.2.0-beta.») — версия становится именем каталога, а Windows молча срезает
// точку в конце имени.
function isValidVersion(v) {
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
  if (an) return -1; // числовой идентификатор младше буквенного
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * semver с пререлизами: 1.10.0 > 1.9.0, 1.2.0-beta.1 < 1.2.0,
 * 1.2.0-beta.2 < 1.2.0-beta.10. Неразборчивая строка младше любой настоящей
 * версии, две неразборчивые равны — исключение здесь уронило бы ответ клиенту
 * из-за мусора в его же заголовке.
 */
function compareVersions(a, b) {
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

/**
 * Корзина 0..99 для поэтапной раздачи. Зависит от версии: следующий выпуск
 * первыми получают уже другие компьютеры, а не одни и те же «подопытные».
 * Без installId (или с мусором вместо него) — 99: такой клиент получает
 * обновление последним, при 100% раздаче.
 */
function bucketOf(installId, version) {
  if (typeof installId !== 'string' || !UUID.test(installId)) return 99;
  const digest = crypto.createHash('sha256').update(`${installId.toLowerCase()}:${version}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Что предложить этому клиенту. Устаревший (ниже minVersion) обходит
 * корзину — обновление для него обязательно.
 */
function decide({ channel, installId, clientVersion, policy, releases, disabledByEnv = false }) {
  const none = { release: null, eligible: false, mandatory: false };
  if (disabledByEnv || !policy?.enabled) return none;
  if (!CHANNELS.includes(channel)) return none;
  const cfg = policy.channels?.[channel];
  const target = cfg?.target;
  if (!target) return none;
  const release = (releases || []).find((r) => r.version === target) || null;
  if (!release) return none;

  const known = isValidVersion(clientVersion);
  const mandatory = Boolean(
    known &&
      policy.minVersion &&
      compareVersions(clientVersion, policy.minVersion) < 0 &&
      compareVersions(target, clientVersion) > 0
  );
  const eligible = mandatory || bucketOf(installId, target) < (cfg.rolloutPercent || 0);
  return { release, eligible, mandatory };
}

// ── Проверка политики ──────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Проверяет черновик политики и возвращает нормализованную копию. releases —
 * список импортированных релизов ({version}); null — не проверять наличие
 * target (разбор уже сохранённой политики).
 */
function validatePolicy(draft, releases) {
  if (!isPlainObject(draft)) throw new UpdatePolicyError('Политика обновлений должна быть объектом');
  const problems = [];
  const known = releases ? new Set(releases.map((r) => r.version)) : null;

  for (const key of Object.keys(draft)) {
    if (!POLICY_KEYS.has(key)) problems.push(`Неизвестное поле политики: ${key.slice(0, 64)}`);
  }

  const clean = clonePolicy(DEFAULT_POLICY);

  if (draft.enabled !== undefined) {
    if (typeof draft.enabled !== 'boolean') problems.push('enabled должно быть true или false');
    else clean.enabled = draft.enabled;
  }

  if (draft.channels !== undefined) {
    if (!isPlainObject(draft.channels)) {
      problems.push('channels должно быть объектом');
    } else {
      for (const [name, cfg] of Object.entries(draft.channels)) {
        if (!CHANNELS.includes(name)) {
          problems.push(`Неизвестный канал: ${name.slice(0, 64)}`);
          continue;
        }
        if (!isPlainObject(cfg)) {
          problems.push(`Настройки канала ${name} должны быть объектом`);
          continue;
        }
        for (const key of Object.keys(cfg)) {
          if (!CHANNEL_KEYS.has(key)) problems.push(`Неизвестное поле канала ${name}: ${key.slice(0, 64)}`);
        }
        const target = cfg.target ?? null;
        if (target !== null) {
          if (!isValidVersion(target)) {
            problems.push(`Неверная версия target канала ${name}: ${String(target).slice(0, 64)}`);
          } else if (known && !known.has(target)) {
            problems.push(`Версия ${target} (канал ${name}) не найдена среди загруженных релизов`);
          } else {
            clean.channels[name].target = target;
          }
        }
        const percent = cfg.rolloutPercent ?? 0;
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
          problems.push(`rolloutPercent канала ${name} — целое число от 0 до 100`);
        } else {
          clean.channels[name].rolloutPercent = percent;
        }
      }
    }
  }

  const minVersion = draft.minVersion ?? null;
  if (minVersion !== null) {
    const stableTarget = clean.channels.stable.target;
    if (!isValidVersion(minVersion)) {
      problems.push(`minVersion — неверная версия: ${String(minVersion).slice(0, 64)}`);
    } else if (!stableTarget) {
      problems.push('minVersion требует target канала stable');
    } else if (compareVersions(minVersion, stableTarget) > 0) {
      problems.push(`minVersion (${minVersion}) не может быть больше target канала stable (${stableTarget})`);
    } else {
      clean.minVersion = minVersion;
    }
  }

  if (draft.checkIntervalMinutes !== undefined) {
    const m = draft.checkIntervalMinutes;
    if (!Number.isInteger(m) || m < 30 || m > 1440) problems.push('checkIntervalMinutes — целое число от 30 до 1440');
    else clean.checkIntervalMinutes = m;
  }

  const message = draft.message ?? null;
  if (message !== null) {
    if (typeof message !== 'string') problems.push('message должно быть строкой');
    else if (message.length > MESSAGE_MAX) problems.push(`message — не длиннее ${MESSAGE_MAX} символов`);
    else if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(message)) problems.push('message содержит управляющие символы');
    else clean.message = message.trim() || null;
  }

  if (problems.length) throw new UpdatePolicyError(problems.join('; '), problems);
  return clean;
}

// ── Хранение ───────────────────────────────────────────────────────────────

/**
 * Действующая политика. Читается из снимка настроек в памяти: маршруты
 * /updates открыты без входа, и поход в базу на каждый запрос был бы готовым
 * способом нагрузить её снаружи.
 */
function getPolicy() {
  const raw = SettingsService.getSettingSync('update_policy', null);
  if (!raw) return clonePolicy(DEFAULT_POLICY);
  try {
    return validatePolicy(JSON.parse(raw), null);
  } catch (err) {
    // Испорченная запись не должна раздавать что попало: выключено.
    console.warn('[Updates] сохранённая политика обновлений не прошла проверку:', err.message);
    return clonePolicy(DEFAULT_POLICY);
  }
}

async function setPolicy(draft, actor, { ip = null } = {}) {
  const { getUpdateStore } = require('./update-store.service');
  const clean = validatePolicy(draft, getUpdateStore().listReleases());
  await SettingsService.setSetting('update_policy', JSON.stringify(clean));
  AuditService.log({ userId: actor?.id ?? null, action: 'update_policy_changed', ip, details: { policy: clean } });
  return clean;
}

function isDisabledByEnv() {
  return Boolean(config.UPDATES_DISABLED);
}

module.exports = {
  CHANNELS,
  DEFAULT_POLICY,
  UpdatePolicyError,
  compareVersions,
  isValidVersion,
  bucketOf,
  decide,
  validatePolicy,
  getPolicy,
  setPolicy,
  isDisabledByEnv
};
