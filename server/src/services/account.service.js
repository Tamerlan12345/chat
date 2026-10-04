// Удаление собственной учётной записи (App Store 5.1.1(v)).
//
// Строка users обезличивается, а не удаляется: цепочка отпечатков журнала
// аудита хранит user_id, и FK SET NULL разорвал бы её. Логин становится
// «deleted~<id>» (прежний освобождается для регистрации), стираются имя,
// почта, телефон, фото, должность, адреса; пароль непроверяем, запись
// отключена и помечена approval_status='deleted' (ни REST, ни WebSocket её
// не примут). Привязки устройств, знакомые адреса и push-токены удаляются.
// Отправленные сообщения остаются; автор в них — «Удалённый сотрудник».
const { identity } = require('../db/identity');
const { getDatabase } = require('../db');
const { verifyPassword } = require('../db/identity/password');
const UserService = require('./user.service');
const PushTokens = require('../push/token-store');
const Safety = require('./safety.service');

class AccountError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    this.code = code;
  }
}

async function deleteOwnAccount(userId, password) {
  if (typeof password !== 'string' || !password) throw new AccountError(400, 'Укажите пароль');
  const db = identity();
  const row = await db.get(
    'SELECT id, password_hash, salt, is_active, approval_status FROM users WHERE id = $1',
    [Number(userId)]
  );
  if (!row) throw new AccountError(404, 'Учётная запись не найдена');
  const { ok } = await verifyPassword(password, row.password_hash, row.salt);
  if (!ok) throw new AccountError(403, 'Неверный пароль', 'INVALID_PASSWORD');

  // Последнего действующего суперадминистратора самостоятельно удалить нельзя:
  // сервер остался бы без управления.
  const user = await UserService.getUserById(userId);
  if (user?.permissions?.is_admin) {
    const admins = await db.all(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1 AND u.approval_status = 'approved' AND r.permissions_json LIKE '%"is_admin":true%'`
    );
    if (admins.every((a) => Number(a.id) === Number(userId))) {
      throw new AccountError(400, 'Нельзя удалить единственного администратора', 'LAST_ADMIN');
    }
  }

  // Сначала то, что лежит в базе переписки, потом сама запись: падение посередине
  // оставляет учётную запись целой, и удаление можно повторить.
  const chat = getDatabase();
  PushTokens.deleteForUser(Number(userId));
  chat.prepare('DELETE FROM channel_members WHERE user_id = ?').run(Number(userId));
  chat.prepare('DELETE FROM message_statuses WHERE user_id = ?').run(Number(userId));
  chat.prepare('DELETE FROM announcement_receipts WHERE user_id = ?').run(Number(userId));
  chat.prepare('DELETE FROM cancelled_client_msgs WHERE sender_id = ?').run(Number(userId));
  Safety.purgeUser(userId);

  const uid = Number(userId);
  await db.run('DELETE FROM device_pairings WHERE user_id = $1', [uid]);
  await db.run('DELETE FROM trusted_login_sources WHERE user_id = $1', [uid]);
  await db.run('DELETE FROM login_failure_log WHERE user_id = $1', [uid]);
  await db.run(
    `UPDATE users SET
       username = $2, full_name = 'Удалённый сотрудник', email = NULL, phone = NULL, job_title = NULL,
       avatar_url = NULL, custom_status = NULL, extension = NULL, bound_ip = NULL, last_login_ip = NULL,
       department_id = NULL, admin_scope_dept_id = NULL, password_hash = '!deleted', salt = NULL,
       is_active = 0, approval_status = 'deleted', status = 'offline',
       token_version = token_version + 1
     WHERE id = $1`,
    [uid, `deleted~${uid}`]
  );
  return { success: true };
}

module.exports = { AccountError, deleteOwnAccount };
