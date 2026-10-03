const test = require('node:test');
const assert = require('node:assert');

// Загружается заново на каждый набор, т.к. config читает переменные окружения
// один раз при первом require.
function loadService(env = {}) {
  for (const key of ['ALLOWED_CLIENT_IPS', 'TRUSTED_PROXY_IPS', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_NAME']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/ip-access.service')];
  return require('../src/services/ip-access.service');
}

const req = (socketIp, headers = {}) => ({ socket: { remoteAddress: socketIp }, headers });

test('getClientIp: без доверенного прокси заголовки игнорируются', () => {
  const { getClientIp } = loadService();
  assert.strictEqual(
    getClientIp(req('203.0.113.9', { 'x-forwarded-for': '10.1.1.1' })),
    '203.0.113.9',
    'подделанный X-Forwarded-For не должен подменять адрес сокета'
  );
});

test('getClientIp: снимает префикс IPv4-mapped IPv6', () => {
  const { getClientIp } = loadService();
  assert.strictEqual(getClientIp(req('::ffff:192.168.1.5')), '192.168.1.5');
});

test('getClientIp: у доверенного прокси берётся ПРАВОЕ значение цепочки', () => {
  // Каждый узел дописывает увиденный им адрес справа, поэтому доверять можно
  // только последнему — всё левее мог подделать сам клиент.
  const { getClientIp } = loadService({ TRUSTED_PROXY_IPS: '10.0.0.1' });
  assert.strictEqual(
    getClientIp(req('10.0.0.1', { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })),
    '203.0.113.9'
  );
});

test('getClientIp: на Railway доверяем X-Real-Ip без списка прокси', () => {
  // У Railway нет фиксированного диапазона прокси, поэтому список настроить
  // нечем; при этом контейнер недостижим в обход их edge.
  const { getClientIp } = loadService({ RAILWAY_PROJECT_ID: 'proj-1' });
  assert.strictEqual(
    getClientIp(req('100.64.0.3', { 'x-real-ip': '203.0.113.9' })),
    '203.0.113.9'
  );
});

