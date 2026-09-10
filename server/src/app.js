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

// Экран отказа по IP. Отдаётся вместо интерфейса, поэтому свёрстан здесь
// целиком — до статики запрос не доходит, брать стили неоткуда.
function renderAccessDeniedPage(ip) {
  const safeIp = String(ip || 'неизвестен').replace(/[^0-9a-fA-F.:]/g, '');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Доступ ограничен</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f1f5f9; font-family:'Segoe UI',system-ui,-apple-system,sans-serif; padding:24px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 12px 40px rgba(15,23,42,.14);
          max-width:520px; width:100%; padding:36px 40px; text-align:center; }
  .badge { width:56px; height:56px; border-radius:50%; background:#fef2f2; color:#dc2626;
           display:flex; align-items:center; justify-content:center; margin:0 auto 18px;
           font-size:26px; }
  h1 { margin:0 0 10px; font-size:19px; color:#0f172a; }
  p { margin:0 0 18px; font-size:14px; line-height:1.6; color:#475569; }
  .ip { display:inline-block; margin:0 0 20px; padding:10px 18px; background:#f8fafc;
        border:1px solid #e2e8f0; border-radius:8px; font-family:Consolas,monospace;
        font-size:17px; font-weight:600; color:#0f172a; letter-spacing:.5px; user-select:all; }
  .hint { font-size:12.5px; color:#64748b; line-height:1.6; border-top:1px solid #e2e8f0;
          padding-top:16px; margin-top:4px; }
</style></head>
<body>
  <div class="card">
    <div class="badge">&#9888;</div>
    <h1>Доступ к корпоративному чату ограничен</h1>
    <p>Подключение разрешено только из сетей компании. Ваш текущий адрес в этот список не входит.</p>
    <div class="ip">${safeIp}</div>
    <div class="hint">
      Передайте этот адрес администратору, чтобы он открыл доступ.<br>
      Адрес меняется при смене сети — например, при переходе с кабеля на Wi&#8209;Fi
      или при работе через мобильный интернет.
    </div>
  </div>
</body></html>`;
}

// Network-level access gate — runs before EVERYTHING else (CORS, static
// files, the API router, even /health), so a disallowed IP gets a flat 403
// and nothing else: no login page, no version info, no route to try next.
// This is deploy-time config (ALLOWED_CLIENT_IPS env var), not an app
// setting — see services/ip-access.service.js for why that split matters.
// No-op (allows everything) when unconfigured, so a plain LAN deployment is
// unaffected by default.
app.use((req, res, next) => {
  const ip = getClientIp(req);
  if (isIpAllowed(ip)) return next();

  // The app loads its whole interface from here, so a bare JSON body ends up
  // rendered as raw text in the window — which is what the employee sees
  // instead of anything explaining the situation. Programmatic callers still
  // get JSON; anything that навигates gets a readable page. The blocked
  // address is shown deliberately: without it the employee cannot tell the
  // administrator what to add, and it is their own address, not a secret.
  const wantsJson =
    req.path.startsWith('/api') ||
    (req.get('accept') || '').includes('application/json');

  if (wantsJson) {
    return res.status(403).json({ error: 'Доступ запрещён с этого IP-адреса', ip });
  }

  res.status(403).type('html').send(renderAccessDeniedPage(ip));
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
  // Возврат к index.html для путей интерфейса. В Express 5 шаблон '*' больше
  // не разбирается — маршрутизатор требует именованный параметр. Обычный
  // app.use в конце цепочки делает то же самое и не зависит от синтаксиса
  // шаблонов вовсе.
  app.use((req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

module.exports = app;
