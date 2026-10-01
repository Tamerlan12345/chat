const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');
const apiRouter = require('./api');
const { isReady } = require('./bootstrap');
const { getClientIp, isIpAllowed, rateLimitIpKey } = require('./services/ip-access.service');
const AuthService = require('./services/auth.service');
const { checkRateLimit } = require('./services/rate-limiter');

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

// Security headers (defense in depth — this SPA is also reachable from any
// plain browser on the LAN via the static-file fallback below, not just
// through the Electron shell). Стоят первыми: раньше они шли после проверки
// адреса и готовности, и страница отказа по IP и ответ 503 «сервер
// запускается» уходили без единого заголовка защиты (аудит, раунд 4, Р4-15).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Ресурсы сервера не встраиваются чужими сайтами (<img>, <script> с другого
  // сайта). same-site, а не same-origin: интерфейс в разработке (vite на
  // localhost:5173) — тот же сайт, что и сервер на localhost:2004.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // Отдельный процесс браузера для этого источника и запрет старых
  // междоменных политик Flash/PDF (crossdomain.xml).
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // Политика содержимого для интерфейса. Любая будущая уязвимость XSS
  // упрётся в неё: чужой скрипт не загрузится, данные не уйдут на чужой адрес,
  // страницу нельзя встроить. blob: — для обработчика звука (AudioWorklet) и
  // картинок переписки; 'unsafe-inline' только для стилей — React задаёт
  // style у элементов. Действует на все ответы, включая API и файлы (у
  // скачивания вложений она ещё строже — sandbox, см. api/index.js).
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=()');
  // Ответы API несут личные данные и токены — ни браузер, ни промежуточный
  // кэш не должны их сохранять. Путь сравнивается в нижнем регистре:
  // маршрутизация Express нечувствительна к регистру, и «/API/…» доходил бы
  // до тех же обработчиков, но мимо no-store (проверка раунда 4, ПР-I1).
  if (req.path.toLowerCase().startsWith('/api/') && req.path.toLowerCase() !== '/api/health') res.setHeader('Cache-Control', 'no-store');
  // Сервис работает только по HTTPS (Railway): браузер и Electron запоминают это
  // и не пойдут по http даже по подменённой ссылке.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

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
    (req.path !== '/api/health' && req.path.startsWith('/api')) ||
    (req.get('accept') || '').includes('application/json');

  if (wantsJson) {
    return res.status(403).json({ error: 'Доступ запрещён с этого IP-адреса', ip });
  }

  res.status(403).type('html').send(renderAccessDeniedPage(ip));
});
// Хранилище учётных записей поднимается асинхронно. Пока оно не готово, любой
// запрос упёрся бы в невнятную ошибку внутри сервиса — честнее ответить, что
// сервер ещё запускается.
app.use((req, res, next) => {
  if (isReady() || req.path === '/health' || req.path === '/api/health') return next();
  res.status(503).json({ error: 'Сервер запускается, повторите через несколько секунд' });
});

// Общий потолок анонимных запросов к API с одного адреса (сети /64 для
// IPv6). Дорогие анонимные действия — вход, регистрация, «стук» устройства —
// ограничены каждое своим пределом; этот — последний рубеж от простого
// потока запросов с одного источника (аудит, раунд 4, находка Р4-12). Запрос
// с действительным по подписи токеном сюда не считается — это работающий
// сотрудник, а не аноним; проверка подписи — один HMAC, без базы. Предел
// щедрый: офис за одним NAT при запуске делает несколько анонимных запросов
// на человека (сведения о сервере, «стук», вход).
// Дешёвые публичные GET, которые отдаются из памяти без обращения к базе:
// клиент запускается и опрашивает их у всех сотрудников разом. Из потолка
// исключены — их флуд стоит только обработки HTTP, а вход/регистрация/«стук»
// ограничены каждый своим пределом (проверка раунда 4, ПР-I1).
// /api/settings/departments НЕ исключён: он делает запрос к базе (в отличие от
// settings/info и /health, отвечающих из памяти), поэтому остаётся под
// потолком; сам ответ вдобавок кэшируется на 30 с (проверка раунда 4, M6).
const ANON_CEILING_EXEMPT = new Set(['/health', '/api/health', '/api/settings/info']);
app.use((req, res, next) => {
  const limit = config.ANON_RATE_LIMIT_PER_MINUTE;
  if (!limit) return next();
  const path = req.path.toLowerCase();
  if (!path.startsWith('/api/') && path !== '/health') return next();
  if (req.method === 'GET' && ANON_CEILING_EXEMPT.has(path)) return next();
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && AuthService.verifyToken(authHeader.substring(7))) {
    return next();
  }
  if (checkRateLimit(`anon:${rateLimitIpKey(getClientIp(req))}`, { maxAttempts: limit, windowMs: 60000 })) {
    return next();
  }
  res.set('Retry-After', '60');
  return res.status(429).json({ error: 'Слишком много запросов с этого адреса. Повторите через минуту.' });
});

