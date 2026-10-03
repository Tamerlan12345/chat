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
  // Push-уведомления мобильных клиентов: учётные данные FCM/APNs только из
  // окружения; без них push выключен (одна строка в журнале), остальное — как раньше.
  require('./push/push.service').configureFromEnv();
  // Почта: если SMTP не настроен, одно честное предупреждение (запуск не блокируется).
  require('./services/mailer.service').logStartupStatus();

  server.listen(config.PORT, config.HOST, () => {
    backupScheduler.start();
    require('./services/security-monitor.service').startScheduledChecks();
    // Журнал, начатый до появления якоря цепочки, закрепляется один раз. Если
    // это случилось на рабочей базе с записями — об этом нужно знать.
    require('./services/audit.service')
      .ensureAnchor()
      .then((created) => {
        if (created) {
          require('./services/security-monitor.service').raise('audit_anchor_created', 'high',
            'Закреплено начало цепочки журнала аудита для существующих записей', {});
        }
      })
      .catch((err) => console.warn('[Audit] якорь цепочки не закреплён:', err.message));
    // Самопроверка при запуске: предупреждения видно в журнале сервера сразу,
    // а не только когда администратор откроет консоль.
    require('./services/security-monitor.service')
      .getStatus()
      .then(({ checks }) => {
        for (const c of checks.filter((x) => x.status !== 'ok')) {
          console.warn(`[Security] ${c.status === 'fail' ? 'ОШИБКА' : 'ВНИМАНИЕ'}: ${c.title} — ${c.detail}`);
        }
      })
      .catch((err) => console.warn('[Security] самопроверка не выполнена:', err.message));

    const identityLine =
      config.IDENTITY_DRIVER === 'postgres'
        ? 'PostgreSQL (DATABASE_URL)'
        : `SQLite ${config.IDENTITY_DB_PATH} — задайте DATABASE_URL для рабочей установки`;

    console.log(`
=====================================================================
   ██████╗███████╗███╗   ██╗████████╗██╗   ██╗ ██████╗██╗  ██╗ █████╗ ████████╗
  ██╔════╝██╔════╝████╗  ██║╚══██╔══╝╚██╗ ██╔╝██╔════╝██║  ██║██╔══██╗╚══██╔══╝
  ██║     █████╗  ██╔██╗ ██║   ██║    ╚████╔╝ ██║     ███████║███████║   ██║
  ██║     ██╔══╝  ██║╚██╗██║   ██║     ╚██╔╝  ██║     ██╔══██║██╔══██║   ██║
  ╚██████╗███████╗██║ ╚████║   ██║      ██║   ╚██████╗██║  ██║██║  ██║   ██║
   ╚═════╝╚══════╝╚═╝  ╚═══╝   ╚═╝      ╚═╝    ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
       CentyChat Server Core v${config.SERVER_VERSION}
=====================================================================
  [✓] Порт:                ${config.PORT} (HTTP и WebSocket)
  [✓] Локальный адрес:     http://localhost:${config.PORT}
  [✓] WebSocket:           ws://localhost:${config.PORT}/ws
  [✓] Переписка:           ${config.DB_PATH} (SQLite WAL)
  [✓] Учётные записи:      ${identityLine}
  [✓] Резервные копии:     каждые ${config.BACKUP_INTERVAL_HOURS} ч, хранить ${config.BACKUP_RETENTION_COUNT} (${config.BACKUPS_DIR})
=====================================================================
  Первый вход администратора: admin, пароль из INITIAL_ADMIN_PASSWORD.
  Относится только к первому запуску, когда база заполняется впервые;
  при первом входе система потребует сменить пароль.
=====================================================================
    `);
  });
}

start().catch((err) => {
  console.error('[CentyChat Server] Запуск не удался:', err);
  process.exit(1);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[CentyChat Server] ${signal}: останавливаюсь…`);

  // Соединение с PostgreSQL закрывается явно: незакрытый пул держит процесс
  // живым, и контейнер снимается по таймауту вместо штатного завершения.
  server.close(async () => {
    SettingsService.stopAutoRefresh();
    try {
      await shutdown();
    } catch (err) {
      console.warn('[CentyChat Server] Ошибка при закрытии хранилища:', err.message);
    }
    console.log('[CentyChat Server] Остановлен.');
    process.exit(0);
  });

  // Если соединения не закрылись за 10 секунд — выходим принудительно.
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
