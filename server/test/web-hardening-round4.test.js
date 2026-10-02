const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freshBoot, closeAll } = require('./helpers/boot');

// Аудит безопасности, раунд 4 — веб-часть
// (docs/superpowers/specs/2026-09-29-security-audit-round4.md):
//   Р4-10 — поиск по переписке: предел частоты, длины, % и _ буквально;
//   Р4-11 — объём загрузок на сотрудника в час;
//   Р4-12 — общий потолок анонимных запросов с адреса;
//   Р4-13 — внутренние ошибки не уходят анонимному клиенту;
//   Р4-14 — отдача вложений: безопасный тип, ошибка чтения не роняет сервер;
//   Р4-15 — заголовки защиты на всех ответах, включая отказ по адресу;
//   Р4-16 — потолок ожидающих заявок на регистрацию;
//   Р4-17 — «стук» устройства с IPv6 хранит адрес целиком;
//   Р4-18 — длинная строка импорта оргструктуры отклоняется до разбора;
//   Р4-20 — служебные имена в настройках.
//
// Пороги уменьшены, адрес клиента задаётся X-Forwarded-For (сервер — за
// «доверенным прокси» 127.0.0.1): у каждого сценария свой адрес.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
// Пол потолка — 600 (значения ниже отклоняются к умолчанию); берём ровно пол,
// чтобы порог проверялся разумным числом запросов.
process.env.ANON_RATE_LIMIT_PER_MINUTE = '600';
process.env.UPLOAD_MAX_MB_PER_HOUR = '1';

let baseUrl;
let server;
let identity;
let chat;
let UserService;
let AuthService;
let SettingsService;
const people = {};

test.before(async () => {
  ({ identity, chat } = await freshBoot());
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  SettingsService = require('../src/services/settings.service');
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, token: AuthService.generateToken(await UserService.getUserById(admin.id)) };
  for (const username of ['w4_alice', 'w4_bob', 'w4_carol']) {
    const created = await UserService.createUser({ username, full_name: username, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: AuthService.generateToken(await UserService.getUserById(created.id)) };
  }
});

test.after(async () => {
  server?.close();
  await closeAll();
});

async function api(method, urlPath, { body, token, ip, headers = {}, raw } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
      ...headers
    },
    ...(raw !== undefined ? { body: raw } : body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

function uploadForm(filename, content) {
  const form = new FormData();
  form.append('file', new Blob([content]), filename);
  return form;
}

// ── Заголовки (Р4-15) ──────────────────────────────────────────────────────

test('заголовки защиты: CORP, X-Permitted-Cross-Domain-Policies, Origin-Agent-Cluster; API не кэшируется', async () => {
  for (const path of ['/health', '/api/settings/info']) {
    const res = await api('GET', path, { ip: '198.51.100.1' });
    assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'same-site', path);
    assert.strictEqual(res.headers.get('x-permitted-cross-domain-policies'), 'none', path);
    assert.strictEqual(res.headers.get('origin-agent-cluster'), '?1', path);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, path);
  }
  const apiRes = await api('GET', '/api/settings/info', { ip: '198.51.100.1' });
  assert.strictEqual(apiRes.headers.get('cache-control'), 'no-store');
});

test('страница отказа по адресу тоже несёт заголовки защиты', async () => {
  await SettingsService.setSetting('ip_blacklist', '198.51.100.66');
  try {
    const res = await api('GET', '/', { ip: '198.51.100.66', headers: { Accept: 'text/html' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy'));
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await SettingsService.setSetting('ip_blacklist', '');
  }
});

// ── Общий потолок анонимных запросов (Р4-12) ────────────────────────────────

test('потолок анонимных запросов ловит непубличный маршрут; /API в другом регистре тоже считается (case-bypass закрыт)', async () => {
  const ip = '198.51.100.2';
  let limited = null;
  // /api/users анониму — 401, но проходит через middleware потолка. Часть шлём
  // в верхнем регистре: маршрутизация Express нечувствительна к регистру, и
  // «/API/...» раньше проходил мимо потолка (воспроизведение e-case-bypass).
  for (let i = 0; i < 640 && limited === null; i++) {
    const path = i % 2 ? '/api/users' : '/API/users';
    const res = await api('GET', path, { ip });
    if (res.status === 429) limited = i;
  }
  assert.ok(limited !== null && limited >= 600 && limited <= 610, `потолок ~600 (сработал на ${limited})`);

  // Другой адрес — свой счёт.
  assert.notStrictEqual((await api('GET', '/api/users', { ip: '198.51.100.3' })).status, 429);
});

test('дешёвые публичные GET (/api/settings/info, /health) не считаются в потолок; токен-запрос — тоже', async () => {
  const ip = '198.51.100.4';
  for (let i = 0; i < 620; i++) {
    const res = await api('GET', i % 2 ? '/api/settings/info' : '/health', { ip });
    assert.strictEqual(res.status, 200, `${i}: ${res.status}`);
  }
  // Запрос с действующим токеном не анонимный — в потолок не идёт.
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await api('GET', '/api/users', { ip, token: people.w4_alice.token })).status, 200);
  }
});

