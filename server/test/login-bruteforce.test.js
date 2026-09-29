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
//   sec5 — суточный предел неверных проверок пароля на учётную запись: U=5
//          (незнакомые адреса), F=10 (знакомые), P=5 (смена пароля), ≤20 в сутки,
//          переживает перезапуск; «стук» устройства не затронут;
//   Р4-01/ПР-I4 — персональная задержка источника (вторичный слой);
//   Р4-02 — ключи по сети /64;
//   ПР-01 — карта ограничителя переполнена → вытеснение, не отказ (fail open);
//   ПР-02 — «в полёте» попытки не считаются неудачами; офис за NAT входит;
//   ПР-03 — несуществующий и существующий логин неотличимы (один IP и очередь);
//   Р4-06 — единая форма логина;
//   Р4-08/ПР-I5 — политика пароля, включая марочные основы.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';
process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
process.env.LOGIN_MAX_FAILED_ATTEMPTS = '3';
process.env.LOGIN_ACCOUNT_MAX_DELAY_SECONDS = '2';
// Суточные корзины (sec5): U=5, F=10, P=5.
process.env.LOGIN_DAILY_FAILURES_UNFAMILIAR = '5';
process.env.LOGIN_DAILY_FAILURES_FAMILIAR = '10';
process.env.PASSWORD_CHANGE_DAILY_FAILURES = '5';

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

// ── Суточные корзины неудач U/F/P (требование владельца, sec5) ──────────────

// Проверка допуска без попытки: билет сразу возвращается нейтральным исходом,
// иначе он держал бы слот «в полёте» (п.1 проверки sec5) и влиял на следующие.
function peekAdmit(name, opts) {
  const a = LoginThrottle.admit(name, opts);
  if (a.ok) LoginThrottle.settle(a.ticket, 'neutral', { now: opts.now });
  return a;
}

// Хелпер: сколько раз подряд admit пропускает (settle=failure), пока корзина
// класса не исчерпается. Работает на реальном модуле с внедрёнными часами.
function guessesUntilBlocked(name, mkOpts, { start = 1e12, stepMs = 400, maxIter = 500 } = {}) {
  let now = start;
  let guesses = 0;
  let lastRefusal = null;
  for (let i = 0; i < maxIter; i++) {
    const a = LoginThrottle.admit(name, { ...mkOpts(i), now });
    if (!a.ok) {
      lastRefusal = a;
      if (a.reason === 'daily') break;
      now += a.retryAfterMs + 1; // персональная задержка источника — переждать
      continue;
    }
    LoginThrottle.settle(a.ticket, 'failure', { now: now + 300 });
    guesses += 1;
    now += stepMs;
  }
  return { guesses, lastRefusal };
}

test('U: распределённый подбор с незнакомых адресов ограничен LOGIN_DAILY_FAILURES_UNFAMILIAR при любом N (воспроизведение j)', () => {
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_UNFAMILIAR;
  for (const N of [1, 10, 100]) {
    LoginThrottle.resetThrottle();
    const { guesses, lastRefusal } = guessesUntilBlocked('victim', (i) => ({ ipKey: `2001:db8:${i % N}::1` }));
    assert.strictEqual(guesses, lim, `N=${N}: ровно ${lim} догадок с незнакомых адресов`);
    assert.strictEqual(lastRefusal.reason, 'daily');
    assert.strictEqual(lastRefusal.cls, 'U');
  }
  LoginThrottle.resetThrottle();
});

test('U: пульсирующий подбор (всплеск-тишина-всплеск) НЕ обходит суточный предел', () => {
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_UNFAMILIAR;
  const quietMs = require('../src/config').LOGIN_LOCKOUT_MINUTES * 60000;
  LoginThrottle.resetThrottle();
  let now = 1e12;
  const end = now + 86400e3;
  let guesses = 0;
  let ipIdx = 0;
  while (now < end) {
    let refusedInRow = 0;
    while (refusedInRow < 10 && now < end) {
      const a = LoginThrottle.admit('victim', { ipKey: `2001:db8:${ipIdx++ % 50}::1`, now });
      if (!a.ok) { refusedInRow += 1; now += 60; continue; }
      LoginThrottle.settle(a.ticket, 'failure', { now: now + 300 });
      guesses += 1; now += 400;
    }
    now += quietMs; // тишина — счётчик пары обнуляется, но суточное окно скользит
  }
  assert.ok(guesses <= lim, `пульс: ${guesses} догадок за сутки ≤ ${lim}`);
  LoginThrottle.resetThrottle();
});

