// Плашка «Ваш рабочий стол просматривает…» умеет ровно две вещи: завершить
// доступ и открыть окно приложения. Больше ей из главного процесса ничего не
// нужно, поэтому ничего больше и не открыто.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rdIndicator', {
  stop: () => ipcRenderer.send('rd-indicator-stop'),
  open: () => ipcRenderer.send('rd-indicator-open')
});
