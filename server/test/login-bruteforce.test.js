const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { freshBoot, closeAll } = require('./helpers/boot');

// Аудит безопасности, раунд 4 + проверка раунда 4
// (docs/superpowers/specs/2026-09-29-security-audit-round4.md).
// Главный принцип: переполнение ограничителей и подбор НЕ должны запирать вход
// сотрудникам, которых не атакуют, а офис за одним NAT не должен спотыкаться о
// пределы штатным трафиком.
//   Р4-01/ПР-I4 — задержка по учётной записи; знакомый адрес не задерживается;
//                 очередь у каждого адреса своя (атакующий не съедает окно);
//   Р4-02 — ключи по сети /64;
//   ПР-01 — карта ограничителя переполнена → вытеснение, не отказ (fail open);
//   ПР-02 — «в полёте» попытки не считаются неудачами; офис за NAT входит;
//   ПР-03 — несуществующий и существующий логин неотличимы (один IP и очередь);
//   Р4-06 — единая форма логина;
//   Р4-08/ПР-I5 — политика пароля, включая марочные основы.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
process.env.LOGIN_MAX_FAILED_ATTEMPTS = '3';
process.env.LOGIN_ACCOUNT_SOFT_LIMIT = '5';
process.env.LOGIN_ACCOUNT_MAX_DELAY_SECONDS = '2';

let baseUrl;
let server;
let identity;
let UserService;
let AuthService;
let LoginThrottle;

test.before(async () => {
  ({ identity } = await freshBoot());
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  LoginThrottle = require('../src/services/login-throttle.service');
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await closeAll();
});

async function api(method, urlPath, { body, token, ip, headers = {} } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

let userSeq = 0;
async function makeUser(password = 'Рабочий-пароль-1') {
  userSeq += 1;
  const username = `bf_user_${userSeq}`;
  const created = await UserService.createUser({ username, full_name: `Подбор ${userSeq}`, password });
  await UserService.setMustChangePassword(created.id, false);
  return { ...created, username, password };
}

async function loginWithRetry(username, password, ip, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    const res = await api('POST', '/api/auth/login', { ip, body: { username, password } });
    if (res.status !== 503 && res.status !== 429) return res;
    const ra = Number(res.headers.get('retry-after')) || 1;
    await new Promise((r) => setTimeout(r, Math.min(ra, 3) * 250));
  }
  return { status: 0 };
}

// ── Ограничитель: переполнение вытесняет, а не отказывает (ПР-01) ────────────

test('ограничитель: переполненная карта вытесняет самый старый ключ, а не отказывает новому', () => {
  const limiter = require('../src/services/rate-limiter');
  limiter.configureLimiter({ maxBuckets: 3 });
  try {
    const opts = { maxAttempts: 1, windowMs: 60000 };
    // Забиваем адресную карту действующими блокировками.
    for (const key of ['a', 'b', 'c']) assert.ok(limiter.checkRateLimit(key, opts));
    for (const key of ['a', 'b', 'c']) assert.ok(!limiter.checkRateLimit(key, opts), `${key} заблокирован`);
    // Новый ключ офиса всё равно проходит: вытеснился самый старый ('a').
    assert.ok(limiter.checkRateLimit('office', opts), 'новый ключ не должен получать отказ');
    // Счётчик «только неудач» для неизвестного ключа — «не ограничено» (fail open).
    assert.strictEqual(limiter.isRateLimited('never-seen', opts), false);
  } finally {
    limiter.configureLimiter({});
    for (const key of ['a', 'b', 'c', 'office']) limiter.resetLimit(key);
  }
});

