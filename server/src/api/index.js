const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const AuthService = require('../services/auth.service');
const UserService = require('../services/user.service');
const OrgService = require('../services/org.service');
const MessageService = require('../services/message.service');
const AnnouncementService = require('../services/announcement.service');
const SettingsService = require('../services/settings.service');
const DbStudioService = require('../services/db-studio.service');
const FileService = require('../services/file.service');
const FilePolicyService = require('../services/file-policy.service');
const createFilePolicyRouter = require('../files/policy-router');
const { parseRange, etagListMatches, ifRangeAllows } = require('../files/http-range');
const Images = require('../media/images');
const Thumbnails = require('../media/thumbnails');
const Avatars = require('../media/avatars');
const DeviceService = require('../services/device.service');
const OrgParserService = require('../services/org-parser.service');
const { checkRateLimit, isRateLimited, peekCount, registerFailure, resetLimit } = require('../services/rate-limiter');
const TrustedSources = require('../services/trusted-sources.service');
const { getClientIp, rateLimitIpKey } = require('../services/ip-access.service');
const LoginThrottle = require('../services/login-throttle.service');
const { canonicalUsername } = LoginThrottle;
const { getDatabase } = require('../db');
const { identity } = require('../db/identity');
const AuditService = require('../services/audit.service');
const wsServer = require('../ws/server');
const config = require('../config');

const router = express.Router();

// Аватары ссылкой (задача 20): клиенту, приславшему X-Avatar-Format: url,
// data URL фотографий в ответах заменяются адресами /api/users/<id>/avatar?v=…
// (старые ссылки — null). Остальным — прежняя форма. См. src/media/avatars.js.
router.use((req, res, next) => {
  if (Avatars.wantsAvatarUrls(req.headers)) {
    const send = res.json.bind(res);
    res.json = (body) => send(Avatars.shapeAvatars(body));
  }
  next();
});
const SecurityMonitor = require('../services/security-monitor.service');
const BackupService = require('../services/backup.service');
const PushService = require('../push/push.service');
const PushTokens = require('../push/token-store');
const Registration = require('../services/registration.service');
const Safety = require('../services/safety.service');
const Account = require('../services/account.service');

// Публичный STUN Google — прежнее поведение, пока администратор не задал свой
// список. Пустой список в настройке — только локальная сеть.
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const ICE_SCHEMES = /^(stun|stuns|turn|turns):/i;

function sanitizeIceServers(list) {
  if (!Array.isArray(list)) throw new Error('Список ICE-серверов должен быть массивом');
  if (list.length > 10) throw new Error('Не больше 10 ICE-серверов');
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Неверная запись ICE-сервера');
    const urls = [].concat(entry.urls).filter((u) => typeof u === 'string' && ICE_SCHEMES.test(u) && u.length <= 256);
    if (!urls.length) throw new Error('У ICE-сервера должен быть адрес stun:, stuns:, turn: или turns:');
    const clean = { urls: urls.length === 1 ? urls[0] : urls };
    if (entry.username !== undefined) clean.username = String(entry.username).slice(0, 128);
    if (entry.credential !== undefined) clean.credential = String(entry.credential).slice(0, 256);
    return clean;
  });
}

// Проверка значений, от которых зависит безопасность: мусор в них ломал бы
// либо защиту, либо саму функцию. update_policy и file_policy сюда же — у них отдельные,
// проверяемые маршруты (/api/admin/updates, /api/admin/file-policy), а не общий
// PUT /api/admin/settings, где список расширений никак не валидируется.
const INTERNAL_SETTING = /^(last_admin_password_reset|audit_chain_|update_policy|file_policy)/;
function publicSettings(all) {
  return Object.fromEntries(Object.entries(all || {}).filter(([key]) => !INTERNAL_SETTING.test(key)));
}

// Все ключи прав, которые где-либо проверяются в коде сервера
// (`grep permissions\. server/src`) плюс те, что заводятся у ролей чистой
// установки (server/src/db/identity/index.js, BASE_ROLES). PUT /admin/roles/:id
// раньше сохранял JSON.stringify(permissions) как есть — опечатка в ключе
// молча превращалась в бессмысленное право (аудит, находка №18).
const KNOWN_PERMISSION_KEYS = new Set([
  'is_admin', 'is_scoped_admin',
  'can_manage_users', 'can_manage_structure', 'can_manage_db',
  'can_broadcast', 'can_call', 'can_remote_control',
  'can_create_channels', 'can_upload_files'
]);

function assertKnownPermissions(permissions) {
  for (const [key, value] of Object.entries(permissions)) {
    if (!KNOWN_PERMISSION_KEYS.has(key)) {
      throw new Error(`Неизвестное право: ${key}`);
    }
    if (typeof value !== 'boolean') {
      throw new Error(`Право ${key} должно быть true или false`);
    }
  }
}

const BOOLEAN_SETTINGS = new Set(['remote_desktop_enabled', 'security_alerts_telegram', 'allow_registration']);
// Окна правки/удаления сообщений (MessageService.editMessage/deleteMessage):
// только целое число минут -1..MAX_MESSAGE_WINDOW_MINUTES. Раньше любая
// строка проходила как есть — пустое поле в админ-панели сохранялось как ''
// и на чтении Number('') === 0 означало «без ограничения», то есть пустое
// значение молча снимало защиту (находка ревью раунда 1).
const MESSAGE_WINDOW_SETTINGS = new Set(['message_edit_window_minutes', 'message_delete_window_minutes']);
const RESERVED_SETTING_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
function validateSettingsUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Не переданы настройки');
  const clean = {};
  for (const [key, value] of Object.entries(body)) {
    if (!/^[a-z0-9_]{1,64}$/.test(key)) throw new Error(`Недопустимое имя настройки: ${key}`);
    // «__proto__», «constructor», «prototype» проходят шаблон выше. Снимок
    // настроек — обычный объект: такой ключ либо молча терялся (присваивание
    // строки в __proto__ игнорируется), либо затенял встроенное свойство
    // (аудит, раунд 4, находка Р4-20).
    if (RESERVED_SETTING_NAMES.has(key)) throw new Error(`Недопустимое имя настройки: ${key}`);
    if (INTERNAL_SETTING.test(key)) throw new Error(`Настройка ${key} служебная и не меняется вручную`);
    if (BOOLEAN_SETTINGS.has(key)) {
      const normalized = String(value);
      if (normalized !== 'true' && normalized !== 'false') throw new Error(`Настройка ${key} принимает true или false`);
      clean[key] = normalized;
    } else if (MESSAGE_WINDOW_SETTINGS.has(key)) {
      if (!MessageService.isValidMessageWindowValue(value)) {
        throw new Error(
          `Настройка ${key} принимает целое число минут от -1 до ${MessageService.MAX_MESSAGE_WINDOW_MINUTES} ` +
          '(−1 — действие выключено, 0 — без ограничения)'
        );
      }
      clean[key] = String(Number(String(value).trim()));
    } else if (key === 'rd_ice_servers') {
      if (value === '' || value === null) {
        clean[key] = '[]';
      } else {
        let parsed;
        try {
          parsed = typeof value === 'string' ? JSON.parse(value) : value;
        } catch {
          throw new Error('Список ICE-серверов — неверный JSON');
        }
        clean[key] = JSON.stringify(sanitizeIceServers(parsed));
      }
    } else if (value !== null && typeof value === 'object') {
      throw new Error(`Настройка ${key} должна быть строкой`);
    } else {
      clean[key] = String(value ?? '').slice(0, 10000);
    }
  }
  return clean;
}
// Файл пишется во временную папку на диске, а не в память: двадцать
// одновременных загрузок по 100 МБ держали в памяти около 2 ГБ.
const UPLOAD_TMP_DIR = path.join(config.UPLOADS_DIR, '.incoming');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
function uploaderFor(limitBytes) {
  return multer({ dest: UPLOAD_TMP_DIR, limits: { fileSize: limitBytes, files: 1, fields: 10 } });
}

// Обработчики работают с двумя базами и почти все асинхронные. Обёртка ловит
// отказ обещания и превращает его в обычный ответ об ошибке: необработанный
// отказ в Node завершает процесс, то есть одна опечатка в запросе роняла бы
// сервер целиком.
const route = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// Текст ошибки для анонимного ответа. Проверки самого сервера бросают простой
// Error без кода — их текст и предназначен человеку («Неверный логин или
// пароль», «Логин может состоять из…»). Всё прочее — ошибки базы (у pg свой
// класс, у node:sqlite код ERR_SQLITE_*), сети (ECONNREFUSED с адресом базы),
// программные TypeError — уходило бы наружу как есть: имена ограничений,
// адреса узлов, подробности устройства сервера — любому, кто дотянулся до
// входа (аудит, раунд 4, находка Р4-13). Такие пишутся в журнал сервера, а
// наружу — общий текст.
// Коды наших собственных ошибок, чей текст предназначен человеку и может
// уйти наружу. Всё остальное с кодом — ошибки драйверов и сети.
const SAFE_ERROR_CODES = new Set(['INVALID_CREDENTIALS', 'ACCOUNT_THROTTLED', 'PASSWORD_HASH_BUSY', 'OLD_PASSWORD_INVALID']);

function publicErrorMessage(err, fallback) {
  if (err instanceof Error && err.constructor === Error && (!err.code || SAFE_ERROR_CODES.has(err.code))) {
    return err.message;
  }
  console.error('[API] внутренняя ошибка на анонимном маршруте:', err?.message || err);
  return fallback;
}

// Ограничение числа ОДНОВРЕМЕННЫХ проверок пароля (scrypt). Применяется ко
// всем путям, где проверяется пароль: вход, смена пароля (проверка раунда 4,
// I-C — «либо общий, либо честно об этом»). Задачи:
//   ПР-02 — «в полёте» попытки не считаются неудачами (офис за NAT не запирает
//           себя верными входами);
//   ПР-06/I-C — один источник не занимает всю очередь хэшей.
// Предел на адрес зависит от того, знаком ли адрес хоть одной учётной записи:
//   — незнакомому НИ ОДНОЙ (типичный атакующий) — жёстко мало
//     (LOGIN_INFLIGHT_UNFAMILIAR, 3): он не займёт очередь хэшей;
//   — знакомому хотя бы одной (адрес офиса за NAT) — щедро (LOGIN_INFLIGHT_PER_IP,
//     20), чтобы утренний вход всего офиса проходил.
// Сверх того — глобальная бронь для знакомых источников: незнакомые все вместе
// не занимают больше (очередь − бронь) мест, так что офису всегда есть место.
const { HASH_QUEUE_MAX } = require('../db/identity/password');
const FAMILIAR_RESERVE = Math.max(10, Math.floor(HASH_QUEUE_MAX * 0.25));
const UNFAMILIAR_GLOBAL_CAP = Math.max(1, HASH_QUEUE_MAX - FAMILIAR_RESERVE);
const inflightByIp = new Map(); // ipKey -> число идущих проверок пароля
let unfamiliarInflight = 0;

function inflightFor(ipKey) {
  return inflightByIp.get(ipKey) || 0;
}
function acquireHashSlot(ipKey, familiar) {
  const cap = familiar ? config.LOGIN_INFLIGHT_PER_IP : config.LOGIN_INFLIGHT_UNFAMILIAR;
  if (inflightFor(ipKey) >= cap) return false;
  // Незнакомые источники все вместе не занимают больше (очередь − бронь):
  // знакомым (офису) всегда остаётся место (I-C).
  if (!familiar && unfamiliarInflight >= UNFAMILIAR_GLOBAL_CAP) return false;
  inflightByIp.set(ipKey, inflightFor(ipKey) + 1);
  if (!familiar) unfamiliarInflight += 1;
  return true;
}
function releaseHashSlot(ipKey, familiar) {
  const left = (inflightByIp.get(ipKey) || 1) - 1;
  if (left > 0) inflightByIp.set(ipKey, left);
  else inflightByIp.delete(ipKey);
  if (!familiar && unfamiliarInflight > 0) unfamiliarInflight -= 1;
}
// Retry-After с разбросом (один раз): одинаковое точное значение позволяло
// атакующему попадать ровно в момент открытия слота (ПР-04); держим в пределах
// LOGIN_ACCOUNT_MAX_DELAY_SECONDS (M6).
function jitterSeconds(base) {
  const withJitter = base + Math.floor(Math.random() * Math.max(1, base));
  return Math.min(withJitter, config.LOGIN_ACCOUNT_MAX_DELAY_SECONDS);
}
// Retry-After для 503 «много входов»: широкий разброс 1–8 с, чтобы клиенты,
// получившие отказ одновременно, не возвращались одной пачкой (третий раунд
// проверки, мелкое).
function busyRetryAfterSeconds() {
  return 1 + Math.floor(Math.random() * 8);
}

// Маршруты, доступные сотруднику с must_change_password = 1: ровно столько,
// чтобы понять, кто он, и сменить пароль. Всё остальное отвечает 403.
// /auth/device/unbind: сотрудник с обязательной сменой пароля тоже должен
// выйти начисто. Без него секрет устройства такому сотруднику отвязать было
// нечем — запрос молча получал 403, а не ошибку сети, и оставался незамечен
// клиентом (см. handleLogout / unbindDeviceOnServer в desktop/App.jsx).
const PASSWORD_CHANGE_ALLOWLIST = new Set(['/auth/me', '/users/password', '/auth/logout', '/auth/refresh', '/auth/device/unbind']);

