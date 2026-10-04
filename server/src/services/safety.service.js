// Жалобы и блокировки пользователей (App Store 1.2). Таблицы user_blocks и
// reports лежат в базе переписки: видимость сообщений решается там же, одним
// запросом, без обращения к хранилищу учётных записей.
const { getDatabase } = require('../db');
const UserService = require('./user.service');

class SafetyError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'SafetyError';
    this.status = status;
    this.code = code;
  }
}

const REASON_MAX = 100;
const DETAILS_MAX = 2000;
const MAX_BLOCKS_PER_USER = 1000;
const MAX_OPEN_REPORTS_PER_USER = 200;

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function existingUser(id) {
  const user = await UserService.getUserById(id);
  return user && user.is_active && user.approval_status === 'approved' ? user : null;
}

// ── Блокировки ──

async function blockUser(blockerId, blockedRaw) {
  const blockedId = positiveInt(blockedRaw);
  if (!blockedId) throw new SafetyError(400, 'Укажите пользователя');
  if (blockedId === Number(blockerId)) throw new SafetyError(400, 'Нельзя заблокировать себя');
  if (!(await existingUser(blockedId))) throw new SafetyError(404, 'Пользователь не найден');
  const db = getDatabase();
  const count = db.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = ?').get(Number(blockerId));
  const already = db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(Number(blockerId), blockedId);
  if (!already && Number(count.n) >= MAX_BLOCKS_PER_USER) throw new SafetyError(400, 'Слишком много блокировок');
  db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(Number(blockerId), blockedId, new Date().toISOString());
  return { userId: blockedId };
}

function unblockUser(blockerId, blockedRaw) {
  const blockedId = positiveInt(blockedRaw);
  if (!blockedId) throw new SafetyError(400, 'Укажите пользователя');
  getDatabase().prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(Number(blockerId), blockedId);
}

async function listBlocks(blockerId) {
  const rows = getDatabase()
    .prepare('SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC, blocked_id DESC')
    .all(Number(blockerId));
  const directory = await UserService.getDirectory(rows.map((r) => r.blocked_id));
  return rows.map((r) => ({
    userId: Number(r.blocked_id),
    displayName: directory.get(Number(r.blocked_id))?.full_name || 'Удалённый пользователь',
    createdAt: r.created_at
  }));
}

function isBlockedEitherWay(a, b) {
  return Boolean(getDatabase()
    .prepare('SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
    .get(Number(a), Number(b), Number(b), Number(a)));
}

// ── Жалобы ──

async function createReport(reporterId, body) {
  const { targetType, targetId: targetRaw, reason: reasonRaw, details: detailsRaw } = body || {};
  if (targetType !== 'message' && targetType !== 'user') throw new SafetyError(400, 'targetType: message или user');
  const targetId = positiveInt(targetRaw);
  if (!targetId) throw new SafetyError(400, 'Укажите targetId');
  if (typeof reasonRaw !== 'string' || !reasonRaw.trim()) throw new SafetyError(400, 'Укажите причину');
  const reason = reasonRaw.trim();
  if (reason.length > REASON_MAX) throw new SafetyError(400, `Причина — не длиннее ${REASON_MAX} символов`);
  if (detailsRaw !== undefined && detailsRaw !== null && typeof detailsRaw !== 'string') {
    throw new SafetyError(400, 'details должен быть строкой');
  }
  const details = detailsRaw ? detailsRaw.trim() : null;
  if (details && details.length > DETAILS_MAX) throw new SafetyError(400, `Подробности — не длиннее ${DETAILS_MAX} символов`);

  const db = getDatabase();
  let reportedUserId;
  if (targetType === 'message') {
    const m = db.prepare('SELECT id, sender_id, target_id, conversation_type FROM messages WHERE id = ?').get(targetId);
    // Жаловаться можно только на сообщение, которое пользователь сам видит.
    const visible = m && (m.conversation_type === 'channel'
      ? db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(m.target_id, Number(reporterId))
      : Number(m.sender_id) === Number(reporterId) || Number(m.target_id) === Number(reporterId));
    if (!visible) throw new SafetyError(404, 'Сообщение не найдено');
    reportedUserId = Number(m.sender_id);
  } else {
    if (targetId === Number(reporterId)) throw new SafetyError(400, 'Нельзя пожаловаться на себя');
    if (!(await existingUser(targetId))) throw new SafetyError(404, 'Пользователь не найден');
    reportedUserId = targetId;
  }

  const dup = db.prepare('SELECT id, status FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ?')
    .get(Number(reporterId), targetType, targetId);
  if (dup) return { id: Number(dup.id), status: dup.status };

  const open = db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND status = 'open'`).get(Number(reporterId));
  if (Number(open.n) >= MAX_OPEN_REPORTS_PER_USER) throw new SafetyError(429, 'Слишком много жалоб. Повторите позже.');

  const info = db.prepare(
    `INSERT INTO reports (reporter_id, target_type, target_id, reported_user_id, reason, details, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(Number(reporterId), targetType, targetId, reportedUserId, reason, details, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), status: 'open' };
}

async function listReports({ status = null, limit = 200 } = {}) {
  const db = getDatabase();
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const rows = status
    ? db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, cap)
    : db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT ?').all(cap);
  const ids = rows.flatMap((r) => [r.reporter_id, r.reported_user_id]).filter(Boolean);
  const directory = await UserService.getDirectory(ids);
  return rows.map((r) => {
    const message = r.target_type === 'message'
      ? db.prepare('SELECT text, is_deleted FROM messages WHERE id = ?').get(r.target_id)
      : null;
    return {
      id: Number(r.id),
      status: r.status,
      targetType: r.target_type,
      targetId: Number(r.target_id),
      reason: r.reason,
      details: r.details,
      createdAt: r.created_at,
      reporter: { id: Number(r.reporter_id), name: directory.get(Number(r.reporter_id))?.full_name || 'Удалённый пользователь' },
      reportedUser: r.reported_user_id
        ? { id: Number(r.reported_user_id), name: directory.get(Number(r.reported_user_id))?.full_name || 'Удалённый пользователь' }
        : null,
      messageText: message && !message.is_deleted ? message.text : null
    };
  });
}

function closeReport(id) {
  const info = getDatabase().prepare(`UPDATE reports SET status = 'closed' WHERE id = ?`).run(Number(id));
  return Number(info.changes) > 0;
}

// Удаление аккаунта: блокировки в обе стороны и жалобы самого пользователя.
function purgeUser(userId) {
  const db = getDatabase();
  db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').run(Number(userId), Number(userId));
  db.prepare('DELETE FROM reports WHERE reporter_id = ?').run(Number(userId));
}

module.exports = {
  SafetyError,
  blockUser,
  unblockUser,
  listBlocks,
  isBlockedEitherWay,
  createReport,
  listReports,
  closeReport,
  purgeUser
};
