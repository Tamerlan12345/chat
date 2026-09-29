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
 * bannerFor(state, { legacyShell, legacy }) → null | { tone, text, action, dismissible? }.
 *
 * tone — 'info' | 'warn' | 'error'.
 * action — null | { kind: 'install' | 'download' | 'check', label }.
 * dismissible — баннер можно скрыть до перезапуска приложения (только
 * необязательное обновление старой оболочки).
 *
 * legacyShell — у window.electronAPI нет getUpdateState (оболочка 1.0.0,
 * парк до автообновления): она не умеет проверять и ставить обновления сама,
 * баннер только указывает на установщик. legacy — что об этом сказал сервер
 * (legacyUpdateFromPolicy) и скрыл ли сотрудник баннер:
 * { downloadUrl, version, mandatory, dismissed }. Без ссылки баннера нет:
 * «Установите новую версию» при выключенных обновлениях или без выпуска
 * только мешало бы всему старому парку, а кнопке нечего было бы открыть.
 */
export function bannerFor(state, { legacyShell = false, legacy = null } = {}) {
  if (legacyShell) {
    if (!legacy || typeof legacy.downloadUrl !== 'string' || !legacy.downloadUrl) return null;
    const version = typeof legacy.version === 'string' ? legacy.version : '';
    if (legacy.mandatory) {
      return {
        tone: 'warn',
        text: squeeze(`Обязательное обновление ${version}: установите новую версию приложения`),
        action: { kind: 'download', label: 'Скачать' },
        dismissible: false
      };
    }
    if (legacy.dismissed) return null;
    return {
      tone: 'info',
      text: squeeze(`Установите новую версию приложения ${version}`),
      action: { kind: 'download', label: 'Скачать' },
      dismissible: true
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
    // Ссылка на скачивание есть только у видов установки, которые сами не
    // обновляются (portable, copy, nsis-machine): им ничего не «загружается» —
    // сотрудник скачивает установщик сам.
    if (status === 'available' && downloadUrl) {
      return { tone: 'info', text: squeeze(`Доступна версия ${version}`), action: { kind: 'download', label: 'Скачать' } };
    }
    const pct = typeof progress === 'number' && Number.isFinite(progress) ? progress : 0;
    return { tone: 'info', text: squeeze(`Загружается обновление ${version} (${pct}%)`), action: null };
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

// Версия и вид установки, от имени которых старая оболочка спрашивает
// policy.json. Без версии сервер не может применить minVersion (обновление
// никогда не становится обязательным), а без installId клиент попадает в
// последнюю корзину раздачи — ссылку получает только при 100 %.
export const LEGACY_SHELL_VERSION = '1.0.0';
export const LEGACY_SHELL_KIND = 'copy';

/**
 * legacyPolicyRequest(serverUrl) → { url, headers } — запрос /updates/policy.json
 * из интерфейса старой оболочки.
 */
export function legacyPolicyRequest(serverUrl) {
  return {
    url: `${String(serverUrl || '').replace(/\/+$/, '')}/updates/policy.json`,
    headers: {
      'X-MyChat-Client-Version': LEGACY_SHELL_VERSION,
      'X-MyChat-Install-Kind': LEGACY_SHELL_KIND
    }
  };
}

/**
 * legacyUpdateFromPolicy(policy, serverUrl) → null | { downloadUrl, version, mandatory }.
 *
 * Ответ /updates/policy.json → что показать старой оболочке. mandatory —
 * решение сервера (версия 1.0.0 ниже minVersion), интерфейс его не
 * пересчитывает. Выключенные обновления, нет выпуска или ссылка не с того же
 * https-источника — null.
 */
export function legacyUpdateFromPolicy(policy, serverUrl) {
  if (!policy || typeof policy !== 'object' || policy.enabled !== true) return null;
  const downloadUrl = resolveLegacyDownloadUrl(policy.setupUrl, serverUrl);
  if (!downloadUrl) return null;
  return {
    downloadUrl,
    version: typeof policy.offeredVersion === 'string' ? policy.offeredVersion : '',
    mandatory: policy.mandatory === true
  };
}

// «Скрыть до перезапуска»: sessionStorage живёт, пока открыто окно
// приложения. Хранится версия — следующий выпуск показывается снова.
// Хранилище может быть недоступно (политика, переполнение) — тогда баннер
// просто не скрывается надолго, но и не ломает страницу.
const LEGACY_DISMISS_KEY = 'mychat-legacy-update-dismissed';

export function isLegacyBannerDismissed(storage, version) {
  try {
    return Boolean(storage) && storage.getItem(LEGACY_DISMISS_KEY) === String(version || '');
  } catch {
    return false;
  }
}

export function rememberLegacyBannerDismissed(storage, version) {
  try {
    if (storage) storage.setItem(LEGACY_DISMISS_KEY, String(version || ''));
  } catch {
    // Не запомнили — баннер скрыт только до перезагрузки страницы.
  }
}
