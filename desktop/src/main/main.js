const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, desktopCapturer, screen, powerMonitor, globalShortcut, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { RemoteInput } = require('./remote-input');

const logFile = path.join(__dirname, '../../electron_debug.log');
function log(msg) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

log('Electron main.js loaded. argv: ' + JSON.stringify(process.argv));

let mainWindow = null;
let tray = null;
let viewerWindows = new Map(); // sessionId -> BrowserWindow
let toastWindows = []; // Active corner toast notification windows

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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
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
    frame: true, // Native Windows form frame
    title: 'MyChat Enterprise Client',
    backgroundColor: '#ffffff',
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

  // Electron refuses navigator.mediaDevices.getDisplayMedia() unless the main
  // process answers the request itself — without this the screen-sharing side
  // of remote desktop threw before WebRTC was ever reached. The whole primary
  // screen is offered; the employee has already consented in the app by then.
  mainWindow.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) return callback({});
          // Отдаётся экран, выбранный оператором. Раньше всегда брался
          // первый: если сотрудник работает на втором мониторе, оператор
          // смотрел в пустой рабочий стол и не понимал, почему.
          const chosen = sources.find((s) => s.id === selectedScreenId) || sources[0];
          callback({ video: chosen, audio: 'loopback' });
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
  // раздавать ему разрешения «на всякий случай» нельзя.
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write']);

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) log(`permission denied: ${permission}`);
    callback(allowed);
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log(`did-fail-load: code ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    log('mainWindow did-finish-load successfully!');
  });

  // Load UI: in development or from built files or server
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const serverUrl = process.env.MYCHAT_SERVER_URL || 'https://chat-production-0456.up.railway.app';

  log(`Loading URL: ${devUrl || serverUrl}`);
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadURL(serverUrl);
  }

  // Handle minimize to tray on close
  mainWindow.on('close', (event) => {
    log('mainWindow close event fired. isQuitting: ' + app.isQuitting);
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.on('focus', () => {
    log('mainWindow focus -> stop flashing');
    mainWindow.flashFrame(false);
    mainWindow.webContents.send('window-focus');
  });

  mainWindow.on('blur', () => {
    mainWindow.webContents.send('window-blur');
  });

  mainWindow.on('closed', () => {
    log('mainWindow closed event fired');
    mainWindow = null;
  });

  try {
    createTray();
    log('createTray completed');
  } catch (e) {
    log('createTray error: ' + e.stack);
  }
}

let currentTrayStatus = 'online';

function updateTrayMenu(status = 'online') {
  if (!tray) return;
  currentTrayStatus = status;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Открыть MyChat',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
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
  tray.setToolTip('MyChat Enterprise');

  updateTrayMenu(currentTrayStatus);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
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
ipcMain.handle('open-remote-desktop-viewer', (event, { sessionId, targetUser }) => {
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
    title: `Удаленный рабочий стол: ${targetUser.full_name} (${targetUser.job_title || 'Сотрудник'}) [Сессия: ${sessionId}]`,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  viewerWindows.set(sessionId, viewer);

  const viewerUrl = `${process.env.VITE_DEV_SERVER_URL || 'https://chat-production-0456.up.railway.app'}?view=remote-desktop-viewer&sessionId=${sessionId}&targetId=${targetUser.id}`;
  viewer.loadURL(viewerUrl);

  viewer.on('closed', () => {
    viewerWindows.delete(sessionId);
    if (mainWindow) {
      mainWindow.webContents.send('rd-viewer-closed', { sessionId });
    }
  });

  return true;
});

// Remote control of this machine's mouse and keyboard, active ONLY while the
// employee has an accepted session with full access. The renderer enables it
// on consent and disables it the moment sharing stops, so an event arriving
// outside a session is dropped rather than acted on.
const remoteInput = new RemoteInput(log);

// Экран, который сейчас транслируется. Читается обработчиком getDisplayMedia
// выше при каждом новом захвате — так работает переключение монитора.
let selectedScreenId = null;

ipcMain.handle('rd-list-screens', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 240, height: 135 }
  });
  return sources.map((s, index) => ({
    id: s.id,
    name: s.name || `Экран ${index + 1}`,
    thumbnail: s.thumbnail.toDataURL()
  }));
});

ipcMain.handle('rd-select-screen', (event, screenId) => {
  selectedScreenId = screenId || null;
  return true;
});

// Буфер обмена сеанса. Синхронизируется только пока сеанс идёт и только
// текстом: файлы и картинки через буфер — отдельная история с иными рисками.
ipcMain.handle('rd-clipboard-read', () => clipboard.readText());
ipcMain.handle('rd-clipboard-write', (event, text) => {
  clipboard.writeText(String(text ?? '').slice(0, 100000));
  return true;
});

// Panic key. The operator is driving this machine's mouse and keyboard, so the
// employee needs a way out that does not depend on aiming at a button. A
// global shortcut fires whatever window has focus.
const PANIC_ACCELERATOR = 'Control+Alt+Shift+S';

function releaseControl(reason) {
  remoteInput.disable();
  globalShortcut.unregister(PANIC_ACCELERATOR);
  log(`remote control: input disabled (${reason})`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rd-input-revoked', { reason });
  }
}

ipcMain.handle('rd-input-enable', () => {
  remoteInput.enable();
  const registered = globalShortcut.register(PANIC_ACCELERATOR, () => {
    releaseControl('panic key');
  });
  log(`remote control: input enabled for this session (panic key ${registered ? 'armed' : 'UNAVAILABLE'})`);
  return { panicKeyArmed: registered };
});

ipcMain.handle('rd-input-disable', () => {
  releaseControl('session ended');
  return true;
});

ipcMain.on('rd-input-event', (event, payload) => {
  remoteInput.handle(payload);
});

// Файл, переданный оператором в ходе сеанса, кладётся в «Загрузки»
// сотрудника. Имя очищается от путей: строка вида "..\\..\\Windows\\x.dll"
// не должна уводить запись за пределы папки.
ipcMain.handle('rd-save-file', async (event, { fileName, data }) => {
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

// Never leave the machine controllable after the app goes away.
app.on('before-quit', () => remoteInput.disable());

// Remote Desktop: Get Screen Sources for local host sharing
ipcMain.handle('get-desktop-sources', async () => {
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
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
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
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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
  if (tray) {
    tray.setToolTip(text || 'OpenMyChat Enterprise');
  }
});

ipcMain.on('focus-window', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
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

app.whenReady().then(() => {
  log('app.whenReady resolved! Calling createMainWindow...');
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

app.on('window-all-closed', () => {
  log('window-all-closed event fired');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
