const { getDatabase } = require('../db');
const AuthService = require('./auth.service');
const UserService = require('./user.service');
const OrgService = require('./org.service');
const wsServer = require('../ws/server');

class DeviceService {
  /**
   * Client calls knock on launch (Zero-Touch Provisioning)
   */
  static knock({ device_id, device_name, ip_address, platform, client_version }) {
    if (!device_id) {
      throw new Error('device_id обязателен для регистрации узла');
    }

    const db = getDatabase();
    const now = new Date().toISOString();
    const cleanIp = (ip_address || '127.0.0.1').replace(/^.*:/, '');

    // 1. Check if device is already paired
    const existingPairing = db.prepare(`
      SELECT p.*, u.id as u_id, u.is_active
      FROM device_pairings p
      JOIN users u ON p.user_id = u.id
      WHERE p.device_id = ? AND p.is_active = 1
    `).get(device_id);

    if (existingPairing && existingPairing.is_active) {
      // Update last seen ip and time
      db.prepare(`
        UPDATE pending_devices 
        SET last_knock_at = ?, ip_address = ?, status = 'paired'
        WHERE device_id = ?
      `).run(now, cleanIp, device_id);

      const user = UserService.getUserById(existingPairing.user_id);
      const token = AuthService.generateToken(user);
      return {
        status: 'paired',
        auto_matched: false,
        user,
        token
      };
    }

    // Note: this used to auto-issue a live token to whoever's IP matched a
    // user's bound_ip, with no prior admin action at all — risky on a WAN box
    // behind shared corporate NAT. That branch is removed; IP-based matching
    // now only happens through the admin-triggered POST /admin/devices/auto-match
    // (autoMatchByIp below), which requires requireAdminOrScopedAdmin. See
    // docs/designs/auth-access-control-remediation.md item 3.

    // 2. Register or update in pending_devices queue
    db.prepare(`
      INSERT INTO pending_devices (device_id, device_name, ip_address, platform, client_version, status, first_knock_at, last_knock_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        ip_address = excluded.ip_address,
        device_name = COALESCE(excluded.device_name, pending_devices.device_name),
        platform = COALESCE(excluded.platform, pending_devices.platform),
        client_version = COALESCE(excluded.client_version, pending_devices.client_version),
        last_knock_at = excluded.last_knock_at,
        status = CASE WHEN pending_devices.status = 'paired' THEN 'paired' ELSE 'pending' END
    `).run(device_id, device_name || 'ПК сотрудника', cleanIp, platform || 'Windows', client_version || '1.0.0', now, now);

    // Notify admins via WebSocket
    try {
      wsServer.broadcast({
        type: 'device_knock_received',
        device: {
          device_id,
          device_name: device_name || 'ПК сотрудника',
          ip_address: cleanIp,
          platform: platform || 'Windows',
          last_knock_at: now
        }
      });
    } catch {}

    return {
      status: 'pending',
      device_id,
      device_name: device_name || 'ПК сотрудника',
      ip_address: cleanIp,
      message: 'Узел зарегистрирован в очереди. Ожидается связывание администратором.'
    };
  }