test('ограничитель: спрей ключами с логином (scope name) не вытесняет адресные счётчики', () => {
  const limiter = require('../src/services/rate-limiter');
  limiter.configureLimiter({ maxBuckets: 100000, nameMaxBuckets: 50 });
  try {
    const addrOpts = { maxAttempts: 30, windowMs: 600000 };
    limiter.registerFailure('login-fail:198.51.100.10', addrOpts); // адрес офиса — в общей карте
    // Атакующий спреит ключи с логином в отдельной карте (scope name).
    for (let i = 0; i < 500; i++) {
      limiter.registerFailure(`login-lock:203.0.113.1:user${i}`, { ...addrOpts, scope: 'name' });
    }
    // Адресный счётчик офиса не пострадал: 1 неудача, не 30 → не ограничен.
    assert.strictEqual(limiter.isRateLimited('login-fail:198.51.100.10', addrOpts), false);
    assert.ok(limiter.limiterSize('name') <= 50, 'карта ключей с логином держит свой потолок');
  } finally {
    limiter.configureLimiter({});
    limiter.resetLimit('login-fail:198.51.100.10');
  }
});

// ── Воспроизведение b/g/i: один источник забивает карту, офис жив ────────────

test('переполнение адресной карты одним источником не отказывает офису (воспроизведение b/g)', () => {
  const limiter = require('../src/services/rate-limiter');
  limiter.configureLimiter({ maxBuckets: 1000 });
  try {
    const opt = { maxAttempts: 5, windowMs: 60000 };
    let made = 0;
    while (limiter.limiterSize() < 1000) {
      const key = `login-fail:203.0.113.${made % 250}:x${made}`;
      for (let i = 0; i < 5; i++) limiter.checkRateLimit(key, opt);
      made++;
    }
    assert.ok(limiter.checkRateLimit('anon:198.51.100.10', { maxAttempts: 12000, windowMs: 60000 }), 'офис: потолок анонимных');
    assert.strictEqual(limiter.isRateLimited('ws_auth:198.51.100.10', { maxAttempts: 10, windowMs: 60000 }), false, 'офис: ws_auth');
    assert.strictEqual(limiter.isRateLimited('login-fail:198.51.100.10', { maxAttempts: 30, windowMs: 600000 }), false, 'офис: login-fail');
    assert.ok(limiter.checkRateLimit('search:42', { maxAttempts: 30, windowMs: 60000 }), 'сотрудник: поиск');
  } finally {
    limiter.configureLimiter({});
  }
});

// ── Адреса IPv6 /64 (Р4-02) ──────────────────────────────────────────────────

