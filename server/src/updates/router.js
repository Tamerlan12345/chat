const express = require('express');
const path = require('node:path');
const config = require('../config');
const UpdatePolicy = require('../services/update-policy.service');
const { getUpdateStore, renderYml, feedOf, setupNameOf, portableNameOf, SAFE_FILE } = require('../services/update-store.service');
const { checkRateLimit } = require('../services/rate-limiter');
const { getClientIp, rateLimitIpKey } = require('../services/ip-access.service');
const { createInstallRecorder } = require('./client-installs');

// Публичные маршруты автообновления. Открыты без входа пользователя
// намеренно: обновление должно работать и до входа, и на странице «нет
// связи». Целостность обеспечивает подпись установщика, которую проверяет
// клиент, а не секретность этих адресов. Стоят за IP-фильтром и проверкой
// готовности (см. app.js) и раньше статики с её фильтром по User-Agent:
// electron-updater ходит своим сеансом, и его запросы не должны превратиться в
// index.html.

const CHANNELS = new Set(['stable', 'beta']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALL_KINDS = new Set(['nsis', 'nsis-machine', 'portable', 'copy']);
const ERROR_CODE = /^[a-z0-9-]{1,32}$/;

function createDownloadGate(max) {
  return {
    active: 0,
    max,
    tryAcquire() {
      if (this.active >= this.max) return false;
      this.active += 1;
      return true;
    },
    release() {
      if (this.active > 0) this.active -= 1;
    }
  };
}

const downloadGate = createDownloadGate(config.UPDATES_MAX_CONCURRENT_DOWNLOADS);
const installRecorder = createInstallRecorder();
const router = express.Router();

// Заголовки клиента — чужой ввод: всё, что не по формату, считается
// отсутствующим и в базу не попадает.
function clientInfo(req) {
  const id = req.get('X-MyChat-Install-Id');
  const version = req.get('X-MyChat-Client-Version');
  const kind = req.get('X-MyChat-Install-Kind');
  const error = req.get('X-MyChat-Update-Error');
  return {
    installId: typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null,
    clientVersion: UpdatePolicy.isValidVersion(version) ? version : null,
    kind: INSTALL_KINDS.has(kind) ? kind : null,
    lastError: typeof error === 'string' && ERROR_CODE.test(error) ? error : null
  };
}

function recordInstall(req, info, channel) {
  if (!info.installId) return;
  installRecorder.record({ ...info, channel, ip: getClientIp(req) });
}

function notFound(res) {
  res.set('Cache-Control', 'no-store');
  res.status(404).type('text/plain').send('Not found');
}

// Предел частоты обновлений — по установке (X-MyChat-Install-Id), а не только
// по адресу: за одним NAT крупного офиса сотни установок опрашивают сервер
// утром разом, и общий счётчик 120/мин на адрес срабатывал на штатной работе
// (проверка раунда 4, M7). У каждой установки свой щедрый предел; на адрес
// (сеть /64) — высокий потолок, чтобы уместился весь офис, но поток с одного
// адреса без валидного install-id всё же был ограничен. Ключи — по адресу и
// по install-id, оба fail open (ПР-01).
const UPD_PER_INSTALL = { maxAttempts: 120, windowMs: 60000 };
function updPerIpLimit() {
  const n = Number(process.env.UPDATES_MAX_REQ_PER_MIN_PER_IP);
  return { maxAttempts: Number.isInteger(n) && n > 0 ? n : 6000, windowMs: 60000 };
}
function updateRequestAllowed(req, info) {
  const ipOk = checkRateLimit('upd-ip:' + rateLimitIpKey(getClientIp(req)), updPerIpLimit());
  if (info.installId) {
    const idOk = checkRateLimit('upd-id:' + info.installId, UPD_PER_INSTALL);
    return ipOk && idOk;
  }
  return ipOk;
}

function decideFor(channel, info) {
  const store = getUpdateStore();
  const policy = UpdatePolicy.getPolicy();
  const decision = UpdatePolicy.decide({
    channel,
    installId: info.installId,
    clientVersion: info.clientVersion,
    policy,
    releases: store.listReleases(),
    disabledByEnv: UpdatePolicy.isDisabledByEnv()
  });
  const release = decision.eligible && decision.release ? store.getRelease(decision.release.version) : null;
  return { policy, decision, release };
}

router.get('/policy.json', (req, res) => {
  const channel = CHANNELS.has(req.query.channel) ? req.query.channel : 'stable';
  const info = clientInfo(req);
  const { policy, decision, release } = decideFor(channel, info);
  // Тот же счётчик и порог, что у latest.yml (тот же ресурс защищаем —
  // запись в client_installs), но здесь запрос не проваливается 429: это
  // проверка баннера обновления, которую клиент дёргает намного чаще и в
  // штатной работе приложения, а не только electron-updater'ом. Сверх предела
  // просто пропускаем запись — ответ клиент всё равно получит (находка
  // ревью, задача 6).
  if (updateRequestAllowed(req, info)) {
    recordInstall(req, info, channel);
  }

  const enabled = !UpdatePolicy.isDisabledByEnv() && policy.enabled;
  // Адреса относительные: клиент достраивает их от адреса сервера, которому
  // уже доверяет, — брать схему и узел из запроса за прокси было бы нельзя.
  const fileUrl = (name) => `/updates/${channel}/${encodeURIComponent(name)}`;
  const hasFile = (name) => Boolean(release?.files.some((f) => f.name === name));

  res.set('Cache-Control', 'no-store').json({
    enabled,
    channel,
    offeredVersion: release ? release.version : null,
    mandatory: Boolean(release && decision.mandatory),
    minVersion: enabled ? policy.minVersion : null,
    message: enabled ? policy.message : null,
    checkIntervalMinutes: policy.checkIntervalMinutes,
    setupUrl: release ? fileUrl(setupNameOf(release.version)) : null,
    portableUrl: release && hasFile(portableNameOf(release.version)) ? fileUrl(portableNameOf(release.version)) : null
  });
});

router.get('/:channel/latest.yml', (req, res) => {
  const { channel } = req.params;
  if (!CHANNELS.has(channel)) return notFound(res);
  const info = clientInfo(req);
  if (!updateRequestAllowed(req, info)) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Слишком много запросов, повторите позже' });
  }

  recordInstall(req, info, channel);
  // Нет права на версию — 404: для electron-updater это «обновлений нет».
  const { release } = decideFor(channel, info);
  if (!release) return notFound(res);

  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/yaml; charset=utf-8');
  res.send(renderYml(feedOf(release)));
});