test('/API/... в верхнем регистре получает Cache-Control: no-store (case-bypass закрыт)', async () => {
  const res = await api('GET', '/API/settings/info', { ip: '198.51.100.5' });
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});

// ── Вложения (Р4-11, Р4-14) ────────────────────────────────────────────────

test('вложение с опасным заявленным типом отдаётся как application/octet-stream', async () => {
  const up = await api('POST', '/api/files/upload', { token: people.w4_alice.token, ip: '198.51.100.4', raw: uploadForm('page.txt', 'просто текст') });
  assert.strictEqual(up.status, 201, up.text);
  const fileId = up.json.id;

  for (const [stored, served] of [
    ['text/html', 'application/octet-stream'],
    ['image/svg+xml', 'application/octet-stream'],
    ['image/png', 'image/png'],
    ['text/plain', 'text/plain; charset=utf-8']
  ]) {
    chat.prepare('UPDATE files SET mime_type = ? WHERE id = ?').run(stored, fileId);
    const res = await api('GET', `/api/files/download/${fileId}`, { token: people.w4_alice.token, ip: '198.51.100.4' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), served, stored);
    assert.match(res.headers.get('content-disposition') || '', /^attachment;/);
    assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
  }
});

test('ошибка чтения вложения — ответ 500, а сервер продолжает работать', async () => {
  const up = await api('POST', '/api/files/upload', { token: people.w4_bob.token, ip: '198.51.100.5', raw: uploadForm('broken.txt', 'x') });
  assert.strictEqual(up.status, 201, up.text);
  const config = require('../src/config');
  // Путь указывает на каталог: fs.existsSync — да, чтение — EISDIR.
  chat.prepare('UPDATE files SET path = ? WHERE id = ?').run(config.UPLOADS_DIR, up.json.id);
  const res = await api('GET', `/api/files/download/${up.json.id}`, { token: people.w4_bob.token, ip: '198.51.100.5' });
  assert.strictEqual(res.status, 500);
  const alive = await api('GET', '/health', { ip: '198.51.100.5' });
  assert.strictEqual(alive.status, 200, 'процесс жив');
});

test('оборванное скачивание не роняет сервер (обработчик close закрывает поток чтения)', async () => {
  // Файл кладём на диск и заводим строку напрямую — минуя часовую квоту загрузок
  // в этом наборе тестов; 8 МБ, чтобы поток не закончился мгновенно.
  const config = require('../src/config');
  const bigPath = require('node:path').join(config.UPLOADS_DIR, 'abort-dl.bin');
  fs.writeFileSync(bigPath, Buffer.alloc(8 * 1024 * 1024, 0x7a));
  const info = chat.prepare(
    'INSERT INTO files (uploader_id, original_name, stored_filename, file_size, mime_type, sha256, path, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(people.w4_alice.id, 'abort-dl.bin', 'abort-dl.bin', 8 * 1024 * 1024, 'application/octet-stream', 'x', bigPath, new Date().toISOString());
  const fileId = Number(info.lastInsertRowid);

  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const p = fetch(`${baseUrl}/api/files/download/${fileId}`, {
      headers: { Authorization: `Bearer ${people.w4_alice.token}`, 'X-Forwarded-For': '198.51.100.61' },
      signal: controller.signal
    }).then((r) => r.arrayBuffer()).catch(() => null);
    setTimeout(() => controller.abort(), 2);
    await p;
  }
  // Сервер жив и следующее скачивание проходит целиком.
  const ok = await api('GET', `/api/files/download/${fileId}`, { token: people.w4_alice.token, ip: '198.51.100.61' });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual((await api('GET', '/health', { ip: '198.51.100.61' })).status, 200);
});