test('rateLimitIpKey: одна сеть /64 — один ключ, другая — другой; IPv4 как есть', () => {
  const { rateLimitIpKey } = require('../src/services/ip-access.service');
  assert.strictEqual(rateLimitIpKey('2001:db8:1:2::1'), rateLimitIpKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'));
  assert.notStrictEqual(rateLimitIpKey('2001:db8:1:2::1'), rateLimitIpKey('2001:db8:1:3::1'));
  assert.strictEqual(rateLimitIpKey('203.0.113.9'), '203.0.113.9');
  assert.strictEqual(rateLimitIpKey('::ffff:203.0.113.9'), '203.0.113.9');
});

test('HTTP: смена адреса внутри одной /64 не обходит предел неудач с адреса', async () => {
  let limited = null;
  for (let i = 0; i < 45 && limited === null; i++) {
    const ip = `2001:db8:77:1::${(i + 1).toString(16)}`;
    const res = await api('POST', '/api/auth/login', { ip, body: { username: `nobody_v6_${i}`, password: 'не-тот' } });
    if (res.status === 429) limited = i;
  }
  assert.ok(limited !== null && limited <= 31, `после ~30 неудач из одной /64 — 429 (на ${limited})`);
  const other = await api('POST', '/api/auth/login', { ip: '2001:db8:77:2::1', body: { username: 'nobody_v6_x', password: 'не-тот' } });
  assert.strictEqual(other.status, 400, other.text);
});

// ── Офис за NAT: верные входы не считаются неудачами (ПР-02, воспр. d) ───────

// scrypt N=2^17 намеренно медленный — этим тестам нужен запас по времени.
test('офис за одним NAT: множество верных входов подряд не расходуют предел неудач', { timeout: 90000 }, async () => {
  const ip = '198.51.100.32';
  const users = [];
  for (let i = 0; i < 34; i++) users.push(await makeUser());
  for (const u of users) {
    const res = await loginWithRetry(u.username, u.password, ip);
    assert.strictEqual(res.status, 200, `${u.username}: ${res.text}`);
  }
});

test('офис за одним NAT: 40 одновременных верных входов — все проходят (после повтора на 503)', { timeout: 90000 }, async () => {
  const ip = '198.51.100.36';
  const users = [];
  for (let i = 0; i < 40; i++) users.push(await makeUser());
  const results = await Promise.all(users.map((u) => loginWithRetry(u.username, u.password, ip)));
  assert.ok(results.every((r) => r.status === 200), 'все 40 верных входов в итоге успешны');
});

// Повтор только на 503 (как настоящий клиент): 429 — окончательный. Так тест
// ловит именно регрессию (429-локаут офиса), а не маскирует её повтором.
async function loginRetry503Only(username, password, ip, rounds = 15) {
  for (let i = 0; i < rounds; i++) {
    const res = await api('POST', '/api/auth/login', { ip, body: { username, password } });
    if (res.status !== 503) return res;
    await new Promise((r) => setTimeout(r, Math.min(3, Number(res.headers.get('retry-after')) || 1) * 250));
  }
  return { status: 0 };
}

test('офис за NAT: опечатки в последние минуты + пачка верных входов НЕ дают 429-локаут (третий раунд, п.1, воспроизведение d3)', { timeout: 90000 }, async () => {
  const ip = '198.51.100.98';
  const users = [];
  for (let i = 0; i < 41; i++) users.push(await makeUser());
  // Офис уже знаком: один успешный вход.
  assert.strictEqual((await loginRetry503Only(users[40].username, users[40].password, ip)).status, 200);
  // 12 опечаток (разные сотрудники, ниже блокировки пары адрес+логин).
  for (let i = 0; i < 12; i++) {
    await api('POST', '/api/auth/login', { ip, body: { username: users[i].username, password: 'опечатка' } });
  }
  // 40 одновременных ВЕРНЫХ входов, повтор только на 503. Ни одного 429.
  const results = await Promise.all(users.slice(0, 40).map((u) => loginRetry503Only(u.username, u.password, ip)));
  const got429 = results.filter((r) => r.status === 429).length;
  assert.strictEqual(got429, 0, `не должно быть 429-локаута (получено ${got429})`);
  assert.ok(results.every((r) => r.status === 200), 'все 40 верных входов прошли');
});

test('поток неверных паролей с адреса упирается в предел неудач и отвечает 503 сверх параллельного предела, но не считает их неудачами', async () => {
  const ip = '198.51.100.31';
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      api('POST', '/api/auth/login', { ip, body: { username: `burst_${i}`, password: 'не-тот' } })
    )
  );
  const codes = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  // Часть дошла до проверки (400), часть отбита параллельным пределом (503).
  assert.ok((codes[400] || 0) <= 30, `до проверки дошло ${codes[400] || 0} — не больше 30`);
  assert.strictEqual((codes[400] || 0) + (codes[503] || 0) + (codes[429] || 0), 60);
});

test('предел параллельных scrypt: не больше PASSWORD_HASH_CONCURRENCY, переполненная очередь — PASSWORD_HASH_BUSY', async () => {
  const password = require('../src/db/identity/password');
  const config = require('../src/config');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('x', salt, 64, { N: 1024, r: 8, p: 1 });
  const cheap = `scrypt$N=1024,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`;
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, password.hashLoad().active); }, 0);
  const total = config.PASSWORD_HASH_CONCURRENCY + password.HASH_QUEUE_MAX + 5;
  const settled = await Promise.allSettled(Array.from({ length: total }, () => password.verifyPassword('x', cheap)));
  clearInterval(watch);
  const busy = settled.filter((s) => s.status === 'rejected' && s.reason?.code === 'PASSWORD_HASH_BUSY').length;
  assert.strictEqual(busy, 5, 'сверх очереди — отказ сразу');
  assert.ok(peak <= config.PASSWORD_HASH_CONCURRENCY, `одновременно шло ${peak}`);
  assert.deepStrictEqual(password.hashLoad(), { active: 0, waiting: 0 });
});

