const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  clientConfigPath,
  programDataDir,
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

test('ProgramData берётся только в виде <диск>:\\ProgramData', () => {
  assert.strictEqual(programDataDir({ ProgramData: 'C:\\ProgramData' }), 'C:\\ProgramData');
  assert.strictEqual(programDataDir({ ProgramData: 'D:\\ProgramData\\' }), 'D:\\ProgramData');
  // Подмена переменной на папку пользователя не уводит чтение конфигурации.
  assert.strictEqual(programDataDir({ ProgramData: 'C:\\Users\\u\\fake' }), 'C:\\ProgramData');
  assert.strictEqual(programDataDir({ ProgramData: '\\\\evil\\share\\ProgramData' }), 'C:\\ProgramData');
  assert.strictEqual(programDataDir({}), 'C:\\ProgramData');
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
