// Хук подписи для electron-builder (win.signtoolOptions.sign).
//
// Раньше подписывались только готовые Setup.exe и Portable.exe — уже после
// сборки. Внутренний «OpenMyChat Enterprise.exe», который и запускается у
// сотрудника, и dll рядом с ним оставались без подписи: подменить их в папке
// установки было нечем обнаружить. electron-builder вызывает этот хук для
// каждого exe и dll ДО упаковки, а также для самих установщиков.
//
// Подписывает тот же PowerShell Set-AuthenticodeSignature, что и
// sign-and-publish.ps1 (signtool из Windows SDK молча не подписывал, см. там).
//
// MYCHAT_SKIP_SIGN=1 — собрать без подписи (проверочная сборка).
// MYCHAT_REQUIRE_SIGN=1 — без сертификата сборка падает, а не идёт дальше.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'sign-file.ps1');

function flag(name) {
  return ['1', 'true', 'yes'].includes(String(process.env[name] || '').toLowerCase());
}

module.exports = async function sign(configuration) {
  const file = configuration?.path;
  if (!file) return;
  const name = path.basename(file);

  if (flag('MYCHAT_SKIP_SIGN')) {
    console.log(`  • подпись пропущена (MYCHAT_SKIP_SIGN): ${name}`);
    return;
  }
  if (process.platform !== 'win32') {
    throw new Error('Подпись дистрибутива возможна только на Windows');
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Path', file],
    { encoding: 'utf8', windowsHide: true }
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (output) console.log(`  • ${output}`);

  if (result.status === 0) return;
  if (result.status === 2 && !flag('MYCHAT_REQUIRE_SIGN')) {
    // Разработчик без сертификата собирает для себя. Выпуск такой сборки
    // остановит sign-and-publish.ps1: он проверяет подпись в win-unpacked.
    console.warn(`  • ВНИМАНИЕ: ${name} остался без подписи`);
    return;
  }
  throw new Error(`Не удалось подписать ${name} (код ${result.status ?? result.error?.message})`);
};
