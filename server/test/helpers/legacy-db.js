const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

// Воссоздаёт базу ПРЕЖНЕЙ версии: учётные записи и переписка в одном файле,
// внешние ключи на users, пароли старого формата (hex-хэш и отдельная колонка
// соли). Нужна, чтобы проверять перенос на настоящей форме данных, а не на
// том, как мы её себе представляем.

const LEGACY_SCHEMA = `
CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, permissions_json TEXT NOT NULL);
CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES departments(id) ON DELETE SET NULL, name TEXT NOT NULL, description TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT NOT NULL, dept_type TEXT DEFAULT 'department');
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, full_name TEXT NOT NULL, email TEXT, phone TEXT, job_title TEXT, department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL, role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL, avatar_url TEXT, status TEXT DEFAULT 'offline', custom_status TEXT, uin INTEGER, extension TEXT, company TEXT, last_seen TEXT, is_active INTEGER DEFAULT 1, must_change_password INTEGER DEFAULT 0, created_at TEXT NOT NULL, bound_ip TEXT, admin_scope_dept_id INTEGER, approval_status TEXT DEFAULT 'approved', registered_at TEXT);
CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, topic TEXT, type TEXT DEFAULT 'public', owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
CREATE TABLE channel_members (channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, role TEXT DEFAULT 'member', joined_at TEXT NOT NULL, last_read_message_id INTEGER DEFAULT 0, PRIMARY KEY (channel_id, user_id));
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_type TEXT NOT NULL, target_id INTEGER NOT NULL, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, type TEXT DEFAULT 'text', reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL, metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT, is_deleted INTEGER DEFAULT 0);
CREATE INDEX idx_messages_direct ON messages(conversation_type, sender_id, target_id, id);
CREATE TABLE message_statuses (message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, timestamp TEXT NOT NULL, PRIMARY KEY (message_id, user_id, status));
CREATE TABLE announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL, target_type TEXT DEFAULT 'all', target_ids_json TEXT, priority TEXT DEFAULT 'normal', expires_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE announcement_receipts (announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, read_at TEXT, confirmed_at TEXT, ip_address TEXT, PRIMARY KEY (announcement_id, user_id));
CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL, original_name TEXT NOT NULL, stored_filename TEXT NOT NULL, file_size INTEGER NOT NULL, mime_type TEXT, sha256 TEXT, path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, details_json TEXT, ip_address TEXT, created_at TEXT NOT NULL);
CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE pending_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT UNIQUE NOT NULL, device_name TEXT, ip_address TEXT, platform TEXT, client_version TEXT, status TEXT DEFAULT 'pending', first_knock_at TEXT NOT NULL, last_knock_at TEXT NOT NULL);
CREATE TABLE device_pairings (device_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, ip_address TEXT, device_name TEXT, paired_at TEXT NOT NULL, is_active INTEGER DEFAULT 1);
`;

const LEGACY_PASSWORD = 'староепарольное';

function buildLegacyDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(LEGACY_SCHEMA);

  const now = new Date().toISOString();
  const adminPermissions = JSON.stringify({
    is_admin: true, can_call: true, can_remote_control: true, can_upload_files: true,
    can_create_channels: true, can_broadcast: true, can_manage_db: true,
    can_manage_users: true, can_manage_structure: true
  });
  const employeePermissions = JSON.stringify({
    is_admin: false, can_call: true, can_upload_files: true, can_create_channels: true
  });

  const insertRole = db.prepare('INSERT INTO roles (id,name,description,permissions_json) VALUES (?,?,?,?)');
  insertRole.run(1, 'Суперадминистратор', '', adminPermissions);
  insertRole.run(2, 'Сотрудник', '', employeePermissions);

  const insertDept = db.prepare(
    'INSERT INTO departments (id,parent_id,name,description,sort_order,created_at,dept_type) VALUES (?,?,?,?,?,?,?)'
  );
  insertDept.run(1, null, 'Головной Офис', '', 1, now, 'branch');
  insertDept.run(2, 1, 'Бухгалтерия', '', 2, now, 'department');

  // Пароль прежнего формата: scryptSync с параметрами по умолчанию.
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(LEGACY_PASSWORD, salt, 64).toString('hex');
  const insertUser = db.prepare(
    `INSERT INTO users (id,username,password_hash,salt,full_name,email,job_title,department_id,role_id,uin,company,created_at,is_active,must_change_password)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0)`
  );
  insertUser.run(1, 'admin', hash, salt, 'Прежний Админ', 'a@cic.kz', 'Админ', 1, 1, 1, 'СК', now);
  insertUser.run(2, 'petrov', hash, salt, 'Петров Пётр', 'p@cic.kz', 'Бухгалтер', 2, 2, 2, 'СК', now);

  db.prepare('INSERT INTO channels (id,name,topic,type,owner_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(1, 'Общий', '', 'system', 1, now);
  const insertMember = db.prepare('INSERT INTO channel_members (channel_id,user_id,role,joined_at) VALUES (?,?,?,?)');
  insertMember.run(1, 1, 'admin', now);
  insertMember.run(1, 2, 'member', now);

  const insertMessage = db.prepare(
    'INSERT INTO messages (conversation_type,target_id,sender_id,text,type,created_at) VALUES (?,?,?,?,?,?)'
  );
  insertMessage.run('direct', 2, 1, 'Привет, Пётр', 'text', now);
  insertMessage.run('direct', 1, 2, 'Здравствуйте', 'text', now);
  insertMessage.run('channel', 1, 1, 'Сообщение в канале', 'text', now);

  const insertSetting = db.prepare('INSERT INTO server_settings (key,value,updated_at) VALUES (?,?,?)');
  insertSetting.run('company_name', 'АО СК Сентрас Иншуранс', now);
  insertSetting.run('allow_registration', 'true', now);

  db.prepare('INSERT INTO audit_logs (user_id,action,details_json,ip_address,created_at) VALUES (?,?,?,?,?)')
    .run(1, 'remote_desktop_request', '{}', '10.0.0.1', now);
  db.prepare('INSERT INTO pending_devices (device_id,device_name,ip_address,platform,client_version,status,first_knock_at,last_knock_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('dev-1', 'ПК Петрова', '10.0.0.5', 'Windows', '1.0.0', 'paired', now, now);
  db.prepare('INSERT INTO device_pairings (device_id,user_id,ip_address,device_name,paired_at,is_active) VALUES (?,?,?,?,?,1)')
    .run('dev-1', 2, '10.0.0.5', 'ПК Петрова', now);

  db.close();
}

module.exports = { buildLegacyDatabase, LEGACY_PASSWORD };
