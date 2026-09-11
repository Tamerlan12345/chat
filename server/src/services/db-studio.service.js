const fs = require('node:fs');
const path = require('node:path');
const { getDatabase } = require('../db');
const { identity } = require('../db/identity');
const config = require('../config');

// Студия базы данных работает ТОЛЬКО с базой переписки. Учётные записи
// вынесены в отдельное хранилище и сюда не попадают намеренно: возможность
// выполнить произвольный SQL — самое сильное право в админ-панели, и хэши
// паролей не должны находиться в его досягаемости. По учётным записям здесь
// доступны только счётчики строк (getIdentityStats).

// ATTACH подключил бы к сессии посторонний файл базы — в том числе
// identity.db, когда PostgreSQL не настроен. Это ровно тот обход, ради
// закрытия которого учётные записи и разъезжались по разным базам.
const FORBIDDEN_STATEMENTS = /^\s*(ATTACH|DETACH)\b/i;

class DbStudioService {
  static getDatabaseStats() {
    const db = getDatabase();
    
    // File size
    let dbSize = 0;
    let walSize = 0;
    if (fs.existsSync(config.DB_PATH)) {
      dbSize = fs.statSync(config.DB_PATH).size;
    }
    const walPath = `${config.DB_PATH}-wal`;
    if (fs.existsSync(walPath)) {
      walSize = fs.statSync(walPath).size;
    }

    const journalMode = db.prepare('PRAGMA journal_mode').get();
    const integrity = db.prepare('PRAGMA integrity_check').get();

    const tables = this.getTables();
    let totalRows = 0;
    for (const t of tables) {
      totalRows += t.rowCount;
    }

    return {
      scope: 'Переписка (SQLite). Учётные записи — в отдельном хранилище.',
      dbPath: config.DB_PATH,
      dbSizeBytes: dbSize,
      dbSizeFormatted: (dbSize / (1024 * 1024)).toFixed(2) + ' MB',
      walSizeBytes: walSize,
      walSizeFormatted: (walSize / (1024 * 1024)).toFixed(2) + ' MB',
      journalMode: journalMode ? Object.values(journalMode)[0] : 'wal',
      integrity: integrity ? Object.values(integrity)[0] : 'ok',
      tablesCount: tables.length,
      totalRows
    };
  }

  static getTables() {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all();

    const tables = [];
    for (const r of rows) {
      let count = 0;
      try {
        const countRow = db.prepare(`SELECT COUNT(*) as c FROM "${r.name}"`).get();
        count = countRow ? countRow.c : 0;
      } catch {
        count = 0;
      }
      tables.push({
        name: r.name,
        rowCount: count
      });
    }
    return tables;
  }

  static getTableSchema(tableName) {
    const db = getDatabase();
    // Validate table name against sqlite_master
    const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
    if (!check) throw new Error(`Таблица '${tableName}' не существует`);

    const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all();
    const indexes = db.prepare(`PRAGMA index_list("${tableName}")`).all();

    return {
      tableName,
      columns: columns.map(c => ({
        cid: c.cid,
        name: c.name,
        type: c.type,
        notnull: c.notnull === 1,
        defaultValue: c.dflt_value,
        pk: c.pk === 1
      })),
      indexes: indexes.map(idx => ({
        name: idx.name,
        unique: idx.unique === 1
      }))
    };
  }

  static getTableData(tableName, limit = 50, offset = 0) {
    const db = getDatabase();
    const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
    if (!check) throw new Error(`Таблица '${tableName}' не существует`);

    const countRow = db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get();
    const total = countRow ? countRow.c : 0;

    const rows = db.prepare(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`).all(limit, offset);

    return {
      tableName,
      total,
      limit,
      offset,
      rows
    };
  }

  static executeCustomSql(sql) {
    const db = getDatabase();
    const trimmed = String(sql || '').trim();
    if (!trimmed) throw new Error('Запрос пуст');
    if (FORBIDDEN_STATEMENTS.test(trimmed)) {
      throw new Error('ATTACH и DETACH запрещены: студия работает только с базой переписки');
    }

    const start = process.hrtime.bigint();

    // Distinguish SELECT queries vs mutating queries
    const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(trimmed);

    if (isSelect) {
      const stmt = db.prepare(trimmed);
      const rows = stmt.all();
      const end = process.hrtime.bigint();
      const elapsedMs = Number(end - start) / 1000000;

      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return {
        type: 'select',
        executionTimeMs: elapsedMs.toFixed(2),
        columns,
        rowCount: rows.length,
        rows
      };
    } else {
      const stmt = db.prepare(trimmed);
      const result = stmt.run();
      const end = process.hrtime.bigint();
      const elapsedMs = Number(end - start) / 1000000;

      return {
        type: 'mutation',
        executionTimeMs: elapsedMs.toFixed(2),
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid
      };
    }
  }

  static backupDatabase() {
    const db = getDatabase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `mychat-backup-${timestamp}.db`;
    const backupFilePath = path.join(config.BACKUPS_DIR, backupFileName);

    // SQLite online backup via VACUUM INTO
    db.prepare(`VACUUM INTO ?`).run(backupFilePath);

    const size = fs.statSync(backupFilePath).size;

    return {
      success: true,
      fileName: backupFileName,
      filePath: backupFilePath,
      sizeBytes: size,
      sizeFormatted: (size / (1024 * 1024)).toFixed(2) + ' MB',
      createdAt: new Date().toISOString()
    };
  }

  static listBackups() {
    if (!fs.existsSync(config.BACKUPS_DIR)) return [];
    const files = fs.readdirSync(config.BACKUPS_DIR);
    return files
      .filter(f => f.endsWith('.db') || f.endsWith('.sqlite'))
      .map(f => {
        const full = path.join(config.BACKUPS_DIR, f);
        const stat = fs.statSync(full);
        return {
          fileName: f,
          sizeBytes: stat.size,
          sizeFormatted: (stat.size / (1024 * 1024)).toFixed(2) + ' MB',
          createdAt: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Сводка по хранилищу учётных записей: только счётчики. Ни одной колонки с
   * паролями здесь нет и быть не должно — это витрина состояния, а не доступ
   * к данным.
   */
  static async getIdentityStats() {
    const db = identity();
    const counts = {};
    for (const table of ['users', 'roles', 'departments', 'device_pairings', 'pending_devices', 'audit_logs']) {
      const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
      counts[table] = Number(row?.n || 0);
    }

    const active = await db.get('SELECT COUNT(*) AS n FROM users WHERE is_active = 1');
    const pending = await db.get(`SELECT COUNT(*) AS n FROM users WHERE approval_status = 'pending'`);
    const locked = await db.get('SELECT COUNT(*) AS n FROM users WHERE locked_until IS NOT NULL AND locked_until > $1', [
      new Date().toISOString()
    ]);

    return {
      engine: config.IDENTITY_DRIVER === 'postgres' ? 'PostgreSQL' : 'SQLite (PostgreSQL не настроен)',
      managed: config.IDENTITY_DRIVER === 'postgres',
      counts,
      activeUsers: Number(active?.n || 0),
      pendingRegistrations: Number(pending?.n || 0),
      lockedAccounts: Number(locked?.n || 0)
    };
  }

  static optimizeDatabase() {
    const db = getDatabase();
    try {
      db.exec('PRAGMA optimize;');
      db.exec('VACUUM;');
      db.exec('ANALYZE;');
    } catch (e) {
      console.warn('Optimize warning:', e.message);
    }
    return this.getDatabaseStats();
  }
}

module.exports = DbStudioService;
