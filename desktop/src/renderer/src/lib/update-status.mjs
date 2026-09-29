// Чистые правила отображения баннера автообновления. Источник данных —
// состояние главного процесса (getUpdateState/onUpdateStatus, см.
// desktop/src/main/updater.js); здесь только перевод состояния в то, что
// показать сотруднику. Без Electron — тестируется в обычном Node.

// Коды ошибок проверки подписи (update-verify.js): установщик скачан, но не
// прошёл проверку — сам по себе он не хуже прежней версии, но ставить его
// нельзя. Сотруднику это не «нет обновлений», а «нужна ИТ-служба».
const SIGNATURE_ERROR_CODES = new Set([
  'signature-untrusted',
  'signature-foreign',
  'version-mismatch',
  'signature-unreadable',
  'signature-check-failed',
  'signature-check-timeout'
]);

function squeeze(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * bannerFor(state, { legacyShell }) → null | { tone, text, action }.
 *
 * tone — 'info' | 'warn' | 'error'.
 * action — null | { kind: 'install' | 'download' | 'check', label }.
 *
 * legacyShell — у window.electronAPI нет getUpdateState (оболочка 1.0.0,
 * парк до автообновления): она не умеет проверять и ставить обновления сама,
 * баннер только указывает на страницу загрузки.
 */
export function bannerFor(state, { legacyShell = false } = {}) {
  if (legacyShell) {
    return {
      tone: 'warn',
      text: 'Установите новую версию приложения',
      action: { kind: 'download', label: 'Скачать' }
    };
  }

  if (!state || typeof state !== 'object') return null;
  const { status, offeredVersion, progress, mandatory, error, downloadUrl } = state;
  const version = typeof offeredVersion === 'string' ? offeredVersion : '';

  if (status === 'error') {
    if (error === 'build-misconfigured') {
      return {
        tone: 'error',
        text: 'Автообновление не настроено на этом компьютере — сообщите в ИТ-службу (build-misconfigured)',
        action: null
      };
    }
    if (SIGNATURE_ERROR_CODES.has(error)) {
      return {
        tone: 'error',
        text: `Обновление не установлено: подпись установщика не прошла проверку — сообщите в ИТ-службу (${error})`,
        action: null
      };
    }
    // Сетевые и временные ошибки (network, sha512, http-5xx, policy-invalid,
    // update-failed) — обновитель сам повторит попытку с отступом,
    // сотруднику это показывать незачем.
    return null;
  }

  if (status === 'available' || status === 'downloading') {
    if (mandatory) {
      return {
        tone: 'warn',
        text: squeeze(`Обязательное обновление до ${version}`),
        action: status === 'available' && downloadUrl ? { kind: 'download', label: 'Скачать' } : null
      };
    }
    const pct = typeof progress === 'number' && Number.isFinite(progress) ? progress : 0;
    const text = squeeze(`Загружается обновление ${version} (${pct}%)`);
    if (status === 'available' && downloadUrl) {
      return { tone: 'info', text, action: { kind: 'download', label: 'Скачать' } };
    }
    return { tone: 'info', text, action: null };
  }

  if (status === 'downloaded') {
    const text = mandatory
      ? squeeze(`Обязательное обновление ${version} готово`)
      : squeeze(`Обновление ${version} готово`);
    return { tone: mandatory ? 'warn' : 'info', text, action: { kind: 'install', label: 'Перезапустить' } };
  }

  // idle, checking, disabled, unsupported — показывать нечего.
  return null;
}

/**
 * resolveLegacyDownloadUrl(setupUrl, serverUrl) → string | null.
 *
 * Оболочка 1.0.0 не умеет сама проверять и ставить обновления — у неё нет
 * openUpdateDownload() (это Задача 9, есть только начиная с 1.1.0), поэтому
 * баннер сам достраивает адрес установщика из setupUrl в /updates/policy.json.
 * Сервер отдаёт его относительным, но `new URL(x, base)` НЕ трогает уже
 * абсолютный x — без отдельной проверки происхождения страница открыла бы
 * ссылку с чужого источника как есть, если бы policy.json (или сервер между
 * клиентом и настоящим бэкендом) её подсунул. Правило то же самое, что
 * resolveDownloadUrl в desktop/src/main/update-policy.js: только https и
 * только тот же origin, что и у сервера, которому страница уже доверяет.
 */
export function resolveLegacyDownloadUrl(setupUrl, serverUrl) {
  if (typeof setupUrl !== 'string' || !setupUrl) return null;

  let origin;
  try {
    const server = new URL(String(serverUrl));
    if (server.protocol !== 'https:') return null;
    origin = server.origin;
  } catch {
    return null;
  }

  let resolved;
  try {
    resolved = new URL(setupUrl, origin + '/');
  } catch {
    return null;
  }
  return resolved.protocol === 'https:' && resolved.origin === origin ? resolved.toString() : null;
}
