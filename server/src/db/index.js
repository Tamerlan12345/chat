const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

// База переписки. Здесь и только здесь лежат сообщения, каналы, объявления и
// файлы. Учётные записи, роли, подразделения, привязки устройств и журнал
// действий вынесены в отдельное хранилище (src/db/identity) — в рабочей
// установке это PostgreSQL.
//
// Из-за этого в таблицах ниже нет внешних ключей на users: та таблица лежит в
// другой базе, и СУБД проверить такую ссылку не может. Целостность здесь
// обеспечивается кодом — отправитель сообщения берётся из проверенного токена,
// а не из тела запроса.

if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
if (!fs.existsSync(config.UPLOADS_DIR)) fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(config.BACKUPS_DIR)) fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });

// Определение каждой таблицы отдельной строкой, а не одним куском: перестроение
// таблицы в SQLite делается пересозданием, и для этого нужен ровно тот же
// текст CREATE, что и для чистой установки. Две расходящиеся копии определения
// — верный способ получить базу, отличающуюся от новой.
const TABLES = {
  channels: `
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      topic TEXT,
      type TEXT DEFAULT 'public', -- 'public', 'private', 'system'
      owner_id INTEGER,
      created_at TEXT NOT NULL
    )`,
  channel_members: `
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'member', -- 'admin', 'moderator', 'member'
      joined_at TEXT NOT NULL,
      last_read_message_id INTEGER DEFAULT 0,
      PRIMARY KEY (channel_id, user_id)
    )`,
  messages: `
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_type TEXT NOT NULL, -- 'channel', 'direct'
      target_id INTEGER NOT NULL,      -- channel_id или id получателя
      sender_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      type TEXT DEFAULT 'text',        -- 'text', 'image', 'file', 'voice', 'system'
      reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      is_deleted INTEGER DEFAULT 0,
      client_msg_id TEXT,              -- ключ идемпотентности отправки (уникален на отправителя)
      change_seq INTEGER               -- номер последнего изменения: курсор /api/sync
    )`,
  message_statuses: `
    CREATE TABLE IF NOT EXISTS message_statuses (
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL, -- 'delivered', 'read'
      timestamp TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, status)
    )`,
  announcements: `
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      target_type TEXT DEFAULT 'all', -- 'all', 'departments', 'users'
      target_ids_json TEXT,
      priority TEXT DEFAULT 'normal', -- 'normal', 'urgent', 'critical'
      expires_at TEXT,
      created_at TEXT NOT NULL
    )`,
  announcement_receipts: `
    CREATE TABLE IF NOT EXISTS announcement_receipts (
      announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      read_at TEXT,
      confirmed_at TEXT,
      ip_address TEXT,
      PRIMARY KEY (announcement_id, user_id)
    )`,
  files: `
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uploader_id INTEGER,
      original_name TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT,
      sha256 TEXT,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      dominant_color TEXT
    )`,
  // История правок и удалений: единственное место, где остаётся исходный
  // текст и метаданные после того, как сообщение в messages уже заменено
  // (правка) или обнулено (удаление). Без неё «кто и что написал на самом
  // деле» было бы невозможно объяснить постфактум.
  message_history: `
    CREATE TABLE IF NOT EXISTS message_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      action TEXT NOT NULL, -- 'edit', 'delete'
      old_text TEXT,
      old_metadata_json TEXT,
      actor_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
  // Счётчик изменений для /api/sync — отдельно от строк messages. Номер,
  // выведенный из MAX(change_seq) живых строк, откатывался бы назад после
  // физического удаления (удаление канала, SQL-консоль), и уже выданные
  // клиентам номера достались бы новым изменениям — клиент их бы не увидел.
  // epoch — случайная метка этой базы: входит в курсор, и курсор чужой базы
  // (или резервной копии, у которой эпоха своя) сервер не примет.
  sync_state: `
    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_seq INTEGER NOT NULL,
      epoch TEXT NOT NULL
    )`,
  // Отозванные автором ключи отправки (cancel_message): отправка с таким
  // ключом отклоняется (CANCELLED). Живут сутки и не больше тысячи на
  // отправителя (MessageService.recordCancelled) — в базе, а не в памяти,
  // чтобы отзыв пережил перезапуск сервера.
  cancelled_client_msgs: `
    CREATE TABLE IF NOT EXISTS cancelled_client_msgs (
      sender_id INTEGER NOT NULL,
      client_msg_id TEXT NOT NULL,
      cancelled_at INTEGER NOT NULL, -- epoch мс
      PRIMARY KEY (sender_id, client_msg_id)
    )`,
  // Токены push-уведомлений мобильных устройств (задача 18). Токен привязан к
  // сотруднику, устройству и сеансу, который его зарегистрировал: выход,
  // отвязка устройства, смена пароля — и уведомления на это устройство больше
  // не уходят (src/push/token-store.js). Через Google/Apple идут только id.
  push_tokens: `
    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,          -- 'ios' | 'android'
      kind TEXT NOT NULL,              -- 'alert' | 'voip' (PushKit, только iOS)
      environment TEXT NOT NULL,       -- 'sandbox' | 'production' (узел APNs)
      device_id TEXT,
      session_jti TEXT,                -- jti токена сеанса, переносится при продлении
      token_version INTEGER,           -- поколение токенов сотрудника на момент регистрации
      auth_time INTEGER,               -- время входа сеанса (SESSION_MAX_DAYS)
      app_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
};

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(conversation_type, sender_id, target_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(conversation_type, target_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`,
  `CREATE INDEX IF NOT EXISTS idx_message_history_message ON message_history(message_id)`,
  // Идемпотентность отправки: один client_msg_id — одно сообщение, но только
  // в пределах отправителя. Чужой id не совпадёт с вашим ни при каком угадывании.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg ON messages(sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL`,
  // Курсор синхронизации: каждое изменение строки получает следующий номер.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_change_seq ON messages(change_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_cancelled_client_msgs_at ON cancelled_client_msgs(cancelled_at)`,
  `CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_push_tokens_session ON push_tokens(session_jti)`
];

// Колонки, добавленные к messages уже после первых установок. CREATE TABLE IF
// NOT EXISTS существующую таблицу не меняет, поэтому они доводятся здесь, на
// месте, при каждом открытии базы (повторно — без последствий).
const MESSAGE_COLUMNS_ADDED = [
  ['client_msg_id', 'TEXT'],
  ['change_seq', 'INTEGER']
];

/**
 * Доводит messages до текущей схемы. Новым колонкам нужен один шаг заполнения:
 * change_seq у строк, которых ещё не было при его появлении, ставится по
 * возрастанию id и ВЫШЕ уже выданных номеров — так курсор синхронизации не
 * пропустит ни одну строку. updated_at не заполняется намеренно: настольный
 * клиент по непустому updated_at рисует «Изменено», и заполнение пометило бы
 * отредактированной всю историю.
 */
function migrateMessages(db) {
  const present = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
  for (const [name, type] of MESSAGE_COLUMNS_ADDED) {
    if (!present.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }

  const maxSeq = () => Number(db.prepare('SELECT COALESCE(MAX(change_seq), 0) AS m FROM messages').get().m);
  // Счётчик заводится один раз — по наибольшему уже выданному номеру.
  db.prepare('INSERT OR IGNORE INTO sync_state (id, last_seq, epoch) VALUES (1, ?, ?)').run(maxSeq(), newSyncEpoch());
  // Счётчик никогда не ниже выданного (база собрана руками, перенесены строки).
  db.prepare('UPDATE sync_state SET last_seq = MAX(last_seq, ?) WHERE id = 1').run(maxSeq());

  const pending = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE change_seq IS NULL').get();
  if (Number(pending?.n || 0) > 0) {
    const base = Number(db.prepare('SELECT last_seq FROM sync_state WHERE id = 1').get().last_seq);
    db.prepare('UPDATE messages SET change_seq = id + ? WHERE change_seq IS NULL').run(base);
    db.prepare('UPDATE sync_state SET last_seq = MAX(last_seq, ?) WHERE id = 1').run(maxSeq());
  }
}

// Размеры и преобладающий цвет картинки-вложения (задача 20): мобильный
// клиент рисует по ним заглушку нужной формы, пока грузится миниатюра. У
// старых вложений пусто — заполняется при первой миниатюре.
const FILE_COLUMNS_ADDED = [
  ['width', 'INTEGER'],
  ['height', 'INTEGER'],
  ['dominant_color', 'TEXT']
];

function migrateFiles(db) {
  const present = new Set(db.prepare('PRAGMA table_info(files)').all().map((c) => c.name));
  for (const [name, type] of FILE_COLUMNS_ADDED) {
    if (!present.has(name)) db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
  }
}

function newSyncEpoch() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Выполняет запись, которой нужен номер изменения: номер берётся из
 * sync_state (только растёт) и запись делается в той же точке сохранения —
 * не удалась запись, не расходуется и номер. write(seq) получает номер.
 */
function withChangeSeq(db, write) {
  db.exec('SAVEPOINT change_seq');
  try {
    const seq = Number(
      db.prepare('UPDATE sync_state SET last_seq = last_seq + 1 WHERE id = 1 RETURNING last_seq').get().last_seq
    );
    const result = write(seq);
    db.exec('RELEASE change_seq');
    return result;
  } catch (err) {
    db.exec('ROLLBACK TO change_seq');
    db.exec('RELEASE change_seq');
    throw err;
  }
}

/** { lastSeq, epoch } — голова последовательности изменений и эпоха базы. */
function getSyncState(db = getDatabase()) {
  const row = db.prepare('SELECT last_seq, epoch FROM sync_state WHERE id = 1').get();
  return { lastSeq: Number(row.last_seq), epoch: String(row.epoch) };
}

/**
 * Новая эпоха в файле резервной копии (сразу после VACUUM INTO). Копия —
 * снимок прошлого: восстановленная из неё база выдала бы заново номера,
 * которые клиенты уже видели. С другой эпохой их курсоры не примутся
 * (HTTP 410), и клиенты синхронизируются с нуля.
 */
function rotateSyncEpoch(filePath) {
  const db = new DatabaseSync(filePath);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'").get()) {
      db.prepare('UPDATE sync_state SET epoch = ? WHERE id = 1').run(newSyncEpoch());
    }
  } finally {
    db.close();
  }
}