const requireAuth = route(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  // resolveSession проверяет не только подпись и срок, но и поколение токена:
  // выданный до смены пароля, до смены роли или до отключения сотрудника
  // перестаёт действовать сразу, а не доживает свою неделю.
  const session = await AuthService.resolveSessionDetailed(authHeader.substring(7));
  if (!session) {
    return res.status(401).json({ error: 'Недействительный или истекший токен' });
  }

  const { user } = session;
  req.user = user;
  req.tokenPayload = session.payload;
  req.rawToken = authHeader.substring(7);
  if (user.must_change_password && !PASSWORD_CHANGE_ALLOWLIST.has(req.path)) {
    return res.status(403).json({
      error: 'Требуется смена пароля перед продолжением работы',
      code: 'MUST_CHANGE_PASSWORD'
    });
  }
  next();
});

// Администратор подразделения («контурный») тоже несёт is_admin — он ведь
// администрирует. Различает их is_scoped_admin. Проверка одного лишь is_admin
// раздавала каждому такому администратору полный набор прав суперадминистратора,
// включая произвольный SQL по всей базе.
//
// role_id не используется: миграция, вставляющая роль с явным идентификатором,
// сдвигает нумерацию, и эти числа не устойчивы. Имя учётной записи — тем более:
// права должны следовать из роли.
function isSuperAdmin(user) {
  const permissions = user?.permissions || {};
  return Boolean(permissions.is_admin) && !permissions.is_scoped_admin;
}

function isScopedAdmin(user) {
  return Boolean(user?.permissions?.is_scoped_admin);
}

function requireAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Доступ запрещен: требуются права администратора' });
  }
  next();
}

function requireAdminOrScopedAdmin(req, res, next) {
  if (!isSuperAdmin(req.user) && !isScopedAdmin(req.user)) {
    return res.status(403).json({ error: 'Доступ запрещен: требуются права администратора' });
  }
  next();
}

// Администратор подразделения действует только внутри своего поддерева и не
// может раздавать административные права. Без этой проверки он правил бы
// кого угодно в компании и назначил бы себе роль суперадминистратора.
async function assertWithinAdminScope(actor, { targetUserId = null, payload = null } = {}) {
  if (isSuperAdmin(actor)) return;

  const scopeRootId = actor?.admin_scope_dept_id;
  if (!scopeRootId) {
    throw new Error('Администратору не назначено подразделение — управление пользователями недоступно');
  }
  const allowed = new Set(await OrgService.getSubtreeDepartmentIds(scopeRootId));

  if (targetUserId !== null) {
    const target = await UserService.getUserById(targetUserId);
    if (!target) throw new Error('Пользователь не найден');
    if (!allowed.has(Number(target.department_id))) {
      throw new Error('Этот сотрудник относится к другому подразделению');
    }
    // Главный администратор может числиться в отделе администратора
    // подразделения. Без этой проверки тот сбрасывал ему пароль или отключал
    // его — и становился главным сам.
    if (target.id !== actor.id && (target.permissions?.is_admin || target.permissions?.is_scoped_admin)) {
      throw new Error('Управлять администраторами может только главный администратор');
    }
  }

  if (payload) {
    // «Без подразделения» — тоже вне зоны: так администратор подразделения
    // выводил сотрудника из своего контура, а заведённый без отдела человек
    // оказывался вне чьего-либо контроля.
    const creating = targetUserId === null;
    const deptGiven = payload.department_id !== undefined;
    if ((creating && (payload.department_id === undefined || payload.department_id === null || payload.department_id === '')) ||
        (!creating && deptGiven && (payload.department_id === null || payload.department_id === ''))) {
      throw new Error('Укажите подразделение из вашей зоны ответственности');
    }
    if (deptGiven && payload.department_id !== null && payload.department_id !== '') {
      if (!allowed.has(Number(payload.department_id))) {
        throw new Error('Выбранное подразделение вне вашей зоны ответственности');
      }
    }
    // Находка №2 (дефект A): раньше проверялось только truthy-значение, и
    // {admin_scope_dept_id: null} на собственной записи проходило — так
    // администратор подразделения сам снимал с себя ограничение области, и
    // следующий его токен уже был без неё. Теперь отказывает сам факт
    // присутствия ключа в теле, при любом значении, включая null.
    if ('admin_scope_dept_id' in payload) {
      throw new Error('Назначать администраторов подразделений может только суперадминистратор');
    }
    if (payload.role_id !== undefined && payload.role_id !== null) {
      const role = await getRoleById(Number(payload.role_id));
      const grants = role ? safeParse(role.permissions_json) : {};
      if (grants.is_admin || grants.is_scoped_admin) {
        throw new Error('Назначать административные роли может только суперадминистратор');
      }
    }
  }
}

function getRoleById(roleId) {
  return identity().get('SELECT permissions_json FROM roles WHERE id = $1', [Number(roleId)]);
}

function safeParse(json) {
  if (!json) return {};
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// Считаются только «пустые» стуки — те, что не выдали токен (неизвестное
// устройство, непредъявленный/неверный секрет, очередь). Успешный стук
// привязанного устройства не расходует предел: утром весь офис за одним NAT
// переподключается разом, и это не злоупотребление (проверка раунда 4, M7).
// Секрет — 256 случайных бит, подбирать бессмысленно; предел — от засорения
// очереди устройств (плюс отдельные пределы pending_devices на IP и throttle
// рассылки администраторам). Ключ — сеть /64 (Р4-02); fail open (ПР-01).
const KNOCK_FAIL_LIMIT = { maxAttempts: 60, windowMs: 60000 };

router.post('/auth/knock', route(async (req, res) => {
  try {
    const remoteIp = getClientIp(req) || '127.0.0.1';
    const knockFailKey = `knock-fail:${rateLimitIpKey(remoteIp)}`;
    if (isRateLimited(knockFailKey, KNOCK_FAIL_LIMIT)) {
      return res.status(429).json({ error: 'Слишком много запросов. Повторите через минуту.' });
    }
    const { device_id, device_secret, device_name, platform, client_version } = req.body || {};
    const result = await DeviceService.knock({
      device_id, device_secret, device_name, ip_address: remoteIp, platform, client_version
    });
    if (result.status !== 'paired') {
      registerFailure(knockFailKey, KNOCK_FAIL_LIMIT);
    }
    if (result.status === 'too_many_pending') {
      return res.status(429).json({ error: result.message });
    }
    if (result.status === 'paired') {
      AuditService.log({ userId: result.user.id, action: 'device_login', ip: remoteIp, details: { deviceId: String(device_id) } });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: publicErrorMessage(err, 'Не удалось обработать запрос устройства') });
  }
}));

// «Выход» на клиенте: устройство больше не должно входить без пароля этим
// секретом. Снимает только секрет своей же привязки — ни существование, ни
// принадлежность чужого device_id этот маршрут не подтверждает и не меняет
// (аудит, находка №9: секрет переживал логаут, пока unbind не убирал его и
// на сервере, а не только флагом в localStorage клиента).
router.post('/auth/device/unbind', requireAuth, route(async (req, res) => {
  const { device_id } = req.body || {};
  const result = await DeviceService.unbindSecret(device_id, req.user.id);
  if (result.unbound) {
    AuditService.log({ userId: req.user.id, action: 'device_secret_unbound', ip: getClientIp(req), details: { deviceId: String(device_id) } });
  }
  // Устройство отвязано — его push-уведомления этому сотруднику тоже.
  if (typeof device_id === 'string' && device_id) PushTokens.removeForDevice({ deviceId: device_id, userId: req.user.id });
  res.json({ ok: true });
}));

// Вход по паролю на привязанном устройстве выдаёт ему секрет для следующих
// входов без пароля. Секрет придумывает клиент, сервер хранит только отпечаток.
router.post('/auth/device/claim', requireAuth, route(async (req, res) => {
  // Только сразу после входа по паролю. Иначе украденный токен позволял бы
  // привязать к устройству сотрудника свой секрет и входить без пароля.
  const payload = req.tokenPayload || {};
  const fresh = payload.amr === 'pwd' && Number.isFinite(payload.auth_time) && Date.now() / 1000 - payload.auth_time <= 300;
  if (!fresh) return res.status(403).json({ claimed: false, error: 'Требуется недавний вход по паролю' });
  const { device_id, device_secret } = req.body || {};
  const result = await DeviceService.claimDeviceSecret({ userId: req.user.id, device_id, device_secret });
  if (result.claimed) {
    AuditService.log({ userId: req.user.id, action: 'device_secret_claimed', ip: getClientIp(req), details: { deviceId: String(device_id) } });
  }
  res.json(result);
}));

// ── Push-уведомления мобильных устройств (задача 18) ──
// Устройство сообщает свой токен FCM/APNs; сервер шлёт через Google/Apple
// только идентификаторы (mobile/contracts/push.md). Токен привязан к
// сотруднику, сеансу (jti, поколение, время входа) и, если назван, устройству.
const PUSH_TOKEN_LIMIT = { maxAttempts: 30, windowMs: 60000 };
const FCM_TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/;
const APNS_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
const APP_VERSION_RE = /^[0-9A-Za-z._+-]{1,32}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function pushTokenError(res, code, error) {
  return res.status(400).json({ error, code });
}

function pushTokenRateLimited(req, res) {
  if (checkRateLimit(`push-token:${req.user.id}`, PUSH_TOKEN_LIMIT)) return false;
  res.set('Retry-After', '60');
  res.status(429).json({ error: 'Слишком много запросов. Повторите через минуту.', code: 'RATE_LIMITED' });
  return true;
}

router.post('/devices/push-token', requireAuth, route(async (req, res) => {
  if (pushTokenRateLimited(req, res)) return;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const platform = body.platform;
  if (platform !== 'ios' && platform !== 'android') return pushTokenError(res, 'INVALID_PLATFORM', 'platform — "ios" или "android"');
  const kind = body.kind === undefined ? 'alert' : body.kind;
  if (!PushTokens.KINDS.has(kind) || (platform === 'android' && kind !== 'alert')) {
    return pushTokenError(res, 'INVALID_KIND', 'kind — "alert" (или "voip" для PushKit на iOS)');
  }
  const token = body.token;
  const tokenRe = platform === 'ios' ? APNS_TOKEN_RE : FCM_TOKEN_RE;
  if (typeof token !== 'string' || !tokenRe.test(token)) return pushTokenError(res, 'INVALID_TOKEN', 'Недопустимый токен устройства');
  const environment = body.environment === undefined && platform === 'android' ? 'production' : body.environment;
  if (!PushTokens.ENVIRONMENTS.has(environment)) return pushTokenError(res, 'INVALID_ENVIRONMENT', 'environment — "sandbox" или "production"');
  const appVersion = body.app_version === undefined || body.app_version === null ? null : body.app_version;
  if (appVersion !== null && (typeof appVersion !== 'string' || !APP_VERSION_RE.test(appVersion))) {
    return pushTokenError(res, 'INVALID_APP_VERSION', 'Недопустимая версия приложения');
  }
  const deviceId = body.device_id === undefined || body.device_id === null ? null : body.device_id;
  if (deviceId !== null && (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId))) {
    return pushTokenError(res, 'INVALID_DEVICE_ID', 'Недопустимый device_id');
  }

  const payload = req.tokenPayload || {};
  const { previousUserId } = PushTokens.register({
    userId: req.user.id,
    token,
    platform,
    kind,
    environment,
    deviceId,
    appVersion,
    session: { jti: payload.jti || null, tokenVersion: Number(payload.tv || 1), authTime: payload.auth_time }
  });
  // Токен перешёл от другого сотрудника (тот же телефон, другой вход) — след
  // в журнале; сам токен в журнал не пишется.
  if (previousUserId !== null) {
    AuditService.log({ userId: req.user.id, action: 'push_token_rebound', ip: getClientIp(req), details: { previousUserId, platform, kind } });
  }
  res.json({ registered: true, push_enabled: PushService.enabled });
}));

router.delete('/devices/push-token', requireAuth, route(async (req, res) => {
  if (pushTokenRateLimited(req, res)) return;
  const token = req.body?.token;
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096) return pushTokenError(res, 'INVALID_TOKEN', 'Укажите token');
  // Чужой и несуществующий токен неразличимы: ответ один и тот же.
  res.json({ removed: PushTokens.remove(req.user.id, token) });
}));

// ── 1. AUTH ──
// Неудачи входа с одного адреса (сети /64 для IPv6): 30 за 10 минут.
const LOGIN_FAIL_LIMIT = { maxAttempts: 30, windowMs: 600000 };
// Заявок на регистрацию, ожидающих решения администратора, одновременно.
const MAX_PENDING_REGISTRATIONS = 200;

