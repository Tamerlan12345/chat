const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { buildFixture, writeReleaseDir, tempDir } = require('./helpers/update-fixtures');

// Маршруты автообновления через настоящий HTTP: публичные /updates/* (их
// вызывает electron-updater до входа пользователя) и админские
// /api/admin/updates*. Каталог релизов — временный, пределы уменьшены, чтобы
// проверить 413 и 503 без гигабайтов.

const UPDATES_DIR = tempDir('omc-updates-routes-');
process.env.UPDATES_DIR = UPDATES_DIR;
process.env.UPDATES_MAX_FILE_MB = '1';
process.env.UPDATES_MAX_CONCURRENT_DOWNLOADS = '3';
process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
// Проверка раунда 4 (M7): предел частоты обновлений теперь по установке плюс
// высокий потолок на адрес. Здесь потолок на адрес занижен, чтобы проверить
// его немногими запросами; в бою по умолчанию 6000/мин, чтобы вместить офис.
process.env.UPDATES_MAX_REQ_PER_MIN_PER_IP = '120';

const { freshBoot, closeAll } = require('./helpers/boot');

let baseUrl;
let server;
let identity;
const people = {};
const fx = {};

test.before(async () => {
  ({ identity } = await freshBoot());
  const UserService = require('../src/services/user.service');
  const AuthService = require('../src/services/auth.service');
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id };

  const scopedRoleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;
  people.scoped = await UserService.createUser({
    username: 'scoped', full_name: 'Начальник Отдела', password: 'Рабочий-пароль-1',
    role_id: scopedRoleId, department_id: admin.department_id, admin_scope_dept_id: admin.department_id
  });
  await UserService.setMustChangePassword(people.scoped.id, false);
  people.ivanov = await UserService.createUser({ username: 'ivanov', full_name: 'Иванов Иван', password: 'Рабочий-пароль-1' });
  await UserService.setMustChangePassword(people.ivanov.id, false);

  for (const name of Object.keys(people)) {
    people[name].token = AuthService.generateToken(await UserService.getUserById(people[name].id));
  }

  fx.old = buildFixture('1.1.0');
  fx.cur = buildFixture('1.2.0', { withPortable: true });
  writeReleaseDir(path.join(UPDATES_DIR, 'inbox', 'rel-1.1.0'), fx.old);
  writeReleaseDir(path.join(UPDATES_DIR, 'inbox', 'rel-1.2.0'), fx.cur);
});

test.after(async () => {
  server?.close();
  await closeAll();
  fs.rmSync(UPDATES_DIR, { recursive: true, force: true });
});

async function api(method, urlPath, { body, token, headers = {} } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, json, text, buf };
}

