// Проверяет installer/acl-guard.ps1 (Get-MyChatDangerousAcl) на настоящем
// NTFS ACL, а не текстом — это то, что закрывает Критическую находку
// ревью: первая версия функции строила маску «опасных» прав из составных
// флагов Modify/FullControl, которые включают биты чтения, и из-за этого
// считала опасным ЛЮБОЙ, в том числе полностью правильный, результат
// собственной настройки ACL (Admins:F, SYSTEM:F, Users:RX) — скрипт
// печатал ОТКАЗ и завершался с ошибкой на каждом корректном запуске.
// Текстовая проверка (installer-scripts.test.js) такую ошибку не ловит:
// код синтаксически верный и выглядит правильно, ломается только при
// реальном исполнении на реальном ACL. См. так же
// sha512-powershell.test.js — тот же принцип, для другой функции.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ACL_GUARD = path.join(__dirname, '..', '..', 'installer', 'acl-guard.ps1');
const SKIP = process.platform !== 'win32' && 'только Windows (ACL/icacls)';

function runIcacls(args) {
  const result = spawnSync('icacls', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`icacls ${args.join(' ')} завершился с кодом ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

// Возвращает число записей, которые Get-MyChatDangerousAcl считает
// опасными для указанного файла — реальный вызов powershell.exe, не мок.
function countDangerous(filePath) {
  const psCommand = [
    `. '${ACL_GUARD.replace(/'/g, "''")}'`,
    `(Get-MyChatDangerousAcl -Path '${filePath.replace(/'/g, "''")}').Count`
  ].join('; ');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
    { encoding: 'utf8' }
  );

  assert.strictEqual(result.status, 0, `powershell завершился с кодом ${result.status}: ${result.stderr}`);
  return Number(result.stdout.trim());
}

test('Get-MyChatDangerousAcl — Admins:F/SYSTEM:F/Users:RX (ровно то, что ставит сам configure-client.ps1) не считается опасным', { skip: SKIP }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mychat-acl-'));
  const filePath = path.join(dir, `client-${crypto.randomUUID()}.json`);
  fs.writeFileSync(filePath, '{}');
  try {
    // Тот же самый ACL, что configure-client.ps1 ставит на client.json.
    runIcacls([filePath, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F', '*S-1-5-32-545:RX']);
    const count = countDangerous(filePath);
    assert.strictEqual(count, 0, 'корректный ACL (Admins:F, SYSTEM:F, Users:RX) не должен считаться опасным');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Get-MyChatDangerousAcl — реальную дыру (Users:Modify) находит', { skip: SKIP }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mychat-acl-'));
  const filePath = path.join(dir, `client-${crypto.randomUUID()}.json`);
  fs.writeFileSync(filePath, '{}');
  try {
    runIcacls([filePath, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F', '*S-1-5-32-545:RX']);
    // Добавляем то, чего быть не должно: обычным пользователям — право
    // менять файл. Именно это должно быть поймано как отказ.
    runIcacls([filePath, '/grant', '*S-1-5-32-545:M']);
    const count = countDangerous(filePath);
    assert.ok(count >= 1, 'ACL с Users:Modify должен считаться опасным (найдена ≥1 запись)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
