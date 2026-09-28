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
  assert.strictEqual(pkg.build.nsis.artifactName, 'OpenMyChat-Enterprise-Setup-${version}.${ext}');
  assert.strictEqual(pkg.build.portable.artifactName, 'OpenMyChat-Enterprise-Portable-${version}.${ext}');
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
