const { getDatabase } = require('../db');
const { identity } = require('../db/identity');
const UserService = require('./user.service');

// Объявления лежат в базе переписки, автор — в хранилище учётных записей.
// Автор подставляется отдельным запросом, а не соединением таблиц.
class AnnouncementService {
  static async createAnnouncement({
    author_id, title, content, target_type = 'all', target_ids = [], priority = 'normal', expires_at = null
  }) {
    if (!title || !String(title).trim()) throw new Error('Укажите заголовок оповещения');
    if (!content || !String(content).trim()) throw new Error('Укажите текст оповещения');

    const result = getDatabase()
      .prepare(`
        INSERT INTO announcements (author_id, title, content, target_type, target_ids_json, priority, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        Number(author_id),
        String(title).trim(),
        String(content).trim(),
        ['all', 'departments', 'users'].includes(target_type) ? target_type : 'all',
        JSON.stringify(Array.isArray(target_ids) ? target_ids.map(Number) : []),
        ['normal', 'urgent', 'critical'].includes(priority) ? priority : 'normal',
        expires_at || null,
        new Date().toISOString()
      );

    return this.getAnnouncementById(Number(result.lastInsertRowid));
  }

  static async getAnnouncementById(id) {
    const row = getDatabase().prepare('SELECT * FROM announcements WHERE id = ?').get(Number(id));
    if (!row) return null;
    const [withAuthor] = await this.attachAuthors([row]);
    return withAuthor;
  }

  static async attachAuthors(rows) {
    if (!rows.length) return rows;
    const directory = await UserService.getDirectory(rows.map((r) => r.author_id));
    return rows.map((row) => {
      const author = directory.get(Number(row.author_id));
      return {
        ...row,
        author_name: author?.full_name || 'Удалённый сотрудник',
        author_job_title: author?.job_title || null
      };
    });
  }

  static async getAnnouncementsForUser(userId) {
    const me = Number(userId);
    const user = await identity().get('SELECT department_id FROM users WHERE id = $1', [me]);
    const deptId = user ? user.department_id : null;

    const rows = getDatabase()
      .prepare(`
        SELECT a.*, ar.read_at, ar.confirmed_at,
               CASE WHEN ar.confirmed_at IS NOT NULL THEN 1 ELSE 0 END AS is_confirmed
        FROM announcements a
        LEFT JOIN announcement_receipts ar ON a.id = ar.announcement_id AND ar.user_id = ?
        WHERE (a.expires_at IS NULL OR a.expires_at > datetime('now'))
        ORDER BY a.created_at DESC
      `)
      .all(me);

    const visible = rows.filter((a) => {
      if (a.target_type === 'all') return true;
      let targets = [];
      try {
        targets = JSON.parse(a.target_ids_json || '[]');
      } catch {
        targets = [];
      }
      if (a.target_type === 'users') return targets.map(Number).includes(me);
      if (a.target_type === 'departments') return deptId !== null && targets.map(Number).includes(Number(deptId));
      return true;
    });

    return this.attachAuthors(visible);
  }

  static acknowledgeAnnouncement(announcementId, userId, ipAddress = '127.0.0.1') {
    const now = new Date().toISOString();
    getDatabase()
      .prepare(`
        INSERT INTO announcement_receipts (announcement_id, user_id, read_at, confirmed_at, ip_address)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(announcement_id, user_id) DO UPDATE SET confirmed_at = ?, ip_address = ?
      `)
      .run(Number(announcementId), Number(userId), now, now, ipAddress, now, ipAddress);

    return { success: true, announcementId: Number(announcementId), confirmed_at: now };
  }

  /**
   * Кто прочитал и подтвердил оповещение. Список получателей берётся из
   * хранилища учётных записей, отметки — из базы переписки, сводятся в коде.
   */
  static async getAnnouncementAudit(announcementId) {
    const announcement = await this.getAnnouncementById(announcementId);
    if (!announcement) throw new Error('Оповещение не найдено');

    const employees = await identity().all(`
      SELECT u.id, u.username, u.full_name, u.job_title, d.name AS department_name
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.is_active = 1 AND u.approval_status = 'approved'
      ORDER BY u.full_name ASC
    `);

    const receipts = new Map(
      getDatabase()
        .prepare('SELECT user_id, read_at, confirmed_at, ip_address FROM announcement_receipts WHERE announcement_id = ?')
        .all(Number(announcementId))
        .map((r) => [Number(r.user_id), r])
    );

    const recipients = employees
      .map((employee) => {
        const receipt = receipts.get(Number(employee.id));
        return {
          ...employee,
          read_at: receipt?.read_at || null,
          confirmed_at: receipt?.confirmed_at || null,
          ip_address: receipt?.ip_address || null,
          is_confirmed: receipt?.confirmed_at ? 1 : 0
        };
      })
      .sort((a, b) => b.is_confirmed - a.is_confirmed || String(a.full_name).localeCompare(String(b.full_name)));

    const total = recipients.length;
    const confirmedCount = recipients.filter((r) => r.is_confirmed === 1).length;

    return {
      announcement,
      recipients,
      stats: {
        total,
        confirmedCount,
        pendingCount: total - confirmedCount,
        percentage: total > 0 ? Math.round((confirmedCount / total) * 100) : 0
      }
    };
  }
}

module.exports = AnnouncementService;
