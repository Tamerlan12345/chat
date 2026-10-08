const crypto = require('node:crypto');
const http2 = require('node:http2');
const { signJwt } = require('./jwt');
const { APNS_ALERT_BODY } = require('./payload');

// Apple Push Notification service по HTTP/2 (node:http2) с токеном поставщика
// (ключ .p8, ES256) — без сертификатов и без SDK. Узел выбирается только из
// двух зашитых адресов по окружению токена (sandbox — сборки из Xcode/TestFlight
// разработчика, production — App Store/TestFlight); настройками его не сменить.

const APNS_HOSTS = Object.freeze({
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com'
});
// Apple: токен поставщика действителен час и обновлять его чаще раза в 20
// минут нельзя (TooManyProviderTokenUpdates). 50 минут — с запасом в обе стороны.
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const DEVICE_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
// Удаляется только токен, который Apple назвала недействительным (410 и
// BadDeviceToken). DeviceTokenNotForTopic — токен другого приложения: значит,
// неверен PUSH_APNS_BUNDLE_ID, это ошибка настройки, и токены не удаляются.
const INVALID_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered']);
const CONFIG_REASONS = new Set(['DeviceTokenNotForTopic', 'TopicDisallowed', 'BadTopic', 'InvalidProviderToken', 'MissingProviderToken']);

/** Ключ .p8 (PEM PKCS#8, EC P-256). «\n» из переменной окружения превращаются в переводы строк. */
function parseApnsKey(pem) {
  let key;
  try {
    key = crypto.createPrivateKey(String(pem || '').replace(/\\n/g, '\n'));
  } catch {
    throw new Error('ключ APNs не читается как PEM (.p8)');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('ключ APNs должен быть EC P-256 (.p8 из Apple Developer)');
  }
  return key;
}

/**
 * Транспорт HTTP/2 с одним соединением на узел (Apple просит держать
 * соединение, а не открывать его на каждое уведомление). Соединение не держит
 * процесс (unref) и закрывается после простоя.
 */
function createHttp2Transport({ idleMs = 5 * 60 * 1000 } = {}) {
  const sessions = new Map();
  const allowed = new Set(Object.values(APNS_HOSTS));

  function sessionFor(origin) {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(origin);
    const forget = () => { if (sessions.get(origin) === session) sessions.delete(origin); };
    session.on('error', forget);
    session.on('close', forget);
    session.on('goaway', () => { forget(); session.close(); });
    session.setTimeout(idleMs, () => session.close());
    session.unref();
    sessions.set(origin, session);
    return session;
  }

  function request({ origin, headers, body, timeoutMs = 10000 }) {
    if (!allowed.has(origin)) return Promise.reject(new Error('недопустимый узел APNs'));
    return new Promise((resolve, reject) => {
      let status = 0;
      let responseHeaders = {};
      const chunks = [];
      let stream;
      try {
        stream = sessionFor(origin).request(headers);
      } catch (err) {
        reject(err);
        return;
      }
      stream.setTimeout(timeoutMs, () => stream.close(http2.constants.NGHTTP2_CANCEL));
      stream.on('response', (h) => { status = Number(h[':status']); responseHeaders = h; });
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
      stream.on('close', () => { if (!status) reject(new Error('поток APNs закрыт без ответа')); });
      stream.end(body);
    });
  }

  return {
    request,
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    }
  };
}

function reasonOf(res) {
  try {
    return String(JSON.parse(res.body || '{}').reason || '');
  } catch {
    return '';
  }
}

/**
 * Заголовки apns-* и тело уведомления (без адреса и авторизации): сообщение —
 * alert с общей заглушкой; mutable-content зарезервирован для возможного будущего
 * расширения уведомлений (в приложении его пока нет); звонок — серверный формат PushKit VoIP (<bundle>.voip); «read» —
 * тихий background-push (content-available, приоритет 5): приложение снимает
 * показанные уведомления переписки. Apple тихие push не гарантирует.
 */
