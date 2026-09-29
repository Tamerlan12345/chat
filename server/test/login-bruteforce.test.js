const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { freshBoot, closeAll } = require('./helpers/boot');

// Аудит безопасности, раунд 4 (docs/superpowers/specs/2026-09-29-security-audit-round4.md):
// подбор паролей и ограничители частоты.
//   Р4-01 — задержка по учётной записи со всех адресов вместе, без запирания
//           сотрудника на знакомом адресе;
//   Р4-02 — IPv6: ключи ограничителей по сети /64;
//   Р4-03 — неудача засчитывается до scrypt; предел параллельных scrypt;
//   Р4-04 — потолок карты ограничителя, отказ при переполнении;
//   Р4-05 — смена пароля как оракул подбора;
//   Р4-06 — единая форма логина в ключах;
//   Р4-08 — политика нового пароля; прежний пароль продолжает пускать;
//   Р4-09 — отказ по дешёвому (старому) хэшу выравнивается по времени.
//
// Пороги уменьшены, чтобы сценарии укладывались в секунды. Сервер — за
// «доверенным прокси» 127.0.0.1, и адрес клиента задаётся заголовком
// X-Forwarded-For: так проверяются разные адреса, в том числе IPv6.

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

// ── Ограничитель: потолок карты и отказ при переполнении (Р4-04) ────────────

test('ограничитель: переполненная действующими блокировками карта отказывает новым ключам, а не пускает', () => {
  const limiter = require('../src/services/rate-limiter');
  limiter.configureLimiter({ maxBuckets: 3 });
  try {
    const opts = { maxAttempts: 1, windowMs: 60000 };
    for (const key of ['cap:a', 'cap:b', 'cap:c']) {
      assert.ok(limiter.checkRateLimit(key, opts), `${key}: первая попытка проходит`);
    }
    // Все три ключа исчерпаны — вытеснять нечего.
    assert.strictEqual(limiter.checkRateLimit('cap:new', opts), false, 'новый ключ не заводится — отказ');
    assert.strictEqual(limiter.isRateLimited('cap:new-fail', opts), true, 'и счётчик неудач для нового ключа считается исчерпанным');
    assert.ok(!limiter.checkRateLimit('cap:a', opts), 'существующая блокировка не снята переполнением');
  } finally {
    limiter.configureLimiter({});
    for (const key of ['cap:a', 'cap:b', 'cap:c']) limiter.resetLimit(key);
  }
});

test('ограничитель: при переполнении вытесняется ключ, который никого не сдерживает', () => {
  const limiter = require('../src/services/rate-limiter');
  limiter.configureLimiter({ maxBuckets: 2 });
  try {
    assert.ok(limiter.checkRateLimit('evict:partial', { maxAttempts: 5, windowMs: 60000 })); // 1 из 5 — не блокирует
    assert.ok(limiter.checkRateLimit('evict:blocked', { maxAttempts: 1, windowMs: 60000 })); // 1 из 1 — блокирует
    assert.ok(limiter.checkRateLimit('evict:new', { maxAttempts: 5, windowMs: 60000 }), 'место нашлось');
    assert.ok(!limiter.checkRateLimit('evict:blocked', { maxAttempts: 1, windowMs: 60000 }), 'действующая блокировка осталась');
  } finally {
    limiter.configureLimiter({});
    for (const key of ['evict:partial', 'evict:blocked', 'evict:new']) limiter.resetLimit(key);
  }
});

test('ограничитель: refundFailure возвращает заранее засчитанную неудачу', () => {
  const limiter = require('../src/services/rate-limiter');
  const opts = { maxAttempts: 2, windowMs: 60000 };
  limiter.registerFailure('refund:k', opts);
  limiter.registerFailure('refund:k', opts);
  assert.ok(limiter.isRateLimited('refund:k', opts));
  limiter.refundFailure('refund:k');
  assert.ok(!limiter.isRateLimited('refund:k', opts));
  limiter.resetLimit('refund:k');
});

// ── Адреса IPv6: ключ по сети /64 (Р4-02) ───────────────────────────────────

