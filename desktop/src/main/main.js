const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, desktopCapturer, screen, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log(`did-fail-load: code ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    log('mainWindow did-finish-load successfully!');
  });

  // Load UI: in development or from built files or server
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const serverUrl = process.env.MYCHAT_SERVER_URL || 'http://localhost:2004';

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

  const viewerUrl = `${process.env.VITE_DEV_SERVER_URL || 'http://localhost:2004'}?view=remote-desktop-viewer&sessionId=${sessionId}&targetId=${targetUser.id}`;
  viewer.loadURL(viewerUrl);

  viewer.on('closed', () => {
    viewerWindows.delete(sessionId);
    if (mainWindow) {
      mainWindow.webContents.send('rd-viewer-closed', { sessionId });
    }
  });

  return true;
});

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

  // 1. Show floating popup window in corner of screen
  showToastNotification(data);

  // 2. Trigger native OS notification
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