router.get('/:channel/:file', (req, res) => {
  if (UpdatePolicy.isDisabledByEnv()) return notFound(res);
  if (!CHANNELS.has(req.params.channel)) return notFound(res);
  const name = req.params.file;
  if (typeof name !== 'string' || !SAFE_FILE.test(name)) return notFound(res);

  // Только поиск по индексу: имя из адреса ни с чем не склеивается.
  const store = getUpdateStore();
  const absPath = store.resolveFile(name);
  if (!absPath || !absPath.startsWith(store.releasesDir + path.sep)) return notFound(res);

  if (!downloadGate.tryAcquire()) {
    res.set('Retry-After', '60');
    return res.status(503).json({ error: 'Сервер обновлений занят, повторите позже' });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    downloadGate.release();
  };
  res.on('finish', release);
  res.on('close', release);

  res.set({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`
  });
  // dotfiles: путь взят из индекса, а каталог данных может лежать под
  // скрытой папкой — отказ по точке в пути здесь только мешал бы.
  res.sendFile(absPath, { acceptRanges: true, cacheControl: false, dotfiles: 'allow' }, (err) => {
    if (!err) return;
    release();
    if (res.headersSent) return;
    res.removeHeader('Content-Disposition');
    res.set('Cache-Control', 'no-store');
    if (err.status === 404 || err.code === 'ENOENT') return notFound(res);
    if (err.status === 416 || err.status === 412) return res.status(err.status).end();
    console.error('[Updates] отдача файла не удалась:', err.message);
    res.status(500).type('text/plain').send('Internal error');
  });
});

// Всё прочее под /updates — 404 здесь же, а не в статике интерфейса: иначе
// ошибка в адресе у клиента получала бы index.html с кодом 200.
router.use((req, res) => notFound(res));

module.exports = router;
module.exports.downloadGate = downloadGate;
module.exports.installRecorder = installRecorder;