test('rateLimitIpKey: IPv6 одной сети /64 — один ключ, другой сети — другой; IPv4 не меняется', () => {
  const { rateLimitIpKey } = require('../src/services/ip-access.service');
  assert.strictEqual(rateLimitIpKey('2001:db8:1:2::1'), rateLimitIpKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'));
  assert.notStrictEqual(rateLimitIpKey('2001:db8:1:2::1'), rateLimitIpKey('2001:db8:1:3::1'));
  assert.strictEqual(rateLimitIpKey('203.0.113.9'), '203.0.113.9');
  assert.strictEqual(rateLimitIpKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.strictEqual(rateLimitIpKey(''), 'unknown');
});

test('HTTP: смена адреса внутри одной сети /64 не обходит предел неудач с адреса', async () => {
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const ip = `2001:db8:77:1::${(i + 1).toString(16)}`; // каждый раз новый адрес той же /64
    const res = await api('POST', '/api/auth/login', { ip, body: { username: `nobody_v6_${i}`, password: 'не-тот-пароль' } });
    if (res.status === 429) limited = i;
  }
  assert.ok(limited !== null && limited <= 30, `после 30 неудач из одной /64 — 429 (получено на попытке ${limited})`);

  // Соседняя сеть /64 — это уже другой абонент, у него свой счёт.
  const other = await api('POST', '/api/auth/login', { ip: '2001:db8:77:2::1', body: { username: 'nobody_v6_x', password: 'не-тот-пароль' } });
  assert.strictEqual(other.status, 400, other.text);
});

// ── Одновременные попытки (Р4-03) ──────────────────────────────────────────

test('HTTP: сотня одновременных попыток с одного адреса — не больше 30 доходят до проверки пароля', async () => {
  const ip = '198.51.100.31';
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      api('POST', '/api/auth/login', { ip, body: { username: `burst_${i}`, password: 'не-тот-пароль' } })
    )
  );
  const checked = results.filter((r) => r.status === 400).length;
  const limited = results.filter((r) => r.status === 429).length;
  assert.ok(checked <= 30, `до проверки дошло ${checked} — больше предела 30`);
  assert.strictEqual(checked + limited, 60);
});

test('HTTP: удачные входы за одним адресом (офис за NAT) предел неудач не расходуют', async () => {
  const ip = '198.51.100.32';
  const users = [];
  for (let i = 0; i < 31; i++) users.push(await makeUser()); // больше предела 30
  for (const u of users) {
    const res = await api('POST', '/api/auth/login', { ip, body: { username: u.username, password: u.password } });
    assert.strictEqual(res.status, 200, `${u.username}: ${res.text}`);
  }
});

test('предел параллельных расчётов scrypt: не больше PASSWORD_HASH_CONCURRENCY, переполненная очередь — PASSWORD_HASH_BUSY', async () => {
  const password = require('../src/db/identity/password');
  const config = require('../src/config');
  // Дешёвые параметры — очередь проверяется, а не процессор.
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('x', salt, 64, { N: 1024, r: 8, p: 1 });
  const cheap = `scrypt$N=1024,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`;

  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, password.hashLoad().active); }, 0);
  const total = config.PASSWORD_HASH_CONCURRENCY + password.HASH_QUEUE_MAX + 5;
  const settled = await Promise.allSettled(Array.from({ length: total }, () => password.verifyPassword('x', cheap)));
  clearInterval(watch);

  const busy = settled.filter((s) => s.status === 'rejected' && s.reason?.code === 'PASSWORD_HASH_BUSY').length;
  const ok = settled.filter((s) => s.status === 'fulfilled' && s.value.ok).length;
  assert.strictEqual(busy, 5, 'сверх очереди — отказ сразу');
  assert.strictEqual(ok, total - 5);
  assert.ok(peak <= config.PASSWORD_HASH_CONCURRENCY, `одновременно шло ${peak} расчётов`);
  assert.deepStrictEqual(password.hashLoad(), { active: 0, waiting: 0 }, 'после завершения очередь пуста');
});

// ── Единая форма логина (Р4-06) ─────────────────────────────────────────────

