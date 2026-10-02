const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { freshBoot, closeAll } = require('./helpers/boot');

// Медиа для мобильных клиентов (задача 20): докачка вложений (Range, ETag),
// миниатюры картинок, размеры и цвет картинки в сообщении, аватары ссылкой.
// Доступ к миниатюре — тот же, что к скачиванию вложения.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let server;
let sharp;
let UserService;
let AuthService;
let MessageService;
let identity;
let config;
const people = {};

test.before(async () => {
  const booted = await freshBoot();
  identity = booted.identity;
  sharp = require('sharp');
  config = require('../src/config');
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  MessageService = require('../src/services/message.service');
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await identity.get("SELECT id FROM users WHERE username = 'admin'");
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, token: await tokenFor(admin.id) };
  for (const [username, full_name] of [['media-bob', 'Боб Медиа'], ['media-carol', 'Карина Медиа']]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = { id: created.id, token: await tokenFor(created.id) };
  }
});

test.after(async () => {
  server?.close();
  await closeAll();
});

async function tokenFor(userId) {
  return AuthService.generateToken(await UserService.getUserById(userId));
}

async function get(urlPath, { token, headers = {} } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

async function upload(buffer, name, type, token = people.admin.token) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), name);
  const res = await fetch(`${baseUrl}/api/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const json = await res.json().catch(() => null);
  assert.strictEqual(res.status, 201, JSON.stringify(json));
  return json;
}

// Файл, который админ отправил Бобу: Бобу доступен, Карине — нет.
async function sharedWithBob(buffer, name, type) {
  const uploaded = await upload(buffer, name, type);
  await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: people['media-bob'].id,
    senderId: people.admin.id,
    text: name,
    type: 'file',
    metadata: { file_id: uploaded.id }
  });
  return uploaded;
}

// ══ Скачивание: Range и ETag ═════════════════════════════════════════════════

const TEXT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'); // 36 байт

test('Скачивание: Accept-Ranges и ETag; If-None-Match — 304 без тела', async () => {
  const file = await sharedWithBob(TEXT, 'алфавит.txt', 'text/plain');
  const bob = people['media-bob'].token;
  const full = await get(`/api/files/download/${file.id}`, { token: bob });
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.headers.get('accept-ranges'), 'bytes');
  const etag = full.headers.get('etag');
  assert.match(etag || '', /^"[0-9a-f]{16,64}"$/);
  assert.deepStrictEqual(full.body, TEXT);

  const again = await get(`/api/files/download/${file.id}`, { token: bob, headers: { 'If-None-Match': etag } });
  assert.strictEqual(again.status, 304);
  assert.strictEqual(again.body.length, 0);
  assert.strictEqual(again.headers.get('etag'), etag);

  const other = await get(`/api/files/download/${file.id}`, { token: bob, headers: { 'If-None-Match': '"0000000000000000"' } });
  assert.strictEqual(other.status, 200);
});

test('Скачивание: один диапазон — 206 с Content-Range; конец за файлом обрезается', async () => {
  const file = await sharedWithBob(TEXT, 'диапазон.txt', 'text/plain');
  const bob = people['media-bob'].token;
  const cases = [
    ['bytes=0-9', 0, 9],
    ['bytes=30-', 30, 35],
    ['bytes=-4', 32, 35],
    ['bytes=10-999999', 10, 35]
  ];
  for (const [range, start, end] of cases) {
    const res = await get(`/api/files/download/${file.id}`, { token: bob, headers: { Range: range } });
    assert.strictEqual(res.status, 206, range);
    assert.strictEqual(res.headers.get('content-range'), `bytes ${start}-${end}/36`, range);
    assert.strictEqual(res.headers.get('content-length'), String(end - start + 1), range);
    assert.deepStrictEqual(res.body, TEXT.subarray(start, end + 1), range);
    assert.ok(res.headers.get('etag'), range);
  }
});

test('Скачивание: несколько диапазонов и неверный Range — 416 с Content-Range bytes */размер', async () => {
  const file = await sharedWithBob(TEXT, 'строго.txt', 'text/plain');
  const bob = people['media-bob'].token;
  for (const range of ['bytes=0-1,4-5', 'bytes=36-', 'bytes=5-2', 'items=0-1', 'bytes=-0', 'bytes=abc', 'bytes= 0-1', 'bytes=-', 'bytes=00000000000000000000001-2']) {
    const res = await get(`/api/files/download/${file.id}`, { token: bob, headers: { Range: range } });
    assert.strictEqual(res.status, 416, range);
    assert.strictEqual(res.headers.get('content-range'), 'bytes */36', range);
  }
});

test('Скачивание: If-Range — совпал ETag — 206, не совпал — весь файл 200', async () => {
  const file = await sharedWithBob(TEXT, 'ифрейндж.txt', 'text/plain');
  const bob = people['media-bob'].token;
  const etag = (await get(`/api/files/download/${file.id}`, { token: bob })).headers.get('etag');
  const partial = await get(`/api/files/download/${file.id}`, { token: bob, headers: { Range: 'bytes=0-3', 'If-Range': etag } });
  assert.strictEqual(partial.status, 206);
  const whole = await get(`/api/files/download/${file.id}`, { token: bob, headers: { Range: 'bytes=0-3', 'If-Range': '"other"' } });
  assert.strictEqual(whole.status, 200);
  assert.deepStrictEqual(whole.body, TEXT);
});

test('Скачивание: доступ проверяется до Range — чужому 403, без токена 401', async () => {
  const file = await sharedWithBob(TEXT, 'чужое.txt', 'text/plain');
  const carol = await get(`/api/files/download/${file.id}`, { token: people['media-carol'].token, headers: { Range: 'bytes=0-1' } });
  assert.strictEqual(carol.status, 403);
  const anon = await get(`/api/files/download/${file.id}`, { headers: { Range: 'bytes=0-1' } });
  assert.strictEqual(anon.status, 401);
});
