const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

// Локальный стенд для мобильных клиентов (mobile/dev): сервер + TLS-прокси +
// сидирование. Тест поднимает всё на случайных портах, во временном каталоге
// данных, и входит как alice по HTTPS с доверием только к тестовому dev-CA.
//
// Сертификаты создаются в before() скриптом make-dev-ca.sh во временный каталог
// (ключи в репозиторий не попадают). Без openssl тест пропускается.

const REPO = path.resolve(__dirname, '../..');
const { spawnSync } = require('node:child_process');
const hasOpenssl = spawnSync('openssl', ['version']).status === 0 && spawnSync('bash', ['-c', 'true']).status === 0;
let FIX;
let ca;

let stand;
let dataDir;

function httpsJson(method, port, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'localhost', port, path: urlPath, method, ca,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  if (!hasOpenssl) return;
  FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'centy-dev-certs-'));
  const gen = spawnSync('bash', [path.join(REPO, 'mobile/dev/make-dev-ca.sh'), FIX], { env: { ...process.env, DEV_CERT_DAYS: '2' } });
  assert.strictEqual(gen.status, 0, String(gen.stderr));
  ca = fs.readFileSync(path.join(FIX, 'dev-ca.crt'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'centy-dev-stand-'));
  const { startStand } = await import(pathToFileURL(path.join(REPO, 'mobile/dev/stand.mjs')).href);
  stand = await startStand({
    dataDir,
    certDir: FIX,
    tlsPort: 0,
    serverPort: 0,
    quiet: true
  });
}, { timeout: 90000 });

test.after(async () => {
  await stand?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (FIX) fs.rmSync(FIX, { recursive: true, force: true });
});

test('alice logs in over HTTPS trusting only the dev CA', { skip: !hasOpenssl }, async () => {
  const res = await httpsJson('POST', stand.tlsPort, '/api/auth/login', {
    body: { username: 'alice', password: stand.seed.alice.password }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.user.username, 'alice');
  assert.ok(res.json.token);
  assert.ok(!res.json.user.must_change_password, 'seeded users must be able to log in straight away');
  assert.match(String(res.headers['strict-transport-security']), /max-age/, 'proxy marks the request as https');
});

test('a client without the dev CA is rejected', { skip: !hasOpenssl }, async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      https.get({ host: 'localhost', port: stand.tlsPort, path: '/api/health' }, resolve).on('error', reject);
    })
  );
});

test('WSS through the proxy returns auth_success', { skip: !hasOpenssl }, async () => {
  const login = await httpsJson('POST', stand.tlsPort, '/api/auth/login', {
    body: { username: 'alice', password: stand.seed.alice.password }
  });
  const frame = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`wss://localhost:${stand.tlsPort}/ws`, { ca });
    const timer = setTimeout(() => { sock.terminate(); reject(new Error('no auth_success')); }, 5000);
    sock.on('error', reject);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'auth', token: login.json.token })));
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'auth_success' || msg.type === 'auth_error') {
        clearTimeout(timer);
        sock.close();
        resolve(msg);
      }
    });
  });
  assert.strictEqual(frame.type, 'auth_success');
});

test('seed data: channel, direct and channel messages, announcement, attachment', { skip: !hasOpenssl }, async () => {
  const login = await httpsJson('POST', stand.tlsPort, '/api/auth/login', {
    body: { username: 'bob', password: stand.seed.bob.password }
  });
  assert.strictEqual(login.status, 200, login.text);
  const token = login.json.token;

  const channels = await httpsJson('GET', stand.tlsPort, '/api/channels', { token });
  assert.ok(channels.json.some((c) => c.name === '#mobile-dev'), 'seed channel exists');

  const users = await httpsJson('GET', stand.tlsPort, '/api/users', { token });
  const alice = users.json.find((u) => u.username === 'alice');
  const direct = await httpsJson('GET', stand.tlsPort, `/api/messages/direct/${alice.id}`, { token });
  assert.ok(direct.json.length >= 2, 'direct messages seeded');

  const channel = channels.json.find((c) => c.name === '#mobile-dev');
  const inChannel = await httpsJson('GET', stand.tlsPort, `/api/messages/channels/${channel.id}`, { token });
  assert.ok(inChannel.json.length >= 2, 'channel messages seeded');
  assert.ok(inChannel.json.some((m) => m.type === 'file'), 'attachment message seeded');

  const ann = await httpsJson('GET', stand.tlsPort, '/api/announcements', { token });
  assert.ok(ann.json.length >= 1, 'announcement seeded');
});

test('seeding twice is harmless', { skip: !hasOpenssl }, async () => {
  const { seed } = await import(pathToFileURL(path.join(REPO, 'mobile/dev/seed.mjs')).href);
  const again = await seed({ baseUrl: `http://127.0.0.1:${stand.serverPort}` });
  assert.strictEqual(again.alreadySeeded, true);
});

// ── Final review (server Minors 9–12): стенд не трогает боевое и чужое ──

