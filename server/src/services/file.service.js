const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDatabase } = require('../db');
const config = require('../config');
const FilePolicyService = require('./file-policy.service');

// Хвост сигнатур в требованиях задачи — не длиннее 12 байт (RIFF....WEBP);
// с запасом читаем немного больше.
const HEAD_BYTES = 16;

async function readHeadBytes(filePath, length = HEAD_BYTES) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

class FileService {
  // Файл уже лежит во временной папке: хеш считается потоком, а сам файл
  // переносится на место без чтения в память и без блокировки сервера на
  // синхронной записи ста мегабайт.
  static async saveUploadedFile({ uploaderId, originalName, tempPath, size, mimeType }) {
    const db = getDatabase();

    // Фильтр типов файлов (находка аудита №6): имя, расширение и сигнатура
    // содержимого проверяются здесь — до переноса из временной папки. При
    // отказе временный файл удаляется, ничего не остаётся на диске под видом
    // сохранённого вложения.
    const headBytes = await readHeadBytes(tempPath);
    const problem = await FilePolicyService.check({ userId: uploaderId, originalName, headBytes });
    if (problem) {
      await fs.promises.rm(tempPath, { force: true });
      const err = new Error(problem.message);
      err.code = problem.code;
      err.statusCode = 415;
      throw err;
    }

    const sha256 = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(tempPath)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
    // Расширение — только безопасные символы: имя файла задаёт отправитель.
    const ext = path.extname(originalName).replace(/[^.A-Za-z0-9]/g, '').slice(0, 16);
    const storedFilename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    const filePath = path.join(config.UPLOADS_DIR, storedFilename);

    await fs.promises.rename(tempPath, filePath);

    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO files (uploader_id, original_name, stored_filename, file_size, mime_type, sha256, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uploaderId, originalName, storedFilename, Number(size), mimeType, sha256, filePath, now);

    return {
      id: result.lastInsertRowid,
      originalName,
      storedFilename,
      fileSize: Number(size),
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
