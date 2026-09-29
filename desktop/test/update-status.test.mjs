import test from 'node:test';
import assert from 'node:assert';
import {
  bannerFor,
  resolveLegacyDownloadUrl,
  legacyPolicyRequest,
  legacyUpdateFromPolicy,
  isLegacyBannerDismissed,
  rememberLegacyBannerDismissed
} from '../src/renderer/src/lib/update-status.mjs';

// Задача 10 плана «безопасность раунд 3, автообновление, интерфейс»:
// bannerFor переводит состояние обновителя (desktop/src/main/updater.js) в
// то, что показать сотруднику. Здесь никакого IPC и никакого DOM — только
// правила, поэтому тесты идут в обычном Node.

const BASE = {
  status: 'idle',
  currentVersion: '1.1.0',
  offeredVersion: null,
  progress: null,
  mandatory: false,
  message: null,
  kind: 'nsis',
  error: null,
  downloadUrl: null
};

function state(patch) {
  return { ...BASE, ...patch };
}

test('idle/checking/disabled/unsupported — баннера нет', () => {
  for (const status of ['idle', 'checking', 'disabled', 'unsupported']) {
    assert.strictEqual(bannerFor(state({ status }), {}), null, status);
  }
});

test('нет состояния и не устаревшая оболочка — баннера нет', () => {
  assert.strictEqual(bannerFor(null, {}), null);
  assert.strictEqual(bannerFor(undefined, { legacyShell: false }), null);
});

test('available — текст с процентом и версией, действия нет без downloadUrl', () => {
  const b = bannerFor(state({ status: 'available', offeredVersion: '1.2.0', progress: null }), {});
  assert.strictEqual(b.tone, 'info');
  assert.match(b.text, /1\.2\.0/);
  assert.strictEqual(b.action, null);
});

test('downloading — «Загружается обновление X (N%)»', () => {
  const b = bannerFor(state({ status: 'downloading', offeredVersion: '1.2.0', progress: 42 }), {});
  assert.strictEqual(b.tone, 'info');
  assert.match(b.text, /Загружается обновление 1\.2\.0 \(42%\)/);
  assert.strictEqual(b.action, null);
});

test('available с downloadUrl — кнопка «Скачать»', () => {
  const b = bannerFor(
    state({ status: 'available', offeredVersion: '1.3.0', downloadUrl: 'https://s/updates/stable/x.exe' }),
    {}
  );
  assert.deepStrictEqual(b.action, { kind: 'download', label: 'Скачать' });
  assert.match(b.text, /1\.3\.0/);
});

test('downloaded — «Обновление X готово» и кнопка «Перезапустить»', () => {
  const b = bannerFor(state({ status: 'downloaded', offeredVersion: '1.2.0' }), {});
  assert.strictEqual(b.tone, 'info');
  assert.match(b.text, /Обновление 1\.2\.0 готово/);
  assert.deepStrictEqual(b.action, { kind: 'install', label: 'Перезапустить' });
});

test('mandatory — тон warn и текст «Обязательное обновление» (available)', () => {
  const b = bannerFor(state({ status: 'available', offeredVersion: '1.4.0', mandatory: true }), {});
  assert.strictEqual(b.tone, 'warn');
  assert.match(b.text, /Обязательное обновление/);
});

test('mandatory — тон warn и текст «Обязательное обновление» (downloading)', () => {
  const b = bannerFor(state({ status: 'downloading', offeredVersion: '1.4.0', progress: 10, mandatory: true }), {});
  assert.strictEqual(b.tone, 'warn');
  assert.match(b.text, /Обязательное обновление/);
});

test('mandatory + downloaded — тон warn, кнопка «Перезапустить» остаётся', () => {
  const b = bannerFor(state({ status: 'downloaded', offeredVersion: '1.4.0', mandatory: true }), {});
  assert.strictEqual(b.tone, 'warn');
  assert.match(b.text, /Обязательное обновление/);
  assert.deepStrictEqual(b.action, { kind: 'install', label: 'Перезапустить' });
});

