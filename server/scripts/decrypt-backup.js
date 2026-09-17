#!/usr/bin/env node
// Расшифровка резервной копии для восстановления.
//
//   BACKUP_ENCRYPTION_KEY=... node scripts/decrypt-backup.js <копия.enc> <куда.db|json>
//
// Ключ передаётся только переменной окружения — не аргументом, чтобы он не
// остался в истории команд и в списке процессов.

const path = require('node:path');
const { decryptFile } = require('../src/services/backup.service');

async function main() {
  const [source, target] = process.argv.slice(2);
  const secret = process.env.BACKUP_ENCRYPTION_KEY;
  if (!source || !target) {
    console.error('Использование: BACKUP_ENCRYPTION_KEY=... node scripts/decrypt-backup.js <копия.enc> <результат>');
    process.exit(2);
  }
  if (!secret) {
    console.error('Не задан BACKUP_ENCRYPTION_KEY');
    process.exit(2);
  }
  await decryptFile(path.resolve(source), path.resolve(target), secret);
  console.log(`Готово: ${path.resolve(target)}`);
}

main().catch((err) => {
  console.error('Расшифровать не удалось:', err.message);
  process.exit(1);
});
