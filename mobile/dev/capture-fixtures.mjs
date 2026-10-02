// Captures the shared mobile contract fixtures from the REAL CentyChat server.
//
//   node mobile/dev/capture-fixtures.mjs --write   regenerate mobile/contracts/fixtures/**
//   node mobile/dev/capture-fixtures.mjs --check   compare with the committed files (exit 1 on drift)
//
// A fresh server process (empty data dir, random port) is seeded with the dev
// stand data, then a scripted scenario runs over HTTP and WebSocket as real
// clients would. Every response / pushed frame is stored verbatim except for
// volatile values (tokens, timestamps, random UINs), which are normalized so
// that regenerating produces a clean diff.
//
// Also importable: captureFixtures({dataDir}) and shapeDiff(expected, actual)
// are what server/test/mobile-contract-fixtures.test.js uses.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServerProcess } from './stand.mjs';
import { seed, CREDENTIALS } from './seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
export const FIXTURES_DIR = path.join(REPO, 'mobile/contracts/fixtures');

const WebSocket = createRequire(path.join(REPO, 'server/package.json'))('ws');

// ── shape comparison ────────────────────────────────────────────────────────

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // object | string | number | boolean
}

/**
 * Structural diff of two JSON values: key sets and value types (null is its
 * own type, so a field turning nullable/non-null is reported). Values are not
 * compared. Returns a list of human-readable differences (empty = same shape).
 */
export function shapeDiff(expected, actual, at = '$') {
  const te = kindOf(expected);
  const ta = kindOf(actual);
  if (te !== ta) return [`${at}: type ${te} (fixture) != ${ta} (server)`];
  if (te === 'array') {
    if (expected.length !== actual.length) return [`${at}: array length ${expected.length} (fixture) != ${actual.length} (server)`];
    return expected.flatMap((item, i) => shapeDiff(item, actual[i], `${at}[${i}]`));
  }
  if (te === 'object') {
    const out = [];
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) out.push(`${at}.${k}: missing in server output`);
      else out.push(...shapeDiff(expected[k], actual[k], `${at}.${k}`));
    }
    for (const k of Object.keys(actual)) {
      if (!(k in expected)) out.push(`${at}.${k}: new in server output, absent from fixture`);
    }
    return out;
  }
  return [];
}

// ── normalization of volatile values ────────────────────────────────────────

const BASE = Date.parse('2026-10-02T09:00:00.000Z');
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyIiwianRpIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwIn0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy';
const ISO_RE = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?$/;

function collectTimes(v, out) {
  if (Array.isArray(v)) v.forEach((x) => collectTimes(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectTimes(x, out));
  else if (typeof v === 'string' && ISO_RE.test(v)) out.add(v);
}

// Normalizes ONE fixture. Timestamps are replaced by BASE + rank seconds, where
// rank is the position among the distinct timestamps of that file in
// chronological order, so ordering (created_at < updated_at) survives while the
// actual wall-clock values (which change on every run) do not.
function normalizeFixture(value) {
  const times = new Set();
  collectTimes(value, times);
  const rank = new Map([...times].sort().map((raw, i) => [raw, i]));
  const mapTime = (raw) => {
    const iso = new Date(BASE + rank.get(raw) * 1000).toISOString(); // 2026-10-02T09:00:00.000Z
    if (!raw.includes('T')) return iso.slice(0, 19).replace('T', ' ');
    let out = /\.\d+/.test(raw) ? iso : iso.replace(/\.\d+Z$/, 'Z');
    if (!/Z$/.test(raw)) out = out.replace(/Z$/, '');
    return out;
  };
  const walk = (v, key, parent) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key, parent));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k, v);
      return out;
    }
    if (typeof v === 'string') {
      if (key === 'token') return FAKE_JWT;
      if (key === 'storedFilename') return '1790000000000_0123456789abcdef.txt';
      // sync cursor "<epoch>.<seq>": the epoch is random per database.
      if (key === 'next_cursor') return v.replace(/^[0-9a-f]{16}\./, '5e7a1c0d9b3f4a62.');
      if (ISO_RE.test(v)) return mapTime(v);
      return v;
    }
    if (typeof v === 'number') {
      if (key === 'at') return BASE;
      if (key === 'retryAt' && v > 0) return BASE + 60000;
      if (key === 'uin') return 1000 + Number(parent.id ?? parent.user_id ?? 0);
    }
    return v;
  };
  return walk(value, '', {});
}

// ── tiny HTTP / WebSocket clients ───────────────────────────────────────────

