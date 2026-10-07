const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Общие JSON-фикстуры мобильного контракта (mobile/contracts/fixtures).
//
// Фикстуры снимаются с настоящего сервера (mobile/dev/capture-fixtures.mjs):
// поднимается отдельный процесс с пустой базой, выполняется сценарий по HTTP и
// WebSocket, ответы нормализуются (токены, время, ожидающие значения) и
// сохраняются. Этот тест снимает их заново и сравнивает с закоммиченными по
// набору ключей и типам значений: если сериализатор сервера изменился, а
// фикстура и контракт — нет, тест падает. Обновление:
//
//   node mobile/dev/capture-fixtures.mjs --write
//
// iOS и Android декодируют ТЕ ЖЕ файлы в своих unit-тестах.

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO, 'mobile/contracts/fixtures');
const CAPTURE = pathToFileURL(path.join(REPO, 'mobile/dev/capture-fixtures.mjs')).href;

// События сервер → клиент, которые обязаны иметь фикстуру (ws/<событие>[.вариант].json).
const REQUIRED_WS_EVENTS = [
  'auth_success', 'auth_error', 'server_disconnect',
  'new_message', 'direct_message', 'channel_message',
  'message_status_updated', 'messages_read', 'conversation_read', 'message_updated', 'message_deleted', 'message_cancelled',
  'user_typing', 'user_status_changed', 'user_created', 'user_updated',
  'channel_created', 'channel_deleted',
  'new_announcement', 'announcement_acknowledged',
  'call_offer', 'call_answer', 'call_rejected', 'call_end', 'ice_candidate',
  'call_denied', 'call_unavailable',
  'wake_state', 'wake_sent', 'wake_ring', 'wake_error',
  'error'
];

// HTTP-ответы, которые мобильные клиенты декодируют.
const REQUIRED_HTTP = [
  'http/auth.login.json', 'http/auth.login-error.json',
  'http/auth.knock-pending.json', 'http/auth.knock-login-required.json', 'http/auth.knock-paired.json',
  'http/auth.device-claim.json', 'http/auth.refresh.json', 'http/auth.me.json', 'http/auth.logout.json',
  'http/auth.unauthorized.json',
  'http/users.list.json', 'http/users.get.json',
  'http/channels.list.json', 'http/conversations.direct.json',
  'http/messages.direct-page.json', 'http/messages.channel-page.json', 'http/messages.send-direct.json',
  // надёжная доставка (задача 5): идемпотентная отправка, страница вперёд, дельта-синхронизация
  'http/messages.send-direct-idempotent.json', 'http/messages.send-direct-duplicate.json',
  'http/messages.send-client-msg-id-invalid.json', 'http/messages.send-client-msg-id-conflict.json',
  'http/messages.after-page.json', 'http/messages.send-cancelled.json',
  'http/sync.bootstrap.json', 'http/sync.page.json', 'http/sync.cursor-invalid.json',
  'http/files.policy.json', 'http/files.upload.json',
  'http/announcements.list.json',
  'http/devices.push-token-register.json', 'http/devices.push-token-invalid.json', 'http/devices.push-token-delete.json',
  // самостоятельная регистрация, удаление аккаунта, жалобы и блокировки (registration.md)
  'http/settings.info.json',
  'http/auth.register-request-disabled.json', 'http/auth.register-request-invalid.json',
  'http/auth.register-request-mail-not-configured.json',
  'http/auth.register-verify-disabled.json', 'http/auth.register-verify-invalid.json', 'http/auth.register-verify-expired.json',
  'http/blocks.add.json', 'http/blocks.list.json', 'http/blocks.remove.json',
  'http/reports.create.json',
  'http/users.delete-me.json', 'http/users.delete-me-wrong-password.json'
];

// Варианты кадров, которые клиенты обязаны различать по code.
const REQUIRED_WS_VARIANTS = ['ws/error.dm_not_allowed.json'];

