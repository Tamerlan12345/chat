// Проверяет конфигурацию сборки/подписи/публикации клиента (package.json,
// installer.nsh, publish-update.ps1) как текст/JSON — без реальной сборки:
// подпись требует сертификата на машине, а имена артефактов и флаги
// электрон-билдера должны совпадать с серверной проверкой обновлений
// (см. docs/superpowers/specs/2026-09-28-autoupdate-design.md).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP_DIR = path.join(__dirname, '..');
const pkgRaw = fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgRaw);

test('build.publish — generic провайдер, заглушка URL', () => {
  assert.ok(Array.isArray(pkg.build.publish), 'build.publish должен быть массивом');
  assert.strictEqual(pkg.build.publish[0].provider, 'generic');
});

test('win.signtoolOptions.publisherName содержит юридическое имя издателя', () => {
  const names = pkg.build.win.signtoolOptions.publisherName;
  assert.ok(Array.isArray(names), 'publisherName должен быть массивом');
  assert.ok(
    names.some((n) => n.includes('Centras Insurance (АО Сентрас Иншуранс)')),
    'publisherName должен содержать "Centras Insurance (АО Сентрас Иншуранс)"'
  );
});

test('win.verifyUpdateCodeSignature включён', () => {
  assert.strictEqual(pkg.build.win.verifyUpdateCodeSignature, true);
});

test('artifactName для nsis и portable — с дефисами и ${version}', () => {
  assert.strictEqual(pkg.build.nsis.artifactName, 'CentyChat-Setup-${version}.${ext}');
  assert.strictEqual(pkg.build.portable.artifactName, 'CentyChat-Portable-${version}.${ext}');
});

// ── Переименование OpenMyChat Enterprise → CentyChat ───────────────────────
// Уже установленные у сотрудников копии (1.0.0) обновляются на месте и
// сохраняют данные. Эти значения держат преемственность — см. комментарии в
// src/main/app-paths.js и build/installer.nsh.

test('переименование: видимые имена — CentyChat', () => {
  assert.strictEqual(pkg.build.productName, 'CentyChat');
  assert.strictEqual(pkg.build.nsis.shortcutName, 'CentyChat');
  assert.match(pkg.build.nsis.uninstallDisplayName, /^CentyChat\b/);
});

