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
