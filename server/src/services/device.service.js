const { identity } = require('../db/identity');
const AuthService = require('./auth.service');
const UserService = require('./user.service');
const OrgService = require('./org.service');
const wsServer = require('../ws/server');

class DeviceService {
  /**
   * Клиент «стучится» при запуске. Если его устройство уже связано с
   * сотрудником — получает токен, иначе встаёт в очередь на связывание.
   */
  static async knock({ device_id, device_name, ip_address, platform, client_version }) {
    if (!device_id) {
      throw new Error('device_id обязателен для регистрации узла');
    }

    const db = identity();
    const now = new Date().toISOString();
    const cleanIp = String(ip_address || '127.0.0.1').replace(/^.*:/, '');

    const pairing = await db.get(
      `SELECT p.device_id, p.user_id, u.is_active
       FROM device_pairings p
       JOIN users u ON u.id = p.user_id
       WHERE p.device_id = $1 AND p.is_active = 1`,
      [String(device_id)]
    );

    if (pairing && pairing.is_active) {
      await db.run(
        `UPDATE pending_devices SET last_knock_at = $1, ip_address = $2, status = 'paired'
         WHERE device_id = $3`,
        [now, cleanIp, String(device_id)]
      );

      const user = await UserService.getUserById(pairing.user_id);
      return {
        status: 'paired',
        auto_matched: false,
        user,
        token: AuthService.generateToken(user)
      };
    }

    // Раньше здесь же выдавался живой токен тому, чей адрес совпал с bound_ip
    // сотрудника, без единого действия администратора. За корпоративным NAT
    // это означало «кто угодно из офиса — это Иванов». Сопоставление по адресу
    // осталось только как отдельное действие администратора (autoMatchByIp).

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
      [
        String(device_id),
        device_name || 'ПК сотрудника',
        cleanIp,
        platform || 'Windows',
        client_version || '1.0.0',
        now
      ]
    );

    try {
      wsServer.broadcastToAdmins({
        type: 'device_knock_received',
        device: {
          device_id,
          device_name: device_name || 'ПК сотрудника',
          ip_address: cleanIp,
          platform: platform || 'Windows',
          last_knock_at: now
        }
      });
    } catch {
      /* некому слушать — не повод отказывать устройству */
    }

    return {
      status: 'pending',
      device_id,
      device_name: device_name || 'ПК сотрудника',
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

    await db.run(
      `INSERT INTO device_pairings (device_id, user_id, ip_address, device_name, paired_at, is_active)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (device_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         ip_address = COALESCE(EXCLUDED.ip_address, device_pairings.ip_address),
         device_name = COALESCE(EXCLUDED.device_name, device_pairings.device_name),
         paired_at = EXCLUDED.paired_at,
         is_active = 1`,
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

    return { success: true, device_id, user, token: AuthService.generateToken(user) };
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

      await db.run(
        `INSERT INTO device_pairings (device_id, user_id, ip_address, device_name, paired_at, is_active)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (device_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           paired_at = EXCLUDED.paired_at,
           is_active = 1`,
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

module.exports = DeviceService;