let dbInstance = null;

function getDatabase() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(config.DB_PATH);

    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
    dbInstance.exec('PRAGMA busy_timeout = 5000;');

    initSchema(dbInstance);
  }
  return dbInstance;
}

function closeDatabase() {
  try {
    dbInstance?.close();
  } catch {
    /* уже закрыта */
  }
  dbInstance = null;
}

function initSchema(db) {
  for (const ddl of Object.values(TABLES)) db.exec(ddl);
  migrateMessages(db);
  migrateFiles(db);
  for (const ddl of INDEXES) db.exec(ddl);
}

// ── Разделение баз ─────────────────────────────────────────────────────────

// Таблицы переписки, которые в прежней схеме ссылались внешним ключом на
// users. После переезда учётных записей такая ссылка указывает в пустоту: при
// включённом PRAGMA foreign_keys первое же сообщение от нового сотрудника
// отклонялось бы как нарушение ссылочной целостности.
const TABLES_REFERENCING_USERS = Object.keys(TABLES);

// Таблицы учётных записей, оставшиеся в базе переписки от прежней версии.
// После успешного переноса их нужно удалить, а не просто перестать читать:
// пока они на месте, хэши паролей лежат в файле, который админ-панель умеет
// показывать произвольным SQL-запросом и отдавать на скачивание как резервную
// копию.
const LEGACY_IDENTITY_TABLES = [
  'device_pairings',
  'pending_devices',
  'audit_logs',
  'server_settings',
  'users',
  'departments',
  'roles'
];

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function referencesUsers(db, table) {
  try {
    return db
      .prepare(`PRAGMA foreign_key_list("${table}")`)
      .all()
      .some((fk) => fk.table === 'users');
  } catch {
    return false;
  }
}

