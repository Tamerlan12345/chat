const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { getDatabase, rotateSyncEpoch } = require('../db');
const { identity } = require('../db/identity');
const config = require('../config');

// Резервные копии: переписка и учётные записи, с проверкой целостности и,
// если задан BACKUP_ENCRYPTION_KEY, в зашифрованном виде.
//
// Раньше копировалась только база переписки и в открытом виде: скачанная
// копия читалась любым просмотрщиком SQLite, а учётные записи (роли, права,
// привязки устройств) не копировались вовсе.
//
// Формат зашифрованного файла (.enc):
//   OMCB1 (5 байт) | соль (16) | IV (12) | шифротекст AES-256-GCM | тег (16)
// Ключ — scrypt(BACKUP_ENCRYPTION_KEY, соль). Расшифровка —
// server/scripts/decrypt-backup.js.

const MAGIC = Buffer.from('OMCB1');
const BACKUP_PREFIXES = ['mychat-backup-', 'identity-backup-'];

// Таблицы учётных записей для выгрузки из PostgreSQL. Отозванные токены не
// нужны: после восстановления они всё равно истекут.
const IDENTITY_TABLES = [
  'roles', 'departments', 'users', 'pending_devices', 'device_pairings',
  'audit_logs', 'server_settings', 'security_alerts'
];

function encryptionKey() {
  const raw = String(process.env.BACKUP_ENCRYPTION_KEY || '');
  return Buffer.byteLength(raw, 'utf8') >= 32 ? raw : null;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function encryptFile(sourcePath, targetPath, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(targetPath, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(sourcePath), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
}

async function decryptFile(sourcePath, targetPath, secret) {
  const fd = await fs.promises.open(sourcePath, 'r');
  const tempPath = `${targetPath}.partial-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const { size } = await fd.stat();
    if (size < MAGIC.length + 28 + 16) throw new Error('Файл копии повреждён или обрезан');
    const header = Buffer.alloc(MAGIC.length + 28);
    await fd.read(header, 0, header.length, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Не зашифрованная копия CentyChat');
    const tag = Buffer.alloc(16);
    await fd.read(tag, 0, 16, size - 16);
    const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
    const iv = header.subarray(MAGIC.length + 16);
    const key = crypto.scryptSync(secret, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    await pipeline(
      fs.createReadStream(sourcePath, { start: header.length, end: size - 17 }),
      decipher,
      fs.createWriteStream(tempPath, { mode: 0o600 })
    );
    // Сюда доходим только если тег подлинности совпал.
    await fs.promises.rename(tempPath, targetPath);
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true });
    throw err;
  } finally {
    await fd.close();
  }
}

// Копия, которую не открыть, хуже отсутствия копии: о ней думают, что она есть.
function checkSqliteIntegrity(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const value = row ? Object.values(row)[0] : null;
    if (value !== 'ok') throw new Error(`проверка целостности копии: ${value}`);
  } finally {
    db.close();
  }
}

async function exportIdentity(targetPath) {
  if (config.IDENTITY_DRIVER !== 'postgres') {
    // SQLite: та же оперативная копия, что и у переписки.
    const db = new DatabaseSync(config.IDENTITY_DB_PATH);
    try {
      db.prepare('VACUUM INTO ?').run(targetPath);
    } finally {
      db.close();
    }
    checkSqliteIntegrity(targetPath);
    return;
  }
  const dump = { format: 'openmychat-identity-v1', createdAt: new Date().toISOString(), tables: {} };
  for (const table of IDENTITY_TABLES) {
    dump.tables[table] = await identity().all(`SELECT * FROM ${table}`);
  }
  await fs.promises.writeFile(targetPath, JSON.stringify(dump), { mode: 0o600 });
}

async function finalize(plainPath) {
  const secret = encryptionKey();
  if (!secret) return plainPath;
  const encPath = `${plainPath}.enc`;
  try {
    await encryptFile(plainPath, encPath, secret);
  } finally {
    await fs.promises.rm(plainPath, { force: true });
  }
  return encPath;
}

class BackupService {
  static async createBackup() {
    fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });
    const stamp = timestamp();
    const files = [];

    const chatPath = path.join(config.BACKUPS_DIR, `mychat-backup-${stamp}.db`);
    try {
      getDatabase().prepare('VACUUM INTO ?').run(chatPath);
      // Своя эпоха синхронизации у копии: курсоры, выданные рабочей базой,
      // к восстановленной из копии не подойдут (см. db/index.js rotateSyncEpoch).
      rotateSyncEpoch(chatPath);
      await fs.promises.chmod(chatPath, 0o600).catch(() => {});
      checkSqliteIntegrity(chatPath);
      files.push(await finalize(chatPath));
    } catch (err) {
      // Незашифрованная копия, оставшаяся после сбоя, — ровно то, от чего
      // защищает шифрование.
      await fs.promises.rm(chatPath, { force: true });
      throw err;
    }

    // Учётные записи (хеши паролей, секреты устройств, журнал) копируются
    // только в зашифрованном виде: открытая копия позволила бы подбирать
    // пароли коллег офлайн.
    if (encryptionKey()) {
      const identityPath = path.join(
        config.BACKUPS_DIR,
        `identity-backup-${stamp}.${config.IDENTITY_DRIVER === 'postgres' ? 'json' : 'db'}`
      );
      try {
        await exportIdentity(identityPath);
        await fs.promises.chmod(identityPath, 0o600).catch(() => {});
        files.push(await finalize(identityPath));
      } catch (err) {
        await fs.promises.rm(identityPath, { force: true });
        throw err;
      }
    } else {
      console.warn('[Backup] Копия учётных записей пропущена: не задан BACKUP_ENCRYPTION_KEY');
    }

    const described = files.map((full) => {
      const size = fs.statSync(full).size;
      return {
        fileName: path.basename(full),
        sizeBytes: size,
        sizeFormatted: (size / (1024 * 1024)).toFixed(2) + ' MB'
      };
    });
    return {
      success: true,
      encrypted: Boolean(encryptionKey()),
      files: described,
      fileName: described[0].fileName,
      sizeBytes: described[0].sizeBytes,
      sizeFormatted: described[0].sizeFormatted,
      createdAt: new Date().toISOString()
    };
  }

  static listBackups() {
    if (!fs.existsSync(config.BACKUPS_DIR)) return [];
    return fs
      .readdirSync(config.BACKUPS_DIR)
      .filter((f) => BACKUP_PREFIXES.some((p) => f.startsWith(p)) || f.endsWith('.db') || f.endsWith('.sqlite'))
      .map((f) => {
        const stat = fs.statSync(path.join(config.BACKUPS_DIR, f));
        return {
          fileName: f,
          encrypted: f.endsWith('.enc'),
          sizeBytes: stat.size,
          sizeFormatted: (stat.size / (1024 * 1024)).toFixed(2) + ' MB',
          createdAt: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // Сколько копий хранить — отдельно для переписки и для учётных записей.
  static enforceRetention() {
    if (!fs.existsSync(config.BACKUPS_DIR)) return;
    const keep = Math.max(1, config.BACKUP_RETENTION_COUNT);
    for (const prefix of BACKUP_PREFIXES) {
      const files = fs
        .readdirSync(config.BACKUPS_DIR)
        .filter((f) => f.startsWith(prefix))
        .map((f) => {
          const full = path.join(config.BACKUPS_DIR, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(keep)) fs.unlinkSync(old.full);
    }
  }
}

module.exports = BackupService;
module.exports.decryptFile = decryptFile;
module.exports.encryptFile = encryptFile;
