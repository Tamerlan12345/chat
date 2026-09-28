const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const {
  UpdateController,
  classifyUpdaterError,
  hasPublisherName,
  MANUAL_CHECK_MIN_INTERVAL_MS,
  RD_RECHECK_MS,
  MANDATORY_DELAY_MS
} = require('../src/main/updater');

const ORIGIN = 'https://chat.centras.local';
const STATE_PATH = 'C:\\Users\\u\\AppData\\Roaming\\OpenMyChat Enterprise\\update-state.json';
const APP_UPDATE_YML = [
  'provider: generic',
  'url: https://updates.invalid/openmychat/',
  'channel: latest',
  'publisherName:',
  '  - Centras Insurance (АО Сентрас Иншуранс)',
  'updaterCacheDirName: mychat-desktop-updater',
  ''
].join('\n');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeTimers(clock) {
  let seq = 0;
  const list = [];
  return {
    list,
    setTimeout(fn, ms) {
      const t = { id: ++seq, fn, ms, at: clock.now + ms };
      list.push(t);
      return t.id;
    },
    clearTimeout(id) {
      const i = list.findIndex((t) => t.id === id);
      if (i !== -1) list.splice(i, 1);
    },
    next() {
      return [...list].sort((a, b) => a.at - b.at)[0] || null;
    },
    // Срабатывает ближайший таймер; часы переводятся на его время.
    async fire() {
      const t = this.next();
      assert.ok(t, 'ожидался запланированный таймер');
      this.clearTimeout(t.id);
      clock.now = Math.max(clock.now, t.at);
      return t.fn();
    }
  };
}

function policy(overrides = {}) {
  return {
    enabled: true,
    channel: 'stable',
    offeredVersion: '1.2.0',
    mandatory: false,
    minVersion: null,
    message: 'Исправлена передача файлов',
    checkIntervalMinutes: 240,
    setupUrl: '/updates/stable/OpenMyChat-Enterprise-Setup-1.2.0.exe',
    portableUrl: '/updates/stable/OpenMyChat-Enterprise-Portable-1.2.0.exe',
    ...overrides
  };
}

function harness(opts = {}) {
  const clock = { now: 1_700_000_000_000 };
  const timers = fakeTimers(clock);
  const files = new Map(Object.entries(opts.files || {}));
  const calls = { fetch: [], check: 0, quit: [], notify: [], sent: [], setFeed: [], logs: [], opened: [], confirm: [], changes: 0, verify: [] };

  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = () => {
    calls.check += 1;
    // Настоящий промис electron-updater; события тест посылает сам.
    return opts.checkResult ? opts.checkResult() : new Promise(() => {});
  };
  autoUpdater.setFeedURL = (o) => calls.setFeed.push(o);
  autoUpdater.quitAndInstall = (...args) => calls.quit.push({ args, isQuitting: app.isQuitting });

  const app = { isQuitting: false, getVersion: () => opts.version || '1.1.0' };
  const hostSession = { active: false };
  let respond = opts.respond || (() => ({ status: 200, body: policy() }));

  const controller = new UpdateController({
    autoUpdater,
    app,
    config: { updates: { enabled: opts.enabled ?? true, channel: opts.channel || 'stable' } },
    kind: opts.kind || 'nsis',
    serverOrigin: opts.serverOrigin || ORIGIN,
    log: (m) => calls.logs.push(m),
    notify: (n) => calls.notify.push(n),
    sendToRenderer: (s) => calls.sent.push(s),
    onStateChange: () => { calls.changes += 1; },
    hostSession,
    fetchJson: async (url, { headers } = {}) => {
      calls.fetch.push({ url, headers: { ...headers } });
      const r = respond(url);
      if (r instanceof Error) throw r;
      return r;
    },
    statePath: STATE_PATH,
    readFile: (f) => {
      if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(f);
    },
    writeFile: (f, text) => files.set(f, text),
    now: () => clock.now,
    timers,
    readAppUpdateYml: opts.readAppUpdateYml || (() => APP_UPDATE_YML),
    verify: opts.verify || (async () => null),
    rand: () => 0.5,
    openExternal: (url) => calls.opened.push(url),
    confirmMandatory: (info) => {
      calls.confirm.push(info);
      return opts.confirm ? opts.confirm(info) : Promise.resolve('later');
    }
  });

  return {
    controller,
    autoUpdater,
    app,
    hostSession,
    clock,
    timers,
    files,
    calls,
    setRespond(fn) { respond = fn; },
    savedState() { return JSON.parse(files.get(STATE_PATH)); }
  };
}

