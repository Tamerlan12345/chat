const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../../config');
const PgDriver = require('./driver-pg');
const SqliteDriver = require('./driver-sqlite');
const { createSchema, resyncSequences } = require('./schema');
const { hashPassword } = require('./password');

let driver = null;
let ready = false;

/**
 * Хранилище учётных записей. Отдельная база: люди, роли, подразделения,
 * привязанные устройства и журнал действий. Переписка сюда не попадает — она
 * остаётся в SQLite рядом с сервером.
 */
function identity() {
  if (!driver || !ready) {
    throw new Error(
      'Хранилище учётных записей ещё не инициализировано — вызовите bootstrap() до обработки запросов'
    );
  }
  return driver;
}

function isIdentityReady() {
  return ready;
}

/**
 * @param {object|null} legacyDb Открытая база переписки. Если в ней ещё лежат
 *        таблицы учётных записей от прежней версии, их содержимое переносится
 *        сюда один раз, с сохранением идентификаторов — на них ссылаются
 *        сообщения, участники каналов и объявления.
 */
async function initIdentity(legacyDb = null) {
  if (ready) return driver;

  driver = config.IDENTITY_DRIVER === 'postgres' ? new PgDriver() : new SqliteDriver();
  await driver.connect();
  await createSchema(driver);

  const existing = await driver.get('SELECT COUNT(*) AS n FROM users');
  const isEmpty = Number(existing?.n || 0) === 0;

  if (isEmpty) {
    const skipInfo = {};
    const source = findImportSource({ dialect: driver.dialect, legacyDb, skipInfo });
    if (source) {
      try {
        await importFromLegacy(driver, source.db, source.label);
      } finally {
        source.close();
      }
    } else if (chatHasHistory(legacyDb) && process.env.IDENTITY_ALLOW_EMPTY_BOOTSTRAP !== 'true') {
      // Хранилище пустое, а переписка уже есть — значит учётные записи где-то
      // потерялись по дороге (неверный DATABASE_URL, пропавший файл). Создать
      // здесь «чистую установку» значило бы молча лишить компанию всех
      // сотрудников и завести администратора с общеизвестным паролем поверх
      // рабочих данных. Лучше не подняться и объяснить почему.
      //
      // Резервный файл мог при этом реально лежать на диске, но быть
      // пропущен именно из-за отсутствия IDENTITY_AUTO_IMPORT (см. цикл в
      // findImportSource) — в этом случае сообщение обязано назвать ИМЕННО
      // этот флаг. Раньше оно называло только IDENTITY_ALLOW_EMPTY_BOOTSTRAP,
      // и следуя ему оператор создал бы чистую установку поверх пропущенного,
      // но существующего резервного файла с рабочими данными (аудит ревью,
      // находка №21).
      const autoImportHint = skipInfo.skippedAutoImport
        ? 'Резервный файл найден на диске, но пропущен без IDENTITY_AUTO_IMPORT=true — если перенос ' +
          'нужен именно из него, задайте этот флаг. '
        : '';
      throw new Error(
        'Хранилище учётных записей пустое, а переписка в базе уже есть — это не новая установка. ' +
          'Сервер не будет создавать администратора с паролем по умолчанию поверх рабочих данных. ' +
          autoImportHint +
          'Проверьте DATABASE_URL: он должен указывать на базу с сотрудниками. ' +
          'Если учётные записи действительно нужно завести заново, задайте IDENTITY_ALLOW_EMPTY_BOOTSTRAP=true.'
      );
    } else {
      await seedFreshInstall(driver);
    }
  }

  // Строго до ensureBaselineRows. Перенос вставляет строки с готовыми
  // идентификаторами, а счётчик PostgreSQL при этом не двигается — и первая же
  // вставка без явного id упирается в занятую единицу. SQLite такую ошибку не
  // показывает: там счётчик подтягивается к наибольшему id сам.
  await resyncSequences(driver);

  await ensureBaselineRows(driver);
  await applyEmergencyAdminReset(driver);

  ready = true;
  return driver;
}

