const { getDatabase } = require('../db');

class AnnouncementService {
  static createAnnouncement({ author_id, title, content, target_type = 'all', target_ids = [], priority = 'normal', expires_at = null }) {
    const db = getDatabase();
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO announcements (author_id, title, content, target_type, target_ids_json, priority, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(author_id, title, content, target_type, JSON.stringify(target_ids), priority, expires_at, now);

    return this.getAnnouncementById(result.lastInsertRowid);
  }

  static getAnnouncementById(id) {
    const db = getDatabase();
    const ann = db.prepare(`
      SELECT a.*, u.full_name as author_name, u.job_title as author_job_title
      FROM announcements a
      JOIN users u ON a.author_id = u.id
      WHERE a.id = ?
    `).get(id);
    return ann;
  }

  static getAnnouncementsForUser(userId) {
    const db = getDatabase();
    const user = db.prepare('SELECT department_id FROM users WHERE id = ?').get(userId);
    const deptId = user ? user.department_id : null;

    const announcements = db.prepare(`
      SELECT a.*, u.full_name as author_name, u.job_title as author_job_title,
             ar.read_at, ar.confirmed_at,
             CASE WHEN ar.confirmed_at IS NOT NULL THEN 1 ELSE 0 END as is_confirmed
      FROM announcements a
      JOIN users u ON a.author_id = u.id
      LEFT JOIN announcement_receipts ar ON a.id = ar.announcement_id AND ar.user_id = ?
      WHERE (a.expires_at IS NULL OR a.expires_at > datetime('now'))
      ORDER BY a.created_at DESC
    `).all(userId);

    // Filter by target
    return announcements.filter(a => {
      if (a.target_type === 'all') return true;
      const targets = JSON.parse(a.target_ids_json || '[]');
      if (a.target_type === 'users') return targets.includes(userId);
      if (a.target_type === 'departments') return deptId && targets.includes(deptId);
      return true;
    });
  }

  static acknowledgeAnnouncement(announcementId, userId, ipAddress = '127.0.0.1') {
    const db = getDatabase();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO announcement_receipts (announcement_id, user_id, read_at, confirmed_at, ip_address)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(announcement_id, user_id) DO UPDATE SET confirmed_at = ?, ip_address = ?
    `).run(announcementId, userId, now, now, ipAddress, now, ipAddress);

    return { success: true, announcementId, confirmed_at: now };
  }

  static getAnnouncementAudit(announcementId) {
    const db = getDatabase();
    const announcement = this.getAnnouncementById(announcementId);
    if (!announcement) throw new Error('Оповещение не найдено');

    const users = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.job_title, d.name as department_name,
             ar.read_at, ar.confirmed_at, ar.ip_address,
             CASE WHEN ar.confirmed_at IS NOT NULL THEN 1 ELSE 0 END as is_confirmed
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      LEFT JOIN announcement_receipts ar ON ar.announcement_id = ? AND ar.user_id = u.id
      WHERE u.is_active = 1
      ORDER BY is_confirmed DESC, u.full_name ASC
    `).all(announcementId);

    const total = users.length;
    const confirmedCount = users.filter(u => u.is_confirmed === 1).length;

    return {
      announcement,
      recipients: users,
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