/**
 * Приводит базу переписки к состоянию после разделения: снимает внешние ключи
 * на users и удаляет оставшиеся таблицы учётных записей.
 *
 * Вызывается только после того, как перенос в новое хранилище состоялся —
 * иначе единственная копия учётных записей была бы удалена раньше, чем
 * появилась вторая.
 */
function finalizeIdentitySplit(db) {
  const needsRebuild = TABLES_REFERENCING_USERS.filter(
    (t) => tableExists(db, t) && referencesUsers(db, t)
  );
  const leftovers = LEGACY_IDENTITY_TABLES.filter((t) => tableExists(db, t));

  if (!needsRebuild.length && !leftovers.length) return { rebuilt: [], dropped: [] };

  // Перед необратимой правкой — копия рядом с базой, а не в каталоге резервных
  // копий: тот отдаётся администратору по HTTP, а этот файл ещё содержит
  // хэши паролей.
  const snapshot = path.join(config.DATA_DIR, 'pre-identity-split.db');
  if (!fs.existsSync(snapshot)) {
    try {
      db.prepare('VACUUM INTO ?').run(snapshot);
      console.log(`[DB] Снимок базы до разделения сохранён: ${snapshot}`);
    } catch (err) {
      console.warn('[DB] Не удалось сохранить снимок до разделения:', err.message);
    }
  }

  // Перестроение таблицы возможно только при выключенной проверке ключей:
  // промежуточное состояние её заведомо нарушает. legacy_alter_table нужен на
  // время переименования — иначе SQLite услужливо перепишет ссылки на эту
  // таблицу в соседних таблицах на временное имя.
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN');

    for (const table of needsRebuild) {
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((c) => `"${c.name}"`)
        .join(', ');

      const rebuildDdl = TABLES[table]
        .replace('CREATE TABLE IF NOT EXISTS ', 'CREATE TABLE ')
        .replace(`${table} (`, `"${table}__new" (`);

      db.exec(rebuildDdl);
      db.exec(`INSERT INTO "${table}__new" (${columns}) SELECT ${columns} FROM "${table}"`);
      db.exec(`DROP TABLE "${table}"`);
      db.exec('PRAGMA legacy_alter_table = ON;');
      db.exec(`ALTER TABLE "${table}__new" RENAME TO "${table}"`);
      db.exec('PRAGMA legacy_alter_table = OFF;');
    }

    for (const table of leftovers) {
      db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* транзакция уже закрыта */
    }
    db.exec('PRAGMA legacy_alter_table = OFF;');
    db.exec('PRAGMA foreign_keys = ON;');
    throw err;
  }

  // Индексы уходят вместе со сброшенной таблицей — пересоздаются здесь.
  for (const ddl of INDEXES) db.exec(ddl);

  db.exec('PRAGMA foreign_keys = ON;');
  const dangling = db.prepare('PRAGMA foreign_key_check').all();
  if (dangling.length) {
    console.warn('[DB] После разделения остались висящие ссылки:', dangling.length);
  }

  if (needsRebuild.length) {
    console.log(`[DB] Сняты внешние ключи на users: ${needsRebuild.join(', ')}`);
  }
  if (leftovers.length) {
    console.log(`[DB] Удалены перенесённые таблицы учётных записей: ${leftovers.join(', ')}`);
  }

  return { rebuilt: needsRebuild, dropped: leftovers };
}

