const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, desktopCapturer, screen, powerMonitor, globalShortcut, clipboard, shell, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { RemoteInput } = require('./remote-input');
const { HostSession } = require('./host-session');
const { findCapturedDisplay, physicalRect } = require('./display-map');
const { originOf, isSameOrigin, isTrustedFrame, isExternalLink } = require('./security');
const {
  HEALTH_RETRY_MS,
  HEALTH_TIMEOUT_MS,
  shouldShowOfflineForFailure,
  shouldShowOfflineForStatus,
  describeLoadFailure,
  describeHttpFailure
} = require('./offline');
const { wasLaunchedAtLogin, resolveEnabled, writePreference, applyAutostart, isAutostartSupported } = require('./autostart');

const logFile = path.join(__dirname, '../../electron_debug.log');
function log(msg) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

log('Electron main.js loaded. argv: ' + JSON.stringify(process.argv));

// Адрес сервера — один на всё приложение. Раньше главное окно и окно
// просмотра брали его из разных переменных и могли смотреть на разные серверы.
// От него же отсчитывается, какой странице доверять (см. security.js).
const DEFAULT_SERVER_URL = 'https://chat-production-0456.up.railway.app';
const SERVER_URL = process.env.VITE_DEV_SERVER_URL || process.env.MYCHAT_SERVER_URL || DEFAULT_SERVER_URL;
const SERVER_ORIGIN = originOf(SERVER_URL);

const OFFLINE_PAGE = path.join(__dirname, 'offline.html');
const INDICATOR_PAGE = path.join(__dirname, 'rd-indicator.html');
const INDICATOR_PRELOAD = path.join(__dirname, 'rd-indicator-preload.js');

let mainWindow = null;

// Запущено ли приложение самой Windows при входе. Тогда окно не показывается —
// приложение подключается к серверу и ждёт в трее.
let launchedAtLogin = false;
let autostartEnabled = false;
let tray = null;
let viewerWindows = new Map(); // sessionId -> BrowserWindow
let toastWindows = []; // Active corner toast notification windows

// ── Сеанс удалённого доступа к этой машине ──────────────────────────────────

// Что сотрудник подтвердил. Пока сеанса нет, экран не отдаётся и ввод не
// включается, что бы ни попросила страница.
const hostSession = new HostSession();

// Экран, который выбрал оператор (id источника desktopCapturer), и экран,
// который реально транслируется сейчас. Второй нужен вводу: курсор ставится
// в пределах именно этого монитора.
let selectedScreenId = null;
let capturedScreen = null; // { sourceId, displayId }
const knownSources = new Map(); // id источника -> display_id

function rememberSources(sources) {
  for (const s of sources) knownSources.set(s.id, s.display_id || null);
}

function capturedDisplayRect() {
  const display = findCapturedDisplay(screen.getAllDisplays(), capturedScreen?.displayId, screen.getPrimaryDisplay());
  // dipToScreenRect есть только на Windows; остальным хватает масштаба.
  const toScreen = process.platform === 'win32' && typeof screen.dipToScreenRect === 'function'
    ? (rect) => screen.dipToScreenRect(null, rect)
    : null;
  return physicalRect(display, toScreen);
}

// Remote control of this machine's mouse and keyboard, active ONLY while the
// employee has an accepted session with full access. The renderer enables it
// on consent and disables it the moment sharing stops, so an event arriving
// outside a session is dropped rather than acted on.
const remoteInput = new RemoteInput(log, { getTargetRect: capturedDisplayRect });

// Single Instance Lock
app.setAppUserModelId('com.openmychat.desktop');
const gotTheLock = app.requestSingleInstanceLock();
log('requestSingleInstanceLock: ' + gotTheLock);
if (!gotTheLock) {
  log('Did not get single instance lock! Quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('Second instance triggered');
    showMainWindow();
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── Куда окну можно уходить и кому отвечает главный процесс ────────────────

function frameUrl(frame) {
  try { return String(frame?.url || ''); } catch { return ''; }
}

// Страница сервера — удалённый код. Ссылка из сообщения не должна ни открыть
// новое окно Electron с доступом к API приложения, ни увести главное окно на
// чужой сайт: оба сохранили бы preload со всеми его возможностями.
function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) {
      shell.openExternal(url).catch((err) => log(`openExternal failed: ${err.message}`));
    } else {
      log(`window.open denied: ${String(url).slice(0, 200)}`);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, legacyUrl) => {
    const url = event?.url || legacyUrl;
    if (isSameOrigin(url, SERVER_ORIGIN)) return;
    event.preventDefault();
    log(`navigation blocked: ${String(url).slice(0, 200)}`);
    if (isExternalLink(url)) {
      shell.openExternal(url).catch((err) => log(`openExternal failed: ${err.message}`));
    }
  });
}

function isMainWindowSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

// Чувствительные каналы принимаются только от верхнего кадра страницы сервера
// (а часть — только из главного окна). Страница без связи, окно-индикатор или
// iframe внутри страницы до них не дотягиваются.
function isFromServerPage(event, { mainWindowOnly = false, quiet = false } = {}) {
  const ok = isTrustedFrame(event.senderFrame, SERVER_ORIGIN) && (!mainWindowOnly || isMainWindowSender(event));
  if (!ok && !quiet) log(`IPC rejected from ${frameUrl(event.senderFrame).slice(0, 200) || 'unknown frame'}`);
  return ok;
}

function isMainWindowFrame(frame) {
  if (!mainWindow || mainWindow.isDestroyed() || !frame) return false;
  try {
    const top = mainWindow.webContents.mainFrame;
    return frame.processId === top.processId && frame.routingId === top.routingId && isTrustedFrame(frame, SERVER_ORIGIN);
  } catch {
    return false;
  }
}

// ── Страница «Нет связи с сервером» ─────────────────────────────────────────

const offline = { active: false, timer: null, checking: false };

function showOfflinePage(reason) {
  if (!mainWindow || mainWindow.isDestroyed() || app.isQuitting) return;
  offline.active = true;
  log(`offline page: ${reason}`);
  refreshTrayTooltip();

  // Загрузка из обработчика другой загрузки — только на следующем витке,
  // иначе Chromium может отменить обе.
  setImmediate(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow
      .loadFile(OFFLINE_PAGE, {
        query: { reason, server: SERVER_ORIGIN || SERVER_URL, retry: String(Math.round(HEALTH_RETRY_MS / 1000)) }
      })
      .catch((err) => log(`offline page load failed: ${err.message}`));
  });

  if (!offline.timer) offline.timer = setInterval(() => { pollServer(); }, HEALTH_RETRY_MS);
}

