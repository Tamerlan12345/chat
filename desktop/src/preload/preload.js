const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Подписка на событие главного процесса. Возвращает функцию отписки: раньше
// слушатели только добавлялись, и каждый новый экземпляр компонента (а в
// StrictMode — каждое повторное подключение эффекта) оставлял прежний висеть
// навсегда. Вызывать отписку не обязательно: код, который возвращаемое
// значение игнорирует, работает как прежде.
function subscribe(channel, toArgs = (data) => [data]) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, data) => callback(...toArgs(data));
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openRemoteDesktopViewer: (data) => ipcRenderer.invoke('open-remote-desktop-viewer', data),
  showNotification: (data) => ipcRenderer.invoke('show-notification', data),
  flashFrame: (flag) => ipcRenderer.send('flash-frame', flag),
  setBadgeCount: (count) => ipcRenderer.send('set-badge-count', count),
  setTrayTooltip: (text) => ipcRenderer.send('set-tray-tooltip', text),
  focusWindow: () => ipcRenderer.send('focus-window'),
  onWindowFocus: subscribe('window-focus', () => []),
  onWindowBlur: subscribe('window-blur', () => []),
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  onTrayStatusChange: subscribe('tray-status-change'),
  onPowerMonitorEvent: subscribe('power-monitor-event'),
  getSystemIdleTime: () => ipcRenderer.invoke('get-system-idle-time'),
  // Текущий итог окна и системы (свёрнуто/в трее/простой — away): страница
  // спрашивает после подписки на power-monitor-event.
  getWindowPresence: () => ipcRenderer.invoke('get-window-presence'),
  syncTrayStatus: (status) => ipcRenderer.send('sync-tray-status', status),
  onRdViewerClosed: subscribe('rd-viewer-closed'),
  onToastAction: subscribe('toast-action'),

  // Управление этой машиной с другого компьютера. rdSessionStart показывает
  // системное окно согласия и возвращает { accepted, accessLevel } — уровень,
  // выбранный сотрудником в нём. Только тогда главный процесс отдаёт экран и
  // (при полном доступе) соглашается включить ввод.
  rdSessionStart: (info) => ipcRenderer.invoke('rd-session-start', info),
  rdSessionEnd: (info) => ipcRenderer.invoke('rd-session-end', info),
  rdInputEnable: () => ipcRenderer.invoke('rd-input-enable'),
  rdInputDisable: () => ipcRenderer.invoke('rd-input-disable'),
  rdInputEvent: (payload) => ipcRenderer.send('rd-input-event', payload),
  onRdInputRevoked: subscribe('rd-input-revoked'),
  rdSaveFile: (payload) => ipcRenderer.invoke('rd-save-file', payload),
  rdListScreens: () => ipcRenderer.invoke('rd-list-screens'),
  rdSelectScreen: (screenId, options) => ipcRenderer.invoke('rd-select-screen', screenId, options),
  // Буфер обмена сеанса — только после согласия в системном окне:
  // rdClipboardGrant({ role: 'host' | 'operator', sessionId, peerName }) -> boolean.
  // Без согласия чтение возвращает null, запись — false.
  rdClipboardGrant: (opts) => ipcRenderer.invoke('rd-clipboard-grant', opts),
  rdClipboardRevoke: (opts) => ipcRenderer.invoke('rd-clipboard-revoke', opts),
  rdClipboardRead: (opts) => ipcRenderer.invoke('rd-clipboard-read', opts),
  rdClipboardWrite: (text, opts) => ipcRenderer.invoke('rd-clipboard-write', text, opts),

  // Страница «Нет связи с сервером».
  retryServerConnection: () => ipcRenderer.invoke('offline-retry'),
  onOfflineStatus: subscribe('offline-status'),

  // Версия оболочки и автообновление (только главное окно).
  // getAppInfo() -> { version, kind } | null;
  // getUpdateState() -> { status, currentVersion, offeredVersion, progress,
  //   mandatory, message, kind, error, downloadUrl };
  // checkForUpdates() -> { ok, reason?, state? } — не чаще раза в минуту;
  // installUpdate() -> { ok, reason? } — только когда status === 'downloaded';
  // openUpdateDownload() -> boolean — ссылку главный процесс берёт у себя;
  // onUpdateStatus(cb) -> отписка; cb получает то же состояние.
  // Проверка по наличию: у старой оболочки (1.0.0) этих функций нет.
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getUpdateState: () => ipcRenderer.invoke('update-get-state'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  openUpdateDownload: () => ipcRenderer.invoke('update-open-download'),
  onUpdateStatus: subscribe('update-status')
});

// ── Масштаб окна: Ctrl+= / Ctrl+Plus / Ctrl+NumpadAdd, Ctrl+-, Ctrl+0 ───────
// В собранной сборке меню приложения убрано: через «Вид → Инструменты
// разработчика» открывались DevTools поверх страницы сервера. Вместе с меню
// пропали и его сочетания масштаба — для тех, кому мелко, это единственный
// быстрый способ. Они возвращены здесь, а не в главном процессе:
// before-input-event срабатывает ДО страницы, и просмотр удалённого стола
// (он передаёт Ctrl+−/+/0 на удалённый компьютер и гасит событие) терял бы
// эти сочетания. Слушатель на window — на всплытии, то есть после
// обработчиков страницы (React вешает их на корень приложения), и уступает
// событию, которое страница уже обработала.
//
// Песочница preload не даёт подключать локальные файлы — чистые функции
// лежат здесь же; тест (test/main-guards.test.js) берёт блок между метками.
// zoom-keys:begin
// Шаг и пределы — как у Chromium: уровень 0 = 100 %, каждый шаг ×1.2^0.5.
const ZOOM_STEP = 0.5;
const ZOOM_MIN_LEVEL = -4; // ≈ 48 %
const ZOOM_MAX_LEVEL = 6; // ≈ 300 %

// KeyboardEvent → 'in' | 'out' | 'reset' | null. Клавиша определяется и по
// физическому коду (раскладка не важна), и по символу («+» бывает на другой
// клавише). Ctrl+Alt — это AltGr: такие сочетания печатают символы. Numpad0
// без NumLock — это Insert (Ctrl+Insert — копирование), поэтому для сброса
// нужен символ «0» или цифровая клавиша основного ряда.
function zoomCommandForKeyEvent(event) {
  if (!event || event.type !== 'keydown') return null;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = String(event.key || '');
  const code = String(event.code || '');
  if (code === 'Equal' || code === 'NumpadAdd' || key === '=' || key === '+') return 'in';
  if (code === 'Minus' || code === 'NumpadSubtract' || key === '-') return 'out';
  if (code === 'Digit0' || key === '0') return 'reset';
  return null;
}

function nextZoomLevel(level, command) {
  const current = Number.isFinite(level) ? level : 0;
  if (command === 'reset') return 0;
  if (command === 'in') return Math.min(ZOOM_MAX_LEVEL, current + ZOOM_STEP);
  if (command === 'out') return Math.max(ZOOM_MIN_LEVEL, current - ZOOM_STEP);
  return current;
}
// zoom-keys:end

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  const command = zoomCommandForKeyEvent(event);
  if (!command) return;
  event.preventDefault();
  webFrame.setZoomLevel(nextZoomLevel(webFrame.getZoomLevel(), command));
});
