const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resetDatabaseFiles, resetPostgresSchema, DATA_DIR, closeAll } = require('./helpers/boot');
const { buildLegacyDatabase } = require('./helpers/legacy-db');

// Миграция базы переписки на месте для надёжной доставки (задача 5):
// у существующей установки в messages нет client_msg_id и change_seq. Они
// добавляются при открытии базы, change_seq заполняется для старых строк
// (по возрастанию id), updated_at старых строк НЕ трогается — настольный
// клиент показывает «Изменено» по непустому updated_at
// (desktop/src/renderer/src/components/ChatView.jsx), и заполнение пометило
// бы всю историю как отредактированную.

let chat;

test.before(async () => {
  resetDatabaseFiles();
  await resetPostgresSchema();
  buildLegacyDatabase(path.join(DATA_DIR, 'mychat.db'));
  const { bootstrap } = require('../src/bootstrap');
  await bootstrap();
  chat = require('../src/db').getDatabase();
});

test.after(async () => {
  await closeAll();
});

test('новые колонки добавлены, change_seq старых строк заполнен по id, updated_at не тронут', () => {
  const columns = chat.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  assert.ok(columns.includes('client_msg_id'));
  assert.ok(columns.includes('change_seq'));

  const rows = chat.prepare('SELECT id, change_seq, client_msg_id, updated_at FROM messages ORDER BY id').all();
  assert.strictEqual(rows.length, 3);
  for (const row of rows) {
    assert.strictEqual(Number(row.change_seq), Number(row.id));
    assert.strictEqual(row.client_msg_id, null);
    assert.strictEqual(row.updated_at, null, 'updated_at старых строк остаётся пустым');
  }
});

test('индексы идемпотентности и курсора на месте и уникальны (после перестроения таблицы тоже)', () => {
  const indexes = chat.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all();
  const byName = new Map(indexes.map((i) => [i.name, i.sql]));
  assert.match(byName.get('idx_messages_client_msg') || '', /UNIQUE/i);
  assert.match(byName.get('idx_messages_change_seq') || '', /UNIQUE/i);
});

test('новая отправка получает следующий номер изменения; повторное открытие базы ничего не ломает', async () => {
  const MessageService = require('../src/services/message.service');
  const db = require('../src/db');
  const before = Number(chat.prepare('SELECT MAX(change_seq) AS m FROM messages').get().m);
  const sent = await MessageService.sendMessage({ conversationType: 'channel', targetId: 1, senderId: 1, text: 'после миграции' });
  const seq = Number(chat.prepare('SELECT change_seq FROM messages WHERE id = ?').get(sent.id).change_seq);
  assert.strictEqual(seq, before + 1);

  db.closeDatabase();
  chat = db.getDatabase();
  const again = chat.prepare('SELECT id, change_seq FROM messages ORDER BY id').all();
  assert.strictEqual(again.length, 4);
  assert.deepStrictEqual(again.map((r) => Number(r.change_seq)), [1, 2, 3, before + 1]);
});

test('строки без change_seq (например, восстановленные старым кодом) получают номера ВЫШЕ текущего максимума', () => {
  const db = require('../src/db');
  const max = Number(chat.prepare('SELECT MAX(change_seq) AS m FROM messages').get().m);
  chat.prepare("INSERT INTO messages (conversation_type, target_id, sender_id, text, created_at) VALUES ('channel', 1, 2, 'вставлено мимо сервиса', ?)")
    .run(new Date().toISOString());
  db.closeDatabase();
  chat = db.getDatabase();
  const row = chat.prepare("SELECT id, change_seq FROM messages WHERE text = 'вставлено мимо сервиса'").get();
  assert.ok(Number(row.change_seq) > max);
});
