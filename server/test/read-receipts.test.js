const test = require('node:test');
const assert = require('node:assert');
const { freshBoot } = require('./helpers/boot');

const MessageService = require('../src/services/message.service');
const AuthService = require('../src/services/auth.service');

let identity;

test.before(async () => {
  ({ identity } = await freshBoot());
});

// Двое сотрудников: администратор из начального наполнения и заведённый здесь.
async function participants() {
  const admin = await identity.get(`SELECT id FROM users WHERE username = 'admin'`);
  let mate = await identity.get(`SELECT id FROM users WHERE username = 'kollega'`);
  if (!mate) {
    const created = await AuthService.register({
      username: 'kollega',
      password: 'парольколлеги',
      full_name: 'Коллега Коллегович'
    });
    await AuthService.approveUser(created.id);
    mate = { id: created.id };
  }
  return { adminId: admin.id, mateId: mate.id };
}

test('своё непрочитанное сообщение приходит без статуса «прочитано»', async () => {
  const { adminId, mateId } = await participants();
  await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: mateId,
    senderId: adminId,
    text: 'Проверка связи'
  });

  const forSender = await MessageService.getMessages('direct', mateId, adminId);
  const last = forSender[forSender.length - 1];
  assert.strictEqual(last.text, 'Проверка связи');
  assert.notStrictEqual(last.delivery_status, 'read', 'получатель ещё не открывал диалог');
});

test('после отметки о прочтении отправитель видит «прочитано»', async () => {
  const { adminId, mateId } = await participants();
  MessageService.markAsRead('direct', adminId, mateId);

  const forSender = await MessageService.getMessages('direct', mateId, adminId);
  const last = forSender[forSender.length - 1];
  assert.strictEqual(last.delivery_status, 'read', 'галочки должны стать двойными');
});

test('markAsRead возвращает список отмеченных сообщений', async () => {
  // Клиент отправителя обновляет по нему галочки, не перезагружая переписку.
  const { adminId, mateId } = await participants();
  const sent = await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: mateId,
    senderId: adminId,
    text: 'Второе сообщение'
  });

  const result = MessageService.markAsRead('direct', adminId, mateId);
  assert.ok(Array.isArray(result.messageIds));
  assert.ok(result.messageIds.includes(sent.id));
});

test('чужое прочтение не отмечает сообщения третьего лица', async () => {
  const { adminId, mateId } = await participants();
  // Коллега пишет администратору; для коллеги-отправителя статус не «прочитано»,
  // пока администратор не откроет диалог.
  await MessageService.sendMessage({
    conversationType: 'direct',
    targetId: adminId,
    senderId: mateId,
    text: 'Ответное сообщение'
  });

  const forMate = await MessageService.getMessages('direct', adminId, mateId);
  const last = forMate[forMate.length - 1];
  assert.strictEqual(last.text, 'Ответное сообщение');
  assert.notStrictEqual(last.delivery_status, 'read');
});

test('имя отправителя подставляется из хранилища учётных записей', async () => {
  // Сообщения и люди лежат в разных базах — соединить их одним запросом
  // больше нельзя, и подстановка стала отдельным шагом. Проверяется, что этот
  // шаг не забыт: без него в переписке вместо имён были бы пустые места.
  const { adminId, mateId } = await participants();
  const messages = await MessageService.getMessages('direct', mateId, adminId);

  assert.ok(messages.length > 0);
  for (const message of messages) {
    assert.ok(message.sender_name, 'у каждого сообщения должно быть имя отправителя');
  }
});

test('список диалогов содержит только тех, с кем переписка была', async () => {
  const { adminId, mateId } = await participants();

  // Третий сотрудник, которому никто не писал.
  const stranger = await AuthService.register({
    username: 'neznakomec',
    password: 'парольнезнакомца',
    full_name: 'Незнакомец Незнакомцев'
  });
  await AuthService.approveUser(stranger.id);

  const convos = await MessageService.getDirectConversations(adminId);
  const ids = convos.map((c) => c.user_id);

  assert.ok(ids.includes(mateId), 'собеседник должен быть в списке');
  assert.ok(!ids.includes(stranger.id), 'беседа не должна появляться сама собой');
});
