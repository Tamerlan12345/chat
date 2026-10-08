const fs = require('node:fs');
const { parseServiceAccount } = require('./fcm');
const { parseApnsKey } = require('./apns');

// Учётные данные поставщиков — только из окружения или файла-секрета (не из
// консоли администратора и не из базы): угнанная учётная запись администратора
// не должна уметь перенаправить уведомления. Нет данных — push выключен,
// остальное работает как раньше. Ошибка в данных — поставщик выключен и
// предупреждение в журнал БЕЗ содержимого секрета.
//
//   FCM (Android):  PUSH_FCM_SERVICE_ACCOUNT_FILE — путь к JSON сервисного аккаунта
//                   или PUSH_FCM_SERVICE_ACCOUNT_JSON — сам JSON (секрет платформы)
//   APNs (iOS):     PUSH_APNS_KEY_FILE — путь к .p8, или PUSH_APNS_KEY — PEM (\n допустимы)
//                   PUSH_APNS_KEY_ID, PUSH_APNS_TEAM_ID, PUSH_APNS_BUNDLE_ID

const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const defaultReadFile = (p) => fs.readFileSync(p, 'utf8');

function readSecret(env, inlineName, fileName, readFile) {
  if (env[inlineName]) return { name: inlineName, value: String(env[inlineName]) };
  if (env[fileName]) {
    try {
      return { name: fileName, value: readFile(String(env[fileName])) };
    } catch {
      return { name: fileName, error: 'файл не читается' };
    }
  }
  return null;
}

function loadFcm(env, readFile, warnings) {
  const secret = readSecret(env, 'PUSH_FCM_SERVICE_ACCOUNT_JSON', 'PUSH_FCM_SERVICE_ACCOUNT_FILE', readFile);
  if (!secret) return null;
  if (secret.error) {
    warnings.push(`[Push] ${secret.name}: ${secret.error} — FCM (Android) выключен`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(secret.value);
  } catch {
    // Текст ошибки JSON.parse цитирует кусок входа — в журнал не идёт.
    warnings.push(`[Push] ${secret.name}: не разбирается как JSON — FCM (Android) выключен`);
    return null;
  }
  try {
    return { serviceAccount: parseServiceAccount(parsed) };
  } catch (err) {
    warnings.push(`[Push] ${secret.name}: ${err.message} — FCM (Android) выключен`);
    return null;
  }
}

function loadApns(env, readFile, warnings) {
  const any = ['PUSH_APNS_KEY', 'PUSH_APNS_KEY_FILE', 'PUSH_APNS_KEY_ID', 'PUSH_APNS_TEAM_ID', 'PUSH_APNS_BUNDLE_ID'].some((n) => env[n]);
  if (!any) return null;
  const off = (why) => {
    warnings.push(`[Push] ${why} — APNs (iOS) выключен`);
    return null;
  };
  const secret = readSecret(env, 'PUSH_APNS_KEY', 'PUSH_APNS_KEY_FILE', readFile);
  if (!secret) return off('не задан PUSH_APNS_KEY или PUSH_APNS_KEY_FILE');
  if (secret.error) return off(`${secret.name}: ${secret.error}`);
  const keyId = String(env.PUSH_APNS_KEY_ID || '');
  const teamId = String(env.PUSH_APNS_TEAM_ID || '');
  const bundleId = String(env.PUSH_APNS_BUNDLE_ID || '');
  if (!APPLE_ID_RE.test(keyId)) return off('PUSH_APNS_KEY_ID не задан или не 10 символов A–Z/0–9');
  if (!APPLE_ID_RE.test(teamId)) return off('PUSH_APNS_TEAM_ID не задан или не 10 символов A–Z/0–9');
  if (!BUNDLE_ID_RE.test(bundleId) || bundleId.length > 155) return off('PUSH_APNS_BUNDLE_ID не задан или недопустим');
  let key;
  try {
    key = parseApnsKey(secret.value);
  } catch (err) {
    return off(`${secret.name}: ${err.message}`);
  }
  return { key, keyId, teamId, bundleId };
}

function boundedInt(env, name, fallback, min, max) {
  const n = Number(env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** { fcm, apns, warnings, limits } из окружения. Секреты в warnings не попадают. */
function loadPushConfig(env = process.env, { readFile = defaultReadFile } = {}) {
  const warnings = [];
  const fcm = loadFcm(env, readFile, warnings);
  const apns = loadApns(env, readFile, warnings);
  return {
    fcm,
    apns,
    warnings,
    limits: {
      concurrency: boundedInt(env, 'PUSH_CONCURRENCY', 8, 1, 64),
      queueMax: boundedInt(env, 'PUSH_QUEUE_MAX', 10000, 10, 1000000),
      maxAttempts: boundedInt(env, 'PUSH_MAX_ATTEMPTS', 4, 1, 10)
    }
  };
}

/** Строка для журнала запуска: что включено. Без секретов. */
function describePushConfig(cfg) {
  const parts = [];
  if (cfg.fcm) parts.push(`FCM (Android, проект ${cfg.fcm.serviceAccount.projectId})`);
  if (cfg.apns) parts.push(`APNs (iOS, ${cfg.apns.bundleId})`);
  if (!parts.length) {
    return '[Push] Push-уведомления выключены: не заданы учётные данные FCM/APNs (см. .env.example). '
      + 'Чат и звонки работают как раньше; мобильные приложения узнают о новом при открытии.';
  }
  return `[Push] Push-уведомления включены: ${parts.join(', ')}. Через Google/Apple уходят только идентификаторы.`;
}

module.exports = { loadPushConfig, describePushConfig };