const tick = () => new Promise((r) => setImmediate(r));

// ── Выключено / не поддерживается / сборка настроена неверно ────────────────

test('выключенный конфиг → ни одного запроса и ни одного таймера', async () => {
  const h = harness({ enabled: false });
  h.controller.start();
  assert.strictEqual(h.controller.getState().status, 'disabled');
  assert.strictEqual(h.timers.list.length, 0);
  assert.strictEqual(h.calls.setFeed.length, 0);
  const r = await h.controller.checkNow({ userInitiated: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.calls.fetch.length, 0);
  assert.strictEqual(h.calls.check, 0);
});

test('разработка → unsupported, проверок нет', async () => {
  const h = harness({ kind: 'dev' });
  h.controller.start();
  assert.strictEqual(h.controller.getState().status, 'unsupported');
  assert.strictEqual(h.timers.list.length, 0);
});

test('сервер не по https → проверок нет', async () => {
  const h = harness({ serverOrigin: 'http://chat.centras.local' });
  h.controller.start();
  assert.strictEqual(h.controller.getState().status, 'unsupported');
  assert.strictEqual(h.timers.list.length, 0);
  assert.strictEqual(h.calls.setFeed.length, 0);
});

test('нет publisherName в app-update.yml → build-misconfigured, checkForUpdates не вызывается', async () => {
  for (const readAppUpdateYml of [
    () => 'provider: generic\nurl: https://updates.invalid/openmychat/\n',
    () => { throw new Error('ENOENT app-update.yml'); },
    () => 'publisherName:\nupdaterCacheDirName: x\n'
  ]) {
    const h = harness({ readAppUpdateYml });
    h.controller.start();
    const s = h.controller.getState();
    assert.strictEqual(s.status, 'error');
    assert.strictEqual(s.error, 'build-misconfigured');
    assert.strictEqual(h.timers.list.length, 0);
    assert.strictEqual(h.calls.setFeed.length, 0);
    const r = await h.controller.checkNow({ userInitiated: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(h.calls.check, 0);
    assert.strictEqual(h.calls.fetch.length, 0);
  }
});

test('hasPublisherName', () => {
  assert.strictEqual(hasPublisherName(APP_UPDATE_YML), true);
  assert.strictEqual(hasPublisherName('publisherName: Centras\n'), true);
  assert.strictEqual(hasPublisherName("publisherName: ''\n"), false);
  assert.strictEqual(hasPublisherName('publisherName: []\n'), false);
  assert.strictEqual(hasPublisherName('# publisherName: x\n'), false);
  assert.strictEqual(hasPublisherName(''), false);
  assert.strictEqual(hasPublisherName(null), false);
});

// ── Настройка electron-updater ─────────────────────────────────────────────

test('nsis: electron-updater настроен до первой проверки', async () => {
  const h = harness();
  h.controller.start();
  const u = h.autoUpdater;
  assert.strictEqual(u.autoDownload, true);
  assert.strictEqual(u.autoInstallOnAppQuit, true);
  assert.strictEqual(u.allowDowngrade, false);
  assert.strictEqual(u.allowPrerelease, false);
  assert.strictEqual(u.disableWebInstaller, true);
  assert.strictEqual(typeof u.verifyUpdateCodeSignature, 'function');
  assert.strictEqual(h.calls.setFeed.length, 1);
  assert.deepStrictEqual(h.calls.setFeed[0], {
    provider: 'generic',
    url: 'https://chat.centras.local/updates/stable/',
    channel: 'latest',
    useMultipleRangeRequest: false
  });
  assert.strictEqual(h.calls.check, 0, 'сразу после старта — ничего не скачивается');
  assert.strictEqual(h.calls.fetch.length, 0);
});

test('канал beta разрешает пререлизы', () => {
  const h = harness({ channel: 'beta' });
  h.controller.start();
  assert.strictEqual(h.autoUpdater.allowPrerelease, true);
  assert.strictEqual(h.calls.setFeed[0].url, 'https://chat.centras.local/updates/beta/');
});

test('installId создаётся один раз и хранится в update-state.json', async () => {
  const h = harness();
  h.controller.start();
  const saved = h.savedState();
  assert.match(saved.installId, UUID_V4);

  const again = harness({ files: { [STATE_PATH]: JSON.stringify({ installId: saved.installId, lastError: 'network' }) } });
  again.controller.start();
  assert.strictEqual(again.savedState().installId, saved.installId);

  const broken = harness({ files: { [STATE_PATH]: '{oops' } });
  broken.controller.start();
  assert.match(broken.savedState().installId, UUID_V4);
});

// ── Цикл проверки ──────────────────────────────────────────────────────────

test('первая проверка через 60–300 с; политика ничего не предлагает → checkForUpdates нет', async () => {
  const h = harness({ respond: () => ({ status: 200, body: policy({ offeredVersion: null, setupUrl: null, portableUrl: null }) }) });
  h.controller.start();
  const first = h.timers.next();
  assert.ok(first.ms >= 60_000 && first.ms <= 300_000, String(first.ms));
  await h.timers.fire();
  assert.strictEqual(h.calls.fetch.length, 1);
  assert.strictEqual(h.calls.fetch[0].url, 'https://chat.centras.local/updates/policy.json?channel=stable');
  assert.strictEqual(h.calls.check, 0);
  assert.strictEqual(h.controller.getState().status, 'idle');
  const next = h.timers.next();
  assert.ok(next.ms >= 240 * 60_000 * 0.85 && next.ms <= 240 * 60_000 * 1.15, String(next.ms));
});

test('предложена та же или старая версия → checkForUpdates нет', async () => {
  for (const offeredVersion of ['1.1.0', '1.0.9']) {
    const h = harness({ respond: () => ({ status: 200, body: policy({ offeredVersion }) }) });
    h.controller.start();
    await h.timers.fire();
    assert.strictEqual(h.calls.check, 0, offeredVersion);
    assert.strictEqual(h.controller.getState().status, 'idle');
  }
});

test('обновления выключены на сервере или старый сервер без /updates → idle', async () => {
  for (const respond of [() => ({ status: 200, body: policy({ enabled: false }) }), () => ({ status: 404, body: null })]) {
    const h = harness({ respond });
    h.controller.start();
    await h.timers.fire();
    assert.strictEqual(h.calls.check, 0);
    assert.strictEqual(h.controller.getState().status, 'idle');
    assert.strictEqual(h.controller.getState().error, null);
  }
});

test('предложено новее → checkForUpdates с заголовками installId/версии/вида', async () => {
  const h = harness();
  h.controller.start();
  await h.timers.fire();
  const { installId } = h.savedState();
  const policyHeaders = h.calls.fetch[0].headers;
  assert.strictEqual(policyHeaders['X-MyChat-Install-Id'], installId);
  assert.strictEqual(policyHeaders['X-MyChat-Client-Version'], '1.1.0');
  assert.strictEqual(policyHeaders['X-MyChat-Install-Kind'], 'nsis');
  assert.ok(!('X-MyChat-Update-Error' in policyHeaders));

  assert.strictEqual(h.calls.check, 1);
  assert.deepStrictEqual(h.autoUpdater.requestHeaders, {
    'X-MyChat-Install-Id': installId,
    'X-MyChat-Client-Version': '1.1.0',
    'X-MyChat-Install-Kind': 'nsis'
  });
  assert.strictEqual(h.controller.getState().status, 'checking');
});

test('события electron-updater → состояние, интерфейс, трей, уведомление', async () => {
  const h = harness();
  h.controller.start();
  await h.timers.fire();
  const u = h.autoUpdater;

  u.emit('checking-for-update');
  assert.strictEqual(h.controller.getState().status, 'checking');

  u.emit('update-available', { version: '1.2.0' });
  let s = h.controller.getState();
  assert.strictEqual(s.status, 'downloading');
  assert.strictEqual(s.offeredVersion, '1.2.0');
  assert.strictEqual(s.progress, 0);

  u.emit('download-progress', { percent: 42.6, transferred: 1, total: 2 });
  assert.strictEqual(h.controller.getState().progress, 43);

  u.emit('update-downloaded', { version: '1.2.0' });
  u.emit('update-downloaded', { version: '1.2.0' }); // electron-updater шлёт дважды
  s = h.controller.getState();
  assert.strictEqual(s.status, 'downloaded');
  assert.strictEqual(s.progress, 100);
  assert.strictEqual(s.mandatory, false);
  assert.strictEqual(s.message, 'Исправлена передача файлов');
  assert.strictEqual(s.kind, 'nsis');
  assert.strictEqual(s.currentVersion, '1.1.0');
  assert.strictEqual(s.downloadUrl, null, 'nsis ставится сам, ссылка не нужна');

  assert.strictEqual(h.calls.notify.length, 1);
  assert.match(h.calls.notify[0].body, /1\.2\.0/);
  assert.ok(h.calls.changes > 0, 'трей узнаёт о смене состояния');
  const statuses = h.calls.sent.map((x) => x.status);
  for (const st of ['checking', 'downloading', 'downloaded']) assert.ok(statuses.includes(st), st);
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'currentVersion', 'downloadUrl', 'error', 'kind', 'mandatory', 'message', 'offeredVersion', 'progress', 'status'
  ]);
  assert.strictEqual(h.timers.list.length, 0, 'после скачивания проверки не нужны');
});

test('update-not-available и 404 на latest.yml → idle, не ошибка', async () => {
  const h = harness({ files: { [STATE_PATH]: JSON.stringify({ installId: '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b', lastError: 'network' }) } });
  h.controller.start();
  await h.timers.fire();
  const notFound = Object.assign(new Error('Cannot find channel "latest.yml" update info: HttpError: 404'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
  h.autoUpdater.emit('error', notFound);
  const s = h.controller.getState();
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.error, null);
  assert.strictEqual(h.savedState().lastError, null, 'успешная проверка снимает прошлую ошибку');
  assert.ok(h.timers.next().ms >= 240 * 60_000 * 0.85, 'дальше — обычный интервал');

  await h.timers.fire();
  h.autoUpdater.emit('update-not-available', { version: '1.1.0' });
  assert.strictEqual(h.controller.getState().status, 'idle');
});

test('ошибка сети → задержка, lastError сохранён и уходит в следующем запросе', async () => {
  const h = harness({ respond: () => new Error('net::ERR_CONNECTION_REFUSED') });
  h.controller.start();
  await h.timers.fire();
  let s = h.controller.getState();
  assert.strictEqual(s.status, 'error');
  assert.strictEqual(s.error, 'network');
  assert.strictEqual(h.savedState().lastError, 'network');
  const backoff1 = h.timers.next().ms;
  assert.ok(backoff1 >= 60_000 && backoff1 < 240 * 60_000 * 0.85, String(backoff1));

  await h.timers.fire();
  assert.strictEqual(h.calls.fetch[1].headers['X-MyChat-Update-Error'], 'network');
  const backoff2 = h.timers.next().ms;
  assert.ok(backoff2 > backoff1, `${backoff2} > ${backoff1}`);

  // Сеть вернулась: ошибка ушла на сервер в заголовке, после успеха снимается.
  h.setRespond(() => ({ status: 200, body: policy({ offeredVersion: null }) }));
  await h.timers.fire();
  assert.strictEqual(h.calls.fetch[2].headers['X-MyChat-Update-Error'], 'network');
  s = h.controller.getState();
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(h.savedState().lastError, null);
  assert.ok(h.timers.next().ms >= 240 * 60_000 * 0.85, 'задержка сброшена');
});

test('5xx и 429 на policy.json — ошибки с задержкой', async () => {
  for (const [status, code] of [[503, 'http-5xx'], [500, 'http-5xx'], [429, 'network']]) {
    const h = harness({ respond: () => ({ status, body: null }) });
    h.controller.start();
    await h.timers.fire();
    assert.strictEqual(h.controller.getState().error, code, String(status));
    assert.strictEqual(h.calls.check, 0);
  }
});

test('ошибки electron-updater классифицируются, код уходит в заголовке следующей проверки', async () => {
  const h = harness();
  h.controller.start();
  await h.timers.fire();
  h.autoUpdater.emit('update-available', { version: '1.2.0' });
  h.autoUpdater.emit('error', Object.assign(new Error('sha512 checksum mismatch, expected x, got y'), { code: 'ERR_CHECKSUM_MISMATCH' }));
  assert.strictEqual(h.controller.getState().status, 'error');
  assert.strictEqual(h.controller.getState().error, 'sha512');
  assert.strictEqual(h.savedState().lastError, 'sha512');
  await h.timers.fire();
  assert.strictEqual(h.calls.fetch[1].headers['X-MyChat-Update-Error'], 'sha512');
  assert.strictEqual(h.autoUpdater.requestHeaders['X-MyChat-Update-Error'], 'sha512');
});

test('classifyUpdaterError', () => {
  const notFound = { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', message: '' };
  assert.strictEqual(classifyUpdaterError(notFound), null);
  assert.strictEqual(classifyUpdaterError({ statusCode: 404, message: 'HttpError: 404' }), null);
  assert.strictEqual(classifyUpdaterError({ code: 'ERR_CHECKSUM_MISMATCH', message: '' }), 'sha512');
  assert.strictEqual(classifyUpdaterError({ statusCode: 503, message: '' }), 'http-5xx');
  assert.strictEqual(classifyUpdaterError({ statusCode: 429, message: '' }), 'network');
  assert.strictEqual(classifyUpdaterError(new Error('Cannot download "https://x/y.exe", status 503: Service Unavailable')), 'http-5xx');
  assert.strictEqual(classifyUpdaterError(new Error('net::ERR_INTERNET_DISCONNECTED')), 'network');
  assert.strictEqual(classifyUpdaterError({ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'not signed' }, 'signature-foreign'), 'signature-foreign');
  assert.strictEqual(classifyUpdaterError({ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'not signed' }), 'signature-untrusted');
  assert.strictEqual(classifyUpdaterError(new Error('что-то странное')), 'update-failed');
  assert.strictEqual(classifyUpdaterError(undefined), 'update-failed');
});

test('проверка подписи: своя, с версией из yml; сбой проверки — отказ', async () => {
  const seen = [];
  let answer = null;
  const h = harness({
    verify: async (file, o) => {
      seen.push({ file, ...o });
      if (answer instanceof Error) throw answer;
      return answer;
    }
  });
  h.controller.start();
  await h.timers.fire();
  h.autoUpdater.emit('update-available', { version: '1.2.0' });
  const verifyFn = h.autoUpdater.verifyUpdateCodeSignature;

  assert.strictEqual(await verifyFn(['Centras Insurance (АО Сентрас Иншуранс)'], 'C:\\t\\setup.exe'), null);
  assert.deepStrictEqual(seen[0], { file: 'C:\\t\\setup.exe', expectedVersion: '1.2.0', currentVersion: '1.1.0' });

  answer = 'signature-foreign';
  assert.strictEqual(await verifyFn([], 'C:\\t\\setup.exe'), 'signature-foreign');
  h.autoUpdater.emit('error', Object.assign(new Error('New version 1.2.0 is not signed by the application owner: signature-foreign'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }));
  assert.strictEqual(h.controller.getState().error, 'signature-foreign');
  assert.strictEqual(h.savedState().lastError, 'signature-foreign');

  answer = new Error('boom');
  const failed = await verifyFn([], 'C:\\t\\setup.exe');
  assert.strictEqual(typeof failed, 'string', 'исключение превращается в отказ, а не в «ок»');
  assert.ok(failed.length > 0);
});

test('промисы electron-updater не падают необработанными', async () => {
  const h = harness({
    checkResult: () => Promise.resolve({ downloadPromise: Promise.reject(new Error('download failed')) })
  });
  h.controller.start();
  await h.timers.fire();
  await tick();
  await tick();
  // Результат без событий — не зависаем в «checking».
  const failing = harness({ checkResult: () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')) });
  failing.controller.start();
  await failing.timers.fire();
  await tick();
  assert.strictEqual(failing.controller.getState().status, 'error');
  assert.strictEqual(failing.controller.getState().error, 'network');
  const nothing = harness({ checkResult: () => Promise.resolve(null) });
  nothing.controller.start();
  await nothing.timers.fire();
  await tick();
  assert.strictEqual(nothing.controller.getState().status, 'idle');
  assert.ok(nothing.timers.next(), 'следующая проверка запланирована');
});

// ── portable / копия / Program Files ───────────────────────────────────────

test('portable: только уведомление со ссылкой на portable-сборку', async () => {
  const h = harness({ kind: 'portable' });
  h.controller.start();
  assert.strictEqual(h.calls.setFeed.length, 0);
  await h.timers.fire();
  assert.strictEqual(h.calls.check, 0);
  const s = h.controller.getState();
  assert.strictEqual(s.status, 'available');
  assert.strictEqual(s.offeredVersion, '1.2.0');
  assert.strictEqual(s.downloadUrl, 'https://chat.centras.local/updates/stable/OpenMyChat-Enterprise-Portable-1.2.0.exe');
  assert.strictEqual(h.calls.fetch[0].headers['X-MyChat-Install-Kind'], 'portable');
  assert.strictEqual(h.controller.openDownload(), true);
  assert.deepStrictEqual(h.calls.opened, [s.downloadUrl]);
  assert.strictEqual(h.calls.notify.length, 1, 'сотрудник узнаёт о новой версии');
});

test('копия и Program Files: ссылка на установщик; без portable — тоже установщик', async () => {
  for (const kind of ['copy', 'nsis-machine']) {
    const h = harness({ kind });
    h.controller.start();
    await h.timers.fire();
    assert.strictEqual(h.calls.check, 0);
    assert.strictEqual(h.controller.getState().downloadUrl, 'https://chat.centras.local/updates/stable/OpenMyChat-Enterprise-Setup-1.2.0.exe', kind);
  }
  const noPortable = harness({ kind: 'portable', respond: () => ({ status: 200, body: policy({ portableUrl: null }) }) });
  noPortable.controller.start();
  await noPortable.timers.fire();
  assert.strictEqual(noPortable.controller.getState().downloadUrl, 'https://chat.centras.local/updates/stable/OpenMyChat-Enterprise-Setup-1.2.0.exe');
});

test('ссылка на чужой сервер из policy.json не принимается', async () => {
  const h = harness({ kind: 'copy', respond: () => ({ status: 200, body: policy({ setupUrl: 'https://evil.com/setup.exe' }) }) });
  h.controller.start();
  await h.timers.fire();
  assert.strictEqual(h.controller.getState().downloadUrl, null);
  assert.strictEqual(h.controller.openDownload(), false);
  assert.deepStrictEqual(h.calls.opened, []);
});

test('openDownload без предложенной версии ничего не открывает', () => {
  const h = harness({ kind: 'copy' });
  h.controller.start();
  assert.strictEqual(h.controller.openDownload(), false);
  assert.deepStrictEqual(h.calls.opened, []);
});

// ── Установка ──────────────────────────────────────────────────────────────

async function downloaded(opts = {}) {
  const h = harness(opts);
  h.controller.start();
  await h.timers.fire();
  h.autoUpdater.emit('update-available', { version: '1.2.0' });
  // electron-updater 6.8.9 посылает update-downloaded дважды подряд
  // (AppUpdater.dispatchUpdateDownloaded) — обработчик обязан это выдержать.
  h.autoUpdater.emit('update-downloaded', { version: '1.2.0' });
  h.autoUpdater.emit('update-downloaded', { version: '1.2.0' });
  return h;
}

test('installNow отклоняется не из downloaded', async () => {
  const h = harness();
  h.controller.start();
  assert.strictEqual(h.controller.installNow().ok, false);
  await h.timers.fire();
  h.autoUpdater.emit('update-available', { version: '1.2.0' });
  const r = h.controller.installNow();
  assert.deepStrictEqual(r, { ok: false, reason: 'not-downloaded' });
  assert.strictEqual(h.calls.quit.length, 0);
  assert.strictEqual(h.app.isQuitting, false);
});

test('installNow во время сеанса удалённого стола откладывается', async () => {
  const h = await downloaded();
  h.hostSession.active = true;
  assert.deepStrictEqual(h.controller.installNow(), { ok: false, reason: 'remote-session' });
  assert.strictEqual(h.calls.quit.length, 0);
  assert.strictEqual(h.app.isQuitting, false);
  h.hostSession.active = false;
  assert.deepStrictEqual(h.controller.installNow(), { ok: true });
});

test('installNow ставит isQuitting до quitAndInstall(true, true)', async () => {
  const h = await downloaded();
  assert.deepStrictEqual(h.controller.installNow(), { ok: true });
  assert.strictEqual(h.calls.quit.length, 1);
  assert.deepStrictEqual(h.calls.quit[0].args, [true, true]);
  assert.strictEqual(h.calls.quit[0].isQuitting, true, 'окно не прячется в трей вместо выхода');
  assert.strictEqual(h.controller.installNow().ok, false, 'повторный вызов ничего не делает');
  assert.strictEqual(h.calls.quit.length, 1);
});

test('обязательное обновление: ждёт конца сеанса, одна отсрочка, затем установка', async () => {
  let answer;
  const h = harness({
    respond: () => ({ status: 200, body: policy({ mandatory: true }) }),
    confirm: () => new Promise((r) => { answer = r; })
  });
  h.controller.start();
  await h.timers.fire();
  h.autoUpdater.emit('update-available', { version: '1.2.0' });
  // Скачано во время сеанса — окно не показывается.
  h.hostSession.active = true;
  h.autoUpdater.emit('update-downloaded', { version: '1.2.0' });
  h.autoUpdater.emit('update-downloaded', { version: '1.2.0' });
  assert.strictEqual(h.controller.getState().mandatory, true);
  await tick();
  assert.strictEqual(h.calls.confirm.length, 0);
  assert.strictEqual(h.timers.list.length, 1, 'один таймер перепроверки, а не два');

  // Перепроверка раз в 60 с, пока идёт сеанс.
  assert.strictEqual(RD_RECHECK_MS, 60_000);
  let t = h.timers.next();
  assert.strictEqual(t.ms, RD_RECHECK_MS);
  await h.timers.fire();
  assert.strictEqual(h.calls.confirm.length, 0);
  assert.strictEqual(h.calls.quit.length, 0);
  t = h.timers.next();
  assert.strictEqual(t.ms, RD_RECHECK_MS);

  // Сеанс кончился — вопрос с отсчётом.
  h.hostSession.active = false;
  await h.timers.fire();
  assert.strictEqual(h.calls.confirm.length, 1);
  assert.strictEqual(h.calls.confirm[0].version, '1.2.0');
  assert.strictEqual(MANDATORY_DELAY_MS, 5 * 60_000);
  assert.strictEqual(h.timers.next().ms, MANDATORY_DELAY_MS);

  answer('later');
  await tick();
  assert.strictEqual(h.calls.quit.length, 0, '«Через 5 минут» — не сейчас');
  await h.timers.fire();
  assert.strictEqual(h.calls.quit.length, 1, 'через 5 минут — установка без второго вопроса');
  assert.strictEqual(h.calls.confirm.length, 1);
  assert.deepStrictEqual(h.calls.quit[0].args, [true, true]);
});

test('обязательное обновление: «Перезапустить сейчас»', async () => {
  const h = await downloaded({
    respond: () => ({ status: 200, body: policy({ mandatory: true }) }),
    confirm: async () => 'now'
  });
  await tick();
  await tick();
  assert.strictEqual(h.calls.confirm.length, 1);
  assert.strictEqual(h.calls.quit.length, 1);
});

test('обязательное обновление: к концу отсчёта начался сеанс — ждём его конца', async () => {
  const h = await downloaded({
    respond: () => ({ status: 200, body: policy({ mandatory: true }) }),
    confirm: async () => 'later'
  });
  await tick();
  h.hostSession.active = true;
  await h.timers.fire();
  assert.strictEqual(h.calls.quit.length, 0);
  assert.strictEqual(h.timers.next().ms, RD_RECHECK_MS);
  h.hostSession.active = false;
  await h.timers.fire();
  assert.strictEqual(h.calls.quit.length, 1);
  assert.strictEqual(h.calls.confirm.length, 1, 'отсрочка одна — второй раз не спрашиваем');
});

// ── Ручная проверка ────────────────────────────────────────────────────────

test('checkNow не чаще раза в минуту', async () => {
  const h = harness({ respond: () => ({ status: 200, body: policy({ offeredVersion: null }) }) });
  h.controller.start();
  assert.strictEqual(MANUAL_CHECK_MIN_INTERVAL_MS, 60_000);
  const first = await h.controller.checkNow({ userInitiated: true });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.state.status, 'idle');
  assert.strictEqual(h.calls.fetch.length, 1);

  h.clock.now += 30_000;
  const second = await h.controller.checkNow({ userInitiated: true });
  assert.deepStrictEqual({ ok: second.ok, reason: second.reason }, { ok: false, reason: 'rate-limited' });
  assert.strictEqual(h.calls.fetch.length, 1);

  h.clock.now += 31_000;
  const third = await h.controller.checkNow({ userInitiated: true });
  assert.strictEqual(third.ok, true);
  assert.strictEqual(h.calls.fetch.length, 2);
});

test('checkNow во время скачивания и после него ничего не запускает', async () => {
  const h = await downloaded();
  const r = await h.controller.checkNow({ userInitiated: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.calls.fetch.length, 1);
  assert.strictEqual(h.calls.check, 1);
});

test('stop снимает таймеры', () => {
  const h = harness();
  h.controller.start();
  assert.ok(h.timers.list.length > 0);
  h.controller.stop();
  assert.strictEqual(h.timers.list.length, 0);
});

test('updater.js загружается без Electron', () => {
  // main.js подключает его после создания окна, тесты — в чистом Node.
  const mod = require('../src/main/updater');
  assert.strictEqual(typeof mod.UpdateController, 'function');
});