test('canonicalUsername: пробелы, регистр и NFKC сводятся к одной форме', () => {
  const { canonicalUsername } = LoginThrottle;
  assert.strictEqual(canonicalUsername('  Admin '), 'admin');
  assert.strictEqual(canonicalUsername('　ＡＤＭＩＮ'), 'admin'); // полноширинные буквы и широкий пробел
  assert.strictEqual(canonicalUsername(null), '');
});

test('HTTP: пробелы вокруг логина не дают нового счётчика «5 попыток в минуту»', async () => {
  const u = await makeUser();
  const ip = '198.51.100.33';
  const variants = [u.username, ` ${u.username}`, `${u.username} `, `  ${u.username}`, `\t${u.username}`, ` ${u.username} `];
  const statuses = [];
  for (const username of variants) {
    statuses.push((await api('POST', '/api/auth/login', { ip, body: { username, password: 'неверный-пароль' } })).status);
  }
  assert.strictEqual(statuses[5], 429, `шестая попытка к той же учётной записи — 429 (${statuses.join(',')})`);
});

// ── Задержка по учётной записи со всех адресов (Р4-01) ─────────────────────

test('подбор с множества адресов: после порога незнакомый адрес ждёт, знакомый входит сразу', async () => {
  const u = await makeUser();
  const homeIp = '203.0.113.200';
  // Сотрудник уже входил со своего адреса — адрес знакомый.
  assert.ok((await AuthService.login(u.username, u.password, { ip: homeIp })).token);

  // Подбор: по одной неудаче с каждого нового адреса — пределы «на адрес»
  // и «адрес + логин» не срабатывают ни разу.
  let throttledAt = null;
  for (let i = 0; i < 12 && throttledAt === null; i++) {
    try {
      await AuthService.login(u.username, `догадка-${i}`, { ip: `192.0.2.${i + 1}` });
    } catch (err) {
      if (err.code === 'ACCOUNT_THROTTLED') throttledAt = i;
    }
  }
  assert.ok(throttledAt !== null, 'задержка по учётной записи включилась');

  // Даже верный пароль с незнакомого адреса сейчас не проверяется.
  await assert.rejects(
    () => AuthService.login(u.username, u.password, { ip: '192.0.2.250' }),
    (err) => err.code === 'ACCOUNT_THROTTLED' && err.retryAfterSeconds >= 1
  );

  // Сотрудник со знакомого адреса входит как обычно — запереть его нельзя.
  const fromHome = await AuthService.login(u.username, u.password, { ip: homeIp });
  assert.ok(fromHome.token);

  // Задержка ограничена сверху (здесь 2 с): спустя неё незнакомый адрес снова
  // допускается к проверке пароля.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const later = await AuthService.login(u.username, u.password, { ip: '192.0.2.251' });
  assert.ok(later.token, 'после задержки верный пароль с незнакомого адреса проходит');
});

test('последний адрес входа из базы (last_login_ip) тоже знакомый — переживает перезапуск', async () => {
  const u = await makeUser();
  await identity.run('UPDATE users SET last_login_ip = $1 WHERE id = $2', ['2001:db8:aa:bb::5', u.id]);
  LoginThrottle.resetThrottle(); // как после перезапуска: в памяти ничего нет
  for (let i = 0; i < 8; i++) {
    await AuthService.login(u.username, `догадка-${i}`, { ip: `192.0.2.${100 + i}` }).catch(() => {});
  }
  await assert.rejects(() => AuthService.login(u.username, u.password, { ip: '192.0.2.199' }), { code: 'ACCOUNT_THROTTLED' });
  // Другой адрес той же сети /64, что и последний вход.
  assert.ok((await AuthService.login(u.username, u.password, { ip: '2001:db8:aa:bb::77' })).token);
});

test('несуществующий логин задерживается точно так же — задержка не выдаёт, заведён ли логин', async () => {
  const ghost = `ghost_${crypto.randomBytes(4).toString('hex')}`;
  const codes = [];
  for (let i = 0; i < 8; i++) {
    try {
      await AuthService.login(ghost, 'что-угодно', { ip: `192.0.2.${150 + i}` });
    } catch (err) {
      codes.push(err.code || 'INVALID');
    }
  }
  assert.ok(codes.includes('ACCOUNT_THROTTLED'), `коды: ${codes.join(',')}`);
});

