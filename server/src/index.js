const http = require('node:http');
const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');
const { getDatabase } = require('./db');
const apiRouter = require('./api');
const wsServer = require('./ws/server');
const backupScheduler = require('./services/backup-scheduler.service');
const { getClientIp, isIpAllowed } = require('./services/ip-access.service');

const app = express();

// Middlewares
app.disable('x-powered-by');

// Network-level access gate — runs before EVERYTHING else (CORS, static
// files, the API router, even /health), so a disallowed IP gets a flat 403
// and nothing else: no login page, no version info, no route to try next.
// This is deploy-time config (ALLOWED_CLIENT_IPS env var), not an app
// setting — see services/ip-access.service.js for why that split matters.
// No-op (allows everything) when unconfigured, so a plain LAN deployment is
// unaffected by default.
app.use((req, res, next) => {
  const ip = getClientIp(req);
  if (!isIpAllowed(ip)) {
    return res.status(403).json({ error: 'Доступ запрещён с этого IP-адреса' });
  }
  next();
});
// origin:true reflects whatever Origin the caller sends — needed because
// clients hit this server from arbitrary LAN hostnames/IPs, and there's no
// fixed allowlist yet (see docs/designs/auth-access-control-remediation.md
// "Open Questions" — CORS lockdown needs real Origin data first). credentials
// is intentionally NOT enabled: auth is Bearer-token-in-header only, no
// cookies are ever set, so reflected-origin + allow-credentials (the actually
// dangerous combination) doesn't apply here.
app.use(cors({ origin: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Security headers (defense in depth — this SPA is also reachable from any
// plain browser on the LAN via the static-file fallback below, not just
// through the Electron shell). Deliberately does NOT set a Content-Security-
// Policy or restrict Permissions-Policy camera/microphone: the app relies on
// WebRTC calls and remote-desktop screen capture, and a strict connect-src/
// media policy would break peer connections that aren't same-origin.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});

// Logging
app.use((req, res, next) => {
  if (!req.path.startsWith('/static')) {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

// API Routes
app.use('/api', apiRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: config.SERVER_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Serve frontend if built — but only to the actual desktop app, not to
// someone who just typed the server's address into a browser. The only
// signal available to tell them apart is the User-Agent Electron sends by
// default ("...Electron/33.x.x..."), which the app never overrides (see
// desktop/src/main/main.js). Be honest about what this is: a UA string is
// trivially forged by anyone who opens devtools, so this stops a casual
// visitor from ever seeing a branded corporate login page at a public URL —
// it is NOT a real access control. The actual gate is the IP allowlist
// above (ALLOWED_CLIENT_IPS); this is an extra layer of obscurity on top of
// it, not a substitute for it. /api and /ws are untouched — the real app's
// own requests to them still work regardless of this check.
//
// Set ALLOW_BROWSER_ACCESS=true to lift this and let a plain browser load the
// UI too. That is the fallback when the desktop app can't be installed at all
// on a machine — Windows Smart App Control blocks unsigned executables outright
// and offers the user no way around it, so on such a machine the browser is the
// only way in until the app is code-signed. Flipping it costs a redeploy of the
// env var, not a code change.
function isDesktopClient(req) {
  return (req.headers['user-agent'] || '').includes('Electron');
}

const staticDir = path.resolve(__dirname, '../../desktop/dist');
if (fs.existsSync(staticDir)) {
  app.use((req, res, next) => {
    if (!config.ALLOW_BROWSER_ACCESS && !isDesktopClient(req)) {
      return res.status(404).send('Not found');
    }
    next();
  });
  app.use(express.static(staticDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

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