// ── Единая форма логина (Р4-06) ─────────────────────────────────────────────

test('canonicalUsername: пробелы, регистр и NFKC — одна форма', () => {
  const { canonicalUsername } = LoginThrottle;
  assert.strictEqual(canonicalUsername('  Admin '), 'admin');
  assert.strictEqual(canonicalUsername('　ＡＤＭＩＮ'), 'admin');
  assert.strictEqual(canonicalUsername(null), '');
});

test('HTTP: пробелы вокруг логина делят один счётчик неудач с адресом, а не заводят новый', async () => {
  const u = await makeUser();
  const ip = '198.51.100.33';
  // Три неверных под разными написаниями одного логина — все в один ключ
  // login-lock (LOGIN_MAX_FAILED_ATTEMPTS=3) → пара адрес+логин заблокирована.
  for (const username of [u.username, ` ${u.username}`, `${u.username} `]) {
    await api('POST', '/api/auth/login', { ip, body: { username, password: 'не-тот' } });
  }
  // Верный пароль с того же адреса под тем же логином (в любом написании) —
  // уже под блокировкой пары адрес+логин: единый ответ, без входа.
  const res = await api('POST', '/api/auth/login', { ip, body: { username: `  ${u.username}`, password: u.password } });
  assert.strictEqual(res.status, 400, res.text);
  // А с другого адреса тот же верный пароль проходит.
  const elsewhere = await loginWithRetry(u.username, u.password, '198.51.100.34');
  assert.strictEqual(elsewhere.status, 200, elsewhere.text);
});

// ── Задержка по учётной записи и её честные гарантии (ПР-I4) ────────────────

test('под распределённым подбором знакомый адрес всегда входит (гарантия доступности)', async () => {
  const u = await makeUser();
  const homeIp = '203.0.113.200';
  assert.ok((await AuthService.login(u.username, u.password, { ip: homeIp })).token, 'адрес стал знакомым');
  // Подбор с множества адресов доводит учётную запись до включённой задержки и
  // может вычерпать общее ведро токенов (незнакомый адрес тогда подождёт).
  for (let i = 0; i < 20; i++) await AuthService.login(u.username, 'догадка', { ip: `192.0.2.${i + 1}` }).catch(() => {});
  // Знакомый адрес входит сразу, сколько бы ни шёл подбор и что бы ни было с
  // ведром — это и есть твёрдая гарантия (I-A).
  assert.ok((await AuthService.login(u.username, u.password, { ip: homeIp })).token, 'знакомый адрес не задержан');
});

test('распределённый подбор одной учётной записи ограничен ~750 догадками в сутки при любом числе адресов (I-A, воспроизведение j на реальном модуле)', () => {
  const config = require('../src/config');
  const bound = config.LOGIN_ACCOUNT_SOFT_LIMIT + 10 + config.LOGIN_ACCOUNT_UNFAMILIAR_PER_HOUR * 24;
  const run = (N) => {
    LoginThrottle.resetThrottle();
    const start = 1e12;
    const end = start + 24 * 3600e3;
    const next = new Array(N).fill(start);
    let guesses = 0;
    for (;;) {
      let i = 0;
      for (let k = 1; k < N; k++) if (next[k] < next[i]) i = k;
      const now = next[i];
      if (now > end) break;
      const a = LoginThrottle.admit('victim', { ipKey: `ip${i}`, now });
      if (!a.ok) { next[i] = now + a.retryAfterMs; continue; }
      LoginThrottle.settle(a.ticket, 'failure', { now: now + 300 });
      guesses += 1;
      next[i] = now + 301;
    }
    return guesses;
  };
  for (const N of [1, 10, 100]) {
    const g = run(N);
    assert.ok(g <= bound + 50, `N=${N}: ${g} догадок/сутки должно быть в пределах ~${bound}`);
  }
  LoginThrottle.resetThrottle();
});

