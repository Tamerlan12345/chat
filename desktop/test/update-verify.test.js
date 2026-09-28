const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  PINNED_THUMBPRINTS,
  VERIFY_TIMEOUT_MS,
  powershellPath,
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
  assert.deepStrictEqual(args.slice(0, 2), ['-NoProfile', '-NonInteractive']);
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
