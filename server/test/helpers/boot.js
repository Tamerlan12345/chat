const fs = require('node:fs');
const path = require('node:path');

// Общая подготовка для тестов. С тех пор как учётные записи переехали в
// отдельное хранилище, «чистая база» — это две базы, и подниматься они должны
// в правильном порядке, тем же bootstrap(), что и в бою.
//
// Файлы удаляются ДО первого require модулей базы: node:sqlite держит файл
// открытым, и удалить его потом Windows уже не даст.

const SERVER_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(SERVER_ROOT, 'data');

const DB_FILES = ['mychat.db', 'identity.db', 'pre-identity-split.db'];

// Весь набор тестов можно прогнать против настоящего PostgreSQL:
//
//   TEST_DATABASE_URL=postgresql://... npm test
//
// Отдельная переменная, а не DATABASE_URL, выбрана намеренно: подготовка
// очищает схему целиком, и случайно направить это на рабочую базу нельзя. Она
// присваивается здесь, до первого require конфигурации, — иначе адрес
// прочитается уже после того, как драйвер выбран.
const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'disable';
}

async function resetPostgresSchema() {
  if (!TEST_DATABASE_URL) return;
  const { Client } = require('pg');
  const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}

function resetDatabaseFiles() {
  for (const base of DB_FILES) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(path.join(DATA_DIR, base + suffix), { force: true });
      } catch {
        /* файл занят другим процессом — тест всё равно упадёт заметно */
      }
    }
  }
}

let booted = null;

/**
 * Поднимает обе базы с нуля. Повторные вызовы возвращают уже поднятые —
 * внутри одного файла тестов состояние накапливается намеренно.
 */
async function freshBoot() {
  if (booted) return booted;
  resetDatabaseFiles();
  await resetPostgresSchema();

  const { bootstrap } = require('../../src/bootstrap');
  const SettingsService = require('../../src/services/settings.service');

  await bootstrap();
  await SettingsService.load();

  booted = {
    identity: require('../../src/db/identity').identity(),
    chat: require('../../src/db').getDatabase()
  };
  return booted;
}

async function closeAll() {
  booted = null;
  try {
    await require('../../src/bootstrap').shutdown();
  } catch {
    /* уже закрыто */
  }
}

module.exports = {
  freshBoot,
  closeAll,
  resetDatabaseFiles,
  resetPostgresSchema,
  DATA_DIR,
  TEST_DATABASE_URL
};
