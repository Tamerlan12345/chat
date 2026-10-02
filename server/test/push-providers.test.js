const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const RFC = require('./helpers/rfc7515-vectors.json');

// Поставщики push-уведомлений (задача 18): подпись JWT, FCM HTTP v1, APNs
// HTTP/2 и разбор настроек. Сеть не используется — транспорт подставляется.
// Ключи для FCM/APNs генерируются здесь же на время прогона: ни одного
// настоящего (и вообще ни одного приватного) ключа в репозитории нет, кроме
// опубликованных тестовых векторов RFC 7515.

const { signJwt, signCompact } = require('../src/push/jwt');
const { FcmProvider, parseServiceAccount, GOOGLE_TOKEN_URL } = require('../src/push/fcm');
const { ApnsProvider, parseApnsKey, APNS_HOSTS } = require('../src/push/apns');
const { notificationFor, APNS_ALERT_BODY } = require('../src/push/payload');
const { loadPushConfig, describePushConfig } = require('../src/push/config');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
const P8_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'centychat-test',
  private_key_id: 'kid-0001',
  private_key: RSA_PEM,
  client_email: 'push@centychat-test.iam.gserviceaccount.com',
  token_uri: 'http://169.254.169.254/evil'
};

const MESSAGE = notificationFor({ type: 'message', conversationType: 'direct', targetId: 7, messageId: 42 });
const CALL = notificationFor({ type: 'call', callerId: 7 });
const FCM_TOKEN = 'fcm_token-AbC:123_xyz-0123456789abcdefghijklmnop';
const APNS_TOKEN = 'a'.repeat(64);

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    input: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url')
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ── JWT ─────────────────────────────────────────────────────────────────────

test('JWT RS256: подпись совпадает с известным ответом RFC 7515 A.2', () => {
  const key = crypto.createPrivateKey({ key: RFC.rs256.jwk, format: 'jwk' });
  const [h, p] = RFC.rs256.jws.split('.');
  assert.strictEqual(signCompact(`${h}.${p}`, key, 'RS256'), RFC.rs256.jws);
});

test('JWT ES256: подпись — «сырые» r||s по 32 байта (RFC 7515 A.3), проверяется открытым ключом', () => {
  const key = crypto.createPrivateKey({ key: RFC.es256.jwk, format: 'jwk' });
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: RFC.es256.jwk.x, y: RFC.es256.jwk.y }, format: 'jwk' });
  const [h, p, rfcSig] = RFC.es256.jws.split('.');
  // Сам пример RFC проверяется в формате ieee-p1363 — это тот формат, что нужен JWS.
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(rfcSig, 'base64url')));
  const ours = signCompact(`${h}.${p}`, key, 'ES256').split('.');
  const sig = Buffer.from(ours[2], 'base64url');
  assert.strictEqual(sig.length, 64, 'r||s, не DER');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, sig));
});

test('JWT: signJwt собирает заголовок {alg, ...} и полезную нагрузку; неизвестный алгоритм — отказ', () => {
  const jwt = signJwt({ alg: 'ES256', header: { kid: 'ABC123DEFG' }, payload: { iss: 'TEAM', iat: 1 }, key: ec.privateKey });
  const d = decodeJwt(jwt);
  assert.deepStrictEqual(d.header, { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepStrictEqual(d.payload, { iss: 'TEAM', iat: 1 });
  assert.ok(crypto.verify('sha256', Buffer.from(d.input), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, d.signature));
  assert.throws(() => signJwt({ alg: 'none', payload: {}, key: ec.privateKey }));
  assert.throws(() => signJwt({ alg: 'HS256', payload: {}, key: ec.privateKey }));
});

// ── FCM ─────────────────────────────────────────────────────────────────────

function fcmHarness(responses) {
  const calls = [];
  let now = 1_800_000_000_000;
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === GOOGLE_TOKEN_URL) return json(200, { access_token: `access-${calls.length}`, expires_in: 3600, token_type: 'Bearer' });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next || json(200, { name: 'projects/centychat-test/messages/1' });
  };
  const provider = new FcmProvider({ serviceAccount: parseServiceAccount(SERVICE_ACCOUNT), fetch, now: () => now });
  return { provider, calls, advance: (ms) => { now += ms; }, now: () => now };
}