test('F: подбор со знакомых адресов ограничен LOGIN_DAILY_FAILURES_FAMILIAR', () => {
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_FAMILIAR;
  LoginThrottle.resetThrottle();
  const { guesses, lastRefusal } = guessesUntilBlocked('victim', () => ({ ipKey: '10.0.0.1', trusted: true }));
  assert.strictEqual(guesses, lim, `ровно ${lim} догадок со знакомых адресов`);
  assert.strictEqual(lastRefusal.cls, 'F');
  LoginThrottle.resetThrottle();
});

test('U и F — раздельные корзины: одна не съедает другую (в сумме ≤ U+F)', () => {
  const cfg = require('../src/config');
  LoginThrottle.resetThrottle();
  const u = guessesUntilBlocked('victim', () => ({ ipKey: '2001:db8:1::1' }));
  const f = guessesUntilBlocked('victim', () => ({ ipKey: '10.0.0.1', trusted: true }));
  assert.strictEqual(u.guesses, cfg.LOGIN_DAILY_FAILURES_UNFAMILIAR);
  assert.strictEqual(f.guesses, cfg.LOGIN_DAILY_FAILURES_FAMILIAR);
  // Знакомый вход по-прежнему исчерпал ровно F, несмотря на уже исчерпанный U.
  LoginThrottle.resetThrottle();
});

test('только подтверждённая неудача тратит бюджет: нейтральные исходы (BUSY) — нет', () => {
  LoginThrottle.resetThrottle();
  const name = 'neutral.acct';
  let now = 2e12;
  for (let i = 0; i < 100; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `2001:db8:${i % 7}::9`, now });
    assert.strictEqual(a.ok, true, `нейтральная попытка ${i} допускается`);
    LoginThrottle.settle(a.ticket, 'neutral', { now });
    now += 1;
  }
  assert.strictEqual(LoginThrottle.dailyCount(name, 'U', now), 0, 'нейтральные исходы не наполнили корзину');
  LoginThrottle.resetThrottle();
});

test('успех сбрасывает ТОЛЬКО свою корзину: удачный вход со знакомого адреса не чистит U', () => {
  LoginThrottle.resetThrottle();
  const name = 'own.class';
  let now = 3e12;
  // Немного неудач с незнакомых адресов (U растёт, но не исчерпан).
  for (let i = 0; i < 3; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `2001:db8:c${i}::1`, now });
    LoginThrottle.settle(a.ticket, 'failure', { now }); now += 1;
  }
  assert.strictEqual(LoginThrottle.dailyCount(name, 'U', now), 3);
  // Удачный вход со ЗНАКОМОГО адреса (класс F) — чистит F, но не U.
  const a = LoginThrottle.admit(name, { ipKey: '10.0.0.1', trusted: true, now });
  LoginThrottle.settle(a.ticket, 'success', { now });
  assert.strictEqual(LoginThrottle.dailyCount(name, 'U', now), 3, 'U не должен обнулиться офисным входом');
  LoginThrottle.resetThrottle();
});

test('окно скользит: спустя 24 ч одна попытка освобождается', () => {
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_UNFAMILIAR;
  LoginThrottle.resetThrottle();
  const name = 'sliding';
  const first = 4e12;
  let now = first;
  for (let i = 0; i < lim; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `2001:db8:d${i}::1`, now });
    LoginThrottle.settle(a.ticket, 'failure', { now }); now += 3600e3; // по одной в час
  }
  assert.strictEqual(peekAdmit(name, { ipKey: '2001:db8:ff::1', now }).ok, false, 'исчерпано');
  // Ровно через 24 ч после ПЕРВОЙ неудачи она выходит из окна — освобождается
  // одна попытка (остальные ещё в окне).
  const later = first + 24 * 3600e3 + 1;
  assert.strictEqual(LoginThrottle.dailyCount(name, 'U', later), lim - 1, 'ровно одна неудача вышла из окна');
  assert.strictEqual(peekAdmit(name, { ipKey: '2001:db8:ff::1', now: later }).ok, true, 'после суток окно сдвинулось');
  LoginThrottle.resetThrottle();
});

test('clearAccount снимает все корзины учётной записи', () => {
  LoginThrottle.resetThrottle();
  const name = 'recover.acct';
  let now = 5e12;
  // Исчерпать U.
  for (let i = 0; i < 10; i++) {
    const a = LoginThrottle.admit(name, { ipKey: `2001:db8:e${i}::1`, now });
    if (a.ok) LoginThrottle.settle(a.ticket, 'failure', { now }); now += 1;
  }
  assert.strictEqual(peekAdmit(name, { ipKey: '2001:db8:eff::1', now }).ok, false);
  LoginThrottle.clearAccount(name);
  assert.strictEqual(peekAdmit(name, { ipKey: '2001:db8:eff::1', now }).ok, true, 'после сброса — свободно');
  LoginThrottle.resetThrottle();
});