/**
 * Системные каналы чистой установки. Раньше создавались вместе с учётной
 * записью администратора одним куском; теперь администратор заводится в другой
 * базе, поэтому его идентификатор передаётся сюда.
 */
function seedChatDefaults(db, ownerId = null) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM channels').get();
  if (Number(existing?.n || 0) > 0) return;

  const now = new Date().toISOString();
  const insertChannel = db.prepare(
    'INSERT INTO channels (name, topic, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  );

  const general = Number(
    insertChannel.run(
      'Общий',
      'Главный корпоративный канал АО "Страховая компания "Сентрас Иншуранс"',
      'system',
      ownerId,
      now
    ).lastInsertRowid
  );

  const announcements = Number(
    insertChannel.run(
      'Объявления',
      'Официальные распоряжения и приказы руководства компании',
      'system',
      ownerId,
      now
    ).lastInsertRowid
  );

  if (ownerId) {
    insertMember.run(general, ownerId, 'admin', now);
    insertMember.run(announcements, ownerId, 'admin', now);
  }
}

module.exports = {
  getDatabase,
  closeDatabase,
  withChangeSeq,
  getSyncState,
  rotateSyncEpoch,
  finalizeIdentitySplit,
  seedChatDefaults,
  TABLES_REFERENCING_USERS,
  LEGACY_IDENTITY_TABLES
};
