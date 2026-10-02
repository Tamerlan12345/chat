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
