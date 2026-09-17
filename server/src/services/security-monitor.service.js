const fs = require('node:fs');
const path = require('node:path');
const { identity, isIdentityReady } = require('../db/identity');
const config = require('../config');

// Монитор безопасности: правила, которые смотрят на события журнала аудита и
// на состояние сервера и поднимают оповещения. Оповещение сохраняется в базе
// учётных записей (вне досягаемости SQL-консоли переписки), сразу приходит
// главным администраторам в приложение и, если включено, уходит в Telegram —
// без имён, адресов и содержимого: только что сработало и насколько серьёзно.
//
// Пороговые правила считают события в скользящем окне в памяти процесса. После
// перезапуска счёт начинается заново — это приемлемо: сами события остаются в
// журнале, а монитор нужен, чтобы заметить атаку, пока она идёт.

const WINDOW_MS = 10 * 60 * 1000;
const DEDUP_MS = 30 * 60 * 1000;

const counters = new Map(); // ключ -> массив отметок времени
const lastAlertAt = new Map(); // ключ дедупликации -> время

// Настройки, изменение которых меняет границу доверия сервиса.
const SECURITY_SETTING_KEYS = new Set([
  'allow_registration',
  'ip_blacklist',
  'remote_desktop_enabled',
  'rd_ice_servers',
  'security_alerts_telegram',
  'telegram_bot_token',
  'telegram_channel_id',
  'max_upload_size_mb'
]);

