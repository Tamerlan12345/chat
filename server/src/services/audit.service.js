const { getDatabase } = require('../db');

// Журнал действий, которые нужно уметь объяснить постфактум. Пока пишутся
// сеансы удалённого доступа: чужим компьютером управляют вживую, и вопрос
// «кто, к кому и когда подключался» обязан иметь ответ, не зависящий от
// памяти участников.
class AuditService {
  static log({ userId = null, action, details = null, ip = null }) {
    try {
      getDatabase()
        .prepare(
          'INSERT INTO audit_logs (user_id, action, details_json, ip_address, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          userId,
          action,
          details ? JSON.stringify(details) : null,
          ip,
          new Date().toISOString()
        );
    } catch (err) {
      // Журнал не должен ронять то, что он описывает.
      console.error('[Audit] не удалось записать событие:', err.message);
    }
  }

  static list({ action = null, limit = 200 } = {}) {
    const db = getDatabase();
    const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const sql = `
      SELECT a.id, a.user_id, u.full_name AS user_name, a.action, a.details_json,
             a.ip_address, a.created_at
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      ${action ? 'WHERE a.action = ?' : ''}
      ORDER BY a.id DESC
      LIMIT ?
    `;
    const rows = action ? db.prepare(sql).all(action, capped) : db.prepare(sql).all(capped);
    return rows.map((r) => ({
      ...r,
      details: r.details_json ? JSON.parse(r.details_json) : null
    }));
  }
}

module.exports = AuditService;
