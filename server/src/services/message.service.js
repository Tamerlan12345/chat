const { getDatabase } = require('../db');

class MessageService {
  // Reused by REST and WS call sites — a channel has no implicit "everyone can
  // read/write" rule; membership must be checked explicitly. See
  // docs/designs/auth-access-control-remediation.md item 6.
  static isChannelMember(channelId, userId) {
    const db = getDatabase();
    return !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
  }

  static assertChannelMember(channelId, userId) {
    if (!this.isChannelMember(channelId, userId)) {
      throw new Error('NOT_CHANNEL_MEMBER');
    }
  }

  static getChannels(userId) {
    const db = getDatabase();
    const channels = db.prepare(`
      SELECT c.*, cm.role as member_role, cm.last_read_message_id,
        (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) as members_count,
        (SELECT COUNT(*) FROM messages WHERE conversation_type = 'channel' AND target_id = c.id AND id > cm.last_read_message_id) as unread_count,
        (SELECT text FROM messages WHERE conversation_type = 'channel' AND target_id = c.id ORDER BY id DESC LIMIT 1) as last_message_text,
        (SELECT created_at FROM messages WHERE conversation_type = 'channel' AND target_id = c.id ORDER BY id DESC LIMIT 1) as last_message_time
      FROM channels c
      LEFT JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ?
      WHERE c.type = 'public' OR c.type = 'system' OR cm.user_id = ?
      ORDER BY COALESCE(last_message_time, c.created_at) DESC
    `).all(userId, userId);
    return channels;
  }

  static getDirectConversations(userId) {
    const db = getDatabase();
    // Get all users with whom the user has had direct messages, or list active users
    const conversations = db.prepare(`
      SELECT 
        u.id as user_id, u.username, u.full_name, u.avatar_url, u.status, u.custom_status, 
        u.job_title, u.uin, u.extension, u.email, u.phone, u.company, d.name as department_name,
        lm.id as last_message_id, lm.text as last_message_text, lm.created_at as last_message_time, 
        lm.sender_id as last_message_sender_id, lm.type as last_message_type,
        (
          SELECT COUNT(*) FROM messages m
          WHERE m.conversation_type = 'direct' 
            AND m.sender_id = u.id 
            AND m.target_id = ? 
            AND m.id NOT IN (
              SELECT message_id FROM message_statuses WHERE user_id = ? AND status = 'read'
            )
        ) as unread_count
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      LEFT JOIN messages lm ON lm.id = (
        SELECT id FROM messages 
        WHERE conversation_type = 'direct' 
          AND ((sender_id = ? AND target_id = u.id) OR (sender_id = u.id AND target_id = ?))
        ORDER BY created_at DESC, id DESC LIMIT 1
      )
      WHERE u.id != ? AND u.is_active = 1
      ORDER BY COALESCE(lm.created_at, '1970-01-01') DESC, u.status = 'online' DESC, u.full_name ASC
    `).all(userId, userId, userId, userId, userId);

    return conversations;
  }

  static getMessages(conversationType, targetId, currentUserId, limit = 50, beforeId = null) {
    const db = getDatabase();

    let query = '';
    let params = [];

    if (conversationType === 'channel') {
      this.assertChannelMember(targetId, currentUserId);
      query = `
        SELECT m.*, u.username as sender_username, u.full_name as sender_name, 
               u.avatar_url as sender_avatar, d.name as sender_department
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        LEFT JOIN departments d ON u.department_id = d.id
        WHERE m.conversation_type = 'channel' AND m.target_id = ?
      `;
      params.push(targetId);
    } else {
      // Direct dialogue between currentUserId and targetId
      query = `
        SELECT m.*, u.username as sender_username, u.full_name as sender_name, 
               u.avatar_url as sender_avatar, d.name as sender_department,
               (SELECT status FROM message_statuses WHERE message_id = m.id AND user_id = CASE WHEN m.sender_id = ? THEN ? ELSE ? END ORDER BY timestamp DESC LIMIT 1) as delivery_status
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        LEFT JOIN departments d ON u.department_id = d.id
        WHERE m.conversation_type = 'direct' 
          AND ((m.sender_id = ? AND m.target_id = ?) OR (m.sender_id = ? AND m.target_id = ?))
      `;
      params.push(currentUserId, targetId, currentUserId, currentUserId, targetId, targetId, currentUserId);
    }

    if (beforeId) {
      query += ' AND m.id < ? ';
      params.push(beforeId);
    }

    query += ' ORDER BY m.id DESC LIMIT ? ';
    params.push(limit);

    const rows = db.prepare(query).all(...params);
    // Return in chronological order
    return rows.reverse();
  }

