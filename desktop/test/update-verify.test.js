const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  PINNED_THUMBPRINTS,
  VERIFY_TIMEOUT_MS,
  powershellPath,
  psEnv,
  buildPsCommand,
  psArgs,
  evaluateSignature,
  verifyInstaller
} = require('../src/main/update-verify');

const PINNED = '0EB61614FC390FCD11BDF8DBFD40BE62EE10862A';
const REPO = path.join(__dirname, '..', '..');

function report({ status = 'Valid', thumbprint = PINNED, productVersion = '1.2.0', cert = true } = {}) {
  return JSON.stringify({
    Status: status,
    SignerCertificate: cert ? { Thumbprint: thumbprint } : null,
    VersionInfo: { ProductVersion: productVersion }
  });
}

const opts = { pinned: PINNED_THUMBPRINTS, expectedVersion: '1.2.0', currentVersion: '1.1.0' };

// ── Разбор ответа PowerShell ───────────────────────────────────────────────

test('Valid + закреплённый отпечаток + совпадающая версия → null', () => {
  assert.strictEqual(evaluateSignature(report(), opts), null);
  assert.strictEqual(evaluateSignature(JSON.parse(report()), opts), null, 'объект тоже принимается');
  assert.strictEqual(evaluateSignature(report({ thumbprint: PINNED.toLowerCase() }), opts), null, 'регистр отпечатка не важен');
  assert.strictEqual(evaluateSignature(report({ productVersion: ' 1.2.0 ' }), opts), null, 'пробелы по краям версии');
});

test('подпись не Valid → signature-untrusted', () => {
  for (const status of ['UnknownError', 'HashMismatch', 'NotSigned', 'NotTrusted', 'Incompatible', '', 0]) {
    assert.strictEqual(
      evaluateSignature(report({ status, cert: status !== 'NotSigned' }), opts),
      'signature-untrusted',
      String(status)
    );
  }
});

test('чужой отпечаток → signature-foreign', () => {
  assert.strictEqual(evaluateSignature(report({ thumbprint: 'A'.repeat(40) }), opts), 'signature-foreign');
  assert.strictEqual(evaluateSignature(report({ thumbprint: '' }), opts), 'signature-foreign');
});

test('нет SignerCertificate → signature-unreadable', () => {
  assert.strictEqual(evaluateSignature(report({ cert: false }), opts), 'signature-unreadable');
  assert.strictEqual(
    evaluateSignature(JSON.stringify({ Status: 'Valid', SignerCertificate: {}, VersionInfo: { ProductVersion: '1.2.0' } }), opts),
    'signature-unreadable'
  );
});

test('версия файла не та → version-mismatch', () => {
  assert.strictEqual(evaluateSignature(report({ productVersion: '1.3.0' }), opts), 'version-mismatch', 'не совпадает с yml');
  assert.strictEqual(
    evaluateSignature(report({ productVersion: '1.0.0' }), { ...opts, expectedVersion: '1.0.0' }),
    'version-mismatch',
    'откат на старую подписанную сборку'
  );
  assert.strictEqual(
    evaluateSignature(report({ productVersion: '1.1.0' }), { ...opts, expectedVersion: '1.1.0' }),
    'version-mismatch',
    'та же версия'
  );
  assert.strictEqual(evaluateSignature(report(), { ...opts, expectedVersion: null }), 'version-mismatch', 'без ожидаемой версии — отказ');
  assert.strictEqual(evaluateSignature(report({ productVersion: '' }), opts), 'signature-unreadable');
});

test('битый JSON и чужая форма → signature-unreadable', () => {
  for (const out of ['', '{oops', 'null', '[]', '"Valid"', '{}', JSON.stringify({ Status: 'Valid' })]) {
    assert.strictEqual(evaluateSignature(out, opts), 'signature-unreadable', out);
  }
  assert.strictEqual(evaluateSignature(undefined, opts), 'signature-unreadable');
});