router.post('/auth/login', route(async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

    const remoteIp = getClientIp(req) || '127.0.0.1';
    const ipKey = rateLimitIpKey(remoteIp);
    // Логин в единой форме (NFKC, trim, нижний регистр) — ту же форму
    // используют задержка по паре адрес+логин и по учётной записи. Раньше здесь
    // не было trim, и « admin» с пробелом давал свежий счётчик для той же
    // учётной записи (Р4-06). Слишком длинный логин ключом не становится вовсе.
    const nameKey = canonicalUsername(username);
    if (!nameKey || nameKey.length > 256) {
      return res.status(400).json({ error: 'Неверный логин или пароль. После нескольких неудачных попыток вход временно заблокирован.' });
    }
    // Перебор по многим логинам с одного адреса: считаются ТОЛЬКО
    // подтверждённые неудачи (ниже, в catch по коду INVALID_CREDENTIALS) —
    // офис за одним NAT входит утром весь сразу верными паролями и ничего не
    // расходует (ПР-02). Предел «неудач с адреса» одновременно ограничивает,
    // сколько разных логинов один адрес успевает перебрать за окно (каждый
    // новый логин-догадка — это подтверждённая неудача), поэтому отдельного
    // счётчика «разных логинов на адрес» не нужно. Отсутствие ключа — «не
    // ограничено» (fail open, ПР-01).
    // Знаком ли адрес хотя бы одной учётной записи (адрес офиса за NAT) — от
    // этого зависят и проверка «неудач с адреса», и щедрость предела
    // одновременных проверок пароля (I-C).
    const familiar = TrustedSources.isFamiliarToAnyoneSync(ipKey);

    // Предел «неудач с адреса»: считаются ТОЛЬКО подтверждённые неудачи (ниже,
    // по коду INVALID_CREDENTIALS) — офис входит утром верными паролями и
    // ничего не тратит (ПР-02). «В полёте» попытки добавляются к проверке ТОЛЬКО
    // для незнакомого адреса (там их не больше LOGIN_INFLIGHT_UNFAMILIAR, так
    // что превышение порога ничтожно). Для знакомого адреса офиса — нет: иначе
    // десяток опечаток плюс утренняя пачка верных входов давали 429, который
    // клиент не повторяет (третий раунд проверки, d3).
    const failKey = `login-fail:${ipKey}`;
    const pending = familiar ? 0 : inflightFor(ipKey);
    if (peekCount(failKey, LOGIN_FAIL_LIMIT) + pending >= LOGIN_FAIL_LIMIT.maxAttempts) {
      return res.status(429).json({ error: 'Слишком много неудачных попыток входа с этого адреса. Повторите позже.' });
    }

    if (!acquireHashSlot(ipKey, familiar)) {
      res.set('Retry-After', String(busyRetryAfterSeconds()));
      return res.status(503).json({ error: 'Сервер сейчас обрабатывает много входов. Повторите через несколько секунд.', code: 'LOGIN_BUSY' });
    }

    try {
      let result;
      try {
        result = await AuthService.login(username, password, { ip: remoteIp });
      } catch (err) {
        if (err.code === 'ACCOUNT_THROTTLED') {
          // Retry-After уже с разбросом и в пределах потолка (throttle) — не
          // разбрасываем повторно (M6).
          res.set('Retry-After', String(err.retryAfterSeconds || 60));
          return res.status(429).json({ error: err.message, code: err.code });
        }
        if (err.code === 'PASSWORD_HASH_BUSY') {
          res.set('Retry-After', String(jitterSeconds(3)));
          return res.status(503).json({ error: err.message, code: err.code });
        }
        // Заявка (самостоятельная регистрация): пароль верен, учётная запись
        // ещё не допущена. Мобильные клиенты ветвятся по code.
        if (err.code === 'ACCOUNT_PENDING') {
          return res.status(403).json({ error: 'Заявка на рассмотрении', code: 'ACCOUNT_PENDING' });
        }
        if (err.code === 'ACCOUNT_REJECTED') {
          return res.status(403).json({ error: 'Заявка отклонена', code: 'ACCOUNT_REJECTED' });
        }
        // Подтверждённая неудача входа (неверный пароль, нет такого/отключён) —
        // только теперь она идёт в предел неудач с адреса. Отказ по «заявка
        // ещё не подтверждена» входом не является (пароль-то верный) и в
        // предел не идёт.
        if (err.code === 'INVALID_CREDENTIALS') {
          registerFailure(failKey, LOGIN_FAIL_LIMIT);
          AuditService.log({ action: 'login_failed', ip: remoteIp, details: { username: String(username).slice(0, 64) } });
        }
        throw err;
      }
      AuditService.log({
        userId: result.user.id,
        action: 'login',
        ip: remoteIp,
        details: { username: result.user.username }
      });
      res.json(result);
    } finally {
      releaseHashSlot(ipKey, familiar);
    }
  } catch (err) {
    res.status(400).json({ error: publicErrorMessage(err, 'Не удалось выполнить вход. Повторите позже.') });
  }
}));

router.post('/auth/register', route(async (req, res) => {
  try {
    const allowRegistration = (await SettingsService.getSetting('allow_registration', 'false')) === 'true';
    if (!allowRegistration) {
      // Тот же ответ, что у /auth/register/request и /verify (registration.md
      // §1.1): канонический текст reg.disabled и код для клиентов.
      return res.status(403).json({ error: Registration.REGISTRATION_DISABLED_MESSAGE, code: 'REGISTRATION_DISABLED' });
    }
    const remoteIp = getClientIp(req) || '127.0.0.1';
    if (!checkRateLimit(`register:${rateLimitIpKey(remoteIp)}`, { maxAttempts: 10, windowMs: 600000 })) {
      return res.status(429).json({ error: 'Слишком много попыток регистрации. Повторите позже.' });
    }
    // Общий потолок неразобранных заявок: предел на адрес не мешает засыпать
    // администраторов заявками с множества адресов, а каждая заявка — это
    // строка в учётных записях, рассылка администраторам и расчёт scrypt
    // (аудит, раунд 4, находка Р4-16).
    const pendingCount = await identity().get(`SELECT COUNT(*) AS n FROM users WHERE approval_status = 'pending'`);
    if (Number(pendingCount?.n || 0) >= MAX_PENDING_REGISTRATIONS) {
      return res.status(429).json({ error: 'Слишком много заявок ожидают подтверждения. Обратитесь к администратору.' });
    }

    const user = await AuthService.register(req.body);
    // Токен не выдаётся: заявка ещё не подтверждена, входить пока не с чем.
    wsServer.broadcastToAdmins({ type: 'registration_pending', username: user.username, fullName: user.full_name });
    res.status(201).json({
      pending: true,
      message: 'Заявка отправлена. Вход станет возможен после подтверждения администратором.'
    });
  } catch (err) {
    if (err?.code === 'PASSWORD_HASH_BUSY') {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: err.message, code: err.code });
    }
    res.status(400).json({ error: publicErrorMessage(err, 'Не удалось подать заявку. Повторите позже.') });
  }
}));

// ── Самостоятельная регистрация по коду из письма (контракт: mobile/contracts/registration.md) ──
function sendRegistrationError(res, err) {
  if (err instanceof Registration.RegistrationError) {
    if (err.status === 429) res.set('Retry-After', String(err.extra?.retryAfter || 600));
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    if (err.extra?.attemptsLeft !== undefined) body.attemptsLeft = err.extra.attemptsLeft;
    return res.status(err.status).json(body);
  }
  if (err?.code === 'PASSWORD_HASH_BUSY') {
    res.set('Retry-After', '5');
    return res.status(503).json({ error: err.message, code: err.code });
  }
  console.error('[Registration] внутренняя ошибка:', err?.message || err);
  return res.status(500).json({ error: 'Не удалось обработать запрос. Повторите позже.' });
}

router.post('/auth/register/request', route(async (req, res) => {
  const ip = getClientIp(req) || '127.0.0.1';
  const ipKey = rateLimitIpKey(ip);
  try {
    // Тот же предел одновременных scrypt, что и у входа: заявка считает хэш пароля.
    if (!acquireHashSlot(ipKey, false)) {
      res.set('Retry-After', String(busyRetryAfterSeconds()));
      return res.status(503).json({ error: 'Сервер сейчас занят. Повторите через несколько секунд.', code: 'BUSY' });
    }
    try {
      const result = await Registration.requestRegistration(req.body, { ip });
      res.status(202).json(result);
    } finally {
      releaseHashSlot(ipKey, false);
    }
  } catch (err) {
    sendRegistrationError(res, err);
  }
}));

router.post('/auth/register/verify', route(async (req, res) => {
  const ip = getClientIp(req) || '127.0.0.1';
  try {
    const result = await Registration.verifyRegistration(req.body, { ip });
    if (result.status === 'pending') {
      AuditService.log({ userId: result.user.id, action: 'registration_pending', ip, details: { username: result.user.username } });
      wsServer.broadcastToAdmins({ type: 'registration_pending', username: result.user.username, fullName: result.user.full_name });
      return res.status(202).json({ status: 'pending' });
    }
    AuditService.log({ userId: result.user.id, action: 'registration_auto_approved', ip, details: { username: result.user.username } });
    wsServer.broadcast({ type: 'user_created', user: UserService.toPublicUser(result.user) });
    res.status(200).json({ user: result.user, token: result.token });
  } catch (err) {
    sendRegistrationError(res, err);
  }
}));

// Продление токена, пока сотрудник работает: срок жизни токена — часы, а не
// неделя. Открытые соединения этого сотрудника переводятся на новый токен —
// старый сразу отзывается.
router.post('/auth/refresh', requireAuth, route(async (req, res) => {
  // Токен прежнего формата не превращается в новый: у него нет ни времени
  // входа, ни номера, и продление выдало бы «свежий вход по паролю».
  // Уже продлённый (идёт пауза) повторно не продлевается: иначе один украденный
  // токен размножался бы в несколько независимых.
  if (req.tokenPayload.legacy || !req.tokenPayload.jti || (await AuthService.hasRevocationRecord(req.tokenPayload.jti))) {
    return res.status(401).json({ error: 'Войдите заново' });
  }
  const token = await AuthService.refreshToken(req.user, req.tokenPayload);
  wsServer.replaceSocketToken(req.rawToken, token);
  // Токены push, зарегистрированные этим сеансом, переходят на новый токен
  // сеанса — иначе выход после продления их бы не нашёл.
  PushTokens.rebindSession(req.user.id, req.tokenPayload.jti, AuthService.verifyToken(token)?.jti);
  // Продление лишь ОБНОВЛЯЕТ уже знакомый адрес, но не заводит новый: иначе
  // украденный живой токен посадил бы в «знакомые» адрес атакующего (I-2).
  require('../services/trusted-sources.service').recordAsync(req.user.id, rateLimitIpKey(getClientIp(req)), { allowCreate: false });
  res.json({ token });
}));

// Выход отзывает именно этот токен: раньше «выйти» значило только забыть токен
// на своём компьютере, а скопированный продолжал работать неделю.
//
// Отвязка секрета устройства сделана ЧАСТЬЮ этого же запроса, а не отдельным
// вызовом клиента после него: если бы клиент сперва звал /auth/logout (токен
// отзывается — jti в чёрном списке), а потом отдельно /api/auth/device/unbind
// с тем же токеном, второй запрос отвечал бы 401 ещё до того, как дошёл бы до
// DeviceService, и секрет остался бы действующим — ровно то, что находка №9
// должна была закрыть. Здесь порядок внутри одного обработчика не важен:
// req.user уже разрешён requireAuth до какой-либо отзыва.
router.post('/auth/logout', requireAuth, route(async (req, res) => {
  await AuthService.revokeToken(req.tokenPayload);

  const { device_id } = req.body || {};
  if (device_id) {
    const unbound = await DeviceService.unbindSecret(device_id, req.user.id);
    if (unbound.unbound) {
      AuditService.log({ userId: req.user.id, action: 'device_secret_unbound', ip: getClientIp(req), details: { deviceId: String(device_id) } });
    }
  }

  // Push-уведомления этого сеанса (и названного устройства) больше не нужны:
  // вышедший сотрудник не должен получать их на этот телефон.
  PushTokens.removeForLogout({
    userId: req.user.id,
    jti: req.tokenPayload.jti || null,
    deviceId: typeof device_id === 'string' && device_id ? device_id : null
  });

  AuditService.log({ userId: req.user.id, action: 'logout', ip: getClientIp(req) });
  wsServer.disconnectSocketsWithToken(req.rawToken, 'Выход из системы');
  res.json({ success: true });
}));

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── 2. USERS ──
router.get('/users', requireAuth, route(async (req, res) => {
  res.json(await UserService.getAllUsers());
}));

// ── Аватары (задача 20) ──
// Загрузка — картинка в поле формы «file», до 5 МБ. Хранится только
// перекодированная копия (JPEG ≤256 px, без EXIF) — тем же data URL в
// users.avatar_url, что и у фото из настольного клиента, чтобы тот видел её
// как раньше.
const AVATAR_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
const AVATAR_RATE_LIMIT = { maxAttempts: 10, windowMs: 60000 };
const avatarUploader = multer({ dest: UPLOAD_TMP_DIR, limits: { fileSize: AVATAR_UPLOAD_LIMIT_BYTES, files: 1, fields: 0 } });

function acceptAvatar(req, res, next) {
  if (!checkRateLimit(`avatar:${req.user.id}`, AVATAR_RATE_LIMIT)) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Слишком часто. Повторите через минуту.', code: 'RATE_LIMITED' });
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > AVATAR_UPLOAD_LIMIT_BYTES + FORM_OVERHEAD_BYTES) {
    res.set('Connection', 'close');
    return res.status(413).json({ error: 'Фотография больше 5 МБ', code: 'IMAGE_TOO_LARGE' });
  }
  // Временный файл не переживает запрос, чем бы тот ни кончился.
  const cleanup = () => { if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {}); };
  res.on('finish', cleanup);
  res.on('close', cleanup);
  avatarUploader.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'Фотография больше 5 МБ' : 'Фотография не принята',
      code: tooLarge ? 'IMAGE_TOO_LARGE' : 'BAD_REQUEST'
    });
  });
}

router.put('/users/avatar', requireAuth, acceptAvatar, route(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Фотография не прикреплена', code: 'BAD_REQUEST' });
  let jpeg;
  try {
    jpeg = await Images.normalizeAvatar(req.file.path);
  } catch (err) {
    if (err instanceof Images.ImageError) {
      if (err.status === 503) res.set('Retry-After', String(jitterSeconds(5)));
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }
  res.json(await UserService.setAvatar(req.user.id, Images.toDataUrl(jpeg)));
}));