test('объём загрузок на сотрудника в час ограничен (UPLOAD_MAX_MB_PER_HOUR)', async () => {
  const big = 'a'.repeat(1536 * 1024); // 1,5 МБ
  const first = await api('POST', '/api/files/upload', { token: people.w4_carol.token, ip: '198.51.100.6', raw: uploadForm('big1.txt', big) });
  assert.strictEqual(first.status, 201, first.text);
  const second = await api('POST', '/api/files/upload', { token: people.w4_carol.token, ip: '198.51.100.6', raw: uploadForm('big2.txt', big) });
  assert.strictEqual(second.status, 429, second.text);
  assert.match(second.json.error, /МБ в час/);
  // Предел — на сотрудника, а не на всех.
  const other = await api('POST', '/api/files/upload', { token: people.w4_bob.token, ip: '198.51.100.6', raw: uploadForm('small.txt', 'y') });
  assert.strictEqual(other.status, 201, other.text);
});

// ── Поиск по переписке (Р4-10) ─────────────────────────────────────────────

test('поиск: % и _ ищутся буквально, длинная строка отклоняется, частые запросы ограничены', async () => {
  const bobId = people.w4_bob.id;
  const send = (text) => api('POST', `/api/messages/direct/${bobId}`, { token: people.w4_alice.token, ip: '198.51.100.7', body: { text } });
  assert.strictEqual((await send('план выполнен на 100% в срок')).status, 201);
  assert.strictEqual((await send('план выполнен на 1000 единиц')).status, 201);

  const found = await api('GET', `/api/messages/search?q=${encodeURIComponent('100%')}`, { token: people.w4_alice.token, ip: '198.51.100.7' });
  assert.strictEqual(found.status, 200, found.text);
  assert.deepStrictEqual(found.json.map((m) => m.text), ['план выполнен на 100% в срок']);

  const underscore = await api('GET', `/api/messages/search?q=${encodeURIComponent('на_1')}`, { token: people.w4_alice.token, ip: '198.51.100.7' });
  assert.strictEqual(underscore.json.length, 0, '_ не совпадает с любым символом');

  const long = await api('GET', `/api/messages/search?q=${'я'.repeat(201)}`, { token: people.w4_alice.token, ip: '198.51.100.7' });
  assert.strictEqual(long.status, 400);

  let limited = false;
  for (let i = 0; i < 35 && !limited; i++) {
    const res = await api('GET', '/api/messages/search?q=план', { token: people.w4_alice.token, ip: '198.51.100.7' });
    if (res.status === 429) limited = true;
  }
  assert.ok(limited, 'после 30 поисков в минуту — 429');
});

// SQLite LIKE сравнивает без учёта регистра только ASCII: «отчёт» не находил
// «Отчёт». Мобильный поиск (задача 21) ищет кириллицей — регистр и «ё» не
// должны мешать, а % и _ по-прежнему буквальные.
test('поиск: кириллица без учёта регистра, «ё» равна «е», шаблонные символы буквальны', async () => {
  const bobId = people.w4_bob.id;
  const send = (text) => api('POST', `/api/messages/direct/${bobId}`, { token: people.w4_carol.token, ip: '198.51.100.8', body: { text } });
  assert.strictEqual((await send('Квартальный ОТЧЁТ по Ёлкам готов')).status, 201);
  assert.strictEqual((await send('Скидка 50% для отдела')).status, 201);
  const search = async (q) => {
    const res = await api('GET', `/api/messages/search?q=${encodeURIComponent(q)}`, { token: people.w4_carol.token, ip: '198.51.100.8' });
    assert.strictEqual(res.status, 200, res.text);
    return res.json.map((m) => m.text);
  };
  assert.deepStrictEqual(await search('отчёт'), ['Квартальный ОТЧЁТ по Ёлкам готов']);
  assert.deepStrictEqual(await search('КВАРТАЛЬНЫЙ'), ['Квартальный ОТЧЁТ по Ёлкам готов']);
  assert.deepStrictEqual(await search('отчет по елкам'), ['Квартальный ОТЧЁТ по Ёлкам готов']);
  assert.deepStrictEqual(await search('СКИДКА 50%'), ['Скидка 50% для отдела']);
  assert.deepStrictEqual(await search('50_'), [], '_ по-прежнему не шаблон');
});

// ── Регистрация (Р4-13, Р4-16) ─────────────────────────────────────────────

