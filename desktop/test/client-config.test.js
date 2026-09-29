const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {
  POLICY_KEY,
  trustedSystemRoot,
  parseRegValue,
  parseRegEntry,
  expandSystemPath,
  resolveSystemDirs,
  readClientConfig,
  resolveEffectiveServerUrl
} = require('../src/main/client-config');

const SYSTEM_ROOT = 'C:\\Windows';
const HARD_DEFAULT = 'https://chat-production-0456.up.railway.app';

// Вывод «reg.exe query <ключ политики>»: строки «    Имя    ТИП    значение».
function policyOutput(values) {
  const lines = values.map(([name, type, data]) => `    ${name}    ${type}    ${data}`);
  return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\OpenMyChat Enterprise\r\n${lines.join('\r\n')}\r\n\r\n`;
}

function policyReg(values, calls = []) {
  return (exe, key, name) => {
    calls.push({ exe, key, name });
    return policyOutput(values);
  };
}

// reg.exe на отсутствующий ключ: код выхода 1 и «ОШИБКА: …» в stderr.
function noPolicyKey() {
  throw Object.assign(new Error('Command failed: reg.exe query'), { status: 1 });
}

// ── Папки Windows: в собранной сборке — не из окружения ────────────────────

const REG_PROFILE_LIST = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\r\n    ProgramData    REG_EXPAND_SZ    %SystemDrive%\\ProgramData\r\n\r\n';
const kernelRoot = (root) => (p) => {
  assert.strictEqual(p, '\\\\?\\GLOBALROOT\\SystemRoot');
  return root;
};

test('собранная сборка: ProgramData из HKLM, корень системы из ядра, окружение не читается', () => {
  const regCalls = [];
  const dirs = resolveSystemDirs({
    isPackaged: true,
    // subst Q: на папку профиля + ProgramData=Q:\ProgramData в HKCU\Environment
    env: { ProgramData: 'Q:\\ProgramData', SystemRoot: 'Q:\\Windows' },
    realpath: kernelRoot('D:\\Windows'),
    regQuery: (exe, key, name) => {
      regCalls.push({ exe, key, name });
      return REG_PROFILE_LIST;
    }
  });
  assert.strictEqual(dirs.systemRoot, 'D:\\Windows');
  assert.strictEqual(dirs.programData, 'D:\\ProgramData', '%SystemDrive% — диск доверенного корня системы');
  assert.deepStrictEqual(regCalls, [{
    exe: 'D:\\Windows\\System32\\reg.exe',
    key: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList',
    name: 'ProgramData'
  }]);
  assert.strictEqual(dirs.problems.length, 2, 'расхождение с окружением видно в журнале');
});

test('собранная сборка: реестр и ядро недоступны — C:\\Windows и C:\\ProgramData, не окружение', () => {
  const dirs = resolveSystemDirs({
    isPackaged: true,
    env: { ProgramData: 'D:\\ProgramData', SystemRoot: 'D:\\Windows' },
    realpath: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    regQuery: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); }
  });
  assert.strictEqual(dirs.systemRoot, 'C:\\Windows');
  assert.strictEqual(dirs.programData, 'C:\\ProgramData');
  assert.ok(dirs.problems.length >= 2);
});

test('собранная сборка: мусор в реестре или от ядра не принимается', () => {
  for (const raw of ['%USERPROFILE%\\ProgramData', '\\\\evil\\share', 'C:\\x\\..\\..\\Users\\u', '']) {
    const dirs = resolveSystemDirs({
      isPackaged: true,
      env: {},
      realpath: kernelRoot('C:\\Windows'),
      regQuery: () => `\r\n    ProgramData    REG_EXPAND_SZ    ${raw}\r\n`
    });
    assert.strictEqual(dirs.programData, 'C:\\ProgramData', raw);
  }
  const weirdRoot = resolveSystemDirs({ isPackaged: true, env: {}, realpath: kernelRoot('\\Device\\HarddiskVolume3\\Windows'), regQuery: () => REG_PROFILE_LIST });
  assert.strictEqual(weirdRoot.systemRoot, 'C:\\Windows');
  assert.strictEqual(trustedSystemRoot({ realpath: kernelRoot('\\\\?\\C:\\Windows') }), 'C:\\Windows');
});

test('разработка: папки из окружения, как раньше', () => {
  const dirs = resolveSystemDirs({
    isPackaged: false,
    env: { ProgramData: 'D:\\ProgramData', SystemRoot: 'D:\\Windows' },
    realpath: kernelRoot('C:\\Windows'),
    regQuery: () => { throw new Error('не должен вызываться'); }
  });
  assert.deepStrictEqual(dirs, { systemRoot: 'D:\\Windows', programData: 'D:\\ProgramData', problems: [] });
});

test('разбор вывода reg.exe и раскрытие %SystemDrive%', () => {
  assert.strictEqual(parseRegValue(REG_PROFILE_LIST, 'ProgramData'), '%SystemDrive%\\ProgramData');
  assert.strictEqual(parseRegValue('\r\n    SystemRoot    REG_SZ    C:\\WINDOWS\r\n', 'systemroot'), 'C:\\WINDOWS');
  assert.strictEqual(parseRegValue('ERROR: not found', 'ProgramData'), null);
  assert.strictEqual(expandSystemPath('%SystemDrive%\\ProgramData', 'E:\\Windows'), 'E:\\ProgramData');
  assert.strictEqual(expandSystemPath('%SYSTEMROOT%\\Temp', 'C:\\Windows'), 'C:\\Windows\\Temp');
  assert.strictEqual(expandSystemPath('%ALLUSERSPROFILE%', 'C:\\Windows'), null, 'прочие переменные не раскрываются');
});

test('на этой машине корень системы определяется через ядро', { skip: process.platform !== 'win32' }, () => {
  const root = trustedSystemRoot();
  assert.match(root, /^[A-Za-z]:\\/);
  const dirs = resolveSystemDirs({ isPackaged: true, env: {} });
  assert.strictEqual(dirs.systemRoot, root);
  assert.match(dirs.programData, /^[A-Za-z]:\\ProgramData$/i, 'настоящий reg.exe и настоящий HKLM');
  assert.deepStrictEqual(dirs.problems, []);
});

// ── Политика машины: HKLM\SOFTWARE\Policies\OpenMyChat Enterprise ─────────

test('ключ политики — HKLM\\SOFTWARE\\Policies\\OpenMyChat Enterprise, читается reg.exe из доверенного корня', () => {
  assert.strictEqual(POLICY_KEY, 'HKLM\\SOFTWARE\\Policies\\OpenMyChat Enterprise');
  const calls = [];
  const config = readClientConfig({
    systemRoot: 'D:\\Windows',
    isPackaged: true,
    regQuery: policyReg([
      ['ServerUrl', 'REG_SZ', 'https://chat.centras.local'],
      ['UpdatesEnabled', 'REG_DWORD', '0x1'],
      ['UpdateChannel', 'REG_SZ', 'beta']
    ], calls)
  });
  assert.deepStrictEqual(calls, [{ exe: 'D:\\Windows\\System32\\reg.exe', key: POLICY_KEY, name: null }]);
  assert.strictEqual(config.serverUrl, 'https://chat.centras.local');
  assert.deepStrictEqual(config.updates, { enabled: true, channel: 'beta' });
  assert.strictEqual(config.source, 'hklm-policy');
  assert.deepStrictEqual(config.problems, []);

  const effective = resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: true, env: {} });
  assert.deepStrictEqual(effective, { url: 'https://chat.centras.local', source: 'hklm-policy', ignored: null });
});

test('ключа политики нет — константа, обновления включены, канал stable', () => {
  const config = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: noPolicyKey });
  assert.strictEqual(config.serverUrl, null);
  assert.deepStrictEqual(config.updates, { enabled: true, channel: 'stable' });
  assert.strictEqual(config.source, 'default');
  assert.strictEqual(config.problems.length, 1, 'отсутствие политики видно в журнале');
  const effective = resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: true, env: {} });
  assert.deepStrictEqual(effective, { url: HARD_DEFAULT, source: 'default', ignored: null });
});

test('ключ есть, но пустой — значения по умолчанию, источник — политика', () => {
  const config = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: policyReg([]) });
  assert.strictEqual(config.serverUrl, null);
  assert.deepStrictEqual(config.updates, { enabled: true, channel: 'stable' });
  assert.strictEqual(config.source, 'hklm-policy');
  assert.deepStrictEqual(config.problems, []);
});

test('reg.exe не запустился или завис — политика не читается, константа', () => {
  for (const err of [
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' })
  ]) {
    const config = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: () => { throw err; } });
    assert.strictEqual(config.serverUrl, null, err.code);
    assert.strictEqual(config.source, 'default', err.code);
    assert.deepStrictEqual(config.updates, { enabled: true, channel: 'stable' });
    assert.strictEqual(config.problems.length, 1, err.code);
  }
});

test('корень системы не определён — reg.exe не запускается', () => {
  for (const systemRoot of [undefined, '', 'Q:', '\\\\evil\\share\\Windows', 'C:\\x\\..\\Windows']) {
    let called = false;
    const config = readClientConfig({ systemRoot, isPackaged: true, regQuery: () => { called = true; return ''; } });
    assert.strictEqual(called, false, String(systemRoot));
    assert.strictEqual(config.source, 'default');
    assert.strictEqual(config.serverUrl, null);
    assert.strictEqual(config.problems.length, 1);
  }
});

test('ServerUrl: http, учётные данные в адресе и мусор отклоняются', () => {
  for (const url of ['http://chat.centras.local', 'https://user:pass@chat.centras.local', 'https://user@chat.centras.local', 'file:///C:/evil.html', 'chat.centras.local', '']) {
    const config = readClientConfig({
      systemRoot: SYSTEM_ROOT,
      isPackaged: true,
      regQuery: policyReg([['ServerUrl', 'REG_SZ', url]])
    });
    assert.strictEqual(config.serverUrl, null, url);
    assert.strictEqual(config.problems.length, 1, url);
    assert.ok(!config.problems[0].includes('pass'), 'адрес с паролем не пишется в журнал');
    assert.strictEqual(resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: true, env: {} }).url, HARD_DEFAULT);
  }
});

test('значения неожиданного типа не принимаются', () => {
  const expand = readClientConfig({
    systemRoot: SYSTEM_ROOT,
    isPackaged: true,
    regQuery: policyReg([['ServerUrl', 'REG_EXPAND_SZ', 'https://%COMPUTERNAME%.centras.local']])
  });
  assert.strictEqual(expand.serverUrl, null, 'REG_EXPAND_SZ для адреса не раскрывается и не принимается');
  assert.strictEqual(expand.problems.length, 1);

  const multi = readClientConfig({
    systemRoot: SYSTEM_ROOT,
    isPackaged: true,
    regQuery: policyReg([['ServerUrl', 'REG_MULTI_SZ', 'https://chat.centras.local\\0https://evil.example']])
  });
  assert.strictEqual(multi.serverUrl, null);
  assert.strictEqual(multi.problems.length, 1);

  // Выключатель с неверным типом («1» строкой) — как опечатка: обновления
  // выключены, и это видно в журнале.
  const enabledAsText = readClientConfig({
    systemRoot: SYSTEM_ROOT,
    isPackaged: true,
    regQuery: policyReg([['UpdatesEnabled', 'REG_SZ', '1']])
  });
  assert.strictEqual(enabledAsText.updates.enabled, false);
  assert.strictEqual(enabledAsText.problems.length, 1);

  const channelAsNumber = readClientConfig({
    systemRoot: SYSTEM_ROOT,
    isPackaged: true,
    regQuery: policyReg([['UpdateChannel', 'REG_DWORD', '0x1']])
  });
  assert.strictEqual(channelAsNumber.updates.channel, 'stable');
  assert.strictEqual(channelAsNumber.problems.length, 1);
});

test('UpdatesEnabled=0 выключает обновления на машине, 1 — включает', () => {
  const off = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: policyReg([['UpdatesEnabled', 'REG_DWORD', '0x0']]) });
  assert.deepStrictEqual(off.updates, { enabled: false, channel: 'stable' });
  assert.strictEqual(off.source, 'hklm-policy');
  assert.deepStrictEqual(off.problems, []);

  const on = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: policyReg([['UpdatesEnabled', 'REG_DWORD', '0x1']]) });
  assert.strictEqual(on.updates.enabled, true);
  assert.deepStrictEqual(on.problems, []);

  const odd = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: policyReg([['UpdatesEnabled', 'REG_DWORD', '0x2']]) });
  assert.strictEqual(odd.updates.enabled, false, 'непонятное значение выключателя — выключено');
  assert.strictEqual(odd.problems.length, 1);
});

test('UpdateChannel: неизвестный канал → stable', () => {
  for (const channel of ['nightly', 'BETA', '', 'stable beta']) {
    const config = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: policyReg([['UpdateChannel', 'REG_SZ', channel]]) });
    assert.strictEqual(config.updates.channel, 'stable', channel);
    assert.strictEqual(config.problems.length, 1, channel);
  }
  const stable = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: policyReg([['UpdateChannel', 'REG_SZ', 'stable']]) });
  assert.deepStrictEqual(stable.problems, []);
});

test('имена значений сравниваются без учёта регистра, как в реестре', () => {
  const config = readClientConfig({
    systemRoot: SYSTEM_ROOT,
    isPackaged: true,
    regQuery: policyReg([['serverurl', 'REG_SZ', 'https://chat.centras.local'], ['UPDATECHANNEL', 'REG_SZ', 'beta']])
  });
  assert.strictEqual(config.serverUrl, 'https://chat.centras.local');
  assert.strictEqual(config.updates.channel, 'beta');
});

test('собранная сборка не читает client.json из ProgramData вовсе', () => {
  // Раньше адрес сервера брался из %ProgramData%\OpenMyChat Enterprise\client.json.
  // Папку в ProgramData по умолчанию может создать любой пользователь — и
  // увести на свой сервер всех, кто работает на этом ПК.
  const touched = [];
  const readFile = (file) => {
    touched.push(`readFile:${file}`);
    return '{ "serverUrl": "https://evil.example" }';
  };
  const spied = ['readFileSync', 'existsSync', 'statSync', 'openSync', 'accessSync'];
  const originals = {};
  for (const name of spied) {
    originals[name] = fs[name];
    fs[name] = (...args) => {
      if (/client\.json/i.test(String(args[0]))) touched.push(`${name}:${args[0]}`);
      return originals[name].apply(fs, args);
    };
  }
  let config;
  try {
    config = readClientConfig({
      systemRoot: SYSTEM_ROOT,
      programData: 'C:\\ProgramData',
      readFile,
      isPackaged: true,
      regQuery: noPolicyKey
    });
  } finally {
    for (const name of spied) fs[name] = originals[name];
  }
  assert.deepStrictEqual(touched, []);
  assert.strictEqual(config.serverUrl, null);
  assert.strictEqual(resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: true, env: {} }).url, HARD_DEFAULT);
});

test('в разработке обновления выключены, переменные окружения работают', () => {
  const config = readClientConfig({
    systemRoot: SYSTEM_ROOT,
    isPackaged: false,
    regQuery: policyReg([['ServerUrl', 'REG_SZ', 'https://chat.centras.local'], ['UpdatesEnabled', 'REG_DWORD', '0x1']])
  });
  assert.strictEqual(config.updates.enabled, false);

  const fromEnv = resolveEffectiveServerUrl({
    config,
    hardDefault: HARD_DEFAULT,
    isPackaged: false,
    env: { VITE_DEV_SERVER_URL: 'http://localhost:5173' }
  });
  assert.strictEqual(fromEnv.url, 'http://localhost:5173');
  assert.strictEqual(fromEnv.source, 'env');

  const noEnv = resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: false, env: {} });
  assert.strictEqual(noEnv.url, 'https://chat.centras.local');
  assert.strictEqual(noEnv.source, 'hklm-policy');

  const badEnv = resolveEffectiveServerUrl({
    config: readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: false, regQuery: noPolicyKey }),
    hardDefault: HARD_DEFAULT,
    isPackaged: false,
    env: { MYCHAT_SERVER_URL: 'http://10.0.0.5:2004' }
  });
  assert.strictEqual(badEnv.url, HARD_DEFAULT);
  assert.strictEqual(badEnv.ignored, 'http://10.0.0.5:2004');
});

test('собранная сборка переменные окружения игнорирует', () => {
  const env = { VITE_DEV_SERVER_URL: 'https://evil.com', MYCHAT_SERVER_URL: 'https://evil.com' };
  const withPolicy = readClientConfig({
    systemRoot: SYSTEM_ROOT,
    isPackaged: true,
    regQuery: policyReg([['ServerUrl', 'REG_SZ', 'https://chat.centras.local']])
  });
  assert.strictEqual(resolveEffectiveServerUrl({ config: withPolicy, hardDefault: HARD_DEFAULT, isPackaged: true, env }).url, 'https://chat.centras.local');
  const without = readClientConfig({ systemRoot: SYSTEM_ROOT, isPackaged: true, regQuery: noPolicyKey });
  assert.strictEqual(resolveEffectiveServerUrl({ config: without, hardDefault: HARD_DEFAULT, isPackaged: true, env }).url, HARD_DEFAULT);
});

test('разбор строк reg.exe с типом значения', () => {
  const out = policyOutput([['ServerUrl', 'REG_SZ', 'https://a.b'], ['Empty', 'REG_SZ', ''], ['UpdatesEnabled', 'REG_DWORD', '0x0']]);
  assert.deepStrictEqual(parseRegEntry(out, 'serverurl'), { type: 'REG_SZ', data: 'https://a.b' });
  assert.deepStrictEqual(parseRegEntry(out, 'Empty'), { type: 'REG_SZ', data: '' });
  assert.deepStrictEqual(parseRegEntry(out, 'UpdatesEnabled'), { type: 'REG_DWORD', data: '0x0' });
  assert.strictEqual(parseRegEntry(out, 'Missing'), null);
  assert.strictEqual(parseRegValue(out, 'UpdatesEnabled'), null, 'parseRegValue — только строковые типы');
  assert.strictEqual(parseRegValue(out, 'ServerUrl'), 'https://a.b');
});

test('на этой машине политика читается настоящим reg.exe без сбоев', { skip: process.platform !== 'win32' }, () => {
  const config = readClientConfig({ systemRoot: trustedSystemRoot(), isPackaged: true });
  assert.ok(['hklm-policy', 'default'].includes(config.source), config.source);
  if (config.source === 'default') assert.strictEqual(config.problems.length, 1, config.problems.join('; '));
});