test('пульсирующий подбор (всплеск-тишина-всплеск) НЕ обходит предел: ≤ ~750/сутки (третий раунд, п.2, воспроизведение j2)', () => {
  const config = require('../src/config');
  const bound = config.LOGIN_ACCOUNT_SOFT_LIMIT + config.LOGIN_ACCOUNT_UNFAMILIAR_PER_HOUR * 24;
  const quietMs = config.LOGIN_LOCKOUT_MINUTES * 60000;
  const run = (N) => {
    LoginThrottle.resetThrottle();
    let now = 1e12;
    const end = now + 86400e3;
    let guesses = 0;
    let ipIdx = 0;
    while (now < end) {
      // Всплеск: бьём, пока подряд не откажут 3N раз.
      let refusedInRow = 0;
      while (refusedInRow < 3 * N && now < end) {
        const ip = 'ip' + (ipIdx++ % N);
        const a = LoginThrottle.admit('victim', { ipKey: ip, now });
        if (!a.ok) { refusedInRow += 1; now += 50; continue; }
        refusedInRow = 0;
        LoginThrottle.settle(a.ticket, 'failure', { now: now + 300 });
        now += 301;
        guesses += 1;
      }
      now += quietMs; // тишина — окно неудач обнуляется, но ведро НЕ пополняется рывком
    }
    return guesses;
  };
  for (const N of [3, 10, 100]) {
    const g = run(N);
    assert.ok(g <= bound + 60, `пульс N=${N}: ${g} догадок/сутки должно быть в пределах ~${bound}`);
  }
  LoginThrottle.resetThrottle();
});

test('login-throttle: успех/нейтраль/BUSY возвращают токен ведра, тратит только неудача (I-A)', () => {
  LoginThrottle.resetThrottle();
  const name = 'refund.acct';
  let now = 7_000_000;
  // Ведро консультируется всегда для незнакомых. Много нейтральных исходов
  // (например, BUSY) не вычерпывают его: токен берётся и тут же возвращается.
  for (let i = 0; i < 200; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `10.2.0.${i % 7}`, now });
    now += 1;
    assert.strictEqual(a.ok, true, `нейтральная попытка ${i} должна допускаться`);
    LoginThrottle.settle(a.ticket, 'neutral', { now });
  }
  // Тратит только подтверждённая неудача: cap = softLimit неудач исчерпывают ведро.
  const soft = require('../src/config').LOGIN_ACCOUNT_SOFT_LIMIT;
  for (let i = 0; i < soft; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `10.4.0.${i}`, now });
    now += 1;
    if (a.ok) LoginThrottle.settle(a.ticket, 'failure', { now });
  }
  const drained = LoginThrottle.admit(name, { ipKey: '10.9.9.9', now });
  assert.strictEqual(drained.ok, false, 'после softLimit неудач ведро исчерпано');
  assert.strictEqual(drained.reason, 'account');
  // Знакомый источник при этом не затронут.
  assert.strictEqual(LoginThrottle.admit(name, { ipKey: '10.9.9.9', trusted: true, now }).ok, true);
  LoginThrottle.resetThrottle();
});

