const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  resetDatabaseFiles,
  resetPostgresSchema,
  DATA_DIR,
  TEST_DATABASE_URL
} = require('./helpers/boot');
const { buildLegacyDatabase } = require('./helpers/legacy-db');

// Как рабочая установка переживает смену хранилища.
//
// Реальный порядок событий на Railway: код выложен раньше, чем задан
// DATABASE_URL. Первый запуск переносит сотрудников в запасной identity.db и
// удаляет их из базы переписки. Потом администратор задаёт DATABASE_URL — и
// PostgreSQL обязан получить этих сотрудников, а не чистую установку с
// администратором «123456». Каждый запуск идёт отдельным процессом, как и в
// бою: хранилище выбирается один раз при старте.

const SERVER_ROOT = path.resolve(__dirname, '..');
const CHAT_DB = path.join(DATA_DIR, 'mychat.db');
const IDENTITY_DB = path.join(DATA_DIR, 'identity.db');
const SNAPSHOT_DB = path.join(DATA_DIR, 'pre-identity-split.db');

const BOOT_SCRIPT = `
  const { bootstrap, shutdown } = require('./src/bootstrap');
  bootstrap()
    .then(() => shutdown())
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
`;

function runBoot({ postgres = false, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.DATABASE_URL;
  delete env.POSTGRES_URL;
  delete env.TEST_DATABASE_URL;
  if (postgres) {
    env.DATABASE_URL = TEST_DATABASE_URL;
    env.DATABASE_SSL = 'disable';
  }
  return spawnSync(process.execPath, ['-e', BOOT_SCRIPT], { cwd: SERVER_ROOT, env, encoding: 'utf8' });
}

function removeDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(file + suffix, { force: true });
  }
}

function withDb(file, fn) {
  const db = new DatabaseSync(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const hasTable = (db, name) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const usernames = (file) =>
  withDb(file, (db) =>
    hasTable(db, 'users') ? db.prepare('SELECT username FROM users ORDER BY id').all().map((r) => r.username) : []
  );

test.before(async () => {
  resetDatabaseFiles();
  await resetPostgresSchema();
  buildLegacyDatabase(CHAT_DB);
});

test('запуск без DATABASE_URL переносит сотрудников в identity.db', () => {
  const run = runBoot();
  assert.strictEqual(run.status, 0, run.stderr);

  assert.deepStrictEqual(usernames(IDENTITY_DB), ['admin', 'petrov']);
  assert.strictEqual(
    withDb(CHAT_DB, (db) => hasTable(db, 'users')),
    false,
    'из базы переписки учётные записи удалены — ровно поэтому их нельзя искать только там'
  );
});

test('для PostgreSQL источником служит identity.db, а не опустевшая база переписки', () => {
  const { findImportSource } = require('../src/db/identity');

  const chat = new DatabaseSync(CHAT_DB);
  try {
    const source = findImportSource({ dialect: 'postgres', legacyDb: chat });
    assert.ok(source, 'источник обязан найтись — иначе PostgreSQL получит чистую установку');
    try {
      assert.match(source.label, /identity\.db/);
      const count = source.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      assert.strictEqual(Number(count), 2);
    } finally {
      source.close();
    }
  } finally {
    chat.close();
  }
});

test(
  'запуск с DATABASE_URL после работы на запасном хранилище сохраняет сотрудников',
  { skip: TEST_DATABASE_URL ? false : 'нужен TEST_DATABASE_URL (npm run test:pg)' },
  async () => {
    const run = runBoot({ postgres: true });
    assert.strictEqual(run.status, 0, run.stderr);

    const { Client } = require('pg');
    const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
    await client.connect();
    try {
      const users = await client.query('SELECT username, password_hash FROM users ORDER BY id');
      assert.deepStrictEqual(users.rows.map((r) => r.username), ['admin', 'petrov'], 'а не чистая установка');

      const expectedHash = withDb(IDENTITY_DB, (db) =>
        db.prepare("SELECT password_hash FROM users WHERE username = 'petrov'").get().password_hash
      );
      assert.strictEqual(
        users.rows[1].password_hash,
        expectedHash,
        'пароль перенесён, а не создан заново'
      );

      const departments = await client.query('SELECT COUNT(*)::int AS n FROM departments');
      assert.ok(departments.rows[0].n < 15, 'структура чистой установки создаваться не должна');
    } finally {
      await client.end();
    }
  }
);

test('без identity.db сотрудники восстанавливаются из снимка до разделения', () => {
  removeDb(IDENTITY_DB);
  assert.ok(fs.existsSync(SNAPSHOT_DB), 'снимок остаётся после первого запуска');

  const run = runBoot();
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(usernames(IDENTITY_DB), ['admin', 'petrov']);
});

test('поверх базы с перепиской администратор по умолчанию не создаётся', () => {
  removeDb(IDENTITY_DB);
  removeDb(SNAPSHOT_DB);

  const run = runBoot();
  assert.notStrictEqual(run.status, 0, 'сервер обязан отказаться подниматься');
  assert.match(run.stderr, /не новая установка/);
  assert.deepStrictEqual(usernames(IDENTITY_DB), [], 'никакого admin с паролем 123456');
});

test('осознанный сброс учётных записей возможен только явным флагом', () => {
  removeDb(IDENTITY_DB);

  const run = runBoot({ extraEnv: { IDENTITY_ALLOW_EMPTY_BOOTSTRAP: 'true' } });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(usernames(IDENTITY_DB), ['admin']);
});