test('FCM: токен доступа — JWT RS256 сервисного аккаунта на фиксированный адрес Google; отправка — только id, без текста', async () => {
  const h = fcmHarness([]);
  const result = await h.provider.send({ token: FCM_TOKEN, notification: MESSAGE });
  assert.deepStrictEqual(result, { status: 'ok' });
  assert.strictEqual(h.calls.length, 2);

  const [tokenCall, sendCall] = h.calls;
  assert.strictEqual(tokenCall.url, 'https://oauth2.googleapis.com/token', 'token_uri из файла не используется');
  assert.strictEqual(tokenCall.init.method, 'POST');
  const form = new URLSearchParams(tokenCall.init.body);
  assert.strictEqual(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = decodeJwt(form.get('assertion'));
  assert.deepStrictEqual(assertion.header, { alg: 'RS256', typ: 'JWT', kid: 'kid-0001' });
  assert.strictEqual(assertion.payload.iss, SERVICE_ACCOUNT.client_email);
  assert.strictEqual(assertion.payload.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.strictEqual(assertion.payload.aud, 'https://oauth2.googleapis.com/token');
  assert.strictEqual(assertion.payload.exp - assertion.payload.iat, 3600);
  assert.ok(crypto.verify('sha256', Buffer.from(assertion.input), rsa.publicKey, assertion.signature));

  assert.strictEqual(sendCall.url, 'https://fcm.googleapis.com/v1/projects/centychat-test/messages:send');
  assert.strictEqual(sendCall.init.headers.Authorization, 'Bearer access-1');
  const body = JSON.parse(sendCall.init.body);
  assert.deepStrictEqual(body, {
    message: {
      token: FCM_TOKEN,
      data: { type: 'message', conversationType: 'direct', targetId: '7', messageId: '42' },
      android: { priority: 'HIGH', ttl: '86400s', collapse_key: 'm-direct-7' }
    }
  });
  assert.ok(!('notification' in body.message), 'нет блока notification: текст показывает само приложение');
});

test('FCM: звонок — высокий приоритет и ttl 30 с, без collapse_key (всё тело целиком)', async () => {
  const h = fcmHarness([]);
  await h.provider.send({ token: FCM_TOKEN, notification: CALL });
  assert.deepStrictEqual(JSON.parse(h.calls[1].init.body), {
    message: { token: FCM_TOKEN, data: { type: 'call', callerId: '7' }, android: { priority: 'HIGH', ttl: '30s' } }
  });
});

test('FCM: токен доступа кэшируется до истечения (с запасом минута), потом обновляется', async () => {
  const h = fcmHarness([]);
  await h.provider.send({ token: FCM_TOKEN, notification: MESSAGE });
  await h.provider.send({ token: FCM_TOKEN, notification: MESSAGE });
  assert.strictEqual(h.calls.filter((c) => c.url === GOOGLE_TOKEN_URL).length, 1);
  h.advance(3600 * 1000 - 59 * 1000);
  await h.provider.send({ token: FCM_TOKEN, notification: MESSAGE });
  assert.strictEqual(h.calls.filter((c) => c.url === GOOGLE_TOKEN_URL).length, 2);
});

test('FCM: 401 — токен доступа обновляется и отправка повторяется один раз', async () => {
  const h = fcmHarness([json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } })]);
  const result = await h.provider.send({ token: FCM_TOKEN, notification: MESSAGE });
  assert.deepStrictEqual(result, { status: 'ok' });
  assert.strictEqual(h.calls.filter((c) => c.url === GOOGLE_TOKEN_URL).length, 2);
});

