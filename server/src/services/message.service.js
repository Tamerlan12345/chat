const { getDatabase } = require('../db');
const UserService = require('./user.service');

// Переписка лежит в SQLite, сотрудники — в отдельном хранилище. Поэтому имя и
// должность отправителя больше не приклеиваются к сообщению соединением
// таблиц: сообщения читаются здесь, а сведения о людях подставляются одним
// запросом на всю страницу (см. attachSenders). Разница в стоимости — один
// дополнительный запрос на 50 сообщений вместо соединения, зато никакой
// зависимости между двумя базами.

const DIALOG_LIST_LIMIT = 50;

const MESSAGE_TYPES = new Set(['text', 'file', 'image']);

// Текст без верхней границы сохранялся целиком и рассылался каждому участнику
// переписки — один авторизованный отправитель мог гонять по многомегабайтному
// сообщению в канал с сотней участников (аудит, находка №7). Предел щедрый —
// это не лимит на «длинное сообщение», а защита от злоупотребления.
const MAX_TEXT_LENGTH = 16000;

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
          CASE WHEN cm.user_id IS NOT NULL THEN (SELECT text FROM messages WHERE conversation_type = 'channel' AND target_id = c.id ORDER BY id DESC LIMIT 1) END AS last_message_text,
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

    // Только известные виды переписки и сообщений. Раньше принималось что
    // угодно — например «system» с пустым текстом несуществующему адресату.
    if (conversationType !== 'direct' && conversationType !== 'channel') {
      throw new Error('Неизвестный вид переписки');
    }
    if (!MESSAGE_TYPES.has(type)) {
      throw new Error('Недопустимый тип сообщения');
    }
    if (!Number.isInteger(Number(targetId)) || Number(targetId) <= 0) {
      throw new Error('Не указан получатель');
    }

    if (conversationType === 'channel') {
      this.assertChannelMember(Number(targetId), Number(senderId));
    } else {
      const recipient = await UserService.getUserById(Number(targetId));
      if (!recipient || !recipient.is_active || recipient.approval_status !== 'approved') {
        throw new Error('Получатель не найден');
      }
    }

    // Ответ — только на сообщение из этой же переписки: ссылка на чужое
    // подтягивала бы его текст туда, где его видеть не должны.
    if (replyToId) {
      const original = db.prepare('SELECT conversation_type, target_id, sender_id FROM messages WHERE id = ?').get(Number(replyToId));
      const sameConversation =
        original &&
        original.conversation_type === conversationType &&
        (conversationType === 'channel'
          ? Number(original.target_id) === Number(targetId)
          : (Number(original.sender_id) === Number(senderId) && Number(original.target_id) === Number(targetId)) ||
            (Number(original.sender_id) === Number(targetId) && Number(original.target_id) === Number(senderId)));
      if (!sameConversation) replyToId = null;
    }

    const body = typeof text === 'string' ? text : String(text ?? '');
    if (!body.trim() && type === 'text') {
      throw new Error('Пустое сообщение не отправляется');
    }
    if (body.length > MAX_TEXT_LENGTH) {
      throw new Error(`Сообщение слишком длинное (не больше ${MAX_TEXT_LENGTH} символов)`);
    }

    // Ссылка на вложение и есть пропуск к файлу: доступ к скачиванию выдаётся
    // каждому участнику переписки, где файл упомянут. Без этой проверки
    // сотрудник вписывал в своё сообщение номер чужого файла и скачивал его.
    if (metadata !== null && metadata !== undefined) {
      if (typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 4096) {
        throw new Error('Недопустимые сведения о вложении');
      }
      if (metadata.file_id !== undefined && metadata.file_id !== null) {
        const fileId = Number(metadata.file_id);
        const FileService = require('./file.service');
        if (!Number.isInteger(fileId) || !FileService.canUserAccessFile(Number(senderId), fileId)) {
          throw new Error('Вложение недоступно: файл не найден или относится к чужой переписке');
        }
      }
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
    const originalNames = this.fileOriginalNames(rows);
    return rows.map((row) => {
      const sender = directory.get(Number(row.sender_id));
      const fileId = this.metadataFileId(row);
      return {
        ...row,
        sender_username: sender?.username || null,
        sender_name: sender?.full_name || 'Удалённый сотрудник',
        sender_avatar: sender?.avatar_url || null,
        sender_department: sender?.department_name || null,
        // Имя для скачивания вложения: только отсюда, никогда из текста
        // сообщения. Текст задаёт отправитель и его можно подделать/спутать
        // (см. аудит безопасности, находка №6) — original_name из таблицы
        // files записывается один раз при загрузке и с тех пор неизменен.
        file_original_name: fileId != null ? (originalNames.get(fileId) ?? null) : null
      };
    });
  }

  // Идентификатор вложения из metadata_json сообщения, если он там есть и
  // выглядит как число. Сам metadata_json клиенту не доверяем — при отправке
  // сообщения он уже проверен (sendMessage → FileService.canUserAccessFile),
  // но здесь достаточно просто вытащить число для последующего JOIN.
  static metadataFileId(row) {
    if (!row.metadata_json) return null;
    try {
      const meta = JSON.parse(row.metadata_json);
      const id = Number(meta?.file_id);
      return Number.isInteger(id) ? id : null;
    } catch {
      return null;
    }
  }

  // Одним запросом на всю пачку сообщений — вместо запроса к files на
  // каждую строку.
  static fileOriginalNames(rows) {
    const ids = [...new Set(rows.map((row) => this.metadataFileId(row)).filter((id) => id !== null))];
    if (!ids.length) return new Map();
    const db = getDatabase();
    const placeholders = ids.map(() => '?').join(', ');
    const found = db.prepare(`SELECT id, original_name FROM files WHERE id IN (${placeholders})`).all(...ids);
    return new Map(found.map((f) => [Number(f.id), f.original_name]));
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

    // Только ещё не прочитанные. Раньше возвращалась вся история собеседника, и
    // каждая отметка порождала рассылку — на которую открытый у собеседника
    // чат отвечал своей отметкой. Два открытых диалога гоняли так тысячи
    // запросов в секунду, переписывая статусы всей переписки.
    const unread = db
      .prepare(`
        SELECT m.id FROM messages m
        WHERE m.conversation_type = 'direct' AND m.sender_id = ? AND m.target_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM message_statuses s
            WHERE s.message_id = m.id AND s.user_id = ? AND s.status = 'read'
          )
      `)
      .all(target, me, me);

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

  /**
   * Системные каналы («Общий», «Объявления») — для всех сотрудников. Участие
   * добавлялось только при одобрении заявки и при импорте; заведённый через
   * консоль видел канал в списке, но читать и писать в него не мог.
   * Возвращает число добавленных участий; повторный вызов ничего не дублирует.
   */
  static addToDefaultChannels(userIds) {
    const ids = [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return 0;
    const db = getDatabase();
    const now = new Date().toISOString();
    const systemChannels = db.prepare(`SELECT id FROM channels WHERE type = 'system'`).all();
    const insertMember = db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    );
    let added = 0;
    for (const userId of ids) {
      for (const channel of systemChannels) {
        added += Number(insertMember.run(channel.id, userId, 'member', now).changes || 0);
      }
    }
    return added;
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
module.exports.MAX_TEXT_LENGTH = MAX_TEXT_LENGTH;
