const test = require('node:test');
const assert = require('node:assert');
const {
  compareVersions,
  isValidVersion,
  detectInstallKind,
  updateBaseUrl,
  feedOptions,
  requestHeaders,
  nextCheckDelay,
  updateCapability,
  resolveDownloadUrl,
  UNINSTALLER_NAME,
  UNINSTALLER_NAMES,
  FIRST_CHECK_MIN_MS,
  FIRST_CHECK_MAX_MS,
  MAX_BACKOFF_MS
} = require('../src/main/update-policy');

// ── Версии: те же векторы, что у сервера (server/test/update-policy.test.js) ──

const SHARED_VECTORS = [
  ['1.0.0', '1.0.1', -1],
  ['1.10.0', '1.9.0', 1],
  ['1.2.0-beta.1', '1.2.0', -1],
  ['1.2.0-beta.2', '1.2.0-beta.10', -1],
  ['1.2.0', '1.2.0', 0]
];

test('compareVersions: общие векторы клиента и сервера', () => {
  for (const [a, b, expected] of SHARED_VECTORS) {
    assert.strictEqual(compareVersions(a, b), expected, `${a} vs ${b}`);
    assert.strictEqual(compareVersions(b, a), -expected || 0, `${b} vs ${a}`);
  }
});

test('compareVersions: пререлизы по semver и неразборчивые строки', () => {
  assert.strictEqual(compareVersions('1.2.0-alpha', '1.2.0-beta'), -1);
  assert.strictEqual(compareVersions('1.2.0-1', '1.2.0-alpha'), -1, 'числовой идентификатор младше буквенного');
  assert.strictEqual(compareVersions('1.2.0-beta', '1.2.0-beta.1'), -1, 'короче — младше');
  assert.strictEqual(compareVersions('99999999999999999999.0.0', '99999999999999999998.0.0'), 1, 'длинные числа без потери точности');
  assert.strictEqual(compareVersions('garbage', '1.0.0'), -1, 'мусор младше любой версии');
  assert.strictEqual(compareVersions('1.0.0', undefined), 1);
  assert.strictEqual(compareVersions('x', 'y'), 0);
  assert.strictEqual(isValidVersion('1.2.0'), true);
  assert.strictEqual(isValidVersion('1.2.0-beta.1'), true);
  assert.strictEqual(isValidVersion('1.2'), false);
  assert.strictEqual(isValidVersion('1.2.0-beta.'), false);
  assert.strictEqual(isValidVersion(null), false);
});

// ── Вид установки ─────────────────────────────────────────────────────────

const PROGRAM_FILES = ['C:\\Program Files', 'C:\\Program Files (x86)'];

function kindOf({ isPackaged = true, execPath, env = {}, files = [] }) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return detectInstallKind({ isPackaged, execPath, env, exists: (f) => set.has(String(f).toLowerCase()), programFiles: PROGRAM_FILES });
}