// Что уходит через поставщиков push (задача 18): по форме на сообщение и звонок.
const REQUIRED_PUSH = [
  'push/fcm.message.direct.json', 'push/fcm.message.channel.json', 'push/fcm.call.json',
  'push/apns.message.direct.json', 'push/apns.message.channel.json', 'push/apns.call.json',
  // тихий «read» — снять уведомления, прочитанные на другом устройстве (multi-device.md §6)
  'push/fcm.read.json', 'push/apns.read.json'
];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

// reducers/ — табличные векторы клиентского редьюсера доставки (delivery-state.md),
// notify/ — векторы решения об уведомлении (multi-device.md); их пишут руками,
// а не снимают с сервера; проверяют их mobile-delivery-reducer.test.js и
// notify-decision.test.js.
function committedFiles() {
  return fs.existsSync(FIXTURES)
    ? walk(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'manifest.json' && !f.startsWith('reducers/') && !f.startsWith('notify/'))
    : [];
}

test('shapeDiff catches renamed keys, changed types and nullability', async () => {
  const { shapeDiff } = await import(CAPTURE);
  assert.deepStrictEqual(shapeDiff({ a: 1, b: 'x' }, { a: 2, b: 'y' }), []);
  assert.ok(shapeDiff({ a: 1 }, { b: 1 }).length >= 2, 'renamed key = missing + unexpected');
  assert.ok(shapeDiff({ a: 1 }, { a: '1' }).length === 1, 'type change');
  assert.ok(shapeDiff({ a: null }, { a: 'x' }).length === 1, 'nullability change');
  assert.ok(shapeDiff({ a: [{ k: 1 }] }, { a: [{ k: 'z' }] }).length === 1, 'array element type');
  assert.deepStrictEqual(shapeDiff({ a: [] }, { a: [] }), []);
});

test('every required WebSocket event has a committed fixture', () => {
  const files = committedFiles();
  for (const event of REQUIRED_WS_EVENTS) {
    const has = files.some((f) => f === `ws/${event}.json` || f.startsWith(`ws/${event}.`));
    assert.ok(has, `no fixture ws/${event}[.variant].json`);
  }
});

test('every required HTTP fixture is committed', () => {
  const files = committedFiles();
  for (const f of REQUIRED_HTTP) assert.ok(files.includes(f), `missing ${f}`);
});

test('every required WebSocket variant is committed', () => {
  const files = committedFiles();
  for (const f of REQUIRED_WS_VARIANTS) assert.ok(files.includes(f), `missing ${f}`);
  const dm = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'ws/error.dm_not_allowed.json'), 'utf8'));
  assert.strictEqual(dm.code, 'DM_NOT_ALLOWED');
  assert.strictEqual(dm.retryable, false);
});