// Интерфейс загружается с этого же сервера, и его запросы — того же
// происхождения, CORS им не нужен. Отражение любого Origin разрешало чужому
// сайту, открытому сотрудником в офисе, обращаться к API из разрешённой сети
// и читать ответы. Для разработки (vite на другом порту) адреса перечисляются
// явно в CORS_ALLOWED_ORIGINS.
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (corsOrigins.length) {
  app.use(cors({ origin: corsOrigins }));
}
// Самое крупное тело — фотография профиля в data URL. 50 МБ на разбор JSON до
// всякой авторизации — готовый способ занять память сервера.
// До проверки входа разбирается только небольшое тело. Крупное (фото профиля
// в data URL) допускается лишь на своём маршруте.
const LARGE_BODY_PATHS = new Set(['/api/users/profile']);
const smallJson = express.json({ limit: '256kb' });
const largeJson = express.json({ limit: '5mb' });
app.use((req, res, next) => (LARGE_BODY_PATHS.has(req.path) ? largeJson : smallJson)(req, res, next));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Logging
app.use((req, res, next) => {
  if (!req.path.startsWith('/static')) {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

// Автообновление настольного клиента: после IP-фильтра и проверки готовности,
// но раньше статики с её фильтром по User-Agent — electron-updater ходит своим
// сеансом, и его запрос не должен получить index.html или отказ фильтра.
app.use('/updates', require('./updates/router'));

// API Routes
app.use('/api', apiRouter);

// Health check endpoint. Анонимному запросу — только состояние: версия
// сервера, движок хранилища учётных записей и время работы — это уже сведения
// о развёртывании, а сюда достаёт кто угодно в разрешённой сети, ещё до
// входа (план 3.6, аудит, находка №18). Подробности отдаются только с
// действующим токеном супер-администратора.
async function healthCheck(req, res) {
  const ready = isReady();
  if (!ready) {
    // Хранилище ещё поднимается — проверять токен не на чем, а «starting»
    // само по себе подробностей не несёт.
    return res.status(503).json({ status: 'starting' });
  }

  let privileged = false;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const user = await AuthService.resolveSession(authHeader.substring(7));
      privileged = Boolean(user?.permissions?.is_admin) && !user.permissions?.is_scoped_admin;
    } catch {
      privileged = false;
    }
  }

  if (!privileged) return res.status(200).json({ status: 'ok' });

  res.status(200).json({
    status: 'ok',
    version: config.SERVER_VERSION,
    identityStore: config.IDENTITY_DRIVER === 'postgres' ? 'postgres' : 'sqlite',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
}

app.get('/health', healthCheck);
app.get('/api/health', healthCheck);

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

// Последний рубеж: обработчики оборачиваются так, что отказ обещания попадает
// сюда. Наружу уходит только то, что вызывающей стороне положено знать, —
// подробности остаются в журнале сервера.
app.use((err, req, res, next) => {
  console.error(`[HTTP Error] ${req.method} ${req.path}:`, err?.message || err);
  if (res.headersSent) return next(err);
  // Ошибки разбора запроса (слишком большое тело, неверный JSON) — это отказ
  // клиенту, а не сбой сервера: 413 и 400 с понятным текстом.
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Неверный формат запроса' });
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

module.exports = app;
