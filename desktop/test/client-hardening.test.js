const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { decidePermissionRequest, decidePermissionCheck } = require('../src/main/permissions');
const { isAllowedServerUrl, resolveServerUrl, isInsecureRequestBlocked } = require('../src/main/server-url');
const {
  buildConsentDialog,
  resolveConsent,
  isFullAccessDisabled,
  isRemoteDesktopDisabled,
  readRdPolicy,
  policyDecline,
  policyPaths,
  buildClipboardDialog,
  buildFileDialog
} = require('../src/main/rd-consent');
const { ClipboardGrants, OPERATOR_GRANT_TTL_MS } = require('../src/main/clipboard-grants');
const { HostSession } = require('../src/main/host-session');

const ORIGIN = 'https://chat.example.kz';

// ── 2.1. Разрешения: только микрофон ───────────────────────────────────────

test('микрофон странице сервера разрешается', () => {
  assert.strictEqual(
    decidePermissionRequest({ permission: 'media', mediaTypes: ['audio'], requestingUrl: ORIGIN + '/', serverOrigin: ORIGIN }),
    true
  );
});

test('камера и снятие экрана через getUserMedia отклоняются', () => {
  const base = { permission: 'media', requestingUrl: ORIGIN + '/', serverOrigin: ORIGIN };
  assert.strictEqual(decidePermissionRequest({ ...base, mediaTypes: ['video'] }), false, 'chromeMediaSource: desktop приходит как video');
  assert.strictEqual(decidePermissionRequest({ ...base, mediaTypes: ['audio', 'video'] }), false);
  assert.strictEqual(decidePermissionRequest({ ...base, mediaTypes: [] }), false);
  assert.strictEqual(decidePermissionRequest({ ...base, mediaTypes: undefined }), false);
});

test('разрешения чужому адресу и лишние разрешения не выдаются', () => {
  assert.strictEqual(
    decidePermissionRequest({ permission: 'media', mediaTypes: ['audio'], requestingUrl: 'https://evil.com/', serverOrigin: ORIGIN }),
    false
  );
  assert.strictEqual(
    decidePermissionRequest({ permission: 'media', mediaTypes: ['audio'], requestingUrl: 'file:///C:/app/offline.html', serverOrigin: ORIGIN }),
    false
  );
  for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal', 'display-capture']) {
    assert.strictEqual(decidePermissionRequest({ permission, requestingUrl: ORIGIN + '/', serverOrigin: ORIGIN }), false, permission);
  }
  assert.strictEqual(
    decidePermissionRequest({ permission: 'clipboard-sanitized-write', requestingUrl: ORIGIN + '/', serverOrigin: ORIGIN }),
    true
  );
});

test('проверка разрешений: без источника — отказ, видео — отказ', () => {
  const base = { permission: 'media', serverOrigin: ORIGIN };
  assert.strictEqual(decidePermissionCheck({ ...base, mediaType: 'audio', requestingOrigin: ORIGIN }), true);
  assert.strictEqual(decidePermissionCheck({ ...base, mediaType: 'audio', requestingOrigin: '' }), false, 'пустой источник');
  assert.strictEqual(decidePermissionCheck({ ...base, mediaType: 'audio', requestingOrigin: undefined }), false);
  assert.strictEqual(decidePermissionCheck({ ...base, mediaType: 'video', requestingOrigin: ORIGIN }), false);
  assert.strictEqual(decidePermissionCheck({ ...base, mediaType: 'unknown', requestingOrigin: ORIGIN }), false);
  assert.strictEqual(decidePermissionCheck({ ...base, mediaType: 'audio', requestingOrigin: 'https://evil.com' }), false);
  assert.strictEqual(decidePermissionCheck({ permission: 'clipboard-read', requestingOrigin: ORIGIN, serverOrigin: ORIGIN }), false);
});

// ── 2.6. Адрес сервера ─────────────────────────────────────────────────────

test('в рабочей сборке — только https', () => {
  assert.strictEqual(isAllowedServerUrl('https://chat.example.kz', { isPackaged: true }), true);
  assert.strictEqual(isAllowedServerUrl('http://chat.example.kz', { isPackaged: true }), false);
  assert.strictEqual(isAllowedServerUrl('http://localhost:2004', { isPackaged: true }), false);
  assert.strictEqual(isAllowedServerUrl('http://192.168.10.15:2004', { isPackaged: true }), false);
  assert.strictEqual(isAllowedServerUrl('file:///C:/evil.html', { isPackaged: true }), false);
  assert.strictEqual(isAllowedServerUrl('https://user:pass@chat.example.kz', { isPackaged: true }), false);
  assert.strictEqual(isAllowedServerUrl('not a url', { isPackaged: true }), false);
});