test('FCM: разбор ответов — удаляется только UNREGISTERED; чужой проект и 404 без кода — ошибка настройки; повтор (Retry-After)', async () => {
  const fcmError = (status, code, errorCode, message = '') => json(status, {
    error: { code: status, status: code, message, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] }
  });
  const cases = [
    [fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), 'invalid'],
    [fcmError(400, 'INVALID_ARGUMENT', 'UNREGISTERED'), 'invalid'],
    [fcmError(404, 'NOT_FOUND', null), 'config'],
    [fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'), 'config'],
    [fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token'), 'failed'],
    [fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'), 'retry'],
    [fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'), 'retry'],
    [fcmError(500, 'INTERNAL', 'INTERNAL'), 'retry'],
    [new Error('socket hang up'), 'retry'],
    [fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Invalid value at message.data'), 'failed']
  ];
  for (const [response, expected] of cases) {
    const h = fcmHarness([response]);
    const result = await h.provider.send({ token: FCM_TOKEN, notification: MESSAGE });
    assert.strictEqual(result.status, expected, `${response instanceof Error ? response.message : response.status}`);
    assert.ok(!JSON.stringify(result).includes(FCM_TOKEN), 'токен не попадает в результат (и в журнал)');
  }
  const h = fcmHarness([fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED')]);
  // Retry-After в секундах.
  h.provider.fetch = async (url, init) => (url === GOOGLE_TOKEN_URL
    ? json(200, { access_token: 'x', expires_in: 3600 })
    : json(429, { error: { code: 429 } }, { 'retry-after': '7' }));
  assert.deepStrictEqual(await h.provider.send({ token: FCM_TOKEN, notification: MESSAGE }), { status: 'retry', reason: 'HTTP_429', retryAfterMs: 7000 });
});

test('FCM: сервисный аккаунт проверяется; ключ не попадает в текст ошибки', () => {
  const bad = (patch) => () => parseServiceAccount({ ...SERVICE_ACCOUNT, ...patch });
  assert.throws(bad({ type: 'authorized_user' }));
  assert.throws(bad({ project_id: '../../evil' }));
  assert.throws(bad({ project_id: 'a/b' }));
  assert.throws(bad({ client_email: 'not-an-email' }));
  // Заголовок PEM собирается из частей: в исходнике не должно быть ничего, похожего на ключ.
  const fakePem = ['-----BEGIN', ' PRIVATE KEY-----\nmusor\n-----END', ' PRIVATE KEY-----'].join('');
  assert.throws(bad({ private_key: fakePem }), (err) => !err.message.includes('musor'));
  assert.throws(bad({ private_key: P8_PEM }), /RSA/);
  const ok = parseServiceAccount(SERVICE_ACCOUNT);
  assert.strictEqual(ok.projectId, 'centychat-test');
  assert.ok(!JSON.stringify(Object.keys(ok)).includes('private_key'));
});

// ── APNs ────────────────────────────────────────────────────────────────────

function apnsHarness(responses) {
  const calls = [];
  let now = 1_800_000_000_000;
  const queue = [...responses];
  const request = async (req) => {
    calls.push(req);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next || { status: 200, headers: { 'apns-id': 'id' }, body: '' };
  };
  const provider = new ApnsProvider({ key: parseApnsKey(P8_PEM), keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'kz.centras.centychat', request, now: () => now });
  return { provider, calls, advance: (ms) => { now += ms; }, now: () => now };
}

const apnsError = (status, reason) => ({ status, headers: {}, body: JSON.stringify({ reason }) });

test('APNs: сообщение — alert с mutable-content и общей заглушкой, только id; заголовки по документации Apple', async () => {
  const h = apnsHarness([]);
  const result = await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: MESSAGE });
  assert.deepStrictEqual(result, { status: 'ok' });
  const [req] = h.calls;
  assert.strictEqual(req.origin, 'https://api.push.apple.com');
  assert.strictEqual(req.headers[':method'], 'POST');
  assert.strictEqual(req.headers[':path'], `/3/device/${APNS_TOKEN}`);
  assert.strictEqual(req.headers['apns-topic'], 'kz.centras.centychat');
  assert.strictEqual(req.headers['apns-push-type'], 'alert');
  assert.strictEqual(req.headers['apns-priority'], '10');
  assert.strictEqual(req.headers['apns-expiration'], String(Math.floor(h.now() / 1000) + 86400));
  assert.strictEqual(req.headers['apns-collapse-id'], 'm-direct-7');
  const jwt = decodeJwt(req.headers.authorization.replace(/^bearer /, ''));
  assert.deepStrictEqual(jwt.header, { alg: 'ES256', kid: 'KEYID12345' });
  assert.deepStrictEqual(jwt.payload, { iss: 'TEAMID1234', iat: Math.floor(h.now() / 1000) });
  assert.ok(crypto.verify('sha256', Buffer.from(jwt.input), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature));
  assert.deepStrictEqual(JSON.parse(req.body), {
    aps: { alert: { body: APNS_ALERT_BODY }, sound: 'default', 'mutable-content': 1, 'thread-id': 'direct-7' },
    type: 'message', conversationType: 'direct', targetId: 7, messageId: 42
  });
  assert.strictEqual(APNS_ALERT_BODY, 'Новое сообщение');

  await h.provider.send({ token: APNS_TOKEN, environment: 'sandbox', notification: MESSAGE });
  assert.strictEqual(h.calls[1].origin, 'https://api.sandbox.push.apple.com');
  assert.deepStrictEqual(APNS_HOSTS, { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' });
});

test('APNs: звонок — PushKit VoIP (<bundle>.voip, push-type voip), срок 30 с', async () => {
  const h = apnsHarness([]);
  await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: CALL });
  const [req] = h.calls;
  assert.strictEqual(req.headers['apns-topic'], 'kz.centras.centychat.voip');
  assert.strictEqual(req.headers['apns-push-type'], 'voip');
  assert.strictEqual(req.headers['apns-priority'], '10');
  assert.strictEqual(req.headers['apns-expiration'], String(Math.floor(h.now() / 1000) + 30));
  assert.ok(!('apns-collapse-id' in req.headers));
  assert.deepStrictEqual(JSON.parse(req.body), { type: 'call', callerId: 7 });
});

test('APNs: токен поставщика живёт 50 минут и выпускается заново после', async () => {
  const h = apnsHarness([]);
  await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: MESSAGE });
  h.advance(49 * 60 * 1000);
  await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: MESSAGE });
  assert.strictEqual(h.calls[0].headers.authorization, h.calls[1].headers.authorization);
  h.advance(2 * 60 * 1000);
  await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: MESSAGE });
  assert.notStrictEqual(h.calls[2].headers.authorization, h.calls[1].headers.authorization);
});