// fetch нормализует «..» и %2e%2e в адресе ещё до отправки — для проверки
// обхода пути путь нужен ровно таким, каким его пришлёт злоумышленник.
function rawGet(rawPath, headers = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const clientHeaders = (installId, version = '1.1.0', kind = 'nsis', extra = {}) => ({
  'X-MyChat-Install-Id': installId,
  'X-MyChat-Client-Version': version,
  'X-MyChat-Install-Kind': kind,
  ...extra
});

async function waitForAudit(action) {
  for (let i = 0; i < 50; i += 1) {
    const row = await identity.get('SELECT * FROM audit_logs WHERE action = $1 ORDER BY id DESC LIMIT 1', [action]);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function tmpEntries() {
  const dir = path.join(UPDATES_DIR, '.tmp');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test('policy.json без релизов: 200, no-store, выключено', async () => {
  const res = await api('GET', '/updates/policy.json');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual(res.json, {
    enabled: false,
    channel: 'stable',
    offeredVersion: null,
    mandatory: false,
    minVersion: null,
    message: null,
    checkIntervalMinutes: 240,
    setupUrl: null,
    portableUrl: null
  });
});

test('latest.yml: выключено / без релизов → 404, неизвестный канал → 404', async () => {
  assert.strictEqual((await api('GET', '/updates/stable/latest.yml')).status, 404);
  assert.strictEqual((await api('GET', '/updates/beta/latest.yml')).status, 404);
  assert.strictEqual((await api('GET', '/updates/nightly/latest.yml')).status, 404);
});

test('админские маршруты: без токена 401, сотрудник и контурный админ 403, супер-админ 200', async () => {
  assert.strictEqual((await api('GET', '/api/admin/updates')).status, 401);
  assert.strictEqual((await api('GET', '/api/admin/updates', { token: people.ivanov.token })).status, 403);
  assert.strictEqual((await api('GET', '/api/admin/updates', { token: people.scoped.token })).status, 403);
  for (const who of ['ivanov', 'scoped']) {
    const t = people[who].token;
    assert.strictEqual((await api('PUT', '/api/admin/updates/policy', { token: t, body: { enabled: false } })).status, 403, who);
    assert.strictEqual((await api('POST', '/api/admin/updates/inbox/rel-1.2.0/import', { token: t, body: {} })).status, 403, who);
    assert.strictEqual((await api('DELETE', '/api/admin/updates/releases/1.2.0', { token: t })).status, 403, who);
    assert.strictEqual((await api('POST', '/api/admin/updates/releases', { token: t })).status, 403, who);
  }

  const res = await api('GET', '/api/admin/updates', { token: people.admin.token });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.disabledByEnv, false);
  assert.strictEqual(res.json.policy.enabled, false);
  assert.deepStrictEqual(res.json.releases, []);
  assert.deepStrictEqual(res.json.inbox.map((e) => e.name).sort(), ['rel-1.1.0', 'rel-1.2.0']);
  assert.deepStrictEqual(res.json.inbox.map((e) => e.problems), [[], []]);
  assert.deepStrictEqual(res.json.fleet, { total: 0, byVersion: {}, byKind: {}, errors: {} });
});

test('импорт из inbox через API: 201, аудит update_release_imported, обход пути отвергнут', async () => {
  for (const name of ['rel-1.1.0', 'rel-1.2.0']) {
    const res = await api('POST', `/api/admin/updates/inbox/${name}/import`, { token: people.admin.token, body: { notes: 'Заметки' } });
    assert.strictEqual(res.status, 201, res.text);
  }
  const audit = await waitForAudit('update_release_imported');
  assert.ok(audit, 'импорт попал в журнал');
  const details = JSON.parse(audit.details_json);
  assert.deepStrictEqual(details, { version: '1.2.0', sha512: fx.cur.sha512, size: fx.cur.setup.length });

  const again = await api('POST', '/api/admin/updates/inbox/rel-1.2.0/import', { token: people.admin.token, body: {} });
  assert.strictEqual(again.status, 404, 'папка уже перенесена');

  for (const bad of ['..%2F..', '%2e%2e', '..%5Coutside', 'a%00b', 'x'.repeat(65)]) {
    const res = await api('POST', `/api/admin/updates/inbox/${bad}/import`, { token: people.admin.token, body: {} });
    assert.ok([400, 404].includes(res.status), `${bad}: ${res.status}`);
  }

  const list = await api('GET', '/api/admin/updates', { token: people.admin.token });
  assert.deepStrictEqual(list.json.releases.map((r) => r.version), ['1.2.0', '1.1.0']);
  const rel = list.json.releases[0];
  assert.strictEqual(rel.importedBy, 'admin');
  assert.strictEqual(rel.notes, 'Заметки');
  assert.ok(rel.files.every((f) => f.name && Number.isInteger(f.size) && f.sha512));
});

test('PUT политики: ошибки → 400, верная → 200 и аудит update_policy_changed', async () => {
  const bad = [
    { enabled: true, channels: { stable: { target: '9.9.9', rolloutPercent: 25 } } },
    { enabled: true, channels: { stable: { target: '1.2.0', rolloutPercent: 250 } } },
    { enabled: true, checkIntervalMinutes: 5 },
    { enabled: 'yes' },
    []
  ];
  for (const body of bad) {
    const res = await api('PUT', '/api/admin/updates/policy', { token: people.admin.token, body });
    assert.strictEqual(res.status, 400, JSON.stringify(body));
    assert.ok(res.json.error);
  }

  const res = await api('PUT', '/api/admin/updates/policy', {
    token: people.admin.token,
    body: {
      enabled: true,
      channels: { stable: { target: '1.2.0', rolloutPercent: 100 }, beta: { target: null, rolloutPercent: 0 } },
      minVersion: '1.1.0',
      checkIntervalMinutes: 60,
      message: 'Исправлена передача файлов'
    }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.policy.channels.stable.target, '1.2.0');
  const audit = await waitForAudit('update_policy_changed');
  assert.ok(audit, 'изменение политики в журнале');
});

test('update_policy не меняется общим PUT настроек и не показывается в нём', async () => {
  for (const url of ['/api/admin/settings', '/api/settings']) {
    const res = await api('PUT', url, { token: people.admin.token, body: { update_policy: '{"enabled":false}' } });
    assert.strictEqual(res.status, 400, url);
  }
  const all = await api('GET', '/api/admin/settings', { token: people.admin.token });
  assert.strictEqual(all.status, 200);
  assert.ok(!('update_policy' in all.json));
  const policy = await api('GET', '/api/admin/updates', { token: people.admin.token });
  assert.strictEqual(policy.json.policy.enabled, true, 'политика не сброшена общим PUT');
});

test('policy.json и latest.yml после включения: 200, text/yaml, no-store', async () => {
  const id = crypto.randomUUID();
  const pol = await api('GET', '/updates/policy.json?channel=stable', { headers: clientHeaders(id, '1.1.0') });
  assert.strictEqual(pol.status, 200);
  assert.strictEqual(pol.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual(pol.json, {
    enabled: true,
    channel: 'stable',
    offeredVersion: '1.2.0',
    mandatory: false,
    minVersion: '1.1.0',
    message: 'Исправлена передача файлов',
    checkIntervalMinutes: 60,
    setupUrl: `/updates/stable/${fx.cur.setupName}`,
    portableUrl: `/updates/stable/${fx.cur.portableName}`
  });

  const old = await api('GET', '/updates/policy.json', { headers: clientHeaders(crypto.randomUUID(), '1.0.0') });
  assert.strictEqual(old.json.mandatory, true);

  const yml = await api('GET', '/updates/stable/latest.yml', { headers: clientHeaders(id) });
  assert.strictEqual(yml.status, 200, yml.text);
  assert.strictEqual(yml.headers.get('content-type'), 'text/yaml; charset=utf-8');
  assert.strictEqual(yml.headers.get('cache-control'), 'no-store');
  const { readYml } = require('../src/services/update-store.service');
  const feed = readYml(yml.text);
  assert.strictEqual(feed.version, '1.2.0');
  assert.strictEqual(feed.path, fx.cur.setupName);
  assert.strictEqual(feed.sha512, fx.cur.sha512);
  assert.deepStrictEqual(feed.files, [{ url: fx.cur.setupName, sha512: fx.cur.sha512, size: fx.cur.setup.length }]);
  assert.strictEqual(feed.releaseNotes, 'Заметки');
  assert.ok(!/stagingPercentage/.test(yml.text));
});

test('latest.yml без права на версию → 404; minVersion обходит раздачу', async () => {
  const setPolicy = (body) => api('PUT', '/api/admin/updates/policy', { token: people.admin.token, body });
  const res = await setPolicy({
    enabled: true,
    channels: { stable: { target: '1.2.0', rolloutPercent: 0 }, beta: { target: '1.1.0', rolloutPercent: 100 } },
    minVersion: '1.1.0'
  });
  assert.strictEqual(res.status, 200, res.text);

  assert.strictEqual((await api('GET', '/updates/stable/latest.yml', { headers: clientHeaders(crypto.randomUUID(), '1.1.0') })).status, 404);
  const pol = await api('GET', '/updates/policy.json', { headers: clientHeaders(crypto.randomUUID(), '1.1.0') });
  assert.strictEqual(pol.json.offeredVersion, null);
  assert.strictEqual(pol.json.setupUrl, null);
  assert.strictEqual((await api('GET', '/updates/stable/latest.yml', { headers: clientHeaders(crypto.randomUUID(), '1.0.5') })).status, 200);
  const beta = await api('GET', '/updates/beta/latest.yml');
  assert.strictEqual(beta.status, 200);
  assert.match(beta.text, /version: "1\.1\.0"/);

  // Выключение политикой — снова 404.
  await setPolicy({ enabled: false, channels: { stable: { target: '1.2.0', rolloutPercent: 100 }, beta: { target: null, rolloutPercent: 0 } } });
  assert.strictEqual((await api('GET', '/updates/stable/latest.yml')).status, 404);
  const off = await api('GET', '/updates/policy.json');
  assert.strictEqual(off.json.enabled, false);

  await setPolicy({ enabled: true, channels: { stable: { target: '1.2.0', rolloutPercent: 100 }, beta: { target: null, rolloutPercent: 0 } } });
});

test('файл: 200 с immutable, Range → 206', async () => {
  const res = await api('GET', `/updates/stable/${fx.cur.setupName}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.ok(res.buf.equals(fx.cur.setup));

  const part = await api('GET', `/updates/stable/${fx.cur.setupName}`, { headers: { Range: 'bytes=0-9' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.buf.length, 10);
  assert.ok(part.buf.equals(fx.cur.setup.subarray(0, 10)));

  // blockmap старой версии — electron-updater запрашивает его для
  // дифференциальной загрузки.
  const oldMap = await api('GET', `/updates/stable/${fx.old.blockmapName}`);
  assert.strictEqual(oldMap.status, 200);
  assert.ok(oldMap.buf.equals(fx.old.blockmap));
});

test('неизвестное имя и обход пути → 404', async () => {
  const setup = fx.cur.setupName;
  const paths = [
    '/updates/stable/release.json',
    '/updates/stable/latest.json',
    '/updates/stable/OpenMyChat-Enterprise-Setup-9.9.9.exe',
    '/updates/stable/..%2F..%2F..%2Fpackage.json',
    '/updates/stable/..%2Freleases%2F1.2.0%2Frelease.json',
    '/updates/stable/..%5C..%5Cpackage.json',
    '/updates/stable/%2e%2e',
    '/updates/stable/..',
    '/updates/stable/../../package.json',
    `/updates/stable/${setup}%00`,
    `/updates/stable/${setup}%00.txt`,
    `/updates/stable/C:%5CWindows%5Cwin.ini`,
    `/updates/stable/%2Fetc%2Fpasswd`,
    `/updates/stable/${'a'.repeat(129)}`,
    `/updates/nightly/${setup}`,
    `/updates/stable/__proto__`,
    `/updates/stable/constructor`
  ];
  for (const p of paths) {
    const res = await rawGet(p, { 'User-Agent': 'Electron' });
    assert.strictEqual(res.status, 404, `${p} → ${res.status}`);
    assert.ok(!res.body.includes('"version"'), p);
  }
});

test('запрос без «Electron» в UA доходит до /updates', async () => {
  const res = await api('GET', '/updates/policy.json', { headers: { 'User-Agent': 'curl/8.0' } });
  assert.strictEqual(res.status, 200);
  const file = await api('GET', `/updates/stable/${fx.cur.setupName}`, { headers: { 'User-Agent': 'curl/8.0' } });
  assert.strictEqual(file.status, 200);
});

test('предел одновременных скачиваний → 503 + Retry-After: 60; счётчик возвращается', async () => {
  const { downloadGate } = require('../src/updates/router');
  assert.strictEqual(downloadGate.active, 0, 'после завершённых скачиваний счётчик пуст');
  const held = [];
  while (downloadGate.tryAcquire()) held.push(true);
  assert.strictEqual(held.length, 3);
  const res = await api('GET', `/updates/stable/${fx.cur.setupName}`);
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.headers.get('retry-after'), '60');
  for (const _ of held) downloadGate.release();
  assert.strictEqual((await api('GET', `/updates/stable/${fx.cur.setupName}`)).status, 200);
  assert.strictEqual(downloadGate.active, 0);

  // Оборванное скачивание тоже освобождает место.
  await new Promise((resolve) => {
    const { port } = server.address();
    const req = http.get({ host: '127.0.0.1', port, path: `/updates/stable/${fx.cur.setupName}` }, (r) => {
      r.destroy();
      resolve();
    });
    req.on('error', resolve);
  });
  for (let i = 0; i < 50 && downloadGate.active !== 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(downloadGate.active, 0);
});

function uploadForm(f, { notes = 'Загружено через консоль', setup = f.setup } = {}) {
  const form = new FormData();
  form.append('notes', notes);
  form.append('yml', new Blob([f.yml]), 'latest.yml');
  form.append('setup', new Blob([setup]), f.setupName);
  if (f.blockmap) form.append('blockmap', new Blob([f.blockmap]), f.blockmapName);
  return form;
}

async function upload(form, token = people.admin.token) {
  const res = await fetch(`${baseUrl}/api/admin/updates/releases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

test('загрузка multipart: счастливый путь 201, повтор 409', async () => {
  const f = buildFixture('1.3.0-beta.1');
  const res = await upload(uploadForm(f));
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.json.version, '1.3.0-beta.1');
  assert.deepStrictEqual(tmpEntries(), [], 'временная папка загрузки убрана');

  const file = await api('GET', `/updates/beta/${f.setupName}`);
  assert.ok(file.buf.equals(f.setup));

  const again = await upload(uploadForm(f));
  assert.strictEqual(again.status, 409, again.text);
  assert.deepStrictEqual(tmpEntries(), []);
});

test('загрузка: превышение размера → 413, неверный файл → 400, хвостов нет', async () => {
  const big = buildFixture('1.4.0', { exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1024 * 1024 + 10)]) });
  const res = await upload(uploadForm(big));
  assert.strictEqual(res.status, 413, res.text);
  assert.ok(res.json.error);

  const f = buildFixture('1.4.0');
  const tampered = Buffer.from(f.setup);
  tampered[50] ^= 1;
  const bad = await upload(uploadForm(f, { setup: tampered }));
  assert.strictEqual(bad.status, 400, bad.text);
  assert.match(bad.json.error, /переподписан/);

  const stray = new FormData();
  stray.append('evil', new Blob(['x']), '../../evil.exe');
  assert.strictEqual((await upload(stray)).status, 400);
  const noSetup = new FormData();
  noSetup.append('yml', new Blob([f.yml]), 'latest.yml');
  assert.strictEqual((await upload(noSetup)).status, 400);

  // Даём файловой системе отпустить файлы, затем проверяем, что нет ни
  // временных папок, ни частичного релиза.
  for (let i = 0; i < 50 && tmpEntries().length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(tmpEntries(), []);
  assert.ok(!fs.existsSync(path.join(UPDATES_DIR, 'releases', '1.4.0')));
});

test('DELETE релиза: target → 409, иначе 200 и аудит update_release_deleted', async () => {
  const locked = await api('DELETE', '/api/admin/updates/releases/1.2.0', { token: people.admin.token });
  assert.strictEqual(locked.status, 409);

  const ok = await api('DELETE', '/api/admin/updates/releases/1.1.0', { token: people.admin.token });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.ok(await waitForAudit('update_release_deleted'));
  assert.strictEqual((await api('GET', `/updates/stable/${fx.old.blockmapName}`)).status, 404);

  assert.strictEqual((await api('DELETE', '/api/admin/updates/releases/1.1.0', { token: people.admin.token })).status, 404);
  assert.strictEqual((await api('DELETE', '/api/admin/updates/releases/..%2F1.2.0', { token: people.admin.token })).status, 400);
});

test('client_installs: запись троттлится, сводка по парку видна админу', async () => {
  const { installRecorder } = require('../src/updates/router');
  await installRecorder.idle();
  const id = crypto.randomUUID();
  await api('GET', '/updates/policy.json', { headers: clientHeaders(id, '1.1.0', 'portable', { 'X-MyChat-Update-Error': 'signature-foreign' }) });
  await installRecorder.idle();
  const first = await identity.get('SELECT * FROM client_installs WHERE install_id = $1', [id]);
  assert.ok(first, 'запись появилась');
  assert.strictEqual(first.client_version, '1.1.0');
  assert.strictEqual(first.install_kind, 'portable');
  assert.strictEqual(first.channel, 'stable');
  assert.strictEqual(first.last_error, 'signature-foreign');

  await api('GET', '/updates/stable/latest.yml', { headers: clientHeaders(id, '1.1.5', 'nsis') });
  await installRecorder.idle();
  const second = await identity.get('SELECT * FROM client_installs WHERE install_id = $1', [id]);
  assert.strictEqual(second.client_version, '1.1.0', 'повтор в течение 10 минут не пишется');
  assert.strictEqual(second.last_check_at, first.last_check_at);

  // Мусор в заголовках не попадает в базу.
  const junk = crypto.randomUUID();
  await api('GET', '/updates/policy.json', { headers: clientHeaders(junk, '<script>', 'evil', { 'X-MyChat-Update-Error': 'x'.repeat(500) }) });
  await installRecorder.idle();
  const junkRow = await identity.get('SELECT * FROM client_installs WHERE install_id = $1', [junk]);
  assert.strictEqual(junkRow.client_version, null);
  assert.strictEqual(junkRow.install_kind, null);
  assert.strictEqual(junkRow.last_error, null);

  const overview = await api('GET', '/api/admin/updates', { token: people.admin.token });
  assert.ok(overview.json.fleet.total >= 2);
  assert.strictEqual(overview.json.fleet.byKind.portable, 1);
  assert.strictEqual(overview.json.fleet.errors['signature-foreign'], 1);
  assert.ok(overview.json.fleet.byVersion['1.1.0'] >= 1);
});

test('client_installs: предел строк соблюдается, старые строки удаляются', async () => {
  const { createInstallRecorder, pruneClientInstalls } = require('../src/updates/client-installs');
  const recorder = createInstallRecorder({ maxRows: 1, throttleMs: 0 });
  await identity.run('DELETE FROM client_installs');
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  recorder.record({ installId: a, clientVersion: '1.0.0', kind: 'nsis', channel: 'stable', ip: '127.0.0.1' });
  await recorder.idle();
  recorder.record({ installId: b, clientVersion: '1.0.0', kind: 'nsis', channel: 'stable', ip: '127.0.0.1' });
  await recorder.idle();
  const rows = await identity.all('SELECT install_id FROM client_installs');
  assert.deepStrictEqual(rows.map((r) => r.install_id), [a], 'новый id сверх предела не записан');

  // Уже известный id обновляется и при заполненной таблице.
  recorder.record({ installId: a, clientVersion: '1.2.0', kind: 'nsis', channel: 'stable', ip: '127.0.0.1' });
  await recorder.idle();
  assert.strictEqual((await identity.get('SELECT client_version FROM client_installs WHERE install_id = $1', [a])).client_version, '1.2.0');

  const old = new Date(Date.now() - 91 * 86400000).toISOString();
  await identity.run('UPDATE client_installs SET last_check_at = $1', [old]);
  assert.strictEqual(await pruneClientInstalls(), 1);
  assert.strictEqual(Number((await identity.get('SELECT COUNT(*) AS n FROM client_installs')).n), 0);
});

// Ревью (задача 6): сводка для одного экрана консоли администратора, не
// полная выгрузка — без предела разнообразие версий в разросшемся парке
// растило бы объект fleet неограниченно на каждый /api/admin/updates.
test('fleetSummary: byVersion содержит не больше 50 записей на группу', async () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 55; i += 1) {
    await identity.run(
      `INSERT INTO client_installs
         (install_id, client_version, install_kind, channel, ip_address, last_error, first_seen_at, last_check_at)
       VALUES ($1, $2, 'nsis', 'stable', '127.0.0.1', NULL, $3, $3)`,
      [crypto.randomUUID(), `9.${i}.0`, now]
    );
  }
  const { fleetSummary } = require('../src/updates/client-installs');
  const summary = await fleetSummary();
  assert.ok(
    Object.keys(summary.byVersion).length <= 50,
    `byVersion вернул ${Object.keys(summary.byVersion).length} записей, ожидалось ≤50`
  );
  await identity.run('DELETE FROM client_installs');
});

test('latest.yml ограничен по частоте с одного адреса', async () => {
  let limited = null;
  for (let i = 0; i < 130; i += 1) {
    const res = await fetch(`${baseUrl}/updates/stable/latest.yml`);
    await res.arrayBuffer();
    if (res.status === 429) { limited = res; break; }
  }
  assert.ok(limited, 'после 120 запросов в минуту — 429');
  assert.strictEqual(limited.headers.get('retry-after'), '60');
});

// Ревью (задача 6): policy.json делит тот же счётчик 'upd:'+ip, что и
// latest.yml (предыдущий тест его уже исчерпал), — но, в отличие от
// latest.yml, не проваливает сам запрос: клиент по-прежнему получает 200,
// просто запись в client_installs пропускается сверх предела.
test('policy.json при исчерпанном (тем же) счётчике частоты по-прежнему отвечает 200, но не пишет client_installs', async () => {
  const { installRecorder } = require('../src/updates/router');
  const id = crypto.randomUUID();
  const res = await api('GET', '/updates/policy.json', { headers: clientHeaders(id, '1.1.0') });
  assert.strictEqual(res.status, 200, res.text);
  await installRecorder.idle();
  const row = await identity.get('SELECT install_id FROM client_installs WHERE install_id = $1', [id]);
  assert.ok(!row, 'запись должна была быть пропущена при исчерпанной частоте');
});