test('персональная задержка источника — вторичный слой: включается при распределённом подборе, не от единичной опечатки', () => {
  const cfg = require('../src/config');
  const engageAt = cfg.LOGIN_MAX_FAILED_ATTEMPTS + 1;
  assert.ok(engageAt <= cfg.LOGIN_DAILY_FAILURES_UNFAMILIAR, 'тест-окружение: порог включения не выше суточной корзины');
  LoginThrottle.resetThrottle();
  const name = 'delay.acct';
  let now = 6e12;
  // Единичная ошибка источника НЕ включает задержку (офис/опечатка).
  const one = LoginThrottle.admit(name, { ipKey: '2001:db8:a0::1', now });
  LoginThrottle.settle(one.ticket, 'failure', { now });
  now += 10;
  assert.strictEqual(peekAdmit(name, { ipKey: '2001:db8:a0::1', now }).ok, true, 'после одной ошибки повтор не задержан');
  // Доводим учётную запись до порога включения распределённым подбором.
  let last = null;
  for (let i = 1; i < engageAt; i++) {
    const ip = `2001:db8:a${i}::1`;
    const a = LoginThrottle.admit(name, { ipKey: ip, now });
    if (a.ok) { LoginThrottle.settle(a.ticket, 'failure', { now }); last = ip; }
    now += 10;
  }
  // Теперь тот же источник, что только что ошибся, при немедленном повторе ждёт.
  const repeat = peekAdmit(name, { ipKey: last, now });
  assert.strictEqual(repeat.ok, false, 'во включённом состоянии повтор того же источника задержан');
  assert.strictEqual(repeat.reason, 'delay');
  assert.ok(repeat.retryAfterMs > 0);
  LoginThrottle.resetThrottle();
});

// ── HTTP: суточные корзины по-настоящему (с базой и персистентностью) ────────

test('HTTP: U исчерпывается на 6-й попытке, верный пароль тоже отклоняется (429)', async () => {
  const u = await makeUser();
  let checked = 0;
  let blocked = 0;
  for (let i = 0; i < 8; i++) {
    const res = await api('POST', '/api/auth/login', { ip: `2001:db8:600:${i}::1`, body: { username: u.username, password: 'не-тот' } });
    if (res.status === 400) checked += 1;
    if (res.status === 429) blocked += 1;
  }
  assert.strictEqual(checked, 5, 'проверено ровно 5 паролей (U=5)');
  assert.ok(blocked >= 3, 'дальше — 429');
  // Верный пароль с нового незнакомого адреса тоже отклонён без проверки.
  const correct = await api('POST', '/api/auth/login', { ip: '2001:db8:6ff::1', body: { username: u.username, password: u.password } });
  assert.strictEqual(correct.status, 429, correct.text);
  assert.strictEqual(correct.json.code, 'ACCOUNT_THROTTLED');
});

test('HTTP: суточная корзина переживает перезапуск (журнал в базе)', async () => {
  const u = await makeUser();
  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/auth/login', { ip: `2001:db8:700:${i}::1`, body: { username: u.username, password: 'не-тот' } });
  }
  // Строки записаны в базу.
  const rows = await identity.all('SELECT class FROM login_failure_log WHERE user_id = $1', [u.id]);
  assert.ok(rows.length >= 5 && rows.every((r) => r.class === 'U'), `в журнале ${rows.length} строк U`);
  // Имитация перезапуска: очищаем ТОЛЬКО память модуля, база остаётся.
  LoginThrottle.resetThrottle();
  await LoginThrottle.ensureLoaded(u.id, u.username);
  assert.strictEqual(LoginThrottle.dailyCount(u.username, 'U'), 5, 'после перезапуска корзина восстановлена из базы');
  const res = await api('POST', '/api/auth/login', { ip: '2001:db8:7ff::1', body: { username: u.username, password: u.password } });
  assert.strictEqual(res.status, 429, 'корректный пароль всё ещё отклонён после перезапуска');
});

