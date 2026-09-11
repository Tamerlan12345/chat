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
