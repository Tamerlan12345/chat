const crypto = require('node:crypto');
const { identity } = require('../db/identity');
const AuthService = require('./auth.service');
const UserService = require('./user.service');
const OrgService = require('./org.service');
const wsServer = require('../ws/server');
const config = require('../config');
const { checkRateLimit } = require('./rate-limiter');
const { normalizeIp, rateLimitIpKey } = require('./ip-access.service');

// Аудит, находка №8: анонимный knock не должен раздувать очередь без предела
// и заваливать администраторов уведомлением на каждый «стук».
const PENDING_DEVICES_MAX_PER_IP = 20;
const PENDING_DEVICES_MAX_TOTAL = 5000;
const KNOCK_BROADCAST_THROTTLE_MS = 10000;

// Длины полей, которые присылает клиент до какой-либо проверки личности —
// без предела запись в базе росла бы вместе с телом запроса.
function capLength(value, max, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const str = String(value);
  return str.length > max ? str.slice(0, max) : str;
}

class DeviceService {
  /**
   * Клиент «стучится» при запуске. Если его устройство уже связано с
   * сотрудником — получает токен, иначе встаёт в очередь на связывание.
   */
  static async knock({ device_id, device_secret, device_name, ip_address, platform, client_version }) {
    if (!device_id) {
      throw new Error('device_id обязателен для регистрации узла');
    }

    const cleanDeviceId = capLength(device_id, 128);
    const cleanDeviceName = capLength(device_name, 128, null) || 'ПК сотрудника';
    const cleanPlatform = capLength(platform, 64, null) || 'Windows';
    const cleanClientVersion = capLength(client_version, 32, null) || '1.0.0';

    const db = identity();
    const now = new Date().toISOString();
    // Адрес приходит уже разобранным (getClientIp: IPv4 внутри IPv6 снят).
    // Прежнее «всё до последнего двоеточия долой» превращало настоящий IPv6 в
    // последнюю группу («2001:db8::1» → «1»): разные машины сливались в один
    // счётчик очереди, а сопоставление с bound_ip не срабатывало вовсе
    // (аудит, раунд 4, находка Р4-17).
    const cleanIp = normalizeIp(ip_address || '127.0.0.1') || '127.0.0.1';

    const pairing = await db.get(
      `SELECT p.device_id, p.user_id, p.secret_hash, p.secret_token_version, p.secret_user_id,
              p.secret_expires_at, p.secret_auth_time,
              u.is_active, u.approval_status, u.token_version
       FROM device_pairings p
       JOIN users u ON u.id = p.user_id
       WHERE p.device_id = $1 AND p.is_active = 1`,
      [cleanDeviceId]
    );

    if (pairing) {
      await db.run(
        `UPDATE pending_devices SET last_knock_at = $1, ip_address = $2, status = 'paired', client_version = $3
         WHERE device_id = $4`,
        [now, cleanIp, cleanClientVersion, cleanDeviceId]
      );

      // Номер устройства видят администраторы, и угадать его несложно — сам по
      // себе он не пропуск. Токен выдаётся только тому, кто предъявил секрет,
      // полученный этим устройством при входе по паролю, и только пока пароль
      // с тех пор не менялся (поколение токенов то же), секрет claim'ил именно
      // текущий владелец записи (secret_user_id === user_id — иначе
      // перепривязка устройства другому сотруднику наследовала бы чужой вход,
      // аудит находка №1) и секрет ещё не истёк (находка №9).
      const secretExpired =
        pairing.secret_expires_at !== null &&
        pairing.secret_expires_at !== undefined &&
        new Date(pairing.secret_expires_at).getTime() <= Date.now();

      // secret_expires_at (DEVICE_SECRET_TTL_DAYS, по умолчанию 30 дней) и
      // SESSION_MAX_DAYS (по умолчанию тоже 30, но настраивается отдельно и
      // независимо) — два разных предела. Токен, который выдаст knock, несёт
      // auth_time = secret_auth_time, и verifyToken отклонит его сам, как
      // только secret_auth_time старше SESSION_MAX_DAYS, — даже если секрет
      // формально ещё не истёк. Без этой проверки здесь knock отвечал бы
      // 'paired' с токеном, который тут же отклонит следующий же запрос:
      // клиент получает 401 → forceLogout → перезагрузка → knock заново — вход
      // без пароля превращается в бесконечный цикл перезагрузок (находка
      // ревью №9в). Проверяется только когда secret_auth_time вообще есть —
      // для записей без него (перенесённых до этой доработки) generateToken
      // сам подставит текущее время, и ограничение здесь неприменимо.
      const sessionExpired =
        Boolean(pairing.secret_auth_time) &&
        (Math.floor(new Date(pairing.secret_auth_time).getTime() / 1000) + AuthService.sessionMaxSeconds()) * 1000 <
          Date.now();

      const trusted =
        pairing.is_active &&
        pairing.approval_status === 'approved' &&
        secretMatches(device_secret, pairing.secret_hash) &&
        Number(pairing.secret_token_version) === Number(pairing.token_version || 1) &&
        pairing.secret_user_id !== null &&
        pairing.secret_user_id !== undefined &&
        Number(pairing.secret_user_id) === Number(pairing.user_id) &&
        !secretExpired &&
        !sessionExpired;

      if (!trusted) {
        return { status: 'login_required', message: 'Войдите по паролю — устройство запомнит вход.' };
      }

      const user = await UserService.getUserById(pairing.user_id);
      // auth_time переносится из момента claim (входа по паролю), а не
      // выставляется заново на каждый вход по устройству — иначе
      // SESSION_MAX_DAYS никогда бы не наступал для клиентов, входящих по
      // секрету (находка №9). Для записей без secret_auth_time (перенесённые
      // до этой доработки) generateToken сам подставит текущее время.
      const authTime = pairing.secret_auth_time
        ? Math.floor(new Date(pairing.secret_auth_time).getTime() / 1000)
        : null;
      // Успешный «стук» — тоже подтверждение личности: адрес становится
      // знакомым, чтобы задержка входа по паролю под атакой не задевала
      // сотрудника с его обычного рабочего места (проверка раунда 4, ПР-I4).
      require('./trusted-sources.service').recordAsync(pairing.user_id, rateLimitIpKey(cleanIp));
      return {
        status: 'paired',
        auto_matched: false,
        user,
        token: AuthService.generateToken(user, { amr: 'device', authTime })
      };
    }

    // Раньше здесь же выдавался живой токен тому, чей адрес совпал с bound_ip
    // сотрудника, без единого действия администратора. За корпоративным NAT
    // это означало «кто угодно из офиса — это Иванов». Сопоставление по адресу
    // осталось только как отдельное действие администратора (autoMatchByIp).

    // Предел действует только на НОВЫЕ идентификаторы устройств: повторный
    // «стук» уже известного device_id обновляет свою же строку через
    // ON CONFLICT ниже и не должен упираться в предел вместе с настоящими
    // новыми узлами.
    const alreadyPending = await db.get('SELECT device_id FROM pending_devices WHERE device_id = $1', [
      cleanDeviceId
    ]);
    if (!alreadyPending) {
      // Только СТРОКИ СО СТАТУСОМ 'pending' считаются к пределу — иначе за
      // корпоративным NAT/прокси 20 уже привязанных компьютеров (status =
      // 'paired', пересобираемых при каждом их же «стуке» строкой выше)
      // навсегда закрывали бы очередь для любого нового устройства с того же
      // адреса, и paired-строки эту очередь никогда бы не покидали (находка
      // ревью №1).
      const [perIpCount, totalCount] = await Promise.all([
        db.get(`SELECT COUNT(*) AS c FROM pending_devices WHERE ip_address = $1 AND status = 'pending'`, [cleanIp]),
        db.get(`SELECT COUNT(*) AS c FROM pending_devices WHERE status = 'pending'`)
      ]);
      if (
        Number(perIpCount?.c || 0) >= PENDING_DEVICES_MAX_PER_IP ||
        Number(totalCount?.c || 0) >= PENDING_DEVICES_MAX_TOTAL
      ) {
        return {
          status: 'too_many_pending',
          message: 'Слишком много неподтверждённых устройств. Обратитесь к администратору.'
        };
      }
    }

    await db.run(
      `INSERT INTO pending_devices (device_id, device_name, ip_address, platform, client_version,
                                    status, first_knock_at, last_knock_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)
       ON CONFLICT (device_id) DO UPDATE SET
         ip_address = EXCLUDED.ip_address,
         device_name = COALESCE(EXCLUDED.device_name, pending_devices.device_name),
         platform = COALESCE(EXCLUDED.platform, pending_devices.platform),
         client_version = COALESCE(EXCLUDED.client_version, pending_devices.client_version),
         last_knock_at = EXCLUDED.last_knock_at,
         status = CASE WHEN pending_devices.status = 'paired' THEN 'paired' ELSE 'pending' END`,
      [cleanDeviceId, cleanDeviceName, cleanIp, cleanPlatform, cleanClientVersion, now]
    );

    // Не чаще раза в 10 секунд на IP: без предела каждый из тысяч возможных
    // «стуков» с одного адреса будил бы администраторов заново (находка №8).
    if (checkRateLimit(`knock-broadcast:${rateLimitIpKey(cleanIp)}`, { maxAttempts: 1, windowMs: KNOCK_BROADCAST_THROTTLE_MS })) {
      try {
        wsServer.broadcastToAdmins({
          type: 'device_knock_received',
          device: {
            device_id: cleanDeviceId,
            device_name: cleanDeviceName,
            ip_address: cleanIp,
            platform: cleanPlatform,
            last_knock_at: now
          }
        });
      } catch {
        /* некому слушать — не повод отказывать устройству */
      }
    }

    return {
      status: 'pending',
      device_id: cleanDeviceId,
      device_name: cleanDeviceName,
      ip_address: cleanIp,
      message: 'Узел зарегистрирован в очереди. Ожидается связывание администратором.'
    };
  }

