const express = require('express');
const FilePolicyService = require('../services/file-policy.service');
const AuditService = require('../services/audit.service');

// Административные маршруты фильтра типов файлов (GET/PUT /api/admin/file-policy).
// Вынесены в отдельный файл и монтируются одной строкой из api/index.js —
// параллельно с этой задачей другой модуль добавляет свой собственный
// административный подроутер (автообновление), и общий файл маршрутов не
// должен становиться точкой конфликта между ними.
//
// requireAuth/requireAdmin/getClientIp передаются вызывающим кодом: они
// определены в api/index.js, и заводить их здесь заново означало бы разойтись
// в поведении (например, в проверке must_change_password).
module.exports = function createFilePolicyRouter({ requireAuth, requireAdmin, getClientIp }) {
  const router = express.Router();

  // requireAdmin — это именно isSuperAdmin (не requireAdminOrScopedAdmin):
  // администратор подразделения фильтром типов файлов не управляет, он
  // действует на всю компанию.
  router.get('/', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await FilePolicyService.getPolicy());
    } catch (err) {
      res.status(500).json({ error: 'Не удалось получить политику файлов' });
    }
  });

  router.put('/', requireAuth, requireAdmin, async (req, res) => {
    try {
      const before = await FilePolicyService.getPolicy();
      const policy = await FilePolicyService.setPolicy(req.body, req.user);
      AuditService.log({
        userId: req.user.id,
        action: 'file_policy_changed',
        ip: getClientIp(req),
        details: FilePolicyService.diffPolicy(before, policy)
      });
      res.json(policy);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