test('HTTP: сброс пароля администратором снимает все три корзины (U, F, P)', async () => {
  const u = await makeUser();
  // U — исчерпываем подбором с незнакомых адресов.
  for (let i = 0; i < 6; i++) {
    await api('POST', '/api/auth/login', { ip: `2001:db8:800:${i}::1`, body: { username: u.username, password: 'не-тот' } });
  }
  // F и P — досеиваем прямо в журнал, чтобы проверить очистку всех трёх классов.
  const nowIso = new Date().toISOString();
  await identity.run('INSERT INTO login_failure_log (user_id, class, at) VALUES ($1, $2, $3)', [u.id, 'F', nowIso]);
  await identity.run('INSERT INTO login_failure_log (user_id, class, at) VALUES ($1, $2, $3)', [u.id, 'P', nowIso]);
  const before = await identity.all('SELECT DISTINCT class FROM login_failure_log WHERE user_id = $1', [u.id]);
  assert.deepStrictEqual(before.map((r) => r.class).sort(), ['F', 'P', 'U'], 'в журнале есть все три класса');
  assert.strictEqual((await api('POST', '/api/auth/login', { ip: '2001:db8:8ff::1', body: { username: u.username, password: u.password } })).status, 429);
  await UserService.adminResetPassword(u.id, 'Новый-Админ-Пароль-9');
  const rows = await identity.all('SELECT class FROM login_failure_log WHERE user_id = $1', [u.id]);
  assert.strictEqual(rows.length, 0, 'сброс пароля очистил журнал неудач всех классов');
  // С новым паролем сотрудник входит с любого адреса (must_change при сбросе — ок).
  const res = await api('POST', '/api/auth/login', { ip: '2001:db8:8ee::1', body: { username: u.username, password: 'Новый-Админ-Пароль-9' } });
  assert.strictEqual(res.status, 200, res.text);
});

test('офис за одним NAT: множество верных входов подряд не расходуют суточную корзину', { timeout: 90000 }, async () => {
  const u = await makeUser();
  await loginRetry503Only(u.username, u.password, '198.51.100.42'); // адрес офиса становится знакомым
  for (let i = 0; i < 12; i++) {
    const res = await loginRetry503Only(u.username, u.password, '198.51.100.42');
    assert.strictEqual(res.status, 200, `вход ${i}: ${res.text}`);
  }
});

test('суточный потолок ≤ 20: пульсирующий U + инсайдерский F + смена P в сумме не больше U+F+P', () => {
  const cfg = require('../src/config');
  LoginThrottle.resetThrottle();
  const name = 'ceiling.acct';
  // U — пульсирующий распределённый подбор (всплеск-тишина-всплеск).
  let uChecks = 0;
  {
    let now = 9e12; const end = now + 86400e3; let idx = 0;
    while (now < end) {
      let refused = 0;
      while (refused < 20 && now < end) {
        const a = LoginThrottle.admit(name, { ipKey: `2001:db8:f${idx++ % 40}::1`, now });
        if (!a.ok) { refused += 1; now += 60; continue; }
        LoginThrottle.settle(a.ticket, 'failure', { now: now + 200 }); uChecks += 1; now += 400;
      }
      now += cfg.LOGIN_LOCKOUT_MINUTES * 60000;
    }
  }
  // F — инсайдер со знакомого адреса.
  let fChecks = 0;
  {
    let now = 9e12;
    for (let i = 0; i < 40; i++) {
      const a = LoginThrottle.admit(name, { ipKey: '10.0.0.5', trusted: true, now });
      if (a.ok) { LoginThrottle.settle(a.ticket, 'failure', { now }); fChecks += 1; }
      now += 1;
    }
  }
  assert.strictEqual(uChecks, cfg.LOGIN_DAILY_FAILURES_UNFAMILIAR, `U=${uChecks}`);
  assert.strictEqual(fChecks, cfg.LOGIN_DAILY_FAILURES_FAMILIAR, `F=${fChecks}`);
  // P — независимая корзина (проверяется отдельным тестом смены пароля).
  const total = uChecks + fChecks + cfg.PASSWORD_CHANGE_DAILY_FAILURES;
  assert.ok(total <= 20, `суммарный суточный потолок ${total} ≤ 20`);
  LoginThrottle.resetThrottle();
});

