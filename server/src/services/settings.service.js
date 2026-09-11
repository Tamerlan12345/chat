const { identity, isIdentityReady } = require('../db/identity');

// Настройки сервера лежат рядом с учётными записями: среди них
// allow_registration и ip_blacklist — значения, от которых зависит, кто вообще
// попадёт внутрь. В базе переписки они оказались бы доступны произвольному
// SQL-запросу из админ-панели.
//
// В памяти держится снимок: проверка чёрного списка адресов происходит на
// КАЖДОМ запросе и на каждом рукопожатии WebSocket, до всякой авторизации, и
// делать ради неё поход в PostgreSQL нельзя — это и задержка, и готовый способ
// положить сервер потоком запросов. Снимок обновляется при любой записи и
// раз в refreshIntervalMs на случай, если настройку изменил другой экземпляр.
const REFRESH_INTERVAL_MS = 15000;

let snapshot = {};
let refreshTimer = null;
let loadedOnce = false;

class SettingsService {
  static async load() {
    if (!isIdentityReady()) return { ...snapshot };
    const rows = await identity().all('SELECT key, value FROM server_settings');
    const next = {};
    for (const row of rows) next[row.key] = row.value;
    snapshot = next;
    loadedOnce = true;
    return { ...snapshot };
  }

  /**
   * Запускает фоновое обновление снимка. Таймер unref'нут: он не должен быть
   * единственной причиной, по которой процесс не может завершиться.
   */
  static startAutoRefresh(intervalMs = REFRESH_INTERVAL_MS) {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      this.load().catch((err) => console.warn('[Settings] обновление не удалось:', err.message));
    }, intervalMs);
    refreshTimer.unref?.();
  }

  static stopAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  static async getAllSettings({ fresh = false } = {}) {
    if (fresh || !loadedOnce) await this.load();
    return { ...snapshot };
  }

  static async getSetting(key, defaultValue = null) {
    if (!loadedOnce) await this.load();
    return snapshot[key] !== undefined ? snapshot[key] : defaultValue;
  }

  /**
   * Значение из снимка, без обращения к базе. Только для мест, которые обязаны
   * отвечать синхронно, — сейчас это проверка адреса на входе.
   */
  static getSettingSync(key, defaultValue = null) {
    return snapshot[key] !== undefined ? snapshot[key] : defaultValue;
  }

  static async setSetting(key, value) {
    await identity().run(
      `INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [String(key), String(value), new Date().toISOString()]
    );
    snapshot[String(key)] = String(value);
  }

  static async updateSettings(settingsObj) {
    for (const [key, value] of Object.entries(settingsObj || {})) {
      await this.setSetting(key, value);
    }
    return this.getAllSettings({ fresh: true });
  }
}

module.exports = SettingsService;