async function closeIdentity() {
  if (driver) await driver.close();
  driver = null;
  ready = false;
}

function legacyHasUsers(legacyDb) {
  try {
    const table = legacyDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get();
    if (!table) return false;
    const row = legacyDb.prepare('SELECT COUNT(*) AS n FROM users').get();
    return Number(row?.n || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Откуда брать учётные записи, если хранилище пустое.
 *
 * Порядок не случаен. Сервер мог уже поработать без DATABASE_URL: тогда
 * сотрудники перенесены в запасной data/identity.db, а из базы переписки
 * удалены. Если потом задать DATABASE_URL и искать их только в базе
 * переписки, их там не окажется — и PostgreSQL получил бы чистую установку
 * вместо живых данных. Поэтому для PostgreSQL первым проверяется identity.db,
 * затем прежняя общая база, последним — снимок, сделанный перед разделением.
 *
 * @param {object} [skipInfo] Заполняется по ссылке: skippedAutoImport = true,
 *        если хотя бы один резервный файл был пропущен именно из-за
 *        отсутствия IDENTITY_AUTO_IMPORT (initIdentity называет флаг в тексте
 *        фатальной ошибки только тогда — иначе оператор не узнал бы, что дело
 *        именно в нём, а не в отсутствующем DATABASE_URL).
 * @returns {{ db: object, label: string, close: () => void } | null}
 */
function findImportSource({ dialect, legacyDb = null, skipInfo = null }) {
  const candidates = [];
  // fromStaleFile: кандидаты, читаемые с диска отдельным файлом, а не из уже
  // открытой базы переписки этого же запуска. Именно они — тот риск из
  // находки №16: если рабочее хранилище опустело по ошибке (опечатка в
  // DATABASE_URL, ещё не поднявшийся PostgreSQL), сервер раньше молча
  // подставлял вместо чистой установки чужие пароли и устройства из старой
  // копии. legacyDb (прежняя общая база) в их число не входит — это не
  // резервная копия, а прямой перенос при штатном первом разделении баз.
  if (dialect === 'postgres') {
    candidates.push({ label: 'запасное хранилище data/identity.db', path: config.IDENTITY_DB_PATH, fromStaleFile: true });
  }
  if (legacyDb) {
    candidates.push({ label: 'прежняя общая база data/mychat.db', db: legacyDb });
  }
  candidates.push({
    label: 'снимок data/pre-identity-split.db',
    path: path.join(config.DATA_DIR, 'pre-identity-split.db'),
    fromStaleFile: true
  });

  for (const candidate of candidates) {
    let db = candidate.db || null;
    let opened = false;
    if (!db) {
      if (!fs.existsSync(candidate.path)) continue;
      if (candidate.fromStaleFile && !config.IDENTITY_AUTO_IMPORT) {
        console.warn(
          `[Identity] ${candidate.label} найден на диске, но автоимпорт из резервных файлов выключен ` +
            '(IDENTITY_AUTO_IMPORT не задан) — источник пропущен. Если перенос нужен намеренно, ' +
            'задайте IDENTITY_AUTO_IMPORT=true (аудит, находка №16).'
        );
        if (skipInfo) skipInfo.skippedAutoImport = true;
        continue;
      }
      try {
        db = new DatabaseSync(candidate.path);
        opened = true;
      } catch {
        continue;
      }
    }

    const close = () => {
      if (!opened) return;
      try {
        db.close();
      } catch {
        /* уже закрыта */
      }
    };

    if (legacyHasUsers(db)) return { db, label: candidate.label, close };
    close();
  }
  return null;
}

// Есть ли в базе переписки хоть одно сообщение — признак того, что установка
// не новая.
function chatHasHistory(chatDb) {
  if (!chatDb) return false;
  try {
    const row = chatDb.prepare('SELECT COUNT(*) AS n FROM messages').get();
    return Number(row?.n || 0) > 0;
  } catch {
    return false;
  }
}

// ── Перенос из прежней общей базы ──────────────────────────────────────────
// Выполняется один раз, при первом запуске с настроенным PostgreSQL. Порядок
// таблиц важен: подразделения ссылаются сами на себя, пользователи — на роли и
// подразделения. Идентификаторы сохраняются как есть.

const LEGACY_COLUMNS = {
  roles: ['id', 'name', 'description', 'permissions_json'],
  departments: ['id', 'parent_id', 'name', 'description', 'dept_type', 'sort_order', 'created_at'],
  users: [
    'id', 'username', 'password_hash', 'salt', 'full_name', 'email', 'phone', 'job_title',
    'department_id', 'role_id', 'admin_scope_dept_id', 'avatar_url', 'status', 'custom_status',
    'uin', 'extension', 'company', 'bound_ip', 'last_seen', 'is_active', 'must_change_password',
    'approval_status', 'registered_at', 'created_at',
    // Колонки защиты есть только в identity.db. В прежней общей базе их нет —
    // legacyHasColumn их отсеет, и сработают значения по умолчанию.
    'token_version', 'password_changed_at', 'failed_login_count', 'locked_until',
    'last_login_at', 'last_login_ip'
  ],
  pending_devices: [
    'id', 'device_id', 'device_name', 'ip_address', 'platform', 'client_version', 'status',
    'first_knock_at', 'last_knock_at'
  ],
  device_pairings: ['device_id', 'user_id', 'ip_address', 'device_name', 'paired_at', 'is_active'],
  audit_logs: ['id', 'user_id', 'action', 'details_json', 'ip_address', 'created_at'],
  server_settings: ['key', 'value', 'updated_at']
};

const IMPORT_ORDER = [
  'roles',
  'departments',
  'users',
  'pending_devices',
  'device_pairings',
  'audit_logs',
  'server_settings'
];

async function importFromLegacy(target, legacyDb, label = 'прежняя база') {
  console.log(`[Identity] Найдены учётные записи (${label}) — переношу в новое хранилище…`);
  const counts = {};

  await target.tx(async (tx) => {
    for (const table of IMPORT_ORDER) {
      const columns = LEGACY_COLUMNS[table].filter((col) => legacyHasColumn(legacyDb, table, col));
      if (!columns.length) continue;

      let rows;
      try {
        rows = legacyDb.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all();
      } catch {
        continue; // таблицы этой версии в прежней базе не было
      }

      // Подразделения переносятся без родителя, а связи проставляются вторым
      // проходом: иначе строка со ссылкой на ещё не вставленного родителя
      // нарушит внешний ключ.
      const deferParent = table === 'departments';
      const insertColumns = deferParent ? columns.filter((c) => c !== 'parent_id') : columns;
      const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ');

      for (const row of rows) {
        const values = insertColumns.map((col) => normalizeLegacyValue(table, col, row[col]));
        await tx.run(
          `INSERT INTO ${table} (${insertColumns.join(', ')}) VALUES (${placeholders})
           ON CONFLICT DO NOTHING`,
          values
        );
      }

      if (deferParent && columns.includes('parent_id')) {
        for (const row of rows) {
          if (row.parent_id === null || row.parent_id === undefined) continue;
          await tx.run('UPDATE departments SET parent_id = $1 WHERE id = $2', [
            row.parent_id,
            row.id
          ]);
        }
      }

      counts[table] = rows.length;
    }

    const now = new Date().toISOString();
    await tx.run(
      `INSERT INTO server_settings (key, value, updated_at) VALUES ('identity_imported_at', $1, $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [now]
    );
  });

  const summary = IMPORT_ORDER.filter((t) => counts[t]).map((t) => `${t}: ${counts[t]}`).join(', ');
  console.log(`[Identity] Перенос завершён (${summary || 'пусто'}).`);
}

function legacyHasColumn(legacyDb, table, column) {
  try {
    const info = legacyDb.prepare(`PRAGMA table_info("${table}")`).all();
    return info.some((c) => c.name === column);
  } catch {
    return false;
  }
}

// Прежняя схема допускала NULL там, где новая требует значение: столбцы
// добавлялись миграциями и у старых строк оставались пустыми.
const LEGACY_DEFAULTS = {
  users: {
    is_active: 1,
    must_change_password: 0,
    approval_status: 'approved',
    status: 'offline',
    created_at: () => new Date().toISOString()
  },
  device_pairings: { is_active: 1 }
};

function normalizeLegacyValue(table, column, value) {
  if (value !== null && value !== undefined) return value;
  const fallback = LEGACY_DEFAULTS[table]?.[column];
  if (fallback === undefined) return null;
  return typeof fallback === 'function' ? fallback() : fallback;
}

// ── Первичное заполнение чистой установки ──────────────────────────────────

const ROLE_SUPERADMIN = 'Суперадминистратор';
const ROLE_EMPLOYEE = 'Сотрудник';
const ROLE_SCOPED_ADMIN = 'Контурный администратор';

const BASE_ROLES = [
  {
    name: ROLE_SUPERADMIN,
    description: 'Полный неограниченный доступ к управлению сервером, пользователями и структурой',
    permissions: {
      is_admin: true,
      can_manage_users: true,
      can_manage_structure: true,
      can_manage_db: true,
      can_broadcast: true,
      can_call: true,
      can_remote_control: true,
      can_create_channels: true,
      can_upload_files: true
    }
  },
  {
    name: ROLE_EMPLOYEE,
    description: 'Стандартный корпоративный доступ: переписка с коллегами, звонки, каналы, файлы',
    permissions: {
      is_admin: false,
      can_manage_users: false,
      can_manage_structure: false,
      can_manage_db: false,
      can_broadcast: false,
      can_call: true,
      can_remote_control: false,
      can_create_channels: true,
      can_upload_files: true
    }
  },
  {
    name: ROLE_SCOPED_ADMIN,
    description:
      'Администратор контура (департамента или филиала) — управление только своими сотрудниками и отделами',
    permissions: {
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
    }
  }
];

const COMPANY_NAME = 'АО "Страховая компания "Сентрас Иншуранс"';

async function seedFreshInstall(target) {
  const now = new Date().toISOString();

  for (const role of BASE_ROLES) {
    await target.run(
      `INSERT INTO roles (name, description, permissions_json) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [role.name, role.description, JSON.stringify(role.permissions)]
    );
  }

  const company = await target.run(
    `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
     VALUES (NULL, $1, $2, 'company', 0, $3) RETURNING id`,
    ['АО СК Сентрас Иншуранс', 'Головная корпоративная холдинговая компания', now]
  );
  const companyId = company.rows[0].id;

  const headOffice = await target.run(
    `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
     VALUES ($1, $2, $3, 'branch', 1, $4) RETURNING id`,
    [companyId, 'Головной Офис', 'Центральный аппарат страховой компании', now]
  );
  const headOfficeId = headOffice.rows[0].id;

  const structure = [
    ['HR-Департамент', 'Управление человеческими ресурсами'],
    ['Административное Управление', 'Хозяйственное и документационное обеспечение'],
    ['Департамент СХ', 'Клиентский опыт и сервис'],
    ['Департамент Web-разработок', 'Разработка корпоративных систем и сервисов'],
    ['Департамент Андеррайтинга', 'Оценка рисков страхования'],
    ['Департамент Бухгалтерского Учета и Аудита', 'Бухгалтерский учет и аудит'],
    ['Департамент Интернет Продаж', 'Цифровые каналы продаж страховых продуктов'],
    ['Департамент Корпоративного Страхования', 'Страхование юридических лиц'],
    ['Департамент Корпоративных Продаж', 'Продажи корпоративным клиентам'],
    ['Департамент Маркетинга', 'Маркетинг и PR'],
    ['Департамент Медицинского Обслуживания', 'Курация медицинских программ'],
    ['Департамент Медицинского Страхования', 'Добровольное медицинское страхование'],
    ['Департамент Методологии Бизнес-процессов', 'Регламентация и методология']
  ];

  let order = 1;
  for (const [name, description] of structure) {
    await target.run(
      `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
       VALUES ($1, $2, $3, 'department', $4, $5)`,
      [headOfficeId, name, description, order++, now]
    );
  }

  // Единственная учётная запись, которая нужна чистой установке. Реальных
  // сотрудников заводит администратор — сервер не придумывает людей.
  const adminRole = await target.get('SELECT id FROM roles WHERE name = $1', [ROLE_SUPERADMIN]);
  const initialPassword = resolveInitialAdminPassword();
  const encoded = await hashPassword(initialPassword);

  await target.run(
    `INSERT INTO users (
       username, password_hash, salt, full_name, email, phone, job_title,
       department_id, role_id, uin, extension, company, status, created_at,
       is_active, must_change_password, approval_status, password_changed_at
     ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, 1, '100', $9, 'offline', $10, 1, 1, 'approved', $10)`,
    [
      'admin',
      encoded,
      process.env.INITIAL_ADMIN_NAME || 'Администратор системы',
      'admin@cic.kz',
      '+7 (727) 244-77-00',
      'Главный системный администратор',
      headOfficeId,
      adminRole.id,
      COMPANY_NAME,
      now
    ]
  );

  const settings = [
    ['company_name', COMPANY_NAME],
    ['server_name', 'CentyChat Server'],
    // Выключено на чистой установке: сервер может оказаться доступен из
    // интернета, и самостоятельная регистрация означала бы, что завести себе
    // учётную запись может любой, кто до него дотянулся.
    ['allow_registration', 'false'],
    ['max_upload_size_mb', '100']
  ];
  for (const [key, value] of settings) {
    await target.run(
      `INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, value, now]
    );
  }

  console.log('[Identity] Чистая установка: созданы роли, структура и учётная запись admin.');
}

// Рабочая установка: Railway или явный NODE_ENV=production.
function isProductionDeployment() {
  return (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID)
  );
}

// Пароль первого администратора. Раньше без переменной им становился «123456»:
// после потери диска учётная запись создавалась заново, и первым вошедшим мог
// оказаться кто угодно. Теперь в рабочей установке без пароля сервер не
// поднимается, а на машине разработчика пароль случайный и виден один раз.
function resolveInitialAdminPassword() {
  const given = process.env.INITIAL_ADMIN_PASSWORD;
  if (given) {
    const { assertPasswordPolicy } = require('../../services/user.service');
    try {
      assertPasswordPolicy(given);
    } catch (err) {
      throw new Error(`INITIAL_ADMIN_PASSWORD не подходит: ${err.message}`);
    }
    return given;
  }
  if (isProductionDeployment()) {
    throw new Error(
      'Задайте INITIAL_ADMIN_PASSWORD: база учётных записей пустая, и без него администратора ' +
        'пришлось бы создать с общеизвестным паролем.'
    );
  }
  const generated = crypto.randomBytes(12).toString('base64url');
  console.warn(`[Identity] Разработка: пароль admin для первого входа — ${generated}`);
  return generated;
}

// Роли и корень структуры должны существовать и в перенесённой базе — прежние
// установки могли их не иметь.
async function ensureBaselineRows(target) {
  for (const role of BASE_ROLES) {
    await target.run(
      `INSERT INTO roles (name, description, permissions_json) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [role.name, role.description, JSON.stringify(role.permissions)]
    );
  }

  const now = new Date().toISOString();
  const company = await target.get(
    `SELECT id FROM departments WHERE dept_type = 'company' ORDER BY id ASC`
  );
  if (!company) {
    const created = await target.run(
      `INSERT INTO departments (parent_id, name, description, dept_type, sort_order, created_at)
       VALUES (NULL, $1, $2, 'company', 0, $3) RETURNING id`,
      ['АО СК Сентрас Иншуранс', 'Головная корпоративная холдинговая компания', now]
    );
    const companyId = created.rows[0].id;
    // Всё, что до сих пор было корнем, становится филиалом этой компании.
    await target.run(
      `UPDATE departments SET parent_id = $1, dept_type = 'branch'
       WHERE parent_id IS NULL AND id <> $1`,
      [companyId]
    );
  }

  for (const [key, value] of [['company_name', COMPANY_NAME], ['allow_registration', 'false']]) {
    await target.run(
      `INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, value, now]
    );
  }
}

// ── Восстановление доступа администратора ──────────────────────────────────
// Единственный путь назад, если пароль администратора утрачен: сменить его
// изнутри нельзя — для этого нужно войти. Право задавать переменные окружения
// развёртывания — та же граница доверия, что и ALLOWED_CLIENT_IPS.
//
// Срабатывает один раз на каждое новое значение: отпечаток применённого
// пароля запоминается, поэтому забытая в настройках переменная не откатывает
// пароль, который администратор сменил потом.
async function applyEmergencyAdminReset(target) {
  const requested = process.env.ADMIN_PASSWORD_RESET;
  if (!requested) return;

  const username = process.env.ADMIN_PASSWORD_RESET_USER || 'admin';
  // Отпечаток — HMAC на ключе сервера: простой SHA-256 от «логин:пароль»
  // подбирался офлайн по словарю. Прежний формат тоже узнаётся, иначе после
  // обновления забытая переменная откатила бы уже сменённый пароль.
  const marker = crypto.createHmac('sha256', config.JWT_SECRET).update(`${username}:${requested}`).digest('hex');
  const legacyMarker = crypto.createHash('sha256').update(`${username}:${requested}`).digest('hex');

  const previous = await target.get(
    `SELECT value FROM server_settings WHERE key = 'last_admin_password_reset'`
  );
  if (previous?.value === marker || previous?.value === legacyMarker) return;

  const { assertPasswordPolicy } = require('../../services/user.service');
  try {
    assertPasswordPolicy(requested);
  } catch (err) {
    console.warn(`[Recovery] ADMIN_PASSWORD_RESET не применён: ${err.message}`);
    return;
  }

  const user = await target.get('SELECT id FROM users WHERE username = $1', [username]);
  if (!user) {
    console.warn(`[Recovery] ADMIN_PASSWORD_RESET задан, но пользователя "${username}" нет — пропущено.`);
    return;
  }

  const encoded = await hashPassword(requested);
  const now = new Date().toISOString();
  await target.run(
    `UPDATE users
     SET password_hash = $1, salt = NULL, must_change_password = 0, is_active = 1,
         failed_login_count = 0, locked_until = NULL, password_changed_at = $2,
         token_version = token_version + 1
     WHERE id = $3`,
    [encoded, now, user.id]
  );

  await target.run(
    `INSERT INTO server_settings (key, value, updated_at) VALUES ('last_admin_password_reset', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [marker, now]
  );

  console.warn(
    `[Recovery] Пароль "${username}" сброшен значением ADMIN_PASSWORD_RESET. ` +
      'Войдите, смените его и УДАЛИТЕ эту переменную из настроек развёртывания.'
  );
}

module.exports = {
  identity,
  isIdentityReady,
  findImportSource,
  initIdentity,
  closeIdentity,
  ROLE_SUPERADMIN,
  ROLE_EMPLOYEE,
  ROLE_SCOPED_ADMIN,
  COMPANY_NAME
};
