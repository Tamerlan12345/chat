const test = require('node:test');
const assert = require('node:assert');
const { originOf, isSameOrigin, isTrustedFrame, isExternalLink } = require('../src/main/security');
const {
  shouldShowOfflineForFailure,
  shouldShowOfflineForStatus,
  describeLoadFailure,
  describeHttpFailure,
  HEALTH_RETRY_MS
} = require('../src/main/offline');
const { HostSession } = require('../src/main/host-session');

const ORIGIN = 'https://chat.example.kz';

// ── Откуда принимаются навигация и IPC ─────────────────────────────────────
// Интерфейс приходит с сервера. Всё, что умеет главный процесс (ввод мыши и
// клавиатуры, буфер обмена, запись файлов), доступно только странице этого
// сервера — не ссылке, по которой окно ушло, и не встроенному iframe.

test('источник адреса', () => {
  assert.strictEqual(originOf(ORIGIN + '/path?q=1'), ORIGIN);
  assert.strictEqual(originOf('not a url'), null);
  assert.strictEqual(originOf(undefined), null);
  assert.strictEqual(originOf('file:///C:/Windows/'), null, 'у file: нет источника');
});

test('навигация — только в пределах сервера', () => {
  assert.strictEqual(isSameOrigin(ORIGIN + '/?view=x', ORIGIN), true);
  assert.strictEqual(isSameOrigin('https://chat.example.kz.evil.com/', ORIGIN), false);
  assert.strictEqual(isSameOrigin('http://chat.example.kz/', ORIGIN), false, 'другая схема');
  assert.strictEqual(isSameOrigin('https://chat.example.kz:8443/', ORIGIN), false, 'другой порт');
  assert.strictEqual(isSameOrigin('file:///C:/Windows/', ORIGIN), false);
  assert.strictEqual(isSameOrigin('javascript:alert(1)', ORIGIN), false);
  assert.strictEqual(isSameOrigin('data:text/html,hi', ORIGIN), false);
  assert.strictEqual(isSameOrigin(ORIGIN, null), false);
});

test('IPC принимается только от верхнего кадра страницы сервера', () => {
  assert.strictEqual(isTrustedFrame({ url: ORIGIN + '/', parent: null }, ORIGIN), true);
  assert.strictEqual(isTrustedFrame({ url: ORIGIN + '/', parent: {} }, ORIGIN), false, 'iframe');
  assert.strictEqual(isTrustedFrame({ url: 'https://evil.com/', parent: null }, ORIGIN), false);
  assert.strictEqual(isTrustedFrame({ url: 'file:///C:/app/offline.html', parent: null }, ORIGIN), false);
  assert.strictEqual(isTrustedFrame(null, ORIGIN), false);
  assert.strictEqual(isTrustedFrame({ parent: null }, ORIGIN), false);
});

test('наружу открываются только http и https', () => {
  assert.strictEqual(isExternalLink('https://example.com/a'), true);
  assert.strictEqual(isExternalLink('http://example.com'), true);
  assert.strictEqual(isExternalLink('file:///C:/Windows/System32/calc.exe'), false);
  assert.strictEqual(isExternalLink('ms-msdt:/id PCWDiagnostic'), false);
  assert.strictEqual(isExternalLink('javascript:alert(1)'), false);
  assert.strictEqual(isExternalLink('smb://server/share'), false);
  assert.strictEqual(isExternalLink(''), false);
});

// ── Страница «Нет связи с сервером» ─────────────────────────────────────────

test('сбой загрузки главного кадра сервера показывает страницу без связи', () => {
  assert.strictEqual(
    shouldShowOfflineForFailure({ errorCode: -105, isMainFrame: true, url: ORIGIN + '/', serverOrigin: ORIGIN }),
    true
  );
});

test('прерванная загрузка, подкадр и чужой адрес — не повод', () => {
  const base = { isMainFrame: true, url: ORIGIN + '/', serverOrigin: ORIGIN };
  assert.strictEqual(shouldShowOfflineForFailure({ ...base, errorCode: -3 }), false, 'ERR_ABORTED — обычная смена адреса');
  assert.strictEqual(shouldShowOfflineForFailure({ ...base, errorCode: -105, isMainFrame: false }), false);
  assert.strictEqual(shouldShowOfflineForFailure({ ...base, errorCode: -105, url: 'https://cdn.other.com/' }), false);
  assert.strictEqual(shouldShowOfflineForFailure({ ...base, errorCode: 0 }), false);
});

