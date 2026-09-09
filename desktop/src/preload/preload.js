const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openRemoteDesktopViewer: (data) => ipcRenderer.invoke('open-remote-desktop-viewer', data),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  showNotification: (data) => ipcRenderer.invoke('show-notification', data),
  flashFrame: (flag) => ipcRenderer.send('flash-frame', flag),
  setBadgeCount: (count) => ipcRenderer.send('set-badge-count', count),
  setTrayTooltip: (text) => ipcRenderer.send('set-tray-tooltip', text),
  focusWindow: () => ipcRenderer.send('focus-window'),
  onWindowFocus: (callback) => {
    ipcRenderer.on('window-focus', () => callback());
  },
  onWindowBlur: (callback) => {
    ipcRenderer.on('window-blur', () => callback());
  },
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  onTrayStatusChange: (callback) => {
    ipcRenderer.on('tray-status-change', (event, status) => callback(status));
  },
  onPowerMonitorEvent: (callback) => {
    ipcRenderer.on('power-monitor-event', (event, data) => callback(data));
  },
  getSystemIdleTime: () => ipcRenderer.invoke('get-system-idle-time'),
  syncTrayStatus: (status) => ipcRenderer.send('sync-tray-status', status),
  onRdViewerClosed: (callback) => {
    ipcRenderer.on('rd-viewer-closed', (event, data) => callback(data));
  },
  onToastAction: (callback) => {
    ipcRenderer.on('toast-action', (event, data) => callback(data));
  },
  // Управление этой машиной с другого компьютера. Включается только на время
  // сеанса, который сотрудник подтвердил лично.
  rdInputEnable: () => ipcRenderer.invoke('rd-input-enable'),
  rdInputDisable: () => ipcRenderer.invoke('rd-input-disable'),
  rdInputEvent: (payload) => ipcRenderer.send('rd-input-event', payload),
  onRdInputRevoked: (callback) => {
    ipcRenderer.on('rd-input-revoked', (event, data) => callback(data));
  }
});
