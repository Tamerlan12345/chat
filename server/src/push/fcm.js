const crypto = require('node:crypto');
const { signJwt } = require('./jwt');

// Firebase Cloud Messaging HTTP v1 без SDK: токен доступа OAuth2 по JWT
// сервисного аккаунта (RS256), кэш до истечения, отправка одного сообщения.
//
// Адреса зашиты в код: token_uri из файла сервисного аккаунта НЕ используется
// (файл — внешний ввод; подменённый адрес увёл бы подписанное утверждение и
// превратил сервер в инструмент запросов к внутренней сети). Номер проекта
// проверяется по шаблону, прежде чем попасть в путь.

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_ORIGIN = 'https://fcm.googleapis.com';
const TOKEN_LIFETIME_S = 3600;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]{1,128}@[A-Za-z0-9.-]{1,128}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FCM_TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/;

/**
 * Проверяет сервисный аккаунт Firebase (разобранный JSON) и возвращает только
 * нужное: { projectId, clientEmail, keyId, privateKey: KeyObject }. Тексты
 * ошибок не содержат значений из файла.
 */
function parseServiceAccount(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('ожидается JSON-объект сервисного аккаунта');
  if (account.type !== 'service_account') throw new Error('type должен быть "service_account"');
  if (typeof account.project_id !== 'string' || !PROJECT_ID_RE.test(account.project_id)) throw new Error('project_id недопустим');
  if (typeof account.client_email !== 'string' || !EMAIL_RE.test(account.client_email)) throw new Error('client_email недопустим');
  if (account.private_key_id !== undefined && (typeof account.private_key_id !== 'string' || !KEY_ID_RE.test(account.private_key_id))) {
    throw new Error('private_key_id недопустим');
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(String(account.private_key || ''));
  } catch {
    throw new Error('private_key не читается как ключ PEM');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('private_key должен быть ключом RSA');
  return {
    projectId: account.project_id,
    clientEmail: account.client_email,
    keyId: account.private_key_id || null,
    privateKey
  };
}

function retryAfterMs(res) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS) : null;
}

async function readError(res) {
  try {
    const body = await res.json();
    const err = body?.error || {};
    const detail = (err.details || []).find((d) => d && typeof d.errorCode === 'string');
    return { status: String(err.status || ''), errorCode: detail ? detail.errorCode : '', message: String(err.message || '') };
  } catch {
    return { status: '', errorCode: '', message: '' };
  }
}

/**
 * Тело запроса FCM v1: только data (значения — строки, требование FCM) и
 * параметры доставки Android. Блока notification нет: уведомление с текстом
 * собирает само приложение, забрав текст с нашего сервера.
 */
function fcmMessageBody(token, notification) {
  const data = Object.fromEntries(Object.entries(notification.data).map(([k, v]) => [k, String(v)]));
  const android = { priority: 'HIGH', ttl: `${notification.ttlSeconds}s` };
  if (notification.collapseKey) android.collapse_key = notification.collapseKey;
  return { message: { token, data, android } };
}

class FcmProvider {
  /**
   * @param serviceAccount результат parseServiceAccount
   * @param fetch транспорт (подменяется в тестах)
   */
  constructor({ serviceAccount, fetch = globalThis.fetch, now = Date.now, timeoutMs = 10000 }) {
    this.account = serviceAccount;
    this.fetch = fetch;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cached = null; // { token, expiresAt }
    this.pending = null;
  }

  get name() { return 'fcm'; }

  get sendUrl() {
    return `${FCM_ORIGIN}/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`;
  }

  /** Токен доступа из кэша или новый (один запрос на всех ждущих). */
  accessToken(force = false) {
    if (!force && this.cached && this.now() < this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(this.cached.token);
    if (!this.pending) {
      this.pending = this.fetchAccessToken().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async fetchAccessToken() {
    const iat = Math.floor(this.now() / 1000);
    const assertion = signJwt({
      alg: 'RS256',
      header: { typ: 'JWT', ...(this.account.keyId ? { kid: this.account.keyId } : {}) },
      payload: { iss: this.account.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S },
      key: this.account.privateKey
    });
    const res = await this.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) {
      const err = new Error(`токен доступа Google не выдан: HTTP ${res.status}`);
      err.retry = res.status === 429 || res.status >= 500;
      throw err;
    }
    const body = await res.json();
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('ответ Google без access_token');
    const lifetime = Number.isFinite(Number(body.expires_in)) ? Math.min(Math.max(Number(body.expires_in), 60), 12 * 3600) : TOKEN_LIFETIME_S;
    this.cached = { token: body.access_token, expiresAt: this.now() + lifetime * 1000 };
    return body.access_token;
  }

  buildMessage(token, notification) {
    return fcmMessageBody(token, notification);
  }

  post(accessToken, body) {
    return this.fetch(this.sendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  /**
   * Отправка одному устройству. Результат: {status:'ok'} | {status:'invalid', reason}
   * (токен удалить) | {status:'retry', reason, retryAfterMs?} | {status:'failed', reason}.
   * Ни токен, ни ответ поставщика целиком в результат не попадают.
   */
  async send({ token, notification }) {
    if (typeof token !== 'string' || !FCM_TOKEN_RE.test(token)) return { status: 'invalid', reason: 'MALFORMED_TOKEN' };
    const body = this.buildMessage(token, notification);
    try {
      let access;
      try {
        access = await this.accessToken(false);
      } catch (err) {
        return err.retry === false ? { status: 'failed', reason: 'AUTH' } : { status: 'retry', reason: 'AUTH_UNAVAILABLE' };
      }
      let res = await this.post(access, body);
      if (res.status === 401) {
        try {
          access = await this.accessToken(true);
        } catch (err) {
          return err.retry === false ? { status: 'failed', reason: 'AUTH' } : { status: 'retry', reason: 'AUTH_UNAVAILABLE' };
        }
        res = await this.post(access, body);
      }
      return await this.classify(res);
    } catch {
      return { status: 'retry', reason: 'NETWORK' };
    }
  }

  async classify(res) {
    if (res.ok) return { status: 'ok' };
    const { errorCode, message } = await readError(res);
    if (res.status === 404 || errorCode === 'UNREGISTERED') return { status: 'invalid', reason: 'UNREGISTERED' };
    if (errorCode === 'SENDER_ID_MISMATCH') return { status: 'invalid', reason: 'SENDER_ID_MISMATCH' };
    if (res.status === 400 && /registration token/i.test(message)) return { status: 'invalid', reason: 'INVALID_TOKEN' };
    if (res.status === 429 || res.status >= 500) {
      const after = retryAfterMs(res);
      return after === null ? { status: 'retry', reason: `HTTP_${res.status}` } : { status: 'retry', reason: `HTTP_${res.status}`, retryAfterMs: after };
    }
    if (res.status === 401) return { status: 'failed', reason: 'AUTH' };
    return { status: 'failed', reason: errorCode || `HTTP_${res.status}` };
  }
}

module.exports = { FcmProvider, parseServiceAccount, fcmMessageBody, GOOGLE_TOKEN_URL, FCM_ORIGIN };