test('ответ 5xx на главную страницу тоже означает «нет связи»', () => {
  const base = { url: ORIGIN + '/', serverOrigin: ORIGIN };
  assert.strictEqual(shouldShowOfflineForStatus({ ...base, httpResponseCode: 502 }), true);
  assert.strictEqual(shouldShowOfflineForStatus({ ...base, httpResponseCode: 503 }), true);
  assert.strictEqual(shouldShowOfflineForStatus({ ...base, httpResponseCode: 200 }), false);
  assert.strictEqual(shouldShowOfflineForStatus({ ...base, httpResponseCode: 404 }), false);
  assert.strictEqual(shouldShowOfflineForStatus({ ...base, httpResponseCode: 0 }), false);
  assert.strictEqual(shouldShowOfflineForStatus({ url: 'https://other.com/', serverOrigin: ORIGIN, httpResponseCode: 502 }), false);
});

test('причина объясняется по-русски, а неизвестная не теряется', () => {
  assert.match(describeLoadFailure(-106, 'ERR_INTERNET_DISCONNECTED'), /интернет/i);
  assert.match(describeLoadFailure(-105, 'ERR_NAME_NOT_RESOLVED'), /адрес/i);
  assert.match(describeLoadFailure(-102, 'ERR_CONNECTION_REFUSED'), /отклонил/i);
  assert.match(describeLoadFailure(-118, 'ERR_CONNECTION_TIMED_OUT'), /не отвечает/i);
  assert.match(describeLoadFailure(-202, 'ERR_CERT_AUTHORITY_INVALID'), /сертификат/i);
  assert.match(describeLoadFailure(-999, 'ERR_WHATEVER'), /ERR_WHATEVER/);
  assert.match(describeHttpFailure(502, 'Bad Gateway'), /502/);
});

test('повторная проверка раз в 5–10 секунд', () => {
  assert.ok(HEALTH_RETRY_MS >= 5000 && HEALTH_RETRY_MS <= 10000);
});

// ── Сеанс удалённого доступа глазами главного процесса ──────────────────────
// Экран отдаётся и ввод включается только пока сотрудник сам подтвердил сеанс.

test('до начала сеанса ничего не разрешено', () => {
  const s = new HostSession();
  assert.strictEqual(s.active, false);
  assert.strictEqual(s.allowsCapture, false);
  assert.strictEqual(s.allowsInput, false);
  assert.strictEqual(s.indicatorText(), '');
});

test('полный доступ разрешает ввод, просмотр — только захват экрана', () => {
  const full = new HostSession();
  assert.strictEqual(full.start({ sessionId: 'rd_1', operatorName: 'Иван Петров', accessLevel: 'full' }), true);
  assert.strictEqual(full.allowsCapture, true);
  assert.strictEqual(full.allowsInput, true);

  const view = new HostSession();
  view.start({ sessionId: 'rd_2', operatorName: 'Иван', accessLevel: 'view_only' });
  assert.strictEqual(view.allowsCapture, true);
  assert.strictEqual(view.allowsInput, false);
});

test('неизвестный уровень доступа считается просмотром', () => {
  const s = new HostSession();
  s.start({ sessionId: 'rd_1', operatorName: 'Иван', accessLevel: 'FULL' });
  assert.strictEqual(s.accessLevel, 'view_only');
  assert.strictEqual(s.allowsInput, false);
});

test('без идентификатора сеанс не начинается', () => {
  const s = new HostSession();
  assert.strictEqual(s.start({ operatorName: 'Иван', accessLevel: 'full' }), false);
  assert.strictEqual(s.start({ sessionId: '', accessLevel: 'full' }), false);
  assert.strictEqual(s.start({ sessionId: 42, accessLevel: 'full' }), false);
  assert.strictEqual(s.start(), false);
  assert.strictEqual(s.active, false);
});

test('завершение чужого сеанса не трогает текущий', () => {
  const s = new HostSession();
  s.start({ sessionId: 'rd_1', operatorName: 'Иван', accessLevel: 'full' });
  assert.strictEqual(s.end('rd_other'), false);
  assert.strictEqual(s.active, true);
  assert.strictEqual(s.end('rd_1'), true);
  assert.strictEqual(s.active, false);
  assert.strictEqual(s.end('rd_1'), false, 'повторное завершение ничего не делает');

  s.start({ sessionId: 'rd_3', operatorName: 'Иван', accessLevel: 'full' });
  assert.strictEqual(s.end(), true, 'без идентификатора завершается любой текущий');
});

