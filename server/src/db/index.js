const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

// Ensure data directories exist
if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
if (!fs.existsSync(config.UPLOADS_DIR)) fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(config.BACKUPS_DIR)) fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });

let dbInstance = null;

function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return check === hash;
}

function getDatabase() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(config.DB_PATH);
    
    // Performance & Concurrency Pragmas (WAL mode)
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
    dbInstance.exec('PRAGMA busy_timeout = 5000;');
    
    initSchema(dbInstance);
    runMigrations(dbInstance);
    seedProductionData(dbInstance);
    applyEmergencyAdminReset(dbInstance);
  }
  return dbInstance;
}

// Recovery path for a locked-out administrator: only whoever can set the
// deployment's environment can trigger it, which is the same trust boundary
// as ALLOWED_CLIENT_IPS. Without it a forgotten admin password is
// unrecoverable — resetting a password requires an admin login, and there is
// no admin left to log in with.
//
// Applied once per distinct value: the hash of the password that was last
// used is recorded, so leaving the variable in place does not silently revert
// a password the admin changes afterwards. Setting a new value resets again.
function applyEmergencyAdminReset(db) {
  const requested = process.env.ADMIN_PASSWORD_RESET;
  if (!requested) return;

  const username = process.env.ADMIN_PASSWORD_RESET_USER || 'admin';
  const marker = crypto.createHash('sha256').update(`${username}:${requested}`).digest('hex');

  const previous = db
    .prepare("SELECT value FROM server_settings WHERE key = 'last_admin_password_reset'")
    .get();
  if (previous?.value === marker) return;

  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) {
    console.warn(`[Recovery] ADMIN_PASSWORD_RESET is set, but no user "${username}" exists — ignored.`);
    return;
  }

  const { hash, salt } = hashPassword(requested);
  db.prepare(
    'UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0, is_active = 1 WHERE id = ?'
  ).run(hash, salt, user.id);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO server_settings (key, value, updated_at) VALUES ('last_admin_password_reset', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(marker, now);

  console.warn(
    `[Recovery] Password for "${username}" was reset from ADMIN_PASSWORD_RESET. ` +
      'Log in, change it, then DELETE that variable from the deployment.'
  );
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      permissions_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      job_title TEXT,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
      avatar_url TEXT,
      status TEXT DEFAULT 'offline', -- 'online', 'away', 'dnd', 'offline'
      custom_status TEXT,
      uin INTEGER,
      extension TEXT,
      company TEXT,
      last_seen TEXT,
      is_active INTEGER DEFAULT 1,
      must_change_password INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      topic TEXT,
      type TEXT DEFAULT 'public', -- 'public', 'private', 'system'
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member', -- 'admin', 'moderator', 'member'
      joined_at TEXT NOT NULL,
      last_read_message_id INTEGER DEFAULT 0,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_type TEXT NOT NULL, -- 'channel', 'direct'
      target_id INTEGER NOT NULL, -- channel_id or recipient user_id
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      type TEXT DEFAULT 'text', -- 'text', 'image', 'file', 'voice', 'system'
      reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      metadata_json TEXT, -- attachments info, file size, voice duration etc.
      created_at TEXT NOT NULL,
      updated_at TEXT,
      is_deleted INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(conversation_type, sender_id, target_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(conversation_type, target_id, id);

    CREATE TABLE IF NOT EXISTS message_statuses (
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL, -- 'delivered', 'read'
      timestamp TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, status)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      target_type TEXT DEFAULT 'all', -- 'all', 'departments', 'users'
      target_ids_json TEXT, -- array of ids
      priority TEXT DEFAULT 'normal', -- 'normal', 'urgent', 'critical'
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS announcement_receipts (
      announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT,
      confirmed_at TEXT,
      ip_address TEXT,
      PRIMARY KEY (announcement_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      original_name TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT,
      sha256 TEXT,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details_json TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      device_name TEXT,
      ip_address TEXT,
      platform TEXT,
      client_version TEXT,
      status TEXT DEFAULT 'pending', -- 'pending', 'paired', 'rejected'
      first_knock_at TEXT NOT NULL,
      last_knock_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_pairings (
      device_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_address TEXT,
      device_name TEXT,
      paired_at TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );
  `);
}

function runMigrations(db) {
  // 1. Column additions for existing databases
  try { db.exec("ALTER TABLE users ADD COLUMN bound_ip TEXT;"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN admin_scope_dept_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;"); } catch {}
  try { db.exec("ALTER TABLE departments ADD COLUMN dept_type TEXT DEFAULT 'department';"); } catch {}
  // Added for docs/designs/auth-access-control-remediation.md item 10. Column
  // defaults to 0 for existing rows on purpose — flipping it to 1 for real,
  // already-active employee accounts is a live operational action that needs
  // explicit sign-off (see the design doc's Dependencies/Assignment), not
  // something a migration should do silently. An admin can set it per-user
  // via the existing "Edit user" admin panel once that sign-off happens.
  try { db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0;"); } catch {}
  // Самостоятельная регистрация ждёт подтверждения администратора. Значение
  // по умолчанию 'approved' — все, кто уже заведён, остаются рабочими; в
  // 'pending' попадают только новые заявки. Отдельная колонка, а не is_active:
  // «ждёт одобрения» и «отключён администратором» — разные состояния, и
  // сообщение при входе должно различаться.
  try { db.exec("ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT 'approved';"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN registered_at TEXT;"); } catch {}

  // 2. Add Role #3: "Контурный администратор" if not exists
  const rScoped = db.prepare("SELECT id FROM roles WHERE id = 3 OR name = 'Контурный администратор'").get();
  if (!rScoped) {
    try {
      db.prepare(`
        INSERT INTO roles (id, name, description, permissions_json)
        VALUES (3, 'Контурный администратор', 'Администратор контура (департамента или филиала) — управление только своими сотрудниками и отделами', ?)
      `).run(JSON.stringify({
        is_admin: true,
        is_scoped_admin: true,
        can_manage_users: true,
        can_manage_structure: true,
        can_manage_db: false,
        can_broadcast: false,
        can_call: true,
        can_remote_control: true,
        can_create_channels: true,
        can_upload_files: true
      }));
    } catch (e) {
      console.warn('Role 3 insert notice:', e.message);
    }
  }

  // 3. Hierarchical Company Root migration in departments
  const existingCompany = db.prepare("SELECT id FROM departments WHERE dept_type = 'company' OR name LIKE '%Сентрас Иншуранс%'").get();
  let companyId;
  const now = new Date().toISOString();
  if (!existingCompany) {
    const res = db.prepare(`
      INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
      VALUES (NULL, 'АО СК Сентрас Иншуранс', 'Головная корпоративная холдинговая компания', 'company', 0, ?)
    `).run(now);
    companyId = Number(res.lastInsertRowid);
    // Link Head Office to Company
    db.prepare("UPDATE departments SET parent_id = ?, dept_type = 'branch' WHERE id = 1").run(companyId);
    db.prepare("UPDATE departments SET dept_type = 'branch' WHERE parent_id = ?").run(companyId);
  } else {
    companyId = existingCompany.id;
    db.prepare("UPDATE departments SET dept_type = 'company' WHERE id = ?").run(companyId);
    // Ensure Head Office is linked to company
    db.prepare("UPDATE departments SET parent_id = ?, dept_type = 'branch' WHERE id = 1 AND parent_id IS NULL").run(companyId);
  }

}

function seedProductionData(db) {
  const checkUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (checkUsers.count > 0) return; // Already seeded, preserve existing production data

  const now = new Date().toISOString();
  const company = 'АО "Страховая компания "Сентрас Иншуранс"';

  // 1. Roles
  const insertRole = db.prepare('INSERT INTO roles (name, description, permissions_json) VALUES (?, ?, ?)');
  const rAdmin = insertRole.run(
    'Суперадминистратор',
    'Полный неограниченный доступ к управлению сервером, пользователями и структурой',
    JSON.stringify({
      is_admin: true,
      can_manage_users: true,
      can_manage_structure: true,
      can_manage_db: true,
      can_broadcast: true,
      can_call: true,
      can_remote_control: true,
      can_create_channels: true,
      can_upload_files: true
    })
  ).lastInsertRowid;

  const rMember = insertRole.run(
    'Сотрудник',
    'Стандартный корпоративный доступ: переписка с коллегами, звонки, каналы, файлы',
    JSON.stringify({
      is_admin: false,
      can_manage_users: false,
      can_manage_structure: false,
      can_manage_db: false,
      can_broadcast: false,
      can_call: true,
      can_remote_control: false,
      can_create_channels: true,
      can_upload_files: true
    })
  ).lastInsertRowid;

  // 2. Departments Hierarchy (matching Screenshot 4)
  const insertDept = db.prepare('INSERT INTO departments (parent_id, name, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?)');
  
  const dHeadOffice = insertDept.run(null, 'Головной Офис', 'Центральный аппарат страховой компании', 1, now).lastInsertRowid;
  
  const dHR = insertDept.run(dHeadOffice, 'HR-Департамент', 'Управление человеческими ресурсами', 1, now).lastInsertRowid;
  const dHROtdele = insertDept.run(dHR, 'Отдел Кадров', 'Кадровое делопроизводство', 1, now).lastInsertRowid;
  const dHRDev = insertDept.run(dHR, 'Отдел развития персонала', 'Обучение и адаптация персонала', 2, now).lastInsertRowid;

  const dAdminMgt = insertDept.run(dHeadOffice, 'Административное Управление', 'Хозяйственное и документационное обеспечение', 2, now).lastInsertRowid;
  const dCX = insertDept.run(dHeadOffice, 'Департамент СХ', 'Клиентский опыт и сервис', 3, now).lastInsertRowid;
  const dWeb = insertDept.run(dHeadOffice, 'Департамент Web-разработок', 'Разработка корпоративных систем и сервисов', 4, now).lastInsertRowid;
  const dUnder = insertDept.run(dHeadOffice, 'Департамент Андеррайтинга', 'Оценка рисков страхования', 5, now).lastInsertRowid;
  const dAcc = insertDept.run(dHeadOffice, 'Департамент Бухгалтерского Учета и Аудита', 'Бухгалтерский учет и аудит', 6, now).lastInsertRowid;
  const dOnlineSales = insertDept.run(dHeadOffice, 'Департамент Интернет Продаж', 'Цифровые каналы продаж страховых продуктов', 7, now).lastInsertRowid;
  const dCorpIns = insertDept.run(dHeadOffice, 'Департамент Корпоративного Страхования', 'Страхование юридических лиц', 8, now).lastInsertRowid;
  const dCorpSales = insertDept.run(dHeadOffice, 'Департамент Корпоративных Продаж', 'Продажи корпоративным клиентам', 9, now).lastInsertRowid;
  const dMkt = insertDept.run(dHeadOffice, 'Департамент Маркетинга', 'Маркетинг и PR', 10, now).lastInsertRowid;
  const dMedCare = insertDept.run(dHeadOffice, 'Департамент Медицинского Обслуживания', 'Курация медицинских программ', 11, now).lastInsertRowid;
  const dMedIns = insertDept.run(dHeadOffice, 'Департамент Медицинского Страхования', 'Добровольное медицинское страхование', 12, now).lastInsertRowid;
  const dMethod = insertDept.run(dHeadOffice, 'Департамент Методологии Бизнес-процессов', 'Регламентация и методология', 13, now).lastInsertRowid;

  // 3. The one real account a fresh install actually needs: the admin.
  // Earlier versions of this seed also created ~10 named "colleague"
  // accounts (matching an original UI-mockup's screenshots) with real-
  // looking names and @cic.kz-pattern emails, all sharing one known
  // password. That was fine for a demo build against throwaway data, but
  // this same function runs on first boot of a REAL deployment (see
  // docker-compose.yml) — seeding lookalike employee accounts into a real
  // company's real database is not acceptable, so it's gone. Real employees
  // are provisioned by an admin afterward via /admin/users or the org
  // batch-importer (OrgParserService), not by this seed.
  const pass = hashPassword('123456');
  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, salt, full_name, email, phone, job_title, department_id, role_id, status, uin, extension, company, created_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // System Administrator — INITIAL_ADMIN_PASSWORD lets the operator set a
  // real password at deploy time (container env) instead of shipping with
  // the well-known default; must_change_password below still forces a
  // change on first login either way.
  const adminPass = process.env.INITIAL_ADMIN_PASSWORD
    ? hashPassword(process.env.INITIAL_ADMIN_PASSWORD)
    : pass;
  const adminId = insertUser.run(
    'admin', adminPass.hash, adminPass.salt,
    process.env.INITIAL_ADMIN_NAME || 'Администратор системы', 'admin@cic.kz', '+7 (727) 244-77-00',
    'Главный системный администратор', dHeadOffice, rAdmin,
    'online', 1, '100', company, now, 1
  ).lastInsertRowid;

  // 4. Default Channels
  const insertChannel = db.prepare('INSERT INTO channels (name, topic, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)');
  const cGeneral = insertChannel.run(
    'Общий',
    'Главный корпоративный канал АО "Страховая компания "Сентрас Иншуранс"',
    'system',
    adminId,
    now
  ).lastInsertRowid;

  const cAnnouncements = insertChannel.run(
    'Объявления',
    'Официальные распоряжения и приказы руководства компании',
    'system',
    adminId,
    now
  ).lastInsertRowid;

  // Admin is the only member of the default system channels at seed time;
  // other employees join as they're provisioned.
  const insertMember = db.prepare('INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
  insertMember.run(cGeneral, adminId, 'admin', now);
  insertMember.run(cAnnouncements, adminId, 'admin', now);

  // 5. Fresh installs only (this function only runs on an empty users table,
  // so it never touches an already-live account): force a password change on
  // first login for every seeded default account, since they all share the
  // same known password.
  db.exec('UPDATE users SET must_change_password = 1');

  // 6. Default Server Settings
  const insertSetting = db.prepare('INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)');
  insertSetting.run('company_name', company, now);
  insertSetting.run('server_name', 'OpenMyChat Enterprise Server', now);
  // Off by default on a fresh install: self-registration on a server that
  // may now be internet-reachable means anyone who can reach it (before any
  // IP allowlist is even considered) could self-provision an account. An
  // admin can flip this on from the Admin Console if self-service signup is
  // actually wanted. Existing installs keep whatever value they already have.
  insertSetting.run('allow_registration', 'false', now);
  insertSetting.run('max_upload_size_mb', '100', now);
}

module.exports = {
  getDatabase,
  hashPassword,
  verifyPassword
};