function apnsRequest({ bundleId, notification, nowMs }) {
  const call = notification.kind === 'call';
  if (notification.kind === 'read') {
    const headers = {
      'apns-topic': bundleId,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'apns-expiration': String(Math.floor(nowMs / 1000) + notification.ttlSeconds)
    };
    if (notification.collapseKey) headers['apns-collapse-id'] = notification.collapseKey;
    return { headers, payload: { aps: { 'content-available': 1 }, ...notification.data } };
  }
  const headers = {
    'apns-topic': call ? `${bundleId}.voip` : bundleId,
    'apns-push-type': call ? 'voip' : 'alert',
    'apns-priority': '10',
    // Срок звонка задаётся от времени вызова (expiresAtMs), а не от попытки.
    'apns-expiration': String(notification.expiresAtMs
      ? Math.floor(notification.expiresAtMs / 1000)
      : Math.floor(nowMs / 1000) + notification.ttlSeconds)
  };
  if (!call && notification.collapseKey) headers['apns-collapse-id'] = notification.collapseKey;
  const payload = call
    ? { ...notification.data }
    : {
      aps: {
        alert: { body: APNS_ALERT_BODY },
        sound: 'default',
        'mutable-content': 1,
        'thread-id': `${notification.data.conversationType}-${notification.data.targetId}`
      },
      ...notification.data
    };
  return { headers, payload };
}

class ApnsProvider {
  constructor({ key, keyId, teamId, bundleId, request = null, now = Date.now, timeoutMs = 10000 }) {
    this.key = key;
    this.keyId = keyId;
    this.teamId = teamId;
    this.bundleId = bundleId;
    this.now = now;
    this.timeoutMs = timeoutMs;
    if (request) {
      this.request = request;
    } else {
      this.transport = createHttp2Transport();
      this.request = this.transport.request;
    }
    this.cached = null; // { jwt, at }
  }

  get name() { return 'apns'; }

  providerToken(force = false) {
    const now = this.now();
    if (!force && this.cached && now - this.cached.at < PROVIDER_TOKEN_TTL_MS) return this.cached.jwt;
    const jwt = signJwt({ alg: 'ES256', header: { kid: this.keyId }, payload: { iss: this.teamId, iat: Math.floor(now / 1000) }, key: this.key });
    this.cached = { jwt, at: now };
    return jwt;
  }

  build(token, notification) {
    const { headers, payload } = apnsRequest({ bundleId: this.bundleId, notification, nowMs: this.now() });
    const jwt = this.providerToken();
    return {
      jwt,
      request: {
        headers: { ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${jwt}`, ...headers },
        body: JSON.stringify(payload)
      }
    };
  }

  /** Результат — как у FcmProvider.send. environment: 'sandbox' | 'production'. */
  async send({ token, environment, notification }) {
    if (typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) return { status: 'invalid', reason: 'MALFORMED_TOKEN' };
    const origin = APNS_HOSTS[environment];
    if (!origin) return { status: 'failed', reason: 'BAD_ENVIRONMENT' };
    try {
      const first = this.build(token, notification);
      let res = await this.request({ origin, ...first.request, timeoutMs: this.timeoutMs });
      if (res.status === 403 && reasonOf(res) === 'ExpiredProviderToken') {
        // Новый токен — только если отклонён тот, что ещё в кэше: параллельный
        // запрос мог уже обновить его, а частое обновление Apple запрещает.
        if (this.cached && this.cached.jwt === first.jwt) this.providerToken(true);
        res = await this.request({ origin, ...this.build(token, notification).request, timeoutMs: this.timeoutMs });
      }
      return this.classify(res);
    } catch {
      return { status: 'retry', reason: 'NETWORK' };
    }
  }

  classify(res) {
    if (res.status === 200) return { status: 'ok' };
    const reason = reasonOf(res);
    if (res.status === 410 || INVALID_TOKEN_REASONS.has(reason)) return { status: 'invalid', reason: reason || 'Unregistered' };
    if (CONFIG_REASONS.has(reason)) return { status: 'config', reason };
    if (res.status === 429 || res.status >= 500) return { status: 'retry', reason: reason || `HTTP_${res.status}` };
    return { status: 'failed', reason: reason || `HTTP_${res.status}` };
  }

  close() {
    this.transport?.close();
  }
}

module.exports = { ApnsProvider, parseApnsKey, apnsRequest, createHttp2Transport, APNS_HOSTS };