test('в разработке http — только для своей машины', () => {
  assert.strictEqual(isAllowedServerUrl('http://localhost:5173', { isPackaged: false }), true);
  assert.strictEqual(isAllowedServerUrl('http://127.0.0.1:2004', { isPackaged: false }), true);
  assert.strictEqual(isAllowedServerUrl('http://192.168.10.15:2004', { isPackaged: false }), false);
  assert.strictEqual(isAllowedServerUrl('http://localhost.evil.com', { isPackaged: false }), false);
});

test('переменные окружения в рабочей сборке не читаются', () => {
  const defaultUrl = 'https://default.example.kz';
  const env = { VITE_DEV_SERVER_URL: 'https://evil.com', MYCHAT_SERVER_URL: 'https://evil.com' };
  assert.deepStrictEqual(resolveServerUrl({ isPackaged: true, env, defaultUrl }), { url: defaultUrl, ignored: null });
  assert.strictEqual(resolveServerUrl({ isPackaged: false, env: { MYCHAT_SERVER_URL: 'https://staging.example.kz' }, defaultUrl }).url, 'https://staging.example.kz');
  assert.strictEqual(resolveServerUrl({ isPackaged: false, env: { VITE_DEV_SERVER_URL: 'http://localhost:5173' }, defaultUrl }).url, 'http://localhost:5173');
  const insecure = resolveServerUrl({ isPackaged: false, env: { MYCHAT_SERVER_URL: 'http://10.0.0.5:2004' }, defaultUrl });
  assert.strictEqual(insecure.url, defaultUrl);
  assert.strictEqual(insecure.ignored, 'http://10.0.0.5:2004');
});

test('http и ws из рабочей сборки не уходят', () => {
  assert.strictEqual(isInsecureRequestBlocked('http://192.168.10.15:2004/api/auth/login', { isPackaged: true }), true);
  assert.strictEqual(isInsecureRequestBlocked('ws://chat.example.kz/ws', { isPackaged: true }), true);
  assert.strictEqual(isInsecureRequestBlocked('http://localhost:2004/', { isPackaged: true }), true);
  assert.strictEqual(isInsecureRequestBlocked('https://chat.example.kz/', { isPackaged: true }), false);
  assert.strictEqual(isInsecureRequestBlocked('wss://chat.example.kz/ws', { isPackaged: true }), false);
  assert.strictEqual(isInsecureRequestBlocked('http://localhost:5173/', { isPackaged: false }), false);
  assert.strictEqual(isInsecureRequestBlocked('http://10.0.0.5/', { isPackaged: false }), true);
});

// ── 2.2. Согласие на удалённый стол ────────────────────────────────────────

test('окно согласия: по умолчанию и по Esc — отказ, первым идёт просмотр', () => {
  const { choices, options } = buildConsentDialog({ operatorName: 'Иванов И.', requestedLevel: 'full' });
  assert.deepStrictEqual(choices, ['view_only', 'full', null]);
  assert.deepStrictEqual(options.buttons, ['Только просмотр', 'Полный доступ', 'Отклонить']);
  assert.strictEqual(options.defaultId, 2);
  assert.strictEqual(options.cancelId, 2);
  assert.ok(options.message.includes('Иванов И.'));
});

test('просили просмотр — полный доступ не предлагается', () => {
  const { choices, options } = buildConsentDialog({ operatorName: 'X', requestedLevel: 'view_only' });
  assert.deepStrictEqual(choices, ['view_only', null]);
  assert.strictEqual(options.defaultId, 1);
  assert.strictEqual(options.cancelId, 1);
  // Страница прислала что-то постороннее — тоже только просмотр.
  assert.deepStrictEqual(buildConsentDialog({ requestedLevel: 'admin' }).choices, ['view_only', null]);
});

test('уровень берётся из ответа в системном окне, а не со страницы', () => {
  const full = buildConsentDialog({ requestedLevel: 'full' }).choices;
  assert.strictEqual(resolveConsent(full, 0), 'view_only');
  assert.strictEqual(resolveConsent(full, 1), 'full');
  assert.strictEqual(resolveConsent(full, 2), null);
  assert.strictEqual(resolveConsent(full, 7), null, 'неизвестный ответ — отказ');
  assert.strictEqual(resolveConsent(full, undefined), null);
  assert.strictEqual(resolveConsent(full, null), null);
  const view = buildConsentDialog({ requestedLevel: 'view_only' }).choices;
  assert.strictEqual(resolveConsent(view, 1), null, 'на месте «Полный доступ» здесь — «Отклонить»');
});