test('detectInstallKind: разработка, portable, Program Files, установщик, копия', () => {
  assert.strictEqual(kindOf({ isPackaged: false, execPath: 'C:\\dev\\electron.exe' }), 'dev');

  assert.strictEqual(
    kindOf({ execPath: 'C:\\Users\\u\\AppData\\Local\\Temp\\2abc\\CentyChat.exe', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\CentyChat.exe' } }),
    'portable'
  );

  const machine = 'C:\\Program Files\\CentyChat\\CentyChat.exe';
  assert.strictEqual(kindOf({ execPath: machine, files: ['C:\\Program Files\\CentyChat\\' + UNINSTALLER_NAME] }), 'nsis-machine');
  assert.strictEqual(kindOf({ execPath: 'c:\\program files (x86)\\CentyChat\\CentyChat.exe' }), 'nsis-machine', 'регистр не важен');

  const perUser = 'C:\\Users\\u\\AppData\\Local\\Programs\\CentyChat\\CentyChat.exe';
  assert.strictEqual(
    kindOf({ execPath: perUser, files: ['C:\\Users\\u\\AppData\\Local\\Programs\\CentyChat\\' + UNINSTALLER_NAME] }),
    'nsis'
  );
  assert.strictEqual(kindOf({ execPath: perUser }), 'copy', 'без деинсталлятора рядом — копия');
  assert.strictEqual(kindOf({ execPath: 'D:\\Apps\\CentyChat\\CentyChat.exe' }), 'copy');

  // «C:\Program Files Evil\...» — не Program Files.
  assert.strictEqual(kindOf({ execPath: 'C:\\Program Files Evil\\CentyChat.exe' }), 'copy');
  assert.strictEqual(UNINSTALLER_NAME, 'Uninstall CentyChat.exe');
});

test('detectInstallKind: установка 1.0.0, обновлённая до CentyChat, — по-прежнему NSIS', () => {
  // Прежняя папка установки сохраняется (обычная установка кладёт CentyChat в
  // её подпапку). Деинсталлятор со старым именем рядом с exe на деле не
  // остаётся, но если окажется — это всё равно установка через NSIS.
  const legacyDir = 'C:\\Users\\u\\AppData\\Local\\Programs\\OpenMyChat Enterprise\\';
  assert.deepStrictEqual([...UNINSTALLER_NAMES], [UNINSTALLER_NAME, 'Uninstall OpenMyChat Enterprise.exe']);
  assert.strictEqual(kindOf({ execPath: legacyDir + 'CentyChat.exe', files: [legacyDir + 'Uninstall CentyChat.exe'] }), 'nsis');
  assert.strictEqual(kindOf({ execPath: legacyDir + 'CentyChat.exe', files: [legacyDir + 'Uninstall OpenMyChat Enterprise.exe'] }), 'nsis');
  assert.strictEqual(
    kindOf({ execPath: legacyDir + 'CentyChat\\CentyChat.exe', files: [legacyDir + 'CentyChat\\Uninstall CentyChat.exe'] }),
    'nsis'
  );
  assert.strictEqual(kindOf({ execPath: legacyDir + 'CentyChat.exe', files: [legacyDir + 'Uninstall Other.exe'] }), 'copy');
  // Сбой проверки одного имени не мешает найти другое.
  const flaky = (f) => {
    if (f.endsWith('Uninstall CentyChat.exe')) throw new Error('EACCES');
    return f.endsWith('Uninstall OpenMyChat Enterprise.exe');
  };
  assert.strictEqual(detectInstallKind({ isPackaged: true, execPath: legacyDir + 'CentyChat.exe', exists: flaky, programFiles: PROGRAM_FILES }), 'nsis');
});

test('updateCapability', () => {
  assert.strictEqual(updateCapability('nsis'), 'auto');
  for (const kind of ['portable', 'copy', 'nsis-machine']) assert.strictEqual(updateCapability(kind), 'notify', kind);
  assert.strictEqual(updateCapability('dev'), 'none');
  assert.strictEqual(updateCapability('whatever'), 'none');
});

// ── Адреса ─────────────────────────────────────────────────────────────────

test('базовый адрес обновлений: только https, завершающий /, канал', () => {
  assert.strictEqual(updateBaseUrl({ serverOrigin: 'https://chat.centras.local', channel: 'stable' }), 'https://chat.centras.local/updates/stable/');
  assert.strictEqual(updateBaseUrl({ serverOrigin: 'https://chat.centras.local:8443', channel: 'beta' }), 'https://chat.centras.local:8443/updates/beta/');
  assert.strictEqual(updateBaseUrl({ serverOrigin: 'https://chat.centras.local/', channel: 'nightly' }), 'https://chat.centras.local/updates/stable/');
  assert.strictEqual(updateBaseUrl({ serverOrigin: 'http://chat.centras.local', channel: 'stable' }), null);
  assert.strictEqual(updateBaseUrl({ serverOrigin: 'https://u:p@chat.centras.local', channel: 'stable' }), null);
  assert.strictEqual(updateBaseUrl({ serverOrigin: null, channel: 'stable' }), null);
  assert.strictEqual(updateBaseUrl({ serverOrigin: 'not a url', channel: 'stable' }), null);
});

test('feedOptions: generic, канал latest, без multi-range', () => {
  const base = 'https://chat.centras.local/updates/stable/';
  const opts = feedOptions({ baseUrl: base });
  assert.deepStrictEqual(opts, { provider: 'generic', url: base, channel: 'latest', useMultipleRangeRequest: false });
  // Сервер отвечает на multi-range полным 200 — дифференциальная загрузка
  // с multi-range сломалась бы.
  assert.strictEqual(opts.useMultipleRangeRequest, false);
});

test('адрес скачивания: относительный от сервера, только свой https-источник', () => {
  const origin = 'https://chat.centras.local';
  assert.strictEqual(
    resolveDownloadUrl({ url: '/updates/stable/CentyChat-Setup-1.2.0.exe', serverOrigin: origin }),
    'https://chat.centras.local/updates/stable/CentyChat-Setup-1.2.0.exe'
  );
  assert.strictEqual(resolveDownloadUrl({ url: 'https://evil.com/setup.exe', serverOrigin: origin }), null);
  assert.strictEqual(resolveDownloadUrl({ url: '//evil.com/setup.exe', serverOrigin: origin }), null);
  assert.strictEqual(resolveDownloadUrl({ url: 'file:///C:/Windows/calc.exe', serverOrigin: origin }), null);
  assert.strictEqual(resolveDownloadUrl({ url: '/x', serverOrigin: 'http://chat.centras.local' }), null);
  assert.strictEqual(resolveDownloadUrl({ url: null, serverOrigin: origin }), null);
  assert.strictEqual(resolveDownloadUrl({ url: 42, serverOrigin: origin }), null);
});

// ── Заголовки ──────────────────────────────────────────────────────────────

test('requestHeaders: installId, версия, вид и последняя ошибка', () => {
  const id = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
  assert.deepStrictEqual(requestHeaders({ installId: id, version: '1.1.0', kind: 'nsis', lastError: 'network' }), {
    'X-MyChat-Install-Id': id,
    'X-MyChat-Client-Version': '1.1.0',
    'X-MyChat-Install-Kind': 'nsis',
    'X-MyChat-Update-Error': 'network'
  });
  const noError = requestHeaders({ installId: id, version: '1.1.0', kind: 'portable', lastError: null });
  assert.ok(!('X-MyChat-Update-Error' in noError));
  // Мусор в заголовки не попадает: сервер его всё равно отбросит, а перевод
  // строки в заголовке уронил бы запрос.
  const junk = requestHeaders({ installId: 'x\r\ny', version: '1.1', kind: 'evil', lastError: 'Bad Error\n' });
  assert.deepStrictEqual(junk, {});
});

// ── Расписание ─────────────────────────────────────────────────────────────

test('первая проверка — через 60–300 с после старта', () => {
  assert.strictEqual(FIRST_CHECK_MIN_MS, 60_000);
  assert.strictEqual(FIRST_CHECK_MAX_MS, 300_000);
  assert.strictEqual(nextCheckDelay({ first: true, rand: () => 0 }), 60_000);
  const max = nextCheckDelay({ first: true, rand: () => 0.999999 });
  assert.ok(max <= 300_000 && max > 299_000, String(max));
  for (let i = 0; i < 200; i++) {
    const d = nextCheckDelay({ first: true });
    assert.ok(d >= 60_000 && d <= 300_000, String(d));
  }
});

test('обычная проверка — интервал ± 15%', () => {
  const interval = 240 * 60_000;
  assert.strictEqual(nextCheckDelay({ intervalMin: 240, attempt: 0, rand: () => 0.5 }), interval);
  assert.strictEqual(nextCheckDelay({ intervalMin: 240, attempt: 0, rand: () => 0 }), Math.round(interval * 0.85));
  const hi = nextCheckDelay({ intervalMin: 240, attempt: 0, rand: () => 0.999999 });
  assert.ok(hi <= interval * 1.15 && hi > interval * 1.149, String(hi));
  for (let i = 0; i < 200; i++) {
    const d = nextCheckDelay({ intervalMin: 30, attempt: 0 });
    assert.ok(d >= 30 * 60_000 * 0.85 && d <= 30 * 60_000 * 1.15, String(d));
  }
  // Неверный интервал — значение сервера по умолчанию, выход за пределы — обрезка.
  assert.strictEqual(nextCheckDelay({ intervalMin: 'x', rand: () => 0.5 }), 240 * 60_000);
  assert.strictEqual(nextCheckDelay({ intervalMin: 1, rand: () => 0.5 }), 30 * 60_000);
  assert.strictEqual(nextCheckDelay({ intervalMin: 100000, rand: () => 0.5 }), 1440 * 60_000);
});

test('после ошибок — экспоненциальная задержка, не больше 6 ч', () => {
  assert.strictEqual(MAX_BACKOFF_MS, 6 * 60 * 60_000);
  const d1 = nextCheckDelay({ intervalMin: 240, attempt: 1, rand: () => 0.5 });
  const d2 = nextCheckDelay({ intervalMin: 240, attempt: 2, rand: () => 0.5 });
  const d3 = nextCheckDelay({ intervalMin: 240, attempt: 3, rand: () => 0.5 });
  assert.ok(d1 >= 60_000, String(d1));
  assert.strictEqual(d2, d1 * 2);
  assert.strictEqual(d3, d1 * 4);
  for (const attempt of [10, 20, 50, 1000]) {
    for (const r of [0, 0.5, 0.999999]) {
      const d = nextCheckDelay({ intervalMin: 240, attempt, rand: () => r });
      assert.ok(d <= MAX_BACKOFF_MS, `${attempt}/${r}: ${d}`);
      assert.ok(d >= MAX_BACKOFF_MS * 0.85 - 1, `${attempt}/${r}: ${d}`);
    }
  }
});
