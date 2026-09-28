// Своя проверка подписи скачанного установщика обновления.
//
// electron-updater умеет проверять подпись сам, но его проверка сверяет лишь
// имя издателя, а без publisherName в app-update.yml и вовсе молча
// пропускается. Здесь — закреплённый отпечаток сертификата, Status=Valid и
// версия файла: ProductVersion должна совпасть с версией из latest.yml и быть
// новее текущей (иначе подписанную, но старую уязвимую сборку можно было бы
// подсунуть как «обновление»).
//
// Проверка отказывает при любой неясности: не запустился PowerShell, не
// ответил за 30 с, ответ не разобран — установщик не ставится.

const { execFile } = require('node:child_process');
const { compareVersions } = require('./update-policy');
const { trustedSystemRoot, DEFAULT_SYSTEM_ROOT } = require('./client-config');

// Меняется только вместе с сертификатом подписи: тот же отпечаток в
// desktop/scripts/signing-common.ps1, installer/установить-сертификат.ps1 и
// installer/разблокировать-запуск.ps1 (сверяется тестом).
const PINNED_THUMBPRINTS = Object.freeze(['0EB61614FC390FCD11BDF8DBFD40BE62EE10862A']);
const VERIFY_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// PowerShell — по абсолютному пути: поиск по PATH нашёл бы первым
// powershell.exe из любой папки, куда сотрудник (или программа от его имени)
// может писать. Корень системы — не из переменной SystemRoot: её сотрудник
// задаёт сам (HKCU\Environment), и поддельный powershell.exe напечатал бы
// «Valid» на что угодно. Его передаёт main.js из resolveSystemDirs (ядро,
// \SystemRoot); без него — то же ядро здесь, затем C:\Windows.
function powershellPath(systemRoot) {
  const root = typeof systemRoot === 'string' && /^[A-Za-z]:\\[^"*?<>|%\r\n]+$/.test(systemRoot) && !systemRoot.includes('..')
    ? systemRoot.replace(/\\+$/, '')
    : DEFAULT_SYSTEM_ROOT;
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

// Строка в одинарных кавычках PowerShell: кавычка внутри удваивается.
// PowerShell считает одинарными кавычками и типографские ‘ ’ ‚ ‛ — их тоже.
function psQuote(value) {
  return `'${String(value).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

function buildPsCommand(file) {
  const p = psQuote(file);
  return [
    "$ErrorActionPreference = 'Stop'",
    // Без этого первая загрузка модулей пишет в stderr прогресс в CLIXML.
    "$ProgressPreference = 'SilentlyContinue'",
    `$s = Get-AuthenticodeSignature -LiteralPath ${p}`,
    `$v = (Get-Item -LiteralPath ${p}).VersionInfo`,
    '$c = $null',
    'if ($s.SignerCertificate) { $c = @{ Thumbprint = [string]$s.SignerCertificate.Thumbprint } }',
    '@{ Status = [string]$s.Status; SignerCertificate = $c; VersionInfo = @{ ProductVersion = [string]$v.ProductVersion } } | ConvertTo-Json -Compress'
  ].join('\n');
}

// Команда передаётся в base64 (UTF-16LE): так путь с пробелами, кавычками и
// кириллицей (имя пользователя в пути к временной папке) доходит до
// PowerShell ровно таким, каким был, без правил разбора командной строки.
function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(String(script), 'utf16le').toString('base64')];
}

/**
 * Разбор ответа PowerShell. → null (подпись в порядке) или код отказа:
 * signature-untrusted — Status не Valid (NotSigned, HashMismatch, UnknownError…);
 * signature-foreign — подписано не закреплённым сертификатом;
 * version-mismatch — ProductVersion не равна версии из yml или не новее текущей;
 * signature-unreadable — ответ не разобран или в нём нет нужных полей.
 */
function evaluateSignature(json, { pinned = PINNED_THUMBPRINTS, expectedVersion, currentVersion } = {}) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json.replace(/^\uFEFF/, '').trim());
    } catch {
      return 'signature-unreadable';
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('Status' in data)) return 'signature-unreadable';
  if (data.Status !== 'Valid') return 'signature-untrusted';

  const cert = data.SignerCertificate;
  if (!cert || typeof cert !== 'object' || typeof cert.Thumbprint !== 'string') return 'signature-unreadable';
  const thumb = cert.Thumbprint.replace(/\s/g, '').toUpperCase();
  const allowed = new Set((pinned || []).map((t) => String(t).toUpperCase()));
  if (!thumb || !allowed.has(thumb)) return 'signature-foreign';

  const productVersion = typeof data.VersionInfo?.ProductVersion === 'string' ? data.VersionInfo.ProductVersion.trim() : '';
  if (!productVersion) return 'signature-unreadable';
  if (typeof expectedVersion !== 'string' || productVersion !== expectedVersion) return 'version-mismatch';
  if (compareVersions(productVersion, currentVersion) <= 0) return 'version-mismatch';
  return null;
}

function defaultRun(exe, args, { timeout }) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

/**
 * Проверяет скачанный установщик. → Promise<null | код отказа>; не бросает.
 * Сверх кодов evaluateSignature: signature-check-failed (PowerShell не
 * запустился или упал) и signature-check-timeout.
 */
async function verifyInstaller(file, { expectedVersion, currentVersion, run = defaultRun, systemRoot, timeoutMs = VERIFY_TIMEOUT_MS, pinned = PINNED_THUMBPRINTS } = {}) {
  if (typeof file !== 'string' || !file) return 'signature-check-failed';
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const running = Promise.resolve().then(() => run(powershellPath(systemRoot || trustedSystemRoot()), psArgs(buildPsCommand(file)), { timeout: timeoutMs }));
    const outcome = await Promise.race([running.then((r) => ({ r }), (error) => ({ error })), timeout]);
    if (outcome.timedOut) return 'signature-check-timeout';
    if (outcome.error) {
      const e = outcome.error;
      return e && (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') ? 'signature-check-timeout' : 'signature-check-failed';
    }
    const stdout = outcome.r && typeof outcome.r.stdout === 'string' ? outcome.r.stdout : '';
    return evaluateSignature(stdout, { pinned, expectedVersion, currentVersion });
  } catch {
    return 'signature-check-failed';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  PINNED_THUMBPRINTS,
  VERIFY_TIMEOUT_MS,
  powershellPath,
  buildPsCommand,
  psArgs,
  evaluateSignature,
  verifyInstaller
};