test('привязанное устройство («стук») входит даже при исчерпанной суточной корзине', async () => {
  const DeviceService = require('../src/services/device.service');
  const u = await makeUser();
  const deviceId = `bf-knock-${userSeq}`;
  const secret = crypto.randomBytes(32).toString('base64url'); // 256 бит, 43 символа
  await DeviceService.bindDevice({ device_id: deviceId, user_id: u.id });
  const claimed = await DeviceService.claimDeviceSecret({ userId: u.id, device_id: deviceId, device_secret: secret });
  assert.strictEqual(claimed.claimed, true);
  // Исчерпываем корзину U подбором с незнакомых адресов.
  for (let i = 0; i < 8; i++) {
    await api('POST', '/api/auth/login', { ip: `2001:db8:a00:${i}::1`, body: { username: u.username, password: 'не-тот' } });
  }
  // Вход по паролю с нового незнакомого адреса теперь отклонён.
  const byPassword = await api('POST', '/api/auth/login', { ip: '2001:db8:aff::1', body: { username: u.username, password: u.password } });
  assert.strictEqual(byPassword.status, 429, byPassword.text);
  // Но «стук» привязанного устройства идёт мимо этой защиты и выдаёт токен.
  const knock = await DeviceService.knock({ device_id: deviceId, device_secret: secret, ip_address: '2001:db8:aff::1' });
  assert.strictEqual(knock.status, 'paired', JSON.stringify(knock));
  assert.ok(knock.token, 'стук выдал токен, несмотря на исчерпанную корзину входа по паролю');
});

