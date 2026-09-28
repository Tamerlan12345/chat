// Проверяет установочные скрипты и документацию администратора по
// автообновлению как текст — без реального запуска PowerShell (это делает
// build-config.test.js для конфигурации сборки; здесь — installer/ и
// docs/автообновление.md, см. раздел «Установщик» в
// docs/superpowers/specs/2026-09-28-autoupdate-design.md).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const INSTALLER_DIR = path.join(REPO_ROOT, 'installer');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

function readText(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

test('configure-client.ps1 — требует прав администратора, ACL, UTF-8 без BOM, проверку https', () => {
  const text = readText(path.join(INSTALLER_DIR, 'configure-client.ps1'));
  assert.match(text, /RunAsAdministrator/, 'должен требовать права администратора (#Requires -RunAsAdministrator)');
  assert.ok(text.includes('/inheritance:r'), 'ACL должен сбрасывать наследование (/inheritance:r)');
  assert.ok(
    text.includes('S-1-5-32-545:(OI)(CI)RX'),
    'ACL должен включать группу "Пользователи" (S-1-5-32-545) только на чтение и выполнение'
  );
  assert.ok(text.includes('UTF8Encoding $false'), 'client.json должен писаться в UTF-8 без BOM');
  assert.match(text, /https:\/\//, 'должен проверять, что адрес сервера начинается с https://');
});

test('настроить-клиент.bat — существует и запускает configure-client.ps1', () => {
  const batPath = path.join(INSTALLER_DIR, 'настроить-клиент.bat');
  assert.ok(fs.existsSync(batPath), 'должен существовать installer/настроить-клиент.bat');
  const text = readText(batPath);
  assert.match(text, /configure-client\.ps1/, 'должен вызывать configure-client.ps1');
});

test('install.ps1 — принимает параметры ServerUrl и Channel', () => {
  const text = readText(path.join(INSTALLER_DIR, 'install.ps1'));
  assert.match(text, /\$ServerUrl/, 'должен принимать параметр -ServerUrl');
  assert.match(text, /\$Channel/, 'должен принимать параметр -Channel');
});

test('docs/автообновление.md — существует и описывает выключатель и публикацию', () => {
  const docPath = path.join(DOCS_DIR, 'автообновление.md');
  assert.ok(fs.existsSync(docPath), 'должен существовать docs/автообновление.md');
  const text = readText(docPath);
  assert.match(text, /UPDATES_DISABLED/, 'должен описывать жёсткий выключатель UPDATES_DISABLED');
  assert.match(text, /publish:update/, 'должен описывать npm run publish:update');
});
