const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, desktopCapturer, screen, powerMonitor, globalShortcut, clipboard, shell, net, dialog, session } = require('electron');
const path = require('node:path');
const { pinUserData, userDataPath } = require('./app-paths');

// Профиль — в прежней папке %APPDATA%\mychat-desktop, что бы ни стояло в
// productName (см. app-paths.js). Раньше всего остального: журнал, сессии,
// автозапуск и блокировка единственного экземпляра берут путь отсюда.
pinUserData(app);

const fs = require('node:fs');
const crypto = require('node:crypto');
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

const { decidePermissionRequest, decidePermissionCheck } = require('./permissions');
const { isWindowAway, presenceSignal } = require('./window-presence');
const { isInsecureRequestBlocked } = require('./server-url');
const { readClientConfig, resolveEffectiveServerUrl, resolveSystemDirs } = require('./client-config');
const { verifyInstaller } = require('./update-verify');
const { detectInstallKind, updateCapability, isUpdaterRequestAllowed } = require('./update-policy');
const { UpdateController } = require('./updater');
const { planReceivedFileName, zoneIdentifierContent, formatFileSize } = require('./received-file');
const { safeDownloadName, isDangerousExtension } = require('./download-guard');
const {
  buildConsentDialog,
  resolveConsent,
  policyPaths,
  readRdPolicy,
  policyDecline,
  buildClipboardDialog,
  buildFileDialog
} = require('./rd-consent');
const { ClipboardGrants } = require('./clipboard-grants');

// Все окна — в песочнице Chromium. preload-скриптам из require нужен только
// 'electron', его песочница оставляет.
app.enableSandbox();

// Журнал — в папке журналов профиля. Раньше он писался рядом с исходниками:
// в собранном приложении — внутрь app.asar, то есть никуда, а в разработке —
// в рабочую копию репозитория.
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
let logFile = null;

function resolveLogFile() {
  if (logFile) return logFile;
  let dir;
  try { dir = app.getPath('logs'); } catch { dir = path.join(app.getPath('userData'), 'logs'); }
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'main.log');
  return logFile;
}

