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
  'message_status_updated', 'messages_read', 'message_updated', 'message_deleted',
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
  'http/files.policy.json', 'http/files.upload.json',
  'http/announcements.list.json'
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

function committedFiles() {
  return fs.existsSync(FIXTURES)
    ? walk(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
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

test('manifest.json describes exactly the committed fixtures', () => {
  const manifestPath = path.join(FIXTURES, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest).sort(), committedFiles());
  for (const [file, meta] of Object.entries(manifest)) {
    assert.ok(meta.kind === 'http' || meta.kind === 'ws', `${file}: kind`);
    assert.ok(typeof meta.description === 'string' && meta.description, `${file}: description`);
    if (meta.kind === 'http') assert.ok(meta.method && meta.path && meta.status, `${file}: method/path/status`);
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