test('посторонний, исчерпавший U, не мешает входу со знакомого адреса; панель считает учётную запись заблокированной', async () => {
  const DbStudioService = require('../src/services/db-studio.service');
  const u = await makeUser();
  const office = '198.51.100.44';
  assert.strictEqual((await loginRetry503Only(u.username, u.password, office)).status, 200, 'адрес офиса стал знакомым');
  const before = (await DbStudioService.getIdentityStats()).lockedAccounts;
  for (let i = 0; i < 8; i++) {
    await api('POST', '/api/auth/login', { ip: `2001:db8:d00:${i}::1`, body: { username: u.username, password: 'не-тот' } });
  }
  assert.strictEqual((await api('POST', '/api/auth/login', { ip: '2001:db8:dff::1', body: { username: u.username, password: u.password } })).status, 429,
    'с нового адреса — 429');
  const fromOffice = await loginRetry503Only(u.username, u.password, office);
  assert.strictEqual(fromOffice.status, 200, `из офиса вход работает: ${fromOffice.text}`);
  // Запись в журнал — без ожидания; даём ей дойти до базы.
  let after = before;
  for (let t = 0; t < 40 && after <= before; t++) {
    after = (await DbStudioService.getIdentityStats()).lockedAccounts;
    if (after <= before) await new Promise((r) => setTimeout(r, 50));
  }
  assert.strictEqual(after, before + 1, 'исчерпавший суточную корзину виден в панели как заблокированный');
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

test('P: не больше PASSWORD_CHANGE_DAILY_FAILURES проверок текущего пароля за сутки — короткие окна и перезапуск их не обнуляют', async () => {
  const limiter = require('../src/services/rate-limiter');
  const cfg = require('../src/config');
  const u = await makeUser();
  const token = AuthService.generateToken(await UserService.getUserById(u.id));
  const change = (oldPassword) => {
    // Имитируем, что короткие окна (5 в минуту и 5 за LOGIN_LOCKOUT_MINUTES) уже прошли.
    limiter.resetLimit(`pwchange:${u.id}`);
    limiter.resetLimit(`pwchange-fail:${u.id}`);
    return api('POST', '/api/users/password', { token, ip: '198.51.100.73', body: { oldPassword, newPassword: 'Суточный-Пароль-Семь-7' } });
  };
  let checked = 0;
  for (let i = 0; i < 12; i++) {
    const res = await change(`wrong-${i}`);
    if (res.status !== 429) checked += 1;
  }
  assert.strictEqual(checked, cfg.PASSWORD_CHANGE_DAILY_FAILURES, `проверено текущих паролей: ${checked}`);
  // Перезапуск: память модуля пуста, журнал неудач — в базе.
  LoginThrottle.resetThrottle();
  const right = await change(u.password);
  assert.strictEqual(right.status, 429, 'верный текущий пароль тоже отклонён без проверки');
  assert.strictEqual(right.json.code, 'ACCOUNT_THROTTLED');
});

test('удачная самостоятельная смена пароля чистит только P, но не U (иначе смена дарила бы подбору свежие догадки)', async () => {
  const u = await makeUser();
  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/auth/login', { ip: `2001:db8:b00:${i}::1`, body: { username: u.username, password: 'не-тот' } });
  }
  const token = AuthService.generateToken(await UserService.getUserById(u.id));
  const newPassword = 'Свой-Новый-Пароль-4';
  await api('POST', '/api/users/password', { token, ip: '198.51.100.74', body: { oldPassword: 'wrong-x', newPassword } });
  assert.strictEqual(LoginThrottle.dailyCount(u.username, 'P'), 1);
  const ok = await api('POST', '/api/users/password', { token, ip: '198.51.100.74', body: { oldPassword: u.password, newPassword } });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(LoginThrottle.dailyCount(u.username, 'P'), 0, 'P очищена');
  assert.strictEqual(LoginThrottle.dailyCount(u.username, 'U'), 5, 'U не тронута');
  // Даже новым паролем с незнакомого адреса — всё ещё 429 до конца окна.
  const res = await api('POST', '/api/auth/login', { ip: '2001:db8:bff::1', body: { username: u.username, password: newPassword } });
  assert.strictEqual(res.status, 429, res.text);
});

test('исчерпание корзины: событие в журнале аудита и оповещение центра безопасности с учётной записью и классом', async () => {
  const SecurityMonitor = require('../src/services/security-monitor.service');
  const u = await makeUser();
  for (let i = 0; i < 6; i++) {
    await api('POST', '/api/auth/login', { ip: `2001:db8:c00:${i}::1`, body: { username: u.username, password: 'не-тот' } });
  }
  let hit = null;
  for (let t = 0; t < 60 && !hit; t++) {
    const alerts = await SecurityMonitor.listAlerts({ limit: 200 });
    hit = alerts.find((a) => a.rule === 'login_daily_budget_exhausted' && Number(a.details.userId) === Number(u.id));
    if (!hit) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hit, 'оповещение поднято');
  assert.strictEqual(hit.details.class, 'U');
  const audit = await identity.all("SELECT details_json FROM audit_logs WHERE action = 'login_daily_budget_exhausted' AND user_id = $1", [u.id]);
  assert.strictEqual(audit.length, 1, 'одно событие на переход в «исчерпано»');
});

// ── Проверка sec5: параллельные попытки, варианты написания, аварийный сброс ──

test('параллельно (сервис): допускается не больше предела попыток U, F и P, остальные — «ждите» (п.1 проверки sec5)', () => {
  const cfg = require('../src/config');
  for (const [cls, lim, opts] of [
    ['U', cfg.LOGIN_DAILY_FAILURES_UNFAMILIAR, (i) => ({ ipKey: `2001:db8:e1:${i}::1` })],
    ['F', cfg.LOGIN_DAILY_FAILURES_FAMILIAR, () => ({ ipKey: '10.0.0.1', trusted: true })],
    ['P', cfg.PASSWORD_CHANGE_DAILY_FAILURES, () => ({ cls: 'P' })]
  ]) {
    LoginThrottle.resetThrottle();
    const now = 7e12;
    // 30 одновременных попыток: ни одна ещё не завершилась.
    const admissions = Array.from({ length: 30 }, (_, i) => LoginThrottle.admit('burst.acct', { ...opts(i), now }));
    const admitted = admissions.filter((a) => a.ok);
    assert.strictEqual(admitted.length, lim, `${cls}: допущено ${admitted.length}, предел ${lim}`);
    assert.ok(admissions.filter((a) => !a.ok).every((a) => a.reason === 'pending'), `${cls}: остальным — «ждите исхода»`);
    for (const a of admitted) LoginThrottle.settle(a.ticket, 'failure', { now });
    assert.strictEqual(LoginThrottle.dailyCount('burst.acct', cls, now), lim);
    assert.strictEqual(LoginThrottle.admit('burst.acct', { ...opts(99), now }).reason, 'daily', `${cls}: дальше — исчерпано`);
    assert.strictEqual(LoginThrottle.inflightTotal(), 0, `${cls}: слоты возвращены`);
  }
  LoginThrottle.resetThrottle();
});

test('параллельно (сервис): нейтральный исход и успех возвращают слот — законный вход не упирается в «ждите»', () => {
  LoginThrottle.resetThrottle();
  const now = 7.1e12;
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_UNFAMILIAR;
  for (let round = 0; round < 3 * lim; round++) {
    const a = LoginThrottle.admit('slot.acct', { ipKey: `2001:db8:e2:${round}::1`, now });
    assert.strictEqual(a.ok, true, `попытка ${round}`);
    LoginThrottle.settle(a.ticket, round % 2 ? 'neutral' : 'success', { now });
    LoginThrottle.settle(a.ticket, 'failure', { now }); // повторный settle того же билета игнорируется
  }
  assert.strictEqual(LoginThrottle.dailyCount('slot.acct', 'U', now), 0);
  assert.strictEqual(LoginThrottle.inflightTotal(), 0);
  LoginThrottle.resetThrottle();
});

test('HTTP: 30 одновременных неверных паролей с 10 незнакомых адресов — ровно 5 проверок, остальные 429 (воспроизведение s5-bounds, п.1)', async () => {
  const u = await makeUser();
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_UNFAMILIAR;
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    api('POST', '/api/auth/login', { ip: `203.0.113.${110 + (i % 10)}`, body: { username: u.username, password: `guess-${i}` } })));
  const codes = burst.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  assert.strictEqual(codes[400] || 0, lim, `проверено паролей: ${JSON.stringify(codes)}`);
  assert.strictEqual((codes[429] || 0) + (codes[503] || 0), 30 - lim, JSON.stringify(codes));
  assert.strictEqual(LoginThrottle.dailyCount(u.username, 'U'), lim);
  const correct = await api('POST', '/api/auth/login', { ip: '203.0.113.200', body: { username: u.username, password: u.password } });
  assert.strictEqual(correct.status, 429, 'верный пароль после пачки — 429');
  assert.strictEqual(LoginThrottle.inflightTotal(), 0, 'ни один слот не потерян');
});

