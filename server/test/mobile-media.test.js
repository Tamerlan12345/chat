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
let wsServer;
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
  wsServer = require('../src/ws/server');
  wsServer.init(server);
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
  wsServer?.wss?.clients.forEach((client) => client.terminate());
  server?.close();
  await closeAll();
});

// Предел загрузок фото (10 в минуту) — свой в каждом тесте.
test.beforeEach(() => {
  const limiter = require('../src/services/rate-limiter');
  for (const p of Object.values(people)) limiter.resetLimit(`avatar:${p.id}`);
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

// ══ Миниатюры: повторные отказы, предел отрисовок, кэш клиента ═════════════════

test('Миниатюра: битую картинку сервер декодирует один раз — повторные запросы получают отказ из памяти', async () => {
  const Images = require('../src/media/images');
  const good = await photo({ orientation: 1 });
  const file = await sharedWithBob(Buffer.concat([good.subarray(0, 40), Buffer.alloc(300, 0x22)]), 'битая-2.jpg', 'image/jpeg');
  const original = Images.renderThumbnail;
  let renders = 0;
  Images.renderThumbnail = (...args) => { renders += 1; return original(...args); };
  try {
    for (const query of ['size=s', 'size=s', 'size=m', 'size=s&format=jpeg']) {
      const res = await get(`/api/files/thumb/${file.id}?${query}`, { token: people['media-bob'].token });
      assert.strictEqual(res.status, 422, query);
      assert.strictEqual(JSON.parse(res.body).code, 'IMAGE_UNREADABLE');
    }
  } finally {
    Images.renderThumbnail = original;
  }
  assert.strictEqual(renders, 1, 'декодирование — один раз на файл');
});

test('Миниатюра: предел отрисовок на сотрудника — сверх него 429, готовые из кэша отдаются', async () => {
  process.env.THUMB_RENDERS_PER_MINUTE = '2';
  require('../src/services/rate-limiter').resetLimit(`thumb-render:${people['media-bob'].id}`);
  try {
    const bob = people['media-bob'].token;
    const files = [];
    for (let i = 0; i < 3; i += 1) files.push(await sharedWithBob(await photo({ width: 300 + i, height: 200, orientation: 1 }), `предел-${i}.jpg`, 'image/jpeg'));
    assert.strictEqual((await get(`/api/files/thumb/${files[0].id}`, { token: bob })).status, 200);
    assert.strictEqual((await get(`/api/files/thumb/${files[1].id}`, { token: bob })).status, 200);
    const third = await get(`/api/files/thumb/${files[2].id}`, { token: bob });
    assert.strictEqual(third.status, 429);
    assert.strictEqual(JSON.parse(third.body).code, 'RATE_LIMITED');
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.strictEqual((await get(`/api/files/thumb/${files[0].id}`, { token: bob })).status, 200, 'из кэша — без предела');
  } finally {
    delete process.env.THUMB_RENDERS_PER_MINUTE;
    require('../src/services/rate-limiter').resetLimit(`thumb-render:${people['media-bob'].id}`);
  }
});

test('Миниатюра: клиент перепроверяет кэш по ETag (не immutable) — после повторного id старая не живёт неделю', async () => {
  const file = await sharedWithBob(await photo({ orientation: 1 }), 'кэш.jpg', 'image/jpeg');
  const res = await get(`/api/files/thumb/${file.id}`, { token: people['media-bob'].token });
  assert.strictEqual(res.status, 200);
  const cc = res.headers.get('cache-control');
  assert.match(cc, /private/);
  assert.match(cc, /no-cache/);
  assert.doesNotMatch(cc, /immutable|max-age=[1-9]/);
});

test('Скачивание: If-Range проверяется раньше Range — не совпал, значит весь файл 200 даже при неверном Range', async () => {
  const file = await sharedWithBob(TEXT, 'порядок.txt', 'text/plain');
  const res = await get(`/api/files/download/${file.id}`, {
    token: people['media-bob'].token,
    headers: { Range: 'bytes=0-1,4-5', 'If-Range': '"other"' }
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, TEXT);
});

// ══ Аватары ══════════════════════════════════════════════════════════════════
//
// По умолчанию — как раньше: data URL в avatar_url и sender_avatar. Адрес
// /api/users/<id>/avatar?v=… вместо него — только по явной просьбе клиента:
// заголовок X-Avatar-Format: url (HTTP), ?avatars=url при подключении (WS).

const OPT_IN = { 'X-Avatar-Format': 'url' };
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CentyChat/1.9.0 Chrome/130.0.0.0 Electron/33.2.0 Safari/537.36 OpenMyChatDesktop/1.9.0 (nsis)';
const AVATAR_URL_RE = (id) => new RegExp(`^/api/users/${id}/avatar\\?v=[0-9a-f]{16}$`);

async function putAvatar(buffer, { token, type = 'image/jpeg', name = 'avatar.jpg', headers = OPT_IN } = {}) {
  const form = new FormData();
  if (buffer) form.append('file', new Blob([buffer], { type }), name);
  const res = await fetch(`${baseUrl}/api/users/avatar`, {
    method: 'PUT',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: form
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getJson(urlPath, { token, headers = {} } = {}) {
  const res = await fetch(baseUrl + urlPath, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

async function putProfile(token, body, headers = {}) {
  const res = await fetch(`${baseUrl}/api/users/profile`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

async function storedAvatar(userId) {
  return (await identity.get('SELECT avatar_url FROM users WHERE id = $1', [userId])).avatar_url;
}

const avatarFiles = (id) => {
  const dir = path.join(config.UPLOADS_DIR, '.avatars');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(`${id}-`)) : [];
};

// Снимок с EXIF, где лежит «секрет» (как координаты съёмки у телефона).
async function photoWithExif(format = 'jpeg') {
  const base = sharp({ create: { width: 900, height: 600, channels: 3, background: '#30a050' } });
  return (format === 'png' ? base.png() : base.jpeg())
    .withExif({ IFD0: { Copyright: 'SECRET-GPS-55.75N-37.61E' } })
    .toBuffer();
}

function assertCleanJpegDataUrl(value) {
  assert.match(value, /^data:image\/jpeg;base64,/);
  const bytes = Buffer.from(value.split(',')[1], 'base64');
  assert.ok(!bytes.includes(Buffer.from('SECRET-GPS')), 'EXIF снят');
  return bytes;
}

test('PUT /users/avatar: картинка перекодирована в JPEG ≤256 px без EXIF; с X-Avatar-Format: url в ответе адрес', async () => {
  const bob = people['media-bob'];
  const original = await photoWithExif();
  assert.ok(original.includes(Buffer.from('SECRET-GPS')), 'исходник несёт EXIF');
  const res = await putAvatar(original, { token: bob.token });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.match(res.json.avatar_url, AVATAR_URL_RE(bob.id));
  assert.ok(!JSON.stringify(res.json).includes('data:'), 'ответ без data URL');

  const stored = await storedAvatar(bob.id);
  const meta = await sharp(assertCleanJpegDataUrl(stored)).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.ok(Math.max(meta.width, meta.height) <= 256);
  assert.ok(!meta.exif);

  const plain = await putAvatar(await photo({ orientation: 1 }), { token: bob.token, headers: {} });
  assert.strictEqual(plain.status, 200);
  assert.strictEqual(plain.json.avatar_url, await storedAvatar(bob.id), 'без заголовка — data URL, как раньше');
});

test('PUT /users/avatar: предел — 10 загрузок в минуту, дальше 429', async () => {
  const carol = people['media-carol'];
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await putAvatar(Buffer.from('x'), { token: carol.token, type: 'image/png', name: 'a.png' })).status);
  assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(415));
  assert.strictEqual(statuses[10], 429);
});

test('PUT /users/avatar: не картинка, SVG, «бомба», больше 5 МБ, без файла, без входа — отказ', async () => {
  const bob = people['media-bob'];
  const before = await storedAvatar(bob.id);
  const text = await putAvatar(Buffer.from('просто текст'), { token: bob.token, type: 'image/png', name: 'a.png' });
  assert.strictEqual(text.status, 415);
  assert.strictEqual(text.json.code, 'NOT_AN_IMAGE');
  const svg = await putAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { token: bob.token, type: 'image/svg+xml', name: 'a.svg' });
  assert.strictEqual(svg.status, 415);
  const bomb = await putAvatar(decompressionBomb(), { token: bob.token, type: 'image/png', name: 'a.png' });
  assert.strictEqual(bomb.status, 422);
  assert.strictEqual(bomb.json.code, 'IMAGE_TOO_LARGE');
  const huge = await putAvatar(Buffer.concat([await photo(), Buffer.alloc(5 * 1024 * 1024)]), { token: bob.token });
  assert.strictEqual(huge.status, 413);
  const none = await putAvatar(null, { token: bob.token });
  assert.strictEqual(none.status, 400);
  const anon = await putAvatar(await photo(), {});
  assert.strictEqual(anon.status, 401);
  assert.strictEqual(await storedAvatar(bob.id), before, 'отказы фото не меняют');
});

test('GET /users/:id/avatar: квадрат 96/256 JPEG, ETag и 304, кэш; видно любому вошедшему; нет фото — 404', async () => {
  const bob = people['media-bob'];
  assert.strictEqual((await putAvatar(await photo({ orientation: 1 }), { token: bob.token })).status, 200);
  const carol = people['media-carol'].token;
  const small = await get(`/api/users/${bob.id}/avatar?size=s`, { token: carol });
  assert.strictEqual(small.status, 200);
  assert.strictEqual(small.headers.get('content-type'), 'image/jpeg');
  assert.match(small.headers.get('cache-control'), /private/);
  const sm = await sharp(small.body).metadata();
  assert.deepStrictEqual([sm.width, sm.height], [96, 96]);
  const medium = await get(`/api/users/${bob.id}/avatar`, { token: carol });
  const mm = await sharp(medium.body).metadata();
  assert.deepStrictEqual([mm.width, mm.height], [256, 256], 'без size — m');
  const etag = medium.headers.get('etag');
  assert.strictEqual((await get(`/api/users/${bob.id}/avatar?size=m`, { token: carol, headers: { 'If-None-Match': etag } })).status, 304);
  const cached = avatarFiles(bob.id);
  assert.ok(cached.length >= 2 && cached.every((n) => /^\d+-[0-9a-f]{16}-(s|m)\.jpg$/.test(n)), cached.join(','));

  assert.strictEqual((await get(`/api/users/${bob.id}/avatar`)).status, 401);
  assert.strictEqual((await get(`/api/users/${bob.id}/avatar?size=xl`, { token: carol })).status, 400);
  assert.strictEqual((await get(`/api/users/${people['media-carol'].id}/avatar`, { token: carol })).status, 404);
  assert.strictEqual((await get('/api/users/999999/avatar', { token: carol })).status, 404);
});

test('Кэш аватаров: новое фото и снятие фото убирают перекодированные копии прежнего', async () => {
  const bob = people['media-bob'];
  assert.strictEqual((await putAvatar(await photo({ orientation: 1 }), { token: bob.token })).status, 200);
  await get(`/api/users/${bob.id}/avatar?size=s`, { token: people.admin.token });
  await get(`/api/users/${bob.id}/avatar?size=m`, { token: people.admin.token });
  const before = avatarFiles(bob.id);
  assert.ok(before.length >= 2);

  assert.strictEqual((await putAvatar(await photo({ width: 640, height: 640, orientation: 1 }), { token: bob.token })).status, 200);
  assert.deepStrictEqual(avatarFiles(bob.id).filter((n) => before.includes(n)), [], 'копии прежнего фото удалены при загрузке нового');

  await get(`/api/users/${bob.id}/avatar?size=s`, { token: people.admin.token });
  const png = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#123456' } }).png().toBuffer();
  assert.strictEqual((await putProfile(bob.token, { avatar_url: `data:image/png;base64,${png.toString('base64')}` })).status, 200);
  assert.deepStrictEqual(avatarFiles(bob.id), [], 'смена фото через профиль тоже чистит');

  await get(`/api/users/${bob.id}/avatar?size=s`, { token: people.admin.token });
  assert.ok(avatarFiles(bob.id).length > 0);
  assert.strictEqual((await putProfile(bob.token, { avatar_url: '' })).status, 200);
  assert.deepStrictEqual(avatarFiles(bob.id), [], 'снятие фото через профиль (пустая строка) чистит');
  assert.strictEqual((await putAvatar(await photo({ orientation: 1 }), { token: bob.token })).status, 200);

  await get(`/api/users/${bob.id}/avatar?size=s`, { token: people.admin.token });
  const res = await fetch(`${baseUrl}/api/users/avatar`, { method: 'DELETE', headers: { Authorization: `Bearer ${bob.token}` } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(avatarFiles(bob.id), [], 'после снятия фото копий нет');
});

test('По умолчанию ответы API несут data URL, как раньше (и для браузера, и для Electron); X-Avatar-Format: url — адрес', async () => {
  const bob = people['media-bob'];
  assert.strictEqual((await putAvatar(await photo({ orientation: 1 }), { token: bob.token })).status, 200);
  const stored = await storedAvatar(bob.id);

  for (const headers of [{}, { 'User-Agent': DESKTOP_UA }, { 'User-Agent': 'CentyChat-Android/1.0.0' }, { 'X-Avatar-Format': 'data' }]) {
    const label = JSON.stringify(headers);
    const list = await getJson('/api/users', { token: people.admin.token, headers });
    assert.strictEqual(list.json.find((u) => u.id === bob.id).avatar_url, stored, label);
    const me = await getJson('/api/auth/me', { token: bob.token, headers });
    assert.strictEqual(me.json.user.avatar_url, stored, label);
  }

  const list = await getJson('/api/users', { token: people.admin.token, headers: OPT_IN });
  assert.match(list.json.find((u) => u.id === bob.id).avatar_url, AVATAR_URL_RE(bob.id));
  assert.ok(!list.text.includes('data:image'), 'в справочнике нет data URL');
  const me = await getJson('/api/auth/me', { token: bob.token, headers: { 'X-Avatar-Format': 'URL' } });
  assert.match(me.json.user.avatar_url, AVATAR_URL_RE(bob.id), 'значение без учёта регистра');

  await MessageService.sendMessage({ conversationType: 'direct', targetId: people.admin.id, senderId: bob.id, text: 'привет с фото' });
  const page = await getJson(`/api/messages/direct/${bob.id}`, { token: people.admin.token, headers: OPT_IN });
  const rows = Array.isArray(page.json) ? page.json : page.json.messages;
  assert.match(rows.find((m) => m.text === 'привет с фото').sender_avatar, AVATAR_URL_RE(bob.id));
  const convs = await getJson('/api/conversations/direct', { token: people.admin.token, headers: OPT_IN });
  assert.match(convs.json.find((c) => c.user_id === bob.id).avatar_url, AVATAR_URL_RE(bob.id));
  const plainPage = await getJson(`/api/messages/direct/${bob.id}`, { token: people.admin.token });
  const plainRows = Array.isArray(plainPage.json) ? plainPage.json : plainPage.json.messages;
  assert.strictEqual(plainRows.find((m) => m.text === 'привет с фото').sender_avatar, stored);
});

test('PUT /users/profile с data URL: фото перекодируется (JPEG без EXIF), остаётся data URL; не картинка — 400', async () => {
  const carol = people['media-carol'];
  const png = await photoWithExif('png');
  assert.ok(png.includes(Buffer.from('SECRET-GPS')));
  const saved = await putProfile(carol.token, { avatar_url: `data:image/png;base64,${png.toString('base64')}` });
  assert.strictEqual(saved.status, 200, saved.text);
  const stored = await storedAvatar(carol.id);
  assert.strictEqual(saved.json.avatar_url, stored, 'по умолчанию — data URL');
  const meta = await sharp(assertCleanJpegDataUrl(stored)).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 256);

  // Форма настольного клиента отправляет полученное значение обратно — без изменений.
  assert.strictEqual((await putProfile(carol.token, { avatar_url: stored, phone: '+7 701 111 11 11' })).status, 200);
  assert.strictEqual(await storedAvatar(carol.id), stored);

  const fake = await putProfile(carol.token, { avatar_url: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.strictEqual(fake.status, 400, 'сигнатура без картинки');
  assert.strictEqual(await storedAvatar(carol.id), stored);
});

test('Старое фото data URL в базе (до перекодирования): по адресу отдаётся перекодированным', async () => {
  const carol = people['media-carol'];
  const png = await sharp({ create: { width: 200, height: 120, channels: 4, background: { r: 10, g: 20, b: 200, alpha: 0.5 } } }).png().toBuffer();
  const legacy = `data:image/png;base64,${png.toString('base64')}`;
  await identity.run('UPDATE users SET avatar_url = $1 WHERE id = $2', [legacy, carol.id]);
  const plain = await getJson('/api/users', { token: people.admin.token });
  assert.strictEqual(plain.json.find((u) => u.id === carol.id).avatar_url, legacy, 'настольному — как хранится');
  const served = await get(`/api/users/${carol.id}/avatar?size=s`, { token: people.admin.token });
  assert.strictEqual(served.status, 200);
  assert.strictEqual((await sharp(served.body).metadata()).format, 'jpeg', 'не исходный PNG');
  assert.ok(!served.body.equals(png));
});

test('Сохранение профиля клиентом с адресами: свой адрес аватара обратно — фото не меняется, прочие поля сохраняются', async () => {
  const bob = people['media-bob'];
  assert.strictEqual((await putAvatar(await photo({ orientation: 1 }), { token: bob.token })).status, 200);
  const stored = await storedAvatar(bob.id);
  const me = await getJson('/api/auth/me', { token: bob.token, headers: OPT_IN });
  const res = await putProfile(bob.token, { avatar_url: me.json.user.avatar_url, phone: '+7 701 000 00 00' }, OPT_IN);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(await storedAvatar(bob.id), stored);
  assert.strictEqual(res.json.phone, '+7 701 000 00 00');
});

test('Старая ссылка (не data URL) в avatar_url: с X-Avatar-Format: url — null, по умолчанию — как раньше; по адресу — 404', async () => {
  const carol = people['media-carol'];
  await identity.run('UPDATE users SET avatar_url = $1 WHERE id = $2', ['https://old.example/photo.png', carol.id]);
  const optIn = await getJson('/api/users', { token: people.admin.token, headers: OPT_IN });
  assert.strictEqual(optIn.json.find((u) => u.id === carol.id).avatar_url, null);
  assert.strictEqual((await get(`/api/users/${carol.id}/avatar`, { token: people.admin.token })).status, 404);
  const plain = await getJson('/api/users', { token: people.admin.token });
  assert.strictEqual(plain.json.find((u) => u.id === carol.id).avatar_url, 'https://old.example/photo.png');
});

test('DELETE /users/avatar: фото снято, по адресу — 404', async () => {
  const bob = people['media-bob'];
  assert.strictEqual((await putAvatar(await photo({ orientation: 1 }), { token: bob.token })).status, 200);
  const res = await fetch(`${baseUrl}/api/users/avatar`, { method: 'DELETE', headers: { Authorization: `Bearer ${bob.token}` } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).avatar_url, null);
  assert.strictEqual(await storedAvatar(bob.id), null);
  assert.strictEqual((await get(`/api/users/${bob.id}/avatar`, { token: people.admin.token })).status, 404);
});

// WebSocket: адреса — сокету, подключившемуся с ?avatars=url; остальным — data URL.
async function openSocket(token, query = '', headers = {}) {
  const WebSocket = require('ws');
  const sock = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws${query}`, { headers });
  const inbox = [];
  sock.on('message', (raw, binary) => { if (!binary) inbox.push(JSON.parse(raw.toString('utf8'))); });
  await new Promise((resolve) => sock.on('open', resolve));
  sock.send(JSON.stringify({ type: 'auth', token }));
  const until = async (pred) => {
    for (let i = 0; i < 300; i += 1) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('кадр не пришёл');
  };
  await until((m) => m.type === 'auth_success');
  return { sock, inbox, until };
}

test('WebSocket: с ?avatars=url — адрес в auth_success и в сообщениях; по умолчанию (и у Electron) — data URL', async () => {
  const bob = people['media-bob'];
  assert.strictEqual((await putAvatar(await photo({ orientation: 1 }), { token: bob.token })).status, 200);
  const stored = await storedAvatar(bob.id);
  const mobile = await openSocket(bob.token, '?avatars=url');
  const plainBob = await openSocket(bob.token);
  const desktop = await openSocket(people.admin.token, '', { 'User-Agent': DESKTOP_UA });
  const mobileAdmin = await openSocket(people.admin.token, '?avatars=url');
  try {
    assert.match(mobile.inbox.find((m) => m.type === 'auth_success').user.avatar_url, AVATAR_URL_RE(bob.id));
    assert.strictEqual(plainBob.inbox.find((m) => m.type === 'auth_success').user.avatar_url, stored);
    mobile.sock.send(JSON.stringify({ type: 'direct_message', targetId: people.admin.id, text: 'кадр с фото', client_msg_id: require('node:crypto').randomUUID() }));
    const onDesktop = await desktop.until((m) => m.message?.text === 'кадр с фото');
    const onMobile = await mobileAdmin.until((m) => m.message?.text === 'кадр с фото');
    assert.strictEqual(onDesktop.message.sender_avatar, stored);
    assert.match(onMobile.message.sender_avatar, AVATAR_URL_RE(bob.id));
  } finally {
    for (const c of [mobile, plainBob, desktop, mobileAdmin]) c.sock.close();
  }
});

test('WebSocket с ?avatars=url: старая ссылка (не data URL) в кадрах — null; по умолчанию — как хранится', async () => {
  const carol = people['media-carol'];
  await identity.run('UPDATE users SET avatar_url = $1 WHERE id = $2', ['https://old.example/carol.png', carol.id]);
  const mobileCarol = await openSocket(carol.token, '?avatars=url');
  const mobileAdmin = await openSocket(people.admin.token, '?avatars=url');
  const plainAdmin = await openSocket(people.admin.token);
  try {
    assert.strictEqual(mobileCarol.inbox.find((m) => m.type === 'auth_success').user.avatar_url, null, 'auth_success');
    mobileCarol.sock.send(JSON.stringify({ type: 'direct_message', targetId: people.admin.id, text: 'кадр со старой ссылкой', client_msg_id: require('node:crypto').randomUUID() }));
    const onMobile = await mobileAdmin.until((m) => m.message?.text === 'кадр со старой ссылкой');
    assert.strictEqual(onMobile.message.sender_avatar, null, 'new_message');
    const onPlain = await plainAdmin.until((m) => m.message?.text === 'кадр со старой ссылкой');
    assert.strictEqual(onPlain.message.sender_avatar, 'https://old.example/carol.png');

    const adminRes = await fetch(`${baseUrl}/api/admin/users/${carol.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${people.admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_title: 'Аналитик' })
    });
    assert.strictEqual(adminRes.status, 200, await adminRes.text());
    const updated = await mobileAdmin.until((m) => m.type === 'user_updated');
    const user = updated.user || updated;
    assert.strictEqual(user.avatar_url, null, 'user_updated');
  } finally {
    for (const c of [mobileCarol, mobileAdmin, plainAdmin]) c.sock.close();
  }
});

// Третья одновременная загрузка — 429 «дождитесь» с Retry-After: клиенты
// (Android, iOS) ждут по заголовку, а не гадают (final-review-parity, Minor).
test('предел одновременных загрузок: 429 с Retry-After', async () => {
  const { port } = server.address();
  const boundary = 'parallel-limit-boundary';
  const held = [];
  const openUpload = () => new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/files/upload',
      headers: {
        Authorization: `Bearer ${people['media-carol'].token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': 4096
      }
    });
    req.on('error', () => {});
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    // Начало формы — и тишина: загрузка «идёт».
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\nпервые байты`);
    held.push(req);
  });
  try {
    openUpload();
    openUpload();
    await new Promise((r) => setTimeout(r, 300));
    const third = await openUpload();
    assert.strictEqual(third.status, 429);
    assert.match(third.body, /Дождитесь окончания текущих загрузок/);
    const retryAfter = Number(third.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 30, `Retry-After: ${third.headers['retry-after']}`);
  } finally {
    for (const req of held) req.destroy();
  }
});
