const { identity, isIdentityReady } = require('../db/identity');

// Журнал действий, которые нужно уметь объяснить постфактум: сеансы удалённого
// доступа, правка прав ролей, решения по заявкам на регистрацию. Чужим
// компьютером управляют вживую, и вопрос «кто, к кому и когда подключался»
// обязан иметь ответ, не зависящий от памяти участников.
//
// Лежит вместе с учётными записями, а не с перепиской: администратор может
// выполнять произвольные SQL-запросы к базе переписки через админ-панель, и
// журнал, который проверяемый способен отредактировать, журналом не является.
class AuditService {
  /**
   * Запись не ожидается вызывающей стороной: журнал не должен ни задерживать,
   * ни ронять то, что он описывает.
   */
  static log({ userId = null, action, details = null, ip = null }) {
    if (!isIdentityReady()) return;

    identity()
      .run(
        `INSERT INTO audit_logs (user_id, action, details_json, ip_address, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          userId === null || userId === undefined ? null : Number(userId),
          String(action),
          details ? JSON.stringify(details) : null,
          ip,
          new Date().toISOString()
        ]
      )
      .catch((err) => {
        console.error('[Audit] не удалось записать событие:', err.message);
      });
  }

  static async list({ action = null, limit = 200 } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);

    const rows = action
      ? await identity().all(
          `SELECT a.id, a.user_id, u.full_name AS user_name, a.action, a.details_json,
                  a.ip_address, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
           WHERE a.action = $1
           ORDER BY a.id DESC
           LIMIT $2`,
          [action, capped]
        )
      : await identity().all(
          `SELECT a.id, a.user_id, u.full_name AS user_name, a.action, a.details_json,
                  a.ip_address, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
           ORDER BY a.id DESC
           LIMIT $1`,
          [capped]
        );

    return rows.map((row) => ({
      ...row,
      details: row.details_json ? safeParse(row.details_json) : null
    }));
  }
}

function safeParse(json) {
  try {
    return typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
}

module.exports = AuditService;