function log(msg) {
  try {
    const file = resolveLogFile();
    // Один предыдущий файл вместо бесконечного роста.
    try {
      if (fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, file + '.old');
    } catch {}
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

// Адреса пишутся в журнал без строки запроса и якоря: там бывают токены.
function redactUrl(url) {
  const text = String(url || '');
  const cut = text.search(/[?#]/);
  return (cut === -1 ? text : text.slice(0, cut) + '?…').slice(0, 200);
}

log(`Electron main.js loaded (packaged: ${app.isPackaged})`);

// Адрес сервера — один на всё приложение. Раньше главное окно и окно
// просмотра брали его из разных переменных и могли смотреть на разные серверы.
// От него же отсчитывается, какой странице доверять (см. security.js).
// В рабочей сборке переменные окружения не читаются, а http не принимается
// вовсе (см. server-url.js). Сервер в локальной сети задаёт ИТ политикой
// реестра HKLM\SOFTWARE\Policies\CentyChat (см. client-config.js);
// без неё — константа ниже. Файл client.json в ProgramData не читается:
// папку там может создать любой пользователь ПК.
const DEFAULT_SERVER_URL = 'https://centychat-production.up.railway.app';
// ProgramData и корень Windows в собранной сборке — из ядра и HKLM, а не из
// переменных окружения, которые сотрудник задаёт себе сам (см. client-config.js).
const SYSTEM_DIRS = resolveSystemDirs({ isPackaged: app.isPackaged, env: process.env });
for (const problem of SYSTEM_DIRS.problems) log(`system dirs: ${problem}`);
// Политика читается reg.exe из того же доверенного корня системы.
const clientConfig = readClientConfig({ systemRoot: SYSTEM_DIRS.systemRoot, isPackaged: app.isPackaged });
for (const problem of clientConfig.problems) log(`machine policy: ${problem}`);
const serverChoice = resolveEffectiveServerUrl({
  config: clientConfig,
  hardDefault: DEFAULT_SERVER_URL,
  isPackaged: app.isPackaged,
  env: process.env
});
if (serverChoice.ignored) log(`server URL from environment rejected: ${redactUrl(serverChoice.ignored)}`);
const SERVER_URL = serverChoice.url;
const SERVER_ORIGIN = originOf(SERVER_URL);
log(`server: ${SERVER_ORIGIN} (${serverChoice.source})`);

// Как установлено приложение — от этого зависит, может ли оно обновить себя
// само (см. update-policy.js).
const INSTALL_KIND = detectInstallKind({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  env: process.env,
  exists: (file) => fs.existsSync(file),
  programFiles: [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
});
log(`install kind: ${INSTALL_KIND}`);

const OFFLINE_PAGE = path.join(__dirname, 'offline.html');

function isDaytime(date = new Date()) {
  const h = date.getHours();
  return h >= 6 && h < 15;
}
const INDICATOR_PAGE = path.join(__dirname, 'rd-indicator.html');
const INDICATOR_PRELOAD = path.join(__dirname, 'rd-indicator-preload.js');

let mainWindow = null;

// Запущено ли приложение самой Windows при входе. Тогда окно не показывается —
// приложение подключается к серверу и ждёт в трее.
let launchedAtLogin = false;
let autostartEnabled = false;
let tray = null;
let viewerWindows = new Map(); // sessionId -> BrowserWindow

// ── Сеанс удалённого доступа к этой машине ──────────────────────────────────

// Что сотрудник подтвердил. Пока сеанса нет, экран не отдаётся и ввод не
// включается, что бы ни попросила страница.
// Функция объявлена ниже, но вызывается только при старте сеанса.
const hostSession = new HostSession({ isBlocked: () => isRemoteDesktopDisabledHere() });

// Согласия на общий буфер обмена (см. clipboard-grants.js).
const clipboardGrants = new ClipboardGrants();

// Системные окна сеанса, которые надо закрыть, если сеанс кончился раньше
// ответа: иначе «Сохранить» в забытом окне сработало бы уже без сеанса.
const sessionDialogs = new Set(); // AbortController

function abortSessionDialogs() {
  for (const controller of sessionDialogs) controller.abort();
  sessionDialogs.clear();
}

// Системное окно поверх главного, если оно на виду; иначе — само по себе:
// модальное к скрытому окну сотрудник бы просто не увидел.
async function askUser(options, { signal, bringToFront = false } = {}) {
  if (bringToFront) showMainWindow();
  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
  const parent = visible ? mainWindow : null;
  if (parent && !parent.isFocused()) parent.flashFrame(true);
  const opts = signal ? { ...options, signal } : options;
  const result = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return result.response;
}

// Запрет полного доступа на этом ПК (см. rd-consent.js). Читается на каждый
// запрос: политику можно разложить, не перезапуская приложение.
function readRdPolicyHere() {
  return readRdPolicy({
    env: process.env,
    // Доверенная ProgramData (из HKLM, а не из окружения): подменой переменной
    // запрет удалённого доступа от ИТ снимался бы.
    paths: policyPaths({ programData: SYSTEM_DIRS.programData, userData: app.getPath('userData') }),
    readFile: (file) => fs.readFileSync(file, 'utf8')
  });
}

function isFullAccessDisabledHere() {
  return readRdPolicyHere().fullAccessDisabled;
}

// Полный запрет удалённого доступа к этому ПК (MYCHAT_RD_DISABLE /
// disableRemoteDesktop). Тоже читается на каждый запрос.
function isRemoteDesktopDisabledHere() {
  return readRdPolicyHere().remoteDesktopDisabled;
}

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
// AppUserModelId совпадает с appId сборки и после переименования в CentyChat
// остаётся прежним: к нему привязаны ярлыки (NSIS ставит его в .lnk),
// уведомления Windows и их настройки, закрепление на панели задач и имя
// значения автозапуска в HKCU\...\Run (см. build/installer.nsh). Не менять.
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
  // Собранная сборка показывает страницу сервера — чужой код. DevTools на
  // ней облегчают снятие токена с общего компьютера, а меню — единственный
  // способ их открыть с клавиатуры (F12 / Ctrl+Shift+I) без пункта меню
  // вовсе. В разработке всё это не трогается: инструменты разработчика
  // нужны.
  if (app.isPackaged) {
    contents.on('devtools-opened', () => {
      log('DevTools closed: forbidden in a packaged build');
      contents.closeDevTools();
    });
    contents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      const isF12 = key === 'f12';
      const isCtrlShiftI = input.control && input.shift && key === 'i';
      if (isF12 || isCtrlShiftI) event.preventDefault();
    });
  }

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
    log(`navigation blocked: ${redactUrl(url)}`);
    if (isExternalLink(url)) {
      shell.openExternal(url).catch((err) => log(`openExternal failed: ${err.message}`));
    }
  });

  // Перенаправление с сервера на чужой адрес (или ответ посредника в сети)
  // увело бы окно вместе с preload туда же — will-navigate его не видит.
  contents.on('will-redirect', (event, legacyUrl) => {
    const url = event?.url || legacyUrl;
    if (isSameOrigin(url, SERVER_ORIGIN)) return;
    event.preventDefault();
    log(`redirect blocked: ${redactUrl(url)}`);
  });

  // Встроенные кадры: главный разбирает will-navigate выше, остальным —
  // только свой сервер или пустая страница.
  contents.on('will-frame-navigate', (event) => {
    if (event?.isMainFrame) return;
    const url = String(event?.url || '');
    if (isSameOrigin(url, SERVER_ORIGIN) || url === 'about:blank' || url === 'about:srcdoc') return;
    event.preventDefault();
    log(`frame navigation blocked: ${redactUrl(url)}`);
  });

  // Согласие оператора на буфер обмена живёт не дольше страницы, которая
  // его получила.
  const contentsId = contents.id;
  contents.on('did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
    const isMainFrame = details?.isMainFrame ?? legacyMainFrame;
    const isSameDocument = details?.isSameDocument ?? legacyInPlace;
    if (isMainFrame && !isSameDocument) clipboardGrants.forgetWebContents(contentsId);
  });
  contents.once('destroyed', () => clipboardGrants.forgetWebContents(contentsId));
}

function isMainWindowSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