test('error: build-misconfigured — тон error, текст для ИТ, без действия', () => {
  const b = bannerFor(state({ status: 'error', error: 'build-misconfigured' }), {});
  assert.strictEqual(b.tone, 'error');
  assert.match(b.text, /ИТ/);
  assert.strictEqual(b.action, null);
});

test('error: коды проверки подписи — тон error', () => {
  for (const error of [
    'signature-untrusted',
    'signature-foreign',
    'version-mismatch',
    'signature-unreadable',
    'signature-check-failed',
    'signature-check-timeout'
  ]) {
    const b = bannerFor(state({ status: 'error', error }), {});
    assert.strictEqual(b.tone, 'error', error);
    assert.match(b.text, /ИТ/, error);
  }
});

test('error: временные ошибки (сеть, sha512, http-5xx) — баннера нет', () => {
  for (const error of ['network', 'sha512', 'http-5xx', 'policy-invalid', 'update-failed']) {
    assert.strictEqual(bannerFor(state({ status: 'error', error }), {}), null, error);
  }
});

// ── Финальное ревью, п.4: notify-виды не «загружают» обновление ──────────

test('available с downloadUrl (portable/copy/nsis-machine) — «Доступна версия X», а не «Загружается (0%)»', () => {
  for (const kind of ['portable', 'copy', 'nsis-machine']) {
    const b = bannerFor(
      state({ status: 'available', kind, offeredVersion: '1.3.0', progress: null, downloadUrl: 'https://s/updates/stable/x.exe' }),
      {}
    );
    assert.strictEqual(b.tone, 'info', kind);
    assert.strictEqual(b.text, 'Доступна версия 1.3.0', kind);
    assert.doesNotMatch(b.text, /Загружается|%/, kind);
    assert.deepStrictEqual(b.action, { kind: 'download', label: 'Скачать' }, kind);
  }
});

test('available без downloadUrl (nsis, скачивание начинается) — по-прежнему «Загружается обновление X (0%)»', () => {
  const b = bannerFor(state({ status: 'available', kind: 'nsis', offeredVersion: '1.3.0' }), {});
  assert.strictEqual(b.text, 'Загружается обновление 1.3.0 (0%)');
  assert.strictEqual(b.action, null);
});

// ── Финальное ревью, п.3: оболочка 1.0.0 ─────────────────────────────────
//
// Раньше баннер «Установите новую версию» показывался на всём старом парке
// всегда — даже при UPDATES_DISABLED и без выпуска, а «Скачать» отвечало, что
// ссылки нет. Теперь баннер — только когда сервер дал ссылку.

const LEGACY_URL = 'https://chat.example.com/updates/stable/OpenMyChat-Enterprise-Setup-1.2.0.exe';

test('legacyShell без ссылки на установщик — баннера нет (ни при каком state)', () => {
  assert.strictEqual(bannerFor(null, { legacyShell: true }), null);
  assert.strictEqual(bannerFor(state({ status: 'idle' }), { legacyShell: true }), null);
  assert.strictEqual(bannerFor(null, { legacyShell: true, legacy: null }), null);
  assert.strictEqual(bannerFor(null, { legacyShell: true, legacy: { downloadUrl: null, mandatory: true } }), null);
});

test('legacyShell со ссылкой — «Установите новую версию» с кнопкой «Скачать», можно скрыть', () => {
  const b = bannerFor(null, { legacyShell: true, legacy: { downloadUrl: LEGACY_URL, version: '1.2.0', mandatory: false } });
  assert.strictEqual(b.tone, 'info');
  assert.match(b.text, /Установите новую версию приложения/);
  assert.match(b.text, /1\.2\.0/);
  assert.deepStrictEqual(b.action, { kind: 'download', label: 'Скачать' });
  assert.strictEqual(b.dismissible, true);

  const hidden = bannerFor(null, { legacyShell: true, legacy: { downloadUrl: LEGACY_URL, version: '1.2.0', mandatory: false, dismissed: true } });
  assert.strictEqual(hidden, null, 'скрытый до перезапуска баннер не возвращается');
});