test('регистрация: при 200 ожидающих заявках новая получает 429', async () => {
  await SettingsService.updateSettings({ allow_registration: 'true' });
  try {
    const now = new Date().toISOString();
    for (let i = 0; i < 200; i++) {
      await identity.run(
        `INSERT INTO users (username, password_hash, full_name, approval_status, created_at, is_active)
         VALUES ($1, 'x', $2, 'pending', $3, 1)`,
        [`pending_${i}`, `Заявка ${i}`, now]
      );
    }
    const res = await api('POST', '/api/auth/register', {
      ip: '198.51.100.8', body: { username: 'late.comer', password: 'Поздний-пароль-9', full_name: 'Опоздавший' }
    });
    assert.strictEqual(res.status, 429, res.text);
  } finally {
    await identity.run(`DELETE FROM users WHERE username LIKE 'pending\\_%' ESCAPE '\\'`);
    await SettingsService.updateSettings({ allow_registration: 'false' });
  }
});

test('регистрация: внутренняя ошибка базы не уходит анонимному клиенту', async () => {
  await SettingsService.updateSettings({ allow_registration: 'true' });
  const original = AuthService.register;
  AuthService.register = async () => {
    const err = new Error('duplicate key value violates unique constraint "users_username_key"');
    err.code = '23505';
    throw err;
  };
  try {
    const res = await api('POST', '/api/auth/register', {
      ip: '198.51.100.9', body: { username: 'dup.user', password: 'Поздний-пароль-9', full_name: 'Дубль' }
    });
    assert.strictEqual(res.status, 400);
    assert.doesNotMatch(res.text, /users_username_key|duplicate key/);
  } finally {
    AuthService.register = original;
    await SettingsService.updateSettings({ allow_registration: 'false' });
  }
});

// ── «Стук» устройства по IPv6 (Р4-17) ──────────────────────────────────────

test('knock с IPv6 сохраняет адрес целиком, а не последнюю группу', async () => {
  const res = await api('POST', '/api/auth/knock', {
    ip: '2001:db8:4:5::abcd', body: { device_id: 'v6-device-001', device_name: 'ПК', platform: 'Windows', client_version: '1.1.0' }
  });
  assert.strictEqual(res.status, 200, res.text);
  const row = await identity.get('SELECT ip_address FROM pending_devices WHERE device_id = $1', ['v6-device-001']);
  assert.strictEqual(row.ip_address, '2001:db8:4:5::abcd');
});

// ── Знакомые адреса входа переживают перезапуск (ПР-I4) ─────────────────────

test('знакомые адреса: создаёт только allowCreate, продление/WS лишь обновляют; переживают перезапуск (I-2)', async () => {
  const TrustedSources = require('../src/services/trusted-sources.service');
  const uid = people.w4_carol.id;

  // Продление/WebSocket (allowCreate:false) НЕ заводят новый адрес.
  await TrustedSources.record(uid, '203.0.113.150', { allowCreate: false });
  assert.ok(
    !(await identity.get('SELECT 1 AS x FROM trusted_login_sources WHERE user_id = $1 AND ip_key = $2', [uid, '203.0.113.150'])),
    'без allowCreate новый адрес не заводится (украденный токен не сажает чужой адрес)'
  );

  // Вход по паролю / «стук» (allowCreate:true) — заводят.
  await TrustedSources.record(uid, '203.0.113.150', { allowCreate: true });
  assert.ok(await identity.get('SELECT 1 AS x FROM trusted_login_sources WHERE user_id = $1 AND ip_key = $2', [uid, '203.0.113.150']),
    'вход по паролю заводит знакомый адрес');

  // Имитация перезапуска: кэш сброшен, знакомость читается из базы.
  TrustedSources._reset();
  assert.strictEqual(await TrustedSources.isTrusted(uid, '203.0.113.150'), true, 'знакомость пережила перезапуск');
  assert.strictEqual(await TrustedSources.isTrusted(uid, '203.0.113.199'), false, 'незнакомый адрес — не знакомый');
  // И попал в обратный индекс «знаком хотя бы одному» (для предела проверок, I-C).
  await TrustedSources.primeReverseIndex();
  assert.strictEqual(TrustedSources.isFamiliarToAnyoneSync('203.0.113.150'), true);
});