  /**
   * Очередь устройств для админ-панели. Администратор подразделения видит
   * только те, что относятся к его сотрудникам, — иначе «контур» ничего не
   * ограничивает.
   */
  static async getPendingDevices(adminUser) {
    const db = identity();
    const scopeDeptIds =
      adminUser && adminUser.admin_scope_dept_id
        ? await OrgService.getSubtreeDepartmentIds(adminUser.admin_scope_dept_id)
        : null;

    const devices = await db.all(`
      SELECT pd.id, pd.device_id, pd.device_name, pd.ip_address, pd.platform,
             pd.client_version, pd.status, pd.first_knock_at, pd.last_knock_at,
             dp.user_id AS paired_user_id, u.full_name AS paired_user_name,
             u.username AS paired_username, u.department_id AS paired_user_dept_id
      FROM pending_devices pd
      LEFT JOIN device_pairings dp ON dp.device_id = pd.device_id AND dp.is_active = 1
      LEFT JOIN users u ON u.id = dp.user_id
      ORDER BY pd.last_knock_at DESC
    `);

    const candidates = await db.all(`
      SELECT u.id, u.username, u.full_name, u.department_id, u.bound_ip, u.extension,
             d.name AS department_name
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.is_active = 1 AND u.bound_ip IS NOT NULL
    `);

    const withSuggestions = devices.map((device) => ({
      ...device,
      suggested_user: candidates.find((u) => u.bound_ip === device.ip_address) || null
    }));

    if (!scopeDeptIds) return withSuggestions;

    return withSuggestions.filter((device) => {
      const pairedInScope =
        device.paired_user_dept_id && scopeDeptIds.includes(Number(device.paired_user_dept_id));
      const suggestedInScope =
        device.suggested_user?.department_id &&
        scopeDeptIds.includes(Number(device.suggested_user.department_id));
      return pairedInScope || suggestedInScope;
    });
  }