test('legacyShell, обязательное обновление — тон warn, скрыть нельзя, скрытие не действует', () => {
  const b = bannerFor(null, { legacyShell: true, legacy: { downloadUrl: LEGACY_URL, version: '1.2.0', mandatory: true, dismissed: true } });
  assert.strictEqual(b.tone, 'warn');
  assert.match(b.text, /Обязательное обновление/);
  assert.deepStrictEqual(b.action, { kind: 'download', label: 'Скачать' });
  assert.strictEqual(b.dismissible, false);
});

test('legacyPolicyRequest — запрос policy.json от имени версии 1.0.0, установка «копией»', () => {
  const req = legacyPolicyRequest('https://chat.example.com');
  assert.strictEqual(req.url, 'https://chat.example.com/updates/policy.json');
  assert.deepStrictEqual(req.headers, { 'X-MyChat-Client-Version': '1.0.0', 'X-MyChat-Install-Kind': 'copy' });
});

test('legacyUpdateFromPolicy — ссылка только из того же https-источника; mandatory — решение сервера по minVersion', () => {
  const SERVER_URL = 'https://chat.example.com';
  // Сервер получил X-MyChat-Client-Version: 1.0.0 и minVersion 1.1.0 → mandatory.
  const mandatory = legacyUpdateFromPolicy({
    enabled: true,
    offeredVersion: '1.2.0',
    mandatory: true,
    minVersion: '1.1.0',
    setupUrl: '/updates/stable/OpenMyChat-Enterprise-Setup-1.2.0.exe'
  }, SERVER_URL);
  assert.deepStrictEqual(mandatory, { downloadUrl: LEGACY_URL, version: '1.2.0', mandatory: true });
  const b = bannerFor(null, { legacyShell: true, legacy: mandatory });
  assert.match(b.text, /Обязательное обновление/);

  const optional = legacyUpdateFromPolicy({ enabled: true, offeredVersion: '1.2.0', mandatory: false, minVersion: null, setupUrl: '/updates/stable/OpenMyChat-Enterprise-Setup-1.2.0.exe' }, SERVER_URL);
  assert.strictEqual(optional.mandatory, false);

  // Выключено (UPDATES_DISABLED или политика), выпуска нет, ссылка чужая — ничего.
  assert.strictEqual(legacyUpdateFromPolicy({ enabled: false, offeredVersion: null, setupUrl: null }, SERVER_URL), null);
  assert.strictEqual(legacyUpdateFromPolicy({ enabled: true, offeredVersion: null, setupUrl: null }, SERVER_URL), null);
  assert.strictEqual(legacyUpdateFromPolicy({ enabled: false, offeredVersion: '1.2.0', setupUrl: '/updates/stable/x.exe' }, SERVER_URL), null);
  assert.strictEqual(legacyUpdateFromPolicy({ enabled: true, offeredVersion: '1.2.0', setupUrl: 'https://evil.example/x.exe' }, SERVER_URL), null);
  assert.strictEqual(legacyUpdateFromPolicy(null, SERVER_URL), null);
  assert.strictEqual(legacyUpdateFromPolicy('мусор', SERVER_URL), null);
});

test('скрытие баннера оболочки 1.0.0 — в sessionStorage по версии, ошибки хранилища не мешают', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.strictEqual(isLegacyBannerDismissed(storage, '1.2.0'), false);
  rememberLegacyBannerDismissed(storage, '1.2.0');
  assert.strictEqual(isLegacyBannerDismissed(storage, '1.2.0'), true);
  assert.strictEqual(isLegacyBannerDismissed(storage, '1.3.0'), false, 'новая версия показывается снова');

  const broken = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
  assert.strictEqual(isLegacyBannerDismissed(broken, '1.2.0'), false);
  assert.doesNotThrow(() => rememberLegacyBannerDismissed(broken, '1.2.0'));
  assert.strictEqual(isLegacyBannerDismissed(null, '1.2.0'), false);
  assert.doesNotThrow(() => rememberLegacyBannerDismissed(undefined, '1.2.0'));
});