async function call(baseUrl, method, urlPath, { body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(baseUrl + urlPath, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Sock {
  constructor(url) {
    this.frames = [];
    this.waiters = [];
    this.closed = false;
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      this.frames.push(JSON.parse(raw.toString('utf8')));
      this.wake();
    });
    this.ws.on('close', () => { this.closed = true; this.wake(); });
    this.ws.on('error', () => { /* surfaced through timeouts */ });
  }

  open() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve(this);
      this.ws.once('open', () => resolve(this));
      this.ws.once('error', reject);
    });
  }

  wake() { for (const w of this.waiters.splice(0)) w(); }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  clear() { this.frames.length = 0; }
  close() { try { this.ws.close(); } catch { /* already closed */ } }

  /** Removes and returns the first buffered/arriving frame matching `pred`. */
  async take(pred, label, ms = 8000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex(pred);
      if (i >= 0) return this.frames.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timeout waiting for ${label}; buffered: ${JSON.stringify(this.frames.map((f) => f.type))}`);
      }
      await new Promise((resolve) => { this.waiters.push(resolve); setTimeout(resolve, left); });
    }
  }

  takeType(type, label = type, pred = () => true) {
    return this.take((f) => f.type === type && pred(f), label);
  }
}

// ── the scenario ────────────────────────────────────────────────────────────

/**
 * Starts a fresh server in `dataDir`, runs the scenario and returns
 * `{ files, manifest }`: normalized JSON per relative fixture path and
 * metadata about how each one was produced.
 */
export async function captureFixtures({ dataDir } = {}) {
  const ownDir = !dataDir;
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'centy-fixtures-'));
  const server = await startServerProcess({ dataDir: dir, port: 0, quiet: true });
  const base = `http://127.0.0.1:${server.port}`;
  const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  const sockets = [];

  const raw = {}; // path -> value (insertion order = capture order, drives timestamp numbering)
  const manifest = {};
  const http = async (file, description, method, urlPath, opts, expectStatus) => {
    const res = await call(base, method, `/api${urlPath}`, opts);
    if (res.status !== expectStatus) {
      throw new Error(`${method} ${urlPath}: expected ${expectStatus}, got ${res.status} ${res.text}`);
    }
    if (file) {
      raw[file] = res.json;
      manifest[file] = { kind: 'http', description, method, path: `/api${urlPath.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}')}`, status: res.status };
    }
    return res.json;
  };
  const ws = (file, event, description, frame, trigger) => {
    if (frame.type !== event) throw new Error(`${file}: expected ${event}, got ${frame.type}`);
    raw[file] = frame;
    manifest[file] = { kind: 'ws', description, event, direction: 'server->client', trigger };
  };
  const open = async () => { const s = await new Sock(wsUrl).open(); sockets.push(s); return s; };
  const auth = async (s, token) => { s.send({ type: 'auth', token }); };
  const login = async (who) => (await call(base, 'POST', '/api/auth/login', { body: { username: who.username, password: who.password } })).json;

  try {
    // ── seed: alice, bob, channel #mobile-dev, messages, one file, one announcement
    await seed({ baseUrl: base });
    const admin = (await call(base, 'POST', '/api/auth/login', { body: CREDENTIALS.admin })).json;
    const adminToken = admin.token;

    // ── HTTP: auth ───────────────────────────────────────────────────────
    const aliceLogin = await http('http/auth.login.json', 'Успешный вход по паролю: токен и профиль пользователя (user как в /auth/me).',
      'POST', '/auth/login', { body: { username: 'alice', password: CREDENTIALS.alice.password } }, 200);
    const alice = aliceLogin.user;
    const tAlice = aliceLogin.token;
    await http('http/auth.login-error.json', 'Неверный пароль: HTTP 400 и { error } (не 401).',
      'POST', '/auth/login', { body: { username: 'alice', password: 'неверный-пароль-123' } }, 400);
    await http('http/auth.unauthorized.json', 'Любой защищённый маршрут с неверным/истёкшим токеном: HTTP 401 и { error }.',
      'GET', '/auth/me', { token: 'not-a-valid-token' }, 401);
    await http('http/auth.me.json', 'Профиль текущего пользователя: { user }.', 'GET', '/auth/me', { token: tAlice }, 200);

    // refresh: only for a STILL VALID token; the old token is revoked.
    const toRefresh = (await login(CREDENTIALS.alice)).token;
    await http('http/auth.refresh.json', 'Продление ещё действующего токена: { token }. Старый токен сразу отзывается.',
      'POST', '/auth/refresh', { token: toRefresh }, 200);

    // knock / claim / paired
    const deviceId = 'ios-3F2A9C1E-7B4D-4E88-9A51-0C6D2B7E1F34';
    const deviceSecret = 'k3Jp9xQ2mT7vB5nR8cL1wZ4yH6aD0sGfUeXoIiNtMqE';
    await http('http/auth.knock-pending.json', 'Неизвестное устройство встало в очередь на привязку администратором (токена нет).',
      'POST', '/auth/knock', { body: { device_id: deviceId, device_name: 'iPhone Алисы', platform: 'ios', client_version: '1.0.0' } }, 200);
    await http(null, '', 'POST', '/admin/devices/bind', { token: adminToken, body: { device_id: deviceId, user_id: alice.id } }, 200);
    await http('http/auth.knock-login-required.json', 'Устройство привязано, но секрета нет/неверен: вход только по паролю.',
      'POST', '/auth/knock', { body: { device_id: deviceId, device_secret: deviceSecret, platform: 'ios' } }, 200);
    const fresh = await login(CREDENTIALS.alice);
    await http('http/auth.device-claim.json', 'Сохранение секрета устройства сразу после входа по паролю (не позднее 5 минут): { claimed }.',
      'POST', '/auth/device/claim', { token: fresh.token, body: { device_id: deviceId, device_secret: deviceSecret } }, 200);
    await http('http/auth.knock-paired.json', 'Беспарольный вход устройства: status "paired", user и token.',
      'POST', '/auth/knock', { body: { device_id: deviceId, device_secret: deviceSecret, platform: 'ios' } }, 200);

    // ── HTTP: directory, conversations, messages, files, announcements ──
    const users = await http('http/users.list.json', 'Справочник сотрудников: массив публичных профилей.', 'GET', '/users', { token: tAlice }, 200);
    const bob = users.find((u) => u.username === 'bob');
    const adminUser = users.find((u) => u.username === 'admin');
    await http('http/users.get.json', 'Профиль одного сотрудника.', 'GET', `/users/${bob.id}`, { token: tAlice }, 200);
    const channels = await http('http/channels.list.json', 'Каналы пользователя со счётчиками непрочитанного.', 'GET', '/channels', { token: tAlice }, 200);
    const devChannel = channels.find((c) => c.name === '#mobile-dev');
    await http('http/conversations.direct.json', 'Личные диалоги: последнее сообщение и счётчик непрочитанного.', 'GET', '/conversations/direct', { token: tAlice }, 200);
    const directPage = await http('http/messages.direct-page.json', 'Страница личной переписки (массив, старые → новые), с delivery_status.',
      'GET', `/messages/direct/${bob.id}?limit=50`, { token: tAlice }, 200);
    await http('http/messages.channel-page.json', 'Страница канала (массив, старые → новые), включая сообщение-вложение.',
      'GET', `/messages/channels/${devChannel.id}?limit=50`, { token: tAlice }, 200);
    await http('http/messages.send-direct.json', 'REST-отправка личного сообщения: HTTP 201 и сохранённое сообщение (без delivery_status).',
      'POST', `/messages/direct/${bob.id}`, { token: tAlice, body: { text: 'Отправлено через REST.' } }, 201);
    await http('http/files.policy.json', 'Политика вложений: { enabled, allowed } (расширения в нижнем регистре, БЕЗ точки).', 'GET', '/files/policy', { token: tAlice }, 200);
    const form = new FormData();
    form.append('file', new Blob(['Протокол встречи\n'], { type: 'text/plain' }), 'protokol.txt');
    await http('http/files.upload.json', 'Загрузка файла (multipart, поле file): HTTP 201 и запись файла; id кладётся в metadata.file_id сообщения.',
      'POST', '/files/upload', { token: tAlice, form }, 201);
    await http('http/announcements.list.json', 'Оповещения, видимые пользователю.', 'GET', '/announcements', { token: tAlice }, 200);

    // ── WebSocket session ────────────────────────────────────────────────
    const tBob = (await login(CREDENTIALS.bob)).token;
    const tA = (await login(CREDENTIALS.alice)).token;

    const A = await open();
    auth(A, tA);
    ws('ws/auth_success.json', 'auth_success', 'Сокет авторизован: полный профиль пользователя с permissions.', await A.takeType('auth_success'), 'клиент отправил { type: "auth", token }');
    ws('ws/wake_state.idle.json', 'wake_state', 'Сразу после auth_success: побудка доступна (retryAt = 0).', await A.takeType('wake_state'), 'следует за auth_success');
    ws('ws/user_status_changed.online.json', 'user_status_changed', 'Широковещательно при входе (приходит и самому вошедшему).', await A.takeType('user_status_changed', 'status online', (f) => f.userId === alice.id), 'вход alice');

    const B = await open();
    auth(B, tBob);
    await B.takeType('auth_success');

    // delta sync: without since = only the current head cursor (start point).
    const syncStart = await http('http/sync.bootstrap.json', 'Синхронизация без since: пустой messages, has_more=false и next_cursor — текущая голова (непрозрачная строка «<эпоха>.<номер>»). С него клиент начинает, загрузив страницы переписок.',
      'GET', '/sync', { token: tAlice }, 200);

    // send_message (direct): sender and recipient both get direct_message AND new_message.
    // Mobile clients always send client_msg_id; it is echoed in message.client_msg_id.
    const wsClientMsgId = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
    A.clear(); B.clear();
    A.send({ type: 'send_message', conversationType: 'direct', targetId: bob.id, text: 'Привет, Боб! Договор готов к подписанию.', client_msg_id: wsClientMsgId });
    const dm = await A.takeType('direct_message');
    ws('ws/direct_message.json', 'direct_message', 'Новое личное сообщение (отправителю и получателю). Всегда сопровождается new_message с той же записью.', dm, 'send_message conversationType=direct');
    ws('ws/new_message.direct.json', 'new_message', 'Дубль того же личного сообщения под общим типом new_message. Дедуплицировать по message.id.', await A.takeType('new_message'), 'send_message conversationType=direct');
    ws('ws/message_status_updated.json', 'message_status_updated', 'Отправителю: получатель онлайн, сообщение доставлено.', await A.takeType('message_status_updated', 'delivered', (f) => f.messageId === dm.message.id), 'получатель bob онлайн в момент отправки');
    await B.takeType('direct_message');
    await B.takeType('new_message');
    const dmId = dm.message.id;

    // channel message
    A.clear(); B.clear();
    A.send({ type: 'send_message', conversationType: 'channel', targetId: devChannel.id, text: 'Релиз мобильных клиентов — в пятницу.' });
    const cm = await A.takeType('channel_message');
    ws('ws/channel_message.json', 'channel_message', 'Новое сообщение канала (всем участникам). Всегда сопровождается new_message.', cm, 'send_message conversationType=channel');
    ws('ws/new_message.channel.json', 'new_message', 'Дубль сообщения канала под общим типом new_message. Дедуплицировать по message.id.', await A.takeType('new_message'), 'send_message conversationType=channel');
    await B.takeType('channel_message');

    // errors
    A.clear();
    A.send({ type: 'send_message', conversationType: 'direct', targetId: 999999, text: 'Это сообщение не будет доставлено' });
    ws('ws/error.send_message.json', 'error', 'Ошибка отправки: сервер возвращает исходный text, чтобы вернуть его в поле ввода.', await A.takeType('error'), 'send_message несуществующему получателю');
    A.send({ type: 'send_message', conversationType: 'direct', targetId: bob.id, text: 'Ключ с пробелом', client_msg_id: 'не годится' });
    ws('ws/error.invalid_client_msg_id.json', 'error', 'client_msg_id недопустим (не строка 1–64 из [A-Za-z0-9_-]): code = "INVALID_CLIENT_MSG_ID", значение обратно не отражается. Сообщение не сохранено.', await A.takeType('error'), 'send_message с недопустимым client_msg_id');
    A.send({ type: 'send_message', conversationType: 'channel', targetId: devChannel.id, text: 'Тот же ключ в другую переписку', client_msg_id: wsClientMsgId });
    ws('ws/error.client_msg_id_conflict.json', 'error', 'Этот client_msg_id автор уже использовал в ДРУГОЙ переписке: code = "CLIENT_MSG_ID_CONFLICT", client_msg_id отражается. Сообщение не сохранено.', await A.takeType('error'), 'send_message с client_msg_id, уже использованным для личного диалога');

    // typing
    A.clear(); B.clear();
    B.send({ type: 'typing', conversationType: 'direct', targetId: alice.id, isTyping: true });
    ws('ws/user_typing.direct.json', 'user_typing', 'Собеседник печатает в личном диалоге. userId — кто печатает; targetId — id получателя кадра (то есть ваш собственный id), поэтому диалог определяется по userId.', await A.takeType('user_typing'), 'typing conversationType=direct');
    B.send({ type: 'typing', conversationType: 'channel', targetId: devChannel.id, isTyping: false });
    ws('ws/user_typing.channel.json', 'user_typing', 'Участник канала перестал печатать (isTyping=false).', await A.takeType('user_typing'), 'typing conversationType=channel');

    // read receipts
    A.clear();
    B.send({ type: 'mark_read', conversationType: 'direct', targetId: alice.id });
    ws('ws/messages_read.json', 'messages_read', 'Собеседник прочитал личные сообщения: byUserId и messageIds.', await A.takeType('messages_read'), 'mark_read conversationType=direct');

    // edit / delete
    A.clear(); B.clear();
    A.send({ type: 'edit_message', messageId: dmId, text: 'Привет, Боб! Договор готов, жду подпись до 17:00.' });
    ws('ws/message_updated.json', 'message_updated', 'Сообщение отредактировано: полная запись сообщения (как new_message) с updated_at.', await A.takeType('message_updated'), 'edit_message');
    const bobsMessage = directPage.find((m) => m.sender_id === bob.id);
    A.send({ type: 'edit_message', messageId: bobsMessage.id, text: 'Чужое сообщение' });
    ws('ws/error.edit_message.json', 'error', 'Ошибка правки: context = "edit_message", message — русский текст причины.', await A.takeType('error'), 'edit_message чужого сообщения');
    A.send({ type: 'delete_message', messageId: dmId });
    ws('ws/message_deleted.direct.json', 'message_deleted', 'Сообщение удалено в личном диалоге. Записи сообщения нет — только идентификаторы.', await A.takeType('message_deleted'), 'delete_message (direct)');
    A.send({ type: 'delete_message', messageId: cm.message.id });
    ws('ws/message_deleted.channel.json', 'message_deleted', 'Сообщение удалено в канале.', await A.takeType('message_deleted'), 'delete_message (channel)');

    // ── reliable delivery over REST: idempotent send, forward paging, delta sync
    const restClientMsgId = '0b7e5a91-2c4d-4e6f-9a10-b2c3d4e5f607';
    const idem = await http('http/messages.send-direct-idempotent.json', 'REST-отправка с client_msg_id: HTTP 201, client_msg_id в ответе. Получатель онлайн — сразу «доставлено» (message_status_updated автору).',
      'POST', `/messages/direct/${bob.id}`, { token: tAlice, body: { text: 'Счёт отправлен на почту.', client_msg_id: restClientMsgId } }, 201);
    await A.takeType('message_status_updated', 'delivered via REST', (f) => f.messageId === idem.id);
    await http('http/messages.send-direct-duplicate.json', 'Повтор той же отправки (тот же client_msg_id того же автора): HTTP 200 и УЖЕ сохранённая запись; новой строки нет, получателю повторно не рассылается.',
      'POST', `/messages/direct/${bob.id}`, { token: tAlice, body: { text: 'Счёт отправлен на почту.', client_msg_id: restClientMsgId } }, 200);
    await http('http/messages.send-client-msg-id-invalid.json', 'Недопустимый client_msg_id: HTTP 400, { error, code: "INVALID_CLIENT_MSG_ID" }.',
      'POST', `/messages/direct/${bob.id}`, { token: tAlice, body: { text: 'Не сохранится', client_msg_id: 'x'.repeat(65) } }, 400);
    await http('http/messages.send-client-msg-id-conflict.json', 'client_msg_id уже использован автором в другой переписке: HTTP 409, { error, code: "CLIENT_MSG_ID_CONFLICT" }.',
      'POST', `/messages/channels/${devChannel.id}`, { token: tAlice, body: { text: 'Не сохранится', client_msg_id: restClientMsgId } }, 409);
    await http('http/messages.after-page.json', 'Страница ВПЕРЁД: GET /api/messages?conversationType=direct&targetId={id}&afterId={id}&limit=… — первые limit сообщений с id > afterId, по возрастанию (с delivery_status).',
      'GET', `/messages?conversationType=direct&targetId=${bob.id}&afterId=${directPage[directPage.length - 1].id}&limit=50`, { token: tAlice }, 200);
    await http('http/sync.page.json', 'Дельта после курсора: GET /api/sync?since={next_cursor}&limit=… — созданные, изменённые, удалённые (надгробие: is_deleted=1, text="", metadata_json=null) и сменившие статус сообщения во всех видимых переписках, по возрастанию изменения; каждое один раз в текущем состоянии. delivery_status — у личных, null у каналов.',
      'GET', `/sync?since=${syncStart.next_cursor}&limit=50`, { token: tAlice }, 200);
    const foreignEpoch = syncStart.next_cursor.startsWith('0123456789abcdef.') ? 'fedcba9876543210' : '0123456789abcdef';
    await http('http/sync.cursor-invalid.json', 'Курсор не этой базы (другая эпоха: база восстановлена из резервной копии, другой сервер), прежнего формата или впереди головы: HTTP 410, { error, code: "SYNC_CURSOR_INVALID" } — начать заново с GET /api/sync без since.',
      'GET', `/sync?since=${foreignEpoch}.1`, { token: tAlice }, 410);

    // presence
    A.clear(); B.clear();
    A.send({ type: 'presence', state: 'away', customStatus: 'Обед до 14:00' });
    ws('ws/user_status_changed.away.json', 'user_status_changed', 'Статус «отошёл» с пользовательским текстом.', await B.takeType('user_status_changed', 'away', (f) => f.userId === alice.id), 'presence state=away');
    B.send({ type: 'set_dnd', enabled: true });
    ws('ws/user_status_changed.dnd.json', 'user_status_changed', 'Режим «Не беспокоить».', await A.takeType('user_status_changed', 'dnd', (f) => f.userId === bob.id && f.status === 'dnd'), 'set_dnd enabled=true');

    // while bob is DND and admin is offline: call_unavailable / wake_error (second alice socket, to stay under the call_offer rate limit)
    const A2 = await open();
    auth(A2, tA);
    await A2.takeType('auth_success');
    A2.clear();
    A2.send({ type: 'call_offer', targetUserId: bob.id });
    ws('ws/call_unavailable.dnd.json', 'call_unavailable', 'Вызов отклонён: у адресата «Не беспокоить».', await A2.takeType('call_unavailable'), 'call_offer при dnd у адресата');
    A2.send({ type: 'call_offer', targetUserId: adminUser.id });
    ws('ws/call_unavailable.offline.json', 'call_unavailable', 'Вызов отклонён: адресат не в сети.', await A2.takeType('call_unavailable'), 'call_offer офлайн-сотруднику');
    A2.send({ type: 'wake_send', targetUserId: bob.id });
    ws('ws/wake_error.dnd.json', 'wake_error', 'Побудка отклонена: «Не беспокоить» (паузу не запускает).', await A2.takeType('wake_error'), 'wake_send при dnd');
    A2.send({ type: 'wake_send', targetUserId: adminUser.id });
    ws('ws/wake_error.offline.json', 'wake_error', 'Побудка отклонена: адресат не в сети.', await A2.takeType('wake_error'), 'wake_send офлайн-сотруднику');
    A2.send({ type: 'wake_send', targetUserId: alice.id });
    ws('ws/wake_error.invalid_target.json', 'wake_error', 'Побудка самому себе недопустима.', await A2.takeType('wake_error'), 'wake_send самому себе');

    // DND off -> wake works, then cooldown
    B.send({ type: 'set_dnd', enabled: false });
    await A.takeType('user_status_changed', 'dnd off', (f) => f.userId === bob.id && f.status === 'online');
    A.clear(); B.clear();
    A.send({ type: 'wake_send', targetUserId: bob.id });
    ws('ws/wake_sent.json', 'wake_sent', 'Инициатору: побудка отправлена, retryAt — когда можно будить снова (epoch ms).', await A.takeType('wake_sent'), 'wake_send');
    ws('ws/wake_ring.json', 'wake_ring', 'Адресату: его будят (fromUserId, fromName, at в epoch ms).', await B.takeType('wake_ring'), 'wake_send от alice');
    A.send({ type: 'wake_send', targetUserId: bob.id });
    ws('ws/wake_error.cooldown.json', 'wake_error', 'Пауза: не чаще раза в минуту; содержит retryAt (epoch ms).', await A.takeType('wake_error'), 'повторный wake_send');
    const A3 = await open();
    auth(A3, tA);
    await A3.takeType('auth_success');
    ws('ws/wake_state.cooldown.json', 'wake_state', 'После переподключения во время паузы: targetUserId, at, retryAt.', await A3.takeType('wake_state'), 'auth при активной паузе побудки');

    // voice-call signalling (relay): offer -> ice -> answer -> end; offer -> reject
    A.clear(); B.clear();
    A.send({ type: 'call_offer', targetUserId: bob.id });
    ws('ws/call_offer.json', 'call_offer', 'Входящий звонок: targetUserId — адресат (вы), senderId/senderName — звонящий.', await B.takeType('call_offer'), 'call_offer alice → bob');
    B.send({ type: 'ice_candidate', targetUserId: alice.id, candidate: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.50 54321 typ host', sdpMid: 'audio', sdpMLineIndex: 0 } });
    ws('ws/ice_candidate.json', 'ice_candidate', 'Ретранслируется как есть (все поля кадра отправителя) плюс targetUserId/senderId/senderName.', await A.takeType('ice_candidate'), 'ice_candidate bob → alice внутри вызова');
    B.send({ type: 'call_answer', targetUserId: alice.id });
    ws('ws/call_answer.json', 'call_answer', 'Абонент ответил; после этого разрешён двоичный аудиопоток.', await A.takeType('call_answer'), 'call_answer bob → alice');
    A.send({ type: 'call_end', targetUserId: bob.id, reason: 'Разговор завершен' });
    ws('ws/call_end.json', 'call_end', 'Собеседник завершил вызов (reason — необязательная строка клиента).', await B.takeType('call_end'), 'call_end alice → bob');
    A.send({ type: 'call_offer', targetUserId: bob.id });
    await B.takeType('call_offer');
    B.send({ type: 'call_rejected', targetUserId: alice.id, reason: 'Занят на совещании' });
    ws('ws/call_rejected.json', 'call_rejected', 'Вызов отклонён адресатом (reason — строка клиента).', await A.takeType('call_rejected'), 'call_rejected bob → alice');

    // admin-driven broadcasts
    A.clear(); B.clear();
    const created = await call(base, 'POST', '/api/admin/channels', { token: adminToken, body: { name: 'релиз', topic: 'Подготовка релиза' } });
    ws('ws/channel_created.json', 'channel_created', 'Создан публичный канал: запись канала (без счётчиков).', await A.takeType('channel_created'), 'POST /api/admin/channels');
    await call(base, 'DELETE', `/api/admin/channels/${created.json.id}`, { token: adminToken });
    ws('ws/channel_deleted.json', 'channel_deleted', 'Канал удалён: только channelId.', await A.takeType('channel_deleted'), 'DELETE /api/admin/channels/{id}');

    const carolUser = (await call(base, 'POST', '/api/admin/users', { token: adminToken, body: { username: 'carol', full_name: 'Карина Тестова', password: 'Carol-Dev-Stand-4417', email: 'carol@example.test' } })).json;
    ws('ws/user_created.json', 'user_created', 'Создан сотрудник: публичный профиль (без пароля).', await A.takeType('user_created'), 'POST /api/admin/users');
    await call(base, 'PUT', `/api/admin/users/${carolUser.id}`, { token: adminToken, body: { must_change_password: false, job_title: 'Аналитик' } });
    ws('ws/user_updated.json', 'user_updated', 'Профиль сотрудника изменён администратором.', await A.takeType('user_updated'), 'PUT /api/admin/users/{id}');
    const dave = (await call(base, 'POST', '/api/admin/users', { token: adminToken, body: { username: 'dave', full_name: 'Давид Тестов', password: 'Dave-Dev-Stand-5528', email: 'dave@example.test' } })).json;

    // announcements
    A.clear();
    const ann = await call(base, 'POST', '/api/announcements', { token: adminToken, body: { title: 'Плановое обновление', content: 'Сегодня в 22:00 сервер будет недоступен 10 минут.', priority: 'urgent' } });
    ws('ws/new_announcement.json', 'new_announcement', 'Новое оповещение (всем при target_type=all, иначе адресатам и автору).', await A.takeType('new_announcement'), 'POST /api/announcements');
    await call(base, 'POST', `/api/announcements/${ann.json.id}/acknowledge`, { token: tAlice });
    ws('ws/announcement_acknowledged.json', 'announcement_acknowledged', 'Сотрудник ознакомился. announcementId — СТРОКА (взята из URL), userId — число.', await A.takeType('announcement_acknowledged'), 'POST /api/announcements/{id}/acknowledge');

    // logout -> server_disconnect for sockets of that token
    const tLogout = (await login(CREDENTIALS.alice)).token;
    const L = await open();
    auth(L, tLogout);
    await L.takeType('auth_success');
    L.clear();
    await http('http/auth.logout.json', 'Выход: токен отзывается, сокеты с этим токеном закрываются. Тело необязательно: device_id снимает секрет устройства.',
      'POST', '/auth/logout', { token: tLogout, body: {} }, 200);
    ws('ws/server_disconnect.logout.json', 'server_disconnect', 'Сервер закрывает сокет (код 4003). Не переподключаться с тем же токеном.', await L.takeType('server_disconnect'), 'POST /api/auth/logout');

    // call ended by a dropped connection (note: no targetUserId in this frame)
    A.clear(); B.clear();
    A.send({ type: 'call_offer', targetUserId: bob.id });
    await B.takeType('call_offer');
    B.send({ type: 'call_answer', targetUserId: alice.id });
    await A.takeType('call_answer');
    B.close();
    ws('ws/call_end.connection_lost.json', 'call_end', 'Собеседник пропал: кадр БЕЗ targetUserId, reason = "connection_lost".', await A.takeType('call_end'), 'сокет собеседника закрыт посреди разговора');

    // delivered after reconnect: bob is offline now; alice writes, bob comes back.
    A.clear();
    A.send({ type: 'send_message', conversationType: 'direct', targetId: bob.id, text: 'Боб, перезвони, как будешь на связи.', client_msg_id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' });
    const offlineDm = await A.takeType('direct_message');
    const B2 = await open();
    auth(B2, tBob);
    await B2.takeType('auth_success');
    ws('ws/message_status_updated.reconnect.json', 'message_status_updated', 'Отправителю: получатель был не в сети и теперь вошёл в сокет — его недоставленные личные сообщения отмечены доставленными (по кадру на сообщение).',
      await A.takeType('message_status_updated', 'delivered on reconnect', (f) => f.messageId === offlineDm.message.id), 'auth получателя после отправки ему, пока он был не в сети');

    // auth errors
    const bad = await open();
    auth(bad, 'not-a-token');
    ws('ws/auth_error.invalid_token.json', 'auth_error', 'Токен недействителен/истёк/отозван. Получить новый можно только входом по паролю или /auth/knock.', await bad.takeType('auth_error'), 'auth с неверным токеном');

    const tDave = (await login({ username: 'dave', password: 'Dave-Dev-Stand-5528' })).token;
    const mustChange = await open();
    auth(mustChange, tDave);
    ws('ws/auth_error.must_change_password.json', 'auth_error', 'Нужно сменить пароль до работы в сокете.', await mustChange.takeType('auth_error'), 'auth пользователя с must_change_password');

    const tCarol = (await login({ username: 'carol', password: 'Carol-Dev-Stand-4417' })).token;
    const many = [];
    for (let i = 0; i < 8; i += 1) {
      const s = await open(); many.push(s); auth(s, tCarol); await s.takeType('auth_success');
    }
    const ninth = await open();
    auth(ninth, tCarol);
    ws('ws/auth_error.too_many_sessions.json', 'auth_error', 'Не больше 8 одновременных сокетов на пользователя.', await ninth.takeType('auth_error'), 'девятый сокет одного пользователя');

    // call_denied: take can_call away from the role, log in again
    const roles = (await call(base, 'GET', '/api/admin/roles', { token: adminToken })).json;
    const employee = roles.find((r) => r.name === 'Сотрудник');
    await call(base, 'PUT', `/api/admin/roles/${employee.id}`, { token: adminToken, body: { permissions: { ...employee.permissions, can_call: false } } });
    ws('ws/server_disconnect.role-changed.json', 'server_disconnect', 'Права роли изменены: сокеты закрываются, нужен повторный вход.', await many[0].takeType('server_disconnect'), 'PUT /api/admin/roles/{id}');
    const tAlice2 = (await login(CREDENTIALS.alice)).token;
    const D = await open();
    auth(D, tAlice2);
    await D.takeType('auth_success');
    D.send({ type: 'call_offer', targetUserId: bob.id });
    ws('ws/call_denied.json', 'call_denied', 'Роль пользователя не имеет права звонить.', await D.takeType('call_denied'), 'call_offer без права can_call');
    await call(base, 'PUT', `/api/admin/roles/${employee.id}`, { token: adminToken, body: { permissions: employee.permissions } });

    // rate limit on socket auth (last: blocks this IP for a minute)
    let limited = null;
    for (let i = 0; i < 15 && !limited; i += 1) {
      const s = await open(); auth(s, `garbage-${i}`);
      const f = await s.takeType('auth_error');
      if (f.code === 'RATE_LIMITED') limited = f;
    }
    if (!limited) throw new Error('RATE_LIMITED was not reached');
    ws('ws/auth_error.rate_limited.json', 'auth_error', 'Слишком много неудачных auth с адреса (10 за минуту).', limited, 'серия auth с неверными токенами');
  } finally {
    for (const s of sockets) s.close();
    await server.close();
    if (ownDir) fs.rmSync(dir, { recursive: true, force: true });
  }

  const files = {};
  for (const [file, value] of Object.entries(raw)) files[file] = normalizeFixture(value);
  const sortedManifest = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { files, manifest: sortedManifest };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function writeFixtures({ files, manifest }) {
  // Drop stale fixtures (events that no longer exist) but keep README.md.
  const stale = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stale(full);
      else if (e.name.endsWith('.json')) fs.rmSync(full);
    }
  };
  stale(FIXTURES_DIR);
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(FIXTURES_DIR, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(FIXTURES_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const result = await captureFixtures();
  if (mode === 'write') {
    writeFixtures(result);
    console.log(`wrote ${Object.keys(result.files).length} fixtures to ${FIXTURES_DIR}`);
  } else {
    let bad = 0;
    for (const [file, value] of Object.entries(result.files)) {
      const p = path.join(FIXTURES_DIR, file);
      if (!fs.existsSync(p)) { console.log(`MISSING ${file}`); bad += 1; continue; }
      for (const d of shapeDiff(JSON.parse(fs.readFileSync(p, 'utf8')), value)) { console.log(`${file}: ${d}`); bad += 1; }
    }
    console.log(bad ? `${bad} difference(s)` : 'fixtures match the server');
    process.exit(bad ? 1 : 0);
  }
}