  static async bindDevice({ device_id, user_id, ip_address, device_name, adminUser }) {
    const db = identity();
    const now = new Date().toISOString();

    const user = await UserService.getUserById(user_id);
    if (!user) throw new Error('Сотрудник не найден');

    if (adminUser && adminUser.admin_scope_dept_id) {
      const scopeDeptIds = await OrgService.getSubtreeDepartmentIds(adminUser.admin_scope_dept_id);
      if (!user.department_id || !scopeDeptIds.includes(Number(user.department_id))) {
        throw new Error('Сотрудник вне вашего контура управления');
      }
    }

    let finalDeviceName = device_name;
    if (!finalDeviceName) {
      const pending = await db.get('SELECT device_name FROM pending_devices WHERE device_id = $1', [
        String(device_id)
      ]);
      finalDeviceName = pending?.device_name || null;
    }

    // Секрет обнуляется при КАЖДОЙ привязке, не только когда владелец
    // действительно меняется: цена лишнего обнуления — заново claim'нуть
    // секрет — намного меньше цены унаследованного чужого входа (аудит,
    // находка №1). secret_expires_at и secret_auth_time чистятся вместе с
    // ним — без хэша они не имеют смысла.
    await db.run(
      `INSERT INTO device_pairings (device_id, user_id, ip_address, device_name, paired_at, is_active)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (device_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         ip_address = COALESCE(EXCLUDED.ip_address, device_pairings.ip_address),
         device_name = COALESCE(EXCLUDED.device_name, device_pairings.device_name),
         paired_at = EXCLUDED.paired_at,
         is_active = 1,
         secret_hash = NULL,
         secret_token_version = NULL,
         secret_user_id = NULL,
         secret_expires_at = NULL,
         secret_auth_time = NULL`,
      [String(device_id), Number(user_id), ip_address || null, finalDeviceName || 'ПК сотрудника', now]
    );

    if (ip_address) {
      await db.run('UPDATE users SET bound_ip = $1 WHERE id = $2', [ip_address, Number(user_id)]);
    }

    await db.run(
      `UPDATE pending_devices SET status = 'paired', last_knock_at = $1 WHERE device_id = $2`,
      [now, String(device_id)]
    );

    // Объявляется только сам факт связывания и только администраторам.
    // Идентификатор устройства — это и есть его пропуск: следующим «стуком» с
    // ним выдаётся недельный токен сотрудника. Разошлись бы события всем —
    // любой коллега дождался бы связывания и вошёл бы под чужим именем.
    try {
      wsServer.broadcastToAdmins({ type: 'device_paired', deviceId: device_id });
    } catch {
      /* нет слушателей */
    }

    // Токен сотрудника администратору не выдаётся: иначе привязка устройства
    // была бы способом войти под любым сотрудником своего отдела.
    return { success: true, device_id, user: UserService.toPublicUser(user) };
  }

