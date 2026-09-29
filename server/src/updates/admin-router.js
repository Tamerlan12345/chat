const express = require('express');
const multer = require('multer');
const fsp = require('node:fs/promises');
const config = require('../config');
const AuditService = require('../services/audit.service');
const UpdatePolicy = require('../services/update-policy.service');
const { getUpdateStore } = require('../services/update-store.service');
const { getClientIp } = require('../services/ip-access.service');
const { fleetSummary } = require('./client-installs');

// Консоль обновлений: /api/admin/updates*. Вход и права (только
// суперадминистратор) проверяются при монтировании в api/index.js — здесь
// только сами действия. Каждое изменение пишется в журнал аудита: релиз,
// попавший в раздачу, получат все компьютеры компании.

const router = express.Router();
const UPLOAD_FIELDS = ['yml', 'setup', 'blockmap', 'portable'];

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function sendError(res, err) {
  const status = Number(err?.status);
  if (status >= 400 && status < 500) return res.status(status).json({ error: err.message });
  console.error('[Updates] ошибка консоли обновлений:', err?.message || err);
  return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}

function auditImport(req, summary) {
  AuditService.log({
    userId: req.user.id,
    action: 'update_release_imported',
    ip: getClientIp(req),
    details: { version: summary.version, sha512: summary.sha512, size: summary.size }
  });
}

router.get('/', route(async (req, res) => {
  const store = getUpdateStore();
  res.json({
    disabledByEnv: UpdatePolicy.isDisabledByEnv(),
    policy: UpdatePolicy.getPolicy(),
    releases: store.listReleases(),
    inbox: store.listInbox(),
    fleet: await fleetSummary()
  });
}));

// Отдельный экземпляр multer: свой предел размера (установщик — сотни
// мегабайт, а не 100 МБ вложения) и своя временная папка на каждый запрос
// внутри UPDATES_DIR/.tmp — перенос в релиз остаётся переименованием на том же
// диске, а неудачная загрузка стирается целиком.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.updatesUploadDir),
    // Имя на диске — имя поля из белого списка, а не присланное имя файла.
    filename: (req, file, cb) => cb(null, file.fieldname)
  }),
  limits: { fileSize: config.UPDATES_MAX_FILE_MB * 1024 * 1024, files: 4, fields: 5 }
}).fields(UPLOAD_FIELDS.map((name) => ({ name, maxCount: 1 })));

router.post('/releases', (req, res, next) => {
  let dir;
  try {
    dir = getUpdateStore().createTempDir();
  } catch (err) {
    return next(err);
  }
  req.updatesUploadDir = dir;

  // Временная папка стирается до ответа при любом исходе: к моменту, когда
  // консоль увидит результат, хвостов на диске уже нет.
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

  upload(req, res, async (err) => {
    let status;
    let body;
    let failure = null;
    try {
      if (err) {
        status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        body = {
          error: status === 413
            ? `Файл больше предела ${config.UPDATES_MAX_FILE_MB} МБ`
            : 'Неверная загрузка: ожидаются поля yml, setup, blockmap, portable и notes'
        };
      } else {
        const files = {};
        for (const field of UPLOAD_FIELDS) {
          const got = req.files?.[field]?.[0];
          if (got) files[field] = got.path;
        }
        if (!files.yml || !files.setup) {
          status = 400;
          body = { error: 'Нужны latest.yml (поле yml) и установщик (поле setup)' };
        } else {
          const notes = typeof req.body?.notes === 'string' ? req.body.notes : '';
          const summary = await getUpdateStore().importUpload(files, { actor: req.user, notes });
          auditImport(req, summary);
          status = 201;
          body = summary;
        }
      }
    } catch (e) {
      failure = e;
    }
    await cleanup();
    if (failure) return sendError(res, failure);
    res.status(status).json(body);
  });
});

router.post('/inbox/:name/import', route(async (req, res) => {
  try {
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : '';
    const summary = await getUpdateStore().importFromDir(req.params.name, { actor: req.user, notes });
    auditImport(req, summary);
    res.status(201).json(summary);
  } catch (err) {
    sendError(res, err);
  }
}));

router.put('/policy', route(async (req, res) => {
  try {
    const policy = await UpdatePolicy.setPolicy(req.body, req.user, { ip: getClientIp(req) });
    res.json({ policy });
  } catch (err) {
    sendError(res, err);
  }
}));

router.delete('/releases/:version', route(async (req, res) => {
  try {
    const { version } = req.params;
    await getUpdateStore().deleteRelease(version, UpdatePolicy.getPolicy());
    AuditService.log({ userId: req.user.id, action: 'update_release_deleted', ip: getClientIp(req), details: { version } });
    res.json({ success: true, version });
  } catch (err) {
    sendError(res, err);
  }
}));

module.exports = router;
