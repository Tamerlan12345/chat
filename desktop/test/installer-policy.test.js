// Проверяет installer/configure-client.ps1 настоящим запуском PowerShell:
// скрипт пишет политику машины в реестр, а client-config.js читает её тем же
// путём, что и собранное приложение (reg.exe из доверенного корня системы).
//
// Сам скрипт требует прав администратора и пишет в
// HKLM\SOFTWARE\Policies\CentyChat. Тест запускает его копию, где
// ключ политики заменён на временный ключ в HKCU, а строка
// «#Requires -RunAsAdministrator» убрана, — вся остальная логика (проверка
// https, типы значений, «без -ServerUrl адрес не трогать») исполняется как
// есть.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { readClientConfig, trustedSystemRoot, POLICY_KEY } = require('../src/main/client-config');

const SCRIPT = path.join(__dirname, '..', '..', 'installer', 'configure-client.ps1');
const SKIP = process.platform !== 'win32' && 'только Windows (реестр, PowerShell)';
const PS_POLICY_LINE = "$PolicyKey = 'HKLM:\\SOFTWARE\\Policies\\CentyChat'";

function makeTestCopy(testKeyPs) {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(text.includes(PS_POLICY_LINE), `в скрипте должна быть строка ${PS_POLICY_LINE}`);
  assert.match(text, /^﻿?#Requires -RunAsAdministrator/m);
  const patched = text
    .replace(/^(﻿?)#Requires -RunAsAdministrator.*$/m, '$1# (тест: без #Requires)')
    .replace(PS_POLICY_LINE, `$PolicyKey = '${testKeyPs}'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mychat-policy-'));
  const file = path.join(dir, 'configure-client.ps1');
  // UTF-8 с BOM — как у оригинала: PowerShell 5.1 без BOM читает кириллицу
  // в кодовой странице ANSI.
  fs.writeFileSync(file, patched.startsWith('﻿') ? patched : `﻿${patched}`, 'utf8');
  return { dir, file };
}

function runScript(file, args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000
  });
}

test('configure-client.ps1 пишет политику в реестр, client-config.js её читает', { skip: SKIP }, () => {
  const name = `CentyChatPolicyTest-${crypto.randomBytes(4).toString('hex')}`;
  const testKeyPs = `HKCU:\\Software\\${name}`;
  const testKeyReg = `HKCU\\Software\\${name}`;
  const { dir, file } = makeTestCopy(testKeyPs);
  const systemRoot = trustedSystemRoot();
  const regExe = `${systemRoot}\\System32\\reg.exe`;
  // Тот же разбор, что в приложении, но из временного ключа вместо HKLM.
  const readPolicy = () => readClientConfig({
    systemRoot,
    isPackaged: true,
    regQuery: (exe, key, valueName) => {
      assert.strictEqual(key, POLICY_KEY);
      assert.strictEqual(valueName, null);
      return execFileSync(exe, ['query', testKeyReg], { encoding: 'utf8', windowsHide: true });
    }
  });
  const regType = (value) => {
    const out = execFileSync(regExe, ['query', testKeyReg, '/v', value], { encoding: 'utf8', windowsHide: true });
    return out.match(/REG_[A-Z_]+/)[0];
  };

  try {
    // Первый запуск: адрес и канал; выключатель ещё не задан — пишется 1.
    let r = runScript(file, ['-ServerUrl', 'https://chat.centras.local', '-Channel', 'beta']);
    assert.strictEqual(r.status, 0, `код ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.strictEqual(regType('ServerUrl'), 'REG_SZ');
    assert.strictEqual(regType('UpdateChannel'), 'REG_SZ');
    assert.strictEqual(regType('UpdatesEnabled'), 'REG_DWORD');
    let config = readPolicy();
    assert.strictEqual(config.source, 'hklm-policy');
    assert.strictEqual(config.serverUrl, 'https://chat.centras.local');
    assert.deepStrictEqual(config.updates, { enabled: true, channel: 'beta' });
    assert.deepStrictEqual(config.problems, []);

    // -DisableUpdates без -ServerUrl: адрес и канал остаются, как были.
    r = runScript(file, ['-DisableUpdates']);
    assert.strictEqual(r.status, 0, `код ${r.status}: ${r.stderr}\n${r.stdout}`);
    config = readPolicy();
    assert.strictEqual(config.serverUrl, 'https://chat.centras.local', 'без -ServerUrl адрес не затирается');
    assert.deepStrictEqual(config.updates, { enabled: false, channel: 'beta' });

    // -EnableUpdates возвращает обновления.
    r = runScript(file, ['-EnableUpdates', '-Channel', 'stable']);
    assert.strictEqual(r.status, 0, `код ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.deepStrictEqual(readPolicy().updates, { enabled: true, channel: 'stable' });

    // http и адрес с учётными данными — отказ с кодом 2, реестр не меняется.
    for (const bad of ['http://chat.centras.local', 'https://user:pass@chat.centras.local', 'не адрес']) {
      r = runScript(file, ['-ServerUrl', bad]);
      assert.strictEqual(r.status, 2, `${bad}: код ${r.status}: ${r.stdout}`);
      assert.strictEqual(readPolicy().serverUrl, 'https://chat.centras.local', bad);
    }

    // Оба выключателя сразу — отказ.
    r = runScript(file, ['-DisableUpdates', '-EnableUpdates']);
    assert.strictEqual(r.status, 2, `код ${r.status}: ${r.stdout}`);
    assert.strictEqual(readPolicy().updates.enabled, true);

    // Кириллический домен: reg.exe печатает значения в кодовой странице OEM,
    // и клиент такой адрес прочитать не смог бы — записывается punycode.
    r = runScript(file, ['-ServerUrl', 'https://чат.компания.kz']);
    assert.strictEqual(r.status, 0, `код ${r.status}: ${r.stderr}\n${r.stdout}`);
    config = readPolicy();
    assert.strictEqual(config.serverUrl, 'https://xn--80a0bn.xn--80aqeigdi5k.kz/');
    assert.deepStrictEqual(config.problems, []);

    // Не-ASCII в пути так же переводится в ASCII (процентная запись).
    r = runScript(file, ['-ServerUrl', 'https://chat.centras.local/чат']);
    assert.strictEqual(r.status, 0, `код ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.strictEqual(readPolicy().serverUrl, 'https://chat.centras.local/%D1%87%D0%B0%D1%82');
  } finally {
    spawnSync(regExe, ['delete', testKeyReg, '/f'], { windowsHide: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