  static async autoMatchByIp(adminUser) {
    const db = identity();
    const now = new Date().toISOString();

    const scopeDeptIds =
      adminUser && adminUser.admin_scope_dept_id
        ? await OrgService.getSubtreeDepartmentIds(adminUser.admin_scope_dept_id)
        : null;

    const matches = await db.all(`
      SELECT pd.device_id, pd.ip_address, pd.device_name,
             u.id AS user_id, u.full_name, u.department_id
      FROM pending_devices pd
      JOIN users u ON pd.ip_address = u.bound_ip
      WHERE pd.status = 'pending' AND u.is_active = 1
    `);

    let count = 0;
    for (const match of matches) {
      if (scopeDeptIds && !scopeDeptIds.includes(Number(match.department_id))) continue;

      // Тот же довод, что и в bindDevice: обнулять секрет при каждой
      // привязке, а не только при смене владельца — иначе перепривязка на
      // прежнего же пользователя оставляет лазейку разбирать значение по
      // побочным эффектам.
      await db.run(
        `INSERT INTO device_pairings (device_id, user_id, ip_address, device_name, paired_at, is_active)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (device_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           paired_at = EXCLUDED.paired_at,
           is_active = 1,
           secret_hash = NULL,
           secret_token_version = NULL,
           secret_user_id = NULL,
           secret_expires_at = NULL,
           secret_auth_time = NULL`,
        [match.device_id, match.user_id, match.ip_address, match.device_name, now]
      );

      await db.run(`UPDATE pending_devices SET status = 'paired' WHERE device_id = $1`, [
        match.device_id
      ]);

      try {
        wsServer.broadcastToAdmins({ type: 'device_paired', deviceId: match.device_id });
      } catch {
        /* нет слушателей */
      }
      count++;
    }

    return { matched_count: count };
  }

