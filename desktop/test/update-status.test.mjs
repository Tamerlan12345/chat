import test from 'node:test';
import assert from 'node:assert';
import { bannerFor } from '../src/renderer/src/lib/update-status.mjs';

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

test('legacyShell — «Установите новую версию приложения» с кнопкой «Скачать», независимо от state', () => {
  const b = bannerFor(null, { legacyShell: true });
  assert.strictEqual(b.tone, 'warn');
  assert.strictEqual(b.text, 'Установите новую версию приложения');
  assert.deepStrictEqual(b.action, { kind: 'download', label: 'Скачать' });

  const b2 = bannerFor(state({ status: 'idle' }), { legacyShell: true });
  assert.deepStrictEqual(b2, b);
});
