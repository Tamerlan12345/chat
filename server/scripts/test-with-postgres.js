#!/usr/bin/env node
// Прогоняет весь набор тестов против настоящего PostgreSQL, а не против
// запасного хранилища на SQLite.
//
//   npm run test:pg                      — поднимет PostgreSQL во временном
//                                          контейнере Docker и уберёт его за собой
//   TEST_DATABASE_URL=... npm run test:pg — возьмёт уже работающий сервер
//
// Смысл в том, что часть ошибок видна ТОЛЬКО на PostgreSQL. Так,
// последовательности идентификаторов после переноса готовых строк не
// сдвигаются сами — SQLite подтягивает счётчик к наибольшему id молча, а
// PostgreSQL отвергает первую же вставку. Прогон на запасном хранилище такую
// ошибку пропускает целиком.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CONTAINER = `mychat-test-pg-${crypto.randomBytes(4).toString('hex')}`;
const PORT = 55400 + Math.floor(Math.random() * 90);
const PASSWORD = crypto.randomBytes(12).toString('hex');

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function dockerAvailable() {
  const probe = run('docker', ['info']);
  return probe.status === 0;
}

function startPostgres() {
  console.log(`[test:pg] Поднимаю PostgreSQL во временном контейнере на порту ${PORT}…`);
  const started = run('docker', [
    'run', '-d', '--rm',
    '--name', CONTAINER,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', 'POSTGRES_DB=mychat_test',
    '-p', `${PORT}:5432`,
    'postgres:16-alpine'
  ]);

  if (started.status !== 0) {
    console.error('[test:pg] Не удалось запустить контейнер:', started.stderr.trim());
    process.exit(1);
  }

  // Контейнер отвечает не сразу: первый запуск ещё разворачивает кластер.
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres']);
    if (ready.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  console.error('[test:pg] PostgreSQL не поднялся за отведённое время.');
  stopPostgres();
  process.exit(1);
}

function stopPostgres() {
  run('docker', ['rm', '-f', CONTAINER]);
}

const external = (process.env.TEST_DATABASE_URL || '').trim();
let ownsContainer = false;

if (!external) {
  if (!dockerAvailable()) {
    console.error(
      '[test:pg] Нужен либо работающий Docker, либо адрес готового сервера в TEST_DATABASE_URL.'
    );
    process.exit(1);
  }
  startPostgres();
  ownsContainer = true;
}

const url = external || `postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/mychat_test`;

const result = run('npm', ['test'], {
  cwd: SERVER_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, TEST_DATABASE_URL: url, DATABASE_SSL: 'disable' }
});

if (ownsContainer) {
  console.log('[test:pg] Убираю временный контейнер.');
  stopPostgres();
}

process.exit(result.status === null ? 1 : result.status);