test('политика запрещает полный доступ', () => {
  const { choices, options } = buildConsentDialog({ requestedLevel: 'full', fullAccessDisabled: true });
  assert.deepStrictEqual(choices, ['view_only', null]);
  assert.ok(options.detail.includes('запрещён политикой'));
  assert.strictEqual(resolveConsent(['view_only', 'full', null], 1, { fullAccessDisabled: true }), 'view_only');
});

test('источники политики: переменная, файл, испорченный файл', () => {
  const none = () => { throw Object.assign(new Error('нет'), { code: 'ENOENT' }); };
  assert.strictEqual(isFullAccessDisabled({ env: {}, paths: ['a'], readFile: none }), false);
  assert.strictEqual(isFullAccessDisabled({ env: { MYCHAT_RD_DISABLE_FULL: '1' }, paths: [], readFile: none }), true);
  assert.strictEqual(isFullAccessDisabled({ env: { MYCHAT_RD_DISABLE_FULL: '0' }, paths: [], readFile: none }), false);
  const files = { p: '\uFEFF{"disableRemoteFullAccess": true}' };
  assert.strictEqual(isFullAccessDisabled({ env: {}, paths: ['p'], readFile: (f) => files[f] }), true);
  assert.strictEqual(isFullAccessDisabled({ env: {}, paths: ['p'], readFile: () => '{"disableRemoteFullAccess": false}' }), false);
  assert.strictEqual(isFullAccessDisabled({ env: {}, paths: ['p'], readFile: () => '{oops' }), true, 'испорченный файл — запрет');
  const paths = policyPaths({ programData: 'C:\\ProgramData', userData: 'C:\\Users\\u\\AppData\\Roaming\\app' });
  assert.strictEqual(paths.length, 2);
  assert.ok(paths[0].endsWith(path.join('OpenMyChat Enterprise', 'policy.json')));
});

test('политика запрещает удалённый доступ целиком: переменная и файл', () => {
  const none = () => { throw Object.assign(new Error('нет'), { code: 'ENOENT' }); };
  assert.strictEqual(isRemoteDesktopDisabled({ env: {}, paths: ['a'], readFile: none }), false);
  assert.strictEqual(isRemoteDesktopDisabled({ env: { MYCHAT_RD_DISABLE: '1' }, paths: [], readFile: none }), true);
  assert.strictEqual(isRemoteDesktopDisabled({ env: { MYCHAT_RD_DISABLE: 'TRUE ' }, paths: [], readFile: none }), true);
  assert.strictEqual(isRemoteDesktopDisabled({ env: { MYCHAT_RD_DISABLE: '0' }, paths: [], readFile: none }), false);
  assert.strictEqual(isRemoteDesktopDisabled({ env: { MYCHAT_RD_DISABLE_FULL: '1' }, paths: [], readFile: none }), false, 'запрет полного доступа не отключает просмотр');
  assert.strictEqual(isRemoteDesktopDisabled({ env: {}, paths: ['p'], readFile: () => '﻿{"disableRemoteDesktop": true}' }), true);
  assert.strictEqual(isRemoteDesktopDisabled({ env: {}, paths: ['p'], readFile: () => '{"disableRemoteDesktop": "true"}' }), false, 'только настоящее true');
  assert.strictEqual(isRemoteDesktopDisabled({ env: {}, paths: ['p'], readFile: () => '{oops' }), true, 'испорченный файл — запрет');
  // Второй файл дополняет первый, а не отменяет его.
  const files = { a: '{"disableRemoteDesktop": true}', b: '{"disableRemoteDesktop": false}' };
  assert.strictEqual(isRemoteDesktopDisabled({ env: {}, paths: ['a', 'b'], readFile: (f) => files[f] }), true);
});

test('без удалённого доступа нет и полного', () => {
  const policy = readRdPolicy({ env: { MYCHAT_RD_DISABLE: 'yes' }, paths: [], readFile: () => '' });
  assert.deepStrictEqual(policy, { remoteDesktopDisabled: true, fullAccessDisabled: true });
  assert.strictEqual(isFullAccessDisabled({ env: {}, paths: ['p'], readFile: () => '{"disableRemoteDesktop": true}' }), true);
});

