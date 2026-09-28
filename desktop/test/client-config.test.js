const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  clientConfigPath,
  trustedSystemRoot,
  parseRegValue,
  expandSystemPath,
  resolveSystemDirs,
  readClientConfig,
  resolveEffectiveServerUrl
} = require('../src/main/client-config');

const PROGRAM_DATA = 'C:\\ProgramData';
const FILE = path.win32.join(PROGRAM_DATA, 'OpenMyChat Enterprise', 'client.json');
const HARD_DEFAULT = 'https://chat-production-0456.up.railway.app';

function fileReader(content) {
  return (file) => {
    if (file !== FILE) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    if (content instanceof Error) throw content;
    return content;
  };
}

function missing() {
  throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

test('путь к client.json — %ProgramData%\\OpenMyChat Enterprise\\client.json', () => {
  assert.strictEqual(clientConfigPath(PROGRAM_DATA), FILE);
  assert.strictEqual(clientConfigPath(''), null);
  assert.strictEqual(clientConfigPath(undefined), null);
});

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

test('файл ProgramData побеждает константу', () => {
  const config = readClientConfig({
    programData: PROGRAM_DATA,
    readFile: fileReader('{ "serverUrl": "https://chat.centras.local", "updates": { "enabled": true, "channel": "beta" } }'),
    isPackaged: true
  });
  assert.strictEqual(config.serverUrl, 'https://chat.centras.local');
  assert.deepStrictEqual(config.updates, { enabled: true, channel: 'beta' });
  assert.strictEqual(config.source, 'programdata');
  assert.deepStrictEqual(config.problems, []);

  const effective = resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: true, env: {} });
  assert.strictEqual(effective.url, 'https://chat.centras.local');
  assert.strictEqual(effective.source, 'client.json');
});

test('без файла — константа, обновления включены, канал stable', () => {
  const config = readClientConfig({ programData: PROGRAM_DATA, readFile: missing, isPackaged: true });
  assert.strictEqual(config.serverUrl, null);
  assert.deepStrictEqual(config.updates, { enabled: true, channel: 'stable' });
  assert.strictEqual(config.source, 'none');
  assert.strictEqual(config.problems.length, 1, 'отсутствие файла видно в журнале');
  const effective = resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: true, env: {} });
  assert.deepStrictEqual(effective, { url: HARD_DEFAULT, source: 'default', ignored: null });
});

test('http, адрес с учётными данными и мусор вместо адреса игнорируются', () => {
  for (const serverUrl of ['http://chat.centras.local', 'https://user:pass@chat.centras.local', 'file:///C:/evil.html', 'chat.centras.local', 42]) {
    const config = readClientConfig({
      programData: PROGRAM_DATA,
      readFile: fileReader(JSON.stringify({ serverUrl })),
      isPackaged: true
    });
    assert.strictEqual(config.serverUrl, null, String(serverUrl));
    assert.strictEqual(config.problems.length, 1, String(serverUrl));
    assert.strictEqual(resolveEffectiveServerUrl({ config, hardDefault: HARD_DEFAULT, isPackaged: true, env: {} }).url, HARD_DEFAULT);
  }
});

test('испорченный JSON игнорируется целиком', () => {
  for (const text of ['{oops', '', 'null', '[1,2]', '"https://chat.centras.local"']) {
    const config = readClientConfig({ programData: PROGRAM_DATA, readFile: fileReader(text), isPackaged: true });
    assert.strictEqual(config.serverUrl, null, JSON.stringify(text));
    assert.deepStrictEqual(config.updates, { enabled: true, channel: 'stable' });
    assert.strictEqual(config.source, 'none');
    assert.ok(config.problems.length >= 1, JSON.stringify(text));
  }
});

test('BOM в начале файла не мешает', () => {
  const config = readClientConfig({
    programData: PROGRAM_DATA,
    readFile: fileReader('\uFEFF{ "serverUrl": "https://chat.centras.local" }'),
    isPackaged: true
  });
  assert.strictEqual(config.serverUrl, 'https://chat.centras.local');
  assert.deepStrictEqual(config.problems, []);
});

test('ошибка чтения (нет доступа) — файл игнорируется с записью', () => {
  const config = readClientConfig({
    programData: PROGRAM_DATA,
    readFile: fileReader(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    isPackaged: true
  });
  assert.strictEqual(config.serverUrl, null);
  assert.strictEqual(config.problems.length, 1);
});

test('updates.enabled=false выключает обновления на машине', () => {
  const config = readClientConfig({
    programData: PROGRAM_DATA,
    readFile: fileReader('{ "updates": { "enabled": false } }'),
    isPackaged: true
  });
  assert.strictEqual(config.updates.enabled, false);
  assert.strictEqual(config.updates.channel, 'stable');
  assert.strictEqual(config.source, 'programdata');
});

test('странное значение выключателя — обновления выключены (и это видно)', () => {
  const config = readClientConfig({
    programData: PROGRAM_DATA,
    readFile: fileReader('{ "updates": { "enabled": "false" } }'),
    isPackaged: true
  });
  assert.strictEqual(config.updates.enabled, false);
  assert.strictEqual(config.problems.length, 1);
});

test('неизвестный канал → stable', () => {
  for (const channel of ['nightly', 'BETA', '', 5, null]) {
    const config = readClientConfig({
      programData: PROGRAM_DATA,
      readFile: fileReader(JSON.stringify({ updates: { channel } })),
      isPackaged: true
    });
    assert.strictEqual(config.updates.channel, 'stable', String(channel));
    assert.strictEqual(config.problems.length, 1, String(channel));
  }
});

test('в разработке обновления выключены, переменные окружения работают', () => {
  const config = readClientConfig({
    programData: PROGRAM_DATA,
    readFile: fileReader('{ "serverUrl": "https://chat.centras.local", "updates": { "enabled": true } }'),
    isPackaged: false
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
  assert.strictEqual(noEnv.source, 'client.json');

  const badEnv = resolveEffectiveServerUrl({
    config: readClientConfig({ programData: PROGRAM_DATA, readFile: missing, isPackaged: false }),
    hardDefault: HARD_DEFAULT,
    isPackaged: false,
    env: { MYCHAT_SERVER_URL: 'http://10.0.0.5:2004' }
  });
  assert.strictEqual(badEnv.url, HARD_DEFAULT);
  assert.strictEqual(badEnv.ignored, 'http://10.0.0.5:2004');
});

test('собранная сборка переменные окружения игнорирует', () => {
  const env = { VITE_DEV_SERVER_URL: 'https://evil.com', MYCHAT_SERVER_URL: 'https://evil.com' };
  const withFile = readClientConfig({
    programData: PROGRAM_DATA,
    readFile: fileReader('{ "serverUrl": "https://chat.centras.local" }'),
    isPackaged: true
  });
  assert.strictEqual(resolveEffectiveServerUrl({ config: withFile, hardDefault: HARD_DEFAULT, isPackaged: true, env }).url, 'https://chat.centras.local');
  const without = readClientConfig({ programData: PROGRAM_DATA, readFile: missing, isPackaged: true });
  assert.strictEqual(resolveEffectiveServerUrl({ config: without, hardDefault: HARD_DEFAULT, isPackaged: true, env }).url, HARD_DEFAULT);
});
