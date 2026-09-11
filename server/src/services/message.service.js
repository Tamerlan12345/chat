const { getDatabase } = require('../db');
const UserService = require('./user.service');

// Переписка лежит в SQLite, сотрудники — в отдельном хранилище. Поэтому имя и
// должность отправителя больше не приклеиваются к сообщению соединением
// таблиц: сообщения читаются здесь, а сведения о людях подставляются одним
// запросом на всю страницу (см. attachSenders). Разница в стоимости — один
// дополнительный запрос на 50 сообщений вместо соединения, зато никакой
// зависимости между двумя базами.

const DIALOG_LIST_LIMIT = 50;

class MessageService {
  // У канала нет негласного правила «читать может каждый»: участие
  // проверяется явно, и в REST, и в WebSocket.
  static isChannelMember(channelId, userId) {
    return !!getDatabase()
      .prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
      .get(Number(channelId), Number(userId));
  }

  static assertChannelMember(channelId, userId) {
    if (!this.isChannelMember(channelId, userId)) {
      throw new Error('NOT_CHANNEL_MEMBER');
    }
  }

  static getChannels(userId) {
    return getDatabase()
      .prepare(`
        SELECT c.*, cm.role AS member_role, cm.last_read_message_id,
          (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS members_count,
          (SELECT COUNT(*) FROM messages WHERE conversation_type = 'channel' AND target_id = c.id AND id > COALESCE(cm.last_read_message_id, 0)) AS unread_count,
          (SELECT text FROM messages WHERE conversation_type = 'channel' AND target_id = c.id ORDER BY id DESC LIMIT 1) AS last_message_text,
          (SELECT created_at FROM messages WHERE conversation_type = 'channel' AND target_id = c.id ORDER BY id DESC LIMIT 1) AS last_message_time
        FROM channels c
        LEFT JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ?
        WHERE c.type = 'public' OR c.type = 'system' OR cm.user_id = ?
        ORDER BY COALESCE(last_message_time, c.created_at) DESC
      `)
      .all(Number(userId), Number(userId));
  }

  /**
   * Список переписок. Возвращает только тех, с кем переписка действительно
   * была: раньше здесь перечислялись все сотрудники компании, и «беседы»
   * появлялись у человека сами собой, ещё до первого сообщения.
   */
  static async getDirectConversations(userId, limit = DIALOG_LIST_LIMIT) {
    const db = getDatabase();
    const me = Number(userId);

    const partners = db
      .prepare(`
        SELECT partner_id, MAX(id) AS last_message_id
        FROM (
          SELECT CASE WHEN sender_id = ? THEN target_id ELSE sender_id END AS partner_id, id
          FROM messages
          WHERE conversation_type = 'direct' AND (sender_id = ? OR target_id = ?)
        )
        WHERE partner_id <> ?
        GROUP BY partner_id
        ORDER BY last_message_id DESC
        LIMIT ?
      `)
      .all(me, me, me, me, Number(limit) || DIALOG_LIST_LIMIT);

    if (!partners.length) return [];

    const messageIds = partners.map((p) => p.last_message_id);
    const placeholders = messageIds.map(() => '?').join(', ');
    const lastMessages = new Map(
      db
        .prepare(`SELECT id, text, created_at, sender_id, type FROM messages WHERE id IN (${placeholders})`)
        .all(...messageIds)
        .map((m) => [m.id, m])
    );

    const partnerIds = partners.map((p) => Number(p.partner_id));
    const unreadPlaceholders = partnerIds.map(() => '?').join(', ');
    const unread = new Map(
      db
        .prepare(`
          SELECT m.sender_id, COUNT(*) AS n
          FROM messages m
          WHERE m.conversation_type = 'direct'
            AND m.target_id = ?
            AND m.sender_id IN (${unreadPlaceholders})
            AND NOT EXISTS (
              SELECT 1 FROM message_statuses s
              WHERE s.message_id = m.id AND s.user_id = ? AND s.status = 'read'
            )
          GROUP BY m.sender_id
        `)
        .all(me, ...partnerIds, me)
        .map((r) => [Number(r.sender_id), Number(r.n)])
    );

    const directory = await UserService.getDirectory(partnerIds);

    return partners
      .map((partner) => {
        const person = directory.get(Number(partner.partner_id));
        // Сотрудника могли удалить из хранилища учётных записей — переписка
        // при этом остаётся. Показывать пустую строку вместо имени хуже, чем
        // честно назвать её удалённой.
        const last = lastMessages.get(partner.last_message_id) || null;
        return {
          user_id: Number(partner.partner_id),
          username: person?.username || null,
          full_name: person?.full_name || 'Удалённый сотрудник',
          avatar_url: person?.avatar_url || null,
          status: person?.status || 'offline',
          custom_status: person?.custom_status || null,
          job_title: person?.job_title || null,
          uin: person?.uin || null,
          extension: person?.extension || null,
          email: person?.email || null,
          phone: person?.phone || null,
          company: person?.company || null,
          department_name: person?.department_name || null,
          last_message_id: partner.last_message_id,
          last_message_text: last?.text || null,
          last_message_time: last?.created_at || null,
          last_message_sender_id: last?.sender_id ?? null,
          last_message_type: last?.type || null,
          unread_count: unread.get(Number(partner.partner_id)) || 0
        };
      })
      .sort((a, b) => String(b.last_message_time || '').localeCompare(String(a.last_message_time || '')));
  }