test('при запрете rd-session-start отвечает отказом policy без окна', () => {
  assert.deepStrictEqual(
    policyDecline({ remoteDesktopDisabled: true, fullAccessDisabled: true }),
    { accepted: false, accessLevel: null, reason: 'policy' }
  );
  assert.strictEqual(policyDecline({ remoteDesktopDisabled: false, fullAccessDisabled: true }), null);
  assert.strictEqual(policyDecline(null), null);

  // В main.js проверка политики стоит раньше окна согласия.
  const fs = require('node:fs');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('rd-session-start'"));
  const policyAt = handler.indexOf('policyDecline(');
  assert.ok(policyAt > 0, 'проверка политики есть');
  assert.ok(policyAt < handler.indexOf('buildConsentDialog('), 'и она раньше окна согласия');
  assert.ok(policyAt < handler.indexOf('askUser('));
});

test('при запрете сеанс не начинается — экран и ввод недоступны', () => {
  let blocked = true;
  const session = new HostSession({ isBlocked: () => blocked });
  assert.strictEqual(session.start({ sessionId: 's1', operatorName: 'X', accessLevel: 'full' }), false);
  assert.strictEqual(session.active, false);
  assert.strictEqual(session.allowsCapture, false);
  assert.strictEqual(session.allowsInput, false);

  const broken = new HostSession({ isBlocked: () => { throw new Error('EACCES'); } });
  assert.strictEqual(broken.start({ sessionId: 's1', accessLevel: 'full' }), false, 'политику не прочитать — отказ');

  blocked = false;
  assert.strictEqual(session.start({ sessionId: 's1', operatorName: 'X', accessLevel: 'full' }), true);
  assert.strictEqual(session.allowsInput, true);
  assert.strictEqual(new HostSession().start({ sessionId: 's2' }), true, 'без политики — как раньше');
});

test('окна буфера и файла: по умолчанию — отказ', () => {
  for (const opts of [buildClipboardDialog({ role: 'host', peerName: 'X' }), buildClipboardDialog({ role: 'operator' })]) {
    assert.strictEqual(opts.defaultId, 1);
    assert.strictEqual(opts.cancelId, 1);
  }
  const file = buildFileDialog({ operatorName: 'X', fileName: 'a.exe.txt', original: 'a.exe', renamed: true, sizeText: '1 Б' });
  assert.strictEqual(file.defaultId, 1);
  assert.strictEqual(file.cancelId, 1);
  assert.ok(file.detail.includes('a.exe.txt'));
});

test('имя оператора в системном окне очищается', () => {
  assert.strictEqual(HostSession.cleanName('Иванов\r\nПароль: 123'), 'ИвановПароль: 123');
  assert.strictEqual(HostSession.cleanName(''), 'оператор техподдержки');
});

// ── 2.3. Буфер обмена — только с согласия ──────────────────────────────────

function hostSessionWith(level) {
  const s = new HostSession();
  s.start({ sessionId: 'rd-1', operatorName: 'X', accessLevel: level });
  return s;
}

test('без сеанса и без согласия буфер сотрудника не читается', () => {
  const grants = new ClipboardGrants();
  assert.strictEqual(grants.hostAllowed(new HostSession(), 'rd-1'), false, 'нет сеанса');
  const full = hostSessionWith('full');
  assert.strictEqual(grants.canAskHost(full, 'rd-1'), true);
  assert.strictEqual(grants.hostAllowed(full, 'rd-1'), false, 'сеанс есть, согласия нет');
  grants.grantHost('rd-1');
  assert.strictEqual(grants.hostAllowed(full, 'rd-1'), true);
  assert.strictEqual(grants.hostAllowed(full, undefined), false, 'без идентификатора сеанса');
  assert.strictEqual(grants.hostAllowed(full, 'rd-2'), false, 'чужой сеанс');
});

test('просмотр не даёт буфера даже при отметке согласия', () => {
  const grants = new ClipboardGrants();
  const view = hostSessionWith('view_only');
  assert.strictEqual(grants.canAskHost(view, 'rd-1'), false);
  grants.grantHost('rd-1');
  assert.strictEqual(grants.hostAllowed(view, 'rd-1'), false);
});

test('согласие на буфер не переходит на следующий сеанс', () => {
  const grants = new ClipboardGrants();
  const s = hostSessionWith('full');
  grants.grantHost('rd-1');
  s.end();
  s.start({ sessionId: 'rd-2', operatorName: 'Y', accessLevel: 'full' });
  assert.strictEqual(grants.hostAllowed(s, 'rd-2'), false);
  grants.revokeHost();
  assert.strictEqual(grants.host, null);
});

test('согласие оператора привязано к окну, сеансу и сроку', () => {
  let now = 1000;
  const grants = new ClipboardGrants({ now: () => now });
  assert.strictEqual(grants.operatorAllowed(5, 'rd-1'), false);
  assert.strictEqual(grants.grantOperator(5, ''), false);
  grants.grantOperator(5, 'rd-1');
  assert.strictEqual(grants.operatorAllowed(5, 'rd-1'), true);
  assert.strictEqual(grants.operatorAllowed(6, 'rd-1'), false, 'другое окно');
  assert.strictEqual(grants.operatorAllowed(5, 'rd-2'), false, 'другой сеанс');
  assert.strictEqual(grants.revokeOperator(5, 'rd-2'), false, 'чужой сеанс не снимает согласие');
  now += OPERATOR_GRANT_TTL_MS + 1;
  assert.strictEqual(grants.operatorAllowed(5, 'rd-1'), false, 'срок истёк');
  grants.grantOperator(5, 'rd-1');
  grants.forgetWebContents(5);
  assert.strictEqual(grants.operatorAllowed(5, 'rd-1'), false, 'окно ушло со страницы');
});

// ── Раздел electron-updater: только https и только сервер обновлений ───────

test('фильтр раздела updater: https того же источника проходит, остальное — нет', () => {
  const { isUpdaterRequestAllowed } = require('../src/main/update-policy');
  const UPD = 'https://chat.centras.local';
  assert.strictEqual(isUpdaterRequestAllowed(UPD + '/updates/stable/latest.yml', UPD), true);
  assert.strictEqual(isUpdaterRequestAllowed(UPD + '/updates/stable/OpenMyChat-Enterprise-Setup-1.2.0.exe?x=1', UPD), true);
  assert.strictEqual(isUpdaterRequestAllowed(UPD + '/updates/policy.json?channel=stable', UPD), true);
  assert.strictEqual(isUpdaterRequestAllowed('http://chat.centras.local/updates/stable/latest.yml', UPD), false, 'http');
  assert.strictEqual(isUpdaterRequestAllowed('https://evil.com/setup.exe', UPD), false, 'чужой источник');
  assert.strictEqual(isUpdaterRequestAllowed('https://chat.centras.local.evil.com/x', UPD), false);
  assert.strictEqual(isUpdaterRequestAllowed('https://chat.centras.local:8443/x', UPD), false, 'другой порт');
  assert.strictEqual(isUpdaterRequestAllowed('https://updates.invalid/openmychat/latest.yml', UPD), false, 'заглушка из app-update.yml');
  assert.strictEqual(isUpdaterRequestAllowed('file:///C:/Windows/calc.exe', UPD), false);
  assert.strictEqual(isUpdaterRequestAllowed('ws://chat.centras.local/', UPD), false);
  assert.strictEqual(isUpdaterRequestAllowed(UPD + '/x', null), false, 'без адреса обновлений — ничего');
  assert.strictEqual(isUpdaterRequestAllowed(UPD + '/x', 'http://chat.centras.local'), false, 'http-источник обновлений не принимается');
  assert.strictEqual(isUpdaterRequestAllowed('not a url', UPD), false);
});

test('main.js ставит фильтр на раздел electron-updater до создания UpdateController', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const guardAt = main.indexOf("fromPartition('electron-updater'");
  assert.ok(guardAt > 0, 'раздел electron-updater получен в main.js');
  const guard = main.slice(guardAt, guardAt + 800);
  assert.match(guard, /onBeforeRequest/);
  assert.match(guard, /isUpdaterRequestAllowed/);
  const controllerAt = main.indexOf('new UpdateController(');
  assert.ok(controllerAt > 0, 'UpdateController создаётся');
  const whenReady = main.slice(main.indexOf('app.whenReady()'));
  assert.ok(whenReady.indexOf('installUpdaterSessionGuard(') > 0, 'фильтр ставится при старте');
  assert.ok(
    whenReady.indexOf('installUpdaterSessionGuard(') < whenReady.indexOf('startUpdater('),
    'фильтр — раньше запуска обновлений'
  );
});

test('IPC обновлений — только из главного окна, адрес скачивания — из состояния main', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  for (const channel of ['update-get-state', 'update-check', 'update-install', 'update-open-download', 'get-app-info']) {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, channel);
    const body = main.slice(at, at + 400);
    assert.match(body, /isFromServerPage\(event, \{ mainWindowOnly: true \}\)/, channel);
  }
  const open = main.slice(main.indexOf("ipcMain.handle('update-open-download'"));
  assert.match(open.slice(0, 400), /\(event\)\s*=>/, 'адрес от страницы не принимается вовсе');
});
