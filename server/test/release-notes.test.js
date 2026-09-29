const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Задача 8 (документация): проверяет не литературный стиль, а то, что в
// заметках для администратора действительно названы все переменные и
// последствия, которые перечислила финальная ревизия, — и что .env.example
// их тоже упоминает, а не только сама заметка. Не про desktop/installer/
// docs/автообновление.md — их не касается.

const REPO_ROOT = path.resolve(__dirname, '../..');
const NOTES_PATH = path.join(REPO_ROOT, 'docs', 'выпуск-2026-10-безопасность.md');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const ROUND4_ENV = [
  'LOGIN_ACCOUNT_SOFT_LIMIT',
  'LOGIN_ACCOUNT_MAX_DELAY_SECONDS',
  'PASSWORD_HASH_CONCURRENCY',
  'ANON_RATE_LIMIT_PER_MINUTE',
  'UPLOAD_MAX_MB_PER_HOUR'
];
const IDENTITY_DOC_PATH = path.join(REPO_ROOT, 'docs', 'identity-store.md');

test('заметки о выпуске существуют и называют однократные последствия деплоя', () => {
  assert.ok(fs.existsSync(NOTES_PATH), `не найден файл ${NOTES_PATH}`);
  const text = fs.readFileSync(NOTES_PATH, 'utf8');

  // Секрет устройства инвалидируется — каждый сотрудник входит по паролю один раз.
  assert.match(text, /секрет.*устройств/i);
  assert.match(text, /пароль/i);

  // Отсечка legacy-токенов.
  assert.match(text, /LEGACY_TOKEN_CUTOFF/);
  assert.match(text, /2026-10-15/);

  // Новые переменные окружения.
  assert.match(text, /DEVICE_SECRET_TTL_DAYS/);
  assert.match(text, /SESSION_MAX_DAYS/);
  assert.match(text, /IDENTITY_AUTO_IMPORT/);
  assert.match(text, /UPDATES_DIR/);
  assert.match(text, /UPDATES_DISABLED/);
  assert.match(text, /UPDATES_MAX_CONCURRENT_DOWNLOADS/);
  assert.match(text, /UPDATES_MAX_FILE_MB/);
  assert.match(text, /docs\/автообновление\.md/);

  // scrypt: параметр и стоимость по памяти.
  assert.match(text, /131072|2\^17/);
  assert.match(text, /128\s*МиБ/);
  assert.match(text, /512\s*МиБ/);

  // Фильтр типов файлов — вкл. по умолчанию, whitelist, 415, вкладка «Файлы».
  assert.match(text, /415/);
  assert.match(text, /«Файлы»/);
  assert.match(text, /pdf/);
  assert.match(text, /docx/);

  // Сотрудники больше не редактируют ФИО/должность.
  assert.match(text, /ФИО/);
  assert.match(text, /должность/i);

  // /health анонимному запросу — только статус.
  assert.match(text, /\/health/);
  assert.match(text, /status/);

  // Окна правки/удаления сообщений — 60 минут по умолчанию.
  assert.match(text, /60 минут/);
});

test('.env.example упоминает новые переменные окружения (с значениями по умолчанию, закомментированные)', () => {
  const text = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  for (const name of [
    'DEVICE_SECRET_TTL_DAYS',
    'LEGACY_TOKEN_CUTOFF',
    'IDENTITY_AUTO_IMPORT',
    'UPDATES_DIR',
    'UPDATES_DISABLED',
    'UPDATES_MAX_CONCURRENT_DOWNLOADS',
    'UPDATES_MAX_FILE_MB',
    // Аудит безопасности, раунд 4.
    ...ROUND4_ENV
  ]) {
    assert.match(text, new RegExp(`^#\\s*${name}=`, 'm'), `.env.example должен упоминать ${name} закомментированной строкой`);
  }
});

test('заметки о выпуске описывают пределы раунда 4 и то, что действующие пароли продолжают пускать', () => {
  const text = fs.readFileSync(NOTES_PATH, 'utf8');
  for (const name of ROUND4_ENV) assert.match(text, new RegExp(name), `заметки должны упоминать ${name}`);
  assert.match(text, /Действующие пароли продолжают работать/);
  assert.match(text, /LOGIN_MAX_FAILED_ATTEMPTS/);
});

test('docs/identity-store.md отражает актуальный N=131072 и требование IDENTITY_AUTO_IMPORT для резервных файлов', () => {
  const text = fs.readFileSync(IDENTITY_DOC_PATH, 'utf8');
  assert.match(text, /131072/);
  assert.doesNotMatch(text, /N=32768/, 'устаревшее значение N не должно оставаться в документе');
  assert.match(text, /IDENTITY_AUTO_IMPORT=true/);
});
