// Проверяет установку «копией» (installer/install.ps1, uninstall.ps1 и их
// общую часть copy-install-common.ps1) настоящим PowerShell.
//
// Функции copy-install-common.ps1 подключаются точкой и проверяются по
// отдельности: какую папку можно считать установкой (и значит — удалять
// целиком), удаление без захода в точки соединения, закрытие запущенного
// приложения. Затем install.ps1 и uninstall.ps1 целиком — на их копиях, где
// ключи реестра, рабочий стол и меню «Пуск» заменены песочницей, а
// %LOCALAPPDATA% подменён переменной окружения (так же, как
// installer-policy.test.js подменяет ключ политики).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { UUID } = require('builder-util-runtime');

const REPO = path.join(__dirname, '..', '..');
const INSTALLER = path.join(REPO, 'installer');
const COMMON = path.join(INSTALLER, 'copy-install-common.ps1');
const SKIP = process.platform !== 'win32' && 'только Windows (PowerShell, реестр)';
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const PING = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE');

const REG_ROOT = `Software\\CentyChatCopyTest-${crypto.randomBytes(4).toString('hex')}`;
const KEYS = { arp: `${REG_ROOT}\\Arp`, run: `${REG_ROOT}\\Run`, nsisCu: `${REG_ROOT}\\NsisCu`, nsisLm: `${REG_ROOT}\\NsisLm` };
const AUMID = 'com.openmychat.desktop';

let sandbox;

function ps(script, { env = {}, file } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  const r = spawnSync('powershell.exe', file ? [...args, '-File', file] : [...args, '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env, ...env }
  });
  return r;
}

// Выполняет функции copy-install-common.ps1 и возвращает то, что сценарий
// вывел последней строкой (JSON).
function common(body, env) {
  const r = ps(`. ${psQuote(COMMON)}; ${body}`, { env });
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

function reg(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}
function regSet(key, name, value) {
  const r = reg(['add', `HKCU\\${key}`, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
  assert.strictEqual(r.status, 0, r.stderr);
}
function regGet(key, name) {
  const r = reg(['query', `HKCU\\${key}`, '/v', name]);
  if (r.status !== 0) return null;
  const m = r.stdout.match(new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_\\w+\\s+(.*)$`, 'm'));
  return m ? m[1].trimEnd() : '';
}
const regKeyExists = (key) => reg(['query', `HKCU\\${key}`]).status === 0;

function junction(link, target) {
  const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// «Приложение» — копия ping.exe под нужным именем: живёт минуту и держит свой exe.
function startFake(exe) {
  const child = spawn(exe, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  return child;
}

async function waitFor(check, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check();
}

test.before(() => {
  if (SKIP) return;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'centychat-copy-'));
});

test.after(() => {
  if (SKIP) return;
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('GUID установки через Setup.exe в copy-install-common.ps1 — тот, что electron-builder выводит из appId', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'package.json'), 'utf8'));
  // NsisTarget.js: UUID.v5(appId, ELECTRON_BUILDER_NS_UUID).
  const guid = UUID.v5(pkg.build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  const text = fs.readFileSync(COMMON, 'utf8');
  assert.ok(text.includes(`$CentyChatNsisGuid = '${guid}'`), `ожидался GUID ${guid}`);
});

test('скрипты установки «копией» разбираются PowerShell без ошибок и сохранены с BOM', { skip: SKIP }, () => {
  for (const name of ['install.ps1', 'uninstall.ps1', 'copy-install-common.ps1']) {
    const file = path.join(INSTALLER, name);
    const r = ps(`$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(file)}, [ref]$t, [ref]$e); $e.Count`);
    assert.strictEqual(r.stdout.trim(), '0', `${name}: ${r.stderr}`);
    assert.deepStrictEqual([...fs.readFileSync(file).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name}: UTF-8 с BOM`);
  }
});