test('после перезапуска адрес офиса знаком ещё до входа: индекс наполняется из last_login_ip (третий раунд, п.3)', async () => {
  const TrustedSources = require('../src/services/trusted-sources.service');
  const { rateLimitIpKey } = require('../src/services/ip-access.service');
  const uid = people.w4_alice.id;
  const officeIp = '198.51.100.240';
  // Сотрудник недавно входил по паролю с этого адреса (last_login_ip пишется
  // только после проверенного входа).
  await identity.run('UPDATE users SET last_login_ip = $1, last_login_at = $2 WHERE id = $3',
    [officeIp, new Date().toISOString(), uid]);
  // Перезапуск: память сброшена, индекс ещё не наполнен.
  TrustedSources._reset();
  assert.strictEqual(TrustedSources.isFamiliarToAnyoneSync(rateLimitIpKey(officeIp)), false, 'до наполнения — неизвестен');
  // Наполнение при старте (bootstrap вызывает primeReverseIndex).
  await TrustedSources.primeReverseIndex();
  assert.strictEqual(TrustedSources.isFamiliarToAnyoneSync(rateLimitIpKey(officeIp)), true,
    'адрес офиса знаком ещё до первого входа после перезапуска');
});

test('знакомые адреса: суточный предел на число новых адресов у одного сотрудника (I-2)', async () => {
  const TrustedSources = require('../src/services/trusted-sources.service');
  TrustedSources._reset();
  const uid = people.w4_bob.id;
  await identity.run('DELETE FROM trusted_login_sources WHERE user_id = $1', [uid]);
  // Больше 5 новых адресов за сутки — сверх предела не заводятся.
  for (let i = 0; i < 9; i++) await TrustedSources.record(uid, `10.20.${i}.0`, { allowCreate: true });
  const rows = await identity.all('SELECT ip_key FROM trusted_login_sources WHERE user_id = $1', [uid]);
  assert.ok(rows.length <= 5, `новых адресов за сутки не больше 5 (получено ${rows.length})`);
});

test('знакомый адрес создаётся успешным «стуком» устройства (allowCreate)', async () => {
  const TrustedSources = require('../src/services/trusted-sources.service');
  const uid = people.w4_carol.id;
  const now = new Date().toISOString();
  await identity.run(
    `INSERT INTO device_pairings (device_id, user_id, paired_at, is_active, secret_hash, secret_token_version, secret_user_id, secret_expires_at, secret_auth_time)
     VALUES ($1, $2, $3, 1, $4, $5, $2, $6, $3)`,
    ['ts-dev-1', uid, now, require('node:crypto').createHash('sha256').update('S'.repeat(43)).digest('hex'),
     (await identity.get('SELECT token_version FROM users WHERE id = $1', [uid])).token_version,
     new Date(Date.now() + 30 * 86400000).toISOString()]
  );
  const knock = await api('POST', '/api/auth/knock', { ip: '203.0.113.151', body: { device_id: 'ts-dev-1', device_secret: 'S'.repeat(43) } });
  assert.strictEqual(knock.status, 200, knock.text);
  await new Promise((r) => setTimeout(r, 60)); // recordAsync
  const knocked = await identity.get('SELECT ip_key FROM trusted_login_sources WHERE user_id = $1 AND ip_key = $2', [uid, '203.0.113.151']);
  assert.ok(knocked, '«стук» записал знакомый адрес');
  void TrustedSources;
});

// ── /updates: install-id не вытесняет адресные счётчики (I-B, воспроизведение k) ─

test('спрей случайными install-id в /updates не сбрасывает блокировку login-fail для того же адреса', async () => {
  const limiter = require('../src/services/rate-limiter');
  const { rateLimitIpKey } = require('../src/services/ip-access.service');
  const ip = '203.0.113.90';
  const ipKey = rateLimitIpKey(ip);
  const failOpts = { maxAttempts: 30, windowMs: 600000 };
  // Тесной делаем ОБЩУЮ (адресную) карту: если install-id попадали бы в неё,
  // спрей вытеснил бы login-fail. Ключи с install-id живут в карте 'name'.
  limiter.configureLimiter({ maxBuckets: 40, nameMaxBuckets: 40 });
  try {
    for (let i = 0; i < 30; i++) limiter.registerFailure(`login-fail:${ipKey}`, failOpts);
    assert.ok(limiter.isRateLimited(`login-fail:${ipKey}`, failOpts), 'предпосылка: адрес заблокирован по login-fail');
    for (let i = 0; i < 200; i++) {
      await api('GET', '/updates/policy.json', { ip, headers: { 'X-MyChat-Install-Id': crypto.randomUUID() } });
    }
    assert.ok(limiter.isRateLimited(`login-fail:${ipKey}`, failOpts), 'после спрея install-id login-fail всё ещё заблокирован (I-B)');
  } finally {
    limiter.configureLimiter({});
    limiter.resetLimit(`login-fail:${ipKey}`);
  }
});

