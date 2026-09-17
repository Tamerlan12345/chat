const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { freshBoot, closeAll } = require('./helpers/boot');

// Второй круг доработки безопасности: короткие токены и настоящий выход,
// политика содержимого, журнал аудита с цепочкой отпечатков, оповещения
// безопасности, самопроверка, выключатель удалённого стола, пароли,
// зашифрованные резервные копии. Каждый тест — атака или сбой, которые должны
// быть замечены или остановлены.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.BACKUP_ENCRYPTION_KEY = 'ключ-шифрования-копий-для-теста-0123456789';
process.env.TOKEN_REFRESH_GRACE_SECONDS = '1';

let baseUrl;
let wsUrl;
let server;
let identity;
let UserService;
let AuthService;
let config;
const people = {};

test.before(async () => {
  ({ identity } = await freshBoot());
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  config = require('../src/config');
  await require('../src/services/settings.service').load();
  const app = require('../src/app');
  const wsServer = require('../src/ws/server');
  server = http.createServer(app);
  wsServer.init(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, token: AuthService.generateToken(await UserService.getUserById(admin.id)) };

  for (const [username, full_name] of [['ivanov', 'Иванов Иван'], ['petrova', 'Петрова Анна']]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: AuthService.generateToken(await UserService.getUserById(created.id)) };
  }
});