test('HTTP: задержка по учётной записи — 429 с Retry-After', async () => {
  const u = await makeUser();
  let throttled = null;
  for (let i = 0; i < 10 && !throttled; i++) {
    const res = await api('POST', '/api/auth/login', { ip: `192.0.2.${200 + i}`, body: { username: u.username, password: `догадка-${i}` } });
    if (res.status === 429) throttled = res;
  }
  assert.ok(throttled, 'после порога — 429');
  assert.strictEqual(throttled.json.code, 'ACCOUNT_THROTTLED');
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1);
});

test('задержка не срабатывает от ошибок одного сотрудника с одного адреса', async () => {
  const u = await makeUser();
  const ip = '198.51.100.34';
  // Сотрудник ошибается до блокировки своей пары адрес+логин (3) — счёт
  // учётной записи (порог 5) этим не достигается.
  for (let i = 0; i < 3; i++) await AuthService.login(u.username, 'опечатка', { ip }).catch(() => {});
  // С другого места (например, телефон) верный пароль проходит без задержки.
  assert.ok((await AuthService.login(u.username, u.password, { ip: '198.51.100.35' })).token);
});

test('login-throttle: переполненная карта считает новый логин задержанным (fail closed), знакомый адрес пропускает', () => {
  LoginThrottle.resetThrottle({ maxEntries: 2 });
  try {
    for (const name of ['full-a', 'full-b']) {
      for (let i = 0; i < 10; i++) {
        const a = LoginThrottle.admit(name, { now: 1000 + i * 10000 });
        if (a.ok) LoginThrottle.settle(a.ticket, 'failure', { now: 1000 + i * 10000 });
      }
    }
    const now = 1000 + 10 * 10000;
    assert.strictEqual(LoginThrottle.admit('full-new', { now }).ok, false, 'места нет — незнакомый адрес ждёт');
    assert.strictEqual(LoginThrottle.admit('full-new', { now, trusted: true }).ok, true, 'знакомый адрес проходит');
  } finally {
    LoginThrottle.resetThrottle();
  }
});

test('login-throttle: задержка растёт вдвое и упирается в потолок', () => {
  LoginThrottle.resetThrottle();
  const config = require('../src/config');
  let now = 10_000_000;
  const delays = [];
  for (let i = 0; i < 12; i++) {
    const a = LoginThrottle.admit('growth', { now });
    if (!a.ok) {
      delays.push(a.retryAfterMs);
      now += a.retryAfterMs;
      continue;
    }
    LoginThrottle.settle(a.ticket, 'failure', { now });
  }
  assert.ok(delays.length > 0, 'задержка наступила');
  assert.ok(Math.max(...delays) <= config.LOGIN_ACCOUNT_MAX_DELAY_SECONDS * 1000, `задержки ${delays.join(',')}`);
  LoginThrottle.resetThrottle();
});

// ── Смена пароля (Р4-05) ───────────────────────────────────────────────────

test('HTTP: неверный текущий пароль при смене засчитывается в счёт учётной записи и в свой предел', async () => {
  const u = await makeUser();
  const token = AuthService.generateToken(await UserService.getUserById(u.id));
  const limiter = require('../src/services/rate-limiter');
  const config = require('../src/config');

  for (let i = 0; i < 5; i++) {
    const res = await api('POST', '/api/users/password', {
      token, ip: `192.0.2.${60 + i}`, body: { oldPassword: `догадка-${i}`, newPassword: 'Совсем-новый-пароль-7' }
    });
    assert.ok([400, 429].includes(res.status), res.text);
  }
  assert.ok(
    limiter.isRateLimited(`pwchange-fail:${u.id}`, { maxAttempts: 5, windowMs: config.LOGIN_LOCKOUT_MINUTES * 60000 }),
    'пять неверных текущих паролей исчерпали предел смены'
  );
  // И вход с незнакомого адреса уже под задержкой учётной записи.
  await assert.rejects(() => AuthService.login(u.username, u.password, { ip: '192.0.2.99' }), { code: 'ACCOUNT_THROTTLED' });
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
  // Образец обычной проверки — несуществующий логин (приманка с нынешними параметрами).
  const ghost = await time(() => AuthService.login(`ghost_t_${userSeq}`, 'x-пароль', { ip: '198.51.100.40' }));
  const cheap = await time(() => AuthService.login(u.username, 'не-тот-пароль', { ip: '198.51.100.41' }));
  assert.ok(cheap >= ghost * 0.5, `отказ по дешёвому хэшу ${cheap} мс против ${ghost} мс у несуществующего логина`);

  // Верный пароль по-прежнему пускает и пересчитывается в нынешний формат.
  assert.ok((await AuthService.login(u.username, u.password, { ip: '198.51.100.41' })).token);
  const row = await identity.get('SELECT password_hash FROM users WHERE id = $1', [u.id]);
  assert.match(row.password_hash, /^scrypt\$N=131072,/);
});

