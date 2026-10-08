const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Решение «кому уведомление» (mobile/contracts/multi-device.md §5) — одна
// чистая функция для сервера, iOS и Android. Табличные векторы
// mobile/contracts/fixtures/notify/*.json прогоняются через КОД СЕРВЕРА
// (server/src/push/notify-decision.js) и через эталон для платформ
// (mobile/contracts/reference/notify-decision.mjs); общий блок обоих файлов
// обязан совпадать байт в байт — правило одно, а не две похожие копии.

const REPO = path.resolve(__dirname, '../..');
const VECTORS_DIR = path.join(REPO, 'mobile/contracts/fixtures/notify');
const REFERENCE = path.join(REPO, 'mobile/contracts/reference/notify-decision.mjs');
const SERVER = path.join(__dirname, '../src/push/notify-decision.js');
const server = require(SERVER);

const VECTOR_KEYS = ['decision', 'description', 'expected', 'input', 'name'];
// Сценарии, которые обязаны быть в векторах (решение владельца, 2026-10-02).
const REQUIRED = [
  '01-viewing-on-desktop', '02-viewing-on-phone', '03-desktop-other-chat-phone-in-pocket', '04-both-on-list',
  '05-desktop-away-while-viewing', '06-phone-background-desktop-viewing', '07-dnd', '08-own-message',
  '09-channel-viewing-other-chat', '10-channel-viewing-same', '11-no-sockets', '12-old-clients-never-send-viewing',
  '13-phone-background-socket-desktop-list', '14-phone-foreground-other-screen', '15-phone-away-without-push-token',
  '16-two-phones-one-foreground', '17-viewing-ignored-while-away-everywhere', '18-old-mobile-foreground-no-device-id',
  'r01-read-dismiss-pocket-devices', 'r02-read-on-phone-no-dismiss-push',
  // Звонки по тому же правилу (решение владельца, 2026-10-03).
  'c01-desktop-idle-phone-in-pocket', 'c02-phone-and-desktop-online', 'c03-dnd', 'c04-own-call', 'c05-no-devices',
  'c06-two-phones-one-foreground', 'c07-old-mobile-no-device-id', 'c08-same-device-away-socket-and-token',
  'c09-viewing-does-not-silence', 'c10-away-phone-without-token'
];

function loadVectors() {
  return fs.readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, vector: JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, file), 'utf8')) }));
}

function core(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const begin = text.indexOf('// ── BEGIN SHARED CORE ──');
  const end = text.indexOf('// ── END SHARED CORE ──');
  assert.ok(begin >= 0 && end > begin, `${path.basename(file)}: нет меток общего блока`);
  return text.slice(begin, end);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function run(impl, vector) {
  const input = deepFreeze(JSON.parse(JSON.stringify(vector.input)));
  if (vector.decision === 'read') return impl.decideReadDismissal(input);
  if (vector.decision === 'call') return impl.decideCallNotification(input);
  return impl.decideMessageNotification(input);
}

const vectors = loadVectors();

test('векторы решения об уведомлении: формат и обязательные сценарии', () => {
  const names = new Set();
  for (const { file, vector } of vectors) {
    assert.deepStrictEqual(Object.keys(vector).sort(), VECTOR_KEYS, `${file}: ключи`);
    assert.strictEqual(`${vector.name}.json`, file, `${file}: name = имя файла`);
    assert.ok(['message', 'read', 'call'].includes(vector.decision), `${file}: decision`);
    if (vector.decision === 'call') assert.ok(vector.name.startsWith('c'), `${file}: векторы звонка — c01…`);
    assert.ok(vector.description.length > 10, `${file}: description`);
    for (const s of vector.input.sockets || []) {
      assert.deepStrictEqual(Object.keys(s).sort(), ['deviceId', 'id', 'presence', 'viewing'], `${file}: сокет`);
      assert.ok(['online', 'away'].includes(s.presence), `${file}: presence`);
    }
    names.add(vector.name);
  }
  for (const name of REQUIRED) assert.ok(names.has(name), `нет обязательного вектора ${name}`);
});

test('общий блок сервера и эталона совпадает байт в байт', () => {
  assert.strictEqual(core(SERVER), core(REFERENCE));
});

test('каждый вектор проходит через код сервера', () => {
  for (const { file, vector } of vectors) {
    assert.deepStrictEqual(run(server, vector), vector.expected, file);
  }
});

test('каждый вектор проходит через эталон для платформ', async () => {
  const reference = await import(pathToFileURL(REFERENCE).href);
  for (const { file, vector } of vectors) {
    assert.deepStrictEqual(run(reference, vector), vector.expected, file);
  }
});

test('chatOf: личный — собеседник с точки зрения получателя, канал — его id', () => {
  assert.deepStrictEqual(server.chatOf({ conversationType: 'direct', targetId: 2, senderId: 5 }, 2), { conversationType: 'direct', targetId: 5 });
  assert.deepStrictEqual(server.chatOf({ conversationType: 'direct', targetId: 2, senderId: 5 }, 5), { conversationType: 'direct', targetId: 2 });
  assert.deepStrictEqual(server.chatOf({ conversationType: 'channel', targetId: 7, senderId: 5 }, 2), { conversationType: 'channel', targetId: 7 });
});

test('звонок: ни одно устройство не молчит из-за открытого чата; push — устройствам без сокета на переднем плане', () => {
  const base = { recipientId: 2, call: { callerId: 5 }, pushDevices: [{ id: 'a' }, { id: 'b' }] };
  const r = server.decideCallNotification({
    ...base,
    sockets: [
      { id: 's1', deviceId: 'a', presence: 'online', viewing: { conversationType: 'direct', targetId: 5 } },
      { id: 's2', deviceId: 'b', presence: 'away', viewing: null }
    ]
  });
  assert.deepStrictEqual(r, { reason: null, push: ['b'], ring: ['s1'], quiet: ['s2'] });
});