test('без закреплённых отпечатков не проходит ничего', () => {
  assert.strictEqual(evaluateSignature(report(), { ...opts, pinned: [] }), 'signature-foreign');
});

// ── Команда PowerShell ─────────────────────────────────────────────────────

test('путь экранируется: одинарная кавычка удваивается, пробелы остаются', () => {
  const file = "C:\\Users\\O'Brien Ivanov\\AppData\\Local\\mychat-desktop-updater\\pending\\temp-OpenMyChat Setup.exe";
  const script = buildPsCommand(file);
  assert.ok(script.includes("-LiteralPath 'C:\\Users\\O''Brien Ivanov\\AppData\\Local\\mychat-desktop-updater\\pending\\temp-OpenMyChat Setup.exe'"), script);
  assert.ok(!script.includes("O'Brien"), 'неудвоенной кавычки нет');
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /ConvertTo-Json/);
  assert.match(script, /ProductVersion/);
  assert.match(script, /Thumbprint/);
});

test('команды — с именем модуля, модули — из $PSHOME, версия — из .NET', () => {
  const script = buildPsCommand('C:\\t\\setup.exe');
  assert.match(script, /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature -LiteralPath/);
  assert.match(script, /\| Microsoft\.PowerShell\.Utility\\ConvertTo-Json -Compress/);
  assert.match(script, /Microsoft\.PowerShell\.Core\\Import-Module -Name \(\$PSHOME \+ '\\Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1'\)/);
  assert.match(script, /Microsoft\.PowerShell\.Core\\Import-Module -Name \(\$PSHOME \+ '\\Modules\\Microsoft\.PowerShell\.Utility\\Microsoft\.PowerShell\.Utility\.psd1'\)/);
  assert.match(script, /\[System\.Diagnostics\.FileVersionInfo\]::GetVersionInfo\('C:\\t\\setup\.exe'\)/);
  // Ни одной команды без имени модуля: её мог бы подменить модуль-двойник.
  const bare = script.split('\n').filter((line) => /(^|[\s(|=])(Get-AuthenticodeSignature|ConvertTo-Json|Get-Item|Import-Module|Join-Path)\b/.test(line.replace(/Microsoft\.PowerShell\.\w+\\/g, 'Q\\')));
  assert.deepStrictEqual(bare, []);
});

test('окружение PowerShell — только корень системы и системный PSModulePath', () => {
  assert.deepStrictEqual(psEnv('D:\\Windows'), {
    SystemRoot: 'D:\\Windows',
    windir: 'D:\\Windows',
    PSModulePath: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
  });
  assert.strictEqual(psEnv('%TEMP%').PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
});

test('кавычки-«ёлочки» Юникода тоже экранируются', () => {
  // PowerShell считает ’ ‘ ‚ ‛ одинарными кавычками наравне с '.
  const script = buildPsCommand('C:\\a\u2019b.exe');
  assert.ok(script.includes("'C:\\a\u2019\u2019b.exe'"), script);
});

test('PowerShell запускается по абсолютному пути, без профиля, команда в base64', () => {
  assert.strictEqual(powershellPath('D:\\Windows'), 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.strictEqual(powershellPath(undefined), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  for (const junk of ['\\\\evil\\share', 'C:\\x\\..\\Users\\u', '%TEMP%', 'relative\\Windows']) {
    assert.strictEqual(powershellPath(junk), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', junk);
  }
  const args = psArgs('Write-Output 1');
  assert.deepStrictEqual(args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive']);
  const encoded = args[args.indexOf('-EncodedCommand') + 1];
  assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), 'Write-Output 1');
  assert.strictEqual(VERIFY_TIMEOUT_MS, 30_000);
});

// ── Запуск проверки ────────────────────────────────────────────────────────

test('verifyInstaller: успешная проверка → null, команда запущена один раз', async () => {
  const calls = [];
  const run = async (exe, args, options) => {
    calls.push({ exe, args, options });
    return { stdout: report() + '\r\n' };
  };
  const result = await verifyInstaller('C:\\t\\setup.exe', { expectedVersion: '1.2.0', currentVersion: '1.1.0', run, systemRoot: 'D:\\Win' });
  assert.strictEqual(result, null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].exe, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(calls[0].options.timeout <= 30_000);
});

test('verifyInstaller: окружение приложения PowerShell не наследует', async () => {
  const saved = { PSModulePath: process.env.PSModulePath, USERPROFILE: process.env.USERPROFILE };
  process.env.PSModulePath = 'C:\\Users\\u\\Documents\\WindowsPowerShell\\Modules';
  process.env.USERPROFILE = process.env.USERPROFILE || 'C:\\Users\\u';
  try {
    let options = null;
    await verifyInstaller('C:\\t\\setup.exe', {
      expectedVersion: '1.2.0',
      currentVersion: '1.1.0',
      systemRoot: 'D:\\Win',
      run: async (exe, args, o) => { options = o; return { stdout: report() }; }
    });
    assert.deepStrictEqual(options.env, {
      SystemRoot: 'D:\\Win',
      windir: 'D:\\Win',
      PSModulePath: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules'
    });
    for (const inherited of ['USERPROFILE', 'HOMEPATH', 'APPDATA', 'PATH', 'Path']) assert.ok(!(inherited in options.env), inherited);
  } finally {
    for (const [k, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
});

// Живая проверка на Windows: модуль-двойник Microsoft.PowerShell.Security /
// Utility в «пользовательской» папке модулей подделывает ответ PowerShell,
// которому достался PSModulePath приложения, но не нашу проверку.
test('живой PowerShell: модуль-двойник в PSModulePath пользователя не подделывает «Valid»', { skip: process.platform !== 'win32', timeout: 60_000 }, async (t) => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { trustedSystemRoot } = require('../src/main/client-config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mychat-shadow-'));
  const forged = `{"Status":"Valid","SignerCertificate":{"Thumbprint":"${PINNED}"},"VersionInfo":{"ProductVersion":"1.2.0"}}`;
  const modules = {
    'Microsoft.PowerShell.Security': `function Get-AuthenticodeSignature { param([string]$LiteralPath, [string]$FilePath) [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Thumbprint = '${PINNED}' } } }`,
    'Microsoft.PowerShell.Utility': `function ConvertTo-Json { param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Compress) '${forged}' }`
  };
  const savedPath = process.env.PSModulePath;
  try {
    for (const [name, body] of Object.entries(modules)) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, `${name}.psm1`), `${body}\nExport-ModuleMember -Function *\n`);
    }
    const fake = path.join(dir, 'OpenMyChat-Enterprise-Setup-1.2.0.exe');
    fs.writeFileSync(fake, 'это не программа');
    const shadowPath = `${dir};${savedPath || ''}`;

    // Двойник действительно работает для PowerShell с унаследованным
    // окружением (иначе — например, политика запрещает скрипты — проверять
    // нечего).
    let probe = '';
    try {
      probe = execFileSync(
        powershellPath(trustedSystemRoot()),
        ['-NoProfile', '-NonInteractive', '-Command', `[string](Get-AuthenticodeSignature -LiteralPath '${fake}').Status`],
        { env: { ...process.env, PSModulePath: shadowPath }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {}
    if (probe !== 'Valid') {
      t.skip(`модуль-двойник не загрузился (${probe || 'ошибка'}) — нечего проверять`);
      return;
    }

    process.env.PSModulePath = shadowPath;
    const result = await verifyInstaller(fake, { expectedVersion: '1.2.0', currentVersion: '1.1.0' });
    assert.strictEqual(result, 'signature-untrusted');
  } finally {
    if (savedPath === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyInstaller: переменная SystemRoot не выбирает, какой PowerShell запустить', async () => {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = 'Q:\\FakeWindows';
  try {
    let exe = null;
    await verifyInstaller('C:\\t\\setup.exe', {
      expectedVersion: '1.2.0',
      currentVersion: '1.1.0',
      run: async (e) => { exe = e; return { stdout: report() }; }
    });
    assert.ok(!exe.startsWith('Q:'), exe);
    assert.match(exe, /^[A-Za-z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  } finally {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  }
});

test('verifyInstaller: ошибки подписи отклоняются своим кодом', async () => {
  const cases = [
    [report({ thumbprint: 'B'.repeat(40) }), 'signature-foreign'],
    [report({ status: 'HashMismatch' }), 'signature-untrusted'],
    [report({ productVersion: '1.0.9' }), 'version-mismatch'],
    ['garbage', 'signature-unreadable']
  ];
  for (const [stdout, code] of cases) {
    const result = await verifyInstaller('C:\\t\\setup.exe', { expectedVersion: '1.2.0', currentVersion: '1.1.0', run: async () => ({ stdout }) });
    assert.strictEqual(result, code, stdout);
  }
});

test('verifyInstaller: ошибка запуска → отказ', async () => {
  const result = await verifyInstaller('C:\\t\\setup.exe', {
    expectedVersion: '1.2.0',
    currentVersion: '1.1.0',
    run: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); }
  });
  assert.strictEqual(result, 'signature-check-failed');

  const sync = await verifyInstaller('C:\\t\\setup.exe', {
    expectedVersion: '1.2.0',
    currentVersion: '1.1.0',
    run: () => { throw new Error('boom'); }
  });
  assert.strictEqual(sync, 'signature-check-failed', 'синхронное исключение тоже отказ');
});

test('verifyInstaller: тайм-аут → отказ', async () => {
  const hung = await verifyInstaller('C:\\t\\setup.exe', {
    expectedVersion: '1.2.0',
    currentVersion: '1.1.0',
    run: () => new Promise(() => {}),
    timeoutMs: 20
  });
  assert.strictEqual(hung, 'signature-check-timeout');

  // execFile сам убил процесс по тайм-ауту.
  const killed = await verifyInstaller('C:\\t\\setup.exe', {
    expectedVersion: '1.2.0',
    currentVersion: '1.1.0',
    run: async () => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }); }
  });
  assert.strictEqual(killed, 'signature-check-timeout');
});

test('verifyInstaller: пустой путь — отказ без запуска', async () => {
  let ran = false;
  const result = await verifyInstaller('', { expectedVersion: '1.2.0', currentVersion: '1.1.0', run: async () => { ran = true; return { stdout: report() }; } });
  assert.strictEqual(result, 'signature-check-failed');
  assert.strictEqual(ran, false);
});

// ── Согласованность отпечатка по всему репозиторию ─────────────────────────

function psVariable(file, name) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(new RegExp(`^\\s*\\$${name}\\s*=\\s*'([0-9A-Fa-f]{40})'`, 'm'));
  assert.ok(m, `${name} в ${path.relative(REPO, file)}`);
  return m[1].toUpperCase();
}

test('закреплённый отпечаток совпадает со скриптами подписи и установки сертификата', () => {
  assert.strictEqual(PINNED_THUMBPRINTS[0], PINNED);
  assert.strictEqual(psVariable(path.join(REPO, 'desktop', 'scripts', 'signing-common.ps1'), 'MyChatPinnedThumbprint'), PINNED_THUMBPRINTS[0]);
  assert.strictEqual(psVariable(path.join(REPO, 'installer', 'установить-сертификат.ps1'), 'PinnedThumbprint'), PINNED_THUMBPRINTS[0]);
  assert.strictEqual(psVariable(path.join(REPO, 'installer', 'разблокировать-запуск.ps1'), 'PinnedThumbprint'), PINNED_THUMBPRINTS[0]);
  assert.ok(Object.isFrozen(PINNED_THUMBPRINTS), 'список нельзя дополнить во время работы');
});