test('переименование: appId прежний — из него NSIS выводит GUID установки, от него зависят ярлыки и уведомления', () => {
  assert.strictEqual(pkg.build.appId, 'com.openmychat.desktop');
  const main = fs.readFileSync(path.join(DESKTOP_DIR, 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /app\.setAppUserModelId\('com\.openmychat\.desktop'\)/, 'AppUserModelId = appId');
  const nsh = fs.readFileSync(path.join(DESKTOP_DIR, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /"com\.openmychat\.desktop"/, 'автозапуск убирается под прежним AppUserModelId');
});

test('переименование: имя пакета прежнее — из него папка кэша electron-updater и имя профиля 1.0.0', () => {
  // electron-builder: updaterCacheDirName = `${name}-updater`
  // (%LOCALAPPDATA%\mychat-desktop-updater); Electron называет профиль по
  // name, пока productName не задан в корне package.json.
  assert.strictEqual(pkg.name, 'mychat-desktop');
});

test('переименование: профиль закреплён за %APPDATA%\\mychat-desktop до блокировки единственного экземпляра', () => {
  const { LEGACY_USER_DATA_DIR, userDataPath, pinUserData } = require('../src/main/app-paths');
  assert.strictEqual(LEGACY_USER_DATA_DIR, 'mychat-desktop');
  assert.strictEqual(LEGACY_USER_DATA_DIR, pkg.name, 'та же папка, что Electron брал по имени пакета в 1.0.0');
  const appData = 'C:\\Users\\u\\AppData\\Roaming';
  assert.strictEqual(userDataPath(appData), path.join(appData, 'mychat-desktop'));

  const calls = [];
  const app = {
    getPath: (name) => { calls.push(['getPath', name]); return appData; },
    setPath: (name, value) => calls.push(['setPath', name, value])
  };
  assert.strictEqual(pinUserData(app), path.join(appData, 'mychat-desktop'));
  assert.deepStrictEqual(calls, [['getPath', 'appData'], ['setPath', 'userData', path.join(appData, 'mychat-desktop')]]);

  // Явный --user-data-dir (отдельный профиль для диагностики) не перебивается.
  const switched = [];
  const withSwitch = {
    commandLine: { hasSwitch: (name) => name === 'user-data-dir' },
    getPath: (name) => { switched.push(['getPath', name]); return appData; },
    setPath: (name, value) => switched.push(['setPath', name, value])
  };
  assert.strictEqual(pinUserData(withSwitch), null);
  assert.deepStrictEqual(switched, [], 'ни чтения, ни закрепления');
  const withOtherSwitch = { ...withSwitch, commandLine: { hasSwitch: () => false } };
  assert.strictEqual(pinUserData(withOtherSwitch), path.join(appData, 'mychat-desktop'));

  const main = fs.readFileSync(path.join(DESKTOP_DIR, 'src', 'main', 'main.js'), 'utf8');
  const pinAt = main.indexOf('pinUserData(app);');
  assert.ok(pinAt > 0, 'main.js закрепляет профиль');
  for (const later of ["app.getPath('userData')", "app.getPath('logs')", 'requestSingleInstanceLock()', 'log(', 'app.enableSandbox()', 'session.']) {
    const at = main.indexOf(later);
    assert.ok(at === -1 || pinAt < at, `pinUserData раньше первого ${later}`);
  }
  // Раньше pinUserData — только подключение модулей.
  const before = main.slice(0, pinAt).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('//'));
  for (const line of before) assert.match(line, /^const .* = require\(/, `до закрепления профиля только require: ${line}`);
  assert.match(main, /statePath: path\.join\(userDataPath\(app\.getPath\('appData'\)\), 'update-state\.json'\)/, 'update-state.json — в той же папке профиля');
});

test('переименование: установка через NSIS узнаётся и по новому, и (страховка) по прежнему деинсталлятору', () => {
  const { UNINSTALLER_NAME, UNINSTALLER_NAMES } = require('../src/main/update-policy');
  assert.strictEqual(UNINSTALLER_NAME, `Uninstall ${pkg.build.productName}.exe`);
  assert.deepStrictEqual([...UNINSTALLER_NAMES], ['Uninstall CentyChat.exe', 'Uninstall OpenMyChat Enterprise.exe']);
  // Прежний деинсталлятор при обновлении на деле не остаётся (деинсталлятор
  // 1.0.0 уносит всё содержимое папки в $PLUGINSDIR, иначе установка
  // прерывается) — удаление одного файла с этим именем лишь страховка.
  const nsh = fs.readFileSync(path.join(DESKTOP_DIR, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!define \/ifndef CENTY_LEGACY_UNINSTALLER "Uninstall OpenMyChat Enterprise\.exe"/);
  assert.match(nsh, /!macro customInstall\b[^]*Delete "\$INSTDIR\\\$\{CENTY_LEGACY_UNINSTALLER\}"[^]*!macroend/);
});

test('переименование: установка «копией» убирается установщиком — всё или ничего, без захода в точки соединения', () => {
  // Поведение проверяет installer-nsh.test.js настоящим makensis; здесь —
  // то, что должно остаться в тексте, даже если makensis на машине нет.
  const nsh = fs.readFileSync(path.join(DESKTOP_DIR, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!define \/ifndef CENTY_COPY_PROGRAMS_DIR "\$LOCALAPPDATA\\Programs"/, 'копия — только прямая подпапка Programs, как в Test-CentyChatCopyDir');
  assert.match(nsh, /!macro customInit\b[^]*INSTALL_REGISTRY_KEY[^]*CENTY_COPY_ARP_KEY[^]*!macroend/, 'копия ищется, только если нет установки через Setup.exe');
  // Копия с деинсталлятором NSIS — это папка Setup.exe, не копия.
  assert.match(nsh, /\$\{if\} \$\{FileExists\} "\$centyCopyDir\\\$\{UNINSTALL_FILENAME\}"/);
  // Сначала переименование (удаётся, только если папку никто не держит без
  // права на удаление), затем проверки: новая установка не «уехала» вместе с
  // папкой, exe копии удалились (не запущены); только потом удаление папки и
  // записи копии.
  const body = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macro customUnInstall'));
  const at = (s, from = 0) => body.indexOf(s, from);
  const renameAt = at('Rename "$centyCopyDir" "$R3"');
  const appExeAt = at('${ifNot} ${FileExists} "$appExe"', renameAt);
  const exeDeleteAt = at('Delete "$R3\\${CENTY_EXE}"', appExeAt);
  const rmdirAt = at('!insertmacro centyRmdirTrash', exeDeleteAt);
  const arpAt = at('DeleteRegKey HKCU "${CENTY_COPY_ARP_KEY}"', rmdirAt);
  assert.ok(renameAt > 0 && appExeAt > renameAt && exeDeleteAt > appExeAt && rmdirAt > exeDeleteAt && arpAt > rmdirAt,
    'переименование → своя установка на месте → exe копии удалены → удаление папки → удаление записи');
  assert.match(nsh, /!macro centyRmdirTrash[^]*rmdir \/s \/q "%CENTY_COPY_TRASH%"[^]*!macroend/);
  assert.match(nsh, /!macro centyTaskkillApp[^]*taskkill \/F \/IM "\$\{CENTY_EXE\}"[^]*!macroend/, 'запасной путь закрытия');
  assert.match(body, /WriteRegStr HKCU "\$\{CENTY_RUNONCE_KEY\}" "CentyChatCopyCleanup"/, 'недоудалённый остаток — при следующем входе');
  assert.ok(!/^\s*RMDir \/r/m.test(nsh), 'RMDir /r проходит по точкам соединения');
  assert.match(nsh, /WriteRegStr HKCU "\$\{CENTY_RUN_KEY\}" "\$\{CENTY_AUMID\}" '"\$appExe" --autostart'/);
});

test('переименование: политика машины — HKLM\\SOFTWARE\\Policies\\CentyChat', () => {
  const { POLICY_KEY } = require('../src/main/client-config');
  assert.strictEqual(POLICY_KEY, 'HKLM\\SOFTWARE\\Policies\\CentyChat');
});

test('electron-updater — точная версия в dependencies (не devDependencies)', () => {
  assert.ok(
    pkg.dependencies && typeof pkg.dependencies['electron-updater'] === 'string',
    'electron-updater должен быть в dependencies'
  );
  assert.ok(
    !(pkg.devDependencies && 'electron-updater' in pkg.devDependencies),
    'electron-updater не должен быть в devDependencies'
  );
  const version = pkg.dependencies['electron-updater'];
  assert.ok(!/^[\^~]/.test(version), `версия electron-updater должна быть точной, а не "${version}"`);
  assert.match(version, /^\d+\.\d+\.\d+$/, `версия electron-updater должна быть semver без диапазона: "${version}"`);
});

test('electronFuses — прежние ключи сохранены и добавлен grantFileProtocolExtraPrivileges:false', () => {
  const fuses = pkg.build.electronFuses;
  assert.deepStrictEqual(fuses.runAsNode, false);
  assert.deepStrictEqual(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.deepStrictEqual(fuses.enableNodeCliInspectArguments, false);
  assert.deepStrictEqual(fuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.deepStrictEqual(fuses.onlyLoadAppFromAsar, true);
  assert.deepStrictEqual(fuses.enableCookieEncryption, true);
  assert.deepStrictEqual(fuses.grantFileProtocolExtraPrivileges, false);
});

test('каждый скрипт со сборкой electron-builder вызывает её с --publish never', () => {
  const scripts = pkg.scripts;
  const builderScripts = Object.entries(scripts).filter(([, cmd]) => cmd.includes('electron-builder'));
  assert.ok(builderScripts.length > 0, 'должен быть хотя бы один скрипт со сборкой electron-builder');
  for (const [name, cmd] of builderScripts) {
    assert.ok(cmd.includes('--publish never'), `скрипт "${name}" должен содержать --publish never: "${cmd}"`);
  }
});

test('publish:update — вызывает publish-update.ps1', () => {
  assert.match(pkg.scripts['publish:update'] || '', /publish-update\.ps1/);
});

test('installer.nsh — customInstallMode и customUnInstall с ${ifNot} ${isUpdated}', () => {
  const nsh = fs.readFileSync(path.join(DESKTOP_DIR, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customInstallMode/);
  assert.match(nsh, /isForceCurrentInstall/);
  assert.match(nsh, /\$\{ifNot\}\s+\$\{isUpdated\}/);
});

test('publish-update.ps1 существует и содержит закреплённый отпечаток сертификата', () => {
  const scriptPath = path.join(DESKTOP_DIR, 'scripts', 'publish-update.ps1');
  assert.ok(fs.existsSync(scriptPath), 'scripts/publish-update.ps1 должен существовать');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert.match(content, /0EB61614FC390FCD11BDF8DBFD40BE62EE10862A/);
});