  static sendMessage({ conversationType, targetId, senderId, text, type = 'text', replyToId = null, metadata = null }) {
    const db = getDatabase();
    const now = new Date().toISOString();

    if (conversationType === 'channel') {
      this.assertChannelMember(targetId, senderId);
    }

    const result = db.prepare(`
      INSERT INTO messages (conversation_type, target_id, sender_id, text, type, reply_to_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conversationType, targetId, senderId, text, type, replyToId, metadata ? JSON.stringify(metadata) : null, now);

    const messageId = result.lastInsertRowid;

    // If channel message, update last_read for sender
    if (conversationType === 'channel') {
      db.prepare(`
        INSERT INTO channel_members (channel_id, user_id, joined_at, last_read_message_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = ?
      `).run(targetId, senderId, now, messageId, messageId);
    }

    return this.getMessageById(messageId);
  }

  static getMessageById(messageId) {
    const db = getDatabase();
    return db.prepare(`
      SELECT m.*, u.username as sender_username, u.full_name as sender_name, 
             u.avatar_url as sender_avatar, d.name as sender_department
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE m.id = ?
    `).get(messageId);
  }

  static markAsRead(conversationType, targetId, currentUserId) {
    const db = getDatabase();
    const now = new Date().toISOString();

    if (conversationType === 'channel') {
      const maxIdRow = db.prepare(`
        SELECT MAX(id) as max_id FROM messages 
        WHERE conversation_type = 'channel' AND target_id = ?
      `).get(targetId);
      const maxId = maxIdRow ? maxIdRow.max_id || 0 : 0;

      db.prepare(`
        UPDATE channel_members 
        SET last_read_message_id = ? 
        WHERE channel_id = ? AND user_id = ?
      `).run(maxId, targetId, currentUserId);
      return { lastReadId: maxId };
    } else {
      // Direct messages: mark all unread messages from targetId to currentUserId as read
      const unread = db.prepare(`
        SELECT id FROM messages 
        WHERE conversation_type = 'direct' AND sender_id = ? AND target_id = ?
      `).all(targetId, currentUserId);

      const insertStatus = db.prepare(`
        INSERT OR REPLACE INTO message_statuses (message_id, user_id, status, timestamp)
        VALUES (?, ?, 'read', ?)
      `);

      for (const msg of unread) {
        insertStatus.run(msg.id, currentUserId, now);
      }
      return { readCount: unread.length, messageIds: unread.map(m => m.id) };
    }
  }

  static searchMessages(query, userId) {
    const db = getDatabase();
    const pattern = `%${query}%`;
    return db.prepare(`
      SELECT m.*, u.full_name as sender_name, c.name as channel_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN channels c ON m.conversation_type = 'channel' AND m.target_id = c.id
      WHERE m.text LIKE ? AND (
        (m.conversation_type = 'channel' AND m.target_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)) OR
        (m.conversation_type = 'direct' AND (m.sender_id = ? OR m.target_id = ?))
      )
      ORDER BY m.id DESC LIMIT 30
    `).all(pattern, userId, userId, userId);
  }

  static searchAuditLogs(query = '', limit = 100) {
    const db = getDatabase();
    let sql = `
      SELECT m.*, u.full_name as sender_name, u.username as sender_username, u.uin as sender_uin,
        CASE 
          WHEN m.conversation_type = 'direct' THEN (SELECT full_name FROM users WHERE id = m.target_id)
          ELSE (SELECT name FROM channels WHERE id = m.target_id)
        END as target_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
    `;
    const params = [];
    if (query && query.trim()) {
      sql += ` WHERE m.text LIKE ? OR u.full_name LIKE ? OR u.username LIKE ?`;
      const q = `%${query.trim()}%`;
      params.push(q, q, q);
    }
    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(Number(limit) || 100);
    return db.prepare(sql).all(...params);
  }
}

module.exports = MessageService;