test('login-throttle: сброс состояния учётной записи (сброс пароля админом) снимает задержку', () => {
  LoginThrottle.resetThrottle();
  const name = 'recover.acct';
  let now = 8_000_000;
  for (let i = 0; i < 40; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `10.3.0.${i % 3}`, now });
    if (a.ok) LoginThrottle.settle(a.ticket, 'failure', { now });
    now += 1;
  }
  // Один из адресов атаки сейчас под персональной задержкой.
  const before = LoginThrottle.admit(name, { ipKey: '10.3.0.0', now });
  assert.strictEqual(before.ok, false, 'до сброса адрес под задержкой');
  LoginThrottle.clearAccount(name);
  const afterReset = LoginThrottle.admit(name, { ipKey: '10.3.0.0', now });
  assert.strictEqual(afterReset.ok, true, 'после сброса состояния — вход свободен');
  LoginThrottle.resetThrottle();
});

test('login-throttle (детерминированно): повтор одного источника упирается в персональную задержку; знакомый — никогда', () => {
  LoginThrottle.resetThrottle();
  const name = 'unit.victim';
  let now = 5_000_000;
  // Повторные неудачи с ОДНОГО адреса: сперва проходят (пока в ведре есть
  // токены), затем этот источник упирается в персональную задержку или в
  // исчерпанное ведро — в любом случае получает отказ с retryAfterMs.
  let refused = null;
  for (let i = 0; i < 12 && !refused; i++) {
    const a = LoginThrottle.admit(name, { ipKey: '10.0.0.7', now });
    if (a.ok) { LoginThrottle.settle(a.ticket, 'failure', { now: now + 300 }); now += 400; }
    else refused = a;
  }
  assert.ok(refused, 'повторяющийся источник в итоге получает отказ');
  assert.ok(refused.retryAfterMs > 0, 'с указанием, когда повторить');
  // Знакомый источник не задерживается никогда, что бы ни творилось.
  assert.strictEqual(LoginThrottle.admit(name, { ipKey: '10.0.0.7', trusted: true, now }).ok, true);
  LoginThrottle.resetThrottle();
});

test('знакомый сотрудник входит всегда, сколько бы ни шёл подбор с чужих адресов (воспроизведение h; знакомый = trusted)', () => {
  LoginThrottle.resetThrottle();
  const name = 'victim';
  let now = 1_000_000;
  // Атакующий доводит учётную запись до задержки со своих адресов.
  for (let i = 0; i < 40; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `203.0.113.${i % 5}`, now });
    if (a.ok) LoginThrottle.settle(a.ticket, 'failure', { now });
    now += 50;
  }
  let userTries = 0;
  let userWins = 0;
  let attackerNext = now;
  let userNext = now;
  const end = now + 10 * 60000;
  while (Math.min(attackerNext, userNext) <= end) {
    const t = Math.min(attackerNext, userNext);
    if (attackerNext <= userNext) {
      const a = LoginThrottle.admit(name, { ipKey: `203.0.113.${Math.floor(Math.random() * 5)}`, now: t });
      if (a.ok) { LoginThrottle.settle(a.ticket, 'failure', { now: t + 300 }); attackerNext = t + 300; }
      else attackerNext = t + a.retryAfterMs + 5;
    } else {
      userTries += 1;
      // Сотрудник с рабочего места — знакомый адрес (trusted): вход гарантирован.
      const a = LoginThrottle.admit(name, { ipKey: '198.51.100.9', trusted: true, now: t });
      if (a.ok) { userWins += 1; LoginThrottle.settle(a.ticket, 'success', { now: t + 300 }); }
      userNext = t + 5000 + Math.floor(Math.random() * 10000);
    }
  }
  assert.ok(userWins === userTries && userTries > 0, `знакомый сотрудник входит всегда: ${userWins}/${userTries}`);
  LoginThrottle.resetThrottle();
});

test('login-throttle: переполнение карты вытесняет и НЕ отказывает новому логину (fail open)', () => {
  LoginThrottle.resetThrottle({ maxEntries: 2 });
  try {
    for (const name of ['full-a', 'full-b']) {
      for (let i = 0; i < 10; i++) {
        const a = LoginThrottle.admit(name, { ipKey: '203.0.113.1', now: 1000 + i * 10000 });
        if (a.ok) LoginThrottle.settle(a.ticket, 'failure', { now: 1000 + i * 10000 });
      }
    }
    // Новый логин при заполненной карте — не задержан (fail open).
    assert.strictEqual(LoginThrottle.admit('full-new', { ipKey: '198.51.100.5', now: 1000 + 10 * 10000 }).ok, true);
  } finally {
    LoginThrottle.resetThrottle();
  }
});