test('APNs: разбор ответов — удаляются только 410 и BadDeviceToken; чужой topic — ошибка настройки; ExpiredProviderToken — новый токен и повтор', async () => {
  const cases = [
    [apnsError(410, 'Unregistered'), 'invalid'],
    [apnsError(400, 'BadDeviceToken'), 'invalid'],
    [apnsError(400, 'DeviceTokenNotForTopic'), 'config'],
    [apnsError(400, 'ExpiredToken'), 'failed'],
    [apnsError(429, 'TooManyRequests'), 'retry'],
    [apnsError(500, 'InternalServerError'), 'retry'],
    [apnsError(503, 'ServiceUnavailable'), 'retry'],
    [new Error('ECONNRESET'), 'retry'],
    [apnsError(400, 'PayloadTooLarge'), 'failed'],
    [apnsError(403, 'InvalidProviderToken'), 'config']
  ];
  for (const [response, expected] of cases) {
    const h = apnsHarness([response]);
    const result = await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: MESSAGE });
    assert.strictEqual(result.status, expected, response instanceof Error ? response.message : JSON.parse(response.body).reason);
    assert.ok(!JSON.stringify(result).includes(APNS_TOKEN));
  }
  const h = apnsHarness([apnsError(403, 'ExpiredProviderToken')]);
  assert.deepStrictEqual(await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: MESSAGE }), { status: 'ok' });
  assert.strictEqual(h.calls.length, 2);
  // Недопустимый токен (не hex) не уходит в путь запроса вовсе.
  const bad = apnsHarness([]);
  assert.strictEqual((await bad.provider.send({ token: '../../3/device/x', environment: 'production', notification: MESSAGE })).status, 'invalid');
  assert.strictEqual(bad.calls.length, 0);
});

test('APNs: ExpiredProviderToken не обновляет токен, если его уже обновил параллельный запрос', async () => {
  const h = apnsHarness([]);
  let concurrent = null;
  let first = true;
  h.provider.request = async (req) => {
    h.calls.push(req);
    if (first) {
      first = false;
      // Пока этот запрос ждал ответа, другой уже получил отказ и обновил токен.
      h.advance(60 * 1000);
      h.provider.providerToken(true);
      concurrent = h.provider.cached.jwt;
      return apnsError(403, 'ExpiredProviderToken');
    }
    return { status: 200, headers: {}, body: '' };
  };
  assert.deepStrictEqual(await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: MESSAGE }), { status: 'ok' });
  assert.strictEqual(h.calls[1].headers.authorization, `bearer ${concurrent}`, 'повтор — с уже обновлённым токеном, без второго обновления');
  assert.strictEqual(h.provider.cached.jwt, concurrent);
});

