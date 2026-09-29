// Проверяет desktop/scripts/publish-update.ps1: разбор настоящим парсером
// PowerShell, закреплённый отпечаток и — главное — загрузку выпуска на
// сервер. Раньше скрипт слал поля multipart «version» и «files» (пять штук,
// вместе с README.txt), а сервер (server/src/updates/admin-router.js) ждёт
// yml, setup, blockmap, portable и текстовое notes, не больше четырёх
// файлов — публикация с -Server всегда отклонялась.
//
// Загрузка проверяется по-настоящему: функции Get-MyChatUploadParts и
// Send-MyChatRelease вынимаются из скрипта парсером PowerShell и шлют
// выпуск на локальный HTTP-сервер этого теста; тело разбирается
// multipart-парсером Node (Response.formData). Весь скрипт целиком тест не
// запускает: ему нужен Setup, подписанный настоящим сертификатом.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { PINNED_THUMBPRINTS } = require('../src/main/update-verify');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'publish-update.ps1');
const SKIP = process.platform !== 'win32' && 'только Windows (PowerShell 5.1)';
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function codeLines(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

test('publish-update.ps1 разбирается PowerShell без ошибок', { skip: SKIP }, () => {
  const ps = [
    '$errs = $null; $tokens = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile(${psQuote(SCRIPT)}, [ref]$tokens, [ref]$errs) | Out-Null`,
    '$errs.Count'
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '0');
  const raw = fs.readFileSync(SCRIPT);
  assert.deepStrictEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 с BOM — иначе PowerShell 5.1 ломает кириллицу');
});

test('publish-update.ps1 сверяет только закреплённый отпечаток, переопределение MYCHAT_SIGN_THUMBPRINT не действует', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const code = codeLines(text);
  assert.ok(code.includes(`'${PINNED_THUMBPRINTS[0]}'`), 'тот же отпечаток, что закреплён в клиенте (update-verify.js)');
  assert.ok(!/MYCHAT_SIGN_THUMBPRINT/.test(code), 'переменная переопределения не читается');
  assert.ok(!/Get-MyChatExpectedThumbprint|Test-MyChatSignature/.test(code), 'функции с переопределением из signing-common.ps1 не используются');
});

test('publish-update.ps1 — токен из MYCHAT_UPDATE_TOKEN, TLS 1.2, поток вместо ReadAllBytes, верные подсказки', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const code = codeLines(text);
  assert.match(code, /\$env:MYCHAT_UPDATE_TOKEN/);
  assert.match(code, /\[Net\.ServicePointManager\]::SecurityProtocol/);
  assert.match(code, /\[Net\.ServicePointManager\]::SecurityProtocol = \[Net\.ServicePointManager\]::SecurityProtocol -bor \[Net\.SecurityProtocolType\]::Tls12/);
  // TLS 1.3 в .NET Framework без поддержки в SChannel ломает рукопожатие.
  assert.ok(!/Tls13/.test(code), 'только TLS 1.2');
  assert.match(code, /StreamContent/);
  assert.ok(!/ReadAllBytes/.test(code), 'файлы в сотни мегабайт не читаются в память целиком');
  assert.ok(!/Write-Host[^\n]*\$(Token|token|effectiveToken)\b/.test(code), 'токен не печатается');
  assert.ok(!/Автообновление → Выпуски|Импорт из папки/.test(text), 'такого раздела в консоли нет');
  assert.match(text, /inbox\/\$UpdateDirName\//, 'в inbox — подпапка, а не содержимое прямо в inbox/');
  assert.ok(!/скопируйте её содержимое в data\/updates\/inbox\/ /.test(text));
  assert.match(text, /«Обновления»/, 'настоящая вкладка консоли');
  assert.ok(!/назначен политикой обновления повторно/.test(text), 'откат только вперёд — см. docs/автообновление.md, раздел 4');
});

function startServer() {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '9.9.9' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

function runPs(command) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('выпуск уходит полями yml, setup, blockmap, portable и notes; README.txt не загружается', { skip: SKIP }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mychat-publish-'));
  const setupName = 'CentyChat-Setup-9.9.9.exe';
  const portableName = 'CentyChat-Portable-9.9.9.exe';
  const files = {
    'latest.yml': Buffer.from('version: 9.9.9\n'),
    [setupName]: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300000, 7)]),
    [`${setupName}.blockmap`]: Buffer.from('blockmap-bytes'),
    [portableName]: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1000, 3)]),
    'README.txt': Buffer.from('только для человека')
  };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);

  const { server, received, port } = await startServer();
  const token = 'secret-token-for-test';
  const notes = 'Исправлена передача файлов';
  // Функции берутся из самого скрипта: их текст — узлы FunctionDefinitionAst.
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$errs = $null; $tokens = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(SCRIPT)}, [ref]$tokens, [ref]$errs)`,
    'if ($errs.Count) { throw "parse errors" }',
    "foreach ($name in @('Get-MyChatUploadParts', 'Send-MyChatRelease')) {",
    '  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)',
    '  if (-not $fn) { throw "нет функции $name" }',
    '  . ([ScriptBlock]::Create($fn.Extent.Text))',
    '}',
    `$parts = Get-MyChatUploadParts -UpdateDir ${psQuote(dir)} -SetupName ${psQuote(setupName)} -PortableName ${psQuote(portableName)}`,
    `$r = Send-MyChatRelease -Uri ${psQuote(`http://127.0.0.1:${port}/api/admin/updates/releases`)} -Token ${psQuote(token)} -Parts $parts -Notes ${psQuote(notes)}`,
    '"STATUS=" + $r.Status'
  ].join('\n');

  let result;
  try {
    result = await runPs(ps);
  } finally {
    server.close();
  }
  try {
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /STATUS=201/);
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), 'токен не печатается');

    assert.strictEqual(received.length, 1);
    const req = received[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/api/admin/updates/releases');
    assert.strictEqual(req.headers.authorization, `Bearer ${token}`);

    const form = await new Response(req.body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    assert.deepStrictEqual([...form.keys()].sort(), ['blockmap', 'notes', 'portable', 'setup', 'yml']);
    const expect = { yml: 'latest.yml', setup: setupName, blockmap: `${setupName}.blockmap`, portable: portableName };
    for (const [field, name] of Object.entries(expect)) {
      const file = form.get(field);
      assert.strictEqual(file.name, name, field);
      assert.deepStrictEqual(Buffer.from(await file.arrayBuffer()), files[name], field);
    }
    assert.strictEqual(form.get('notes'), notes);
    assert.ok(!req.body.includes(Buffer.from('README')), 'README.txt на сервер не уходит');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
