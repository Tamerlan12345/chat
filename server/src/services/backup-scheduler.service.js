const config = require('../config');
const BackupService = require('./backup.service');

// Резервные копии по расписанию, с хранением последних N. Сбой копии — не
// строка в консоли, которую никто не читает, а критическое оповещение
// безопасности: без копий данные компании держатся на одном диске.
let intervalHandle = null;

async function runBackupCycle() {
  try {
    const result = await BackupService.createBackup();
    console.log(`[Backup] Резервная копия создана: ${result.files.map((f) => f.fileName).join(', ')}`);
    require('./audit.service').log({ action: 'db_backup_created', details: { files: result.files.map((f) => f.fileName), encrypted: result.encrypted, scheduled: true } });
  } catch (err) {
    console.error('[Backup] Плановая копия не создана:', err.message);
    require('./security-monitor.service').raise('backup_failed', 'critical', 'Резервная копия не создана', { error: err.message });
    return;
  }
  try {
    BackupService.enforceRetention();
  } catch (err) {
    console.error('[Backup] Очистка старых копий не удалась:', err.message);
  }
}

function start() {
  const intervalMs = config.BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => { runBackupCycle(); }, intervalMs);
  intervalHandle.unref(); // таймер не должен держать процесс
  console.log(`[Backup] Автоматические копии: каждые ${config.BACKUP_INTERVAL_HOURS} ч, хранить ${config.BACKUP_RETENTION_COUNT}`);
}

module.exports = { start, runBackupCycle };