test('APNs: срок звонка — от времени вызова (expiresAtMs), а не от попытки', async () => {
  const h = apnsHarness([]);
  const expiresAtMs = h.now() + 12_345;
  await h.provider.send({ token: APNS_TOKEN, environment: 'production', notification: { ...CALL, ttlSeconds: 13, expiresAtMs } });
  assert.strictEqual(h.calls[0].headers['apns-expiration'], String(Math.floor(expiresAtMs / 1000)));
});

test('APNs: ключ .p8 — только EC P-256', () => {
  assert.throws(() => parseApnsKey(RSA_PEM));
  assert.throws(() => parseApnsKey('мусор'));
  assert.strictEqual(parseApnsKey(P8_PEM.replace(/\n/g, '\\n')).asymmetricKeyDetails.namedCurve, 'prime256v1', 'переводы строк \\n из переменной окружения');
});

// ── Настройки ───────────────────────────────────────────────────────────────

test('Настройки: без переменных push выключен — понятная строка в журнал, без ошибок', () => {
  const cfg = loadPushConfig({});
  assert.strictEqual(cfg.fcm, null);
  assert.strictEqual(cfg.apns, null);
  assert.deepStrictEqual(cfg.warnings, []);
  assert.match(describePushConfig(cfg), /push-уведомления выключены/i);
});

test('Настройки: FCM из JSON или файла, APNs из ключа; ошибки — предупреждением без содержимого секрета', () => {
  const files = { '/run/secrets/fcm.json': JSON.stringify(SERVICE_ACCOUNT), '/run/secrets/AuthKey.p8': P8_PEM };
  const readFile = (p) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  };
  const full = loadPushConfig({
    PUSH_FCM_SERVICE_ACCOUNT_FILE: '/run/secrets/fcm.json',
    PUSH_APNS_KEY_FILE: '/run/secrets/AuthKey.p8',
    PUSH_APNS_KEY_ID: 'KEYID12345',
    PUSH_APNS_TEAM_ID: 'TEAMID1234',
    PUSH_APNS_BUNDLE_ID: 'kz.centras.centychat'
  }, { readFile });
  assert.strictEqual(full.fcm.serviceAccount.projectId, 'centychat-test');
  assert.strictEqual(full.apns.bundleId, 'kz.centras.centychat');
  assert.deepStrictEqual(full.warnings, []);
  const line = describePushConfig(full);
  assert.match(line, /FCM.*centychat-test/);
  assert.match(line, /APNs.*kz\.centras\.centychat/);
  assert.ok(!line.includes('PRIVATE KEY'));

  const inline = loadPushConfig({ PUSH_FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT) });
  assert.ok(inline.fcm);

  const broken = loadPushConfig({
    PUSH_FCM_SERVICE_ACCOUNT_JSON: '{"private_key": "СЕКРЕТ-НЕ-ПЕЧАТАТЬ", oops',
    PUSH_APNS_KEY: P8_PEM,
    PUSH_APNS_TEAM_ID: 'TEAMID1234',
    PUSH_APNS_BUNDLE_ID: 'kz.centras.centychat'
  });
  assert.strictEqual(broken.fcm, null);
  assert.strictEqual(broken.apns, null, 'нет PUSH_APNS_KEY_ID');
  assert.strictEqual(broken.warnings.length, 2);
  assert.ok(broken.warnings.every((w) => !w.includes('СЕКРЕТ') && !w.includes('PRIVATE KEY')), broken.warnings.join(' | '));
  assert.ok(broken.warnings.some((w) => w.includes('PUSH_FCM_SERVICE_ACCOUNT_JSON')));
  assert.ok(broken.warnings.some((w) => w.includes('PUSH_APNS_KEY_ID')));

  const badBundle = loadPushConfig({ PUSH_APNS_KEY: P8_PEM, PUSH_APNS_KEY_ID: 'KEYID12345', PUSH_APNS_TEAM_ID: 'TEAMID1234', PUSH_APNS_BUNDLE_ID: 'evil/../x' });
  assert.strictEqual(badBundle.apns, null);
});