// Чувствительные каналы принимаются только от верхнего кадра страницы сервера
// (а часть — только из главного окна). Страница без связи, окно-индикатор или
// iframe внутри страницы до них не дотягиваются.
function isFromServerPage(event, { mainWindowOnly = false, quiet = false } = {}) {
  const ok = isTrustedFrame(event.senderFrame, SERVER_ORIGIN) && (!mainWindowOnly || isMainWindowSender(event));
  if (!ok && !quiet) log(`IPC rejected from ${redactUrl(frameUrl(event.senderFrame)) || 'unknown frame'}`);
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
    // В разработке системное меню (File/Edit/View/Window) оставлено ради DevTools,
    // но дублировало собственную строку меню приложения: скрыто, Alt показывает.
    autoHideMenuBar: !app.isPackaged,
    title: 'CentyChat',
    // Фон до загрузки интерфейса — в цвет темы по часам, чтобы утром окно
    // не вспыхивало тёмным (см. renderer lib/theme.mjs).
    backgroundColor: isDaytime() ? '#fbfbfc' : '#26282c',
    // Omit the key entirely (not `icon: null`) when the file can't be found —
    // an explicit null blanks the taskbar icon instead of falling back to the
    // .exe's own embedded icon.
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  const win = mainWindow;
  hardenWebContents(win.webContents);
  // Масштаб Ctrl +/−/0 — в preload.js, после страницы: здесь, в
  // before-input-event, он отнимал бы эти сочетания у просмотра удалённого
  // стола.

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
      if (isRemoteDesktopDisabledHere()) return deny('remote desktop disabled by policy');
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
  //
  // `media` — только микрофон: камера и снятие экрана через getUserMedia
  // (chromeMediaSource: 'desktop') отклоняются. Экран отдаётся лишь через
  // getDisplayMedia внутри подтверждённого сеанса (обработчик выше).
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents?.getURL?.() || '';
    const allowed = decidePermissionRequest({
      permission,
      mediaTypes: details?.mediaTypes,
      requestingUrl,
      serverOrigin: SERVER_ORIGIN
    });
    if (!allowed) {
      const media = Array.isArray(details?.mediaTypes) ? ` [${details.mediaTypes.join(',')}]` : '';
      log(`permission denied: ${permission}${media} for ${redactUrl(requestingUrl)}`);
    }
    callback(allowed);
  });

  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    decidePermissionCheck({
      permission,
      mediaType: details?.mediaType,
      requestingOrigin,
      serverOrigin: SERVER_ORIGIN
    })
  );

  // Сервер недоступен — раньше окно оставалось белым навсегда.
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log(`did-fail-load: code ${errorCode}, desc: ${errorDescription}, url: ${redactUrl(validatedURL)}`);
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
    // Запуск при входе в Windows — окно сразу в трее: странице, которая
    // считает себя «в сети», сообщаем настоящее состояние.
    if (isWindowAway(win)) sendWindowPresence('hidden-at-load');
  });

  // Перезагрузка или уход страницы на другой адрес: той страницы, что
  // включала управление, больше нет — управление выключается вместе с ней.
  win.webContents.on('did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
    const isMainFrame = details?.isMainFrame ?? legacyMainFrame;
    const isSameDocument = details?.isSameDocument ?? legacyInPlace;
    if (isMainFrame && !isSameDocument) {
      // Окно согласия от прежней страницы больше не к кому относить.
      consentDialog?.controller.abort();
      if (hostSession.active || remoteInput.enabled) endHostSession('page navigation or reload');
    }
  });

  win.webContents.on('render-process-gone', (event, details) => {
    log(`render-process-gone: ${details?.reason} (exit ${details?.exitCode})`);
    consentDialog?.controller.abort();
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
    sendWindowPresence('hidden');
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
  win.on('show', () => { syncIndicator(); sendWindowPresence('shown'); });
  // Свёрнутое окно или окно в трее — сотрудник «отошёл» (multi-device.md §2).
  win.on('minimize', () => { syncIndicator(); sendWindowPresence('minimized'); });
  win.on('restore', () => { syncIndicator(); sendWindowPresence('restored'); });

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
  let text = rendererTrayTooltip || 'CentyChat';
  if (offline.active) text = 'CentyChat — нет связи с сервером';
  if (hostSession.active) text = `CentyChat — ${hostSession.indicatorText()}`;
  tray.setToolTip(text.slice(0, 127));
}

const TRAY_STATUS_LABELS = { online: 'в сети', away: 'отошёл', offline: 'не в сети' };
// Последний статус от системы — чтобы при «Не беспокоить» было видно, что под ним.
let trayPresence = 'online';

function updateTrayMenu(status = 'online') {
  if (!tray) return;
  currentTrayStatus = status;
  if (status !== 'dnd') trayPresence = status;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Открыть CentyChat',
      click: () => showMainWindow()
    },
    ...updateTrayItems(),
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
    // Статус выставляет система — здесь он только виден. Вручную меняется
    // лишь «Не беспокоить».
    {
      label: `Статус: ${TRAY_STATUS_LABELS[status === 'dnd' ? trayPresence : status] || 'В сети'}${status === 'dnd' ? ' · не беспокоить' : ''}`,
      enabled: false
    },
    {
      label: 'Не беспокоить',
      type: 'checkbox',
      checked: status === 'dnd',
      click: (item) => {
        if (mainWindow) mainWindow.webContents.send('tray-status-change', item.checked ? 'dnd-on' : 'dnd-off');
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

// ── Автообновление ─────────────────────────────────────────────────────────
// Вся логика — в updater.js; здесь только Electron: сеть, окна, трей, IPC.

let updateController = null;
let updaterSession = null;

// Источник обновлений — сервер приложения, и только по https.
const UPDATE_ORIGIN = SERVER_ORIGIN && SERVER_ORIGIN.startsWith('https://') ? SERVER_ORIGIN : null;

// electron-updater ходит в сеть через собственный раздел «electron-updater»
// без кэша (electronHttpExecutor.getNetSession). Фильтр
// defaultSession его не касается, поэтому здесь свой: только https и только
// сервер обновлений — ни перенаправление, ни адрес из latest.yml не уведут
// скачивание установщика на чужой сервер.
function installUpdaterSessionGuard() {
  const ses = session.fromPartition('electron-updater', { cache: false });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isUpdaterRequestAllowed(details.url, UPDATE_ORIGIN);
    if (!allowed) log(`updater request blocked: ${redactUrl(details.url)}`);
    callback({ cancel: !allowed });
  });
  return ses;
}

const POLICY_MAX_BYTES = 64 * 1024;

// policy.json — через тот же раздел и тот же фильтр, что и сам updater.
async function fetchUpdateJson(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const ses = updaterSession;
  if (!ses) throw new Error('updater session guard is missing');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await ses.fetch(url, { headers, signal: controller.signal });
    if (res.status !== 200) return { status: res.status, body: null };
    const text = await res.text();
    if (text.length > POLICY_MAX_BYTES) return { status: res.status, body: null };
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function showUpdateNotification({ title, body }) {
  if (!Notification.isSupported()) return;
  const notif = new Notification({ title: String(title).slice(0, 200), body: String(body).slice(0, 1000) });
  notif.on('click', () => showMainWindow());
  notif.show();
}

function blankUpdateState() {
  return {
    status: 'unsupported',
    currentVersion: app.getVersion(),
    offeredVersion: null,
    progress: null,
    mandatory: false,
    message: null,
    kind: INSTALL_KIND,
    error: null,
    downloadUrl: null
  };
}

function currentUpdateState() {
  return updateController ? updateController.getState() : blankUpdateState();
}

function installUpdateFromTray() {
  if (!updateController) return;
  updateController
    .installNow()
    .then((result) => {
      if (result.ok) return;
      if (result.reason === 'remote-session') {
        showUpdateNotification({
          title: 'Обновление отложено',
          body: 'Во время удалённого доступа приложение не перезапускается. Завершите сеанс и повторите.'
        });
      } else if (result.reason !== 'busy') {
        showUpdateNotification({ title: 'Обновление не установлено', body: 'Установщик не прошёл проверку или не запустился — сообщите в ИТ.' });
      }
    })
    .catch((err) => log(`install from tray failed: ${err.message}`));
}

function checkUpdatesFromTray() {
  if (!updateController) return;
  updateController
    .checkNow({ userInitiated: true })
    .then((result) => {
      const s = result.state || currentUpdateState();
      if (result.reason === 'rate-limited') {
        showUpdateNotification({ title: 'Проверка обновлений', body: 'Проверка уже была меньше минуты назад.' });
      } else if (s.status === 'idle') {
        showUpdateNotification({ title: 'Проверка обновлений', body: `Установлена последняя доступная версия (${s.currentVersion}).` });
      } else if (s.status === 'error') {
        showUpdateNotification({ title: 'Проверка обновлений', body: 'Не удалось проверить обновления — повторим позже.' });
      }
    })
    .catch((err) => log(`manual update check failed: ${err.message}`));
}

function updateTrayItems() {
  if (!updateController) return [];
  const s = updateController.getState();
  const items = [];
  if (s.status === 'downloaded') {
    items.push({ label: `Перезапустить и обновить до ${s.offeredVersion}`, click: () => installUpdateFromTray() });
  } else if (s.status === 'available' && s.downloadUrl) {
    items.push({ label: `Скачать версию ${s.offeredVersion}`, click: () => updateController.openDownload() });
  }
  if (updateController.canCheck() && s.status !== 'downloaded') {
    items.push({
      label: 'Проверить обновления',
      enabled: s.status !== 'checking' && s.status !== 'downloading',
      click: () => checkUpdatesFromTray()
    });
  }
  return items.length ? [{ type: 'separator' }, ...items] : [];
}

// Создаётся после главного окна: уведомления и вопрос об обязательном
// обновлении должны быть к чему привязать.
function startUpdater() {
  if (updateController) return;
  try {
    const capability = updateCapability(INSTALL_KIND);
    let lastTrayKey = null;
    updateController = new UpdateController({
      // electron-updater нужен только установке, которая умеет обновлять
      // себя сама; остальным он лишь создал бы свой каталог и таймеры.
      autoUpdater: capability === 'auto' && clientConfig.updates.enabled ? require('electron-updater').autoUpdater : null,
      app,
      config: clientConfig,
      kind: INSTALL_KIND,
      serverOrigin: UPDATE_ORIGIN,
      log,
      notify: showUpdateNotification,
      sendToRenderer: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', state);
      },
      onStateChange: (state) => {
        // Прогресс скачивания приходит часто — меню трея пересобирается
        // только при смене состояния.
        const key = `${state.status}|${state.offeredVersion}|${Boolean(state.downloadUrl)}`;
        if (key === lastTrayKey) return;
        lastTrayKey = key;
        updateTrayMenu(currentTrayStatus);
      },
      hostSession,
      fetchJson: fetchUpdateJson,
      // В папке профиля, закреплённой в app-paths.js, — рядом с остальными
      // данными сотрудника.
      statePath: path.join(userDataPath(app.getPath('appData')), 'update-state.json'),
      readFile: (file) => fs.readFileSync(file, 'utf8'),
      writeFile: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      },
      readAppUpdateYml: () => fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'),
      verify: (file, options) => verifyInstaller(file, { ...options, systemRoot: SYSTEM_DIRS.systemRoot }),
      openExternal: (url) => {
        shell.openExternal(url).catch((err) => log(`openExternal failed: ${err.message}`));
      },
      confirmMandatory: ({ version, signal }) =>
        askUser(
          {
            type: 'warning',
            title: 'Обязательное обновление',
            message: `Обязательное обновление до версии ${version}. Перезапуск через 5 минут.`,
            detail: 'Сохраните начатое сообщение. Приложение закроется, обновится и откроется снова.',
            buttons: ['Перезапустить сейчас', 'Через 5 минут'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            normalizeAccessKeys: false
          },
          { signal, bringToFront: true }
        ).then((response) => (response === 0 ? 'now' : 'later'))
    });
    updateController.start();
  } catch (err) {
    log('updater start failed: ' + (err.stack || err.message));
  }
}

// Сигнал системы меняет строку статуса в трее, но не снимает «Не беспокоить».
function setTrayPresence(state) {
  trayPresence = state;
  updateTrayMenu(currentTrayStatus === 'dnd' ? 'dnd' : state);
}

let isCurrentlyIdle = false;
let isScreenLocked = false;
let presenceInterval = null;

// Итог сигналов компьютера: окно, простой, блокировка экрана. Возврат
// (разблокировка, пробуждение, ввод после простоя) при свёрнутом окне не
// делает сотрудника «в сети».
function currentPresence() {
  return presenceSignal({ windowAway: isWindowAway(mainWindow), idle: isCurrentlyIdle, locked: isScreenLocked });
}

function sendWindowPresence(reason) {
  const status = currentPresence();
  setTrayPresence(status);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('power-monitor-event', { state: reason, status });
  }
}