test('HTTP: 30 одновременных неверных паролей со знакомого адреса — не больше F проверок', async () => {
  const u = await makeUser();
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_FAMILIAR;
  const office = '198.51.100.46';
  assert.strictEqual((await loginRetry503Only(u.username, u.password, office)).status, 200);
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    api('POST', '/api/auth/login', { ip: office, body: { username: u.username, password: `f-guess-${i}` } })));
  const checked = burst.filter((r) => r.status === 400).length;
  assert.ok(checked <= lim, `проверено ${checked} > ${lim}`);
  assert.ok(LoginThrottle.dailyCount(u.username, 'F') <= lim);
  assert.strictEqual(LoginThrottle.inflightTotal(), 0, 'ни один слот не потерян');
});

test('HTTP: параллельные неверные текущие пароли при смене — не больше P проверок, слоты возвращаются', async () => {
  const u = await makeUser();
  const lim = require('../src/config').PASSWORD_CHANGE_DAILY_FAILURES;
  const token = AuthService.generateToken(await UserService.getUserById(u.id));
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    api('POST', '/api/users/password', { token, ip: '198.51.100.75', body: { oldPassword: `wrong-${i}`, newPassword: 'Параллельный-Пароль-6' } })));
  const checked = burst.filter((r) => r.status !== 429 && r.status !== 503).length;
  assert.ok(checked <= lim, `проверено ${checked} > ${lim}`);
  assert.ok(LoginThrottle.dailyCount(u.username, 'P') <= lim);
  assert.strictEqual(LoginThrottle.inflightTotal(), 0, 'ни один слот не потерян');
});

test('варианты написания (регистр, пробелы, NFKC) после исчерпания: существующий и несуществующий логин неотличимы (воспроизведение s5-bounds, п.2)', async () => {
  const real = await makeUser();
  const ghost = `ghost_${crypto.randomBytes(3).toString('hex')}`;
  const variants = (name) => [name.toUpperCase(), ` ${name} `, name.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)), name];
  const probe = async (name, net) => {
    const out = [];
    // Исчерпываем корзину: часть — точным написанием, часть — вариантом.
    for (let i = 0; i < 5; i++) {
      const as = i % 2 ? name.toUpperCase() : name;
      const r = await api('POST', '/api/auth/login', { ip: `2001:db8:${net}:${i}::1`, body: { username: as, password: `w${i}` } });
      out.push(`${r.status}:${r.json?.code || ''}`);
    }
    for (const [j, v] of variants(name).entries()) {
      const r = await api('POST', '/api/auth/login', { ip: `2001:db8:${net}:f${j}::1`, body: { username: v, password: 'w-next' } });
      out.push(`${r.status}:${r.json?.code || ''}`);
    }
    return out;
  };
  const a = await probe(real.username, 'e3');
  const b = await probe(ghost, 'e4');
  assert.deepStrictEqual(a, b, `существующий ${JSON.stringify(a)} против несуществующего ${JSON.stringify(b)}`);
  assert.ok(a.slice(5).every((x) => x.startsWith('429')), 'после исчерпания любое написание — 429');
});

