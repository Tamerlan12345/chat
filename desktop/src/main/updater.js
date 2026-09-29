// Автообновление оболочки Electron с сервера компании.
//
// Интерфейс (React) и так приходит с сервера при каждом выкате; обновлять
// нужно только сам exe. Порядок:
//  1. GET /updates/policy.json — предлагает ли сервер этой машине версию
//     (поэтапная раздача решается на сервере по installId);
//  2. установка NSIS «для пользователя» (kind 'nsis') — electron-updater
//     скачивает latest.yml и установщик, sha512 сверяет он, подпись — наша
//     проверка (update-verify.js); остальные виды установки обновить себя не
//     могут — только уведомление со ссылкой на скачивание;
//  3. скачано — пункт трея, системное уведомление и событие в интерфейс;
//     ставится при выходе из приложения или по «Перезапустить и обновить».
//     Обязательное обновление — с отсчётом и одной отсрочкой, но никогда во
//     время сеанса удалённого стола.
//
// Electron здесь не подключается: всё, что от него нужно, передаётся в
// конструктор (тесты — в обычном Node, с поддельным autoUpdater).

const crypto = require('node:crypto');
const {
  compareVersions,
  isValidVersion,
  updateCapability,
  updateBaseUrl,
  feedOptions,
  requestHeaders,
  resolveDownloadUrl,
  nextCheckDelay,
  normalizeChannel
} = require('./update-policy');
const { verifyInstaller } = require('./update-verify');

const MANUAL_CHECK_MIN_INTERVAL_MS = 60_000;
const RD_RECHECK_MS = 60_000;
const MANDATORY_DELAY_MS = 5 * 60_000;
const POLICY_TIMEOUT_MS = 20_000;
const MESSAGE_MAX = 500;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[a-z0-9-]{1,32}$/;

// Без publisherName в app-update.yml electron-updater пропускает проверку
// подписи целиком (NsisUpdater.verifySignature) — такой сборке нельзя
// разрешать ставить что бы то ни было.
function hasPublisherName(yml) {
  if (typeof yml !== 'string') return false;
  const m = yml.match(/^publisherName:[ \t]*(.*)$/m);
  if (!m) return false;
  const inline = m[1].trim();
  if (inline) return !/^(''|""|\[\s*\]|null|~)$/.test(inline);
  // Список на следующих строках: «  - Centras Insurance …».
  const after = yml.slice(m.index + m[0].length);
  return /^\r?\n[ \t]+-[ \t]*\S/.test(after);
}

/**
 * Код ошибки electron-updater для журнала, состояния и заголовка
 * X-MyChat-Update-Error. null — это не ошибка, а «обновлений нет» (404 на
 * latest.yml: сервер не включил эту машину в раздачу).
 */
function classifyUpdaterError(err, verifyCode = null) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = err && typeof err.message === 'string' ? err.message : String(err || '');
  const status = err && Number.isInteger(err.statusCode) ? err.statusCode : null;
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || status === 404) return null;
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return verifyCode || 'signature-untrusted';
  if (code === 'ERR_CHECKSUM_MISMATCH' || /sha512 checksum mismatch/i.test(message)) return 'sha512';
  const httpStatus = status || Number((message.match(/\bstatus (\d{3})\b/) || [])[1]) || null;
  if (httpStatus === 429) return 'network';
  if (httpStatus >= 500 && httpStatus <= 599) return 'http-5xx';
  if (/net::ERR_|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message) || /^(ECONN|ENOTFOUND|ETIMEDOUT)/.test(code)) {
    return 'network';
  }
  return 'update-failed';
}