// ── Политика паролей (Р4-08) ───────────────────────────────────────────────

test('политика: частые пароли, пароль = логин, повтор символа, время года с годом, полноширинные цифры', () => {
  const policy = UserService.assertPasswordPolicy;
  for (const weak of ['password1', 'qwerty123', '1q2w3e4r', 'йцукен123', 'Лето2026', 'aaaaaaaa', 'abababab', '１２３４５６７８']) {
    assert.throws(() => policy(weak), /простой/, weak);
  }
  assert.throws(() => policy('petrov.ivan', { username: 'petrov.ivan' }), /логином/);
  assert.throws(() => policy('Petrov.Ivan2026!', { username: 'petrov.ivan' }), /логином/);
  assert.throws(() => policy('навi.вортеп', { username: 'петров.iван' }), /логином/);
  assert.throws(() => policy('короткий'.slice(0, 7)), /не короче 8/);
  assert.throws(() => policy('я'.repeat(600)), /длинный|простой/);
  assert.doesNotThrow(() => policy('Рабочий-пароль-1', { username: 'petrov.ivan' }));
  assert.doesNotThrow(() => policy('ivan-и-кофе-2026', { username: 'petrov.ivan' }));
});

test('политика действует при регистрации, создании, сбросе и смене пароля', async () => {
  const AuthSvc = AuthService;
  await assert.rejects(() => AuthSvc.register({ username: 'reg.same', password: 'reg.same2026', full_name: 'Р' }), /логином/);
  await assert.rejects(() => UserService.createUser({ username: 'mk.same', full_name: 'М', password: 'password123' }), /простой/);
  const u = await makeUser();
  await assert.rejects(() => UserService.adminResetPassword(u.id, u.username + '1'), /логином/);
  await assert.rejects(() => UserService.changePassword(u.id, u.password, 'qwertyuiop', { ip: '198.51.100.50' }), /простой/);
});

test('прежний пароль, не проходящий новую политику, продолжает пускать без принудительной смены', async () => {
  const { hashPassword } = require('../src/db/identity/password');
  const u = await makeUser();
  // «password1» новая политика не допустит, но прежняя допускала: такой пароль
  // мог быть задан до выпуска — вход обязан работать как раньше.
  await identity.run('UPDATE users SET password_hash = $1, salt = NULL WHERE id = $2', [await hashPassword('password1'), u.id]);
  const res = await api('POST', '/api/auth/login', { ip: '198.51.100.51', body: { username: u.username, password: 'password1' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!res.json.user.must_change_password, 'смена при входе требуется только по прежнему правилу');
});

// ── Ошибки внутренних слоёв не уходят анонимному клиенту (Р4-13) ────────────

test('HTTP: внутренняя ошибка при входе не раскрывает подробностей', async () => {
  const original = AuthService.login;
  AuthService.login = async () => {
    const err = new Error('connect ECONNREFUSED 10.9.8.7:5432');
    err.code = 'ECONNREFUSED';
    throw err;
  };
  try {
    const res = await api('POST', '/api/auth/login', { ip: '198.51.100.60', body: { username: 'admin', password: 'что-то' } });
    assert.strictEqual(res.status, 400);
    assert.doesNotMatch(res.text, /ECONNREFUSED|10\.9\.8\.7|5432/);
  } finally {
    AuthService.login = original;
  }
});