test.after(async () => {
  const wsServer = require('../src/ws/server');
  wsServer.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  for (const name of fs.existsSync(config.BACKUPS_DIR) ? fs.readdirSync(config.BACKUPS_DIR) : []) {
    if (name.includes('-backup-')) fs.rmSync(path.join(config.BACKUPS_DIR, name), { force: true });
  }
  await closeAll();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, urlPath, { body, token, rawBody } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body || rawBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(rawBody ? { body: rawBody } : body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function connect(name) {
  const sock = new WebSocket(wsUrl);
  const client = { sock, inbox: [], closed: false };
  sock.on('message', (raw, isBinary) => {
    if (!isBinary) {
      try { client.inbox.push(JSON.parse(raw.toString('utf8'))); } catch {}
    }
  });
  sock.on('close', () => { client.closed = true; });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.on('open', resolve));
  sock.send(JSON.stringify({ type: 'auth', token: people[name].token }));
  await waitFor(client, (m) => m.type === 'auth_success');
  return client;
}

async function waitFor(client, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = client.inbox.find(predicate);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error('событие не пришло за отведённое время');
}

function signToken(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}

// ── Токены ─────────────────────────────────────────────────────────────────

test('продление выдаёт новый токен, старый отзывается, соединение живёт', async () => {
  const sock = await connect('ivanov');
  const old = people.ivanov.token;
  const res = await api('POST', '/api/auth/refresh', { token: old });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.token && res.json.token !== old);
  // Запросы, ушедшие со старым токеном за миг до продления, ещё проходят…
  assert.strictEqual((await api('GET', '/api/auth/me', { token: old })).status, 200, 'пауза после продления');
  await sleep(1200);
  // …а после паузы старый токен отозван.
  assert.strictEqual((await api('GET', '/api/auth/me', { token: old })).status, 401, 'старый токен отозван');
  people.ivanov.token = res.json.token;
  assert.strictEqual((await api('GET', '/api/auth/me', { token: people.ivanov.token })).status, 200);

  // Перепроверка соединения идёт по новому токену — соединение не закрывается.
  await require('../src/ws/server').revalidateAll();
  await sleep(100);
  assert.strictEqual(sock.closed, false);
  sock.sock.close();
});

test('выход отзывает токен', async () => {
  const token = AuthService.generateToken(await UserService.getUserById(people.petrova.id));
  assert.strictEqual((await api('POST', '/api/auth/logout', { token })).status, 200);
  assert.strictEqual((await api('GET', '/api/auth/me', { token })).status, 401);
});

test('токены чужого назначения, без подписи и слишком старые не принимаются', async () => {
  const now = Math.floor(Date.now() / 1000);
  const base = { userId: people.ivanov.id, tv: 1, iat: now, exp: now + 3600, auth_time: now, amr: 'pwd', jti: 'x1' };
  assert.strictEqual((await api('GET', '/api/auth/me', { token: signToken({ ...base, iss: 'другой', aud: 'openmychat-client' }) })).status, 401);
  assert.strictEqual((await api('GET', '/api/auth/me', { token: signToken({ ...base, iss: 'openmychat-server', aud: 'openmychat-client' }, { alg: 'none' }) })).status, 401);
  const tooOld = { ...base, iss: 'openmychat-server', aud: 'openmychat-client', auth_time: now - 40 * 86400 };
  assert.strictEqual((await api('GET', '/api/auth/me', { token: signToken(tooOld) })).status, 401, 'сессия старше 30 дней');
});

test('секрет устройства привязывается только сразу после входа по паролю', async () => {
  const now = Math.floor(Date.now() / 1000);
  const user = await UserService.getUserById(people.ivanov.id);
  const stale = signToken({
    userId: user.id, tv: Number(user.token_version), iss: 'openmychat-server', aud: 'openmychat-client',
    iat: now, exp: now + 3600, auth_time: now - 3600, amr: 'pwd', jti: crypto.randomBytes(8).toString('hex')
  });
  const byDevice = AuthService.generateToken(user, { amr: 'device' });
  const body = { device_id: 'dev-x', device_secret: crypto.randomBytes(32).toString('base64url') };
  assert.strictEqual((await api('POST', '/api/auth/device/claim', { token: stale, body })).status, 403);
  assert.strictEqual((await api('POST', '/api/auth/device/claim', { token: byDevice, body })).status, 403);
});

// ── Заголовки и тело запроса ───────────────────────────────────────────────

test('ответы несут политику содержимого', async () => {
  const res = await api('GET', '/api/settings/info');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('крупное тело до проверки входа не разбирается', async () => {
  const big = JSON.stringify({ username: 'x', password: 'y'.repeat(400 * 1024) });
  const res = await api('POST', '/api/auth/login', { rawBody: big });
  assert.strictEqual(res.status, 413);
});

// ── Журнал аудита ──────────────────────────────────────────────────────────

test('подделка записи журнала обнаруживается и поднимает критическое оповещение', async () => {
  const AuditService = require('../src/services/audit.service');
  await AuditService.logNow({ userId: people.admin.id, action: 'test_event', details: { n: 1 } });
  await AuditService.logNow({ userId: people.admin.id, action: 'test_event', details: { n: 2 } });
  const ok = await api('GET', '/api/admin/audit/verify', { token: people.admin.token });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.ok, true, JSON.stringify(ok.json));
  assert.ok(ok.json.checked >= 2);

  const target = await identity.get(`SELECT id FROM audit_logs WHERE action = 'test_event' ORDER BY id ASC`);
  await identity.run(`UPDATE audit_logs SET details_json = $1 WHERE id = $2`, ['{"n":999}', target.id]);

  const broken = await api('GET', '/api/admin/audit/verify', { token: people.admin.token });
  assert.strictEqual(broken.json.ok, false);
  assert.strictEqual(broken.json.brokenAt, target.id);
  const alert = await identity.get(`SELECT severity FROM security_alerts WHERE rule = 'audit_chain_broken'`);
  assert.strictEqual(alert.severity, 'critical');

  // Вернуть как было, чтобы следующие проверки видели целый журнал.
  await identity.run(`UPDATE audit_logs SET details_json = $1 WHERE id = $2`, ['{"n":1}', target.id]);
});

test('удаление записи из журнала тоже обнаруживается', async () => {
  const AuditService = require('../src/services/audit.service');
  await AuditService.logNow({ action: 'test_delete', details: { n: 1 } });
  await AuditService.logNow({ action: 'test_delete', details: { n: 2 } });
  await AuditService.logNow({ action: 'test_delete', details: { n: 3 } });
  const rows = await identity.all(`SELECT id FROM audit_logs WHERE action = 'test_delete' ORDER BY id ASC`);
  const saved = await identity.get('SELECT * FROM audit_logs WHERE id = $1', [rows[1].id]);
  await identity.run('DELETE FROM audit_logs WHERE id = $1', [rows[1].id]);
  const result = await AuditService.verify();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.brokenAt, rows[2].id);
  await identity.run(
    `INSERT INTO audit_logs (id, user_id, action, details_json, ip_address, created_at, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [saved.id, saved.user_id, saved.action, saved.details_json, saved.ip_address, saved.created_at, saved.prev_hash, saved.hash]
  );
  assert.strictEqual((await AuditService.verify()).ok, true);
});

// ── Оповещения безопасности ────────────────────────────────────────────────

test('подбор пароля поднимает оповещение и оно приходит главному администратору', async () => {
  const adminSock = await connect('admin');
  for (let i = 0; i < 10; i++) {
    await api('POST', '/api/auth/login', { body: { username: `нет-такого-${i}`, password: 'подбор-пароля' } });
  }
  const live = await waitFor(adminSock, (m) => m.type === 'security_alert' && m.alert.rule === 'login_bruteforce_ip', 5000);
  assert.strictEqual(live.alert.severity, 'high');

  const list = await api('GET', '/api/admin/security/alerts?limit=50', { token: people.admin.token });
  const stored = list.json.find((a) => a.rule === 'login_bruteforce_ip');
  assert.ok(stored);
  const ack = await api('POST', `/api/admin/security/alerts/${stored.id}/ack`, { token: people.admin.token });
  assert.strictEqual(ack.status, 200);
  const again = await api('GET', '/api/admin/security/alerts?limit=50', { token: people.admin.token });
  assert.ok(again.json.find((a) => a.id === stored.id).acknowledged_at);
  adminSock.sock.close();
});

test('чтение переписки администратором поднимает оповещение', async () => {
  await api('GET', '/api/admin/audit/messages?q=договор', { token: people.admin.token });
  await sleep(200);
  const row = await identity.get(`SELECT severity FROM security_alerts WHERE rule = 'admin_read_messages'`);
  assert.strictEqual(row.severity, 'high');
});

test('центр безопасности недоступен сотруднику', async () => {
  for (const url of ['/api/admin/security/status', '/api/admin/security/alerts', '/api/admin/audit/verify', '/api/admin/audit']) {
    assert.strictEqual((await api('GET', url, { token: people.petrova.token })).status, 403, url);
  }
});

test('самопроверка сервера сообщает о небезопасных настройках', async () => {
  const res = await api('GET', '/api/admin/security/status', { token: people.admin.token });
  assert.strictEqual(res.status, 200, res.text);
  const ids = res.json.checks.map((c) => c.id);
  for (const id of ['jwt_secret', 'ip_allowlist', 'https', 'remote_desktop', 'backup_encryption', 'backup_recent', 'audit_chain']) {
    assert.ok(ids.includes(id), id);
  }
  const allowlist = res.json.checks.find((c) => c.id === 'ip_allowlist');
  assert.strictEqual(allowlist.status, 'warn', 'в тестах список адресов не задан');
  assert.ok(allowlist.recommendation);
});

// ── Удалённый стол ─────────────────────────────────────────────────────────

test('выключатель удалённого стола запрещает запросы и отдаётся приложению', async () => {
  const set = await api('PUT', '/api/admin/settings', { token: people.admin.token, body: { remote_desktop_enabled: 'false', rd_ice_servers: '' } });
  assert.strictEqual(set.status, 200, set.text);
  const rd = await api('GET', '/api/settings/rd', { token: people.ivanov.token });
  assert.deepStrictEqual(rd.json, { enabled: false, iceServers: [] });

  const operator = await connect('admin');
  await connect('ivanov');
  operator.sock.send(JSON.stringify({ type: 'rd_request', targetUserId: people.ivanov.id }));
  const denied = await waitFor(operator, (m) => m.type === 'rd_denied' || m.type === 'rd_requested');
  assert.strictEqual(denied.type, 'rd_denied');
  assert.match(denied.reason, /отключён/);

  const bad = await api('PUT', '/api/admin/settings', { token: people.admin.token, body: { rd_ice_servers: '[{"urls":"http://evil"}]' } });
  assert.strictEqual(bad.status, 400);
  const badBool = await api('PUT', '/api/admin/settings', { token: people.admin.token, body: { remote_desktop_enabled: 'да' } });
  assert.strictEqual(badBool.status, 400);
  await api('PUT', '/api/admin/settings', { token: people.admin.token, body: { remote_desktop_enabled: 'true' } });
  operator.sock.close();
});

// ── Пароли и справочник ────────────────────────────────────────────────────

test('слабый пароль из прошлого пускает, но требует смены', async () => {
  const created = await UserService.createUser({ username: 'oldweak', full_name: 'Старый Пароль', password: 'Временный-пароль-1' });
  await UserService.setMustChangePassword(created.id, false);
  const { hashPassword } = require('../src/db/identity/password');
  await identity.run('UPDATE users SET password_hash = $1, salt = NULL WHERE id = $2', [await hashPassword('123456'), created.id]);
  const res = await api('POST', '/api/auth/login', { body: { username: 'oldweak', password: '123456' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.user.must_change_password, 'после входа со слабым паролем — обязательная смена');
});

test('администратор не может задать слабый пароль', async () => {
  const res = await api('POST', `/api/admin/users/${people.petrova.id}/reset-password`, { token: people.admin.token, body: { password: '1' } });
  assert.strictEqual(res.status, 400);
});

test('ожидающие заявки не видны в справочнике сотрудников', async () => {
  await identity.run(
    `INSERT INTO users (username, password_hash, full_name, created_at, approval_status, is_active)
     VALUES ('pending1', 'x', 'Заявка Ожидающая', $1, 'pending', 1)`,
    [new Date().toISOString()]
  );
  const res = await api('GET', '/api/users', { token: people.ivanov.token });
  assert.ok(!res.json.some((u) => u.username === 'pending1'));
});

test('IPv6-адреса не склеиваются в один счётчик', () => {
  const { normalizeIp } = require('../src/services/ip-access.service');
  assert.strictEqual(normalizeIp('::ffff:10.0.0.7'), '10.0.0.7');
  assert.strictEqual(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.notStrictEqual(normalizeIp('2001:db8::1'), normalizeIp('2001:db8::2:1'));
});

// ── Резервные копии ────────────────────────────────────────────────────────

test('резервная копия шифруется, проверяется и расшифровывается', async () => {
  const res = await api('POST', '/api/admin/db/backup', { token: people.admin.token });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.encrypted, true);
  assert.strictEqual(res.json.filePath, undefined, 'путь на сервере не раскрывается');
  const names = res.json.files.map((f) => f.fileName);
  assert.ok(names.some((n) => n.startsWith('mychat-backup-') && n.endsWith('.db.enc')));
  assert.ok(names.some((n) => n.startsWith('identity-backup-') && n.endsWith('.enc')));

  const chat = path.join(config.BACKUPS_DIR, names.find((n) => n.startsWith('mychat-backup-')));
  const head = fs.readFileSync(chat).subarray(0, 16).toString('latin1');
  assert.ok(!head.startsWith('SQLite format 3'), 'на диске не открытая база');

  const { decryptFile } = require('../src/services/backup.service');
  const restored = path.join(config.BACKUPS_DIR, 'restore-check.db');
  await decryptFile(chat, restored, process.env.BACKUP_ENCRYPTION_KEY);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(restored, { readOnly: true });
  assert.strictEqual(Object.values(db.prepare('PRAGMA quick_check').get())[0], 'ok');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM channels').get().n >= 0);
  db.close();
  fs.rmSync(restored, { force: true });

  await assert.rejects(() => decryptFile(chat, restored, 'неверный-ключ-шифрования-копий-0123456789'));
  fs.rmSync(restored, { force: true });
});

// ── Исправления по ревью безопасности ──────────────────────────────────────

test('служебные значения журнала не отдаются и не меняются через настройки', async () => {
  const res = await api('GET', '/api/admin/settings', { token: people.admin.token });
  assert.ok(!Object.keys(res.json).some((k) => k.startsWith('audit_chain_')));
  const put = await api('PUT', '/api/admin/settings', { token: people.admin.token, body: { audit_chain_anchor: '{}' } });
  assert.strictEqual(put.status, 400);
});

test('токен прежнего формата и уже продлённый токен не продлеваются', async () => {
  const user = await UserService.getUserById(people.petrova.id);
  const legacy = signToken({ userId: user.id, username: user.username, tv: Number(user.token_version), exp: Date.now() + 3600000 });
  assert.strictEqual((await api('GET', '/api/auth/me', { token: legacy })).status, 200, 'старый токен ещё действует до срока');
  assert.strictEqual((await api('POST', '/api/auth/refresh', { token: legacy })).status, 401);

  const fresh = AuthService.generateToken(user);
  const first = await api('POST', '/api/auth/refresh', { token: fresh });
  assert.strictEqual(first.status, 200);
  const second = await api('POST', '/api/auth/refresh', { token: fresh });
  assert.strictEqual(second.status, 401, 'во время паузы тот же токен повторно не продлевается');
});

test('обрезанная или подменённая копия не расшифровывается и не оставляет файла', async () => {
  const { encryptFile, decryptFile } = require('../src/services/backup.service');
  const plain = path.join(config.BACKUPS_DIR, 'tamper-src.txt');
  const enc = path.join(config.BACKUPS_DIR, 'tamper.enc');
  const out = path.join(config.BACKUPS_DIR, 'tamper-out.txt');
  fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });
  fs.writeFileSync(plain, 'данные копии '.repeat(2000));
  await encryptFile(plain, enc, process.env.BACKUP_ENCRYPTION_KEY);
  const bytes = fs.readFileSync(enc);
  fs.writeFileSync(enc, bytes.subarray(0, bytes.length - 100));
  await assert.rejects(() => decryptFile(enc, out, process.env.BACKUP_ENCRYPTION_KEY));
  assert.ok(!fs.existsSync(out), 'непроверенные данные не попали на место копии');
  assert.ok(!fs.readdirSync(config.BACKUPS_DIR).some((n) => n.startsWith('tamper-out.txt.partial')));
  for (const f of [plain, enc]) fs.rmSync(f, { force: true });
});

// Проверки подделки журнала идут последними: восстанавливать цепочку после них
// не нужно.
test('обнуление отпечатков начала журнала не выдаёт его за «до цепочки»', async () => {
  const AuditService = require('../src/services/audit.service');
  await AuditService.logNow({ action: 'test_prefix', details: { n: 1 } });
  await AuditService.logNow({ action: 'test_prefix', details: { n: 2 } });
  const last = await identity.get(`SELECT id FROM audit_logs WHERE action = 'test_prefix' ORDER BY id DESC`);
  const saved = await identity.all('SELECT id, hash, prev_hash FROM audit_logs WHERE id < $1', [last.id]);
  await identity.run('UPDATE audit_logs SET hash = NULL WHERE id < $1', [last.id]);
  const result = await AuditService.verify();
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  for (const row of saved) await identity.run('UPDATE audit_logs SET hash = $1 WHERE id = $2', [row.hash, row.id]);
  assert.strictEqual((await AuditService.verify()).ok, true);
});

test('удаление якоря или контрольной точки журнала обнаруживается', async () => {
  const AuditService = require('../src/services/audit.service');
  const anchor = await identity.get(`SELECT value FROM server_settings WHERE key = 'audit_chain_anchor'`);
  await identity.run(`DELETE FROM server_settings WHERE key = 'audit_chain_anchor'`);
  assert.strictEqual((await AuditService.verify()).ok, false);
  await identity.run(`INSERT INTO server_settings (key, value, updated_at) VALUES ('audit_chain_anchor', $1, $2)`, [anchor.value, new Date().toISOString()]);
  await identity.run(`UPDATE server_settings SET value = $1 WHERE key = 'audit_chain_checkpoint'`, ['{"id":1,"hash":"x","mac":"подделка"}']);
  assert.strictEqual((await AuditService.verify()).ok, false);
});

test('обрезка хвоста журнала обнаруживается по контрольной точке', async () => {
  const AuditService = require('../src/services/audit.service');
  await AuditService.logNow({ action: 'test_tail', details: { n: 1 } });
  await AuditService.logNow({ action: 'test_tail', details: { n: 2 } });
  assert.strictEqual((await AuditService.verify()).ok, true);
  const last = await identity.get(`SELECT id FROM audit_logs ORDER BY id DESC`);
  await identity.run('DELETE FROM audit_logs WHERE id = $1', [last.id]);
  const result = await AuditService.verify();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.brokenAt, last.id);
});