function setupPowerAndPresenceMonitoring() {
  log('Setting up powerMonitor and automated presence state triggers...');

  powerMonitor.on('lock-screen', () => {
    log('powerMonitor: lock-screen detected -> triggering away');
    isScreenLocked = true;
    setTrayPresence('away');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-monitor-event', { state: 'locked', status: 'away' });
    }
  });

  powerMonitor.on('unlock-screen', () => {
    log('powerMonitor: unlock-screen detected -> triggering online');
    isCurrentlyIdle = false;
    isScreenLocked = false;
    sendWindowPresence('unlocked');
  });

  powerMonitor.on('suspend', () => {
    log('powerMonitor: suspend (sleep/hibernation) detected -> triggering offline');
    setTrayPresence('offline');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-monitor-event', { state: 'suspend', status: 'offline' });
    }
  });

  powerMonitor.on('resume', () => {
    log('powerMonitor: resume from sleep detected -> triggering online');
    isCurrentlyIdle = false;
    sendWindowPresence('resume');
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
        setTrayPresence('away');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('power-monitor-event', { state: 'idle', status: 'away', idleSeconds });
        }
      } else if (idleSeconds < 10 && isCurrentlyIdle) {
        isCurrentlyIdle = false;
        log(`powerMonitor: user resumed input (idle ${idleSeconds}s) -> transitioning to online`);
        const status = currentPresence();
        setTrayPresence(status);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('power-monitor-event', { state: 'active', status, idleSeconds });
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
      nodeIntegration: false,
      sandbox: true
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

// Страница просит начать сеанс. Решает не она: главный процесс сам
// показывает системное окно, и сеанс получает ровно тот уровень, который
// сотрудник выбрал в нём. accessLevel от страницы лишь ограничивает выбор —
// если в окне приложения выбран просмотр, полный доступ не предлагается.
//
// Ответ: { accepted, accessLevel } — страница сообщает серверу именно его.
let consentDialog = null; // { sessionId, controller }

ipcMain.handle('rd-session-start', async (event, info) => {
  const declined = (reason) => ({ accepted: false, accessLevel: null, reason });
  if (!isFromServerPage(event, { mainWindowOnly: true })) return declined('untrusted');
  const { sessionId, operatorName, accessLevel } = info || {};
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) return declined('invalid');

  // Политика ПК запрещает удалённый доступ: отказ сразу, без окна. Идущий
  // сеанс (политику разложили посреди него) тоже обрывается.
  const policyAnswer = policyDecline(readRdPolicyHere());
  if (policyAnswer) {
    if (hostSession.active) endHostSession('remote desktop disabled by policy');
    log(`remote session declined by policy: ${sessionId}`);
    return policyAnswer;
  }

  // Повторный вызов для уже подтверждённого сеанса ничего не расширяет.
  if (hostSession.active && hostSession.sessionId === sessionId) {
    return { accepted: true, accessLevel: hostSession.accessLevel };
  }
  // Второе окно поверх открытого — путь к тому, чтобы сотрудник нажал не туда.
  if (consentDialog) return declined('busy');

  const fullAccessDisabled = isFullAccessDisabledHere();
  const { choices, options } = buildConsentDialog({
    operatorName: HostSession.cleanName(operatorName),
    requestedLevel: accessLevel === 'full' ? 'full' : 'view_only',
    fullAccessDisabled
  });

  const pending = { sessionId, controller: new AbortController() };
  consentDialog = pending;
  const page = mainWindow?.webContents;
  let response = null;
  try {
    response = await askUser(options, { signal: pending.controller.signal, bringToFront: true });
  } catch (err) {
    log(`consent dialog failed: ${err.message}`);
  } finally {
    if (consentDialog === pending) consentDialog = null;
  }

  if (pending.controller.signal.aborted) return declined('cancelled');
  // Пока окно было открыто, страница могла смениться.
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== page || !isMainWindowFrame(page.mainFrame)) {
    return declined('page changed');
  }

  const level = resolveConsent(choices, response, { fullAccessDisabled });
  if (!level) {
    log(`remote session declined in the consent dialog: ${sessionId}`);
    return declined('declined');
  }

  if (hostSession.active && hostSession.sessionId !== sessionId) {
    endHostSession('replaced by a new session');
  }
  if (!hostSession.start({ sessionId, operatorName, accessLevel: level })) return declined('invalid');
  selectedScreenId = null;
  capturedScreen = null;
  log(`remote session started: ${hostSession.sessionId} (${hostSession.accessLevel}, consented in the system dialog)`);
  onHostSessionChanged();
  return { accepted: true, accessLevel: hostSession.accessLevel };
});