test('Test-CentyChatCopyDir: только прямая подпапка Programs с exe приложения, не ссылка', { skip: SKIP }, () => {
  const root = path.join(sandbox, 'guard');
  const programs = path.join(root, 'Programs');
  const make = (dir, exe) => {
    fs.mkdirSync(dir, { recursive: true });
    if (exe) fs.writeFileSync(path.join(dir, exe), 'x');
    return dir;
  };
  const cases = {
    current: make(path.join(programs, 'CentyChat'), 'CentyChat.exe'),
    legacy: make(path.join(programs, 'OpenMyChat Enterprise'), 'OpenMyChat Enterprise.exe'),
    legacyTrailing: path.join(programs, 'OpenMyChat Enterprise') + '\\',
    noExe: make(path.join(programs, 'Other'), 'other.exe'),
    exeIsDir: make(path.join(programs, 'Tricky', 'CentyChat.exe')) && path.join(programs, 'Tricky'),
    nested: make(path.join(programs, 'Vendor', 'CentyChat'), 'CentyChat.exe'),
    programsItself: (fs.writeFileSync(path.join(programs, 'CentyChat.exe'), 'x'), programs),
    profile: make(path.join(root, 'Profile'), 'CentyChat.exe'),
    escape: path.join(programs, 'CentyChat', '..', '..', 'Profile'),
    relative: 'Programs\\CentyChat',
    driveRoot: path.parse(root).root,
    empty: ''
  };
  make(path.join(root, 'Target'), 'CentyChat.exe');
  junction(path.join(programs, 'Linked'), path.join(root, 'Target'));
  cases.junction = path.join(programs, 'Linked');

  const body = Object.entries(cases)
    .map(([k, v]) => `$r[${psQuote(k)}] = Test-CentyChatCopyDir -Path ${psQuote(v)} -ProgramsRoot ${psQuote(programs)}`)
    .join('; ');
  const result = common(`$r = [ordered]@{}; ${body}; $r | ConvertTo-Json -Compress`);
  assert.deepStrictEqual(result, {
    current: true,
    legacy: true,
    legacyTrailing: true,
    noExe: false,
    exeIsDir: false,
    nested: false,
    programsItself: false,
    profile: false,
    escape: false,
    relative: false,
    driveRoot: false,
    empty: false,
    junction: false
  });

  // По умолчанию корень — %LOCALAPPDATA%\Programs.
  const byEnv = common(`Test-CentyChatCopyDir -Path ${psQuote(cases.current)} | ConvertTo-Json`, { LOCALAPPDATA: root });
  assert.strictEqual(byEnv, true);
});

test('Remove-CentyChatCopyDir удаляет папку, но не то, на что указывают точки соединения внутри', { skip: SKIP }, () => {
  const root = path.join(sandbox, 'remove');
  const victim = path.join(root, 'Programs', 'CentyChat');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(victim, 'resources', 'deep'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(victim, 'CentyChat.exe'), 'x');
  fs.writeFileSync(path.join(victim, 'resources', 'app.asar'), 'x');
  const ro = path.join(victim, 'resources', 'deep', 'readonly.txt');
  fs.writeFileSync(ro, 'x');
  fs.chmodSync(ro, 0o444);
  junction(path.join(victim, 'link'), outside);
  junction(path.join(victim, 'resources', 'deep', 'link2'), outside);

  const ok = common(`Remove-CentyChatCopyDir -Path ${psQuote(victim)} | ConvertTo-Json`);
  assert.strictEqual(ok, true);
  assert.ok(!fs.existsSync(victim), 'папка удалена');
  assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'цель точки соединения цела');
});

test('Stop-CentyChatCopyApp закрывает запущенное из папки и только его', { skip: SKIP }, async () => {
  const dir = path.join(sandbox, 'stop', 'Programs', 'CentyChat');
  const other = path.join(sandbox, 'stop', 'elsewhere');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.copyFileSync(PING, path.join(dir, 'CentyChat.exe'));
  fs.copyFileSync(PING, path.join(other, 'CentyChat.exe'));
  const inside = startFake(path.join(dir, 'CentyChat.exe'));
  const outside = startFake(path.join(other, 'CentyChat.exe'));
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(isRunning(inside.pid) && isRunning(outside.pid));
    const stopped = common(`Stop-CentyChatCopyApp -Dir ${psQuote(dir)} | ConvertTo-Json`);
    assert.strictEqual(stopped, true);
    assert.ok(await waitFor(() => !isRunning(inside.pid), 5000), 'запущенное из папки закрыто');
    assert.ok(isRunning(outside.pid), 'тот же exe из другой папки не тронут');
  } finally {
    for (const child of [inside, outside]) if (isRunning(child.pid)) child.kill();
  }
});

test('Get-CentyChatNsisInstall находит установку через Setup.exe по записи NSIS', { skip: SKIP }, () => {
  const keys = `@(${psQuote(`HKCU:\\${KEYS.nsisCu}`)}, ${psQuote(`HKCU:\\${KEYS.nsisLm}`)})`;
  // ConvertTo-Json в PowerShell 5.1 ничего не выводит для $null.
  const lookup = () => common(`$v = Get-CentyChatNsisInstall -KeyPaths ${keys}; if ($null -eq $v) { 'null' } else { $v | ConvertTo-Json }`);
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  assert.strictEqual(lookup(), null);
  regSet(KEYS.nsisLm, 'InstallLocation', 'C:\\Program Files\\CentyChat');
  assert.strictEqual(lookup(), 'C:\\Program Files\\CentyChat');
  regSet(KEYS.nsisCu, 'InstallLocation', 'C:\\Users\\u\\AppData\\Local\\Programs\\OpenMyChat Enterprise');
  assert.strictEqual(lookup(), 'C:\\Users\\u\\AppData\\Local\\Programs\\OpenMyChat Enterprise');
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
});