// Проверяет главный процесс, а не сама страница: сервер пускает запросы только
// со своего адреса (CORS), а страница без связи открыта из файла.
async function checkServerHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const url = new URL('/health', SERVER_URL);
    url.searchParams.set('t', String(Date.now()));
    const res = await net.fetch(url.toString(), { signal: controller.signal });
    return res.ok ? { ok: true } : { ok: false, error: describeHttpFailure(res.status, res.statusText) };
  } catch (err) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? `Сервер не ответил за ${Math.round(HEALTH_TIMEOUT_MS / 1000)} с`
        : `Сервер недоступен: ${err.message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pollServer() {
  if (!offline.active) return { ok: true };
  if (offline.checking) return { ok: false, error: 'Проверка уже идёт' };
  offline.checking = true;
  try {
    const result = await checkServerHealth();
    if (result.ok) {
      leaveOffline();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('offline-status', { error: result.error });
    }
    return result;
  } finally {
    offline.checking = false;
  }
}

function leaveOffline() {
  if (offline.timer) clearInterval(offline.timer);
  offline.timer = null;
  offline.active = false;
  refreshTrayTooltip();
  log('server is reachable again, reloading the app');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(SERVER_URL).catch((err) => log(`loadURL after recovery failed: ${err.message}`));
  }
}

function createMainWindow() {
  const iconIco = path.join(__dirname, '../../build/icon.ico');
  const iconPng = path.join(__dirname, '../../build/icon.png');
  const appIcon = fs.existsSync(iconIco) ? iconIco : (fs.existsSync(iconPng) ? iconPng : null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    // При автозапуске окно создаётся скрытым: страница грузится, соединение
    // устанавливается и уведомления приходят, но работа не перекрывается.
    show: !launchedAtLogin,
    frame: true, // Native Windows form frame
    title: 'MyChat Enterprise Client',
    backgroundColor: '#0b1017',
    // Omit the key entirely (not `icon: null`) when the file can't be found —
    // an explicit null blanks the taskbar icon instead of falling back to the
    // .exe's own embedded icon.
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  const win = mainWindow;
  hardenWebContents(win.webContents);

  // Electron refuses navigator.mediaDevices.getDisplayMedia() unless the main
  // process answers the request itself — without this the screen-sharing side
  // of remote desktop threw before WebRTC was ever reached.
  //
  // Экран отдаётся только внутри сеанса, который сотрудник подтвердил сам
  // (rd-session-start), и только странице сервера в главном окне. Раньше он
  // уходил молча на любой запрос — вместе со звуком системы, который
  // удалённому столу вовсе не нужен.
  win.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      const deny = (why) => {
        log(`getDisplayMedia denied: ${why}`);
        callback({});
      };
      if (!hostSession.allowsCapture) return deny('no accepted remote session');
      if (!isMainWindowFrame(request.frame)) return deny(`not the main window page (${frameUrl(request.frame).slice(0, 120)})`);

      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!hostSession.allowsCapture) return deny('session ended while screens were being listed');
          if (!sources.length) return deny('no screens');
          rememberSources(sources);
          // Отдаётся экран, выбранный оператором. Раньше всегда брался
          // первый: если сотрудник работает на втором мониторе, оператор
          // смотрел в пустой рабочий стол и не понимал, почему.
          const chosen = sources.find((s) => s.id === selectedScreenId) || sources[0];
          capturedScreen = { sourceId: chosen.id, displayId: chosen.display_id || null };
          callback({ video: chosen });
        })
        .catch((err) => {
          log(`getDisplayMedia source lookup failed: ${err.message}`);
          callback({});
        });
    },
    { useSystemPicker: false }
  );

  // Разрешения запрашивает страница, а решает главный процесс. Без явного
  // обработчика поведение зависит от версии Electron, и звонок мог падать с
  // невнятным отказом ещё до того, как система вообще спросит про микрофон.
  //
  // Список закрытый: разрешается ровно то, чем пользуется приложение. Всё
  // остальное — местоположение, уведомления браузера, датчики, midi — молча
  // отклоняется. Интерфейс приходит с сервера, то есть это удалённый код, и
  // раздавать ему разрешения «на всякий случай» нельзя. И только ему: странице
  // без связи или чужому адресу микрофон не положен.
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write']);

  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents?.getURL?.() || '';
    const allowed = ALLOWED_PERMISSIONS.has(permission) && isSameOrigin(requestingUrl, SERVER_ORIGIN);
    if (!allowed) log(`permission denied: ${permission} for ${String(requestingUrl).slice(0, 120)}`);
    callback(allowed);
  });

  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    ALLOWED_PERMISSIONS.has(permission) && (!requestingOrigin || isSameOrigin(requestingOrigin, SERVER_ORIGIN))
  );

  // Сервер недоступен — раньше окно оставалось белым навсегда.
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log(`did-fail-load: code ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`);
    if (shouldShowOfflineForFailure({ errorCode, isMainFrame, url: validatedURL, serverOrigin: SERVER_ORIGIN })) {
      showOfflinePage(describeLoadFailure(errorCode, errorDescription));
    }
  });
  // 502/503 на главную страницу загружается «успешно» — пустым окном.
  win.webContents.on('did-navigate', (event, url, httpResponseCode, httpStatusText) => {
    if (shouldShowOfflineForStatus({ url, httpResponseCode, serverOrigin: SERVER_ORIGIN })) {
      showOfflinePage(describeHttpFailure(httpResponseCode, httpStatusText));
    }
  });
  win.webContents.on('did-finish-load', () => {
    log('mainWindow did-finish-load successfully!');
  });

  // Перезагрузка или уход страницы на другой адрес: той страницы, что
  // включала управление, больше нет — управление выключается вместе с ней.
  win.webContents.on('did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
    const isMainFrame = details?.isMainFrame ?? legacyMainFrame;
    const isSameDocument = details?.isSameDocument ?? legacyInPlace;
    if (isMainFrame && !isSameDocument && (hostSession.active || remoteInput.enabled)) {
      endHostSession('page navigation or reload');
    }
  });

  win.webContents.on('render-process-gone', (event, details) => {
    log(`render-process-gone: ${details?.reason} (exit ${details?.exitCode})`);
    endHostSession('renderer gone');
    if (details?.reason !== 'clean-exit' && !app.isQuitting) {
      showOfflinePage('Окно приложения аварийно завершилось — перезапускаем, как только сервер ответит.');
    }
  });

  log(`Loading URL: ${SERVER_URL}`);
  // Отказ загрузки разбирает did-fail-load; здесь только не даём обещанию
  // упасть необработанным.
  win.loadURL(SERVER_URL).catch(() => {});

  // Handle minimize to tray on close
  win.on('close', (event) => {
    log('mainWindow close event fired. isQuitting: ' + app.isQuitting);
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
    return false;
  });

  win.on('hide', () => {
    syncIndicator();
    // Окно ушло в трей посреди сеанса — сотрудник должен понимать, что доступ
    // к экрану не закончился вместе с окном.
    if (hostSession.active && tray && process.platform === 'win32') {
      try {
        tray.displayBalloon({
          iconType: 'warning',
          title: 'Удалённый доступ продолжается',
          content: `${hostSession.indicatorText()}. Завершить можно на плашке вверху экрана.`
        });
      } catch {}
    }
  });
  win.on('show', syncIndicator);
  win.on('minimize', syncIndicator);
  win.on('restore', syncIndicator);

  win.on('focus', () => {
    log('mainWindow focus -> stop flashing');
    win.flashFrame(false);
    win.webContents.send('window-focus');
  });

  win.on('blur', () => {
    win.webContents.send('window-blur');
  });

  win.on('closed', () => {
    log('mainWindow closed event fired');
    endHostSession('main window closed');
    if (offline.timer) clearInterval(offline.timer);
    offline.timer = null;
    offline.active = false;
    if (mainWindow === win) mainWindow = null;
  });

  try {
    createTray();
    log('createTray completed');
  } catch (e) {
    log('createTray error: ' + e.stack);
  }
}

let currentTrayStatus = 'online';
let rendererTrayTooltip = null;

// Подсказка трея: идущий сеанс важнее всего, потом отсутствие связи, потом
// то, что попросила страница (например, число непрочитанных).
function refreshTrayTooltip() {
  if (!tray) return;
  let text = rendererTrayTooltip || 'MyChat Enterprise';
  if (offline.active) text = 'MyChat — нет связи с сервером';
  if (hostSession.active) text = `MyChat — ${hostSession.indicatorText()}`;
  tray.setToolTip(text.slice(0, 127));
}

function updateTrayMenu(status = 'online') {
  if (!tray) return;
  currentTrayStatus = status;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Открыть MyChat',
      click: () => showMainWindow()
    },
    ...(hostSession.active
      ? [{ type: 'separator' }, { label: 'Завершить удалённый доступ', click: () => stopFromIndicator('tray menu') }]
      : []),
    ...(isAutostartSupported(app)
      ? [
          { type: 'separator' },
          {
            label: 'Запускать при входе в Windows',
            type: 'checkbox',
            checked: autostartEnabled,
            click: (item) => setAutostart(item.checked)
          }
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Статус: В сети',
      type: 'radio',
      checked: status === 'online',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-status-change', 'online');
      }
    },
    {
      label: 'Статус: Отошел',
      type: 'radio',
      checked: status === 'away',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-status-change', 'away');
      }
    },
    {
      label: 'Статус: Не беспокоить',
      type: 'radio',
      checked: status === 'dnd',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-status-change', 'dnd');
      }
    },
    {
      label: 'Статус: Не в сети',
      type: 'radio',
      checked: status === 'offline',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-status-change', 'offline');
      }
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) return;

  const pngPath = path.join(__dirname, '../../build/icon.png');
  const icoPath = path.join(__dirname, '../../build/icon.ico');
  let icon = null;
  if (fs.existsSync(pngPath)) {
    icon = nativeImage.createFromPath(pngPath).resize({ width: 16, height: 16 });
  } else if (fs.existsSync(icoPath)) {
    icon = nativeImage.createFromPath(icoPath).resize({ width: 16, height: 16 });
  } else {
    const iconBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA0SURBVDhPY2AYBeMGTExM/oNoBgYGBnLNw6cZH2b8h1YkYvBhYIhhwDcwjAowjAowjAowMAAArWkHC0p41uMAAAAASUVORK5CYII=',
      'base64'
    );
    icon = nativeImage.createFromBuffer(iconBuffer);
  }

  tray = new Tray(icon);
  refreshTrayTooltip();

  updateTrayMenu(currentTrayStatus);

  // После автозапуска окно спрятано, и значок в трее — единственный путь к
  // нему. Двойного клика ждал не каждый: одного достаточно, как у мессенджеров.
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

let isCurrentlyIdle = false;
let presenceInterval = null;

function setupPowerAndPresenceMonitoring() {
  log('Setting up powerMonitor and automated presence state triggers...');

  powerMonitor.on('lock-screen', () => {
    log('powerMonitor: lock-screen detected -> triggering away');
    updateTrayMenu('away');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-monitor-event', { state: 'locked', status: 'away' });
    }
  });

  powerMonitor.on('unlock-screen', () => {
    log('powerMonitor: unlock-screen detected -> triggering online');
    isCurrentlyIdle = false;
    updateTrayMenu('online');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-monitor-event', { state: 'unlocked', status: 'online' });
    }
  });

  powerMonitor.on('suspend', () => {
    log('powerMonitor: suspend (sleep/hibernation) detected -> triggering offline');
    updateTrayMenu('offline');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-monitor-event', { state: 'suspend', status: 'offline' });
    }
  });

  powerMonitor.on('resume', () => {
    log('powerMonitor: resume from sleep detected -> triggering online');
    isCurrentlyIdle = false;
    updateTrayMenu('online');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-monitor-event', { state: 'resume', status: 'online' });
    }
  });

  // Automated Inactivity / Idle Polling
  // If no mouse or keyboard action for >= 300 seconds (5 min) -> transition to 'away'
  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(() => {
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      if (idleSeconds >= 300 && !isCurrentlyIdle) {
        isCurrentlyIdle = true;
        log(`powerMonitor: idle for ${idleSeconds}s -> transitioning to away`);
        updateTrayMenu('away');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('power-monitor-event', { state: 'idle', status: 'away', idleSeconds });
        }
      } else if (idleSeconds < 10 && isCurrentlyIdle) {
        isCurrentlyIdle = false;
        log(`powerMonitor: user resumed input (idle ${idleSeconds}s) -> transitioning to online`);
        updateTrayMenu('online');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('power-monitor-event', { state: 'active', status: 'online', idleSeconds });
        }
      }
    } catch (err) {
      log('Error during idle polling: ' + err.message);
    }
  }, 10000);
}

// ── IPC Handlers ──

// Remote Desktop: Open Separate Viewer Window
ipcMain.handle('open-remote-desktop-viewer', (event, { sessionId, targetUser } = {}) => {
  if (!isFromServerPage(event)) return false;
  if (typeof sessionId !== 'string' || !sessionId || !targetUser || targetUser.id === undefined) return false;

  if (viewerWindows.has(sessionId)) {
    const existing = viewerWindows.get(sessionId);
    existing.show();
    existing.focus();
    return true;
  }

  const viewer = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: true,
    title: `Удаленный рабочий стол: ${String(targetUser.full_name || '')} (${String(targetUser.job_title || 'Сотрудник')}) [Сессия: ${sessionId}]`,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  hardenWebContents(viewer.webContents);

  viewerWindows.set(sessionId, viewer);

  const viewerUrl = new URL(SERVER_URL);
  viewerUrl.searchParams.set('view', 'remote-desktop-viewer');
  viewerUrl.searchParams.set('sessionId', sessionId);
  viewerUrl.searchParams.set('targetId', String(targetUser.id));
  viewer.loadURL(viewerUrl.toString()).catch((err) => log(`viewer load failed: ${err.message}`));

  viewer.on('closed', () => {
    viewerWindows.delete(sessionId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rd-viewer-closed', { sessionId });
    }
  });

  return true;
});

// Сотрудник подтвердил сеанс. С этого момента и до rd-session-end главный
// процесс отдаёт экран и (при полном доступе) соглашается включить ввод.
ipcMain.handle('rd-session-start', (event, info) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return false;
  const { sessionId, operatorName, accessLevel } = info || {};
  if (hostSession.active && hostSession.sessionId !== sessionId) {
    disableInput('replaced by a new session');
  }
  if (!hostSession.start({ sessionId, operatorName, accessLevel })) return false;
  selectedScreenId = null;
  capturedScreen = null;
  log(`remote session started: ${hostSession.sessionId} (${hostSession.accessLevel})`);
  onHostSessionChanged();
  return true;
});

// Завершить сеанс ничем не опасно, поэтому достаточно, что просит главное окно.
ipcMain.handle('rd-session-end', (event, info) => {
  if (!isMainWindowSender(event)) return false;
  const sessionId = info?.sessionId;
  if (hostSession.active && sessionId && sessionId !== hostSession.sessionId) return false;
  endHostSession('session ended by the page');
  return true;
});

ipcMain.handle('rd-list-screens', async (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return [];
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 240, height: 135 }
  });
  rememberSources(sources);
  return sources.map((s, index) => ({
    id: s.id,
    name: s.name || `Экран ${index + 1}`,
    thumbnail: s.thumbnail.toDataURL()
  }));
});

// Выбор монитора для следующего захвата. restore: подмена дорожки не
// удалась, оператор по-прежнему видит прежний экран — туда же и ввод.
ipcMain.handle('rd-select-screen', (event, screenId, options) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return false;
  if (!hostSession.active) return false;
  const previousScreenId = capturedScreen?.sourceId ?? null;
  selectedScreenId = typeof screenId === 'string' && screenId ? screenId : null;
  if (options?.restore && selectedScreenId) {
    capturedScreen = {
      sourceId: selectedScreenId,
      displayId: knownSources.has(selectedScreenId) ? knownSources.get(selectedScreenId) : capturedScreen?.displayId ?? null
    };
  }
  return { previousScreenId };
});

// Буфер обмена сеанса. Синхронизируется только пока сеанс идёт и только
// текстом: файлы и картинки через буфер — отдельная история с иными рисками.
ipcMain.handle('rd-clipboard-read', (event) => (isFromServerPage(event) ? clipboard.readText() : ''));
ipcMain.handle('rd-clipboard-write', (event, text) => {
  if (!isFromServerPage(event)) return false;
  clipboard.writeText(String(text ?? '').slice(0, 100000));
  return true;
});

// Panic key. The operator is driving this machine's mouse and keyboard, so the
// employee needs a way out that does not depend on aiming at a button. A
// global shortcut fires whatever window has focus.
const PANIC_ACCELERATOR = 'Control+Alt+Shift+S';

function disableInput(reason) {
  const wasEnabled = remoteInput.enabled;
  remoteInput.disable();
  if (app.isReady()) globalShortcut.unregister(PANIC_ACCELERATOR);
  if (wasEnabled) log(`remote control: input disabled (${reason})`);
}

// Управление обрывается здесь, а сеанс целиком закрывает страница: она
// держит захват экрана и сообщает оператору.
function releaseControl(reason) {
  disableInput(reason);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rd-input-revoked', { reason });
  }
}

function endHostSession(reason) {
  disableInput(reason);
  const hadSession = hostSession.end();
  selectedScreenId = null;
  capturedScreen = null;
  if (hadSession) {
    log(`remote session ended (${reason})`);
    onHostSessionChanged();
  }
}

function onHostSessionChanged() {
  syncIndicator();
  refreshTrayTooltip();
  updateTrayMenu(currentTrayStatus);
}

// «Завершить доступ» с плашки или из трея. Страница получает сигнал и
// завершает сеанс сама (останавливает захват, сообщает оператору). Если она
// не отозвалась — зависла или занята, — окно перезагружается: вместе со
// страницей обрываются и захват экрана, и соединение с сервером.
function stopFromIndicator(source) {
  const sessionId = hostSession.sessionId;
  if (!sessionId) return;
  log(`remote session: stop requested from ${source}`);
  releaseControl(source);
  setTimeout(() => {
    if (hostSession.sessionId !== sessionId) return;
    log('remote session: page did not end the session in time, reloading the window');
    endHostSession('stop request timed out');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  }, 4000);
}

ipcMain.handle('rd-input-enable', (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return { enabled: false, panicKeyArmed: false };
  if (!hostSession.allowsInput) {
    log('remote control: enable refused — no accepted full-access session');
    return { enabled: false, panicKeyArmed: false };
  }
  remoteInput.enable();
  globalShortcut.unregister(PANIC_ACCELERATOR);
  const registered = globalShortcut.register(PANIC_ACCELERATOR, () => {
    releaseControl('panic key');
  });
  log(`remote control: input enabled for this session (panic key ${registered ? 'armed' : 'UNAVAILABLE'})`);
  return { enabled: true, panicKeyArmed: registered };
});

// Выключить управление можно всегда — сверять тут нечего.
ipcMain.handle('rd-input-disable', (event) => {
  if (!isMainWindowSender(event)) return false;
  disableInput('session ended');
  return true;
});

ipcMain.on('rd-input-event', (event, payload) => {
  if (!remoteInput.enabled || !hostSession.allowsInput) return;
  // Событий много (десятки в секунду) — отказ не пишется в журнал.
  if (!isFromServerPage(event, { mainWindowOnly: true, quiet: true })) return;
  remoteInput.handle(payload);
});

// Файл, переданный оператором в ходе сеанса, кладётся в «Загрузки»
// сотрудника. Имя очищается от путей: строка вида "..\\..\\Windows\\x.dll"
// не должна уводить запись за пределы папки. Принимается только внутри
// сеанса с полным доступом.
const MAX_SAVED_FILE_BYTES = 12 * 1024 * 1024;

ipcMain.handle('rd-save-file', async (event, { fileName, data } = {}) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return { success: false, error: 'Недоверенный источник' };
  if (!hostSession.allowsInput) return { success: false, error: 'Нет активного сеанса с полным доступом' };
  if (!(Array.isArray(data) || data instanceof Uint8Array) || data.length > MAX_SAVED_FILE_BYTES) {
    return { success: false, error: 'Некорректный файл' };
  }
  try {
    const safeName = path.basename(String(fileName || 'файл')).replace(/[<>:"/\\|?*]/g, '_');
    const dir = app.getPath('downloads');
    let target = path.join(dir, safeName);

    // Не затираем то, что у человека уже лежит.
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    let n = 1;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${base} (${n++})${ext}`);
    }

    fs.writeFileSync(target, Buffer.from(data));
    log(`remote file received: ${target}`);

    new Notification({
      title: 'Получен файл',
      body: `${path.basename(target)} сохранён в папку «Загрузки»`
    }).show();

    return { success: true, path: target };
  } catch (err) {
    log(`rd-save-file failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ── Плашка «Ваш рабочий стол просматривает…» ────────────────────────────────
// Панель сеанса живёт внутри окна приложения. Окно свернули или закрыли в
// трей — и сотрудник переставал видеть, что к его экрану кто-то подключён.
// Пока окно не на виду, поверх всех окон висит небольшая плашка с кнопкой
// «Завершить доступ».

let indicatorWindow = null;

function closeIndicator() {
  const win = indicatorWindow;
  indicatorWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

function syncIndicator() {
  if (!app.isReady()) return;
  const mainHidden = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized();
  if (!hostSession.active || !mainHidden) {
    closeIndicator();
    return;
  }
  if (indicatorWindow && !indicatorWindow.isDestroyed()) {
    if (indicatorWindow.rdSessionId === hostSession.sessionId) return;
    closeIndicator();
  }

  try {
    const { workArea } = screen.getPrimaryDisplay();
    const width = 540;
    const height = 56;
    const win = new BrowserWindow({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: workArea.y + 12,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      show: false,
      backgroundColor: '#7f1d1d',
      webPreferences: {
        preload: INDICATOR_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.rdSessionId = hostSession.sessionId;
    win.setAlwaysOnTop(true, 'screen-saver');
    // В саму трансляцию плашка не попадает: закрывать ею часть экрана,
    // который смотрит оператор, незачем.
    try { win.setContentProtection(true); } catch {}
    hardenWebContents(win.webContents);
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    win.on('closed', () => { if (indicatorWindow === win) indicatorWindow = null; });
    win.loadFile(INDICATOR_PAGE, {
      query: { text: hostSession.indicatorText(), mode: hostSession.accessLevel || 'view_only' }
    }).catch((err) => log(`indicator load failed: ${err.message}`));
    indicatorWindow = win;
  } catch (err) {
    log(`indicator window failed: ${err.message}`);
  }
}

function isIndicatorSender(event) {
  return Boolean(indicatorWindow && !indicatorWindow.isDestroyed() && event.sender === indicatorWindow.webContents);
}

ipcMain.on('rd-indicator-stop', (event) => {
  if (!isIndicatorSender(event)) return;
  stopFromIndicator('indicator');
});

ipcMain.on('rd-indicator-open', (event) => {
  if (!isIndicatorSender(event)) return;
  showMainWindow();
});

ipcMain.handle('offline-retry', async (event) => {
  if (!isMainWindowSender(event) || !frameUrl(event.senderFrame).startsWith('file:')) return { ok: false };
  return pollServer();
});

// Never leave the machine controllable after the app goes away.
app.on('before-quit', () => {
  app.isQuitting = true;
  endHostSession('app quit');
});

// Remote Desktop: Get Screen Sources for local host sharing
ipcMain.handle('get-desktop-sources', async (event) => {
  if (!isFromServerPage(event)) return [];
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 }
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL()
  }));
});

// Floating Screen Corner Toast Window (sliding from bottom-right)
function showToastNotification(data) {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { workArea } = primaryDisplay;

    const width = 380;
    const height = 90;
    const marginX = 20;
    const marginY = 14;

    // Prune closed windows
    toastWindows = toastWindows.filter(w => !w.isDestroyed());

    // Max 3 toasts stacked
    if (toastWindows.length >= 3) {
      const oldest = toastWindows.shift();
      if (!oldest.isDestroyed()) oldest.close();
    }

    const index = toastWindows.length;
    const x = Math.round(workArea.x + workArea.width - width - marginX);
    const y = Math.round(workArea.y + workArea.height - (height + marginY) * (index + 1));

    const toastWin = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    toastWindows.push(toastWin);

    toastWin.loadFile(path.join(__dirname, 'toast.html'));

    toastWin.webContents.once('did-finish-load', () => {
      if (!toastWin.isDestroyed()) {
        toastWin.webContents.send('render-toast', data);
        toastWin.showInactive();
      }
    });

    toastWin.on('closed', () => {
      toastWindows = toastWindows.filter(w => w !== toastWin && !w.isDestroyed());
    });
  } catch (err) {
    console.error('Error showing toast notification window:', err);
  }
}

// Native Notification & Corner Toast Handler
ipcMain.handle('show-notification', (event, data) => {
  const { title, body, isUrgent } = data || {};

  // Flash taskbar icon if window is not focused
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }

  // Раньше здесь показывалось СВОЁ плавающее окно и вдобавок системное
  // уведомление Windows — две карточки на одно событие, одна поверх другой.
  // Оставлено системное: оно подчиняется настройкам уведомлений Windows,
  // попадает в центр уведомлений и не перекрывает чужие окна самовольно.
  if (Notification.isSupported()) {
    try {
      let notifIcon = null;
      try {
        const iconPath = path.join(__dirname, '../../build/icon.png');
        if (fs.existsSync(iconPath)) notifIcon = nativeImage.createFromPath(iconPath);
      } catch (_) {}

      const notifOptions = {
        title: title || 'Centras Chat',
        body: body || '',
        urgency: isUrgent ? 'critical' : 'normal',
        timeoutType: isUrgent ? 'never' : 'default'
      };
      if (notifIcon) notifOptions.icon = notifIcon;

      const notif = new Notification(notifOptions);
      notif.on('click', () => {
        if (mainWindow) {
          showMainWindow();
          mainWindow.webContents.send('toast-action', data);
        }
      });
      notif.show();
    } catch (e) {
      console.warn('Notification error:', e);
    }
  }
  return true;
});

// Toast Window IPC callbacks
ipcMain.on('toast-clicked', (event, toastData) => {
  if (mainWindow) {
    showMainWindow();
    mainWindow.webContents.send('toast-action', toastData);
  }
});

ipcMain.on('toast-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.close();
  }
});

ipcMain.handle('get-system-idle-time', () => {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch (e) {
    return 0;
  }
});


ipcMain.on('flash-frame', (event, flag) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(Boolean(flag));
  }
});

ipcMain.on('set-badge-count', (event, count) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBadgeCount(count || 0);
  }
});

ipcMain.on('set-tray-tooltip', (event, text) => {
  rendererTrayTooltip = typeof text === 'string' && text ? text : null;
  refreshTrayTooltip();
});

ipcMain.on('focus-window', () => {
  showMainWindow();
});

ipcMain.handle('get-device-info', () => {
  const os = require('node:os');
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    username: os.userInfo()?.username || 'user'
  };
});

ipcMain.on('sync-tray-status', (event, status) => {
  updateTrayMenu(status);
});

process.on('uncaughtException', (err) => {
  log('UncaughtException: ' + err.stack);
});

function setAutostart(enabled) {
  try {
    writePreference(app.getPath('userData'), enabled);
    autostartEnabled = applyAutostart(app, { enabled, log });
  } catch (err) {
    log('autostart change failed: ' + err.message);
  }
  updateTrayMenu(currentTrayStatus);
}

app.whenReady().then(() => {
  log('app.whenReady resolved! Calling createMainWindow...');
  try {
    launchedAtLogin = wasLaunchedAtLogin(process.argv, app.getLoginItemSettings?.({ args: ['--autostart'] }));
    autostartEnabled = applyAutostart(app, { enabled: resolveEnabled(app.getPath('userData')), log });
    log('launchedAtLogin: ' + launchedAtLogin);
  } catch (err) {
    log('autostart setup failed: ' + err.message);
  }
  try {
    createMainWindow();
    log('createMainWindow called successfully!');
    setupPowerAndPresenceMonitoring();
  } catch (err) {
    log('createMainWindow ERROR: ' + err.stack);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((err) => {
  log('app.whenReady rejected: ' + err.stack);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  log('window-all-closed event fired');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
