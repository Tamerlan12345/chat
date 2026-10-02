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

// ══ Миниатюры ════════════════════════════════════════════════════════════════

// Снимок 1200×800, повёрнутый EXIF-ом (orientation 6 — показывать 800×1200),
// с EXIF внутри: в миниатюру он попасть не должен.
async function photo({ width = 1200, height = 800, orientation = 6 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: '#d03030' } })
    .composite([{ input: { create: { width: Math.round(width / 4), height, channels: 3, background: '#2040c0' } }, left: 0, top: 0 }])
    .jpeg()
    .withMetadata({ orientation })
    .toBuffer();
}

// PNG, заявляющий 20000×20000 (400 Мп) при размере в сотню байт.
function decompressionBomb() {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20000, 0);
  ihdr.writeUInt32BE(20000, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const thumbsDir = () => path.join(config.UPLOADS_DIR, '.thumbs');
const thumbFiles = (id) => (fs.existsSync(thumbsDir()) ? fs.readdirSync(thumbsDir()).filter((n) => n.startsWith(`${id}-`)) : []);

test('Миниатюра: WebP по длинной стороне 160/480, повёрнута по EXIF, без метаданных; кэш на диске по id', async () => {
  const file = await sharedWithBob(await photo(), 'снимок.jpg', 'image/jpeg');
  const bob = people['media-bob'].token;
  const small = await get(`/api/files/thumb/${file.id}?size=s`, { token: bob });
  assert.strictEqual(small.status, 200, small.body.toString());
  assert.strictEqual(small.headers.get('content-type'), 'image/webp');
  assert.strictEqual(small.headers.get('x-content-type-options'), 'nosniff');
  const meta = await sharp(small.body).metadata();
  assert.strictEqual(meta.format, 'webp');
  assert.deepStrictEqual([meta.width, meta.height], [107, 160], 'портрет после поворота по EXIF');
  assert.ok(!meta.exif, 'EXIF не попал в миниатюру');
  assert.ok(thumbFiles(file.id).some((n) => /^\d+-[0-9a-f]{16}-s\.webp$/.test(n)), 'кэш назван по id файла и ключу содержимого');

  const medium = await get(`/api/files/thumb/${file.id}?size=m`, { token: bob });
  assert.strictEqual(medium.status, 200);
  const m = await sharp(medium.body).metadata();
  assert.deepStrictEqual([m.width, m.height], [320, 480]);

  const byDefault = await get(`/api/files/thumb/${file.id}`, { token: bob });
  assert.deepStrictEqual(byDefault.body, small.body, 'без size — маленькая');
});

test('Миниатюра: ETag и If-None-Match — 304; JPEG по запросу; маленькая картинка не увеличивается', async () => {
  const file = await sharedWithBob(await photo({ width: 100, height: 60, orientation: 1 }), 'мелкая.jpg', 'image/jpeg');
  const bob = people['media-bob'].token;
  const first = await get(`/api/files/thumb/${file.id}?size=m`, { token: bob });
  assert.strictEqual(first.status, 200);
  const meta = await sharp(first.body).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [100, 60]);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.match(first.headers.get('cache-control'), /private/);
  const again = await get(`/api/files/thumb/${file.id}?size=m`, { token: bob, headers: { 'If-None-Match': etag } });
  assert.strictEqual(again.status, 304);

  const jpeg = await get(`/api/files/thumb/${file.id}?size=s&format=jpeg`, { token: bob });
  assert.strictEqual(jpeg.status, 200);
  assert.strictEqual(jpeg.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual((await sharp(jpeg.body).metadata()).format, 'jpeg');
  assert.notStrictEqual(jpeg.headers.get('etag'), etag);
});

test('Миниатюра: доступ как у скачивания — чужому 403, без токена 401, нет файла 404', async () => {
  const file = await sharedWithBob(await photo(), 'закрытое.jpg', 'image/jpeg');
  assert.strictEqual((await get(`/api/files/thumb/${file.id}`, { token: people['media-carol'].token })).status, 403);
  assert.strictEqual((await get(`/api/files/thumb/${file.id}`)).status, 401);
  assert.strictEqual((await get('/api/files/thumb/999999', { token: people.admin.token })).status, 404);
  assert.deepStrictEqual(thumbFiles(file.id), [], 'отказ не порождает миниатюру');
});

test('Миниатюра: неверный размер или формат — 400', async () => {
  const file = await sharedWithBob(await photo(), 'параметры.jpg', 'image/jpeg');
  const bob = people['media-bob'].token;
  for (const query of ['size=xl', 'size=../../x', 'format=png', 'format=svg']) {
    const res = await get(`/api/files/thumb/${file.id}?${query}`, { token: bob });
    assert.strictEqual(res.status, 400, query);
  }
});

test('Миниатюра: тип — по сигнатуре; MIME «image/png» у текста, PDF или SVG — 415', async () => {
  const bob = people['media-bob'].token;
  const text = await sharedWithBob(Buffer.from('просто текст'), 'заметка.txt', 'text/plain');
  const res = await get(`/api/files/thumb/${text.id}`, { token: bob });
  assert.strictEqual(res.status, 415);
  assert.strictEqual(JSON.parse(res.body).code, 'NOT_AN_IMAGE');

  // MIME в базе назвал загрузивший — ему не верим.
  const chatDb = require('../src/db').getDatabase();
  for (const [name, bytes] of [
    ['поддельная.png', Buffer.from('%PDF-1.7\n1 0 obj')],
    ['вектор.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')]
  ]) {
    const stored = path.join(config.UPLOADS_DIR, `forged-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    fs.writeFileSync(stored, bytes);
    const row = chatDb.prepare(`INSERT INTO files (uploader_id, original_name, stored_filename, file_size, mime_type, sha256, path, created_at)
      VALUES (?, ?, ?, ?, 'image/png', NULL, ?, ?)`).run(people['media-bob'].id, name, path.basename(stored), bytes.length, stored, new Date().toISOString());
    const forged = await get(`/api/files/thumb/${row.lastInsertRowid}`, { token: bob });
    assert.strictEqual(forged.status, 415, name);
  }
});

test('Миниатюра: «бомба распаковки» (20000×20000 в сотне байт) — 422 без декодирования', async () => {
  const file = await sharedWithBob(decompressionBomb(), 'бомба.png', 'image/png');
  const res = await get(`/api/files/thumb/${file.id}`, { token: people['media-bob'].token });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(JSON.parse(res.body).code, 'IMAGE_TOO_LARGE');
  assert.deepStrictEqual(thumbFiles(file.id), []);
});

test('Миниатюра: битая картинка — 422 IMAGE_UNREADABLE', async () => {
  const good = await photo({ orientation: 1 });
  const broken = Buffer.concat([good.subarray(0, 40), Buffer.alloc(200, 0x11)]);
  const file = await sharedWithBob(broken, 'битая.jpg', 'image/jpeg');
  const res = await get(`/api/files/thumb/${file.id}`, { token: people['media-bob'].token });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(JSON.parse(res.body).code, 'IMAGE_UNREADABLE');
});

// ══ Размеры и цвет картинки во вложении ══════════════════════════════════════

const COLOR_RE = /^#[0-9a-f]{6}$/;

test('Загрузка картинки: ответ несёт width/height (с учётом поворота) и преобладающий цвет; не картинка — null', async () => {
  const image = await upload(await photo(), 'размеры.jpg', 'image/jpeg');
  assert.strictEqual(image.width, 800);
  assert.strictEqual(image.height, 1200);
  assert.match(image.dominantColor, COLOR_RE);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(image.dominantColor.slice(i, i + 2), 16));
  assert.ok(r > 150 && g < 100 && b < 100, `преобладает красный: ${image.dominantColor}`);

  const text = await upload(Buffer.from('не картинка'), 'текст.txt', 'text/plain');
  assert.strictEqual(text.width, null);
  assert.strictEqual(text.height, null);
  assert.strictEqual(text.dominantColor, null);

  const bomb = await upload(decompressionBomb(), 'бомба-2.png', 'image/png');
  assert.strictEqual(bomb.width, null, '«бомбу» сервер не декодирует');
});

test('Сообщение с картинкой: file_width, file_height, file_dominant_color; у прочих сообщений — null', async () => {
  const file = await sharedWithBob(await photo(), 'в-ленте.jpg', 'image/jpeg');
  await MessageService.sendMessage({
    conversationType: 'direct', targetId: people['media-bob'].id, senderId: people.admin.id, text: 'просто текст'
  });
  const messages = await MessageService.getMessages('direct', people['media-bob'].id, people.admin.id);
  const withImage = messages.find((m) => m.text === 'в-ленте.jpg');
  assert.strictEqual(withImage.file_width, 800);
  assert.strictEqual(withImage.file_height, 1200);
  assert.match(withImage.file_dominant_color, COLOR_RE);
  const plain = messages[messages.length - 1];
  assert.strictEqual(plain.text, 'просто текст');
  assert.strictEqual(plain.file_width, null);
  assert.strictEqual(plain.file_height, null);
  assert.strictEqual(plain.file_dominant_color, null);

  // То же — в REST-ответе страницы сообщений.
  const res = await fetch(`${baseUrl}/api/messages/direct/${people.admin.id}`, { headers: { Authorization: `Bearer ${people['media-bob'].token}` } });
  const page = await res.json();
  const listed = (Array.isArray(page) ? page : page.messages).find((m) => m.text === 'в-ленте.jpg');
  assert.strictEqual(listed.file_width, 800);
});

test('Старое вложение без размеров: размеры и цвет дописываются при первой миниатюре', async () => {
  const file = await sharedWithBob(await photo({ orientation: 1 }), 'старое.jpg', 'image/jpeg');
  const chatDb = require('../src/db').getDatabase();
  chatDb.prepare('UPDATE files SET width = NULL, height = NULL, dominant_color = NULL WHERE id = ?').run(file.id);
  const thumb = await get(`/api/files/thumb/${file.id}?size=m`, { token: people['media-bob'].token });
  assert.strictEqual(thumb.status, 200);
  const row = chatDb.prepare('SELECT width, height, dominant_color FROM files WHERE id = ?').get(file.id);
  assert.deepStrictEqual([row.width, row.height], [1200, 800]);
  assert.match(row.dominant_color, COLOR_RE);
});