// Пути Windows сравниваются без учёта регистра.
function fileKey(file) {
  return String(file).replace(/\//g, '\\').toLowerCase();
}

function normalizePolicy(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const offered = isValidVersion(body.offeredVersion) ? body.offeredVersion : null;
  const message = typeof body.message === 'string' && body.message.trim() ? body.message.slice(0, MESSAGE_MAX) : null;
  return {
    enabled: body.enabled === true,
    offeredVersion: offered,
    mandatory: body.mandatory === true,
    message,
    checkIntervalMinutes: Number.isFinite(body.checkIntervalMinutes) ? body.checkIntervalMinutes : undefined,
    setupUrl: typeof body.setupUrl === 'string' ? body.setupUrl : null,
    portableUrl: typeof body.portableUrl === 'string' ? body.portableUrl : null
  };
}

class UpdateController {
  constructor({
    autoUpdater,
    app,
    config,
    kind,
    serverOrigin,
    log = () => {},
    notify = () => {},
    sendToRenderer = () => {},
    onStateChange = () => {},
    hostSession = null,
    fetchJson,
    statePath,
    readFile,
    writeFile,
    now = () => Date.now(),
    timers = { setTimeout, clearTimeout },
    readAppUpdateYml = () => null,
    verify = verifyInstaller,
    rand = Math.random,
    randomUUID = () => crypto.randomUUID(),
    openExternal = () => {},
    confirmMandatory = async () => 'later'
  } = {}) {
    this.autoUpdater = autoUpdater;
    this.app = app;
    this.kind = kind;
    this.capability = updateCapability(kind);
    this.enabled = Boolean(config?.updates?.enabled);
    this.channel = normalizeChannel(config?.updates?.channel);
    this.serverOrigin = serverOrigin;
    this.baseUrl = updateBaseUrl({ serverOrigin, channel: this.channel });
    this.deps = { log, notify, sendToRenderer, onStateChange, fetchJson, statePath, readFile, writeFile, now, timers, readAppUpdateYml, verify, rand, randomUUID, openExternal, confirmMandatory };
    this.hostSession = hostSession;
    this.currentVersion = String(app?.getVersion?.() || '0.0.0');

    this.state = {
      status: 'idle',
      currentVersion: this.currentVersion,
      offeredVersion: null,
      progress: null,
      mandatory: false,
      message: null,
      kind,
      error: null,
      downloadUrl: null
    };
    this.persisted = { installId: null, lastCheckAt: null, lastError: null };
    this.checkTimer = null;
    this.mandatoryTimer = null;
    this.failures = 0;
    this.intervalMin = undefined;
    this.lastManualCheckAt = null;
    this.checkInFlight = null;
    this.downloadVersion = null;
    this.lastVerifyError = null;
    this.mandatoryAsked = false;
    this.mandatoryAbort = null;
    this.installing = false;
    this.verifiedFiles = new Set();
    this.downloadedFile = null;
    this.downloadedCheck = null;
    this.started = false;
    this.stopped = false;
  }

  // ── Состояние ────────────────────────────────────────────────────────────

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    try { this.deps.sendToRenderer(snapshot); } catch (err) { this.deps.log(`update-status send failed: ${err.message}`); }
    try { this.deps.onStateChange(snapshot); } catch (err) { this.deps.log(`update state listener failed: ${err.message}`); }
  }

  loadPersisted() {
    let saved = null;
    try {
      saved = JSON.parse(String(this.deps.readFile(this.deps.statePath)).replace(/^﻿/, ''));
    } catch {
      saved = null;
    }
    const installId = saved && typeof saved.installId === 'string' && UUID_V4.test(saved.installId) ? saved.installId.toLowerCase() : null;
    this.persisted = {
      installId: installId || this.deps.randomUUID(),
      lastCheckAt: saved && typeof saved.lastCheckAt === 'string' ? saved.lastCheckAt : null,
      lastError: saved && typeof saved.lastError === 'string' && ERROR_CODE.test(saved.lastError) ? saved.lastError : null
    };
    if (!installId) this.savePersisted();
  }

  savePersisted(patch = {}) {
    this.persisted = { ...this.persisted, ...patch };
    try {
      this.deps.writeFile(this.deps.statePath, JSON.stringify(this.persisted, null, 2));
    } catch (err) {
      this.deps.log(`update-state.json not written: ${err.message}`);
    }
  }

  headers() {
    return requestHeaders({
      installId: this.persisted.installId,
      version: this.currentVersion,
      kind: this.kind,
      lastError: this.persisted.lastError
    });
  }

  // ── Запуск ───────────────────────────────────────────────────────────────

  start() {
    if (this.started) return;
    this.started = true;

    if (this.capability === 'none') {
      this.setState({ status: 'unsupported' });
      this.deps.log(`updates: not supported for install kind ${this.kind}`);
      return;
    }
    if (!this.enabled) {
      this.setState({ status: 'disabled' });
      this.deps.log('updates: disabled on this machine (policy UpdatesEnabled=0)');
      return;
    }
    if (!this.baseUrl) {
      this.setState({ status: 'unsupported' });
      this.deps.log('updates: server is not https — updates are off');
      return;
    }

    if (this.capability === 'auto') {
      let yml = null;
      try { yml = this.deps.readAppUpdateYml(); } catch (err) { this.deps.log(`updates: app-update.yml not read: ${err.message}`); }
      if (!hasPublisherName(yml)) {
        this.deps.log('updates: app-update.yml has no publisherName — signature check would be skipped, updates are off');
        this.setState({ status: 'error', error: 'build-misconfigured' });
        return;
      }
    }

    this.loadPersisted();
    if (this.capability === 'auto') this.configureAutoUpdater();
    this.deps.log(`updates: ${this.kind}, channel ${this.channel}, feed ${this.baseUrl}`);
    this.scheduleCheck(nextCheckDelay({ first: true, rand: this.deps.rand }));
  }

  stop() {
    this.stopped = true;
    this.clearCheckTimer();
    this.clearMandatoryTimer();
    if (this.mandatoryAbort) this.mandatoryAbort.abort();
  }

  configureAutoUpdater() {
    const u = this.autoUpdater;
    const log = this.deps.log;
    u.logger = {
      info: (m) => log(`electron-updater: ${m}`),
      warn: (m) => log(`electron-updater warning: ${m}`),
      error: (m) => log(`electron-updater error: ${m}`),
      debug: () => {}
    };
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowDowngrade = false;
    u.allowPrerelease = this.channel === 'beta';
    u.disableWebInstaller = true;
    u.setFeedURL(feedOptions({ baseUrl: this.baseUrl }));
    u.requestHeaders = this.headers();
    // electron-updater ждёт строку (отказ) или null (подпись в порядке).
    // Любое исключение — отказ: пропустить установщик из-за сбоя проверки нельзя.
    u.verifyUpdateCodeSignature = (publisherNames, file) => this.verifyDownloaded(file);

    u.on('checking-for-update', () => {
      if (this.state.status !== 'downloaded') this.setState({ status: 'checking', error: null });
    });
    u.on('update-available', (info) => this.onUpdateAvailable(info));
    u.on('update-not-available', () => this.onNothingToInstall());
    u.on('download-progress', (p) => {
      if (this.state.status !== 'downloading') return;
      const percent = Number(p?.percent);
      this.setState({ progress: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : this.state.progress });
    });
    u.on('update-downloaded', (info) => this.onDownloaded(info));
    u.on('error', (err) => this.onUpdaterError(err));
  }

  async verifyDownloaded(file, expectedVersion = this.downloadVersion) {
    let code;
    try {
      code = await this.deps.verify(file, { expectedVersion, currentVersion: this.currentVersion });
      if (code !== null && typeof code !== 'string') code = 'signature-check-failed';
    } catch (err) {
      this.deps.log(`update signature check crashed: ${err.message}`);
      code = 'signature-check-failed';
    }
    this.lastVerifyError = code;
    this.deps.log(code ? `update signature REJECTED (${code})` : 'update signature verified');
    return code;
  }

  // ── Расписание ───────────────────────────────────────────────────────────

  clearCheckTimer() {
    if (this.checkTimer !== null) this.deps.timers.clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  clearMandatoryTimer() {
    if (this.mandatoryTimer !== null) this.deps.timers.clearTimeout(this.mandatoryTimer);
    this.mandatoryTimer = null;
  }

  scheduleCheck(delay) {
    if (this.stopped) return;
    this.clearCheckTimer();
    this.checkTimer = this.deps.timers.setTimeout(() => {
      this.checkTimer = null;
      return this.runCheck();
    }, delay);
  }

  scheduleAfterSuccess() {
    this.failures = 0;
    this.scheduleCheck(nextCheckDelay({ intervalMin: this.intervalMin, attempt: 0, rand: this.deps.rand }));
  }

  scheduleAfterFailure() {
    this.failures += 1;
    this.scheduleCheck(nextCheckDelay({ intervalMin: this.intervalMin, attempt: this.failures, rand: this.deps.rand }));
  }

  // ── Проверка ─────────────────────────────────────────────────────────────

  canCheck() {
    return this.started && !this.stopped && this.enabled && Boolean(this.baseUrl) && this.capability !== 'none' && this.state.error !== 'build-misconfigured';
  }

  async checkNow({ userInitiated = false } = {}) {
    if (!this.canCheck()) return { ok: false, reason: this.state.status, state: this.getState() };
    if (['checking', 'downloading', 'downloaded'].includes(this.state.status) || this.checkInFlight) {
      return { ok: false, reason: 'busy', state: this.getState() };
    }
    if (userInitiated) {
      const t = this.deps.now();
      if (this.lastManualCheckAt !== null && t - this.lastManualCheckAt < MANUAL_CHECK_MIN_INTERVAL_MS) {
        return { ok: false, reason: 'rate-limited', state: this.getState() };
      }
      this.lastManualCheckAt = t;
    }
    await this.runCheck();
    return { ok: true, state: this.getState() };
  }

  runCheck() {
    if (this.checkInFlight) return this.checkInFlight;
    this.checkInFlight = this.doCheck().finally(() => { this.checkInFlight = null; });
    return this.checkInFlight;
  }

  async doCheck() {
    if (!this.canCheck() || ['downloading', 'downloaded'].includes(this.state.status)) return;
    this.clearCheckTimer();
    this.setState({ status: 'checking', error: null });
    this.savePersisted({ lastCheckAt: new Date(this.deps.now()).toISOString() });

    let response;
    try {
      response = await this.deps.fetchJson(`${this.serverOrigin.replace(/\/+$/, '')}/updates/policy.json?channel=${this.channel}`, {
        headers: this.headers(),
        timeoutMs: POLICY_TIMEOUT_MS
      });
    } catch (err) {
      this.fail('network', `policy.json request failed: ${err?.message || err}`);
      return;
    }

    const status = Number(response?.status);
    // Старый сервер без /updates — обновлений просто нет.
    if (status === 404) return this.onNothingToInstall();
    if (status === 429) return this.fail('network', 'policy.json: 429 rate limited');
    if (status >= 500) return this.fail('http-5xx', `policy.json: HTTP ${status}`);
    if (status !== 200) return this.fail('policy-invalid', `policy.json: HTTP ${status}`);
    const policy = normalizePolicy(response.body);
    if (!policy) return this.fail('policy-invalid', 'policy.json: unexpected body');

    this.intervalMin = policy.checkIntervalMinutes;
    const offered = policy.enabled && policy.offeredVersion && compareVersions(policy.offeredVersion, this.currentVersion) > 0
      ? policy.offeredVersion
      : null;
    if (!offered) return this.onNothingToInstall();

    const base = { offeredVersion: offered, mandatory: policy.mandatory, message: policy.message };

    if (this.capability === 'notify') {
      const preferred = this.kind === 'portable' ? policy.portableUrl || policy.setupUrl : policy.setupUrl;
      const downloadUrl = resolveDownloadUrl({ url: preferred, serverOrigin: this.serverOrigin });
      if (preferred && !downloadUrl) this.deps.log('updates: download URL from policy.json rejected (not this server)');
      const isNew = this.state.status !== 'available' || this.state.offeredVersion !== offered;
      this.setState({ ...base, status: 'available', progress: null, error: null, downloadUrl });
      this.savePersisted({ lastError: null });
      if (isNew) this.safeNotify({ title: 'Доступна новая версия OpenMyChat', body: `Версия ${offered} — скачайте и установите её.` });
      this.scheduleAfterSuccess();
      return;
    }

    // auto: дальше ведёт electron-updater, состояние меняют его события.
    // Его промис не ждём: скачивание идёт минутами, а проверка (и ручная
    // «Проверить обновления») заканчивается на решении политики.
    this.setState({ ...base, downloadUrl: null });
    this.autoUpdater.requestHeaders = this.headers();
    Promise.resolve()
      .then(() => this.autoUpdater.checkForUpdates())
      .then(
        (result) => {
          if (result && result.downloadPromise && typeof result.downloadPromise.catch === 'function') {
            // Ошибку скачивания разбирает обработчик события error.
            result.downloadPromise.catch(() => {});
          }
          // Ни события, ни ошибки (например, electron-updater считает себя
          // неактивным) — не зависаем в «checking».
          if (this.state.status === 'checking') this.onNothingToInstall();
        },
        (err) => {
          // Обычно electron-updater уже прислал событие error; если нет — здесь.
          if (this.state.status === 'checking') this.onUpdaterError(err);
        }
      );
  }

  fail(code, detail) {
    this.deps.log(`updates: ${detail} (${code})`);
    this.savePersisted({ lastError: code });
    this.setState({ status: 'error', error: code, progress: null });
    this.scheduleAfterFailure();
  }

  onNothingToInstall() {
    if (this.state.status === 'downloaded') return;
    this.savePersisted({ lastError: null });
    this.setState({ status: 'idle', offeredVersion: null, progress: null, mandatory: false, error: null, downloadUrl: null });
    this.scheduleAfterSuccess();
  }

  // ── События electron-updater ─────────────────────────────────────────────

  onUpdateAvailable(info) {
    const version = isValidVersion(info?.version) ? info.version : null;
    this.downloadVersion = version;
    this.lastVerifyError = null;
    this.setState({ status: 'downloading', offeredVersion: version || this.state.offeredVersion, progress: 0, error: null });
  }

  // electron-updater 6.8.9 посылает это событие один раз на каждое
  // завершённое скачивание (BaseUpdater.executeDownload → done). Обработчик
  // всё равно выдерживает повтор, пришедший, пока предыдущий ещё проверяет
  // файл: второй проверки и второго уведомления не будет.
  onDownloaded(info) {
    if (this.state.status === 'downloaded' || this.downloadedCheck) return this.downloadedCheck || undefined;
    // Сразу, до проверки: electron-updater вслед за этим событием регистрирует
    // свой обработчик выхода (BaseUpdater.addQuitHandler), и обычный выход из
    // приложения, пока идёт наша проверка (до 30 с), поставил бы ещё не
    // проверенный файл. Флаг он читает в момент выхода; вернём его только
    // после успешной проверки.
    if (this.autoUpdater) this.autoUpdater.autoInstallOnAppQuit = false;
    const version = isValidVersion(info?.version) ? info.version : this.downloadVersion || this.state.offeredVersion;
    const file = typeof info?.downloadedFile === 'string' && info.downloadedFile ? info.downloadedFile : null;
    this.downloadedCheck = this.confirmDownloaded(version, file)
      .catch((err) => this.deps.log(`updates: downloaded file check failed: ${err?.message || err}`))
      .finally(() => { this.downloadedCheck = null; });
    return this.downloadedCheck;
  }

  // Подпись, проверенная во время скачивания, относилась к временному файлу.
  // Готовый установщик лежит уже в другом месте (кэш pending), а файл из
  // кэша прошлого запуска electron-updater берёт повторно, сверив лишь sha512
  // и не вызывая проверку подписи вовсе. Поэтому здесь — своя проверка
  // именно того файла, который будет запущен, если в этом запуске он ещё не
  // проверялся.
  async confirmDownloaded(version, file) {
    let code = null;
    if (!file) code = 'signature-check-failed';
    else if (!this.verifiedFiles.has(fileKey(file))) code = await this.verifyDownloaded(file, version);
    if (this.stopped) return;
    if (code) {
      this.rejectDownloaded(code, file);
      return;
    }
    this.verifiedFiles.add(fileKey(file));
    this.downloadedFile = file;
    if (this.autoUpdater) {
      this.autoUpdater.autoInstallOnAppQuit = true;
      // Пока флаг был снят, addQuitHandler отказался регистрировать
      // обработчик выхода, так что регистрирует его теперь только этот вызов;
      // повторный вызов безопасен (quitHandlerAdded). Метод внутренний — его
      // наличие в установленной версии сверяет тест (updater.test.js).
      if (typeof this.autoUpdater.addQuitHandler === 'function') {
        try { this.autoUpdater.addQuitHandler(); } catch (err) { this.deps.log(`обновления: addQuitHandler упал: ${err.message}`); }
      } else {
        this.deps.log('ВНИМАНИЕ, обновления: в electron-updater нет addQuitHandler — при выходе обновление не установится, только по «Перезапустить и обновить»');
      }
    }
    this.clearCheckTimer();
    this.failures = 0;
    this.savePersisted({ lastError: null });
    this.setState({ status: 'downloaded', offeredVersion: version, progress: 100, error: null });
    this.deps.log(`updates: ${version} downloaded and verified`);
    this.safeNotify({
      title: 'Обновление OpenMyChat готово',
      body: this.state.mandatory
        ? `Обязательное обновление до версии ${version}. Приложение перезапустится.`
        : `Версия ${version} установится при выходе из приложения или по «Перезапустить и обновить» в меню значка.`
    });
    if (this.state.mandatory) this.handleMandatory();
  }

  onUpdaterError(err) {
    const code = classifyUpdaterError(err, this.lastVerifyError);
    if (code === null) {
      this.deps.log('updates: latest.yml not offered to this machine (404) — no update');
      this.onNothingToInstall();
      return;
    }
    if (this.state.status === 'downloaded') {
      this.deps.log(`updates: error after download ignored: ${err?.message || err}`);
      return;
    }
    this.fail(code, `electron-updater: ${String(err?.message || err).split('\n')[0].slice(0, 300)}`);
  }

  safeNotify(n) {
    try { this.deps.notify(n); } catch (err) { this.deps.log(`update notification failed: ${err.message}`); }
  }

  // ── Установка ────────────────────────────────────────────────────────────

  // Файл не прошёл проверку: electron-updater не должен поставить его и при
  // выходе из приложения (autoInstallOnAppQuit).
  rejectDownloaded(code, file) {
    if (this.autoUpdater) this.autoUpdater.autoInstallOnAppQuit = false;
    if (file) this.verifiedFiles.delete(fileKey(file));
    this.downloadedFile = null;
    this.fail(code, `downloaded installer rejected: ${file || 'no file path'}`);
  }

  async installNow() {
    const result = await this.attemptInstall();
    // Установку (из трея, интерфейса или по таймеру обязательного
    // обновления) остановил сеанс удалённого стола. Для обязательного
    // обновления ожидание должно продолжиться, даже если его таймер уже
    // сработал, пока шла эта попытка, и ушёл вхолостую.
    if (!result.ok && result.reason === 'remote-session' && this.state.mandatory && this.mandatoryTimer === null) {
      this.handleMandatory();
    }
    return result;
  }

  async attemptInstall() {
    if (this.installing) return { ok: false, reason: 'busy' };
    if (this.state.status !== 'downloaded') return { ok: false, reason: 'not-downloaded' };
    // Перезапуск посреди сеанса удалённого стола оборвал бы работу оператора
    // и сотрудника — ставим только после его конца.
    if (this.hostSession && this.hostSession.active) return { ok: false, reason: 'remote-session' };
    this.installing = true;
    try {
      // Последняя проверка — прямо перед запуском: между скачиванием и
      // установкой могли пройти часы, а папка кэша доступна на запись
      // любой программе сотрудника.
      const file = (this.autoUpdater && this.autoUpdater.installerPath) || this.downloadedFile;
      const code = file ? await this.verifyDownloaded(file, this.state.offeredVersion) : 'signature-check-failed';
      if (code) {
        this.rejectDownloaded(code, file);
        return { ok: false, reason: code };
      }
      // Пока шла проверка, мог начаться сеанс или всё остановиться.
      if (this.stopped || this.state.status !== 'downloaded') return { ok: false, reason: 'not-downloaded' };
      if (this.hostSession && this.hostSession.active) return { ok: false, reason: 'remote-session' };

      this.clearCheckTimer();
      this.clearMandatoryTimer();
      this.deps.log(`updates: installing ${this.state.offeredVersion} now`);
      // Иначе обработчик close главного окна спрятал бы его в трей и выход
      // не состоялся бы.
      this.app.isQuitting = true;
      let started = false;
      try {
        this.autoUpdater.quitAndInstall(true, true);
        // BaseUpdater сбрасывает флаг, если установщик не запустился
        // (нет installerPath, ошибка запуска).
        started = this.autoUpdater.quitAndInstallCalled !== false;
      } catch (err) {
        this.deps.log(`updates: quitAndInstall threw: ${err?.message || err}`);
      }
      if (!started) {
        this.app.isQuitting = false;
        this.fail('install-failed', 'installer did not start — the app keeps running');
        return { ok: false, reason: 'install-failed' };
      }
      return { ok: true };
    } finally {
      // После успешного запуска приложение выходит; флаг остаётся, чтобы
      // второй щелчок не запустил установщик ещё раз.
      if (!this.app.isQuitting) this.installing = false;
    }
  }

  installFromMandatory() {
    // Сеанс, начавшийся во время последней проверки, возвращает в ожидание
    // сам installNow.
    this.installNow().catch((err) => this.deps.log(`mandatory install failed: ${err?.message || err}`));
  }

  handleMandatory() {
    if (this.stopped || this.installing || this.state.status !== 'downloaded') return;
    this.clearMandatoryTimer();
    if (this.hostSession && this.hostSession.active) {
      this.deps.log('updates: mandatory update waits for the remote session to end');
      this.mandatoryTimer = this.deps.timers.setTimeout(() => {
        this.mandatoryTimer = null;
        return this.handleMandatory();
      }, RD_RECHECK_MS);
      return;
    }
    // Отсрочка одна: второй раз не спрашиваем, а ставим.
    if (this.mandatoryAsked) {
      this.installFromMandatory();
      return;
    }
    this.mandatoryAsked = true;
    const abort = new AbortController();
    this.mandatoryAbort = abort;
    this.mandatoryTimer = this.deps.timers.setTimeout(() => {
      this.mandatoryTimer = null;
      abort.abort();
      return this.handleMandatory();
    }, MANDATORY_DELAY_MS);

    let asked;
    try {
      asked = Promise.resolve(this.deps.confirmMandatory({ version: this.state.offeredVersion, delayMs: MANDATORY_DELAY_MS, signal: abort.signal }));
    } catch (err) {
      asked = Promise.reject(err);
    }
    asked
      .then((answer) => {
        if (abort.signal.aborted || answer !== 'now') return;
        this.handleMandatoryNow();
      })
      .catch((err) => this.deps.log(`mandatory update dialog failed: ${err?.message || err}`));
  }

  handleMandatoryNow() {
    this.clearMandatoryTimer();
    if (this.hostSession && this.hostSession.active) {
      this.handleMandatory();
      return;
    }
    this.installFromMandatory();
  }

  // Ссылка на скачивание берётся только из состояния главного процесса,
  // никогда — от страницы.
  openDownload() {
    const url = this.state.status === 'available' ? this.state.downloadUrl : null;
    if (!url) return false;
    try {
      this.deps.openExternal(url);
      return true;
    } catch (err) {
      this.deps.log(`open download failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = {
  UpdateController,
  classifyUpdaterError,
  hasPublisherName,
  MANUAL_CHECK_MIN_INTERVAL_MS,
  RD_RECHECK_MS,
  MANDATORY_DELAY_MS
};
