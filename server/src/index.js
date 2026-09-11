const http = require('node:http');
const config = require('./config');
const { bootstrap, shutdown } = require('./bootstrap');
const wsServer = require('./ws/server');
const backupScheduler = require('./services/backup-scheduler.service');
const SettingsService = require('./services/settings.service');

// Приложение собирается в app.js и экспортируется без запуска — так его можно
// поднять в тестах на произвольном порту, не трогая расписание резервных копий
// и WebSocket.
const app = require('./app');

const server = http.createServer(app);
wsServer.init(server);

async function start() {
  // Сначала базы, потом приём соединений: запросы, пришедшие раньше готовности
  // хранилища учётных записей, всё равно пришлось бы отклонять.
  await bootstrap();
  await SettingsService.load();
  SettingsService.startAutoRefresh();

  server.listen(config.PORT, config.HOST, () => {
    backupScheduler.start();

    const identityLine =
      config.IDENTITY_DRIVER === 'postgres'
        ? 'PostgreSQL (DATABASE_URL)'
        : `SQLite ${config.IDENTITY_DB_PATH} — задайте DATABASE_URL для рабочей установки`;

    console.log(`
=====================================================================
  ███╗   ███╗██╗   ██╗ ██████╗██╗  ██╗ █████╗ ████████╗
  ████╗ ████║╚██╗ ██╔╝██╔════╝██║  ██║██╔══██╗╚══██╔══╝
  ██╔████╔██║ ╚████╔╝ ██║     ███████║███████║   ██║
  ██║╚██╔╝██║  ╚██╔╝  ██║     ██╔══██║██╔══██║   ██║
  ██║ ╚═╝ ██║   ██║   ╚██████╗██║  ██║██║  ██║   ██║
  ╚═╝     ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
       OpenMyChat Enterprise Server Core v${config.SERVER_VERSION}
=====================================================================
  [✓] Порт:                ${config.PORT} (HTTP и WebSocket)
  [✓] Локальный адрес:     http://localhost:${config.PORT}
  [✓] WebSocket:           ws://localhost:${config.PORT}/ws
  [✓] Переписка:           ${config.DB_PATH} (SQLite WAL)
  [✓] Учётные записи:      ${identityLine}
  [✓] Резервные копии:     каждые ${config.BACKUP_INTERVAL_HOURS} ч, хранить ${config.BACKUP_RETENTION_COUNT} (${config.BACKUPS_DIR})
=====================================================================
  Вход администратора: admin
  Пароль:              ${process.env.INITIAL_ADMIN_PASSWORD
    ? 'как задано в INITIAL_ADMIN_PASSWORD'
    : '123456 (по умолчанию — задайте INITIAL_ADMIN_PASSWORD)'}
  Относится только к первому запуску, когда база заполняется впервые;
  уже изменённый пароль это не затрагивает. При первом входе система
  потребует его сменить.
=====================================================================
    `);
  });
}

start().catch((err) => {
  console.error('[MyChat Server] Запуск не удался:', err);
  process.exit(1);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[MyChat Server] ${signal}: останавливаюсь…`);

  // Соединение с PostgreSQL закрывается явно: незакрытый пул держит процесс
  // живым, и контейнер снимается по таймауту вместо штатного завершения.
  server.close(async () => {
    SettingsService.stopAutoRefresh();
    try {
      await shutdown();
    } catch (err) {
      console.warn('[MyChat Server] Ошибка при закрытии хранилища:', err.message);
    }
    console.log('[MyChat Server] Остановлен.');
    process.exit(0);
  });

  // Если соединения не закрылись за 10 секунд — выходим принудительно.
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
