const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDatabase } = require('../db');
const config = require('../config');

class FileService {
  static saveUploadedFile({ uploaderId, originalName, buffer, mimeType }) {
    const db = getDatabase();
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const ext = path.extname(originalName);
    const storedFilename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    const filePath = path.join(config.UPLOADS_DIR, storedFilename);

    fs.writeFileSync(filePath, buffer);

    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO files (uploader_id, original_name, stored_filename, file_size, mime_type, sha256, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uploaderId, originalName, storedFilename, buffer.length, mimeType, sha256, filePath, now);

    return {
      id: result.lastInsertRowid,
      originalName,
      storedFilename,
      fileSize: buffer.length,
      mimeType,
      url: `/api/files/download/${result.lastInsertRowid}`
    };
  }

  static getFileById(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  }

  // Files have no FK to the conversation they were shared in — only a free-form
  // metadata_json blob on the message that references file_id. Resolve access
  // by finding that reference and checking the caller is part of that
  // conversation. See docs/designs/auth-access-control-remediation.md item 8.
  //
  // Сравнивается само значение file_id, а не подстрока: шаблон
  // LIKE '%"file_id":1%' находил и сообщения с файлом №12, №105 — и открывал
  // по ним доступ к файлу №1. Ссылку на файл в сообщение может поставить
  // только тот, кому файл уже доступен, — см. MessageService.sendMessage.
  static canUserAccessFile(userId, fileId) {
    const db = getDatabase();
    const file = db.prepare('SELECT uploader_id FROM files WHERE id = ?').get(Number(fileId));
    if (!file) return false;
    if (Number(file.uploader_id) === Number(userId)) return true;

    const refs = db.prepare(`
      SELECT conversation_type, target_id, sender_id
      FROM messages
      WHERE json_valid(metadata_json)
        AND CAST(json_extract(metadata_json, '$.file_id') AS INTEGER) = ?
    `).all(Number(fileId));

    for (const ref of refs) {
      if (ref.conversation_type === 'direct') {
        if (Number(ref.sender_id) === Number(userId) || Number(ref.target_id) === Number(userId)) return true;
      } else if (ref.conversation_type === 'channel') {
        const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(ref.target_id, userId);
        if (member) return true;
      }
    }
    return false;
  }

  // Имя загрузившего лежит в другой базе — подставляется отдельным запросом,
  // одним на всю выдачу.
  static async getRecentFiles(userId, limit = 50) {
    const db = getDatabase();
    const memberChannels = db
      .prepare('SELECT channel_id FROM channel_members WHERE user_id = ?')
      .all(Number(userId))
      .map((r) => r.channel_id);
    const channelPlaceholders = memberChannels.length ? memberChannels.map(() => '?').join(',') : 'NULL';

    const rows = db.prepare(`
      SELECT f.*
      FROM files f
      WHERE f.uploader_id = ?
        OR EXISTS (
          SELECT 1 FROM messages m
          WHERE json_valid(m.metadata_json)
            AND CAST(json_extract(m.metadata_json, '$.file_id') AS INTEGER) = f.id
            AND (
              (m.conversation_type = 'direct' AND (m.sender_id = ? OR m.target_id = ?))
              OR (m.conversation_type = 'channel' AND m.target_id IN (${channelPlaceholders}))
            )
        )
      ORDER BY f.id DESC LIMIT ?
    `).all(Number(userId), Number(userId), Number(userId), ...memberChannels, Number(limit) || 50);

    const UserService = require('./user.service');
    const directory = await UserService.getDirectory(rows.map((r) => r.uploader_id));
    return rows.map((row) => ({
      ...row,
      uploader_name: directory.get(Number(row.uploader_id))?.full_name || 'Удалённый сотрудник'
    }));
  }
}

module.exports = FileService;