  /**
   * Вход по паролю на привязанном устройстве: сотрудник доказал, кто он, и
   * устройство получает секрет для входа без пароля. Привязку делает
   * администратор; здесь она только подтверждается владельцем.
   */
  static async claimDeviceSecret({ userId, device_id, device_secret }) {
    if (!device_id || typeof device_secret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(device_secret)) {
      return { claimed: false };
    }
    const db = identity();
    const pairing = await db.get(
      'SELECT user_id FROM device_pairings WHERE device_id = $1 AND is_active = 1',
      [String(device_id)]
    );
    if (!pairing || Number(pairing.user_id) !== Number(userId)) return { claimed: false };
    const user = await db.get('SELECT token_version FROM users WHERE id = $1', [Number(userId)]);

    // secret_user_id фиксирует, КТО claim'ил секрет — knock потом сверяет его
    // с текущим владельцем записи, а не только хэш (находка №1).
    // secret_expires_at — секрет не вечен (находка №9, по умолчанию 30 дней,
    // DEVICE_SECRET_TTL_DAYS). secret_auth_time — момент этого входа по
    // паролю: его, а не время самого knock, понесёт токен по устройству,
    // иначе SESSION_MAX_DAYS не действовал бы на вход без пароля.
    const claimedAt = new Date();
    const expiresAt = new Date(claimedAt.getTime() + config.DEVICE_SECRET_TTL_DAYS * 86400000);
    await db.run(
      `UPDATE device_pairings
       SET secret_hash = $1, secret_token_version = $2, secret_user_id = $3,
           secret_expires_at = $4, secret_auth_time = $5
       WHERE device_id = $6`,
      [
        hashSecret(device_secret),
        Number(user?.token_version || 1),
        Number(userId),
        expiresAt.toISOString(),
        claimedAt.toISOString(),
        String(device_id)
      ]
    );
    return { claimed: true };
  }

  /**
   * «Выход» на клиенте: устройство больше не должно входить без пароля с этой
   * записи. В отличие от административного unbindDevice (полностью снимает
   * пару device↔user), здесь снимается только секрет — привязку к сотруднику
   * может отменить только администратор. Пара (device_id, userId) не
   * совпадает — ничего не меняется и ответ вызывающему всё равно "успех": так
   * запрос не подтверждает и не опровергает существование чужой привязки.
   */
  static async unbindSecret(device_id, userId) {
    if (!device_id) return { unbound: false };
    const result = await identity().run(
      `UPDATE device_pairings
       SET secret_hash = NULL, secret_token_version = NULL, secret_user_id = NULL,
           secret_expires_at = NULL, secret_auth_time = NULL
       WHERE device_id = $1 AND user_id = $2`,
      [String(device_id), Number(userId)]
    );
    return { unbound: Number(result?.changes || 0) > 0 };
  }

  static async getPairingOwner(device_id) {
    const row = await identity().get(
      'SELECT p.user_id, u.department_id FROM device_pairings p JOIN users u ON u.id = p.user_id WHERE p.device_id = $1',
      [String(device_id)]
    );
    return row || null;
  }

  static async unbindDevice(device_id) {
    const db = identity();
    await db.run('DELETE FROM device_pairings WHERE device_id = $1', [String(device_id)]);
    await db.run(`UPDATE pending_devices SET status = 'pending' WHERE device_id = $1`, [
      String(device_id)
    ]);

    try {
      wsServer.broadcastToAdmins({ type: 'device_unpaired', deviceId: device_id });
    } catch {
      /* нет слушателей */
    }

    return { success: true };
  }
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

// Секрет — 256 случайных бит, поэтому хватает SHA-256; сравнение — за
// постоянное время, чтобы ответ не подсказывал, сколько символов совпало.
function secretMatches(secret, storedHash) {
  if (typeof secret !== 'string' || !secret || !storedHash) return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(String(storedHash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = DeviceService;