  static async getMessages(conversationType, targetId, currentUserId, limit = 50, beforeId = null) {
    const db = getDatabase();
    const me = Number(currentUserId);
    const target = Number(targetId);
    const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);

    let query;
    const params = [];

    if (conversationType === 'channel') {
      this.assertChannelMember(target, me);
      query = `SELECT m.* FROM messages m WHERE m.conversation_type = 'channel' AND m.target_id = ?`;
      params.push(target);
    } else {
      query = `
        SELECT m.*,
               (SELECT status FROM message_statuses
                WHERE message_id = m.id
                  AND user_id = CASE WHEN m.sender_id = ? THEN ? ELSE ? END
                ORDER BY timestamp DESC LIMIT 1) AS delivery_status
        FROM messages m
        WHERE m.conversation_type = 'direct'
          AND ((m.sender_id = ? AND m.target_id = ?) OR (m.sender_id = ? AND m.target_id = ?))
      `;
      params.push(me, target, me, me, target, target, me);
    }

    if (beforeId) {
      query += ' AND m.id < ? ';
      params.push(Number(beforeId));
    }

    query += ' ORDER BY m.id DESC LIMIT ? ';
    params.push(capped);

    const rows = db.prepare(query).all(...params);
    rows.reverse(); // в хронологическом порядке
    return this.attachSenders(rows);
  }

  static async sendMessage({
    conversationType, targetId, senderId, text, type = 'text', replyToId = null, metadata = null
  }) {
    const db = getDatabase();
    const now = new Date().toISOString();

    if (conversationType === 'channel') {
      this.assertChannelMember(Number(targetId), Number(senderId));
    }

    const body = typeof text === 'string' ? text : String(text ?? '');
    if (!body.trim() && type === 'text') {
      throw new Error('Пустое сообщение не отправляется');
    }

    const result = db
      .prepare(`
        INSERT INTO messages (conversation_type, target_id, sender_id, text, type, reply_to_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        conversationType,
        Number(targetId),
        Number(senderId),
        body,
        type,
        replyToId ? Number(replyToId) : null,
        metadata ? JSON.stringify(metadata) : null,
        now
      );

    const messageId = Number(result.lastInsertRowid);

    if (conversationType === 'channel') {
      db.prepare(`
        INSERT INTO channel_members (channel_id, user_id, joined_at, last_read_message_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = ?
      `).run(Number(targetId), Number(senderId), now, messageId, messageId);
    }

    return this.getMessageById(messageId);
  }

  static async getMessageById(messageId) {
    const row = getDatabase().prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!row) return null;
    const [withSender] = await this.attachSenders([row]);
    return withSender;
  }

  /**
   * Подставляет к сообщениям сведения об отправителях — одним запросом к
   * хранилищу учётных записей на всю пачку.
   */
  static async attachSenders(rows) {
    if (!rows.length) return rows;
    const directory = await UserService.getDirectory(rows.map((r) => r.sender_id));
    return rows.map((row) => {
      const sender = directory.get(Number(row.sender_id));
      return {
        ...row,
        sender_username: sender?.username || null,
        sender_name: sender?.full_name || 'Удалённый сотрудник',
        sender_avatar: sender?.avatar_url || null,
        sender_department: sender?.department_name || null
      };
    });
  }

  static markAsRead(conversationType, targetId, currentUserId) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const me = Number(currentUserId);
    const target = Number(targetId);

    if (conversationType === 'channel') {
      const maxIdRow = db
        .prepare(`SELECT MAX(id) AS max_id FROM messages WHERE conversation_type = 'channel' AND target_id = ?`)
        .get(target);
      const maxId = maxIdRow?.max_id || 0;

      db.prepare('UPDATE channel_members SET last_read_message_id = ? WHERE channel_id = ? AND user_id = ?')
        .run(maxId, target, me);
      return { lastReadId: maxId };
    }

    const unread = db
      .prepare(`SELECT id FROM messages WHERE conversation_type = 'direct' AND sender_id = ? AND target_id = ?`)
      .all(target, me);

    const insertStatus = db.prepare(`
      INSERT OR REPLACE INTO message_statuses (message_id, user_id, status, timestamp)
      VALUES (?, ?, 'read', ?)
    `);
    for (const message of unread) insertStatus.run(message.id, me, now);

    return { readCount: unread.length, messageIds: unread.map((m) => m.id) };
  }

  static async searchMessages(query, userId) {
    const db = getDatabase();
    const me = Number(userId);
    const rows = db
      .prepare(`
        SELECT m.*, c.name AS channel_name
        FROM messages m
        LEFT JOIN channels c ON m.conversation_type = 'channel' AND m.target_id = c.id
        WHERE m.text LIKE ? AND (
          (m.conversation_type = 'channel' AND m.target_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)) OR
          (m.conversation_type = 'direct' AND (m.sender_id = ? OR m.target_id = ?))
        )
        ORDER BY m.id DESC LIMIT 30
      `)
      .all(`%${query}%`, me, me, me);

    return this.attachSenders(rows);
  }

  /**
   * Журнал переписки для администратора. Поиск по тексту идёт в базе
   * переписки, поиск по человеку — в хранилище учётных записей: одним
   * запросом их больше не свести.
   */
  static async searchAuditLogs(query = '', limit = 100) {
    const db = getDatabase();
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const term = String(query || '').trim();

    let rows;
    if (!term) {
      rows = db.prepare('SELECT m.* FROM messages m ORDER BY m.id DESC LIMIT ?').all(capped);
    } else {
      const matchedUsers = await UserService.searchByName(term);
      const ids = matchedUsers.map((u) => Number(u.id));
      const idFilter = ids.length ? ` OR m.sender_id IN (${ids.map(() => '?').join(', ')})` : '';
      rows = db
        .prepare(`SELECT m.* FROM messages m WHERE m.text LIKE ?${idFilter} ORDER BY m.id DESC LIMIT ?`)
        .all(`%${term}%`, ...ids, capped);
    }

    const withSenders = await this.attachSenders(rows);

    // Имя собеседника в личной переписке и название канала — тоже из разных баз.
    const channelNames = new Map(
      db.prepare('SELECT id, name FROM channels').all().map((c) => [Number(c.id), c.name])
    );
    const directIds = withSenders
      .filter((m) => m.conversation_type === 'direct')
      .map((m) => Number(m.target_id));
    const targets = await UserService.getDirectory(directIds);

    return withSenders.map((message) => ({
      ...message,
      sender_uin: null,
      target_name:
        message.conversation_type === 'direct'
          ? targets.get(Number(message.target_id))?.full_name || null
          : channelNames.get(Number(message.target_id)) || null
    }));
  }

  static createChannel(name, topic, type, ownerId) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const formatted = String(name).startsWith('#') ? String(name) : `#${name}`;

    const result = db
      .prepare('INSERT INTO channels (name, topic, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(formatted, topic || '', type === 'private' ? 'private' : 'public', Number(ownerId), now);

    const channelId = Number(result.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(channelId, Number(ownerId), 'admin', now);

    return db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  }

  static getChannelMemberIds(channelId) {
    return getDatabase()
      .prepare('SELECT user_id FROM channel_members WHERE channel_id = ?')
      .all(Number(channelId))
      .map((r) => Number(r.user_id));
  }

  static markDelivered(messageId, userId) {
    const now = new Date().toISOString();
    getDatabase()
      .prepare("INSERT OR REPLACE INTO message_statuses (message_id, user_id, status, timestamp) VALUES (?, ?, 'delivered', ?)")
      .run(Number(messageId), Number(userId), now);
    return now;
  }
}

module.exports = MessageService;
module.exports.DIALOG_LIST_LIMIT = DIALOG_LIST_LIMIT;