test('ADMIN_PASSWORD_RESET (аварийный сброс при запуске) снимает суточные корзины (воспроизведение s5-phase2, п.3)', async () => {
  const u = await makeUser();
  for (let i = 0; i < 6; i++) {
    await api('POST', '/api/auth/login', { ip: `2001:db8:e5:${i}::1`, body: { username: u.username, password: 'не-тот' } });
  }
  const countRows = async () => Number((await identity.get('SELECT COUNT(*) AS n FROM login_failure_log WHERE user_id = $1', [u.id])).n);
  for (let t = 0; t < 40 && (await countRows()) < 5; t++) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(await countRows(), 5, 'журнал записан');
  // «Перезапуск» с переменной: память процесса пуста, сброс выполняется при запуске.
  LoginThrottle.resetThrottle();
  const saved = { user: process.env.ADMIN_PASSWORD_RESET_USER, pw: process.env.ADMIN_PASSWORD_RESET };
  process.env.ADMIN_PASSWORD_RESET_USER = u.username;
  process.env.ADMIN_PASSWORD_RESET = 'Аварийный-Пароль-2026';
  try {
    await require('../src/db/identity')._applyEmergencyAdminReset(identity);
  } finally {
    if (saved.user === undefined) delete process.env.ADMIN_PASSWORD_RESET_USER; else process.env.ADMIN_PASSWORD_RESET_USER = saved.user;
    if (saved.pw === undefined) delete process.env.ADMIN_PASSWORD_RESET; else process.env.ADMIN_PASSWORD_RESET = saved.pw;
  }
  assert.strictEqual(await countRows(), 0, 'аварийный сброс очистил журнал неудач');
  const res = await api('POST', '/api/auth/login', { ip: '2001:db8:e5:ff::1', body: { username: u.username, password: 'Аварийный-Пароль-2026' } });
  assert.strictEqual(res.status, 200, `новый пароль с незнакомого адреса входит: ${res.text}`);
});

test('новичок без единого знакомого адреса: опечатки из офиса идут в корзину F, а не U (п.4 проверки sec5)', async () => {
  const colleague = await makeUser();
  const office = '198.51.100.47';
  assert.strictEqual((await loginRetry503Only(colleague.username, colleague.password, office)).status, 200, 'офис знаком коллеге');
  const newcomer = await makeUser();
  for (let i = 0; i < 2; i++) {
    await api('POST', '/api/auth/login', { ip: office, body: { username: newcomer.username, password: `опечатка-${i}` } });
  }
  assert.strictEqual(LoginThrottle.dailyCount(newcomer.username, 'F'), 2, 'у новичка офисные опечатки — F');
  assert.strictEqual(LoginThrottle.dailyCount(newcomer.username, 'U'), 0);
  // Устоявшийся сотрудник со своим знакомым адресом (не этим офисом) — по-прежнему U.
  const remote = await makeUser();
  assert.strictEqual((await loginRetry503Only(remote.username, remote.password, '198.51.100.48')).status, 200);
  await api('POST', '/api/auth/login', { ip: office, body: { username: remote.username, password: 'опечатка' } });
  assert.strictEqual(LoginThrottle.dailyCount(remote.username, 'U'), 1, 'устоявшемуся правило не расширяется');
  // Новичок с того же офиса затем входит верным паролем.
  const ok = await loginRetry503Only(newcomer.username, newcomer.password, office);
  assert.strictEqual(ok.status, 200, ok.text);
});

test('журнал неудач: две неудачи в одну миллисекунду не склеиваются, обрезка по id не оставляет лишних (п.5 проверки sec5)', async () => {
  const u = await makeUser();
  const lim = require('../src/config').LOGIN_DAILY_FAILURES_UNFAMILIAR;
  const countRows = async () => Number((await identity.get("SELECT COUNT(*) AS n FROM login_failure_log WHERE user_id = $1 AND class = 'U'", [u.id])).n);
  const t = Date.now();
  for (let i = 0; i < 2; i++) {
    const a = LoginThrottle.admit(u.username, { ipKey: `2001:db8:e6:${i}::1`, userId: u.id, now: t });
    LoginThrottle.settle(a.ticket, 'failure', { now: t }); // одна и та же миллисекунда
  }
  for (let k = 0; k < 40 && (await countRows()) < 2; k++) await new Promise((r) => setTimeout(r, 50));
  LoginThrottle.resetThrottle();
  await LoginThrottle.ensureLoaded(u.id, u.username);
  assert.strictEqual(LoginThrottle.dailyCount(u.username, 'U'), 2, 'после перезагрузки из базы — обе неудачи');
  // Лишние строки с совпадающим временем: обрезка до предела — по суррогатному id.
  const iso = new Date(t).toISOString();
  for (let i = 0; i < lim + 3; i++) {
    await identity.run('INSERT INTO login_failure_log (user_id, class, at) VALUES ($1, $2, $3)', [u.id, 'U', iso]);
  }
  LoginThrottle.resetThrottle();
  const a = LoginThrottle.admit(u.username, { ipKey: '2001:db8:e6:ff::1', userId: u.id, now: t + 1 });
  LoginThrottle.settle(a.ticket, 'failure', { now: t + 1 });
  for (let k = 0; k < 40 && (await countRows()) > lim; k++) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(await countRows(), lim, 'в журнале не больше предела строк');
  LoginThrottle.resetThrottle();
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
