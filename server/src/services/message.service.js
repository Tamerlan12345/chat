const { getDatabase, withChangeSeq, getSyncState } = require('../db');
const UserService = require('./user.service');
const SettingsService = require('./settings.service');

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

// Rocket.Chat: Block Message Editing/Deleting After N Minutes. Значения
// настроек — минуты: 0 — без ограничения, -1 — действие выключено совсем.
// Администратор не задавал их раньше — час, чтобы опечатку можно было
// поправить сразу после отправки, но не превратить чат в редактируемый
// задним числом.
const DEFAULT_EDIT_WINDOW_MINUTES = '60';
const DEFAULT_DELETE_WINDOW_MINUTES = '60';
const DEFAULT_WINDOW_MINUTES = 60;
// Год в минутах — щедрый потолок для «сколько угодно, но не бесконечность
// как повод не думать»; validateSettingsUpdate (server/src/api/index.js)
// отклоняет всё, что вне -1..MAX_MESSAGE_WINDOW_MINUTES, ещё на записи.
const MAX_WINDOW_MINUTES = 525600;

// Только «-1», «0» или положительное целое — валидное значение окна. Раньше
// любой мусор (пустая строка, "abc", дробь) проходил как Number(...) === NaN
// или 0 и трактовался как «без ограничения» — испорченная или незаполненная
// настройка молча снимала защиту, а не включала её (находка ревью раунда 1).
function isValidWindowValue(raw) {
  if (raw === null || raw === undefined) return false;
  const str = String(raw).trim();
  if (!/^-?\d+$/.test(str)) return false; // только целое число, без дробной части и текста
  const n = Number(str);
  return n >= -1 && n <= MAX_WINDOW_MINUTES;
}

// Испорченное или отсутствующее значение — это «настройка не задана», а не
// «ограничения нет»: безопасный откат на DEFAULT_WINDOW_MINUTES, тот же
// принцип, что у max_upload_size_mb (server/src/api/index.js, acceptUpload).
function parseWindowMinutes(raw) {
  return isValidWindowValue(raw) ? Number(raw) : DEFAULT_WINDOW_MINUTES;
}

function isWithinWindow(createdAt, windowMinutesRaw) {
  const minutes = parseWindowMinutes(windowMinutesRaw);
  if (minutes === -1) return false;
  if (minutes === 0) return true;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs <= minutes * 60 * 1000;
}

// Ключ идемпотентности отправки, который придумывает клиент (обычно UUID).
// Только безопасный набор символов и не длиннее 64: значение хранится в базе,
// попадает в индекс и отражается в ответах — произвольный текст здесь не нужен.
const CLIENT_MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// /api/sync: страница по умолчанию и потолок, как у GET /api/messages.
const SYNC_DEFAULT_LIMIT = 100;
const SYNC_MAX_LIMIT = 200;

// Сколько последних входящих личных сообщений просматривается при входе
// получателя в поисках недоставленных (S3). Без предела каждый вход проверял
// бы всю историю человека, а после перезапуска сервера в сеть входит весь
// офис разом. Недоставленные — это всегда последние входящие.
const PENDING_DELIVERY_SCAN = 1000;

// Видимость сообщения пользователю — одна и та же для поиска и синхронизации:
// канал — только при участии (как assertChannelMember в getMessages), личное —
// только своё (отправитель или получатель). Параметры: user_id трижды.
const VISIBLE_TO_USER_SQL = `(
  (m.conversation_type = 'channel' AND m.target_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)) OR
  (m.conversation_type = 'direct' AND (m.sender_id = ? OR m.target_id = ?))
)`;

// Номер изменения выдаёт счётчик sync_state (db/index.js withChangeSeq), а не
// MAX(change_seq) по живым строкам: тот откатывался бы после физического
// удаления строк, и номера, уже выданные клиентам, достались бы новым
// изменениям.

// Курсор /api/sync: «<эпоха базы>.<номер изменения>». Клиенту — непрозрачная
// строка; эпоха отличает эту базу от её восстановленной копии.
const SYNC_CURSOR_PARSE_RE = /^([0-9a-f]{16})\.(\d{1,15})$/;

function formatSyncCursor(epoch, seq) {
  return `${epoch}.${seq}`;
}

function syncCursorError() {
  const err = new Error('Курсор синхронизации недействителен — загрузите переписку заново');
  err.code = 'SYNC_CURSOR_INVALID';
  return err;
}