test('задержка не срабатывает от ошибок одного сотрудника с одного адреса', async () => {
  const u = await makeUser();
  const ip = '198.51.100.40';
  for (let i = 0; i < 3; i++) await AuthService.login(u.username, 'опечатка', { ip }).catch(() => {});
  assert.ok((await AuthService.login(u.username, u.password, { ip: '198.51.100.41' })).token);
});

// ── Оракул перечисления закрыт (ПР-03, воспроизведение f) ───────────────────

test('несуществующий и существующий логин неотличимы: тот же код и то же сообщение за 23 попытки (воспроизведение f)', async () => {
  // На уровне сервиса (как в reviewer f-enum-single-ip.js), чтобы не смешивать
  // с per-ip счётчиком HTTP-маршрута. Ключ: ни один из путей не уходит в
  // задержку по учётной записи раньше другого и отвечает тем же исключением.
  const real = await makeUser();
  const probe = async (name, ip) => {
    const out = [];
    for (let i = 0; i < 23; i++) {
      try { await AuthService.login(name, `wrong-${i}`, { ip }); out.push('OK'); }
      catch (err) { out.push(`${err.code || 'INV'}:${err.message}`); }
    }
    return out;
  };
  // Разные адреса, чтобы у каждого пробинга свой отсчёт пары адрес+логин.
  const ghost = await probe(`no_such_${crypto.randomBytes(3).toString('hex')}`, '203.0.113.71');
  const existing = await probe(real.username, '203.0.113.72');
  assert.deepStrictEqual(ghost, existing, `ghost=${JSON.stringify(ghost.slice(-3))} existing=${JSON.stringify(existing.slice(-3))}`);
});

// ── Смена пароля не гейтится задержкой по учётной записи (ПР-I4) ─────────────

test('чужой подбор на входе не мешает владельцу сменить пароль', async () => {
  const u = await makeUser();
  const token = AuthService.generateToken(await UserService.getUserById(u.id));
  // Доводим учётную запись до задержки чужим подбором с разных адресов.
  for (let i = 0; i < 10; i++) await AuthService.login(u.username, `x-${i}`, { ip: `192.0.2.${30 + i}` }).catch(() => {});
  // Владелец с действующим токеном меняет пароль — задержка входа ему не мешает.
  const res = await api('POST', '/api/users/password', {
    token, ip: '198.51.100.70', body: { oldPassword: u.password, newPassword: 'Другой-Надёжный-Пароль-7' }
  });
  assert.strictEqual(res.status, 200, res.text);
});

test('смена пароля: 5 неверных текущих паролей упираются в предел на сотрудника', async () => {
  const u = await makeUser();
  const token = AuthService.generateToken(await UserService.getUserById(u.id));
  let limited = false;
  for (let i = 0; i < 7 && !limited; i++) {
    const res = await api('POST', '/api/users/password', {
      token, ip: '198.51.100.71', body: { oldPassword: `wrong-${i}`, newPassword: 'Ещё-Один-Пароль-8' }
    });
    if (res.status === 429) limited = true;
  }
  assert.ok(limited, 'после 5 неверных текущих паролей — 429');
});

// ── Выравнивание по времени (Р4-09) ────────────────────────────────────────