test('текст индикатора: имя очищено и ограничено', () => {
  const s = new HostSession();
  s.start({ sessionId: 'rd_1', operatorName: '  Иван Петров\n', accessLevel: 'full' });
  assert.strictEqual(s.indicatorText(), 'Ваш рабочий стол просматривает Иван Петров');

  s.start({ sessionId: 'rd_2', operatorName: '', accessLevel: 'full' });
  assert.strictEqual(s.indicatorText(), 'Ваш рабочий стол просматривает оператор техподдержки');

  s.start({ sessionId: 'rd_3', operatorName: 'Я'.repeat(500), accessLevel: 'full' });
  assert.ok(s.operatorName.length <= 80);
});

// ── Масштаб Ctrl +/−/0 (финальное ревью, п.5 и повторное ревью) ────────────
// Меню приложения в собранной сборке убрано (через него открывались
// DevTools), а вместе с ним пропали и сочетания масштаба. Масштаб возвращён
// в preload: слушатель keydown на window срабатывает ПОСЛЕ страницы и
// пропускает событие, если страница его уже обработала (defaultPrevented).
// Так просмотр удалённого стола, который сам передаёт Ctrl+−/+/0 на
// удалённый компьютер, их не теряет. Первая версия перехватывала клавиши в
// главном процессе (before-input-event) — до страницы.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const preloadText = fs.readFileSync(PRELOAD, 'utf8');

// Чистые функции масштаба — блок между метками в preload.js. Песочница
// preload не даёт подключать локальные файлы, поэтому источник один — сам
// preload, а тест берёт этот блок из него.
function loadZoomHelpers() {
  const begin = preloadText.indexOf('// zoom-keys:begin');
  const end = preloadText.indexOf('// zoom-keys:end');
  assert.ok(begin > 0 && end > begin, 'в preload.js есть блок // zoom-keys:begin … // zoom-keys:end');
  const block = preloadText.slice(begin, end);
  return vm.runInNewContext(`${block}\n({ zoomCommandForKeyEvent, nextZoomLevel, ZOOM_MIN_LEVEL, ZOOM_MAX_LEVEL });`);
}

const zoom = loadZoomHelpers();
const keyEvent = (key, code, mods = {}) => ({ type: 'keydown', key, code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, defaultPrevented: false, ...mods });

test('Ctrl+= / Ctrl+Plus / Ctrl+NumpadAdd — крупнее, Ctrl+- — мельче, Ctrl+0 — сброс', () => {
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('=', 'Equal')), 'in');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('+', 'Equal', { shiftKey: true })), 'in');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('+', 'NumpadAdd')), 'in');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('+', 'BracketRight')), 'in', 'клавиша «+» в других раскладках');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('-', 'Minus')), 'out');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('-', 'NumpadSubtract')), 'out');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('0', 'Digit0')), 'reset');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('0', 'Numpad0')), 'reset');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('=', 'Equal', { ctrlKey: false, metaKey: true })), 'in');
});

test('прочие сочетания масштабом не считаются — DevTools, копирование, AltGr, отпускание', () => {
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('F12', 'F12', { ctrlKey: false })), null);
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('I', 'KeyI', { shiftKey: true })), null);
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('Insert', 'Numpad0')), null, 'Ctrl+Insert на цифровом блоке без NumLock — копирование');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('=', 'Equal', { altKey: true })), null, 'AltGr = Ctrl+Alt');
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('=', 'Equal', { ctrlKey: false })), null);
  assert.strictEqual(zoom.zoomCommandForKeyEvent({ ...keyEvent('=', 'Equal'), type: 'keyup' }), null);
  assert.strictEqual(zoom.zoomCommandForKeyEvent(keyEvent('r', 'KeyR')), null);
  assert.strictEqual(zoom.zoomCommandForKeyEvent(null), null);
});

test('шаг масштаба 0.5 и пределы', () => {
  assert.strictEqual(zoom.nextZoomLevel(0, 'in'), 0.5);
  assert.strictEqual(zoom.nextZoomLevel(0, 'out'), -0.5);
  assert.strictEqual(zoom.nextZoomLevel(2.5, 'reset'), 0);
  assert.strictEqual(zoom.nextZoomLevel(zoom.ZOOM_MAX_LEVEL, 'in'), zoom.ZOOM_MAX_LEVEL);
  assert.strictEqual(zoom.nextZoomLevel(zoom.ZOOM_MIN_LEVEL, 'out'), zoom.ZOOM_MIN_LEVEL);
  assert.strictEqual(zoom.nextZoomLevel(Number.NaN, 'in'), 0.5);
});

