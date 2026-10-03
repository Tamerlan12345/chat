// Проверяет scripts/signing-common.ps1: Get-MyChatSha512Base64 — тот самый
// расчёт sha512, который publish-update.ps1 сверяет со значением в
// latest.yml перед выпуском обновления.
//
// Почему тест реально запускает PowerShell, а не читает файл текстом
// --------------------------------------------------------------------
// Раньше эта сверка считалась строкой `[byte[]] -split (...) | ForEach-Object
// { [Convert]::ToByte($_, 16) }` — в Windows PowerShell 5.1 `[byte[]]` слева
// от `-split` разбирается как часть самого оператора, а не как приведение
// результата, и шестнадцатеричная пара вида "A1" затем приводится к byte по
// основанию 10, а не 16 — падает на первой же паре с буквой. Проверка текстом
// файла такую ошибку в РЕАЛЬНОМ PowerShell не находит: код синтаксически
// валиден, падает только во время исполнения. Единственный надёжный способ —
// действительно вызвать PowerShell и сравнить результат с Node.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SIGNING_COMMON = path.join(__dirname, '..', 'scripts', 'signing-common.ps1');

test('Get-MyChatSha512Base64 (signing-common.ps1) совпадает с Node crypto', { skip: process.platform !== 'win32' && 'только Windows (PowerShell 5.1/7)' }, () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mychat-sha512-')), 'fake-setup.exe');
  // Содержимое не важно для проверки самой формулы хеша — важно, что оно не
  // тривиально короткое и не состоит только из цифр (чтобы точно упасть на
  // старом коде при наличии букв в hex-представлении).
  fs.writeFileSync(tmpFile, Buffer.from('MZ-fake-installer-bytes-for-hash-test-1234567890', 'utf8'));

  const expected = crypto.createHash('sha512').update(fs.readFileSync(tmpFile)).digest('base64');

  const psCommand = [
    `. '${SIGNING_COMMON.replace(/'/g, "''")}'`,
    `Get-MyChatSha512Base64 -Path '${tmpFile.replace(/'/g, "''")}'`
  ].join('; ');

  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
    encoding: 'utf8'
  });

  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });

  assert.strictEqual(result.status, 0, `powershell завершился с кодом ${result.status}: ${result.stderr}`);
  assert.strictEqual(result.stdout.trim(), expected);
});

test('старая формула через [byte[]] -split действительно падает в PowerShell 5.1 (регресс-проверка)', { skip: process.platform !== 'win32' && 'только Windows' }, () => {
  // Хеш подставляется готовым (из Node), а не считается Get-FileHash в самом
  // PowerShell: на раннере CI Windows PowerShell запускается из pwsh 7 с чужим
  // PSModulePath и не находит Get-FileHash вовсе — команда падала бы по этой
  // причине (или, наоборот, «успешно» ничего не делала), а не из-за формулы,
  // которую здесь проверяют.
  const hash = crypto.createHash('sha512').update(Buffer.from('MZ-fake-installer-bytes-for-hash-test-1234567890', 'utf8')).digest('hex').toUpperCase();

  const psCommand = [
    `$h = '${hash}'`,
    `[byte[]] -split ($h -replace '..', '$0 ') | ForEach-Object { [Convert]::ToByte($_, 16) }`
  ].join('; ');

  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
    encoding: 'utf8'
  });

  // Не 0 — подтверждает, что старый способ действительно нерабочий (а не
  // просто «выглядит подозрительно»), и что замена на Get-MyChatSha512Base64
  // была не косметической.
  assert.notStrictEqual(result.status, 0, 'ожидалась ошибка выполнения у старой формулы приведения hex→byte[]');
});
