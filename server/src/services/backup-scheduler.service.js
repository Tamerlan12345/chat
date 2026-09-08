const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const DbStudioService = require('./db-studio.service');

// mychat.db is the single, only copy of the company's data (see
// docs/designs/auth-access-control-remediation.md and Architecture -
// Database.md). The admin console already has a manual "Backup now" button;
// this makes that happen unattended on a schedule, with retention so the
// backups/ folder doesn't grow forever.
let intervalHandle = null;

function runBackupCycle() {
  try {
    const result = DbStudioService.backupDatabase();
    console.log(`[Backup] Scheduled backup created: ${result.fileName} (${result.sizeFormatted})`);
  } catch (err) {
    console.error('[Backup] Scheduled backup failed:', err.message);
    return;
  }
  try {
    enforceRetention();
  } catch (err) {
    console.error('[Backup] Retention cleanup failed:', err.message);
  }
}

function enforceRetention() {
  if (!fs.existsSync(config.BACKUPS_DIR)) return;
  const keep = Math.max(1, config.BACKUP_RETENTION_COUNT);
  const files = fs.readdirSync(config.BACKUPS_DIR)
    .filter((f) => f.startsWith('mychat-backup-') && f.endsWith('.db'))
    .map((f) => {
      const full = path.join(config.BACKUPS_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of files.slice(keep)) {
    fs.unlinkSync(old.full);
    console.log(`[Backup] Removed old backup beyond retention (${keep}): ${path.basename(old.full)}`);
  }
}

function start() {
  const intervalMs = config.BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(runBackupCycle, intervalMs);
  intervalHandle.unref(); // don't keep the process alive just for this timer
  console.log(`[Backup] Automatic backups enabled: every ${config.BACKUP_INTERVAL_HOURS}h, keeping last ${config.BACKUP_RETENTION_COUNT}`);
}

module.exports = { start, runBackupCycle };