function clientMsgIdError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Отказ с машинным кодом (G3/G4 delivery-state.md §10). Текст — прежний, для
// человека (настольный клиент показывает только его); код — для мобильных
// клиентов, которые по нему решают, повторять ли запрос.
const codedError = clientMsgIdError;

// Коды отказов, повторять которые бессмысленно: запрос неверен или запрещён.
// Всё остальное (RATE_LIMITED, INTERNAL_ERROR) — временное.
const PERMANENT_ERROR_CODES = new Set([
  'INVALID_CLIENT_MSG_ID', 'CLIENT_MSG_ID_CONFLICT', 'CANCELLED',
  'INVALID_CONVERSATION', 'INVALID_MESSAGE_TYPE', 'INVALID_TARGET', 'RECIPIENT_NOT_FOUND',
  'NOT_CHANNEL_MEMBER', 'EMPTY_TEXT', 'TEXT_TOO_LONG', 'INVALID_METADATA', 'ATTACHMENT_NOT_ACCESSIBLE',
  'NOT_FOUND', 'NOT_OWNER', 'MESSAGE_DELETED', 'NOT_TEXT_MESSAGE', 'EDIT_WINDOW_EXPIRED', 'DELETE_WINDOW_EXPIRED'
]);

const INTERNAL_ERROR_MESSAGE = 'Не удалось обработать запрос — повторите позже';

/**
 * Описание отказа для клиента: { code, retryable, message }. Наши проверки
 * бросают Error с кодом из PERMANENT_ERROR_CODES — их текст уходит как есть.
 * Всё прочее (ошибки базы, сети, программные) — INTERNAL_ERROR: временный
 * отказ без подробностей устройства сервера.
 */
function describeError(err) {
  if (err && err.message === 'NOT_CHANNEL_MEMBER') {
    return { code: 'NOT_CHANNEL_MEMBER', retryable: false, message: 'Вы не участник этого канала' };
  }
  if (err && PERMANENT_ERROR_CODES.has(err.code)) {
    return { code: err.code, retryable: false, message: err.message };
  }
  console.error('[Messages] внутренняя ошибка:', err?.message || err);
  return { code: 'INTERNAL_ERROR', retryable: true, message: INTERNAL_ERROR_MESSAGE };
}

// Отменённые ключи отправки (cancel_message, G9): сколько помнить и сколько
// держать на одного отправителя. Читаются при каждом вызове — тесты меняют их.
function cancelledKeyTtlMs() {
  const value = Number(process.env.CANCELLED_KEY_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 24 * 60 * 60 * 1000;
}
function cancelledKeysPerSender() {
  const value = Number(process.env.CANCELLED_KEYS_PER_SENDER);
  return Number.isInteger(value) && value > 0 ? value : 1000;
}

/**
 * Проверяет client_msg_id из запроса. undefined/null — поля нет (как у
 * настольного клиента). Любое другое значение обязано быть строкой из
 * безопасного набора, иначе — ошибка с кодом INVALID_CLIENT_MSG_ID.
 */
function normalizeClientMsgId(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !CLIENT_MSG_ID_RE.test(raw)) {
    throw clientMsgIdError(
      'INVALID_CLIENT_MSG_ID',
      'Недопустимый client_msg_id: строка 1–64 символа из A–Z, a–z, 0–9, «_» и «-»'
    );
  }
  return raw;
}

