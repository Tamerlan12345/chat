const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.resolve(__dirname, '../data/mychat.db');

let db;
function database() {
  if (!db) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch {}
    }
    db = require('../src/db').getDatabase();
  }
  return db;
}

const MessageService = require('../src/services/message.service');
const AuthService = require('../src/services/auth.service');

// Двое сотрудников: администратор из начального наполнения и заведённый здесь.
function participants() {
  const d = database();
  const admin = d.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  let mate = d.prepare("SELECT id FROM users WHERE username = 'kollega'").get();
  if (!mate) {
    const created = AuthService.register({
      username: 'kollega',
      password: 'парольколлеги',
      full_name: 'Коллега Коллегович'
    });
    AuthService.approveUser(created.id);
    mate = { id: created.id };
  }
  return { adminId: admin.id, mateId: mate.id };
}

test('своё непрочитанное сообщение приходит без статуса «прочитано»', () => {
  const { adminId, mateId } = participants();
  MessageService.sendMessage({
    conversationType: 'direct',
    targetId: mateId,
    senderId: adminId,
    text: 'Проверка связи'
  });

  const forSender = MessageService.getMessages('direct', mateId, adminId);
  const last = forSender[forSender.length - 1];
  assert.strictEqual(last.text, 'Проверка связи');
  assert.notStrictEqual(last.delivery_status, 'read', 'получатель ещё не открывал диалог');
});

test('после отметки о прочтении отправитель видит «прочитано»', () => {
  const { adminId, mateId } = participants();
  MessageService.markAsRead('direct', adminId, mateId);

  const forSender = MessageService.getMessages('direct', mateId, adminId);
  const last = forSender[forSender.length - 1];
  assert.strictEqual(last.delivery_status, 'read', 'галочки должны стать двойными');
});

test('markAsRead возвращает список отмеченных сообщений', () => {
  // Клиент отправителя обновляет по нему галочки, не перезагружая переписку.
  const { adminId, mateId } = participants();
  const sent = MessageService.sendMessage({
    conversationType: 'direct',
    targetId: mateId,
    senderId: adminId,
    text: 'Второе сообщение'
  });

  const result = MessageService.markAsRead('direct', adminId, mateId);
  assert.ok(Array.isArray(result.messageIds));
  assert.ok(result.messageIds.includes(sent.id));
});

test('чужое прочтение не отмечает сообщения третьего лица', () => {
  const { adminId, mateId } = participants();
  // Коллега пишет администратору; для коллеги-отправителя статус не «прочитано»,
  // пока администратор не откроет диалог.
  MessageService.sendMessage({
    conversationType: 'direct',
    targetId: adminId,
    senderId: mateId,
    text: 'Ответное сообщение'
  });

  const forMate = MessageService.getMessages('direct', adminId, mateId);
  const last = forMate[forMate.length - 1];
  assert.strictEqual(last.text, 'Ответное сообщение');
  assert.notStrictEqual(last.delivery_status, 'read');
});