function bump(key, now = Date.now()) {
  const list = (counters.get(key) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  counters.set(key, list);
  if (counters.size > 5000) {
    for (const [k, v] of counters) {
      if (!v.length || now - v[v.length - 1] > WINDOW_MS) counters.delete(k);
    }
  }
  return list.length;
}

function shouldAlert(dedupKey, now = Date.now()) {
  const last = lastAlertAt.get(dedupKey);
  if (last && now - last < DEDUP_MS) return false;
  lastAlertAt.set(dedupKey, now);
  return true;
}

class SecurityMonitor {
  /**
   * Правила по событиям журнала. Вызывается журналом после каждой записи.
   * Собственные оповещения монитора в журнал не пишутся — иначе правило могло
   * бы срабатывать на самого себя.
   */
  static onAuditEvent({ userId, action, details, ip }) {
    const d = details || {};
    switch (action) {
      case 'login_failed': {
        const byIp = bump(`login_failed:ip:${ip}`);
        if (byIp >= 10 && shouldAlert(`login_failed:ip:${ip}`)) {
          this.raise('login_bruteforce_ip', 'high', 'Подбор пароля с одного адреса', {
            ip, attempts: byIp, windowMinutes: WINDOW_MS / 60000
          });
        }
        const name = String(d.username || '').toLowerCase();
        if (name) {
          const byUser = bump(`login_failed:user:${name}`);
          if (byUser >= 15 && shouldAlert(`login_failed:user:${name}`)) {
            this.raise('login_bruteforce_account', 'high', 'Подбор пароля к одной учётной записи', {
              username: name, attempts: byUser, windowMinutes: WINDOW_MS / 60000
            });
          }
        }
        const total = bump('login_failed:all');
        if (total >= 100 && shouldAlert('login_failed:all')) {
          this.raise('login_failures_mass', 'critical', 'Массовые неудачные входы', {
            attempts: total, windowMinutes: WINDOW_MS / 60000
          });
        }
        return;
      }
      case 'account_locked':
        if (shouldAlert(`locked:${userId}`)) {
          this.raise('account_locked', 'medium', 'Учётная запись заблокирована после неудачных входов', { userId, ip });
        }
        return;
      case 'messages_read_by_admin':
        this.raise('admin_read_messages', 'high', 'Администратор читал переписку сотрудников', {
          userId, query: d.query, rows: d.rows, ip
        });
        return;
      case 'role_permissions_changed':
        this.raise('role_permissions_changed', 'high', 'Изменены права роли', { userId, role: d.roleName, ip });
        return;
      case 'user_updated_by_admin': {
        const fields = Array.isArray(d.fields) ? d.fields : [];
        if (fields.some((f) => ['role_id', 'admin_scope_dept_id', 'is_active'].includes(f))) {
          this.raise('user_privileges_changed', 'high', 'Изменены роль, зона или активность сотрудника', {
            userId, targetUserId: d.targetUserId, fields, ip
          });
        }
        return;
      }
      case 'password_reset_by_admin':
        if (bump(`pwreset:${userId}`) >= 5 && shouldAlert(`pwreset:${userId}`)) {
          this.raise('mass_password_reset', 'high', 'Массовый сброс паролей одним администратором', { userId, ip });
        }
        return;
      case 'db_query_executed':
        this.raise('db_console_query', /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(String(d.sql || '')) ? 'medium' : 'high',
          'Выполнен запрос в SQL-консоли', { userId, sql: String(d.sql || '').slice(0, 200), ip });
        return;
      case 'db_backup_downloaded':
        this.raise('db_backup_downloaded', 'high', 'Скачана резервная копия базы', { userId, fileName: d.fileName, ip });
        return;
      case 'settings_changed': {
        const keys = (Array.isArray(d.keys) ? d.keys : []).filter((k) => SECURITY_SETTING_KEYS.has(k));
        if (keys.length) this.raise('security_settings_changed', 'high', 'Изменены настройки безопасности', { userId, keys, ip });
        return;
      }
      case 'ip_blacklist_changed':
        this.raise('ip_blacklist_changed', 'medium', 'Изменён чёрный список адресов', { userId, ip });
        return;
      case 'device_bound':
        this.raise('device_bound', 'medium', 'Устройство привязано к сотруднику', { userId, targetUserId: d.targetUserId, ip });
        return;
      case 'remote_desktop_accepted':
        if (d.accessLevel === 'full') {
          this.raise('remote_desktop_full', 'medium', 'Начат сеанс удалённого управления компьютером', {
            operatorId: d.operatorId, targetUserId: userId, sessionId: d.sessionId
          });
        }
        return;
      case 'remote_desktop_file_sent':
        this.raise('remote_desktop_file', 'medium', 'Через удалённый стол передан файл', {
          userId, sessionId: d.sessionId, fileName: d.fileName
        });
        return;
      default:
    }
  }

  // Неудачные входы через WebSocket не пишутся в журнал поштучно (их может быть
  // много), но всплеск — повод для оповещения.
  static recordWsAuthFailure(ip) {
    const count = bump(`ws_auth:${ip}`);
    if (count >= 30 && shouldAlert(`ws_auth:${ip}`)) {
      this.raise('ws_auth_bruteforce', 'medium', 'Много неудачных подключений с недействительным токеном', {
        ip, attempts: count, windowMinutes: WINDOW_MS / 60000
      });
    }
  }

  static raise(rule, severity, title, details = {}) {
    if (!isIdentityReady()) return;
    this.persistAndNotify(rule, severity, title, details).catch((err) =>
      console.error('[Security] оповещение не сохранено:', err.message)
    );
  }

  static async raiseNow(rule, severity, title, details = {}) {
    return this.persistAndNotify(rule, severity, title, details);
  }

  static async persistAndNotify(rule, severity, title, details) {
    const createdAt = new Date().toISOString();
    const result = await identity().run(
      `INSERT INTO security_alerts (rule, severity, title, details_json, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [rule, severity, title, JSON.stringify(details || {}), createdAt]
    );
    const alert = {
      id: result.rows?.[0]?.id ?? null,
      rule,
      severity,
      title,
      details: details || {},
      created_at: createdAt,
      acknowledged_at: null,
      acknowledged_by_name: null
    };
    console.warn(`[Security] ${severity.toUpperCase()} ${rule}: ${title}`);
    try {
      require('../ws/server').broadcastToAdmins({ type: 'security_alert', alert });
    } catch {
      /* нет слушателей */
    }
    this.sendTelegram(alert).catch((err) => console.warn('[Security] Telegram не доставлен:', err.message));
    return alert;
  }

  // В Telegram уходит только суть: правило, серьёзность, время. Ни имён, ни
  // адресов, ни текста запросов — чат-бот находится вне периметра компании.
  static async sendTelegram(alert) {
    const SettingsService = require('./settings.service');
    const settings = await SettingsService.getAllSettings();
    if (settings.security_alerts_telegram !== 'true') return;
    const token = settings.telegram_bot_token;
    const chatId = settings.telegram_channel_id;
    if (!token || !chatId) return;
    const severityLabel = { critical: 'КРИТИЧНО', high: 'ВЫСОКИЙ', medium: 'СРЕДНИЙ' }[alert.severity] || alert.severity;
    const text = `OpenMyChat: оповещение безопасности [${severityLabel}]\n${alert.title}\nВремя: ${alert.created_at}\nПодробности — в консоли администратора.`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  static async listAlerts({ limit = 100, onlyOpen = false } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const openFilter = onlyOpen ? 'WHERE a.acknowledged_at IS NULL' : '';
    const rows = await identity().all(
      `SELECT a.id, a.rule, a.severity, a.title, a.details_json, a.created_at, a.acknowledged_at,
              u.full_name AS acknowledged_by_name
       FROM security_alerts a
       LEFT JOIN users u ON u.id = a.acknowledged_by
       ${openFilter}
       ORDER BY a.id DESC
       LIMIT $1`,
      [capped]
    );
    return rows.map(({ details_json, ...row }) => ({ ...row, details: safeParse(details_json) }));
  }

  static async acknowledge(alertId, userId) {
    const result = await identity().run(
      `UPDATE security_alerts SET acknowledged_at = $1, acknowledged_by = $2
       WHERE id = $3 AND acknowledged_at IS NULL`,
      [new Date().toISOString(), Number(userId), Number(alertId)]
    );
    return (result.rowCount ?? result.changes ?? 0) > 0;
  }

  /**
   * Самопроверка сервера: настройки, от которых зависит защищённость. Каждая
   * проверка — ok / warn / fail с понятной рекомендацией.
   */
  static async getStatus() {
    const SettingsService = require('./settings.service');
    const AuditService = require('./audit.service');
    const settings = await SettingsService.getAllSettings({ fresh: true });
    const checks = [];
    const add = (id, title, status, detail, recommendation = null) => checks.push({ id, title, status, detail, recommendation });
    const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);

    add('jwt_secret', 'Ключ подписи токенов задан в настройках развёртывания',
      process.env.JWT_SECRET ? 'ok' : 'warn',
      process.env.JWT_SECRET ? 'JWT_SECRET задан' : 'Ключ сгенерирован и хранится в файле на диске сервера',
      process.env.JWT_SECRET ? null : 'Задайте JWT_SECRET (не короче 32 байт): потеря диска иначе выбросит всех сотрудников');

    add('audit_key', 'Отдельный ключ цепочки журнала аудита',
      process.env.AUDIT_HMAC_KEY ? 'ok' : 'warn',
      process.env.AUDIT_HMAC_KEY ? 'AUDIT_HMAC_KEY задан' : 'Ключ выводится из JWT_SECRET',
      process.env.AUDIT_HMAC_KEY ? null : 'Задайте AUDIT_HMAC_KEY: смена JWT_SECRET иначе сделает старый журнал непроверяемым');

    const allowlist = String(process.env.ALLOWED_CLIENT_IPS || '').trim();
    add('ip_allowlist', 'Доступ ограничен сетями компании',
      allowlist ? 'ok' : 'warn',
      allowlist ? 'ALLOWED_CLIENT_IPS задан' : 'Сервер принимает подключения с любого адреса',
      allowlist ? null : 'Задайте ALLOWED_CLIENT_IPS — подсети офиса, филиалов и VPN');

    const https = onRailway || String(process.env.TRUSTED_PROXY_IPS || '').trim() || process.env.HTTPS_TERMINATED === 'true';
    add('https', 'Соединение шифруется (HTTPS)',
      https ? 'ok' : 'warn',
      https ? 'HTTPS обеспечивает прокси перед сервером' : 'Сервер сам говорит только по HTTP, прокси с HTTPS не объявлен',
      https ? null : 'Поставьте перед сервером HTTPS-прокси и задайте TRUSTED_PROXY_IPS (или HTTPS_TERMINATED=true)');

    add('browser_access', 'Интерфейс не раздаётся обычным браузерам',
      process.env.ALLOW_BROWSER_ACCESS === 'true' ? 'warn' : 'ok',
      process.env.ALLOW_BROWSER_ACCESS === 'true' ? 'ALLOW_BROWSER_ACCESS=true' : 'Выключено',
      process.env.ALLOW_BROWSER_ACCESS === 'true' ? 'Выключите ALLOW_BROWSER_ACCESS, если доступ из браузера не нужен' : null);

    add('registration', 'Самостоятельная регистрация',
      settings.allow_registration === 'true' ? 'warn' : 'ok',
      settings.allow_registration === 'true' ? 'Включена — заявки подаёт любой, кто дотянулся до сервера' : 'Выключена',
      settings.allow_registration === 'true' ? 'Держите выключенной, если сервер доступен не только из сети компании' : null);

    const rdEnabled = settings.remote_desktop_enabled !== 'false';
    add('remote_desktop', 'Удалённый рабочий стол',
      rdEnabled ? 'warn' : 'ok',
      rdEnabled ? 'Включён — функция повышенного риска' : 'Отключён',
      rdEnabled ? 'Включайте только по решению ИБ и только для ролей ИТ-поддержки' : null);

    const ice = parseIce(settings.rd_ice_servers);
    const external = ice === null
      ? true
      : ice.some((server) => [].concat(server.urls).some((u) => /google\.com|twilio|stunprotocol|cloudflare/i.test(String(u))));
    add('rd_ice', 'Удалённый стол не использует внешние серверы',
      !rdEnabled || !external ? 'ok' : 'warn',
      ice === null ? 'Не настроено — используется публичный STUN Google' : external ? 'В списке есть внешние серверы' : 'Только внутренние серверы или локальная сеть',
      !rdEnabled || !external ? null : 'Укажите внутренний STUN/TURN или пустой список (только локальная сеть)');

    add('backup_encryption', 'Резервные копии шифруются',
      backupKeyValid() ? 'ok' : 'warn',
      backupKeyValid() ? 'BACKUP_ENCRYPTION_KEY задан' : 'Копии хранятся в открытом виде',
      backupKeyValid() ? null : 'Задайте BACKUP_ENCRYPTION_KEY (не короче 32 байт) и храните его отдельно от сервера');

    const latestBackup = latestBackupTime();
    const backupAgeHours = latestBackup ? (Date.now() - latestBackup) / 3600000 : null;
    const backupLimit = config.BACKUP_INTERVAL_HOURS * 1.5;
    add('backup_recent', 'Свежая резервная копия',
      backupAgeHours === null ? 'fail' : backupAgeHours <= backupLimit ? 'ok' : 'fail',
      backupAgeHours === null ? 'Резервных копий нет' : `Последняя — ${backupAgeHours.toFixed(1)} ч назад`,
      backupAgeHours !== null && backupAgeHours <= backupLimit ? null : 'Проверьте планировщик копий и место на диске');

    let chain;
    try {
      chain = await AuditService.verify();
    } catch (err) {
      chain = { ok: false, checked: 0, brokenAt: null, error: err.message };
    }
    add('audit_chain', 'Целостность журнала аудита',
      chain.ok ? 'ok' : 'fail',
      chain.ok ? `Проверено записей: ${chain.checked}` : `Цепочка нарушена${chain.brokenAt ? ` начиная с записи #${chain.brokenAt}` : ''}`,
      chain.ok ? null : 'Журнал мог быть изменён в обход приложения — сообщите в ИБ. Та же картина бывает после смены AUDIT_HMAC_KEY или JWT_SECRET: записи, подписанные прежним ключом, не проверяются');

    const leftover = path.join(config.DATA_DIR, 'pre-identity-split.db');
    add('legacy_db', 'Нет старых копий базы с паролями',
      fs.existsSync(leftover) ? 'warn' : 'ok',
      fs.existsSync(leftover) ? 'Остался файл pre-identity-split.db с хешами паролей' : 'Не найдено',
      fs.existsSync(leftover) ? 'Перенесите файл в защищённое хранилище или удалите после проверки миграции' : null);

    add('identity_store', 'Учётные записи в управляемой базе',
      config.IDENTITY_DRIVER === 'postgres' ? 'ok' : 'warn',
      config.IDENTITY_DRIVER === 'postgres' ? 'PostgreSQL' : 'SQLite-файл на диске сервера',
      config.IDENTITY_DRIVER === 'postgres' ? null : 'Для рабочей установки задайте DATABASE_URL');

    const open = await identity().get(
      `SELECT COUNT(*) AS n FROM security_alerts WHERE acknowledged_at IS NULL AND severity IN ('critical', 'high')`
    );
    const openCount = Number(open?.n || 0);
    add('open_alerts', 'Непросмотренные серьёзные оповещения',
      openCount === 0 ? 'ok' : 'fail',
      openCount === 0 ? 'Нет' : `Непросмотренных: ${openCount}`,
      openCount === 0 ? null : 'Разберите оповещения в разделе «Оповещения»');

    return { generatedAt: new Date().toISOString(), checks };
  }

  // Проверка журнала по расписанию: подделку нужно заметить, даже если в
  // консоль никто не заходит.
  static startScheduledChecks() {
    const run = async () => {
      try {
        const AuditService = require('./audit.service');
        const result = await AuditService.verify();
        if (!result.ok && shouldAlert('audit_chain_broken')) {
          await this.raiseNow('audit_chain_broken', 'critical', 'Нарушена целостность журнала аудита', {
            brokenAt: result.brokenAt, checked: result.checked
          });
        }
        const latest = latestBackupTime();
        const limitMs = config.BACKUP_INTERVAL_HOURS * 1.5 * 3600000;
        if ((!latest || Date.now() - latest > limitMs) && process.uptime() * 1000 > limitMs && shouldAlert('backup_stale')) {
          await this.raiseNow('backup_stale', 'critical', 'Нет свежей резервной копии', {
            lastBackupAt: latest ? new Date(latest).toISOString() : null
          });
        }
      } catch (err) {
        console.error('[Security] плановая проверка не удалась:', err.message);
      }
    };
    const hours = Number(process.env.SECURITY_CHECK_INTERVAL_HOURS) || 6;
    const timer = setInterval(run, hours * 3600000);
    timer.unref();
    const first = setTimeout(run, 30000);
    first.unref();
    return timer;
  }

  // Только для тестов.
  static resetState() {
    counters.clear();
    lastAlertAt.clear();
  }
}

function parseIce(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function backupKeyValid() {
  return Buffer.byteLength(String(process.env.BACKUP_ENCRYPTION_KEY || ''), 'utf8') >= 32;
}

function latestBackupTime() {
  if (!fs.existsSync(config.BACKUPS_DIR)) return null;
  let latest = null;
  for (const name of fs.readdirSync(config.BACKUPS_DIR)) {
    if (!name.startsWith('mychat-backup-')) continue;
    const mtime = fs.statSync(path.join(config.BACKUPS_DIR, name)).mtimeMs;
    if (!latest || mtime > latest) latest = mtime;
  }
  return latest;
}

function safeParse(json) {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

module.exports = SecurityMonitor;
module.exports.SECURITY_SETTING_KEYS = SECURITY_SETTING_KEYS;