// Экранирование для LIKE … ESCAPE '\': символы шаблона из строки поиска
// сотрудника ищутся буквально.
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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
      throw codedError('NOT_CHANNEL_MEMBER', 'NOT_CHANNEL_MEMBER');
    }
  }

  static getChannels(userId) {
    return getDatabase()
      .prepare(`
        SELECT c.*, cm.role AS member_role, cm.last_read_message_id,
          (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS members_count,
          (SELECT COUNT(*) FROM messages WHERE conversation_type = 'channel' AND target_id = c.id AND id > COALESCE(cm.last_read_message_id, 0)) AS unread_count,
          CASE WHEN cm.user_id IS NOT NULL THEN (SELECT text FROM messages WHERE conversation_type = 'channel' AND target_id = c.id ORDER BY id DESC LIMIT 1) END AS last_message_text,
          -- G7: id последнего сообщения в том же снимке, что и unread_count, —
          -- клиент досчитывает живые сообщения, пришедшие после расчёта.
          CASE WHEN cm.user_id IS NOT NULL THEN (SELECT id FROM messages WHERE conversation_type = 'channel' AND target_id = c.id ORDER BY id DESC LIMIT 1) END AS last_message_id,
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

  /**
   * Страница переписки. beforeId — назад, к более старым (последние limit до
   * него); afterId — вперёд, к более новым (первые limit после него). В обоих
   * случаях результат по возрастанию id.
   */
  static async getMessages(conversationType, targetId, currentUserId, limit = 50, beforeId = null, afterId = null) {
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

    const forward = afterId !== null && afterId !== undefined;
    if (forward) {
      query += ' AND m.id > ? ';
      params.push(Number(afterId));
    }

    query += forward ? ' ORDER BY m.id ASC LIMIT ? ' : ' ORDER BY m.id DESC LIMIT ? ';
    params.push(capped);

    const rows = db.prepare(query).all(...params);
    if (!forward) rows.reverse(); // в хронологическом порядке
    return this.attachSenders(rows);
  }

  static async sendMessage(params) {
    return (await this.sendMessageIdempotent(params)).message;
  }

  /**
   * Сообщение с тем же client_msg_id этого же отправителя, если оно уже есть.
   * Повтор в другую переписку — ошибка CLIENT_MSG_ID_CONFLICT: возвращать
   * запись не той переписки значило бы молча «доставить» не туда.
   */
  static findClientDuplicate(db, { senderId, clientMsgId, conversationType, targetId }) {
    if (!clientMsgId) return null;
    const existing = db
      .prepare('SELECT id, conversation_type, target_id FROM messages WHERE sender_id = ? AND client_msg_id = ?')
      .get(Number(senderId), clientMsgId);
    if (!existing) return null;
    if (existing.conversation_type !== conversationType || Number(existing.target_id) !== Number(targetId)) {
      throw clientMsgIdError('CLIENT_MSG_ID_CONFLICT', 'Этот client_msg_id уже использован для другой переписки');
    }
    return Number(existing.id);
  }

  /**
   * Отправка с защитой от повтора. Возвращает { message, duplicate }:
   * duplicate = true, если сообщение с этим client_msg_id у отправителя уже
   * было, — тогда ничего не записывается и возвращается сохранённая запись
   * (в том числе удалённая, как надгробие).
   *
   * Каждый отказ — Error с машинным code (describeError) и случается ДО записи
   * (G3): запись строки и участие в канале — одна точка сохранения, а после неё
   * отказа уже не бывает — если не удалось подставить сведения об отправителе,
   * возвращается сохранённая запись с отправителем из senderProfile (тот, кто
   * отправляет: пользователь сокета или запроса).
   */
  static async sendMessageIdempotent({
    conversationType, targetId, senderId, text, type = 'text', replyToId = null, metadata = null, clientMsgId = null,
    senderProfile = null
  }) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const clientKey = normalizeClientMsgId(clientMsgId);

    // Только известные виды переписки и сообщений. Раньше принималось что
    // угодно — например «system» с пустым текстом несуществующему адресату.
    if (conversationType !== 'direct' && conversationType !== 'channel') {
      throw codedError('INVALID_CONVERSATION', 'Неизвестный вид переписки');
    }
    if (!MESSAGE_TYPES.has(type)) {
      throw codedError('INVALID_MESSAGE_TYPE', 'Недопустимый тип сообщения');
    }
    if (!Number.isInteger(Number(targetId)) || Number(targetId) <= 0) {
      throw codedError('INVALID_TARGET', 'Не указан получатель');
    }

    // Повтор узнаётся раньше остальных проверок: отправка уже состоялась, и
    // ответ на её повтор не должен зависеть от того, что изменилось с тех пор.
    // Ищется только среди сообщений САМОГО отправителя — чужое не вернётся.
    const knownId = this.findClientDuplicate(db, { senderId, clientMsgId: clientKey, conversationType, targetId });
    if (knownId) return { message: await this.storedMessage(knownId, senderProfile), duplicate: true };
    // Автор отозвал этот ключ (cancel_message), и сохранено ничего не было.
    this.assertNotCancelled(db, senderId, clientKey);

    if (conversationType === 'channel') {
      this.assertChannelMember(Number(targetId), Number(senderId));
    } else {
      const recipient = await UserService.getUserById(Number(targetId));
      if (!recipient || !recipient.is_active || recipient.approval_status !== 'approved') {
        throw codedError('RECIPIENT_NOT_FOUND', 'Получатель не найден');
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
      throw codedError('EMPTY_TEXT', 'Пустое сообщение не отправляется');
    }
    if (body.length > MAX_TEXT_LENGTH) {
      throw codedError('TEXT_TOO_LONG', `Сообщение слишком длинное (не больше ${MAX_TEXT_LENGTH} символов)`);
    }

    // Ссылка на вложение и есть пропуск к файлу: доступ к скачиванию выдаётся
    // каждому участнику переписки, где файл упомянут. Без этой проверки
    // сотрудник вписывал в своё сообщение номер чужого файла и скачивал его.
    if (metadata !== null && metadata !== undefined) {
      if (typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 4096) {
        throw codedError('INVALID_METADATA', 'Недопустимые сведения о вложении');
      }
      if (metadata.file_id !== undefined && metadata.file_id !== null) {
        const fileId = Number(metadata.file_id);
        const FileService = require('./file.service');
        if (!Number.isInteger(fileId) || !FileService.canUserAccessFile(Number(senderId), fileId)) {
          throw codedError('ATTACHMENT_NOT_ACCESSIBLE', 'Вложение недоступно: файл не найден или относится к чужой переписке');
        }
      }
    }

    // Между первой проверкой и записью были await (получатель, файл) — за это
    // время мог успеть сохраниться параллельный повтор или прийти отзыв ключа.
    // Отсюда и до INSERT кода с await нет, так что эти проверки и запись
    // неразрывны: cancel_message либо видит сохранённую строку (и удаляет её),
    // либо эта отправка видит его отметку.
    const raced = this.findClientDuplicate(db, { senderId, clientMsgId: clientKey, conversationType, targetId });
    if (raced) return { message: await this.storedMessage(raced, senderProfile), duplicate: true };
    this.assertNotCancelled(db, senderId, clientKey);

    let messageId;
    try {
      // Строка и отметка прочтения автора в канале — одна точка сохранения:
      // не удалась вторая — нет и первой, и отказ честный (ничего не записано).
      messageId = withChangeSeq(db, (seq) => {
        const result = db
          .prepare(`
            INSERT INTO messages (conversation_type, target_id, sender_id, text, type, reply_to_id, metadata_json, created_at, client_msg_id, change_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            conversationType,
            Number(targetId),
            Number(senderId),
            body,
            type,
            replyToId ? Number(replyToId) : null,
            metadata ? JSON.stringify(metadata) : null,
            now,
            clientKey,
            seq
          );
        const id = Number(result.lastInsertRowid);
        if (conversationType === 'channel') {
          db.prepare(`
            INSERT INTO channel_members (channel_id, user_id, joined_at, last_read_message_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = ?
          `).run(Number(targetId), Number(senderId), now, id, id);
        }
        return id;
      });
    } catch (err) {
      // Уникальный индекс (sender_id, client_msg_id) — последняя линия защиты.
      const again = clientKey && /UNIQUE/i.test(String(err.message))
        ? this.findClientDuplicate(db, { senderId, clientMsgId: clientKey, conversationType, targetId })
        : null;
      if (again) return { message: await this.storedMessage(again, senderProfile), duplicate: true };
      throw err;
    }

    return { message: await this.storedMessage(messageId, senderProfile), duplicate: false };
  }

  /**
   * Сохранённая запись для ответа отправителю. Сведения об отправителях живут
   * в другой базе; если она сейчас недоступна, запись всё равно возвращается —
   * отправитель известен (senderProfile), а отказ после записи сказал бы
   * клиенту неправду: что сообщения нет (G3).
   */
  static async storedMessage(messageId, senderProfile = null) {
    try {
      const full = await this.getMessageById(messageId);
      if (full) return full;
    } catch (err) {
      console.warn('[Messages] сведения об отправителе недоступны, ответ без них:', err.message);
    }
    const stored = getDatabase().prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!stored) throw new Error('Сохранённое сообщение не найдено');
    const directory = new Map();
    if (senderProfile && Number(senderProfile.id) === Number(stored.sender_id)) {
      directory.set(Number(stored.sender_id), senderProfile);
    }
    let originalNames = new Map();
    try {
      originalNames = this.fileOriginalNames([stored]);
    } catch {
      /* без имени вложения — не повод отказывать */
    }
    return this.decorateRows([stored], directory, originalNames)[0];
  }

  // ── Отменённые ключи отправки (cancel_message, G9) ──────────────────────

  static isCancelled(db, senderId, clientKey) {
    if (!clientKey) return false;
    return !!db
      .prepare('SELECT 1 FROM cancelled_client_msgs WHERE sender_id = ? AND client_msg_id = ? AND cancelled_at >= ?')
      .get(Number(senderId), clientKey, Date.now() - cancelledKeyTtlMs());
  }

  static assertNotCancelled(db, senderId, clientKey) {
    if (this.isCancelled(db, senderId, clientKey)) {
      throw codedError('CANCELLED', 'Отправка отменена автором');
    }
  }

  /**
   * Запоминает отзыв ключа отправителем: на срок cancelledKeyTtlMs, не больше
   * cancelledKeysPerSender на отправителя (старые вытесняются). Повторный
   * отзыв продлевает срок. Хранится в SQLite — переживает перезапуск.
   */
  static recordCancelled(db, senderId, clientKey) {
    const now = Date.now();
    db.prepare('DELETE FROM cancelled_client_msgs WHERE cancelled_at < ?').run(now - cancelledKeyTtlMs());
    db.prepare(`
      INSERT INTO cancelled_client_msgs (sender_id, client_msg_id, cancelled_at) VALUES (?, ?, ?)
      ON CONFLICT(sender_id, client_msg_id) DO UPDATE SET cancelled_at = excluded.cancelled_at
    `).run(Number(senderId), clientKey, now);
    db.prepare(`
      DELETE FROM cancelled_client_msgs
      WHERE sender_id = ? AND rowid NOT IN (
        SELECT rowid FROM cancelled_client_msgs WHERE sender_id = ? ORDER BY cancelled_at DESC, rowid DESC LIMIT ?
      )
    `).run(Number(senderId), Number(senderId), cancelledKeysPerSender());
  }

  /**
   * cancel_message: «если этот ключ придёт — не сохраняй; если уже сохранён —
   * удали». Только свои ключи (пара отправитель + ключ). Отметка и поиск
   * строки идут без await между ними, как и проверка с записью в отправке,
   * поэтому при любом порядке с параллельной отправкой либо отправка увидит
   * отметку (CANCELLED), либо отзыв увидит строку и удалит её.
   *
   * Возвращает { messageId: null, deleted: null } (ничего не сохранено и уже
   * не сохранится) или { messageId, deleted } — deleted как у deleteMessage
   * (alreadyDeleted = true, если удалено раньше). Удаление подчиняется окну
   * удаления; отказ — Error с code и messageId.
   */
  static async cancelClientMessage({ senderId, clientMsgId }) {
    const clientKey = normalizeClientMsgId(clientMsgId);
    if (!clientKey) {
      throw codedError('INVALID_CLIENT_MSG_ID', 'Недопустимый client_msg_id: строка 1–64 символа из A–Z, a–z, 0–9, «_» и «-»');
    }
    const db = getDatabase();
    this.recordCancelled(db, senderId, clientKey);
    const stored = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND client_msg_id = ?').get(Number(senderId), clientKey);
    if (!stored) return { messageId: null, deleted: null };
    const messageId = Number(stored.id);
    try {
      const deleted = await this.deleteMessage({ messageId, actorId: senderId, isSuperAdmin: false });
      return { messageId, deleted };
    } catch (err) {
      err.messageId = messageId;
      throw err;
    }
  }

  /**
   * Сдвигает сообщения в конец последовательности изменений: правка,
   * удаление, смена статуса доставки/прочтения. Синхронизация (/api/sync)
   * вернёт их снова, уже в новом состоянии.
   */
  static touchMessages(ids) {
    const unique = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!unique.length) return;
    const db = getDatabase();
    const bump = db.prepare('UPDATE messages SET change_seq = ? WHERE id = ?');
    for (const id of unique) withChangeSeq(db, (seq) => bump.run(seq, id));
  }

  /**
   * Правка своего текстового сообщения (Rocket.Chat: Allow Message Editing).
   * Старый текст уходит в message_history до того, как строка в messages
   * перезаписывается, — иначе первая же правка стирала бы след безвозвратно.
   */
  static async editMessage({ messageId, actorId, text }) {
    const db = getDatabase();
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!message) throw codedError('NOT_FOUND', 'Сообщение не найдено');
    if (Number(message.sender_id) !== Number(actorId)) {
      throw codedError('NOT_OWNER', 'Нельзя редактировать чужое сообщение');
    }
    if (message.is_deleted) throw codedError('MESSAGE_DELETED', 'Сообщение удалено');
    if (message.type !== 'text') throw codedError('NOT_TEXT_MESSAGE', 'Редактировать можно только текстовые сообщения');

    const windowMinutes = await SettingsService.getSetting('message_edit_window_minutes', DEFAULT_EDIT_WINDOW_MINUTES);
    if (!isWithinWindow(message.created_at, windowMinutes)) {
      throw codedError('EDIT_WINDOW_EXPIRED', 'Время на изменение сообщения истекло');
    }

    const body = typeof text === 'string' ? text : String(text ?? '');
    if (!body.trim()) throw codedError('EMPTY_TEXT', 'Пустое сообщение не отправляется');
    if (body.length > MAX_TEXT_LENGTH) {
      throw codedError('TEXT_TOO_LONG', `Сообщение слишком длинное (не больше ${MAX_TEXT_LENGTH} символов)`);
    }

    // Пока ждали настройку, сообщение могли удалить — правка надгробия
    // вернула бы ему текст — или исправить параллельной правкой: в историю
    // идёт текст, который эта правка заменяет на самом деле, а не прочитанный
    // до ожидания (иначе промежуточная версия пропала бы из истории).
    const current = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id);
    if (!current) throw codedError('NOT_FOUND', 'Сообщение не найдено');
    if (current.is_deleted) throw codedError('MESSAGE_DELETED', 'Сообщение удалено');

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO message_history (message_id, action, old_text, old_metadata_json, actor_id, created_at)
      VALUES (?, 'edit', ?, ?, ?, ?)
    `).run(current.id, current.text, current.metadata_json, Number(actorId), now);

    withChangeSeq(db, (seq) => db.prepare('UPDATE messages SET text = ?, updated_at = ?, change_seq = ? WHERE id = ?')
      .run(body, now, seq, message.id));

    return this.getMessageById(message.id);
  }

  /**
   * Удаление своего сообщения (Rocket.Chat: Allow Message Deleting). Супер-
   * администратор удаляет чужое в целях модерации — без временного окна, но
   * с последующей записью в аудит (внешним кодом: здесь известно только то,
   * что удаление разрешено, а не кто его выполняет с точки зрения журнала).
   * Текст и вложение обнуляются в самой строке — reply-превью и поиск не
   * видят их ни при каком запросе; старые значения остаются только в
   * message_history.
   *
   * Удаление уже удалённого — не ошибка, а то же надгробие (G4): клиент,
   * повторивший удаление после обрыва, получает подтверждение. Только автору
   * (или супер-администратору): чужое надгробие постороннему — NOT_OWNER.
   * Повтор ничего не пишет: ни истории, ни нового номера изменения;
   * alreadyDeleted = true говорит вызывающему не рассылать его снова.
   */
  static async deleteMessage({ messageId, actorId, isSuperAdmin = false }) {
    const db = getDatabase();
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!message) throw codedError('NOT_FOUND', 'Сообщение не найдено');
    const tombstone = (row, alreadyDeleted) => ({
      id: row.id,
      conversation_type: row.conversation_type,
      target_id: Number(row.target_id),
      sender_id: Number(row.sender_id),
      updated_at: row.updated_at ?? null,
      alreadyDeleted
    });

    if (!isSuperAdmin && Number(message.sender_id) !== Number(actorId)) {
      throw codedError('NOT_OWNER', 'Нельзя удалить чужое сообщение');
    }
    if (message.is_deleted) return tombstone(message, true);

    // Строка, которую удаление обнуляет: без ожидания (супер-администратор) —
    // прочитанная выше; после ожидания настройки — перечитанная (её могли
    // исправить за это время, и в историю должен попасть последний текст).
    let current = message;
    if (!isSuperAdmin) {
      const windowMinutes = await SettingsService.getSetting('message_delete_window_minutes', DEFAULT_DELETE_WINDOW_MINUTES);
      if (!isWithinWindow(message.created_at, windowMinutes)) {
        throw codedError('DELETE_WINDOW_EXPIRED', 'Время на удаление сообщения истекло');
      }
      // Пока ждали настройку, то же сообщение мог удалить параллельный запрос
      // (другой сокет, cancel_message) — второе удаление не пишется.
      current = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id);
      if (!current) throw codedError('NOT_FOUND', 'Сообщение не найдено');
      if (current.is_deleted) return tombstone(current, true);
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO message_history (message_id, action, old_text, old_metadata_json, actor_id, created_at)
      VALUES (?, 'delete', ?, ?, ?, ?)
    `).run(current.id, current.text, current.metadata_json, Number(actorId), now);

    withChangeSeq(db, (seq) => db.prepare("UPDATE messages SET is_deleted = 1, text = '', metadata_json = NULL, updated_at = ?, change_seq = ? WHERE id = ?")
      .run(now, seq, current.id));

    return tombstone({ ...current, updated_at: now }, false);
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
    return this.decorateRows(rows, directory, this.fileOriginalNames(rows));
  }

  // Запись сообщения для клиента: строка базы без служебных полей плюс
  // сведения об отправителе из directory (Map id → профиль).
  static decorateRows(rows, directory, originalNames) {
    return rows.map((fullRow) => {
      // Номер изменения — внутреннее дело сервера: курсор синхронизации
      // клиенту выдаёт /api/sync (next_cursor), а не отдельные записи.
      const { change_seq: _changeSeq, ...row } = fullRow;
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
        file_original_name: fileId != null ? (originalNames.get(fileId) ?? null) : null,
        // Размеры и цвет картинки-вложения (задача 20) — из таблицы files,
        // посчитанные сервером, а не присланные отправителем в metadata_json.
        file_width: fileId != null ? (originalNames.imageInfo?.get(fileId)?.width ?? null) : null,
        file_height: fileId != null ? (originalNames.imageInfo?.get(fileId)?.height ?? null) : null,
        file_dominant_color: fileId != null ? (originalNames.imageInfo?.get(fileId)?.dominant_color ?? null) : null
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
    const found = db.prepare(`SELECT id, original_name, width, height, dominant_color FROM files WHERE id IN (${placeholders})`).all(...ids);
    const names = new Map(found.map((f) => [Number(f.id), f.original_name]));
    // Размеры картинок — тем же запросом; Map имён остаётся прежней формы.
    names.imageInfo = new Map(found.map((f) => [Number(f.id), {
      width: f.width == null ? null : Number(f.width),
      height: f.height == null ? null : Number(f.height),
      dominant_color: f.dominant_color ?? null
    }]));
    return names;
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
    this.touchMessages(unread.map((m) => m.id));

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
        WHERE m.is_deleted = 0 AND m.text LIKE ? ESCAPE '\\' AND ${VISIBLE_TO_USER_SQL}
        ORDER BY m.id DESC LIMIT 30
      `)
      // % и _ в строке поиска — буквально, а не шаблон: «100%» ищет «100%», а
      // строка из сотни «%» не превращается в дорогой перебор (Р4-10).
      .all(`%${escapeLike(String(query))}%`, me, me, me);

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
    // Длина ограничена, % и _ экранированы (буквальный поиск, не шаблон) —
    // как в обычном поиске по переписке (проверка раунда 4, M1).
    const term = String(query || '').trim().slice(0, 200);

    let rows;
    if (!term) {
      rows = db.prepare('SELECT m.* FROM messages m ORDER BY m.id DESC LIMIT ?').all(capped);
    } else {
      const matchedUsers = await UserService.searchByName(term);
      const ids = matchedUsers.map((u) => Number(u.id));
      const idFilter = ids.length ? ` OR m.sender_id IN (${ids.map(() => '?').join(', ')})` : '';
      rows = db
        .prepare(`SELECT m.* FROM messages m WHERE m.text LIKE ? ESCAPE '\\'${idFilter} ORDER BY m.id DESC LIMIT ?`)
        .all(`%${escapeLike(term)}%`, ...ids, capped);
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
    this.touchMessages([messageId]);
    return now;
  }

  /**
   * S3: получатель появился на связи — его входящие личные сообщения, у
   * которых ещё нет ни «доставлено», ни «прочитано», отмечаются доставленными.
   * Прочитанные не трогаются (иначе «доставлено» с более поздним временем
   * перекрыло бы «прочитано»), удалённые — тоже. Просматриваются последние
   * PENDING_DELIVERY_SCAN входящих. Возвращает { timestamp, delivered:
   * [{ messageId, senderId }] } по возрастанию id.
   */
  static markPendingDelivered(recipientId) {
    const db = getDatabase();
    const me = Number(recipientId);
    const pending = db
      .prepare(`
        SELECT m.id, m.sender_id FROM (
          SELECT id, sender_id, is_deleted FROM messages
          WHERE conversation_type = 'direct' AND target_id = ?
          ORDER BY id DESC LIMIT ?
        ) m
        WHERE m.sender_id <> ? AND m.is_deleted = 0
          AND NOT EXISTS (
            SELECT 1 FROM message_statuses s
            WHERE s.message_id = m.id AND s.user_id = ? AND s.status IN ('delivered', 'read')
          )
        ORDER BY m.id ASC
      `)
      .all(me, PENDING_DELIVERY_SCAN, me, me);
    if (!pending.length) return { timestamp: null, delivered: [] };

    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO message_statuses (message_id, user_id, status, timestamp) VALUES (?, ?, 'delivered', ?)"
    );
    for (const row of pending) insert.run(row.id, me, now);
    this.touchMessages(pending.map((r) => r.id));
    return {
      timestamp: now,
      delivered: pending.map((r) => ({ messageId: Number(r.id), senderId: Number(r.sender_id) }))
    };
  }

  /**
   * Текущая «голова» последовательности изменений: последний выданный номер
   * (счётчик sync_state, не MAX по живым строкам).
   */
  static syncHead() {
    return getSyncState().lastSeq;
  }

  /** Курсор «изменений после этого нет» — начальная точка для клиента. */
  static syncHeadCursor() {
    const { lastSeq, epoch } = getSyncState();
    return formatSyncCursor(epoch, lastSeq);
  }

  /**
   * Номер изменения из курсора клиента. Курсор другой эпохи (база
   * восстановлена из копии, другой сервер), прежнего формата или с номером
   * впереди головы — SYNC_CURSOR_INVALID: клиент начинает заново.
   */
  static parseSyncCursor(cursor) {
    const match = SYNC_CURSOR_PARSE_RE.exec(String(cursor));
    if (!match) throw syncCursorError();
    const { lastSeq, epoch } = getSyncState();
    const seq = Number(match[2]);
    if (match[1] !== epoch || seq > lastSeq) throw syncCursorError();
    return seq;
  }

  /**
   * S2: всё, что изменилось в видимых пользователю переписках после курсора
   * since: созданные, отредактированные, удалённые (надгробие) сообщения и
   * личные сообщения со сменившимся статусом доставки/прочтения. Каждое —
   * один раз, в текущем состоянии, по возрастанию номера изменения.
   *
   * Курсор — номер изменения (change_seq), а не время: у многих изменений
   * одна и та же миллисекунда, а номер у каждого свой.
   */
  static async syncSince(userId, since, limit = SYNC_DEFAULT_LIMIT) {
    const db = getDatabase();
    const me = Number(userId);
    const capped = Math.min(Math.max(Number(limit) || SYNC_DEFAULT_LIMIT, 1), SYNC_MAX_LIMIT);

    // Всё синхронно до attachSenders: голова и выборка читаются без
    // промежуточных записей, поэтому next_cursor = голова ничего не пропустит.
    const from = this.parseSyncCursor(since);
    const { lastSeq: head, epoch } = getSyncState();

    const rows = db
      .prepare(`
        SELECT m.*,
               CASE WHEN m.conversation_type = 'direct' THEN
                 (SELECT status FROM message_statuses
                  WHERE message_id = m.id
                    AND user_id = CASE WHEN m.sender_id = ? THEN m.target_id ELSE ? END
                  ORDER BY timestamp DESC LIMIT 1)
               END AS delivery_status
        FROM messages m
        WHERE m.change_seq > ? AND ${VISIBLE_TO_USER_SQL}
        ORDER BY m.change_seq ASC
        LIMIT ?
      `)
      .all(me, me, from, me, me, me, capped + 1);

    const hasMore = rows.length > capped;
    const page = hasMore ? rows.slice(0, capped) : rows;
    const nextCursor = hasMore ? Number(page[page.length - 1].change_seq) : Math.max(from, head);

    return {
      messages: await this.attachSenders(page),
      next_cursor: formatSyncCursor(epoch, nextCursor),
      has_more: hasMore
    };
  }
}

module.exports = MessageService;
module.exports.DIALOG_LIST_LIMIT = DIALOG_LIST_LIMIT;
module.exports.MAX_TEXT_LENGTH = MAX_TEXT_LENGTH;
// Переиспользуются validateSettingsUpdate (server/src/api/index.js) — одна
// проверка формата на запись (settings PUT) и на чтение (isWithinWindow),
// а не две разные копии одной и той же регулярки.
module.exports.isValidMessageWindowValue = isValidWindowValue;
module.exports.MAX_MESSAGE_WINDOW_MINUTES = MAX_WINDOW_MINUTES;
module.exports.CLIENT_MSG_ID_RE = CLIENT_MSG_ID_RE;
module.exports.SYNC_DEFAULT_LIMIT = SYNC_DEFAULT_LIMIT;
module.exports.SYNC_MAX_LIMIT = SYNC_MAX_LIMIT;
module.exports.PENDING_DELIVERY_SCAN = PENDING_DELIVERY_SCAN;
module.exports.describeError = describeError;