// ── knock считает только «пустые» стуки (M7) ────────────────────────────────

test('успешные «стуки» привязанного устройства не расходуют предел knock', async () => {
  const uid = people.w4_alice.id;
  const now = new Date().toISOString();
  const secret = 'K'.repeat(43);
  await identity.run(
    `INSERT INTO device_pairings (device_id, user_id, paired_at, is_active, secret_hash, secret_token_version, secret_user_id, secret_expires_at, secret_auth_time)
     VALUES ($1, $2, $3, 1, $4, $5, $2, $6, $3)`,
    ['knock-count-dev', uid, now, crypto.createHash('sha256').update(secret).digest('hex'),
     (await identity.get('SELECT token_version FROM users WHERE id = $1', [uid])).token_version,
     new Date(Date.now() + 30 * 86400000).toISOString()]
  );
  // 70 успешных «стуков» (порог «пустых» — 60): успех предел не расходует.
  for (let i = 0; i < 70; i++) {
    const res = await api('POST', '/api/auth/knock', { ip: '203.0.113.95', body: { device_id: 'knock-count-dev', device_secret: secret } });
    assert.strictEqual(res.status, 200, `стук ${i}: ${res.text}`);
    assert.strictEqual(res.json.status, 'paired', `стук ${i} должен быть paired`);
  }
});

// ── Свободное место перед загрузкой (M2, 507) ───────────────────────────────

test('загрузка отклоняется 507, когда на диске мало свободного места', async () => {
  const original = fs.promises.statfs;
  fs.promises.statfs = async () => ({ bsize: 4096, blocks: 1e6, bavail: 1, bfree: 1 }); // почти ноль свободно
  try {
    const res = await api('POST', '/api/files/upload', { token: people.w4_alice.token, ip: '198.51.100.60', raw: uploadForm('x.txt', 'данные') });
    assert.strictEqual(res.status, 507, res.text);
    assert.match(res.json.error, /свободного места/);
  } finally {
    fs.promises.statfs = original;
  }
});

// ── Администрирование (Р4-18, Р4-20) ───────────────────────────────────────

test('импорт оргструктуры: строка длиннее 2000 символов отклоняется до разбора', async () => {
  const text = `Компания/Отдел/Иванов Иван (${'x'.repeat(5000)})`;
  const started = Date.now();
  const res = await api('POST', '/api/admin/org/preview-import', { token: people.admin.token, ip: '198.51.100.10', body: { text } });
  assert.strictEqual(res.status, 400, res.text);
  assert.match(res.json.error, /2000/);
  assert.ok(Date.now() - started < 2000);
});

test('настройки: служебные имена __proto__, constructor, prototype отклоняются', async () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const res = await api('PUT', '/api/admin/settings', {
      token: people.admin.token, ip: '198.51.100.11', raw: `{"${key}":"x"}`, headers: { 'Content-Type': 'application/json' }
    });
    assert.strictEqual(res.status, 400, `${key}: ${res.text}`);
  }
  const ok = await api('PUT', '/api/admin/settings', { token: people.admin.token, ip: '198.51.100.11', body: { server_name: 'Сервер' } });
  assert.strictEqual(ok.status, 200, ok.text);
});

test('монитор безопасности: счётчики не растут без предела при потоке неудач с разных логинов', () => {
  const SecurityMonitor = require('../src/services/security-monitor.service');
  // Каждая неудача заводит два ключа (адрес и логин) — 6000 неудач дали бы
  // 12 000 свежих ключей; раньше карта в этом случае не чистилась вовсе.
  for (let i = 0; i < 6000; i++) {
    SecurityMonitor.onAuditEvent({ action: 'login_failed', ip: `10.0.${i >> 8}.${i & 255}`, details: { username: `spray_${i}` } });
  }
  const stats = SecurityMonitor.counterStats();
  assert.ok(stats.counters <= stats.max + 2, `в памяти ${stats.counters} ключей при потолке ${stats.max}`);
});