test('getClientIp: на Railway подмена левого значения не проходит', () => {
  const { getClientIp } = loadService({ RAILWAY_PROJECT_ID: 'proj-1' });
  assert.strictEqual(
    getClientIp(req('100.64.0.3', { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' })),
    '203.0.113.9',
    'реальным считается адрес, дописанный прокси справа'
  );
});

test('getClientIp: разные клиенты за одним прокси различимы', () => {
  // Ровно эта ошибка блокировала вход: ключ ограничителя строился по адресу
  // сокета, одинаковому для всех, и счётчик попыток был общим.
  const { getClientIp } = loadService({ RAILWAY_PROJECT_ID: 'proj-1' });
  const a = getClientIp(req('100.64.0.3', { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' }));
  const b = getClientIp(req('100.64.0.3', { 'x-forwarded-for': '10.0.0.1, 198.51.100.7' }));
  assert.notStrictEqual(a, b);
});

test('matchesAny: точное совпадение и диапазоны CIDR', () => {
  const { matchesAny } = loadService();
  assert.ok(matchesAny('192.168.1.5', ['192.168.1.5']));
  assert.ok(matchesAny('192.168.1.5', ['192.168.1.0/24']));
  assert.ok(matchesAny('10.0.5.1', ['192.168.1.0/24', '10.0.0.0/8']));

  assert.ok(!matchesAny('192.168.2.5', ['192.168.1.0/24']), 'соседняя подсеть не должна проходить');
  assert.ok(!matchesAny('192.168.1.5', []), 'пустой список не пропускает никого');
  assert.ok(!matchesAny('не-адрес', ['192.168.1.0/24']), 'мусор вместо адреса не должен совпадать');
});

test('matchesAny: /32 — ровно один адрес, /0 — любой', () => {
  const { matchesAny } = loadService();
  assert.ok(matchesAny('203.0.113.9', ['203.0.113.9/32']));
  assert.ok(!matchesAny('203.0.113.10', ['203.0.113.9/32']));
  assert.ok(matchesAny('203.0.113.10', ['0.0.0.0/0']));
});

// Маршруты автообновления открыты без входа пользователя — тем важнее, что
// они стоят за тем же сетевым фильтром и за проверкой готовности, что и всё
// остальное. Приложение поднимается без хранилища учётных записей: ответ 503
// от проверки готовности и доказывает, что /updates смонтирован после неё.
test('маршруты /updates/* закрыты ALLOWED_CLIENT_IPS и стоят за проверкой готовности', async () => {
  const http = require('node:http');
  loadService({ ALLOWED_CLIENT_IPS: '10.9.9.9' });
  const config = require('../src/config');
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/updates/policy.json', '/updates/stable/latest.yml', '/updates/stable/CentyChat-Setup-1.0.0.exe']) {
      const denied = await fetch(base + p, { headers: { 'User-Agent': 'Electron' } });
      await denied.arrayBuffer();
      assert.strictEqual(denied.status, 403, `${p}: чужой адрес не проходит`);
    }

    // Тот же процесс, тот же объект настроек — адрес теста добавляется в список.
    config.ALLOWED_CLIENT_IPS.push('127.0.0.1');
    const gated = await fetch(base + '/updates/policy.json');
    await gated.arrayBuffer();
    assert.strictEqual(gated.status, 503, 'разрешённый адрес упирается в проверку готовности');
  } finally {
    server.close();
    delete process.env.ALLOWED_CLIENT_IPS;
  }
});

test('GET /api/health variants mirror /health while the server is starting', async () => {
  const http = require('node:http');
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const root = await fetch(base + '/health');

    assert.strictEqual(root.status, 503);
    const rootBody = await root.json();
    const headers = [
      'cache-control',
      'content-security-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
      'origin-agent-cluster',
      'permissions-policy',
      'referrer-policy',
      'x-content-type-options',
      'x-frame-options',
      'x-permitted-cross-domain-policies'
    ];

    for (const path of ['/api/health', '/api/health/', '/API/health']) {
      const alias = await fetch(base + path);
      assert.strictEqual(alias.status, root.status, path);
      assert.deepStrictEqual(await alias.json(), rootBody, path);
      for (const name of headers) {
        assert.strictEqual(alias.headers.get(name), root.headers.get(name), `${path}: ${name}`);
      }
    }
  } finally {
    server.close();
  }
});

test('restricted IP treats API health case and trailing slash variants like /health', async () => {
  const http = require('node:http');
  loadService({ ALLOWED_CLIENT_IPS: '10.9.9.9' });
  delete require.cache[require.resolve('../src/app')];
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const root = await fetch(base + '/health');
    assert.strictEqual(root.status, 403);
    const rootBody = await root.text();

    for (const path of ['/api/health', '/api/health/', '/API/health']) {
      const alias = await fetch(base + path);
      assert.strictEqual(alias.status, root.status, path);
      assert.strictEqual(await alias.text(), rootBody, path);
      assert.strictEqual(alias.headers.get('content-type'), root.headers.get('content-type'), `${path}: content-type`);
      assert.strictEqual(alias.headers.get('cache-control'), root.headers.get('cache-control'), `${path}: cache-control`);
    }
  } finally {
    server.close();
    delete process.env.ALLOWED_CLIENT_IPS;
  }
});

test('double-slash API health paths remain protected by generic startup handling', async () => {
  const http = require('node:http');
  loadService();
  delete require.cache[require.resolve('../src/app')];
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const path of ['/api/health//', '/API/health//']) {
      const response = await fetch(base + path);
      assert.strictEqual(response.status, 503, path);
      assert.strictEqual(response.headers.get('cache-control'), 'no-store', path);
      const body = await response.json();
      assert.ok(typeof body.error === 'string', path);
      assert.notStrictEqual(body.status, 'starting', path);
    }
  } finally {
    server.close();
  }
});