// preload.js загружается как в песочнице: 'electron' подменён, window —
// заглушка, которая запоминает слушателей.
function loadPreload() {
  const listeners = [];
  const zoomCalls = [];
  let level = 0;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { on() {}, removeListener() {}, invoke() {}, send() {} },
    webFrame: {
      getZoomLevel: () => level,
      setZoomLevel: (value) => { zoomCalls.push(value); level = value; }
    }
  };
  const originalLoad = Module._load;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  Module._load = function load(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, ...rest);
  };
  global.window = { addEventListener: (type, fn, options) => listeners.push({ type, fn, options }) };
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
  } finally {
    Module._load = originalLoad;
    if (hadWindow) global.window = previousWindow;
    else delete global.window;
    delete require.cache[PRELOAD];
  }
  const keydown = listeners.filter((l) => l.type === 'keydown');
  const dispatch = (event) => {
    let prevented = event.defaultPrevented;
    const e = { ...event, get defaultPrevented() { return prevented; }, preventDefault() { prevented = true; } };
    for (const l of keydown) l.fn(e);
    return prevented;
  };
  return { keydown, dispatch, zoomCalls, setLevel: (v) => { level = v; } };
}

test('preload: Ctrl+=/−/0 меняют масштаб окна, если страница клавишу не обработала', () => {
  const p = loadPreload();
  assert.strictEqual(p.keydown.length, 1, 'один слушатель keydown на window');
  assert.notStrictEqual(p.keydown[0].options && p.keydown[0].options.capture, true, 'слушатель — на всплытии, после страницы');
  assert.strictEqual(p.dispatch(keyEvent('=', 'Equal')), true, 'обработанное сочетание гасится');
  assert.strictEqual(p.dispatch(keyEvent('-', 'Minus')), true);
  assert.strictEqual(p.dispatch(keyEvent('+', 'NumpadAdd')), true);
  assert.deepStrictEqual(p.zoomCalls, [0.5, 0, 0.5]);
  p.setLevel(3);
  p.dispatch(keyEvent('0', 'Digit0'));
  assert.deepStrictEqual(p.zoomCalls, [0.5, 0, 0.5, 0]);
  assert.strictEqual(p.dispatch(keyEvent('c', 'KeyC')), false, 'прочие сочетания не трогаются');
  assert.strictEqual(p.zoomCalls.length, 4);
});

test('preload: если страница уже обработала клавишу (просмотр удалённого стола), масштаб не меняется', () => {
  const p = loadPreload();
  for (const e of [keyEvent('=', 'Equal'), keyEvent('-', 'Minus'), keyEvent('0', 'Digit0'), keyEvent('+', 'NumpadAdd')]) {
    p.dispatch({ ...e, defaultPrevented: true });
  }
  assert.deepStrictEqual(p.zoomCalls, [], 'Ctrl+−/+/0 уходят на удалённый компьютер, а не масштабируют окно');
});

test('main.js не перехватывает клавиши масштаба до страницы; DevTools по-прежнему закрыты', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.ok(!/zoomCommand|setZoomLevel|zoom-keys/.test(main), 'в главном процессе масштаб не обрабатывается');
  const inputHandlers = main.split("on('before-input-event'").slice(1).map((s) => s.slice(0, 600));
  assert.strictEqual(inputHandlers.length, 1, 'один before-input-event — гашение DevTools');
  assert.match(inputHandlers[0], /isF12 \|\| isCtrlShiftI\) event\.preventDefault\(\)/, 'F12 и Ctrl+Shift+I по-прежнему гасятся');
  assert.ok(!/Equal|Minus|Digit0|NumpadAdd/.test(inputHandlers[0]));
  assert.match(main, /if \(app\.isPackaged\) Menu\.setApplicationMenu\(null\);/, 'меню в собранной сборке не возвращается');
  assert.match(main, /autoHideMenuBar: !app\.isPackaged/, 'системное меню в разработке скрыто и не дублирует меню приложения');
  assert.ok(!/openDevTools|toggleDevTools/.test(main), 'DevTools нигде не открываются');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'main', 'zoom-keys.js')), 'единственный источник — preload.js');

  assert.match(preloadText, /window\.addEventListener\('keydown'/, 'preload слушает keydown на window');
  assert.match(preloadText, /if \(event\.defaultPrevented\) return;/, 'и уступает странице');
  assert.match(preloadText, /webFrame\.setZoomLevel\(nextZoomLevel\(webFrame\.getZoomLevel\(\)/);
});