  /**
   * Get list of knocking / pending devices for Admin UI. A scoped ("Контурный")
   * admin only sees devices already paired to, or suggestible for, an employee
   * inside their own department subtree — otherwise the "scoped" boundary is
   * decorative. See docs/designs/auth-access-control-remediation.md item 14.
   */
  static getPendingDevices(adminUser) {
    const db = getDatabase();
    const scopeDeptIds = adminUser && adminUser.admin_scope_dept_id
      ? OrgService.getSubtreeDepartmentIds(adminUser.admin_scope_dept_id)
      : null;

    const devices = db.prepare(`
      SELECT pd.*, dp.user_id as paired_user_id, u.full_name as paired_user_name, u.username as paired_username,
        u.department_id as paired_user_dept_id
      FROM pending_devices pd
      LEFT JOIN device_pairings dp ON pd.device_id = dp.device_id AND dp.is_active = 1
      LEFT JOIN users u ON dp.user_id = u.id
      ORDER BY pd.last_knock_at DESC
    `).all();

    // Fetch candidate users with bound_ip for suggestion
    const allUsers = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.department_id, u.bound_ip, u.extension, d.name as department_name
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.is_active = 1
    `).all();

    const withSuggestions = devices.map(d => {
      const candidate = allUsers.find(u => u.bound_ip && u.bound_ip === d.ip_address);
      return {
        ...d,
        suggested_user: candidate || null
      };
    });

    if (!scopeDeptIds) return withSuggestions;

    return withSuggestions.filter(d => {
      const pairedInScope = d.paired_user_dept_id && scopeDeptIds.includes(d.paired_user_dept_id);
      const suggestedInScope = d.suggested_user && d.suggested_user.department_id && scopeDeptIds.includes(d.suggested_user.department_id);
      return pairedInScope || suggestedInScope;
    });
  }

  /**
   * Bind an incoming device to an employee
   */
  static bindDevice({ device_id, user_id, ip_address, device_name, adminUser }) {
    const db = getDatabase();
    const now = new Date().toISOString();

    const user = UserService.getUserById(user_id);
    if (!user) {
      throw new Error('Сотрудник не найден');
    }

    if (adminUser && adminUser.admin_scope_dept_id) {
      const scopeDeptIds = OrgService.getSubtreeDepartmentIds(adminUser.admin_scope_dept_id);
      if (!user.department_id || !scopeDeptIds.includes(user.department_id)) {
        throw new Error('Сотрудник вне вашего контура управления');
      }
    }

    let finalDeviceName = device_name;
    if (!finalDeviceName) {
      const pending = db.prepare('SELECT device_name FROM pending_devices WHERE device_id = ?').get(device_id);
      if (pending && pending.device_name) finalDeviceName = pending.device_name;
    }

    // Upsert pairing
    db.prepare(`
      INSERT INTO device_pairings (device_id, user_id, ip_address, device_name, paired_at, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(device_id) DO UPDATE SET
        user_id = excluded.user_id,
        ip_address = COALESCE(excluded.ip_address, device_pairings.ip_address),
        device_name = COALESCE(excluded.device_name, device_pairings.device_name),
        paired_at = excluded.paired_at,
        is_active = 1
    `).run(device_id, user_id, ip_address || null, finalDeviceName || 'ПК сотрудника', now);

    // Optionally update user's bound_ip if provided
    if (ip_address) {
      db.prepare('UPDATE users SET bound_ip = ? WHERE id = ?').run(ip_address, user_id);
    }

    // Update pending_devices status
    db.prepare(`
      UPDATE pending_devices 
      SET status = 'paired', last_knock_at = ?
      WHERE device_id = ?
    `).run(now, device_id);

    const token = AuthService.generateToken(user);

    // Announce the pairing WITHOUT the token or the user record. broadcast()
    // reaches every open socket, including ones that never authenticated, so
    // anything sent here is public — a token here handed any listener a valid
    // 7-day session for the paired account. The waiting device collects its
    // own token from POST /auth/knock instead.
    try {
      wsServer.broadcast({
        type: 'device_paired',
        deviceId: device_id
      });
    } catch {}

    return {
      success: true,
      device_id,
      user,
      token
    };
  }

  /**
   * Automatically match all pending devices whose IP matches an employee's bound_ip
   */
  static autoMatchByIp(adminUser) {
    const db = getDatabase();
    const now = new Date().toISOString();

    const matches = db.prepare(`
      SELECT pd.device_id, pd.ip_address, pd.device_name, u.id as user_id, u.full_name
      FROM pending_devices pd
      JOIN users u ON pd.ip_address = u.bound_ip
      WHERE pd.status = 'pending' AND u.is_active = 1
    `).all();

    let count = 0;
    for (const m of matches) {
      db.prepare(`
        INSERT INTO device_pairings (device_id, user_id, ip_address, device_name, paired_at, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(device_id) DO UPDATE SET
          user_id = excluded.user_id,
          paired_at = excluded.paired_at,
          is_active = 1
      `).run(m.device_id, m.user_id, m.ip_address, m.device_name, now);

      db.prepare(`UPDATE pending_devices SET status = 'paired' WHERE device_id = ?`).run(m.device_id);

      // No token or user record here either — see bindDevice above.
      try {
        wsServer.broadcast({
          type: 'device_paired',
          deviceId: m.device_id
        });
      } catch {}

      count++;
    }

    return { matched_count: count };
  }

  /**
   * Unbind a device
   */
  static unbindDevice(device_id) {
    const db = getDatabase();
    db.prepare('DELETE FROM device_pairings WHERE device_id = ?').run(device_id);
    db.prepare("UPDATE pending_devices SET status = 'pending' WHERE device_id = ?").run(device_id);

    try {
      wsServer.broadcast({
        type: 'device_unpaired',
        deviceId: device_id
      });
    } catch {}

    return { success: true };
  }
}

module.exports = DeviceService;