router.delete('/users/avatar', requireAuth, route(async (req, res) => {
  res.json(await UserService.setAvatar(req.user.id, null));
}));

// Фото коллеги видно любому вошедшему — как и в справочнике сотрудников.
// Отдаётся всегда перекодированным (квадрат 96 или 256 px), из кэша на диске.
router.get('/users/:id/avatar', requireAuth, route(async (req, res) => {
  const size = req.query.size === undefined ? 'm' : req.query.size;
  if (typeof size !== 'string' || !Object.hasOwn(Images.AVATAR_SIZES, size)) {
    return res.status(400).json({ error: 'size — s или m', code: 'BAD_REQUEST' });
  }
  const id = Number(req.params.id);
  const row = Number.isSafeInteger(id) && id > 0
    ? await identity().get('SELECT avatar_url FROM users WHERE id = $1', [id])
    : null;
  const avatar = row ? await Avatars.getAvatarFile(id, row.avatar_url, size) : null;
  if (!avatar) return res.status(404).json({ error: 'Фотографии нет', code: 'NO_AVATAR' });
  res.setHeader('ETag', avatar.etag);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (etagListMatches(req.headers['if-none-match'], avatar.etag)) return res.status(304).end();
  res.type('image/jpeg');
  res.sendFile(avatar.path, { lastModified: false, etag: false, dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400' } });
}));

router.get('/users/:id', requireAuth, route(async (req, res) => {
  const user = await UserService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  // Полная запись — себе и администратору. Коллеге — те же поля, что и в
  // общем справочнике, без адресов входа и устройства прав.
  let privileged = user.id === req.user.id || isSuperAdmin(req.user);
  if (!privileged && isScopedAdmin(req.user) && req.user.admin_scope_dept_id) {
    const allowed = new Set(await OrgService.getSubtreeDepartmentIds(req.user.admin_scope_dept_id));
    privileged = allowed.has(Number(user.department_id));
  }
  res.json(privileged ? user : UserService.toPublicUser(user));
}));

router.put('/users/profile', requireAuth, route(async (req, res) => {
  try {
    res.json(await UserService.updateProfile(req.user.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/users/password', requireAuth, route(async (req, res) => {
  try {
    if (!checkRateLimit(`pwchange:${req.user.id}`, { maxAttempts: 5, windowMs: 60000 })) {
      return res.status(429).json({ error: 'Слишком много попыток. Повторите через минуту.' });
    }
    // Смена пароля проверяет текущий пароль — то есть с действующим токеном
    // (например, украденным) по ней можно подбирать пароль: 5 попыток в
    // минуту давали 7200 в сутки, и счётчики входа об этом не знали (аудит,
    // раунд 4, находка Р4-05). Предел — на самого сотрудника (не на адрес):
    // 5 неверных текущих паролей за LOGIN_LOCKOUT_MINUTES. Задержкой по учётной
    // записи, которую снаружи раскручивает посторонний, смена НЕ гейтится —
    // иначе он бы блокировал владельцу смену пароля (проверка раунда 4, ПР-I4).
    const failKey = `pwchange-fail:${req.user.id}`;
    const failLimit = { maxAttempts: 5, windowMs: config.LOGIN_LOCKOUT_MINUTES * 60000 };
    if (isRateLimited(failKey, failLimit)) {
      res.set('Retry-After', String(jitterSeconds(30)));
      return res.status(429).json({ error: 'Слишком много неверных попыток ввести текущий пароль. Повторите позже.' });
    }
    // Суточная корзина P (не больше PASSWORD_CHANGE_DAILY_FAILURES неверных
    // текущих паролей в сутки на сотрудника) — переживает перезапуск (sec5).
    // Короткий предел выше остаётся как защита от всплеска в минуту.
    // Допуск учитывает и параллельные попытки «в полёте» (проверка sec5, п.1):
    // билет обязан вернуться в settle при любом исходе — отсюда внешний finally.
    await LoginThrottle.ensureLoaded(req.user.id, req.user.username);
    const pwAdmission = LoginThrottle.admitPasswordChange(req.user.username, { userId: req.user.id });
    if (!pwAdmission.ok) {
      res.set('Retry-After', String(Math.min(3600, Math.ceil(pwAdmission.retryAfterMs / 1000))));
      const error = pwAdmission.reason === 'pending'
        ? 'Слишком много одновременных попыток сменить пароль. Повторите через несколько секунд.'
        : 'Слишком много неверных попыток сменить пароль за сутки. Обратитесь к администратору.';
      return res.status(429).json({ error, code: 'ACCOUNT_THROTTLED' });
    }
    let pwOutcome = 'neutral';
    try {
      // Смена пароля тоже считает scrypt — тот же предел одновременных проверок
      // на адрес, что и вход (I-C, общий): один источник не занимает очередь.
      const ipKey = rateLimitIpKey(getClientIp(req));
      const familiar = TrustedSources.isFamiliarToAnyoneSync(ipKey);
      if (!acquireHashSlot(ipKey, familiar)) {
        res.set('Retry-After', String(busyRetryAfterSeconds()));
        return res.status(503).json({ error: 'Сервер сейчас обрабатывает много входов. Повторите через несколько секунд.', code: 'LOGIN_BUSY' });
      }
      const { oldPassword, newPassword } = req.body || {};
      try {
        await UserService.changePassword(req.user.id, oldPassword, newPassword);
        pwOutcome = 'success';
      } catch (err) {
        if (err.code === 'OLD_PASSWORD_INVALID') {
          pwOutcome = 'failure';
          registerFailure(failKey, failLimit);
          AuditService.log({ userId: req.user.id, action: 'password_change_failed', ip: getClientIp(req) });
        }
        if (err.code === 'PASSWORD_HASH_BUSY') {
          res.set('Retry-After', String(jitterSeconds(3)));
          return res.status(503).json({ error: err.message, code: err.code });
        }
        throw err;
      } finally {
        releaseHashSlot(ipKey, familiar);
      }
    } finally {
      LoginThrottle.settle(pwAdmission.ticket, pwOutcome);
    }
    resetLimit(failKey); // корзину P удачная смена чистит сама (settle и UserService.changePassword)
    AuditService.log({ userId: req.user.id, action: 'password_changed', ip: getClientIp(req) });
    // Старый токен отозван, но открытые соединения авторизовались им раньше.
    // Без разрыва тот, кто украл токен, продолжал бы писать от имени сотрудника.
    // Клиент переподключится уже с новым токеном из этого ответа.
    wsServer.disconnectUser(req.user.id, 'Пароль изменён — переподключение');

    // Прежний токен только что перестал действовать вместе со сменой пароля —
    // без нового клиенту пришлось бы входить заново прямо здесь.
    const refreshed = await UserService.getUserById(req.user.id);
    res.json({
      success: true,
      message: 'Пароль успешно изменен',
      token: AuthService.generateToken(refreshed, { amr: 'pwd' }),
      user: refreshed
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── ADMIN USER MANAGEMENT ──
router.get('/admin/users', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  res.json(await UserService.getAllUsers(req.user));
}));

router.post('/admin/users', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { payload: req.body });
    const newUser = await UserService.createUser(req.body);
    MessageService.addToDefaultChannels([newUser.id]);
    AuditService.log({
      userId: req.user.id,
      action: 'user_created',
      ip: getClientIp(req),
      details: { createdUserId: newUser.id, username: newUser.username }
    });
    // Начальный пароль виден только тому, кто завёл учётную запись, и только в
    // этом ответе — в рассылке его быть не должно.
    const { initial_password, ...broadcastable } = newUser;
    wsServer.broadcast({ type: 'user_created', user: UserService.toPublicUser(broadcastable) });
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.put('/admin/users/:id', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    await assertWithinAdminScope(req.user, { targetUserId: targetId, payload: req.body });
    const updated = await UserService.adminUpdateUser(targetId, req.body);
    const body = req.body || {};
    AuditService.log({
      userId: req.user.id,
      action: 'user_updated_by_admin',
      ip: getClientIp(req),
      details: { targetUserId: targetId, fields: Object.keys(body).filter((k) => k !== 'password') }
    });
    // Роль, зона или активность поменялись — права открытых соединений взяты из
    // прежней записи. Их нужно закрыть, иначе пониженный сохраняет старые права.
    if (body.role_id !== undefined || body.is_active !== undefined || body.admin_scope_dept_id !== undefined) {
      wsServer.disconnectUser(targetId, 'Права учётной записи изменены — войдите заново');
    }
    wsServer.broadcast({ type: 'user_updated', user: UserService.toPublicUser(updated) });
    res.json(UserService.hideAdminOnlyFields(updated, req.user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/admin/users/:id', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    const updated = await UserService.toggleUserActive(Number(req.params.id), false);
    AuditService.log({
      userId: req.user.id,
      action: 'user_deactivated',
      ip: getClientIp(req),
      details: { targetUserId: Number(req.params.id) }
    });
    wsServer.disconnectUser(Number(req.params.id), 'Учётная запись отключена администратором');
    wsServer.forgetPushedChats(Number(req.params.id));
    wsServer.broadcast({ type: 'user_updated', user: UserService.toPublicUser(updated) });
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/users/:id/toggle-active', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const updated = await UserService.toggleUserActive(Number(req.params.id));
    AuditService.log({ userId: req.user.id, action: updated.is_active ? 'user_activated' : 'user_deactivated', ip: getClientIp(req), details: { targetUserId: Number(req.params.id) } });
    if (!updated.is_active) {
      wsServer.disconnectUser(Number(req.params.id), 'Учётная запись отключена администратором');
      wsServer.forgetPushedChats(Number(req.params.id));
    }
    wsServer.broadcast({ type: 'user_updated', user: UserService.toPublicUser(updated) });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Администратор подразделения заводит и правит своих сотрудников — забытый
// пароль он должен уметь сбросить им сам, иначе смысла в его роли мало.
// Границы контура проверяются так же, как и в остальных операциях.
router.post('/admin/users/:id/reset-password', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    const { password } = req.body || {};
    const targetId = Number(req.params.id);
    await assertWithinAdminScope(req.user, { targetUserId: targetId });

    const { password: issued, generated } = await UserService.adminResetPassword(targetId, password || null);

    // Сброс чужого пароля выдаёт временный, который сотрудник обязан сменить.
    // Администратор, сбросивший пароль сам себе, его уже выбрал — повторное
    // требование отправляло бы его на экран смены пароля при каждом входе, а
    // тот экран закрывает как раз админ-панель, из которой флаг и снимается.
    if (targetId === req.user.id) {
      await UserService.setMustChangePassword(targetId, false);
    }

    AuditService.log({
      userId: req.user.id,
      action: 'password_reset_by_admin',
      ip: getClientIp(req),
      details: { targetUserId: targetId, generated }
    });
    wsServer.disconnectUser(targetId, 'Пароль сброшен администратором — войдите заново');

    res.json({
      success: true,
      generated,
      // Сгенерированный пароль возвращается ровно один раз — передать его
      // сотруднику больше неоткуда. Заданный администратором не возвращается.
      password: generated ? issued : undefined,
      message: generated
        ? 'Выдан временный пароль — передайте его сотруднику, при первом входе он его сменит'
        : 'Пароль успешно изменён'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── СЕРВЕРНАЯ ПАНЕЛЬ УПРАВЛЕНИЯ ──
router.get('/admin/server/overview', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const os = require('node:os');
    const netInterfaces = os.networkInterfaces();
    let lanIp = '127.0.0.1';
    for (const devName in netInterfaces) {
      for (const alias of netInterfaces[devName]) {
        if (alias.family === 'IPv4' && !alias.internal) {
          lanIp = alias.address;
          break;
        }
      }
    }

    const [dbStats, identityStats, allUsers, settings] = await Promise.all([
      Promise.resolve(DbStudioService.getDatabaseStats()),
      DbStudioService.getIdentityStats(),
      UserService.getAllUsers(),
      SettingsService.getAllSettings()
    ]);
    const onlineList = wsServer.getOnlineConnectionsList();
    const allChannels = MessageService.getChannels(req.user.id);

    res.json({
      server_name: settings.server_name || 'CentyChat Server',
      company_name: settings.company_name || 'АО "Страховая компания "Сентрас Иншуранс"',
      version: config.SERVER_VERSION,
      uptime_seconds: Math.floor(process.uptime()),
      lan_ip: lanIp,
      port: config.PORT,
      node_version: process.version,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      db_engine: `Переписка: SQLite (WAL) · Учётные записи: ${identityStats.engine}`,
      db_stats: dbStats,
      identity_stats: identityStats,
      online_count: onlineList.length,
      total_users: allUsers.length,
      total_channels: allChannels.length,
      online_connections: onlineList
    });
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}));

router.post('/admin/server/disconnect-user', requireAuth, requireAdmin, (req, res) => {
  try {
    const ok = wsServer.disconnectUser(req.body?.userId);
    res.json({ success: ok, message: ok ? 'Сессия успешно сброшена' : 'Пользователь не подключен' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── РОЛИ И ПРАВА ──
router.get('/admin/roles', requireAuth, requireAdmin, route(async (req, res) => {
  const roles = await identity().all('SELECT * FROM roles ORDER BY id ASC');
  res.json(roles.map((role) => ({ ...role, permissions: safeParse(role.permissions_json) })));
}));

// Права ролей меняет только суперадминистратор — этим правом можно выдать себе
// что угодно.
router.put('/admin/roles/:id', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { name, description, permissions } = req.body || {};
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Не переданы права роли' });
    }
    assertKnownPermissions(permissions);

    const db = identity();
    const roleId = Number(req.params.id);
    const role = await db.get('SELECT * FROM roles WHERE id = $1', [roleId]);
    if (!role) return res.status(404).json({ error: 'Роль не найдена' });

    // Защита от необратимой самоблокировки: снять признак администратора у
    // роли, кроме которой администраторов больше нет, — значит навсегда лишить
    // систему управления. Восстановить это можно было бы только правкой базы
    // напрямую, поэтому такая правка отклоняется.
    const grantsFullAdmin = Boolean(permissions.is_admin) && !permissions.is_scoped_admin;
    const current = safeParse(role.permissions_json);
    const roleHadFullAdmin = Boolean(current.is_admin) && !current.is_scoped_admin;

    if (roleHadFullAdmin && !grantsFullAdmin) {
      const remaining = await db.get(
        `SELECT COUNT(*) AS n
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.is_active = 1 AND u.role_id <> $1
           AND r.permissions_json LIKE '%"is_admin":true%'
           AND r.permissions_json NOT LIKE '%"is_scoped_admin":true%'`,
        [roleId]
      );
      if (!Number(remaining?.n || 0)) {
        return res.status(400).json({
          error: 'Нельзя снять права администратора: в системе не останется ни одного администратора'
        });
      }
    }

    const orNull = (v) => (v === undefined ? null : v);
    await db.run(
      `UPDATE roles
       SET name = COALESCE($1, name), description = COALESCE($2, description), permissions_json = $3
       WHERE id = $4`,
      [orNull(name), orNull(description), JSON.stringify(permissions), roleId]
    );

    // Права изменились — у всех, кто носит эту роль, должны обновиться и
    // выданные токены, иначе новые ограничения вступят в силу только через
    // неделю.
    await db.run('UPDATE users SET token_version = token_version + 1 WHERE role_id = $1', [roleId]);
    wsServer.disconnectUsersWithRole(roleId, 'Права вашей роли изменены администратором — войдите заново');

    AuditService.log({
      userId: req.user.id,
      action: 'role_permissions_changed',
      ip: getClientIp(req),
      details: { roleId, roleName: role.name, permissions }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── КАНАЛЫ (администрирование) ──
router.get('/admin/channels', requireAuth, requireAdmin, (req, res) => {
  try {
    const channels = getDatabase().prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS members_count,
        (SELECT COUNT(*) FROM messages WHERE conversation_type = 'channel' AND target_id = c.id) AS total_messages
      FROM channels c
      ORDER BY c.id ASC
    `).all();
    res.json(channels);
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/admin/channels', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { name, topic } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Укажите название канала' });

    const db = getDatabase();
    const now = new Date().toISOString();
    const formattedName = String(name).startsWith('#') ? String(name) : `#${name}`;
    const result = db
      .prepare('INSERT INTO channels (name, topic, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(formattedName, topic || '', 'public', req.user.id, now);
    const channelId = Number(result.lastInsertRowid);

    // Все действующие сотрудники сразу становятся участниками общего канала.
    const users = await identity().all('SELECT id FROM users WHERE is_active = 1');
    const addMember = db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    );
    for (const user of users) {
      addMember.run(channelId, user.id, user.id === req.user.id ? 'admin' : 'member', now);
    }

    const created = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    wsServer.broadcast({ type: 'channel_created', channel: created });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/admin/channels/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const channelId = Number(req.params.id);
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel) throw new Error('Канал не найден');
    if (channel.name === '#Общий' || channel.name === 'Общий') {
      throw new Error('Запрещено удалять главный корпоративный канал');
    }

    AuditService.log({ userId: req.user.id, action: 'channel_deleted', ip: getClientIp(req), details: { channelId, name: channel.name } });
    db.prepare("DELETE FROM messages WHERE conversation_type = 'channel' AND target_id = ?").run(channelId);
    db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channelId);
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    wsServer.forgetPushedChatForAll(`channel:${channelId}`);

    wsServer.broadcast({ type: 'channel_deleted', channelId });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── ИНСТРУМЕНТЫ ──
router.get('/admin/audit/messages', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const rows = await MessageService.searchAuditLogs(req.query.q || '', req.query.limit || 100);
    // Чтение чужой переписки — самое чувствительное действие в системе. Оно
    // разрешено только главному администратору и всегда оставляет след:
    // без записи в журнал результат не отдаётся.
    await AuditService.logNow({
      userId: req.user.id,
      action: 'messages_read_by_admin',
      ip: getClientIp(req),
      details: { query: String(req.query.q || '').slice(0, 200), rows: rows.length }
    });
    res.json(rows);
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}));

router.get('/admin/tools/port-test', requireAuth, requireAdmin, (req, res) => {
  const os = require('node:os');
  const tStart = Date.now();
  res.json({
    status: 'OK',
    server_port: config.PORT,
    chat_protocol: 'TCP / WebSocket RFC 6455',
    web_admin_protocol: 'HTTP/1.1 REST JSON',
    response_time_ms: Date.now() - tStart,
    network_interfaces: Object.keys(os.networkInterfaces())
  });
});

router.post('/admin/tools/vacuum', requireAuth, requireAdmin, (req, res) => {
  try {
    const stats = DbStudioService.optimizeDatabase();
    AuditService.log({ userId: req.user.id, action: 'db_vacuum', ip: getClientIp(req) });
    res.json({ success: true, message: 'Оптимизация базы переписки завершена успешно', stats });
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ── ФИЛЬТРЫ ──
router.get('/admin/filters', requireAuth, requireAdmin, route(async (req, res) => {
  const settings = await SettingsService.getAllSettings();
  res.json({
    antiflood_limit: Number(settings.antiflood_limit || 10),
    bad_words_enabled: settings.bad_words_enabled === 'true',
    bad_words_list: settings.bad_words_list || 'спам,мат,реклама',
    ip_blacklist: settings.ip_blacklist || ''
  });
}));

router.post('/admin/filters', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { antiflood_limit, bad_words_enabled, bad_words_list, ip_blacklist } = req.body || {};
    if (antiflood_limit !== undefined) await SettingsService.setSetting('antiflood_limit', antiflood_limit);
    if (bad_words_enabled !== undefined) await SettingsService.setSetting('bad_words_enabled', String(bad_words_enabled));
    if (bad_words_list !== undefined) await SettingsService.setSetting('bad_words_list', bad_words_list);
    if (ip_blacklist !== undefined) {
      await SettingsService.setSetting('ip_blacklist', ip_blacklist);
      AuditService.log({
        userId: req.user.id,
        action: 'ip_blacklist_changed',
        ip: getClientIp(req),
        details: { value: ip_blacklist }
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── НАСТРОЙКИ ──
router.get('/admin/settings', requireAuth, requireAdmin, route(async (req, res) => {
  res.json(publicSettings(await SettingsService.getAllSettings({ fresh: true })));
}));

router.put('/admin/settings', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const body = validateSettingsUpdate(req.body);
    AuditService.log({ userId: req.user.id, action: 'settings_changed', ip: getClientIp(req), details: { keys: Object.keys(body) } });
    const updated = await SettingsService.updateSettings(body);
    if (body.remote_desktop_enabled === 'false') {
      wsServer.endAllRemoteSessions('Удалённый рабочий стол отключён администратором');
    }
    res.json(publicSettings(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── ОБНОВЛЕНИЯ КЛИЕНТА ── только главный администратор (см. updates/admin-router.js)
router.use('/admin/updates', requireAuth, requireAdmin, require('../updates/admin-router'));

// ── ЦЕНТР БЕЗОПАСНОСТИ ──
// Только главный администратор: состояние защиты, оповещения, журнал.
router.get('/admin/security/status', requireAuth, requireAdmin, route(async (req, res) => {
  res.json(await SecurityMonitor.getStatus());
}));

router.get('/admin/security/alerts', requireAuth, requireAdmin, route(async (req, res) => {
  res.json(await SecurityMonitor.listAlerts({ limit: req.query.limit, onlyOpen: req.query.open === 'true' }));
}));

router.post('/admin/security/alerts/:id/ack', requireAuth, requireAdmin, route(async (req, res) => {
  const ok = await SecurityMonitor.acknowledge(Number(req.params.id), req.user.id);
  if (!ok) return res.status(404).json({ error: 'Оповещение не найдено или уже просмотрено' });
  AuditService.log({ userId: req.user.id, action: 'security_alert_acknowledged', ip: getClientIp(req), details: { alertId: Number(req.params.id) } });
  res.json({ success: true });
}));

router.get('/admin/audit/verify', requireAuth, requireAdmin, route(async (req, res) => {
  const result = await AuditService.verify();
  if (!result.ok) {
    await SecurityMonitor.raiseNow('audit_chain_broken', 'critical', 'Нарушена целостность журнала аудита', {
      brokenAt: result.brokenAt, checked: result.checked, requestedBy: req.user.id
    });
  }
  res.json(result);
}));

// Настройки удалённого стола для приложения: включён ли он и через какие
// серверы соединяться. Пустой список — только локальная сеть, без внешних
// обращений.
router.get('/settings/rd', requireAuth, route(async (req, res) => {
  const settings = await SettingsService.getAllSettings();
  let iceServers = null;
  if (settings.rd_ice_servers !== undefined && settings.rd_ice_servers !== '') {
    try {
      iceServers = sanitizeIceServers(JSON.parse(settings.rd_ice_servers));
    } catch {
      iceServers = [];
    }
  }
  res.json({
    enabled: settings.remote_desktop_enabled !== 'false',
    iceServers: iceServers === null ? DEFAULT_ICE_SERVERS : iceServers
  });
}));

router.post('/admin/telegram/test', requireAuth, requireAdmin, route(async (req, res) => {
  const { bot_token, chat_id } = req.body || {};
  if (!bot_token) {
    return res.status(400).json({ success: false, error: 'Токен Telegram бота не указан.' });
  }
  try {
    const fetchRes = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const botInfo = await fetchRes.json();
    if (!botInfo.ok) {
      return res.status(400).json({ success: false, error: botInfo.description || 'Неверный токен бота' });
    }

    if (chat_id) {
      const sendRes = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id,
          text: '🔔 *CentyChat Server*\\nТестовое оповещение успешно доставлено!',
          parse_mode: 'Markdown'
        })
      });
      const sendData = await sendRes.json();
      if (!sendData.ok) {
        return res.json({
          success: true,
          bot: botInfo.result,
          warning: `Бот @${botInfo.result.username} активен, но отправка в Chat ID не удалась: ${sendData.description}`
        });
      }
    }

    res.json({
      success: true,
      bot: botInfo.result,
      message: `Бот @${botInfo.result.username} успешно проверен и готов к работе!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `Ошибка связи с api.telegram.org: ${err.message}` });
  }
}));

router.get('/admin/licenses', requireAuth, requireAdmin, route(async (req, res) => {
  const [settings, users] = await Promise.all([
    SettingsService.getAllSettings(),
    UserService.getAllUsers()
  ]);
  res.json({
    product_name: 'CentyChat Server',
    license_type: 'Корпоративная неограниченная (Enterprise LAN/WAN)',
    license_owner: settings.company_name || 'АО "Страховая компания "Сентрас Иншуранс"',
    license_key: 'MC7-ENT-CENTR-2025-9981-A4F2',
    max_online_users: 'Без ограничений',
    current_active_users: users.length,
    support_expiration: 'Бессрочная лицензия',
    registered_at: '2025-01-01'
  });
}));

// ── 3. ОРГСТРУКТУРА ──
router.get('/org/tree', requireAuth, route(async (req, res) => {
  // Контур сужает дерево только администратору подразделения. Поле
  // admin_scope_dept_id можно проставить и рядовому сотруднику — и его
  // «Контакты» молча сжимались до одного отдела.
  const scope = isScopedAdmin(req.user) ? req.user.admin_scope_dept_id : null;
  res.json(await OrgService.getOrganizationTree(scope));
}));

router.post('/org/departments', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.status(201).json(await OrgService.createDepartment(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.put('/org/departments/:id', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json(await OrgService.updateDepartment(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/org/departments/:id', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    await OrgService.deleteDepartment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/org/move-user', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const { userId, departmentId } = req.body || {};
    await OrgService.moveUser(userId, departmentId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── 4. КАНАЛЫ И ПЕРЕПИСКА ──
router.get('/channels', requireAuth, (req, res) => {
  res.json(MessageService.getChannels(req.user.id));
});

router.get('/conversations/direct', requireAuth, route(async (req, res) => {
  res.json(await MessageService.getDirectConversations(req.user.id));
}));

// afterId — необязательный, но если передан, то только неотрицательное целое:
// молча превращать «abc» в «с начала» значило бы отдать клиенту всю переписку
// вместо ошибки в его коде.
function parseAfterId(raw) {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) return { ok: false };
  return { ok: true, value: Number(raw) };
}

const AFTER_ID_ERROR = 'afterId — неотрицательное целое (id последнего известного сообщения)';

// Отказ отправки — всегда с машинным code (G3): 409 — ключ занят другой
// перепиской (CLIENT_MSG_ID_CONFLICT) или отозван автором (CANCELLED), 403 —
// не участник канала, 400 — прочие отказы проверок. Внутренний сбой (база,
// сеть) — 503 INTERNAL_ERROR без подробностей: временный, повтор тем же
// client_msg_id безопасен.
function sendErrorResponse(res, err) {
  const { code, retryable, message } = MessageService.describeError(err);
  if (retryable) return res.status(503).json({ error: message, code });
  if (code === 'NOT_CHANNEL_MEMBER' || code === 'DM_NOT_ALLOWED') return res.status(403).json({ error: message, code });
  if (code === 'CLIENT_MSG_ID_CONFLICT' || code === 'CANCELLED') return res.status(409).json({ error: message, code });
  return res.status(400).json({ error: message, code });
}

router.get('/messages', requireAuth, route(async (req, res) => {
  try {
    const { conversationType, targetId, limit, beforeId } = req.query;
    if (!conversationType || !targetId) {
      return res.status(400).json({ error: 'Укажите conversationType и targetId' });
    }
    const after = parseAfterId(req.query.afterId);
    if (!after.ok) return res.status(400).json({ error: AFTER_ID_ERROR });
    res.json(await MessageService.getMessages(
      conversationType,
      Number(targetId),
      req.user.id,
      limit ? parseInt(limit, 10) : 50,
      beforeId ? parseInt(beforeId, 10) : null,
      after.value
    ));
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
}));

router.get('/messages/direct/:targetId', requireAuth, route(async (req, res) => {
  const after = parseAfterId(req.query.afterId);
  if (!after.ok) return res.status(400).json({ error: AFTER_ID_ERROR });
  res.json(await MessageService.getMessages(
    'direct',
    Number(req.params.targetId),
    req.user.id,
    req.query.limit ? parseInt(req.query.limit, 10) : 50,
    req.query.beforeId ? parseInt(req.query.beforeId, 10) : null,
    after.value
  ));
}));

// REST-отправка: 201 — сообщение создано; 200 — повтор с тем же client_msg_id,
// в ответе уже сохранённая запись. Рассылка — та же, что у WS (publishNewMessage):
// включая «доставлено», если получатель на связи.
async function sendViaRest(req, res, conversationType) {
  try {
    const { text, type, reply_to_id, metadata, client_msg_id } = req.body || {};
    const { message, duplicate } = await MessageService.sendMessageIdempotent({
      conversationType,
      targetId: Number(req.params.targetId),
      senderId: req.user.id,
      text,
      type: type || 'text',
      replyToId: reply_to_id || null,
      metadata,
      clientMsgId: client_msg_id,
      senderProfile: req.user
    });
    // Сообщение уже сохранено: сбой рассылки не превращает ответ в отказ (G3).
    try {
      wsServer.publishNewMessage(message, { duplicate });
    } catch (err) {
      console.error('[API] рассылка сохранённого сообщения не удалась:', err.message);
    }
    res.status(duplicate ? 200 : 201).json(message);
  } catch (err) {
    sendErrorResponse(res, err);
  }
}

router.post('/messages/direct/:targetId', requireAuth, route((req, res) => sendViaRest(req, res, 'direct')));

router.get('/messages/channels/:targetId', requireAuth, route(async (req, res) => {
  try {
    const after = parseAfterId(req.query.afterId);
    if (!after.ok) return res.status(400).json({ error: AFTER_ID_ERROR });
    res.json(await MessageService.getMessages(
      'channel',
      Number(req.params.targetId),
      req.user.id,
      req.query.limit ? parseInt(req.query.limit, 10) : 50,
      req.query.beforeId ? parseInt(req.query.beforeId, 10) : null,
      after.value
    ));
  } catch (err) {
    if (err.message === 'NOT_CHANNEL_MEMBER') return res.status(403).json({ error: 'Вы не участник этого канала' });
    res.status(400).json({ error: err.message });
  }
}));

router.post('/messages/channels/:targetId', requireAuth, route((req, res) => sendViaRest(req, res, 'channel')));

// ── Синхронизация после переподключения (мобильные клиенты) ──
// Курсор — непрозрачная строка «<эпоха>.<номер изменения>» (не время). Не
// похожая на курсор строка — 400; похожая, но не этой базы или устаревшая —
// 410 (MessageService.parseSyncCursor). Без since — только
// текущая голова: с неё клиент начинает, загрузив страницы переписок обычным
// путём. Предел частоты — как у поиска: обход длинного пропуска — это десятки
// страниц, а не тысячи запросов в минуту.
const SYNC_RATE_LIMIT = { maxAttempts: 60, windowMs: 60000 };
const SYNC_CURSOR_RE = /^[A-Za-z0-9._-]{1,64}$/;

router.get('/sync', requireAuth, route(async (req, res) => {
  if (!checkRateLimit(`sync:${req.user.id}`, SYNC_RATE_LIMIT)) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Слишком много запросов синхронизации. Повторите через минуту.' });
  }
  const { since, limit } = req.query;
  if (since !== undefined && (typeof since !== 'string' || !SYNC_CURSOR_RE.test(since))) {
    return res.status(400).json({ error: 'since — курсор из next_cursor (непрозрачная строка)' });
  }
  let pageSize = MessageService.SYNC_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^\d{1,6}$/.test(limit) || Number(limit) < 1) {
      return res.status(400).json({ error: `limit — целое от 1 (больше ${MessageService.SYNC_MAX_LIMIT} урезается)` });
    }
    pageSize = Number(limit);
  }
  if (since === undefined) {
    return res.json({ messages: [], next_cursor: MessageService.syncHeadCursor(), has_more: false });
  }
  try {
    res.json(await MessageService.syncSince(req.user.id, since, pageSize));
  } catch (err) {
    if (err.code === 'SYNC_CURSOR_INVALID') return res.status(410).json({ error: err.message, code: err.code });
    throw err;
  }
}));

// Поиск — полный просмотр таблицы сообщений (LIKE '%…%'), а node:sqlite
// синхронен: пока идёт запрос, сервер не обслуживает никого. Без предела один
// сотрудник частыми поисками по длинной строке останавливал сервер для всех
// (аудит, раунд 4, находка Р4-10). Живой поиск в интерфейсе — единицы
// запросов в секунду на время набора.
const SEARCH_LIMIT = { maxAttempts: 30, windowMs: 60000 };
const SEARCH_MAX_LENGTH = 200;

router.get('/messages/search', requireAuth, route(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  if (typeof q !== 'string' || q.length > SEARCH_MAX_LENGTH) {
    return res.status(400).json({ error: `Строка поиска — не длиннее ${SEARCH_MAX_LENGTH} символов` });
  }
  if (!checkRateLimit(`search:${req.user.id}`, SEARCH_LIMIT)) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Слишком много поисковых запросов. Повторите через минуту.' });
  }
  res.json(await MessageService.searchMessages(q, req.user.id));
}));

// ── 5. ОПОВЕЩЕНИЯ ──
router.get('/announcements', requireAuth, route(async (req, res) => {
  res.json(await AnnouncementService.getAnnouncementsForUser(req.user.id));
}));

router.post('/announcements', requireAuth, route(async (req, res) => {
  try {
    // Находка №4: раньше проверялся is_admin, а его несёт и администратор
    // подразделения — с can_broadcast:false он всё равно рассылал
    // распоряжения «от компании» кому угодно. isSuperAdmin() исключает
    // контурных администраторов, как и везде в этом файле.
    if (!isSuperAdmin(req.user) && !req.user.permissions.can_broadcast) {
      return res.status(403).json({ error: 'Нет прав на отправку массовых оповещений' });
    }
    // Автор — всегда тот, кто отправил. Раньше author_id из тела запроса
    // перекрывал настоящего, и распоряжение уходило «от директора».
    const ann = await AnnouncementService.createAnnouncement({ ...(req.body || {}), author_id: req.user.id });
    AuditService.log({ userId: req.user.id, action: 'announcement_created', ip: getClientIp(req), details: { announcementId: ann?.id } });
    if (ann.target_type === 'all') {
      wsServer.broadcast({ type: 'new_announcement', announcement: ann });
    } else {
      // Находка №3: адресное оповещение раньше уходило полным текстом всем —
      // видимость по цели проверялась только при чтении REST-списком, а не
      // при живой рассылке. Теперь текст получают только получатели и автор.
      const recipientIds = new Set(await AnnouncementService.getRecipientIds(ann));
      recipientIds.add(Number(ann.author_id));
      for (const userId of recipientIds) {
        wsServer.sendToUser(userId, { type: 'new_announcement', announcement: ann });
      }
    }
    res.status(201).json(ann);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/announcements/:id/acknowledge', requireAuth, route(async (req, res) => {
  try {
    const ip = getClientIp(req) || '127.0.0.1';
    // Находка №10: раньше принимался ack на любой id, даже несуществующий
    // или не адресованный этому сотруднику — журнал ознакомления переставал
    // быть надёжным. Теперь оба условия проверяются до записи.
    const announcement = await AnnouncementService.getAnnouncementById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ error: 'Оповещение не найдено' });
    }
    if (!(await AnnouncementService.isVisibleTo(announcement.id, req.user.id, announcement))) {
      return res.status(403).json({ error: 'Оповещение не адресовано вам' });
    }
    const result = AnnouncementService.acknowledgeAnnouncement(req.params.id, req.user.id, ip);
    // Только реальным получателям и автору — не всей компании (та же логика
    // видимости, что и при создании).
    const recipientIds = new Set(await AnnouncementService.getRecipientIds(announcement));
    recipientIds.add(Number(announcement.author_id));
    for (const userId of recipientIds) {
      wsServer.sendToUser(userId, {
        type: 'announcement_acknowledged',
        announcementId: req.params.id,
        userId: req.user.id,
        userName: req.user.full_name
      });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.get('/announcements/:id/audit', requireAuth, route(async (req, res) => {
  try {
    // Кто и когда ознакомился — сведения для тех, кто рассылает распоряжения,
    // а не для всех сотрудников.
    const permissions = req.user.permissions || {};
    // Находка №4: то же самое смешение is_admin/can_broadcast, что и в
    // создании оповещения — контурный администратор без can_broadcast не
    // должен читать журнал (IP и адреса всех сотрудников компании).
    if (!isSuperAdmin(req.user) && !permissions.can_broadcast) {
      return res.status(403).json({ error: 'Журнал ознакомления доступен только администраторам' });
    }
    // Контурный администратор с правом на рассылку видит журнал только
    // собственных оповещений — иначе он читает адреса и IP всех сотрудников
    // компании по чужому распоряжению.
    if (isScopedAdmin(req.user)) {
      const owned = await AnnouncementService.getAnnouncementById(req.params.id);
      if (!owned) return res.status(404).json({ error: 'Оповещение не найдено' });
      if (Number(owned.author_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Журнал доступен только для оповещений, отправленных вами' });
      }
    }
    res.json(await AnnouncementService.getAnnouncementAudit(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── 6. СВЕДЕНИЯ О СЕРВЕРЕ ──
router.get('/settings/info', route(async (req, res) => {
  const settings = await SettingsService.getAllSettings();
  res.json({
    server_name: settings.server_name || 'CentyChat Server',
    company_name: settings.company_name || 'Корпоративная сеть',
    allow_registration: settings.allow_registration === 'true',
    // Окна правки/удаления сообщений: клиенту нужно знать их, чтобы не
    // показывать «Изменить»/«Удалить» там, где сервер их всё равно отклонит.
    // Сама проверка остаётся на сервере (MessageService.editMessage/deleteMessage) —
    // здесь только то, что нужно для скрытия пункта меню.
    message_edit_window_minutes: settings.message_edit_window_minutes || '60',
    message_delete_window_minutes: settings.message_delete_window_minutes || '60',
    version: config.SERVER_VERSION
  });
}));

// Только названия подразделений и только пока включена самостоятельная
// регистрация: форме регистрации этот список нужен до всякой авторизации, но
// полное дерево — сотрудники, контакты, структура — не должно читаться
// анонимным вызовом.
let departmentsCache = { at: 0, payload: null };
const DEPARTMENTS_CACHE_MS = 30000;
router.get('/settings/departments', route(async (req, res) => {
  // Кэш на 30 с: анонимная форма регистрации дёргает список у всех сразу, а
  // содержимое меняется редко — незачем ходить в базу на каждый запрос
  // (проверка раунда 4, M6).
  if (departmentsCache.payload && Date.now() - departmentsCache.at < DEPARTMENTS_CACHE_MS) {
    return res.json(departmentsCache.payload);
  }
  const allowRegistration = (await SettingsService.getSetting('allow_registration', 'false')) === 'true';
  let payload;
  if (!allowRegistration) {
    payload = { departments: [] };
  } else {
    const departments = await identity().all(
      'SELECT id, name FROM departments ORDER BY sort_order ASC, name ASC'
    );
    payload = { departments };
  }
  departmentsCache = { at: Date.now(), payload };
  res.json(payload);
}));

// ── ЗАЯВКИ НА РЕГИСТРАЦИЮ ──
// Сотрудник регистрируется сам, но пользоваться системой начинает только после
// подтверждения. Администратору не нужно заводить каждого руками, при этом
// посторонний в корпоративный чат не попадает.
router.get('/admin/registrations', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  const wanted = req.query.status === undefined ? 'pending' : String(req.query.status);
  if (!['pending', 'rejected', 'approved'].includes(wanted)) {
    return res.status(400).json({ error: 'status: pending, rejected или approved' });
  }
  // Scope must be part of the query before LIMIT, otherwise 500 earlier
  // registrations in sibling departments hide legitimate local registrations.
  if (isScopedAdmin(req.user) && !req.user.admin_scope_dept_id) return res.json([]);
  const allowed = isScopedAdmin(req.user)
    ? await OrgService.getSubtreeDepartmentIds(req.user.admin_scope_dept_id)
    : null;
  if (allowed && !allowed.length) return res.json([]);
  const scopeSql = allowed
    ? ` AND u.department_id IN (${allowed.map((_, i) => `$${i + 2}`).join(', ')})`
    : '';
  const rows = await identity().all(`
    SELECT u.id, u.username, u.full_name, u.email, u.phone, u.job_title, u.approval_status,
           u.department_id, d.name AS department_name, u.registered_at
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.approval_status = $1 AND u.registered_at IS NOT NULL${scopeSql}
    ORDER BY u.registered_at ASC
    LIMIT 500
  `, [wanted, ...(allowed || [])]);
  res.json(rows);
}));

router.post('/admin/registrations/:id/approve', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    const user = await AuthService.approveUser(Number(req.params.id));
    AuditService.log({
      userId: req.user.id,
      action: 'registration_approved',
      ip: getClientIp(req),
      details: { approvedUserId: Number(req.params.id), username: user?.username }
    });
    wsServer.broadcast({ type: 'user_created', user: UserService.toPublicUser(user) });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/registrations/:id/reject', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.params.id) });
    await AuthService.rejectUser(Number(req.params.id));
    AuditService.log({
      userId: req.user.id,
      action: 'registration_rejected',
      ip: getClientIp(req),
      details: {
        rejectedUserId: Number(req.params.id),
        reason: typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : undefined
      }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Список разрешённых адресов самостоятельной регистрации: адрес из списка
// активируется сразу после кода, остальные ждут решения. Только суперадминистратор.
router.get('/admin/registration-allowlist', requireAuth, requireAdmin, route(async (req, res) => {
  res.json(await Registration.listAllowlist());
}));

router.post('/admin/registration-allowlist', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const row = await Registration.addAllowlist(req.body?.pattern, req.user.id);
    AuditService.log({ userId: req.user.id, action: 'registration_allowlist_added', ip: getClientIp(req), details: { pattern: row.pattern } });
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof Registration.RegistrationError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

router.delete('/admin/registration-allowlist/:id', requireAuth, requireAdmin, route(async (req, res) => {
  const removed = await Registration.removeAllowlist(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Запись не найдена' });
  AuditService.log({ userId: req.user.id, action: 'registration_allowlist_removed', ip: getClientIp(req), details: { id: Number(req.params.id) } });
  res.json({ success: true });
}));

// ── Жалобы, блокировки, удаление аккаунта (App Store 1.2, 5.1.1(v)) ──
function sendSafetyError(res, err) {
  if (err instanceof Safety.SafetyError || err instanceof Account.AccountError) {
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    return res.status(err.status).json(body);
  }
  throw err;
}

router.post('/reports', requireAuth, route(async (req, res) => {
  if (!checkRateLimit(`report:${req.user.id}`, { maxAttempts: 30, windowMs: 3600000 })) {
    res.set('Retry-After', '600');
    return res.status(429).json({ error: 'Слишком много жалоб. Повторите позже.' });
  }
  try {
    const report = await Safety.createReport(req.user.id, req.body);
    AuditService.log({ userId: req.user.id, action: 'report_created', ip: getClientIp(req), details: { reportId: report.id, targetType: req.body.targetType, targetId: Number(req.body.targetId) } });
    res.status(201).json(report);
  } catch (err) {
    sendSafetyError(res, err);
  }
}));

router.get('/admin/reports', requireAuth, requireAdmin, route(async (req, res) => {
  const status = req.query.status === undefined ? null : String(req.query.status);
  if (status !== null && status !== 'open' && status !== 'closed') {
    return res.status(400).json({ error: 'status: open или closed' });
  }
  res.json(await Safety.listReports({ status }));
}));

router.post('/admin/reports/:id/close', requireAuth, requireAdmin, route(async (req, res) => {
  if (!Safety.closeReport(req.params.id)) return res.status(404).json({ error: 'Жалоба не найдена' });
  res.json({ success: true });
}));

router.post('/blocks', requireAuth, route(async (req, res) => {
  try {
    const result = await Safety.blockUser(req.user.id, req.body?.userId);
    // Звонок, который уже звонит (или ждёт телефон, разбуженный push), не
    // переживает блокировку — в обе стороны.
    wsServer.endCallsBetween(req.user.id, result.userId);
    res.status(201).json(result);
  } catch (err) {
    sendSafetyError(res, err);
  }
}));

router.delete('/blocks/:userId', requireAuth, route(async (req, res) => {
  try {
    Safety.unblockUser(req.user.id, req.params.userId);
    res.json({ success: true });
  } catch (err) {
    sendSafetyError(res, err);
  }
}));

router.get('/blocks', requireAuth, route(async (req, res) => {
  res.json({ blocks: await Safety.listBlocks(req.user.id) });
}));

router.delete('/users/me', requireAuth, route(async (req, res) => {
  const ip = getClientIp(req) || '127.0.0.1';
  const ipKey = rateLimitIpKey(ip);
  // Пароль проверяется, поэтому подбор с украденным токеном ограничен так же,
  // как у смены пароля: неверные попытки на сотрудника и общий предел.
  const failKey = `acct-delete-fail:${req.user.id}`;
  const failLimit = { maxAttempts: 5, windowMs: config.LOGIN_LOCKOUT_MINUTES * 60000 };
  if (isRateLimited(failKey, failLimit) || !checkRateLimit(`acct-delete:${req.user.id}`, { maxAttempts: 10, windowMs: 3600000 })) {
    res.set('Retry-After', '600');
    return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
  }
  if (!acquireHashSlot(ipKey, true)) {
    res.set('Retry-After', String(busyRetryAfterSeconds()));
    return res.status(503).json({ error: 'Сервер сейчас занят. Повторите через несколько секунд.', code: 'BUSY' });
  }
  try {
    await Account.deleteOwnAccount(req.user.id, req.body?.password);
    AuditService.log({ action: 'account_deleted', ip, details: { deletedUserId: req.user.id } });
    wsServer.disconnectUser(req.user.id, 'Учётная запись удалена');
    wsServer.forgetPushedChats(req.user.id);
    // Рассылается уже обезличенная строка из базы: прежние логин, почта,
    // телефон и должность стёрты и по сокетам не уходят (registration.md §3).
    const erased = await UserService.getUserById(req.user.id);
    wsServer.broadcast({
      type: 'user_updated',
      user: UserService.toPublicUser({
        ...(erased || { id: req.user.id, username: `deleted~${req.user.id}`, full_name: 'Удалённый сотрудник' }),
        is_active: 0, status: 'offline', avatar_url: null
      })
    });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof Account.AccountError && err.code === 'INVALID_PASSWORD') registerFailure(failKey, failLimit);
    if (err?.code === 'PASSWORD_HASH_BUSY') {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: err.message, code: err.code });
    }
    sendSafetyError(res, err);
  } finally {
    releaseHashSlot(ipKey, true);
  }
}));

// Журнал действий. Читать может только суперадминистратор.
router.get('/admin/audit', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json(await AuditService.list({ action: req.query.action || null, userId: req.query.userId ?? null, limit: req.query.limit }));
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}));

// Полные настройки содержат токен Telegram-бота и чёрный список адресов —
// только администратору. Сотрудникам нужное отдаёт /settings/info.
router.get('/settings', requireAuth, requireAdmin, route(async (req, res) => {
  res.json(publicSettings(await SettingsService.getAllSettings()));
}));

router.put('/settings', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const body = validateSettingsUpdate(req.body);
    AuditService.log({ userId: req.user.id, action: 'settings_changed', ip: getClientIp(req), details: { keys: Object.keys(body) } });
    const updated = await SettingsService.updateSettings(body);
    if (body.remote_desktop_enabled === 'false') {
      wsServer.endAllRemoteSessions('Удалённый рабочий стол отключён администратором');
    }
    res.json(publicSettings(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/channels', requireAuth, (req, res) => {
  try {
    const { name, topic, type = 'public' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Укажите название канала' });
    if (!req.user.permissions?.can_create_channels && !req.user.permissions?.is_admin) {
      return res.status(403).json({ error: 'Создание каналов не разрешено для вашей роли' });
    }
    const channel = MessageService.createChannel(name, topic, type, req.user.id);

    if (channel.type === 'private') {
      // Находка №11: приватный канал рассылался всем сокетам целиком (имя,
      // тема) — посторонние узнавали о его существовании. Теперь только
      // тем, кто уже состоит в нём с момента создания.
      for (const memberId of MessageService.getChannelMemberIds(channel.id)) {
        wsServer.sendToUser(memberId, { type: 'channel_created', channel });
      }
    } else {
      wsServer.broadcast({ type: 'channel_created', channel });
    }
    res.status(201).json(channel);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 8. ФАЙЛЫ ──
// Право проверяется до приёма тела: иначе сотрудник без права загрузки всё
// равно заставлял сервер держать в памяти до 100 МБ, прежде чем получить 403.
function requireUploadPermission(req, res, next) {
  if (!req.user.permissions?.can_upload_files && !req.user.permissions?.is_admin) {
    return res.status(403).json({ error: 'Загрузка файлов не разрешена для вашей роли' });
  }
  next();
}

// Типы, которые можно отдать вложению как есть: браузер не исполняет их как
// документ. Сверяется только «тип/подтип» без параметров.
const SAFE_DOWNLOAD_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
  'application/pdf', 'text/plain', 'text/csv',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/webm',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/zip', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed'
]);

function safeDownloadType(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!SAFE_DOWNLOAD_TYPES.has(base)) return 'application/octet-stream';
  // Текст — всегда с явной кодировкой, чтобы браузер её не угадывал.
  return base.startsWith('text/') ? `${base}; charset=utf-8` : base;
}

// Объём загрузок на сотрудника за час (UPLOAD_MAX_MB_PER_HOUR). Параллельных
// загрузок и так не больше двух, но без предела по объёму один сотрудник за
// ночь заполнял бы том сервера — и вместе с ним останавливалась бы база
// (аудит, раунд 4, находка Р4-11; остаток находки №7 раунда 3).
const UPLOAD_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const uploadVolume = new Map(); // userId -> { windowStart, bytes }

function uploadQuotaBytes() {
  return config.UPLOAD_MAX_MB_PER_HOUR * 1024 * 1024;
}

function uploadedThisHour(userId, now = Date.now()) {
  const entry = uploadVolume.get(userId);
  if (!entry || now - entry.windowStart >= UPLOAD_QUOTA_WINDOW_MS) return 0;
  return entry.bytes;
}

// Сколько секунд до обнуления часового окна квоты — осмысленный Retry-After
// вместо фиксированной догадки (M2).
function uploadWindowResetSeconds(userId, now = Date.now()) {
  const entry = uploadVolume.get(userId);
  if (!entry) return 1;
  return Math.max(1, Math.ceil((entry.windowStart + UPLOAD_QUOTA_WINDOW_MS - now) / 1000));
}

function recordUploadVolume(userId, bytes, now = Date.now()) {
  let entry = uploadVolume.get(userId);
  if (!entry || now - entry.windowStart >= UPLOAD_QUOTA_WINDOW_MS) {
    entry = { windowStart: now, bytes: 0 };
    uploadVolume.set(userId, entry);
  }
  entry.bytes += Number(bytes) || 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of uploadVolume) {
    if (now - entry.windowStart >= UPLOAD_QUOTA_WINDOW_MS) uploadVolume.delete(userId);
  }
}, 10 * 60000).unref();

// Заявленный размер запроса известен до приёма тела. Без этой проверки
// сервер читал 100 МБ и лишь потом отказывал — человек ждал минуты ради
// «файл слишком большой». Запас в 1 МБ — на служебные части формы.
const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const FORM_OVERHEAD_BYTES = 1024 * 1024;
// Одновременных загрузок на сотрудника. Больше двух — это уже не работа.
const MAX_PARALLEL_UPLOADS = 2;
const activeUploads = new Map(); // userId -> число идущих загрузок

async function acceptUpload(req, res, next) {
  // Настройка «максимальный размер» в консоли раньше ни на что не влияла.
  const configuredMb = Number(await SettingsService.getSetting('max_upload_size_mb', '100'));
  const limitBytes = Math.min(UPLOAD_LIMIT_BYTES, Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * 1024 * 1024 : UPLOAD_LIMIT_BYTES);
  const limitMb = Math.round(limitBytes / (1024 * 1024));

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes + FORM_OVERHEAD_BYTES) {
    res.set('Connection', 'close');
    return res.status(413).json({ error: `Файл больше ${limitMb} МБ — такой файл загрузить нельзя` });
  }

  // Свободное место на диске: приняв файл в почти полный том, сервер рискует
  // тем, что запись базы переписки в тот же том оборвётся на середине. Ниже
  // порога UPLOAD_MIN_FREE_DISK_MB загрузка отклоняется заранее (M2, 507).
  if (config.UPLOAD_MIN_FREE_DISK_MB > 0 && fs.promises.statfs) {
    try {
      const st = await fs.promises.statfs(UPLOAD_TMP_DIR);
      const freeBytes = st.bavail * st.bsize;
      const needed = (Number.isFinite(declared) ? declared : 0) + config.UPLOAD_MIN_FREE_DISK_MB * 1024 * 1024;
      if (freeBytes < needed) {
        res.set('Retry-After', String(jitterSeconds(300)));
        return res.status(507).json({ error: 'На сервере недостаточно свободного места. Обратитесь к администратору.' });
      }
    } catch {
      /* statfs недоступен на этой ФС — не повод отказывать в загрузке */
    }
  }

  const userId = req.user.id;
  const quota = uploadQuotaBytes();
  if (quota > 0) {
    const pending = Number.isFinite(declared) ? declared : 0;
    if (uploadedThisHour(userId) + pending > quota + FORM_OVERHEAD_BYTES) {
      res.set('Retry-After', String(uploadWindowResetSeconds(userId)));
      return res.status(429).json({
        error: `Предел загрузок — ${config.UPLOAD_MAX_MB_PER_HOUR} МБ в час. Повторите позже или обратитесь к администратору.`
      });
    }
  }
  const running = activeUploads.get(userId) || 0;
  if (running >= MAX_PARALLEL_UPLOADS) {
    // Подсказка клиенту, когда спросить снова: мобильные клиенты ждут по
    // Retry-After, а не помечают файл как «не загрузилось».
    res.set('Retry-After', String(jitterSeconds(3)));
    return res.status(429).json({ error: 'Дождитесь окончания текущих загрузок' });
  }
  activeUploads.set(userId, running + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (activeUploads.get(userId) || 1) - 1;
    if (left > 0) activeUploads.set(userId, left);
    else activeUploads.delete(userId);
    // Временный файл не должен пережить запрос, чем бы он ни кончился.
    if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {});
  };
  res.on('finish', release);
  res.on('close', release);

  uploaderFor(limitBytes).single('file')(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? `Файл больше ${limitMb} МБ — такой файл загрузить нельзя` : 'Файл не принят'
    });
  });
}

router.post('/files/upload', requireAuth, requireUploadPermission, route(acceptUpload), route(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не прикреплен' });
    // Засчитывается принятое на диск, даже если фильтр типов потом откажет:
    // место и время сервер уже потратил.
    recordUploadVolume(req.user.id, req.file.size);
    res.status(201).json(await FileService.saveUploadedFile({
      uploaderId: req.user.id,
      originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      tempPath: req.file.path,
      size: req.file.size,
      mimeType: req.file.mimetype
    }));
  } catch (err) {
    // Фильтр типов файлов (FileService.saveUploadedFile → FilePolicyService)
    // отмечает свой отказ полем statusCode — остальные ошибки сохранения
    // остаются обычным 400 без подробностей о причине.
    if (err.statusCode === 415) {
      return res.status(415).json({ error: err.message, code: err.code });
    }
    res.status(400).json({ error: 'Файл не сохранён' });
  }
}));

// Действующий для вызывающего список разрешённых расширений — клиент
// использует его для предпроверки при выборе файла (accept у <input> и
// понятная ошибка до отправки), не дожидаясь отказа сервера постфактум.
router.get('/files/policy', requireAuth, route(async (req, res) => {
  const policy = await FilePolicyService.getPolicy();
  const allowed = await FilePolicyService.effectiveAllowed(req.user.id);
  res.json({ enabled: policy.enabled, allowed });
}));

// Метка содержимого вложения: SHA-256, посчитанный при загрузке (файл после
// этого не меняется). У старых записей без хеша — размер и время изменения.
function downloadEtag(file, size) {
  if (/^[0-9a-f]{64}$/.test(String(file.sha256 || ''))) return `"${file.sha256}"`;
  let mtime = 0;
  try { mtime = Math.floor(fs.statSync(file.path).mtimeMs); } catch { /* метка без времени */ }
  return `"${size.toString(16).padStart(8, '0')}${mtime.toString(16).padStart(12, '0')}"`;
}

router.get('/files/download/:id', requireAuth, (req, res) => {
  const file = FileService.getFileById(req.params.id);
  if (!file || !fs.existsSync(file.path)) {
    return res.status(404).send('Файл не найден');
  }
  if (!FileService.canUserAccessFile(req.user.id, req.params.id)) {
    return res.status(403).send('Доступ запрещен: файл вне ваших диалогов и каналов');
  }
  // Тип файла назвал тот, кто его загрузил. Отданный «inline» HTML или SVG
  // исполнился бы в контексте приложения — поэтому только как вложение.
  // Сверх того тип берётся из короткого списка безопасных (картинки без SVG,
  // PDF, звук, видео, простой текст), всё остальное — octet-stream: вложение,
  // песочница и nosniff уже не дают исполнить HTML/SVG, но заявленный
  // отправителем тип вообще не должен доходить до браузера как есть (аудит,
  // раунд 4, находка Р4-14).
  res.setHeader('Content-Type', safeDownloadType(file.mime_type));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // no-store остаётся: вложение не должно оседать в кэше браузера или
  // Electron. Метка ETag нужна клиентам со своим кэшем (мобильные): они сами
  // присылают If-None-Match и получают 304 без тела.
  res.setHeader('Cache-Control', 'private, no-store');

  // Докачка (задача 20): один диапазон байт — 206, всё прочее в Range — 416.
  // Доступ уже проверен выше: диапазон отдаётся тем же, кому и весь файл.
  let size;
  try {
    size = fs.statSync(file.path).size;
  } catch {
    return res.status(404).send('Файл не найден');
  }
  const etag = downloadEtag(file, size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  if (etagListMatches(req.headers['if-none-match'], etag)) {
    res.removeHeader('Content-Disposition');
    return res.status(304).end();
  }
  // If-Range проверяется раньше Range (RFC 9110 §13.2.2): не совпал — Range
  // не рассматривается вовсе, отдаётся весь файл, даже если Range неверен.
  const range = ifRangeAllows(req.headers['if-range'], etag) ? parseRange(req.headers.range, size) : null;
  if (range?.invalid) {
    res.removeHeader('Content-Disposition');
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else {
    res.setHeader('Content-Length', String(size));
  }
  // Обрыв соединения закрывает поток чтения (иначе дескриптор подтекал бы на
  // каждом прерванном скачивании), а ошибка чтения (файл исчез между проверкой
  // и открытием, исчерпаны дескрипторы) не роняет процесс, а отвечает 500 (M3).
  // stream.pipeline здесь не подходит: при ошибке источника он разрушает res
  // до того, как удастся отдать понятный 500. Поэтому — ручной pipe плюс явное
  // закрытие потока на 'close' соединения.
  const src = fs.createReadStream(file.path, range ? { start: range.start, end: range.end } : undefined);
  const closeSrc = () => src.destroy();
  res.on('close', closeSrc);
  src.on('error', (err) => {
    console.error('[API] отдача вложения не удалась:', err.message);
    src.destroy();
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Range');
      res.type('json').status(500).json({ error: 'Внутренняя ошибка сервера' });
    } else {
      res.destroy();
    }
  });
  src.pipe(res);
});

// Миниатюра картинки-вложения (задача 20). Доступ — ровно тот же, что у
// скачивания (и в том же порядке: 404, затем 403). Тип картинки — по
// сигнатуре файла, не по MIME из базы; миниатюра отрисовывается один раз и
// дальше отдаётся из кэша на диске.
router.get('/files/thumb/:id', requireAuth, route(async (req, res) => {
  const file = FileService.getFileById(req.params.id);
  if (!file || !fs.existsSync(file.path)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  if (!FileService.canUserAccessFile(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'Доступ запрещен: файл вне ваших диалогов и каналов' });
  }
  const size = req.query.size === undefined ? 's' : req.query.size;
  const format = req.query.format === undefined ? 'webp' : req.query.format;
  if (typeof size !== 'string' || !Object.hasOwn(Images.THUMB_SIZES, size) || (format !== 'webp' && format !== 'jpeg')) {
    return res.status(400).json({ error: 'size — s или m; format — webp или jpeg', code: 'BAD_REQUEST' });
  }
  let thumb;
  try {
    // Отрисовка (промах кэша) — не больше THUMB_RENDERS_PER_MINUTE в минуту
    // на сотрудника: готовые миниатюры из кэша пределом не ограничены.
    const admitRender = () => checkRateLimit(`thumb-render:${req.user.id}`, {
      maxAttempts: Number(process.env.THUMB_RENDERS_PER_MINUTE) > 0 ? Number(process.env.THUMB_RENDERS_PER_MINUTE) : 60,
      windowMs: 60000
    });
    thumb = await Thumbnails.getThumbnail(file, { size, format, admitRender });
  } catch (err) {
    if (err instanceof Images.ImageError) {
      if (err.status === 503) res.set('Retry-After', String(jitterSeconds(5)));
      if (err.status === 429) res.set('Retry-After', '60');
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }
  if (thumb.rendered?.source) {
    FileService.recordImageInfo(file.id, { ...thumb.rendered.source, dominantColor: thumb.rendered.color });
  }
  res.setHeader('ETag', thumb.etag);
  // Не immutable: после восстановления базы id файла может достаться другому
  // вложению — клиент перепроверяет кэш по ETag (в нём ключ содержимого) и
  // получает 304, пока миниатюра та же.
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (etagListMatches(req.headers['if-none-match'], thumb.etag)) return res.status(304).end();
  res.type(thumb.contentType);
  res.sendFile(thumb.path, { headers: { 'Cache-Control': 'private, no-cache' }, lastModified: false, etag: false, dotfiles: 'allow' });
}));

router.get('/files/recent', requireAuth, route(async (req, res) => {
  res.json(await FileService.getRecentFiles(req.user.id));
}));

// Администрирование фильтра типов файлов — отдельный подроутер
// (server/src/files/policy-router.js), чтобы не разрастать этот файл.
router.use('/admin/file-policy', createFilePolicyRouter({ requireAuth, requireAdmin, getClientIp }));

// ── 9. СТУДИЯ БАЗЫ ДАННЫХ ──
// Работает только с базой переписки: учётные записи лежат в другом хранилище и
// произвольным SQL отсюда недостижимы — см. db-studio.service.js.
router.get('/admin/db/stats', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    res.json({ ...DbStudioService.getDatabaseStats(), identity: await DbStudioService.getIdentityStats() });
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}));

router.get('/admin/db/tables', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(DbStudioService.getTables());
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.get('/admin/db/tables/:name/schema', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(DbStudioService.getTableSchema(req.params.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/db/tables/:name/data', requireAuth, requireAdmin, (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const data = DbStudioService.getTableData(req.params.name, limit, offset);
    AuditService.log({ userId: req.user.id, action: 'db_table_viewed', ip: getClientIp(req), details: { table: String(req.params.name), limit, offset } });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/db/query', requireAuth, requireAdmin, (req, res) => {
  try {
    const result = DbStudioService.executeCustomSql(req.body?.sql);
    AuditService.log({
      userId: req.user.id,
      action: 'db_query_executed',
      ip: getClientIp(req),
      details: { sql: String(req.body?.sql || '').slice(0, 500) }
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/db/backup', requireAuth, requireAdmin, route(async (req, res) => {
  try {
    const result = await BackupService.createBackup();
    AuditService.log({ userId: req.user.id, action: 'db_backup_created', ip: getClientIp(req), details: { files: result.files.map((f) => f.fileName), encrypted: result.encrypted } });
    const { filePath, ...safe } = result;
    res.json(safe);
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}));

router.get('/admin/db/backups', requireAuth, requireAdmin, (req, res) => {
  res.json(BackupService.listBackups());
});

router.get('/admin/db/backups/:filename', requireAuth, requireAdmin, (req, res) => {
  const safeName = path.basename(req.params.filename);
  const file = path.join(config.BACKUPS_DIR, safeName);
  if (!fs.existsSync(file)) return res.status(404).send('Бэкап не найден');
  AuditService.log({
    userId: req.user.id,
    action: 'db_backup_downloaded',
    ip: getClientIp(req),
    details: { fileName: safeName }
  });
  res.download(file);
});

// ── ПРИВЯЗКА УСТРОЙСТВ ──
router.get('/admin/devices/pending', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    res.json(await DeviceService.getPendingDevices(req.user));
  } catch (err) {
    console.error(`[API] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}));

router.post('/admin/devices/bind', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user, { targetUserId: Number(req.body?.user_id) });
    // Rebinding also mutates the current owner's pairing. A scoped admin may
    // assign a device to a local employee only if its current owner is local.
    const owner = await DeviceService.getPairingOwner(req.body?.device_id);
    if (owner) await assertWithinAdminScope(req.user, { targetUserId: Number(owner.user_id) });
    const result = await DeviceService.bindDevice({ ...req.body, adminUser: req.user });
    AuditService.log({
      userId: req.user.id,
      action: 'device_bound',
      ip: getClientIp(req),
      details: { deviceId: req.body?.device_id, targetUserId: req.body?.user_id }
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/devices/auto-match', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    await assertWithinAdminScope(req.user);
    res.json(await DeviceService.autoMatchByIp(req.user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/admin/devices/unbind', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    const owner = await DeviceService.getPairingOwner(req.body?.device_id);
    if (owner) await assertWithinAdminScope(req.user, { targetUserId: Number(owner.user_id) });
    else if (!isSuperAdmin(req.user)) throw new Error('Устройство не найдено');
    AuditService.log({ userId: req.user.id, action: 'device_unbound', ip: getClientIp(req), details: { deviceId: String(req.body?.device_id), targetUserId: owner?.user_id ?? null } });
    const result = await DeviceService.unbindDevice(req.body?.device_id);
    if (req.body?.device_id) PushTokens.removeForDevice({ deviceId: String(req.body.device_id) });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ── ПАКЕТНЫЙ ИМПОРТ ОРГСТРУКТУРЫ ──
router.post('/admin/org/preview-import', requireAuth, requireAdminOrScopedAdmin, (req, res) => {
  try {
    const { text, format } = req.body || {};
    res.json({ success: true, preview: OrgParserService.parseRawText(text, format || 'auto') });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/org/batch-import', requireAuth, requireAdminOrScopedAdmin, route(async (req, res) => {
  try {
    const { text, format, defaultPassword } = req.body || {};
    const parsed = OrgParserService.parseRawText(text, format || 'auto');
    const result = await OrgParserService.applyImport({
      parsedData: parsed,
      defaultPassword: defaultPassword || UserService.generateTempPassword(),
      adminScopeDeptId: req.user.admin_scope_dept_id,
      actorIsScopedAdmin: isScopedAdmin(req.user)
    });
    AuditService.log({
      userId: req.user.id,
      action: 'org_batch_import',
      ip: getClientIp(req),
      details: { createdUsers: result.createdUsers, createdDepts: result.createdDepts }
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
