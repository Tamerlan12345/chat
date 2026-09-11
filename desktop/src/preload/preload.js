const { contextBridge, ipcRenderer } = require('electron');

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
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
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
  syncTrayStatus: (status) => ipcRenderer.send('sync-tray-status', status),
  onRdViewerClosed: subscribe('rd-viewer-closed'),
  onToastAction: subscribe('toast-action'),

  // Управление этой машиной с другого компьютера. Сначала страница сообщает
  // о сеансе, который сотрудник подтвердил лично, — только тогда главный
  // процесс отдаёт экран и соглашается включить ввод.
  rdSessionStart: (info) => ipcRenderer.invoke('rd-session-start', info),
  rdSessionEnd: (info) => ipcRenderer.invoke('rd-session-end', info),
  rdInputEnable: () => ipcRenderer.invoke('rd-input-enable'),
  rdInputDisable: () => ipcRenderer.invoke('rd-input-disable'),
  rdInputEvent: (payload) => ipcRenderer.send('rd-input-event', payload),
  onRdInputRevoked: subscribe('rd-input-revoked'),
  rdSaveFile: (payload) => ipcRenderer.invoke('rd-save-file', payload),
  rdListScreens: () => ipcRenderer.invoke('rd-list-screens'),
  rdSelectScreen: (screenId, options) => ipcRenderer.invoke('rd-select-screen', screenId, options),
  rdClipboardRead: () => ipcRenderer.invoke('rd-clipboard-read'),
  rdClipboardWrite: (text) => ipcRenderer.invoke('rd-clipboard-write', text),

  // Страница «Нет связи с сервером».
  retryServerConnection: () => ipcRenderer.invoke('offline-retry'),
  onOfflineStatus: subscribe('offline-status')
});
