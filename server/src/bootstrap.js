const { getDatabase, finalizeIdentitySplit, seedChatDefaults } = require('./db');
const { initIdentity, identity, isIdentityReady, closeIdentity } = require('./db/identity');

// Порядок запуска важен и поэтому собран в одном месте.
//
//  1. Открыть базу переписки — из неё берутся учётные записи прежней версии.
//  2. Поднять хранилище учётных записей: схема, перенос, первичное заполнение.
//  3. Завести системные каналы, если установка чистая.
//  4. Только теперь — убрать из базы переписки то, что переехало.
//
// Шаг 4 идёт последним намеренно: до него единственная копия учётных записей
// ещё может оказаться в старой базе, и падение на шаге 2 не должно стоить
// компании её сотрудников.

let started = null;

// Сотрудники, заведённые через консоль до исправления, в общих каналах не
// состояли: канал был виден, а читать и писать в него было нельзя. При каждом
// запуске недостающее участие добавляется — повторно ничего не дублируется.
async function syncDefaultChannelMembers() {
  const MessageService = require('./services/message.service');
  const members = await identity().all(
    `SELECT id FROM users WHERE is_active = 1 AND approval_status = 'approved'`
  );
  const added = MessageService.addToDefaultChannels(members.map((m) => m.id));
  if (added) console.log(`[DB] Добавлено участий в общих каналах: ${added}`);
  return added;
}

// Аудит, находка №8: без предела в knock, брошенная (никем не связанная)
// очередь устройств растёт бесконечно. Предел в knock останавливает рост «в
// моменте», а эта уборка при каждом запуске выметает то, что накопилось до
// предела и так и осталось невостребованным — тридцать дней с лихвой
// перекрывают любой разумный отпуск администратора.
async function pruneStaleDevices() {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const result = await identity().run(
    `DELETE FROM pending_devices WHERE first_knock_at < $1 AND status <> 'paired'`,
    [cutoff]
  );
  const removed = Number(result?.changes || 0);
  if (removed) console.log(`[DB] Удалено устаревших заявок на связывание устройств: ${removed}`);
  return removed;
}

async function bootstrap() {
  if (started) return started;
  started = (async () => {
    const chatDb = getDatabase();
    await initIdentity(chatDb);

    const admin = await identity().get(
      `SELECT u.id FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1 AND r.permissions_json LIKE '%"is_admin":true%'
       ORDER BY u.id ASC`
    );
    seedChatDefaults(chatDb, admin ? admin.id : null);
    await syncDefaultChannelMembers();
    await pruneStaleDevices();
    await require('./updates/client-installs').pruneClientInstalls();

    finalizeIdentitySplit(chatDb);

    // Никто не может быть «в сети» сразу после запуска: сокетов ещё нет.
    await identity().run("UPDATE users SET status = 'offline' WHERE status <> 'offline'");

    return { chatDb, identity: identity() };
  })();

  try {
    return await started;
  } catch (err) {
    started = null;
    throw err;
  }
}

async function shutdown() {
  started = null;
  await closeIdentity();
}

module.exports = { bootstrap, shutdown, isReady: isIdentityReady, syncDefaultChannelMembers, pruneStaleDevices };