test('стенд: сервер не наследует боевые настройки из окружения', async () => {
  const { standServerEnv } = await import(pathToFileURL(path.join(REPO, 'mobile/dev/stand.mjs')).href);
  const env = standServerEnv({
    PATH: '/usr/bin', SystemRoot: 'C:\\Windows', HOME: '/home/dev',
    DATABASE_URL: 'postgresql://prod', POSTGRES_URL: 'postgresql://prod', DATABASE_SSL: 'require', PGPASSWORD: 'x',
    SMTP_HOST: 'smtp.company', SMTP_PASS: 'x', PUSH_FCM_SERVICE_ACCOUNT_JSON: '{}', PUSH_APNS_KEY: 'k',
    FCM_SERVER_KEY: 'x', APNS_KEY_ID: 'x', JWT_SECRET: 'prod-secret', AUDIT_HMAC_KEY: 'x', BACKUP_ENCRYPTION_KEY: 'x',
    REGISTRATION_ALLOWED_EMAILS: '@company.kz', RAILWAY_ENVIRONMENT_NAME: 'production', NODE_ENV: 'production',
    ADMIN_PASSWORD_RESET: 'x', DATA_DIR: '/prod/data'
  });
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.SystemRoot, 'C:\\Windows');
  for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_SSL', 'PGPASSWORD', 'SMTP_HOST', 'SMTP_PASS',
    'PUSH_FCM_SERVICE_ACCOUNT_JSON', 'PUSH_APNS_KEY', 'FCM_SERVER_KEY', 'APNS_KEY_ID', 'JWT_SECRET', 'AUDIT_HMAC_KEY',
    'BACKUP_ENCRYPTION_KEY', 'REGISTRATION_ALLOWED_EMAILS', 'RAILWAY_ENVIRONMENT_NAME', 'NODE_ENV', 'ADMIN_PASSWORD_RESET', 'DATA_DIR']) {
    assert.ok(!(name in env), `${name} не передаётся серверу стенда`);
  }
});

test('стенд: порт по умолчанию 2014, порт 2004 (сервер владельца) не используется', async () => {
  const { DEFAULT_SERVER_PORT, startStand, assertNotReservedPort } = await import(pathToFileURL(path.join(REPO, 'mobile/dev/stand.mjs')).href);
  assert.strictEqual(DEFAULT_SERVER_PORT, 2014);
  assert.match(fs.readFileSync(path.join(REPO, 'mobile/dev/dev.env'), 'utf8'), /^SERVER_PORT=2014$/m);
  assert.throws(() => assertNotReservedPort(2004), /2004/);
  await assert.rejects(startStand({ serverPort: 2004, dataDir: path.join(os.tmpdir(), 'never-used'), certDir: path.join(os.tmpdir(), 'never-used'), quiet: true }), /2004/);

  // seed.mjs из командной строки: адрес обязателен, 2004 — отказ.
  const seedCli = path.join(REPO, 'mobile/dev/seed.mjs');
  const env = { ...process.env };
  delete env.SEED_BASE_URL;
  const noUrl = spawnSync(process.execPath, [seedCli], { env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(noUrl.status, 0);
  assert.match(noUrl.stderr, /base URL/i);
  const owner = spawnSync(process.execPath, [seedCli, 'http://127.0.0.1:2004'], { env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(owner.status, 0);
  assert.match(owner.stderr, /2004/);

  // tls-proxy.mjs сам по себе тоже не публикует порт 2004.
  const proxyCli = spawnSync(process.execPath, [path.join(REPO, 'mobile/dev/tls-proxy.mjs')], {
    env: { ...env, SERVER_PORT: '2004', TLS_CERT_DIR: path.join(os.tmpdir(), 'never-used') }, encoding: 'utf8', timeout: 20000
  });
  assert.notStrictEqual(proxyCli.status, 0);
  assert.match(proxyCli.stderr, /2004/);
});

test('TLS-прокси по умолчанию слушает только 127.0.0.1', { skip: !hasOpenssl }, async () => {
  const { startTlsProxy } = await import(pathToFileURL(path.join(REPO, 'mobile/dev/tls-proxy.mjs')).href);
  const proxy = await startTlsProxy({
    key: fs.readFileSync(path.join(FIX, 'dev-leaf.key')),
    cert: fs.readFileSync(path.join(FIX, 'dev-chain.crt')),
    listenPort: 0,
    targetPort: stand.serverPort
  });
  try {
    assert.strictEqual(proxy.server.address().address, '127.0.0.1');
  } finally {
    await proxy.close();
  }
});

test('dev CA ограничен именами стенда: сертификат на чужой адрес им не подписать', { skip: !hasOpenssl }, async () => {
  const text = spawnSync('openssl', ['x509', '-in', path.join(FIX, 'dev-ca.crt'), '-noout', '-text'], { encoding: 'utf8' }).stdout;
  assert.match(text, /Name Constraints: critical/);
  assert.match(text, /DNS:localhost/);
  // Лист на постороннее имя, подписанный тем же ключом CA, не проходит проверку.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'centy-evil-'));
  try {
    const run = (args) => spawnSync('openssl', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    fs.writeFileSync(path.join(dir, 'evil.ext'), 'subjectAltName = DNS:bank.example\n');
    assert.strictEqual(run(['genrsa', '-out', 'evil.key', '2048']).status, 0);
    assert.strictEqual(run(['req', '-new', '-key', 'evil.key', '-subj', '/CN=bank.example', '-out', 'evil.csr']).status, 0);
    assert.strictEqual(run(['x509', '-req', '-in', 'evil.csr', '-CA', path.join(FIX, 'dev-ca.crt'), '-CAkey', path.join(FIX, 'dev-ca.key'),
      '-CAcreateserial', '-CAserial', path.join(dir, 'ca.srl'), '-days', '1', '-extfile', 'evil.ext', '-out', 'evil.crt']).status, 0);
    const verdict = run(['verify', '-CAfile', path.join(FIX, 'dev-ca.crt'), 'evil.crt']);
    assert.notStrictEqual(verdict.status, 0, verdict.stdout + verdict.stderr);
    assert.match(verdict.stdout + verdict.stderr, /subtree|name constraint/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('стенд: самостоятельная регистрация включена (экран регистрации доступен в разработке)', { skip: !hasOpenssl }, async () => {
  const info = await httpsJson('GET', stand.tlsPort, '/api/settings/info');
  assert.strictEqual(info.status, 200, info.text);
  assert.strictEqual(info.json.allow_registration, true);
});
