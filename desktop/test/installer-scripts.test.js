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

// Код без строк-комментариев: упоминание client.json в пояснении допустимо,
// в коде — нет.
function codeLines(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

test('configure-client.ps1 — требует прав администратора, пишет политику HKLM, проверяет https', () => {
  const text = readText(path.join(INSTALLER_DIR, 'configure-client.ps1'));
  assert.match(text, /^﻿?#Requires -RunAsAdministrator/m, 'должен требовать права администратора (#Requires -RunAsAdministrator)');
  assert.ok(
    text.includes("$PolicyKey = 'HKLM:\\SOFTWARE\\Policies\\OpenMyChat Enterprise'"),
    'политика машины — в HKLM:\\SOFTWARE\\Policies\\OpenMyChat Enterprise (пишут только администраторы)'
  );
  assert.match(text, /New-ItemProperty[^\n]*-Name ServerUrl[^\n]*-PropertyType String/, 'ServerUrl — REG_SZ');
  assert.match(text, /New-ItemProperty[^\n]*-Name UpdateChannel[^\n]*-PropertyType String/, 'UpdateChannel — REG_SZ');
  assert.match(text, /New-ItemProperty[^\n]*-Name UpdatesEnabled[^\n]*-PropertyType DWord/, 'UpdatesEnabled — REG_DWORD');
  assert.match(text, /https:\/\//, 'должен проверять, что адрес сервера начинается с https://');
  assert.match(text, /UserInfo/, 'адрес с именем и паролем должен отклоняться');
});

test('configure-client.ps1 — client.json больше не пишет', () => {
  const code = codeLines(readText(path.join(INSTALLER_DIR, 'configure-client.ps1')));
  assert.ok(!/client\.json/i.test(code), 'client.json не должен упоминаться в коде скрипта');
  assert.ok(!/ProgramData/i.test(code), 'скрипт не должен трогать ProgramData');
  assert.ok(!/WriteAllText|Set-Content|Out-File|icacls/i.test(code), 'скрипт не пишет файлы и не меняет ACL файлов');
  assert.ok(!fs.existsSync(path.join(INSTALLER_DIR, 'acl-guard.ps1')), 'acl-guard.ps1 больше не нужен');
});

test('install.ps1 и настроить-клиент.bat — говорят о политике реестра, а не о client.json', () => {
  for (const name of ['install.ps1', 'настроить-клиент.bat']) {
    const text = readText(path.join(INSTALLER_DIR, name));
    assert.ok(!/client\.json/i.test(text), `${name} не должен упоминать client.json`);
    assert.match(text, /Policies\\OpenMyChat Enterprise/, `${name} должен называть ключ политики`);
  }
});

test('правило брандмауэра — только домен/частная сеть; для «Общественной» сети — подсказка сменить профиль, а не расширять правило', () => {
  for (const name of ['setup-firewall.bat', 'install-service.bat']) {
    const text = readText(path.join(INSTALLER_DIR, name));
    assert.match(text, /localport=2004 profile=domain,private/, `${name}: правило только для домена и частной сети`);
    assert.ok(!/profile=(any|public|domain,private,public)/i.test(text), `${name}: правило не расширяется на публичный профиль`);
    assert.match(text, /^echo .*Get-NetConnectionProfile/m, `${name}: команда проверки профиля сети`);
    assert.match(text, /^echo .*Set-NetConnectionProfile -InterfaceIndex \S+ -NetworkCategory Private/m, `${name}: команда смены профиля на частный`);
    assert.match(text, /Общественн|Public/, `${name}: объясняет, когда это нужно`);
    // Символы, которые cmd в echo понимает как перенаправление, сломали бы подсказку.
    for (const line of text.split(/\r?\n/).filter((l) => /^echo .*NetConnectionProfile/.test(l))) {
      assert.ok(!/[<>|&]/.test(line), `${name}: в строке подсказки нет < > | &: ${line}`);
    }
  }
});

// Установщик называется OpenMyChat-Enterprise-Setup-<версия>.exe
// (build.nsis.artifactName); старое имя без версии в подсказках вводит в
// заблуждение.
const UNVERSIONED_ARTIFACT = /OpenMyChat-Enterprise-(Setup|Portable)\.exe/;

test('установщик и документация не называют файлы без версии', () => {
  const files = fs.readdirSync(INSTALLER_DIR)
    .filter((name) => /\.(ps1|bat|txt|vbs)$/i.test(name))
    .map((name) => path.join(INSTALLER_DIR, name))
    .concat([path.join(DOCS_DIR, 'аудит-и-улучшения.md'), path.join(DOCS_DIR, 'автообновление.md')]);
  for (const file of files) {
    const text = readText(file);
    assert.ok(!UNVERSIONED_ARTIFACT.test(text), `${path.basename(file)}: имя установщика без версии`);
  }
  assert.match(readText(path.join(INSTALLER_DIR, 'SHA256SUMS.txt')), /OpenMyChat-Enterprise-Setup-\d+\.\d+\.\d+\.exe/);
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
  // Splatting массива передал бы строку '-ServerUrl' позиционным значением —
  // configure-client.ps1 получил бы ServerUrl='-ServerUrl' и отказал.
  assert.match(text, /\$configArgs = @\{\}/, 'параметры configure-client.ps1 — хэш-таблицей');
  assert.ok(!/\$configArgs \+= @\(/.test(text), 'не массивом');
});

test('docs/автообновление.md — существует и описывает выключатель и публикацию', () => {
  const docPath = path.join(DOCS_DIR, 'автообновление.md');
  assert.ok(fs.existsSync(docPath), 'должен существовать docs/автообновление.md');
  const text = readText(docPath);
  assert.match(text, /UPDATES_DISABLED/, 'должен описывать жёсткий выключатель UPDATES_DISABLED');
  assert.match(text, /publish:update/, 'должен описывать npm run publish:update');
  assert.match(
    text,
    /client\.json[^]{0,200}теперь игнорируется[^]{0,200}удалите этот файл/,
    'должен сказать, что client.json пилотной версии игнорируется и его нужно заменить политикой и удалить'
  );
});
