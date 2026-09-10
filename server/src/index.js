const http = require('node:http');
const config = require('./config');
const { getDatabase } = require('./db');
const wsServer = require('./ws/server');
const backupScheduler = require('./services/backup-scheduler.service');

// Приложение собирается в app.js и экспортируется без запуска — так его
// можно поднять в тестах на произвольном порту, не трогая расписание
// резервных копий и WebSocket.
const app = require('./app');

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket Gateway
wsServer.init(server);

// Start listening
server.listen(config.PORT, config.HOST, () => {
  // Ensure DB is initialized
  const db = getDatabase();
  db.prepare("UPDATE users SET status = 'offline'").run();

  backupScheduler.start();

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
  [✓] Server Port:        ${config.PORT} (TCP / HTTP & WebSocket)
  [✓] Local Address:      http://localhost:${config.PORT}
  [✓] Web Management:     http://localhost:${config.PORT}/admin
  [✓] Web Database Studio:http://localhost:${config.PORT}/api/admin/db
  [✓] WebSocket Endpoint: ws://localhost:${config.PORT}/ws
  [✓] Database Path:      ${config.DB_PATH} (SQLite WAL)
  [✓] Auto Backups:       every ${config.BACKUP_INTERVAL_HOURS}h, keep last ${config.BACKUP_RETENTION_COUNT} (${config.BACKUPS_DIR})
  [✓] Ready for client connections & remote desktop sessions.
=====================================================================
  SuperAdmin login: admin
  Password:         ${process.env.INITIAL_ADMIN_PASSWORD
    ? 'as set in INITIAL_ADMIN_PASSWORD'
    : '123456 (default — set INITIAL_ADMIN_PASSWORD to override)'}
  Applies to the first run only, when the database is seeded; a password
  changed since then is unaffected. A forced change is required on first login.
=====================================================================
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[MyChat Server] Stopping server gracefully...');
  server.close(() => {
    console.log('[MyChat Server] Stopped.');
    process.exit(0);
  });
});