test('отказ по паролю со старыми дешёвыми параметрами длится не меньше обычной проверки', async () => {
  const u = await makeUser();
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(u.password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  await identity.run('UPDATE users SET password_hash = $1, salt = NULL WHERE id = $2', [
    `scrypt$N=16384,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`, u.id
  ]);
  const time = async (fn) => { const t = Date.now(); await fn().catch(() => {}); return Date.now() - t; };
  const ghost = await time(() => AuthService.login(`ghost_t_${userSeq}`, 'x-пароль', { ip: '198.51.100.80' }));
  const cheap = await time(() => AuthService.login(u.username, 'не-тот', { ip: '198.51.100.81' }));
  assert.ok(cheap >= ghost * 0.5, `дешёвый хэш ${cheap} мс против приманки ${ghost} мс`);
  assert.ok((await AuthService.login(u.username, u.password, { ip: '198.51.100.81' })).token);
});

// ── Политика пароля (Р4-08 + ПР-I5) ─────────────────────────────────────────

test('политика: частые пароли, марочные основы, гомоглифы, пароль=логин', () => {
  const policy = UserService.assertPasswordPolicy;
  const banned = [
    'password1', 'qwerty123', '1q2w3e4r', 'Лето2026', 'aaaaaaaa', '１２３４５６７８',
    'centychat', 'Centychat1', 'CentyChat2026', 'CentyChat!', 'centy.chat1', 'сентичат123',
    'centras!', 'Centras2027', 'Centras@2026', 'Centras_2026', 'Сентрас2026', 'ctynhfc123',
    'centrasins', 'MyCentras2026', 'openmychat1', 'Qwerty123!', 'Password1!', 'Lето2026',
    // leetspeak и гомоглифы (ПР-I5, I-6)
    'C3ntras2026', 'P@ssw0rd2026', 'Pa$$word1', 'сentras2026'
  ];
  for (const p of banned) assert.throws(() => policy(p), /простой|логином/, p);
  assert.throws(() => policy('petrov.ivan2026!', { username: 'petrov.ivan' }), /логином/);
  // Длинные фразы, лишь начинающиеся со словарного слова или голого «centy»/
  // «mychat», проходят (I-6 — ложных срабатываний быть не должно).
  for (const ok of ['парольдлятеста', 'Рабочий-пароль-1', 'passwordbook-9', 'ГорныйВелосипед7',
    'Centymeter-long-phrase-9', 'mychatter-is-fun-2026']) {
    assert.doesNotThrow(() => policy(ok), ok);
  }
});

test('политика действует при регистрации, создании, сбросе и смене пароля', async () => {
  await assert.rejects(() => AuthService.register({ username: 'reg.same', password: 'reg.same2026', full_name: 'Р' }), /логином/);
  await assert.rejects(() => UserService.createUser({ username: 'mk.brand', full_name: 'М', password: 'Centras2026' }), /простой/);
  const u = await makeUser();
  await assert.rejects(() => UserService.adminResetPassword(u.id, u.username + '1'), /логином/);
  await assert.rejects(() => UserService.changePassword(u.id, u.password, 'qwerty123'), /простой/);
});

test('прежний пароль, не проходящий новую политику, продолжает пускать без принудительной смены', async () => {
  const { hashPassword } = require('../src/db/identity/password');
  const u = await makeUser();
  await identity.run('UPDATE users SET password_hash = $1, salt = NULL WHERE id = $2', [await hashPassword('password1'), u.id]);
  const res = await loginWithRetry(u.username, 'password1', '198.51.100.90');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!res.json.user.must_change_password);
});

// ── Внутренние ошибки не уходят анониму (Р4-13) ─────────────────────────────

test('HTTP: внутренняя ошибка при входе не раскрывает подробностей', async () => {
  const original = AuthService.login;
  AuthService.login = async () => { const e = new Error('connect ECONNREFUSED 10.9.8.7:5432'); e.code = 'ECONNREFUSED'; throw e; };
  try {
    const res = await api('POST', '/api/auth/login', { ip: '198.51.100.95', body: { username: 'admin', password: 'x' } });
    assert.strictEqual(res.status, 400);
    assert.doesNotMatch(res.text, /ECONNREFUSED|10\.9\.8\.7|5432/);
  } finally {
    AuthService.login = original;
  }
});