// ── install.ps1 и uninstall.ps1 целиком, в песочнице ───────────────────────

function sandboxLayout(name) {
  const root = path.join(sandbox, name);
  return {
    root,
    local: path.join(root, 'Local'),
    programs: path.join(root, 'Local', 'Programs'),
    desktop: path.join(root, 'Desktop'),
    menu: path.join(root, 'Menu'),
    dist: path.join(root, 'dist')
  };
}

// Копии скриптов с ключами реестра и папками песочницы.
function stageScripts(l) {
  fs.mkdirSync(path.join(l.dist, 'app', 'resources'), { recursive: true });
  fs.mkdirSync(l.programs, { recursive: true });
  fs.mkdirSync(l.desktop, { recursive: true });
  fs.mkdirSync(l.menu, { recursive: true });
  fs.copyFileSync(PING, path.join(l.dist, 'app', 'CentyChat.exe'));
  fs.writeFileSync(path.join(l.dist, 'app', 'resources', 'app.asar'), 'new');
  const replace = (text, from, to) => {
    assert.ok(text.includes(from), `в скрипте нет «${from}»`);
    return text.split(from).join(to);
  };
  const patch = (text) => {
    let t = text;
    t = replace(t, "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenMyChatEnterprise'", psQuote(`HKCU:\\${KEYS.arp}`));
    t = replace(t, "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'", psQuote(`HKCU:\\${KEYS.run}`));
    t = replace(t, "[Environment]::GetFolderPath('Desktop')", psQuote(l.desktop));
    t = replace(t, "[Environment]::GetFolderPath('Programs')", psQuote(l.menu));
    return t;
  };
  for (const name of ['install.ps1', 'uninstall.ps1']) {
    fs.writeFileSync(path.join(l.dist, name), patch(fs.readFileSync(path.join(INSTALLER, name), 'utf8')), 'utf8');
  }
  let commonText = fs.readFileSync(COMMON, 'utf8');
  const nsisKeys = /\$CentyChatNsisKeys = @\([^)]*\)/;
  assert.match(commonText, nsisKeys);
  commonText = commonText.replace(nsisKeys, `$CentyChatNsisKeys = @(${psQuote(`HKCU:\\${KEYS.nsisCu}`)}, ${psQuote(`HKCU:\\${KEYS.nsisLm}`)})`);
  fs.writeFileSync(path.join(l.dist, 'copy-install-common.ps1'), commonText, 'utf8');
}

function makeShortcut(lnk, target) {
  const r = ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)}); $s.TargetPath = ${psQuote(target)}; $s.Save()`);
  assert.strictEqual(r.status, 0, r.stderr);
}
function shortcutTarget(lnk) {
  return ps(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)}).TargetPath`).stdout.trim();
}

const runInstall = (l) => ps(null, { file: path.join(l.dist, 'install.ps1'), env: { LOCALAPPDATA: l.local } });
const runUninstall = (l, script) => ps(null, { file: script, env: { LOCALAPPDATA: l.local } });

