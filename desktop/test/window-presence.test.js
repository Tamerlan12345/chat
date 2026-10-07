const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Окно свёрнуто или убрано в трей — сотрудник «отошёл» (multi-device.md §2,
// правило владельца). При backgroundThrottling: false страница может не
// узнать о сворачивании (document.hidden), поэтому сигнал даёт главный
// процесс.

function fakeWindow({ minimized = false, visible = true, destroyed = false } = {}) {
  return { isMinimized: () => minimized, isVisible: () => visible, isDestroyed: () => destroyed };
}

test('isWindowAway: свёрнуто или скрыто — away; на экране — нет', () => {
  const { isWindowAway } = require('../src/main/window-presence');
  assert.strictEqual(isWindowAway(fakeWindow()), false);
  assert.strictEqual(isWindowAway(fakeWindow({ minimized: true })), true);
  assert.strictEqual(isWindowAway(fakeWindow({ visible: false })), true, 'в трее');
  assert.strictEqual(isWindowAway(fakeWindow({ destroyed: true })), false);
  assert.strictEqual(isWindowAway(null), false);
});

test('presenceSignal: online только когда окно на экране, нет простоя и экран не заблокирован', () => {
  const { presenceSignal } = require('../src/main/window-presence');
  assert.strictEqual(presenceSignal({ windowAway: false, idle: false, locked: false }), 'online');
  assert.strictEqual(presenceSignal({ windowAway: true, idle: false, locked: false }), 'away');
  assert.strictEqual(presenceSignal({ windowAway: false, idle: true, locked: false }), 'away');
  assert.strictEqual(presenceSignal({ windowAway: false, idle: false, locked: true }), 'away');
  assert.strictEqual(presenceSignal({}), 'online');
});

test('main.js: сворачивание/трей шлют away сразу, разворачивание — online; «вернулся» при свёрнутом окне не делает online', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/window-presence'\)/);
  for (const evt of ['minimize', 'restore', 'hide', 'show']) {
    const re = new RegExp(String.raw`win\.on\('${evt}', \(\) => \{[\s\S]{0,60}sendWindowPresence\(`);
    assert.match(main, re, `${evt} → sendWindowPresence`);
  }
  // Возвраты (разблокировка, пробуждение, ввод после простоя) шлют итог по
  // presenceSignal, а не голое online.
  const power = main.slice(main.indexOf('function setupPowerAndPresenceMonitoring'));
  assert.ok(!/status: 'online'/.test(power.slice(0, power.indexOf('// ── IPC Handlers'))), 'нет безусловного online');
  // Окно, запущенное свёрнутым в трей при входе в Windows, сообщает away после загрузки.
  assert.match(main, /did-finish-load[\s\S]{0,300}sendWindowPresence/);
});

// ── Fix round 1 (Ruling S): «в трее при запуске» не теряется ───────────────
// did-finish-load мог прийти раньше, чем страница подписалась на
// power-monitor-event. Страница сама спрашивает состояние после подписки.

test('preload и main: get-window-presence отдаёт текущий итог только странице сервера', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  assert.match(preload, /getWindowPresence: \(\) => ipcRenderer\.invoke\('get-window-presence'\)/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('get-window-presence'"));
  assert.ok(main.includes("ipcMain.handle('get-window-presence'"), 'обработчик есть');
  assert.match(handler.slice(0, 300), /isFromServerPage\(event/);
  assert.match(handler.slice(0, 300), /return currentPresence\(\)/);
});

test('App.jsx: после подписки на power-monitor-event страница спрашивает состояние окна', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'App.jsx'), 'utf8');
  const i = app.indexOf('const offPower = window.electronAPI?.onPowerMonitorEvent');
  assert.ok(i > 0);
  assert.match(app.slice(i, i + 900), /getWindowPresence\?\.\(\)/);
});