// ── resolveLegacyDownloadUrl (фикс раунда 1) ───────────────────────────────
//
// Оболочка 1.0.0 не умеет сама скачивать обновление — баннер строит ссылку
// из setupUrl в /updates/policy.json сам, а не через openUpdateDownload()
// (Задача 9, есть только начиная с 1.1.0). Сервер отдаёт setupUrl
// относительным, но `new URL(x, base)` НЕ трогает уже абсолютный x —
// достраивание в один шаг без проверки происхождения открыло бы страницу,
// присланную политикой, на чужом источнике. Правило то же самое, что
// resolveDownloadUrl в desktop/src/main/update-policy.js: тот же https,
// тот же origin, что и у сервера.

const SERVER = 'https://chat.example.com';

test('resolveLegacyDownloadUrl — относительный путь достраивается до адреса того же источника', () => {
  assert.strictEqual(
    resolveLegacyDownloadUrl('/updates/stable/OpenMyChat-Setup-1.2.0.exe', SERVER),
    'https://chat.example.com/updates/stable/OpenMyChat-Setup-1.2.0.exe'
  );
});

test('resolveLegacyDownloadUrl — абсолютный адрес того же источника (https) принимается', () => {
  assert.strictEqual(
    resolveLegacyDownloadUrl('https://chat.example.com/updates/stable/x.exe', SERVER),
    'https://chat.example.com/updates/stable/x.exe'
  );
});

test('resolveLegacyDownloadUrl — абсолютный адрес чужого источника отклоняется', () => {
  assert.strictEqual(resolveLegacyDownloadUrl('https://evil.example.com/Setup.exe', SERVER), null);
  // Поддомен — не тот же origin.
  assert.strictEqual(resolveLegacyDownloadUrl('https://sub.chat.example.com/Setup.exe', SERVER), null);
});

test('resolveLegacyDownloadUrl — http на том же хосте отклоняется', () => {
  assert.strictEqual(resolveLegacyDownloadUrl('http://chat.example.com/Setup.exe', SERVER), null);
  // Сам адрес сервера не https — тоже отказ, без исключения.
  assert.strictEqual(resolveLegacyDownloadUrl('/updates/x.exe', 'http://chat.example.com'), null);
});

test('resolveLegacyDownloadUrl — javascript: и file: отклоняются', () => {
  assert.strictEqual(resolveLegacyDownloadUrl('javascript:alert(1)', SERVER), null);
  assert.strictEqual(resolveLegacyDownloadUrl('file:///etc/passwd', SERVER), null);
});

test('resolveLegacyDownloadUrl — мусорные и пустые значения setupUrl → null', () => {
  assert.strictEqual(resolveLegacyDownloadUrl('', SERVER), null);
  assert.strictEqual(resolveLegacyDownloadUrl(null, SERVER), null);
  assert.strictEqual(resolveLegacyDownloadUrl(undefined, SERVER), null);
  assert.strictEqual(resolveLegacyDownloadUrl(42, SERVER), null);
  assert.strictEqual(resolveLegacyDownloadUrl({}, SERVER), null);
});

test('resolveLegacyDownloadUrl — неразборчивый или отсутствующий адрес сервера → null, без исключения', () => {
  assert.strictEqual(resolveLegacyDownloadUrl('/updates/x.exe', 'не адрес'), null);
  assert.strictEqual(resolveLegacyDownloadUrl('/updates/x.exe', ''), null);
  assert.strictEqual(resolveLegacyDownloadUrl('/updates/x.exe', null), null);
  assert.strictEqual(resolveLegacyDownloadUrl('/updates/x.exe', undefined), null);
});