// Завершить сеанс ничем не опасно, поэтому достаточно, что просит главное окно.
ipcMain.handle('rd-session-end', (event, info) => {
  if (!isMainWindowSender(event)) return false;
  const sessionId = info?.sessionId;
  // Оператор отменил запрос, пока окно согласия ещё открыто.
  if (consentDialog && (!sessionId || consentDialog.sessionId === sessionId)) consentDialog.controller.abort();
  if (hostSession.active && sessionId && sessionId !== hostSession.sessionId) return false;
  endHostSession('session ended by the page');
  return true;
});

// Миниатюры экранов — только внутри идущего сеанса.
ipcMain.handle('rd-list-screens', async (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return [];
  if (!hostSession.active || isRemoteDesktopDisabledHere()) return [];
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
//
// Раньше чтение отдавалось странице в любой момент. Теперь нужна отметка
// согласия, которую ставит главный процесс после системного окна
// (rd-clipboard-grant):
//  - role 'host' — сотрудник: идущий сеанс с полным доступом, главное окно;
//  - role 'operator' — тот, кто подключился: согласие привязано к окну и
//    сеансу и снимается вместе со страницей.
function clipboardAllowed(event, opts) {
  const role = opts?.role === 'operator' ? 'operator' : 'host';
  const sessionId = opts?.sessionId;
  if (role === 'operator') {
    return isFromServerPage(event, { quiet: true }) && clipboardGrants.operatorAllowed(event.sender.id, sessionId);
  }
  return isFromServerPage(event, { mainWindowOnly: true, quiet: true }) && clipboardGrants.hostAllowed(hostSession, sessionId);
}

// Опрос идёт раз в секунду — отказы не пишутся в журнал.
ipcMain.handle('rd-clipboard-read', (event, opts) => (clipboardAllowed(event, opts) ? clipboard.readText() : null));

ipcMain.handle('rd-clipboard-write', (event, text, opts) => {
  if (!clipboardAllowed(event, opts)) return false;
  clipboard.writeText(String(text ?? '').slice(0, 100000));
  return true;
});

let clipboardDialogOpen = false;

ipcMain.handle('rd-clipboard-grant', async (event, opts) => {
  const role = opts?.role === 'operator' ? 'operator' : 'host';
  const sessionId = opts?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return false;

  if (role === 'host') {
    if (!isFromServerPage(event, { mainWindowOnly: true })) return false;
    if (!clipboardGrants.canAskHost(hostSession, sessionId)) return false;
    if (clipboardGrants.hostAllowed(hostSession, sessionId)) return true;
  } else {
    if (!isFromServerPage(event)) return false;
    if (clipboardGrants.operatorAllowed(event.sender.id, sessionId)) return true;
  }
  if (clipboardDialogOpen) return false;

  const controller = new AbortController();
  if (role === 'host') sessionDialogs.add(controller);
  clipboardDialogOpen = true;
  let response = 1;
  try {
    const options = buildClipboardDialog({
      role,
      peerName: role === 'host' ? hostSession.operatorName : (opts?.peerName ? HostSession.cleanName(opts.peerName) : '')
    });
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (role === 'operator' && owner && owner !== mainWindow && !owner.isDestroyed()) {
      response = (await dialog.showMessageBox(owner, { ...options, signal: controller.signal })).response;
    } else {
      response = await askUser(options, { signal: controller.signal });
    }
  } catch (err) {
    log(`clipboard consent dialog failed: ${err.message}`);
  } finally {
    clipboardDialogOpen = false;
    sessionDialogs.delete(controller);
  }
  if (controller.signal.aborted || response !== 0) return false;

  if (role === 'host') {
    // Сеанс мог закончиться или смениться, пока окно было открыто.
    if (!clipboardGrants.canAskHost(hostSession, sessionId)) return false;
    clipboardGrants.grantHost(sessionId);
    log(`remote session ${sessionId}: shared clipboard allowed by the employee`);
    return true;
  }
  if (event.sender.isDestroyed()) return false;
  clipboardGrants.grantOperator(event.sender.id, sessionId);
  log(`remote session ${sessionId}: operator allowed sending own clipboard`);
  return true;
});

// Выключить общий буфер можно всегда.
ipcMain.handle('rd-clipboard-revoke', (event, opts) => {
  if (opts?.role === 'operator') {
    // Снять можно только своё согласие — оно привязано к окну-отправителю.
    if (!isFromServerPage(event, { quiet: true })) return false;
    return clipboardGrants.revokeOperator(event.sender.id, opts?.sessionId);
  }
  if (!isMainWindowSender(event)) return false;
  clipboardGrants.revokeHost();
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
  clipboardGrants.revokeHost();
  abortSessionDialogs();
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
  if (isRemoteDesktopDisabledHere()) {
    endHostSession('remote desktop disabled by policy');
    log('remote control: enable refused — remote desktop disabled by policy');
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
// сотрудника — только внутри сеанса с полным доступом и только после «Сохранить»
// в системном окне. Имя очищается (received-file.js): без путей, без
// зарезервированных имён Windows, исполняемые типы получают «.txt». На файл
// ставится пометка «из интернета» (Zone.Identifier), чтобы SmartScreen и
// Office проверили его при открытии. Раньше любой файл, включая .exe и .lnk,
// сохранялся молча и без пометки.
const MAX_SAVED_FILE_BYTES = 12 * 1024 * 1024;
let fileDialogOpen = false;

function writeZoneIdentifier(target) {
  if (process.platform !== 'win32') return;
  try {
    fs.writeFileSync(`${target}:Zone.Identifier`, zoneIdentifierContent(SERVER_ORIGIN || undefined));
  } catch (err) {
    // Не NTFS (флешка FAT32) — потока нет. Файл остаётся, но в журнале видно.
    log(`Zone.Identifier not written for ${path.basename(target)}: ${err.message}`);
  }
}

// Явный item.setSavePath() (см. will-download ниже) отключает штатное
// поведение Electron/Chrome, которое само добавляет « (1)», « (2)» к имени
// уже существующего файла в «Загрузках» — так что делаем это сами.
function uniqueDownloadPath(target) {
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return target;
}

ipcMain.handle('rd-save-file', async (event, { fileName, data } = {}) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return { success: false, error: 'Недоверенный источник' };
  if (!hostSession.allowsInput) return { success: false, error: 'Нет активного сеанса с полным доступом' };
  if (isRemoteDesktopDisabledHere()) return { success: false, error: 'Удалённый доступ к этому компьютеру запрещён политикой' };
  if (!(Array.isArray(data) || data instanceof Uint8Array) || data.length > MAX_SAVED_FILE_BYTES) {
    return { success: false, error: 'Некорректный файл' };
  }
  // По одному окну за раз: поток файлов не должен превращаться в поток окон,
  // в котором «Сохранить» нажимается не глядя.
  if (fileDialogOpen) return { success: false, error: 'Предыдущий файл ещё ждёт решения — файл отклонён' };

  const sessionId = hostSession.sessionId;
  const bytes = Buffer.from(data);
  const plan = planReceivedFileName(fileName);
  const controller = new AbortController();
  sessionDialogs.add(controller);
  fileDialogOpen = true;
  let response = 1;
  try {
    response = await askUser(
      buildFileDialog({
        operatorName: hostSession.operatorName,
        fileName: plan.name,
        original: plan.original,
        renamed: plan.renamed,
        sizeText: formatFileSize(bytes.length)
      }),
      { signal: controller.signal }
    );
  } catch (err) {
    log(`file consent dialog failed: ${err.message}`);
  } finally {
    fileDialogOpen = false;
    sessionDialogs.delete(controller);
  }

  if (controller.signal.aborted || response !== 0) {
    log(`remote file declined by the employee: ${plan.name} (${bytes.length} bytes)`);
    return { success: false, declined: true, error: 'Сотрудник отказался принять файл' };
  }
  if (!hostSession.allowsInput || hostSession.sessionId !== sessionId) {
    return { success: false, error: 'Сеанс завершён — файл не сохранён' };
  }

  try {
    const dir = app.getPath('downloads');
    const ext = path.extname(plan.name);
    const base = path.basename(plan.name, ext);
    let target = path.join(dir, plan.name);
    let n = 1;
    // Не затираем то, что у человека уже лежит: 'wx' отказывает, если файл
    // появился между проверкой и записью.
    for (;;) {
      try {
        fs.writeFileSync(target, bytes, { flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' || n > 999) throw err;
        target = path.join(dir, `${base} (${n++})${ext}`);
      }
    }
    writeZoneIdentifier(target);

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    log(`remote file received in session ${sessionId}: ${path.basename(target)}, ${bytes.length} bytes, sha256 ${sha256}${plan.renamed ? ' (executable type renamed)' : ''}`);

    new Notification({
      title: 'Получен файл',
      body: `${path.basename(target)} сохранён в папку «Загрузки»`
    }).show();

    return { success: true, path: target, renamed: plan.renamed, name: path.basename(target) };
  } catch (err) {
    log(`rd-save-file failed: ${err.message}`);
    return { success: false, error: 'Не удалось сохранить файл' };
  }
});

// ── Плашка «Ваш рабочий стол просматривает…» ────────────────────────────────
// Панель сеанса живёт внутри окна приложения, а оно приходит с сервера и
// может её не показать. Поэтому плашка главного процесса висит поверх всех
// окон на ВСЁ время сеанса — раньше она появлялась, только когда окно
// свернули или убрали в трей.

let indicatorWindow = null;

function closeIndicator() {
  const win = indicatorWindow;
  indicatorWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

function syncIndicator() {
  if (!app.isReady()) return;
  if (!hostSession.active) {
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

// Обработчик get-desktop-sources удалён: интерфейс его не вызывал, а отдавал
// он миниатюры всех экранов любой странице сервера в любой момент, без сеанса.
// Окно всплывающих уведомлений (toast.html с доступом к Node) тоже удалено —
// оно давно не показывалось, уведомления системные.

// Системное уведомление. Только от страницы сервера: иначе любая страница в
// окне могла бы показать поддельное уведомление от имени приложения.
ipcMain.handle('show-notification', (event, data) => {
  if (!isFromServerPage(event)) return false;
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
        title: String(title || 'CentyChat').slice(0, 200),
        body: String(body || '').slice(0, 1000),
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
      log(`Notification error: ${e.message}`);
    }
  }
  return true;
});

// Итог окна и системы для страницы, которая подписалась позже кадра
// did-finish-load (окно, запущенное в трее).
ipcMain.handle('get-window-presence', (event) => {
  if (!isFromServerPage(event, { quiet: true })) return 'online';
  return currentPresence();
});

ipcMain.handle('get-system-idle-time', (event) => {
  if (!isFromServerPage(event, { quiet: true })) return 0;
  try {
    return powerMonitor.getSystemIdleTime();
  } catch (e) {
    return 0;
  }
});

ipcMain.on('flash-frame', (event, flag) => {
  if (!isFromServerPage(event)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(Boolean(flag));
  }
});

ipcMain.on('set-badge-count', (event, count) => {
  if (!isFromServerPage(event)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const n = Number(count);
    mainWindow.setBadgeCount(Number.isInteger(n) && n > 0 ? Math.min(n, 9999) : 0);
  }
});

ipcMain.on('set-tray-tooltip', (event, text) => {
  if (!isFromServerPage(event)) return;
  rendererTrayTooltip = typeof text === 'string' && text ? text : null;
  refreshTrayTooltip();
});

ipcMain.on('focus-window', (event) => {
  if (!isFromServerPage(event)) return;
  showMainWindow();
});

// Имя компьютера и учётной записи Windows — только странице сервера.
ipcMain.handle('get-device-info', (event) => {
  if (!isFromServerPage(event)) return null;
  const os = require('node:os');
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    username: os.userInfo()?.username || 'user'
  };
});

// Обновления. Только главное окно: страница сервера — удалённый код, и ни
// окну просмотра, ни iframe незачем запускать установку. Адрес скачивания
// страница не передаёт — он берётся из состояния главного процесса.
ipcMain.handle('update-get-state', (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return null;
  return currentUpdateState();
});

ipcMain.handle('update-check', async (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return { ok: false, reason: 'untrusted' };
  if (!updateController) return { ok: false, reason: 'unsupported', state: currentUpdateState() };
  return updateController.checkNow({ userInitiated: true });
});

ipcMain.handle('update-install', (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return { ok: false, reason: 'untrusted' };
  if (!updateController) return { ok: false, reason: 'unsupported' };
  return updateController.installNow();
});

ipcMain.handle('update-open-download', (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return false;
  return updateController ? updateController.openDownload() : false;
});

// Настоящая версия оболочки — интерфейс сообщает её серверу (knock) и
// показывает в подвале; раньше там была жёстко прописанная строка.
ipcMain.handle('get-app-info', (event) => {
  if (!isFromServerPage(event, { mainWindowOnly: true })) return null;
  return { version: app.getVersion(), kind: INSTALL_KIND };
});

const TRAY_STATUSES = new Set(['online', 'away', 'offline', 'dnd']);

ipcMain.on('sync-tray-status', (event, status) => {
  if (!isFromServerPage(event)) return;
  updateTrayMenu(TRAY_STATUSES.has(status) ? status : 'online');
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

  // Меню по умолчанию (Файл/Правка/Вид…) не несёт полезных команд, зато
  // «Вид → Инструменты разработчика» и его сочетание клавиш открывали
  // DevTools поверх страницы сервера. В разработке меню оставлено — им
  // пользуются во время отладки.
  if (app.isPackaged) Menu.setApplicationMenu(null);

  // Незащищённые запросы и WebSocket (http:, ws:) в рабочей сборке не уходят
  // вовсе — что бы ни указали в «Сетевом сервере» интерфейса. В разработке
  // разрешён только localhost.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'ws://*/*'] }, (details, callback) => {
    const cancel = isInsecureRequestBlocked(details.url, { isPackaged: app.isPackaged });
    if (cancel) log(`insecure request blocked: ${redactUrl(details.url)}`);
    callback({ cancel });
  });

  // Раздел electron-updater — свой фильтр (только https и только сервер
  // обновлений); ставится всегда, даже если обновления выключены.
  try {
    updaterSession = installUpdaterSessionGuard();
  } catch (err) {
    log('updater session guard failed: ' + err.message);
  }

  // Сервер видит, какая оболочка к нему пришла. Слово Electron в строке
  // остаётся: по нему сервер отличает приложение от браузера. Метка
  // OpenMyChatDesktop — технический идентификатор, как и заголовки
  // X-MyChat-*: на неё могут опираться журналы и правила прокси, поэтому с
  // переименованием в CentyChat она не менялась.
  app.userAgentFallback = `${app.userAgentFallback} OpenMyChatDesktop/${app.getVersion()} (${INSTALL_KIND})`;

  // Скачивание вложения обычной переписки (не файла удалённого стола —
  // у того свой путь, ipcMain.handle('rd-save-file', …) выше). Имя задаёт
  // отправитель — тот же класс риска, что и у входящего файла удалённого
  // стола, и та же защита: опасное расширение получает добавочный «.txt»
  // (download-guard.js переиспользует правило received-file.js, второго
  // списка нет), подтверждается системным окном, а по завершении на файл
  // ставится пометка «из интернета» (Zone.Identifier) для SmartScreen.
  session.defaultSession.on('will-download', (event, item) => {
    const originalName = item.getFilename();
    const dangerous = isDangerousExtension(originalName);
    const finalName = safeDownloadName(originalName);
    const targetPath = uniqueDownloadPath(path.join(app.getPath('downloads'), finalName));
    item.setSavePath(targetPath);

    const proceed = () => {
      item.once('done', (doneEvent, state) => {
        if (state === 'completed') writeZoneIdentifier(targetPath);
        else log(`download ${state}: ${path.basename(targetPath)}`);
      });
    };

    if (!dangerous) {
      proceed();
      return;
    }

    // Опасный тип не запускается сам по себе (добавочный «.txt»), но
    // сотрудник должен знать, что он вообще что-то сохранил — как и при
    // приёме файла по удалённому столу.
    item.pause();
    askUser({
      type: 'warning',
      title: 'Скачивание файла',
      message: `Файл «${finalName}» — исполняемый или иной потенциально опасный тип. Сохранить его?`,
      detail: `Исходное имя: ${originalName}\nФайл будет помечен как полученный из интернета.`,
      buttons: ['Сохранить', 'Отклонить'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      normalizeAccessKeys: false
    })
      .then((response) => {
        if (response !== 0) {
          log(`download declined (dangerous type): ${finalName}`);
          item.cancel();
          return;
        }
        proceed();
        item.resume();
      })
      .catch((err) => {
        log(`download consent dialog failed: ${err.message}`);
        item.cancel();
      });
  });

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
  // Без фильтра раздела updater обновления не запускаются вовсе.
  if (updaterSession) startUpdater();
  else log('updates: not started — updater session guard is missing');

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
