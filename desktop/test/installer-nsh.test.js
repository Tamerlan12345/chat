// Проверяет desktop/build/installer.nsh настоящим makensis из кэша
// electron-builder: макросы собираются с -WX (как в сборке: предупреждение —
// ошибка) и для установщика, и для деинсталлятора, а затем тестовый
// установщик с этими макросами запускается на песочнице. Ключи реестра,
// %LOCALAPPDATA%\Programs и ярлыки подменяются через !define (installer.nsh
// задаёт их через !define /ifndef) — настоящий профиль не трогается.
//
// Что проверяется — переход на CentyChat с установки «копией» (1.0.0 или уже
// обновлённой новым install.ps1), когда установки через Setup.exe нет:
// запущенное из папки копии закрывается, папка убирается (точки соединения
// внутри не проходятся), а запись и прежние ярлыки — только если папки не
// стало; автозапуск переписывается на новый exe, только если вёл в прежнюю
// установку. И что при установке через Setup.exe, чужой папке или папке,
// которую не удалось освободить, копия остаётся как была.
//
// Без makensis в кэше (сборки на этой машине не было) тест пропускается —
// кроме CI (переменная CI задана): там это ошибка.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const DESKTOP = path.join(__dirname, '..');
const NSH = path.join(DESKTOP, 'build', 'installer.nsh');
const TEMPLATE_INCLUDE = path.join(DESKTOP, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const PING = path.join(SYSTEM32, 'PING.EXE');

function electronBuilderCache() {
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache') : null;
}

// Кэш electron-builder: <cache>\nsis-3.x\nsis-3.x-<хэш>\Bin\makensis.exe и
// <cache>\nsis-resources-3.x\nsis-resources-3.x-<хэш>\plugins\x86-unicode.
function findInCache(prefix, rel) {
  const cache = electronBuilderCache();
  if (!cache || !fs.existsSync(cache)) return null;
  for (const top of fs.readdirSync(cache).filter((n) => n.startsWith(prefix)).sort().reverse()) {
    const topDir = path.join(cache, top);
    if (!fs.statSync(topDir).isDirectory()) continue;
    for (const sub of fs.readdirSync(topDir)) {
      const candidate = path.join(topDir, sub, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const MAKENSIS = process.platform === 'win32' ? findInCache('nsis-3', path.join('Bin', 'makensis.exe')) : null;
const PLUGINS = process.platform === 'win32' ? findInCache('nsis-resources-', path.join('plugins', 'x86-unicode')) : null;
const MISSING = 'нет makensis в кэше electron-builder (соберите установщик хотя бы раз: npm run dist:nsis)';
const SKIP = process.platform !== 'win32'
  ? 'только Windows'
  : (!MAKENSIS || !PLUGINS) && !process.env.CI && MISSING;

const REG_ROOT = `Software\\CentyChatNshTest-${crypto.randomBytes(4).toString('hex')}`;
const KEYS = {
  install: `${REG_ROOT}\\Install`,
  run: `${REG_ROOT}\\Run`,
  arp: `${REG_ROOT}\\CopyArp`
};
const AUMID = 'com.openmychat.desktop';

let sandbox;
let installerExe;

const paths = () => ({
  programs: path.join(sandbox, 'Local', 'Programs'),
  legacy: path.join(sandbox, 'Local', 'Programs', 'OpenMyChat Enterprise'),
  fresh: path.join(sandbox, 'Local', 'Programs', 'CentyChat'),
  desktop: path.join(sandbox, 'Desktop'),
  desktopLnk: path.join(sandbox, 'Desktop', 'OpenMyChat Enterprise.lnk'),
  menuLnk: path.join(sandbox, 'Menu', 'OpenMyChat Enterprise.lnk'),
  outside: path.join(sandbox, 'outside')
});

function harness({ uninstaller, outFile }) {
  const p = paths();
  return [
    'Unicode true',
    `!addplugindir /x86-unicode "${PLUGINS}"`,
    `!addincludedir "${TEMPLATE_INCLUDE}"`,
    '!include "StdUtils.nsh"',
    // Флаг --updated — так же, как его объявляет electron-builder (nsisScriptGenerator.flags).
    '!macro _isUpdated _a _b _t _f',
    '  ${StdUtils.TestParameter} $R9 "updated"',
    '  StrCmp "$R9" "true" `${_t}` `${_f}`',
    '!macroend',
    '!define isUpdated `"" isUpdated ""`',
    `!define INSTALL_REGISTRY_KEY "${KEYS.install}"`,
    `!define CENTY_RUN_KEY "${KEYS.run}"`,
    `!define CENTY_COPY_ARP_KEY "${KEYS.arp}"`,
    `!define CENTY_COPY_PROGRAMS_DIR "${p.programs}"`,
    `!define CENTY_LEGACY_DESKTOP_LNK "${p.desktopLnk}"`,
    `!define CENTY_LEGACY_MENU_LNK "${p.menuLnk}"`,
    uninstaller ? '!define BUILD_UNINSTALLER' : '',
    `!include "${NSH}"`,
    // В сборке electron-builder LogicLib и FileFunc подключаются после
    // installer.nsh (common.nsh, multiUser.nsh), но до вставки макросов.
    '!include LogicLib.nsh',
    '!include FileFunc.nsh',
    'Name "CentyChat installer.nsh test"',
    `OutFile "${outFile}"`,
    'RequestExecutionLevel user',
    'SilentInstall silent',
    ...(uninstaller
      ? [
          'Section',
          `  WriteUninstaller "${outFile}.un.exe"`,
          'SectionEnd',
          'Section "un.Uninstall"',
          '  !insertmacro customUnInstall',
          'SectionEnd'
        ]
      : [
          'Var isForceCurrentInstall',
          'Var appExe',
          `InstallDir "${p.fresh}"`,
          'Function .onInit',
          '  !insertmacro customInit',
          'FunctionEnd',
          'Section',
          '  !insertmacro customInstallMode',
          '  SetOutPath $INSTDIR',
          '  StrCpy $appExe "$INSTDIR\\CentyChat.exe"',
          '  FileOpen $0 $appExe w',
          '  FileWrite $0 "new"',
          '  FileClose $0',
          '  !insertmacro customInstall',
          'SectionEnd'
        ])
  ].join('\r\n');
}

function compile(uninstaller) {
  const name = uninstaller ? 'un' : 'in';
  const script = path.join(sandbox, `${name}.nsi`);
  const outFile = path.join(sandbox, `${name}.exe`);
  // makensis читает сценарий с BOM как UTF-8.
  fs.writeFileSync(script, '\uFEFF' + harness({ uninstaller, outFile }), 'utf8');
  const r = spawnSync(MAKENSIS, ['-WX', '-V2', script], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { ...r, outFile };
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
  const m = r.stdout.match(new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_SZ\\s+(.*)$`, 'm'));
  return m ? m[1].trimEnd() : '';
}
const regKeyExists = (key) => reg(['query', `HKCU\\${key}`]).status === 0;

function resetSandbox() {
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  const p = paths();
  for (const dir of [path.join(sandbox, 'Local'), p.desktop, path.join(sandbox, 'Menu'), p.outside]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of [p.programs, p.desktop, path.join(sandbox, 'Menu'), p.outside]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function makeShortcut(lnk, target) {
  const ps = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); $s.TargetPath = '${target}'; $s.Save()`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
}

// Установка «копией» в папке dir: exe (копия ping.exe, чтобы его можно было
// запустить), ресурсы, uninstall.ps1, запись; у 1.0.0 — ярлыки
// «OpenMyChat Enterprise.lnk», у уже обновлённой — «CentyChat.lnk». Внутри по
// желанию — точка соединения на папку снаружи с файлом, который должен уцелеть.
function makeCopy(dir, { exe = 'OpenMyChat Enterprise.exe', withJunction = false } = {}) {
  const p = paths();
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.copyFileSync(PING, path.join(dir, exe));
  fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'old');
  fs.writeFileSync(path.join(dir, 'uninstall.ps1'), '# copy');
  fs.writeFileSync(path.join(dir, 'copy-install-common.ps1'), '# copy');
  if (withJunction) {
    fs.writeFileSync(path.join(p.outside, 'keep.txt'), 'keep');
    const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', path.join(dir, 'link'), p.outside], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  }
  if (exe === 'OpenMyChat Enterprise.exe') {
    for (const lnk of [p.desktopLnk, p.menuLnk]) makeShortcut(lnk, path.join(dir, exe));
  } else {
    makeShortcut(path.join(p.desktop, 'CentyChat.lnk'), path.join(dir, exe));
  }
  regSet(KEYS.arp, 'InstallLocation', dir);
  return path.join(dir, exe);
}

function start(exe, { cwd } = {}) {
  return spawn(exe, ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true, cwd });
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withProcesses(children, fn) {
  try {
    await new Promise((r) => setTimeout(r, 500));
    for (const child of children) assert.ok(isRunning(child.pid), 'подставной процесс запущен');
    await fn();
  } finally {
    for (const child of children) if (isRunning(child.pid)) child.kill();
  }
}

function runInstaller(installDir) {
  // /D= — последним и без кавычек даже с пробелами, как требует NSIS; Node
  // иначе взял бы весь аргумент в кавычки, и NSIS его бы не узнал.
  const r = spawnSync(installerExe, ['/S', `/D=${installDir}`], {
    windowsVerbatimArguments: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  });
  assert.strictEqual(r.status, 0, `установщик завершился с кодом ${r.status}`);
}

const leftovers = () => fs.readdirSync(paths().programs).filter((n) => n.includes('~centychat-remove'));

test.before(() => {
  if (SKIP) return;
  assert.ok(MAKENSIS && PLUGINS, `CI: ${MISSING}`);
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'centychat-nsh-'));
  const built = compile(false);
  assert.strictEqual(built.status, 0, `makensis (установщик):\n${built.stdout}\n${built.stderr}`);
  installerExe = built.outFile;
});

test.after(() => {
  if (SKIP || !sandbox) return;
  reg(['delete', `HKCU\\${REG_ROOT}`, '/f']);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('installer.nsh собирается с -WX и в деинсталляторе', { skip: SKIP }, () => {
  const built = compile(true);
  assert.strictEqual(built.status, 0, `makensis (деинсталлятор):\n${built.stdout}\n${built.stderr}`);
});

test('копия 1.0.0 без установки через Setup.exe: закрыта, ярлыки, запись и папка убраны, автозапуск на новом exe', { skip: SKIP }, async () => {
  resetSandbox();
  const p = paths();
  const exe = makeCopy(p.legacy, { withJunction: true });
  regSet(KEYS.run, AUMID, `"${exe}" --autostart`);
  // Тот же exe из другой папки (например, portable) не закрывается:
  // закрывается только запущенное из папки копии.
  const other = path.join(sandbox, 'Local', 'portable');
  fs.mkdirSync(other, { recursive: true });
  fs.copyFileSync(PING, path.join(other, 'OpenMyChat Enterprise.exe'));
  const app = start(exe);
  const otherApp = start(path.join(other, 'OpenMyChat Enterprise.exe'));
  await withProcesses([app, otherApp], () => {
    runInstaller(p.fresh);
    assert.ok(!isRunning(app.pid), 'запущенная 1.0.0 закрыта');
    assert.ok(isRunning(otherApp.pid), 'exe с тем же именем из другой папки не закрыт');
  });
  assert.ok(fs.existsSync(path.join(p.fresh, 'CentyChat.exe')));
  assert.ok(!fs.existsSync(p.legacy), 'папка копии 1.0.0 удалена');
  assert.deepStrictEqual(leftovers(), [], 'переименованная для удаления папка тоже убрана');
  assert.strictEqual(fs.readFileSync(path.join(p.outside, 'keep.txt'), 'utf8'), 'keep', 'цель точки соединения не тронута');
  assert.ok(!fs.existsSync(p.desktopLnk) && !fs.existsSync(p.menuLnk), 'ярлыки 1.0.0 удалены');
  assert.ok(!regKeyExists(KEYS.arp), 'запись копии в «Установке и удалении программ» удалена');
  assert.strictEqual(regGet(KEYS.run, AUMID), `"${path.join(p.fresh, 'CentyChat.exe')}" --autostart`);
});

test('копия, уже обновлённая install.ps1 до CentyChat.exe в прежней папке, тоже убирается', { skip: SKIP }, async () => {
  resetSandbox();
  const p = paths();
  const exe = makeCopy(p.legacy, { exe: 'CentyChat.exe' });
  regSet(KEYS.run, AUMID, `"${exe}" --autostart`);
  const app = start(exe);
  await withProcesses([app], () => {
    runInstaller(p.fresh);
    assert.ok(!isRunning(app.pid), 'запущенная копия закрыта');
  });
  assert.ok(!fs.existsSync(p.legacy), 'папка копии удалена');
  assert.ok(!regKeyExists(KEYS.arp), 'запись копии удалена — в «Установке и удалении программ» одна запись');
  assert.ok(fs.existsSync(path.join(p.desktop, 'CentyChat.lnk')), 'CentyChat.lnk не трогается: в сборке его пересоздаёт сам установщик');
  assert.strictEqual(regGet(KEYS.run, AUMID), `"${path.join(p.fresh, 'CentyChat.exe')}" --autostart`);
});

test('копия в другой подпапке Programs тоже убирается', { skip: SKIP }, () => {
  resetSandbox();
  const p = paths();
  const dir = path.join(p.programs, 'Chat');
  makeCopy(dir, { exe: 'CentyChat.exe' });
  runInstaller(p.fresh);
  assert.ok(!fs.existsSync(dir));
  assert.ok(!regKeyExists(KEYS.arp));
  assert.strictEqual(regGet(KEYS.run, AUMID), null, 'автозапуска не было — не появляется');
});

test('автозапуск на постороннем пути (portable) не трогается', { skip: SKIP }, () => {
  resetSandbox();
  const p = paths();
  makeCopy(p.legacy);
  const portable = `"${path.join(sandbox, 'Downloads', 'CentyChat-Portable-1.1.0.exe')}" --autostart`;
  regSet(KEYS.run, AUMID, portable);
  runInstaller(p.fresh);
  assert.ok(!fs.existsSync(p.legacy), 'копия убрана');
  assert.strictEqual(regGet(KEYS.run, AUMID), portable);
});

test('процесс с тем же именем из другой папки держит папку копии — taskkill, и копия всё же убрана', { skip: SKIP }, async () => {
  resetSandbox();
  const p = paths();
  makeCopy(p.legacy, { exe: 'CentyChat.exe' });
  fs.mkdirSync(path.join(p.legacy, 'locked'));
  // Запущен не из папки копии (закрытие по пути его не находит), но его
  // текущая папка — внутри неё, и переименовать папку нельзя, пока он жив.
  const other = path.join(sandbox, 'Local', 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  fs.copyFileSync(PING, path.join(other, 'CentyChat.exe'));
  const holder = start(path.join(other, 'CentyChat.exe'), { cwd: path.join(p.legacy, 'locked') });
  await withProcesses([holder], () => {
    runInstaller(p.fresh);
    assert.ok(!isRunning(holder.pid), 'закрыт запасным путём — taskkill по имени');
  });
  assert.ok(!fs.existsSync(p.legacy));
  assert.ok(!regKeyExists(KEYS.arp));
});

test('папку копии не удалось освободить — копия, запись и ярлыки остаются как были', { skip: SKIP }, async () => {
  resetSandbox();
  const p = paths();
  const exe = makeCopy(p.legacy);
  regSet(KEYS.run, AUMID, `"${exe}" --autostart`);
  fs.mkdirSync(path.join(p.legacy, 'locked'));
  // Посторонний процесс (не наш exe — ни закрытие по пути, ни taskkill его
  // не трогают) с текущей папкой внутри копии.
  const holder = start(PING, { cwd: path.join(p.legacy, 'locked') });
  await withProcesses([holder], () => runInstaller(p.fresh));
  for (const name of ['OpenMyChat Enterprise.exe', 'uninstall.ps1', 'copy-install-common.ps1', path.join('resources', 'app.asar')]) {
    assert.ok(fs.existsSync(path.join(p.legacy, name)), `${name} на месте — удалять нечего было частично`);
  }
  assert.deepStrictEqual(leftovers(), []);
  assert.strictEqual(regGet(KEYS.arp, 'InstallLocation'), p.legacy, 'запись на месте — копию можно удалить штатно');
  assert.ok(fs.existsSync(p.desktopLnk) && fs.existsSync(p.menuLnk), 'ярлыки на месте');
  assert.strictEqual(regGet(KEYS.run, AUMID), `"${exe}" --autostart`, 'автозапуск по-прежнему на копию');
});

test('есть установка через Setup.exe: копию не трогаем, автозапуск на прежнюю установку — на новый exe', { skip: SKIP }, () => {
  resetSandbox();
  const p = paths();
  makeCopy(p.legacy);
  const oldNsis = path.join(p.programs, 'Old NSIS');
  regSet(KEYS.install, 'InstallLocation', oldNsis);
  regSet(KEYS.run, AUMID, `"${path.join(oldNsis, 'OpenMyChat Enterprise.exe')}" --autostart`);

  runInstaller(p.fresh);

  assert.ok(fs.existsSync(path.join(p.legacy, 'OpenMyChat Enterprise.exe')), 'папка копии на месте');
  assert.ok(fs.existsSync(p.desktopLnk) && fs.existsSync(p.menuLnk), 'ярлыки на месте');
  assert.strictEqual(regGet(KEYS.arp, 'InstallLocation'), p.legacy, 'запись копии на месте');
  assert.strictEqual(regGet(KEYS.run, AUMID), `"${path.join(p.fresh, 'CentyChat.exe')}" --autostart`);
});

test('запись копии без uninstall.ps1 в папке — нерабочая, удаляется; запись на эту же папку — тоже', { skip: SKIP }, () => {
  resetSandbox();
  const p = paths();
  // Установка через Setup.exe есть (копия 1.0.0 лежала в той же папке, и её
  // удалил деинсталлятор 1.0.0) — от копии осталась только запись.
  regSet(KEYS.install, 'InstallLocation', p.legacy);
  regSet(KEYS.arp, 'InstallLocation', p.legacy);
  runInstaller(p.fresh);
  assert.ok(!regKeyExists(KEYS.arp), 'нерабочая запись удалена');

  // Копия CentyChat (install.ps1 после переименования) в папке, куда ставит Setup.exe.
  resetSandbox();
  fs.mkdirSync(p.fresh, { recursive: true });
  for (const name of ['CentyChat.exe', 'uninstall.ps1', 'copy-install-common.ps1']) fs.writeFileSync(path.join(p.fresh, name), 'copy');
  regSet(KEYS.arp, 'InstallLocation', p.fresh);
  runInstaller(p.fresh);
  assert.ok(!regKeyExists(KEYS.arp), 'запись копии удалена — папка теперь принадлежит установке через Setup.exe');
  assert.ok(!fs.existsSync(path.join(p.fresh, 'uninstall.ps1')));
  assert.ok(!fs.existsSync(path.join(p.fresh, 'copy-install-common.ps1')));
  assert.ok(fs.existsSync(path.join(p.fresh, 'CentyChat.exe')));
});

test('новая установка внутри папки копии: папка остаётся, убираются exe и скрипт удаления копии', { skip: SKIP }, () => {
  resetSandbox();
  const p = paths();
  makeCopy(p.legacy);
  const nested = path.join(p.legacy, 'CentyChat');

  runInstaller(nested);

  assert.ok(fs.existsSync(path.join(nested, 'CentyChat.exe')), 'новая версия на месте');
  assert.ok(!fs.existsSync(path.join(p.legacy, 'OpenMyChat Enterprise.exe')), 'прежний exe удалён');
  assert.ok(!fs.existsSync(path.join(p.legacy, 'uninstall.ps1')), 'uninstall.ps1 копии удалён — он снёс бы и новую установку');
  assert.ok(fs.existsSync(path.join(p.legacy, 'resources', 'app.asar')), 'остальное не трогается');
  assert.ok(!regKeyExists(KEYS.arp));
  assert.ok(!fs.existsSync(p.desktopLnk) && !fs.existsSync(p.menuLnk));
});

test('копия не в Programs или в папке-ссылке — чужая, не трогается', { skip: SKIP }, () => {
  resetSandbox();
  const p = paths();
  const elsewhere = path.join(sandbox, 'Local', 'Elsewhere', 'OpenMyChat Enterprise');
  makeCopy(elsewhere);
  runInstaller(p.fresh);
  assert.ok(fs.existsSync(path.join(elsewhere, 'OpenMyChat Enterprise.exe')));
  assert.ok(fs.existsSync(p.desktopLnk));
  assert.strictEqual(regGet(KEYS.arp, 'InstallLocation'), elsewhere);

  resetSandbox();
  const target = path.join(sandbox, 'Local', 'Target');
  makeCopy(target, { exe: 'CentyChat.exe' });
  const linked = path.join(p.programs, 'Linked');
  const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', linked, target], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  regSet(KEYS.arp, 'InstallLocation', linked);
  runInstaller(p.fresh);
  assert.ok(fs.existsSync(path.join(target, 'CentyChat.exe')), 'цель ссылки цела');
  assert.ok(fs.existsSync(linked), 'сама ссылка тоже');
  assert.strictEqual(regGet(KEYS.arp, 'InstallLocation'), linked);
});
