const test = require('node:test');
const assert = require('node:assert');
const { freshBoot } = require('./helpers/boot');

const MessageService = require('../src/services/message.service');
const AuthService = require('../src/services/auth.service');

let identity;
let chat;

test.before(async () => {
  ({ identity, chat } = await freshBoot());
});

// ── Находка #6: скачиваемое имя вложения не должно зависеть от текста
// сообщения (его при желании можно подделать/спутать) — только от
// неизменного original_name, записанного в таблицу files при загрузке.

async function participants() {
  const admin = await identity.get(`SELECT id FROM users WHERE username = 'admin'`);
  let mate = await identity.get(`SELECT id FROM users WHERE username = 'kollega-file'`);
  if (!mate) {
    const created = await AuthService.register({
      username: 'kollega-file',
      password: 'парольколлеги2',
      full_name: 'Коллега Файлович'
    });
    await AuthService.approveUser(created.id);
    mate = { id: created.id };
  }
  return { adminId: admin.id, mateId: mate.id };
}

function insertFile({ uploaderId, originalName }) {
  const now = new Date().toISOString();
  const result = chat
    .prepare(`
      INSERT INTO files (uploader_id, original_name, stored_filename, file_size, mime_type, sha256, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(uploaderId, originalName, 'stored_test_file.bin', 1234, 'application/octet-stream', 'deadbeef', '/tmp/stored_test_file.bin', now);
  return Number(result.lastInsertRowid);
}

test('сообщение с вложением возвращает исходное имя файла из таблицы files', async () => {
  const { adminId, mateId } = await participants();
  const fileId = insertFile({ uploaderId: adminId, originalName: 'Договор поставки.pdf' });

  await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: mateId,
    senderId: adminId,
    text: 'какой-то текст сообщения, не имя файла',
    type: 'file',
    metadata: { file_id: fileId, size: 1234, mimeType: 'application/octet-stream' }
  });

  const messages = await MessageService.getMessages('direct', mateId, adminId);
  const last = messages[messages.length - 1];
  assert.strictEqual(last.file_original_name, 'Договор поставки.pdf');
  // Само неизменное имя не совпадает с произвольным текстом сообщения —
  // клиент обязан брать имя для скачивания именно отсюда, а не из text.
  assert.notStrictEqual(last.file_original_name, last.text);
});

test('сообщения без вложения не получают поле file_original_name', async () => {
  const { adminId, mateId } = await participants();
  await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: mateId,
    senderId: adminId,
    text: 'обычное текстовое сообщение'
  });

  const messages = await MessageService.getMessages('direct', mateId, adminId);
  const last = messages[messages.length - 1];
  assert.strictEqual(last.file_original_name, null);
});

test('поле file_original_name не спутывает файлы разных сообщений (не LIKE-подстрока)', async () => {
  const { adminId, mateId } = await participants();
  const fileId1 = insertFile({ uploaderId: adminId, originalName: 'один.pdf' });
  const fileId2 = insertFile({ uploaderId: adminId, originalName: 'двенадцать.pdf' });

  await MessageService.sendMessage({
    conversationType: 'direct', targetId: mateId, senderId: adminId, text: 'ф1', type: 'file',
    metadata: { file_id: fileId1 }
  });
  await MessageService.sendMessage({
    conversationType: 'direct', targetId: mateId, senderId: adminId, text: 'ф2', type: 'file',
    metadata: { file_id: fileId2 }
  });

  const messages = await MessageService.getMessages('direct', mateId, adminId);
  const m1 = messages.find((m) => m.text === 'ф1');
  const m2 = messages.find((m) => m.text === 'ф2');
  assert.strictEqual(m1.file_original_name, 'один.pdf');
  assert.strictEqual(m2.file_original_name, 'двенадцать.pdf');
});