// openapi.yaml описывает каждый маршрут, ответ которого снят в фикстуру: новый
// маршрут без описания в контракте — это дрейф (final review, parity Part 1 №2).
test('openapi.yaml documents every captured HTTP endpoint and status', () => {
  const yaml = fs.readFileSync(path.join(REPO, 'mobile/contracts/openapi.yaml'), 'utf8');
  const norm = (p) => p.replace(/\{[^}]+\}/g, '{}');
  const ops = new Map(); // "/path" -> Map(method -> Set(status))
  let current = null;
  let method = null;
  let inResponses = false;
  for (const line of yaml.split(/\r?\n/)) {
    let m;
    if ((m = /^  (\/[^:\s]*):\s*$/.exec(line))) { current = norm(m[1]); ops.set(current, ops.get(current) || new Map()); method = null; continue; }
    if (/^\S/.test(line)) { current = null; continue; }
    if (!current) continue;
    if ((m = /^    (get|post|put|patch|delete):\s*$/.exec(line))) { method = m[1].toUpperCase(); ops.get(current).set(method, new Set()); inResponses = false; continue; }
    if (method && /^      responses:\s*$/.test(line)) { inResponses = true; continue; }
    if (method && /^      \S/.test(line)) inResponses = false;
    if (method && inResponses && (m = /^        ['"]?(\d{3})['"]?:/.exec(line))) ops.get(current).get(method).add(m[1]);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
  const missing = [];
  for (const [file, meta] of Object.entries(manifest)) {
    if (meta.kind !== 'http') continue;
    const p = norm(meta.path.replace(/^\/api/, ''));
    const statuses = ops.get(p)?.get(meta.method);
    if (!statuses) missing.push(`${meta.method} ${p} (${file})`);
    else if (!statuses.has(String(meta.status))) missing.push(`${meta.method} ${p} -> ${meta.status} (${file})`);
  }
  assert.deepStrictEqual(missing, [], `openapi.yaml lacks:\n${missing.join('\n')}`);
});

// Примеры в контракте — нейтральные (example.com/.test/.invalid), без адресов
// и телефонов, похожих на настоящих сотрудников, и без хостов компании.
test('contract examples use neutral data', () => {
  const files = [
    'mobile/contracts/openapi.yaml', 'mobile/contracts/registration.md',
    ...committedFiles().map((f) => `mobile/contracts/fixtures/${f}`)
  ];
  const problems = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const [, addr] of text.matchAll(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      if (!/@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net|test)|example|invalid|test)$/i.test(addr)) problems.push(`${rel}: e-mail ${addr}`);
    }
    for (const re of [/centras\.kz/gi, /\bcic\.kz\b/gi, /kz\.centras\./gi, /\+7 \(7\d\d\) \d{3}-\d\d-\d\d/g]) {
      for (const [hit] of text.matchAll(re)) problems.push(`${rel}: ${hit}`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('every required push payload fixture is committed and carries ids only', () => {
  const files = committedFiles();
  for (const f of REQUIRED_PUSH) {
    assert.ok(files.includes(f), `missing ${f}`);
    const value = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
    const data = f.startsWith('push/fcm.') ? value.message.data : value.payload;
    const { aps, ...ids } = data;
    const allowed = ids.type === 'call' ? ['type', 'callerId', 'callId']
      : ids.type === 'read' ? ['type', 'conversationType', 'targetId']
        : ['type', 'conversationType', 'targetId', 'messageId'];
    for (const k of Object.keys(ids)) assert.ok(allowed.includes(k), `${f}: unexpected field ${k} (only ids may pass through Google/Apple)`);
    if (aps && ids.type === 'read') assert.deepStrictEqual(aps, { 'content-available': 1 }, `${f}: read is silent (no alert, no sound)`);
    else if (aps) assert.deepStrictEqual(aps.alert, { body: 'Новое сообщение' }, `${f}: alert must be the generic placeholder`);
  }
});

test('manifest.json describes exactly the committed fixtures', () => {
  const manifestPath = path.join(FIXTURES, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest).sort(), committedFiles());
  for (const [file, meta] of Object.entries(manifest)) {
    assert.ok(['http', 'ws', 'push'].includes(meta.kind), `${file}: kind`);
    assert.ok(typeof meta.description === 'string' && meta.description, `${file}: description`);
    if (meta.kind === 'http') assert.ok(meta.method && meta.path && meta.status, `${file}: method/path/status`);
    else if (meta.kind === 'push') assert.ok(['fcm', 'apns'].includes(meta.provider) && meta.trigger, `${file}: provider/trigger`);
    else assert.ok(meta.event && meta.direction === 'server->client', `${file}: event/direction`);
  }
});

test('committed fixtures match what the real server serializes now', { timeout: 180000 }, async () => {
  const { captureFixtures, shapeDiff } = await import(CAPTURE);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'centy-fixtures-'));
  let captured;
  try {
    captured = await captureFixtures({ dataDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const committed = committedFiles();
  assert.deepStrictEqual(Object.keys(captured.files).sort(), committed,
    'set of captured fixtures differs from committed ones (run: node mobile/dev/capture-fixtures.mjs --write)');

  const problems = [];
  for (const file of committed) {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    for (const d of shapeDiff(expected, captured.files[file])) problems.push(`${file}: ${d}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest, captured.manifest, 'manifest.json drifted from the capture script');
  assert.deepStrictEqual(problems, [],
    `serializer output drifted from fixtures (run: node mobile/dev/capture-fixtures.mjs --write):\n${problems.join('\n')}`);
});
