const { getDatabase } = require('../db');

class SettingsService {
  static getAllSettings() {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM server_settings').all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  static getSetting(key, defaultValue = null) {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  }

  static setSetting(key, value) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO server_settings (key, value, updated_at) 
      VALUES (?, ?, ?) 
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), now);
  }

  static updateSettings(settingsObj) {
    for (const [k, v] of Object.entries(settingsObj)) {
      this.setSetting(k, v);
    }
    return this.getAllSettings();
  }
}

module.exports = SettingsService;