test('install.ps1 поверх копии 1.0.0: на месте, приложение закрыто, прежние exe и ярлыки убраны; uninstall.ps1 всё убирает', { skip: SKIP }, async () => {
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  const l = sandboxLayout('e2e-legacy');
  stageScripts(l);
  const legacy = path.join(l.programs, 'OpenMyChat Enterprise');
  fs.mkdirSync(path.join(legacy, 'resources'), { recursive: true });
  fs.copyFileSync(PING, path.join(legacy, 'OpenMyChat Enterprise.exe'));
  fs.writeFileSync(path.join(legacy, 'resources', 'app.asar'), 'old');
  for (const dir of [l.desktop, l.menu]) makeShortcut(path.join(dir, 'OpenMyChat Enterprise.lnk'), path.join(legacy, 'OpenMyChat Enterprise.exe'));
  // Чужой ярлык с тем же именем — в другую папку — остаётся.
  makeShortcut(path.join(l.root, 'foreign.lnk'), path.join(l.root, 'elsewhere', 'OpenMyChat Enterprise.exe'));
  regSet(KEYS.arp, 'InstallLocation', legacy);
  regSet(KEYS.run, AUMID, `"${path.join(legacy, 'OpenMyChat Enterprise.exe')}" --autostart`);
  const running = startFake(path.join(legacy, 'OpenMyChat Enterprise.exe'));
  try {
    await new Promise((r) => setTimeout(r, 500));
    const r = runInstall(l);
    assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!isRunning(running.pid), 'запущенная 1.0.0 закрыта до копирования');
  } finally {
    if (isRunning(running.pid)) running.kill();
  }
  const exe = path.join(legacy, 'CentyChat.exe');
  assert.ok(fs.existsSync(exe), 'обновлено в прежней папке');
  assert.ok(!fs.existsSync(path.join(legacy, 'OpenMyChat Enterprise.exe')), 'прежний exe удалён');
  assert.strictEqual(fs.readFileSync(path.join(legacy, 'resources', 'app.asar'), 'utf8'), 'new');
  assert.ok(fs.existsSync(path.join(legacy, 'uninstall.ps1')) && fs.existsSync(path.join(legacy, 'copy-install-common.ps1')));
  for (const dir of [l.desktop, l.menu]) {
    assert.ok(!fs.existsSync(path.join(dir, 'OpenMyChat Enterprise.lnk')), 'прежний ярлык удалён');
    assert.strictEqual(shortcutTarget(path.join(dir, 'CentyChat.lnk')).toLowerCase(), exe.toLowerCase());
  }
  assert.strictEqual(regGet(KEYS.arp, 'DisplayName'), 'CentyChat');
  assert.strictEqual(regGet(KEYS.arp, 'InstallLocation'), legacy);
  assert.strictEqual(regGet(KEYS.run, AUMID), `"${exe}" --autostart`, 'автозапуск ведёт на новый exe');

  const u = runUninstall(l, path.join(legacy, 'uninstall.ps1'));
  assert.strictEqual(u.status, 0, `${u.stdout}\n${u.stderr}`);
  assert.ok(await waitFor(() => !fs.existsSync(legacy)), 'папка удалена');
  for (const dir of [l.desktop, l.menu]) assert.ok(!fs.existsSync(path.join(dir, 'CentyChat.lnk')));
  assert.ok(fs.existsSync(path.join(l.root, 'foreign.lnk')));
  assert.ok(!regKeyExists(KEYS.arp));
  assert.strictEqual(regGet(KEYS.run, AUMID), null, 'автозапуск в удалённую папку убран');
});

test('install.ps1 отказывается ставить копию рядом с установкой через Setup.exe', { skip: SKIP }, () => {
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  const l = sandboxLayout('e2e-nsis');
  stageScripts(l);
  regSet(KEYS.nsisCu, 'InstallLocation', path.join(l.programs, 'CentyChat'));
  const r = runInstall(l);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /Setup\.exe/);
  assert.deepStrictEqual(fs.readdirSync(l.programs), [], 'ничего не скопировано');
  assert.deepStrictEqual(fs.readdirSync(l.desktop), []);
  assert.ok(!regKeyExists(KEYS.arp));
});

test('неверный InstallLocation в записи не используется: ставится в Programs\\CentyChat, удаляется только она', { skip: SKIP }, async () => {
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  const l = sandboxLayout('e2e-bogus');
  stageScripts(l);
  // «Профиль пользователя» — с exe приложения внутри, как после установки
  // прежней версией скрипта по неверному адресу.
  const profile = path.join(l.root, 'Profile');
  fs.mkdirSync(path.join(profile, 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Documents', 'важное.docx'), 'data');
  fs.writeFileSync(path.join(profile, 'CentyChat.exe'), 'x');
  regSet(KEYS.arp, 'InstallLocation', profile);

  const r = runInstall(l);
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const fresh = path.join(l.programs, 'CentyChat');
  assert.ok(fs.existsSync(path.join(fresh, 'CentyChat.exe')));
  assert.strictEqual(regGet(KEYS.arp, 'InstallLocation'), fresh);

  // Запись снова испорчена — uninstall.ps1 берёт свою папку ($PSScriptRoot).
  regSet(KEYS.arp, 'InstallLocation', profile);
  const u = runUninstall(l, path.join(fresh, 'uninstall.ps1'));
  assert.strictEqual(u.status, 0, `${u.stdout}\n${u.stderr}`);
  assert.ok(await waitFor(() => !fs.existsSync(fresh)), 'удалена папка установки');
  assert.strictEqual(fs.readFileSync(path.join(profile, 'Documents', 'важное.docx'), 'utf8'), 'data', 'профиль не тронут');
});

test('uninstall.ps1 вне папки установки и без годной записи ничего не удаляет', { skip: SKIP }, () => {
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  const l = sandboxLayout('e2e-stray');
  stageScripts(l);
  const profile = path.join(l.root, 'Profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'CentyChat.exe'), 'x');
  regSet(KEYS.arp, 'InstallLocation', profile);
  // Скрипт из папки раздачи (рядом нет CentyChat.exe, и она не в Programs).
  const u = runUninstall(l, path.join(l.dist, 'uninstall.ps1'));
  assert.strictEqual(u.status, 1, u.stdout);
  assert.ok(fs.existsSync(path.join(profile, 'CentyChat.exe')));
  assert.ok(fs.existsSync(path.join(l.dist, 'install.ps1')));
  assert.ok(regKeyExists(KEYS.arp), 'запись не тронута');
});
