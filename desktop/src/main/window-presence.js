// Присутствие, которое диктует компьютер (multi-device.md §2, правило
// владельца): окно на экране и человек за компьютером — «в сети»; окно
// свёрнуто или убрано в трей, компьютер простаивает или экран заблокирован —
// «отошёл».
//
// Окно создаётся с backgroundThrottling: false, и тогда страница не всегда
// узнаёт о сворачивании (document.hidden остаётся false), поэтому о свёрнутом
// окне сообщает главный процесс.

function isWindowAway(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  return Boolean(win.isMinimized()) || !win.isVisible();
}

function presenceSignal({ windowAway = false, idle = false, locked = false } = {}) {
  return windowAway || idle || locked ? 'away' : 'online';
}

module.exports = { isWindowAway, presenceSignal };
