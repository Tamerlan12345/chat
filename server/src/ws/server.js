const { WebSocketServer, WebSocket } = require('ws');
const AuthService = require('../services/auth.service');
const UserService = require('../services/user.service');
const MessageService = require('../services/message.service');
const RemoteDesktopService = require('../services/remote-desktop.service');
const AuditService = require('../services/audit.service');
const { isRateLimited, registerFailure } = require('../services/rate-limiter');
const { getClientIp, isIpAllowed, rateLimitIpKey } = require('../services/ip-access.service');
const config = require('../config');

// Самое крупное законное сообщение — файл до 10 МБ, переданный на удалённый
// рабочий стол в base64 (около 13,5 МБ). Без предела библиотека принимает до
// 100 МБ, и десяток таких сообщений съедает память сервера. Это верхний
// предел для соединения целиком (проверяется библиотекой ws при получении
// кадра, до события 'message'); обычным типам ниже отведено намного меньше.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

// Обычному кадру (сообщение чата, смена статуса, «печатает…») взяться крупным
// неоткуда — 256 КБ с большим запасом. Крупные кадры законны только там, где
// их не избежать: файл или список экранов на удалённый рабочий стол (rd_*),
// обмен ICE-кандидатами и сигналинг звонка (call_*, ice_candidate) — см.
// RD_RELAY_TYPES выше и клиентские rd_file/rd_screens в
// desktop/src/renderer/src/components/RemoteDesktop*.jsx. Для них верхней
// границей остаётся MAX_MESSAGE_BYTES, проверенный библиотекой ws.
const MAX_TEXT_FRAME_BYTES = 256 * 1024;
// Разрешённый тип проверяется дважды и по-разному, и оба раза — не по сырым
// байтам от клиента. Раньше исключение решалось подстрокой в начале кадра
// («клиент всегда пишет type первым полем») — но JSON допускает повторяющийся
// ключ, и JSON.parse оставляет ПОСЛЕДНЕЕ значение, а не первое, которое видела
// подстрока (тот же ключ можно ещё и записать через экранирование \uXXXX, так
// что даже поиск подстроки "type" по всему кадру, а не только в начале, не
// спасал бы). Клиент мог показать в начале кадра type":"rd_file",
// а на деле передать send_message на 300 КБ текста — предел обходился целиком
// (найдено на ревью). Теперь решение до разбора зависит только от того, что
// сервер сам знает про это соединение (isOversizedFrameAllowedFor), а после
// разбора — от разобранного (не подстрокой) значения data.type.
const LARGE_FRAME_ALLOWED_TYPE_RE = /^(rd_[a-zA-Z0-9_]+|ice_candidate|call_[a-zA-Z0-9_]+)$/;

// Статус выставляет система: «в сети» и «отошёл» приходят от клиента, когда
// компьютер активен или простаивает, «не в сети» — только от разрыва
// соединения. Сам сотрудник управляет лишь режимом «Не беспокоить». Раньше
// можно было выбрать «не в сети», оставаясь на связи, — и коллеги считали,
// что человека нет.
const SYSTEM_PRESENCE = new Set(['online', 'away']);
const CUSTOM_STATUS_MAX = 200;

// Побудка собеседника: сигнал уходит сразу, следующий — не раньше чем через
// минуту. Пауза общая на отправителя, а не на пару: иначе можно было бы по
// очереди будить весь отдел.
function wakeCooldownMs() {
  const value = Number(process.env.WAKE_COOLDOWN_MS);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}
const AUTH_LIMIT = { maxAttempts: 10, windowMs: 60000 };

// До входа сокет — никто. Ему позволено одно короткое сообщение «auth»: раньше
// анонимное соединение могло прислать 16 МБ JSON и заставить сервер его
// разобрать, а десяток таких соединений замораживал обработку для всех.
const PRE_AUTH_MAX_BYTES = 4096;

// Сколько соединений держит один адрес и один сотрудник. Офис за одним NAT —
// это сотни человек, поэтому предел на адрес щедрый; на человека — несколько
// окон и устройств.
// Офис за одним NAT — это сотни человек, у каждого возможны несколько окон и
// устройств. 500 было мало для крупного офиса (проверка раунда 4, M7): при
// 500 сотрудниках с парой вкладок предел упирался бы в штатной работе. 2000
// с запасом; настраивается через WS_MAX_SOCKETS_PER_IP.
const MAX_SOCKETS_PER_IP = Number(process.env.WS_MAX_SOCKETS_PER_IP) > 0
  ? Number(process.env.WS_MAX_SOCKETS_PER_IP)
  : 2000;
const MAX_SOCKETS_PER_USER = 8;

// Частота сообщений на соединение: [сколько, за сколько мс]. Без предела одна
// учётная запись рассылала тысячи смен статуса в секунду всей компании и
// звонила коллеге без остановки.
const RATE_LIMITS = {
  presence: [10, 1000],
  set_dnd: [10, 1000],
  set_status: [10, 1000],
  status_update: [10, 1000],
  typing: [6, 1000],
  send_message: [10, 1000],
  direct_message: [10, 1000],
  channel_message: [10, 1000],
  edit_message: [10, 1000],
  delete_message: [10, 1000],
  cancel_message: [10, 1000],
  mark_read: [20, 1000],
  call_offer: [3, 10000],
  rd_request: [3, 30000],
  wake_send: [20, 10000],
  rd_input_event: [120, 1000],
  rd_ice_candidate: [60, 1000],
  ice_candidate: [60, 1000],
  '*': [60, 1000],
  audio: [120, 1000]
};

// Как часто перепроверять, что сессия соединения всё ещё действительна.
function revalidateIntervalMs() {
  const value = Number(process.env.WS_REVALIDATE_MS);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

// Запрос удалённого доступа, на который не ответили, истекает: иначе висящее
// окно согласия можно было нажать спустя час, когда оператор уже ушёл.
function rdRequestTtlMs() {
  const value = Number(process.env.RD_REQUEST_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}
const RD_MAX_SESSION_MS = 8 * 60 * 60 * 1000;

function isRemoteDesktopEnabled() {
  const SettingsService = require('../services/settings.service');
  return SettingsService.getSettingSync('remote_desktop_enabled', 'true') !== 'false';
}

// Те же адресаты, что при отправке (send_message): все члены канала или обе
// стороны личной переписки. edit_message/delete_message рассылаются по той
// же логике — иначе правка ушла бы не всем, кто уже видел исходное сообщение.
function conversationRecipients(message) {
  return message.conversation_type === 'channel'
    ? MessageService.getChannelMemberIds(message.target_id)
    : [Number(message.target_id), Number(message.sender_id)];
}

function allowRate(ws, key) {
  return checkRate(ws, key).allowed;
}

// Предел частоты с ответом: allowed — пропустить кадр; иначе retryAfterMs —
// через сколько откроется окно (для кадра error RATE_LIMITED, G2).
function checkRate(ws, key) {
  const [limit, windowMs] = RATE_LIMITS[key] || RATE_LIMITS['*'];
  if (!ws.rate) ws.rate = new Map();
  const now = Date.now();
  const bucket = ws.rate.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    ws.rate.set(key, { start: now, count: 1 });
    return { allowed: true, retryAfterMs: 0 };
  }
  bucket.count += 1;
  if (bucket.count <= limit) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: Math.max(1, bucket.start + windowMs - now) };
}

// ── Очередь кадров сокета (G1) ──────────────────────────────────────────────
// Кадры переписки одного сокета обрабатываются строго по очереди: обработчик
// отправки ждёт базу учётных записей и проверку файла, и без очереди два
// сообщения подряд сохранялись в обратном порядке. Очередь своя у каждого
// сокета — медленный кадр одного не задерживает остальных. Звонки, удалённый
// стол, «печатает…», присутствие и auth идут мимо очереди, как раньше: их
// порядок относительно сообщений не важен, а задержка заметна.
const SEND_TYPES = new Set(['send_message', 'direct_message', 'channel_message']);
const SERIAL_TYPES = new Set([...SEND_TYPES, 'edit_message', 'delete_message', 'cancel_message', 'mark_read']);
// Кадры, на которые клиент ждёт ответа: отказ пределом частоты или
// переполненной очередью им сообщается кадром error RATE_LIMITED (G2).
// Остальные (mark_read, typing, presence…) по-прежнему отбрасываются молча.
const ACK_TYPES = new Set([...SEND_TYPES, 'edit_message', 'delete_message', 'cancel_message']);

// Сколько кадров переписки может ждать в очереди одного сокета. Предел
// частоты пропускает в неё до ~60 кадров/с; очередь растёт, только если
// обработка медленнее. Сверх предела — отказ RATE_LIMITED, а не память.
function maxQueuedFrames() {
  const value = Number(process.env.WS_MAX_QUEUED_FRAMES);
  return Number.isInteger(value) && value > 0 ? value : 100;
}
const QUEUE_FULL_RETRY_MS = 1000;

// Обработчик, который не ответил за это время (зависла внешняя база),
// перестаёт держать очередь сокета: следующий кадр идёт дальше.
function frameTimeoutMs() {
  const value = Number(process.env.WS_FRAME_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

// Ответы RATE_LIMITED сами ограничены: не больше REPLY_BUDGET за секунду на
// сокет и не тогда, когда клиент не читает свой сокет (bufferedAmount) —
// иначе поток отброшенных кадров превращался бы в поток ответов, копящихся в
// памяти сервера. Без ответа клиент узнаёт об отказе по таймауту, как раньше.
const REPLY_BUDGET = 10;
const REPLY_WINDOW_MS = 1000;
const MAX_BUFFERED_FOR_REPLY = 1024 * 1024;

function takeReplyBudget(ws) {
  const now = Date.now();
  if (!ws.replyBudget || now - ws.replyBudget.start >= REPLY_WINDOW_MS) ws.replyBudget = { start: now, count: 0 };
  ws.replyBudget.count += 1;
  return ws.replyBudget.count <= REPLY_BUDGET && (ws.bufferedAmount || 0) <= MAX_BUFFERED_FOR_REPLY;
}

function safeSend(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  } catch {
    /* сокет уже закрыт */
  }
}

// Поля, по которым клиент находит в своей очереди запрос, на который пришёл
// отказ: client_msg_id отправки/отзыва (только допустимый — недопустимое
// значение обратно не отражается) или messageId правки/удаления.
function correlation(type, msg) {
  const out = {};
  if (SEND_TYPES.has(type) || type === 'cancel_message') {
    if (typeof msg.client_msg_id === 'string' && MessageService.CLIENT_MSG_ID_RE.test(msg.client_msg_id)) {
      out.client_msg_id = msg.client_msg_id;
    }
  } else if (type === 'edit_message' || type === 'delete_message') {
    const id = Number(msg.messageId);
    if (Number.isInteger(id) && id > 0) out.messageId = id;
  }
  return out;
}

// Кадр error в ответ на запрос. message (и text отправки/правки) — как
// раньше, их читает настольный клиент; code, retryable и поля корреляции —
// дополнение для мобильных клиентов (delivery-state.md).
function errorFrame(type, msg, { message, code, retryable }, extra = {}) {
  const context = SEND_TYPES.has(type) ? 'send_message' : type;
  const frame = { type: 'error', context, message };
  if ((SEND_TYPES.has(type) || type === 'edit_message') && typeof msg.text === 'string') frame.text = msg.text;
  frame.code = code;
  frame.retryable = retryable;
  return { ...frame, ...correlation(type, msg), ...extra };
}

const RATE_LIMITED_MESSAGE = 'Слишком много запросов — повторите чуть позже';

// Браузерная страница с чужого сайта может открыть соединение к серверу от
// имени пользователя. Токен в cookie не хранится, поэтому вреда сейчас нет,
// но пускать чужие источники незачем: интерфейс приходит с этого же сервера.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // не браузер: служебные клиенты и тесты
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host && host === req.headers.host) return true;
  const allowed = String(config.CORS_ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

// Вызов, на который так и не ответили, перестаёт давать право «ответить».
const CALL_OFFER_TTL_MS = 2 * 60 * 1000;

// Сообщения, которыми оператор управляет чужим компьютером. При доступе
// «только просмотр» сервер их не пропускает: полагаться на то, что клиент
// оператора сам их не отправит, нельзя.
const OPERATOR_CONTROL_TYPES = new Set(['rd_input_event', 'rd_file', 'rd_clipboard', 'rd_clipboard_mode']);

const RD_DECLINE_REASONS = new Set(['busy', 'superseded', 'capture_failed', 'policy', 'disabled']);

const RD_RELAY_TYPES = new Set([
  'rd_webrtc_offer', 'rd_webrtc_answer', 'rd_ice_candidate', 'rd_input_event', 'rd_file',
  'rd_screens', 'rd_select_screen', 'rd_clipboard', 'rd_clipboard_mode', 'rd_end'
]);

function authTimeoutMs() {
  const value = Number(process.env.WS_AUTH_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 10000;
}

class WsServer {
  constructor() {
    this.wss = null;
    this.userSockets = new Map(); // userId -> Set of WebSockets
    this.socketUser = new Map();  // WebSocket -> user object
    // Кто с кем сейчас разговаривает. Только эти пары могут обмениваться
    // звуком — см. relayAudioFrame.
    this.activeCalls = new Map(); // userId -> userId
    // Кто кому звонит и ещё не получил ответа: callerId -> { targetId, at }.
    this.pendingOffers = new Map();
    // «Не беспокоить» переживает переподключение: переход ноутбука в сон не
    // должен молча снимать режим.
    this.dndUsers = new Set();
    // Последний сигнал системы о присутствии: что показать, когда режим
    // «Не беспокоить» выключат.
    this.presence = new Map(); // userId -> 'online' | 'away'
    // Последняя побудка каждого отправителя: fromId -> { toId, at }.
    this.lastWake = new Map();
    this.wakeInFlight = new Set();
    this.socketsPerIp = new Map(); // ip -> число соединений
  }

  effectiveStatus(userId) {
    if (this.dndUsers.has(userId)) return 'dnd';
    return this.presence.get(userId) || 'online';
  }

  async publishStatus(user, previous = null) {
    const status = this.effectiveStatus(user.id);
    if (previous !== null && previous === status) return;
    user.status = status;
    await UserService.updateStatus(user.id, status, user.custom_status ?? null);
    for (const socketUser of this.socketsOf(user.id)) socketUser.status = status;
    this.broadcast({
      type: 'user_status_changed',
      userId: user.id,
      user_id: user.id,
      status,
      customStatus: user.custom_status ?? null
    });
  }

  socketsOf(userId) {
    const result = [];
    for (const socket of this.userSockets.get(userId) || []) {
      const u = this.socketUser.get(socket);
      if (u) result.push(u);
    }
    return result;
  }

  // ── Побудка ──────────────────────────────────────────────────────────────

  wakeRetryAt(fromId) {
    const last = this.lastWake.get(fromId);
    return last ? last.at + wakeCooldownMs() : 0;
  }

  async sendWake(sender, msg) {
    const reply = (payload) => this.sendToUser(sender.id, payload);
    const targetId = Number(msg.targetUserId);

    const retryAt = this.wakeRetryAt(sender.id);
    if (retryAt > Date.now() || this.wakeInFlight.has(sender.id)) {
      return reply({ type: 'wake_error', code: 'cooldown', targetUserId: targetId, retryAt: Math.max(retryAt, Date.now() + 1000), message: 'Будить можно не чаще раза в минуту' });
    }
    // Пока идёт запрос к базе, второй сигнал того же человека ждёт отказа —
    // иначе два быстрых нажатия проскочили бы паузу.
    this.wakeInFlight.add(sender.id);
    let target;
    try {
      target = Number.isInteger(targetId) && targetId !== sender.id ? await UserService.getUserById(targetId) : null;
    } finally {
      this.wakeInFlight.delete(sender.id);
    }
    if (!target || target.is_active === 0 || target.is_active === false) {
      return reply({ type: 'wake_error', code: 'invalid_target', targetUserId: targetId, message: 'Разбудить можно только коллегу' });
    }
    if (this.wakeRetryAt(sender.id) > Date.now()) {
      return reply({ type: 'wake_error', code: 'cooldown', targetUserId: targetId, retryAt: this.wakeRetryAt(sender.id), message: 'Будить можно не чаще раза в минуту' });
    }
    // Отказы ниже паузу не запускают: сигнал никто не услышал.
    if (this.dndUsers.has(targetId)) {
      return reply({ type: 'wake_error', code: 'dnd', targetUserId: targetId, message: 'У собеседника включено «Не беспокоить»' });
    }
    if (!this.isUserOnline(targetId)) {
      return reply({ type: 'wake_error', code: 'offline', targetUserId: targetId, message: 'Собеседник не в сети' });
    }

    const at = Date.now();
    this.lastWake.set(sender.id, { toId: targetId, at });
    this.sendToUser(targetId, { type: 'wake_ring', fromUserId: sender.id, fromName: sender.full_name, at });
    reply({ type: 'wake_sent', targetUserId: targetId, at, retryAt: at + wakeCooldownMs() });
  }

  wakeStateFor(userId) {
    const last = this.lastWake.get(userId);
    const retryAt = this.wakeRetryAt(userId);
    if (!last || retryAt <= Date.now()) return { type: 'wake_state', retryAt: 0 };
    return { type: 'wake_state', targetUserId: last.toId, at: last.at, retryAt };
  }

  init(httpServer) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: MAX_MESSAGE_BYTES,
      // Mirrors the Express-level gate in index.js: the WS upgrade never
      // passes through Express middleware, so it needs its own check.
      // verifyClient rejects at the handshake itself — the connection never
      // opens for a disallowed IP, rather than opening and immediately
      // being closed.
      verifyClient: (info, callback) => {
        const ip = getClientIp(info.req) || '127.0.0.1';
        if (!isIpAllowed(ip)) return callback(false, 403, 'IP not allowed');
        if (!originAllowed(info.req)) return callback(false, 403, 'Origin not allowed');
        // Предел соединений — на сеть /64 для IPv6, а не на отдельный адрес:
        // иначе он обходился сменой адреса внутри своей же сети (Р4-02).
        if ((this.socketsPerIp.get(rateLimitIpKey(ip)) || 0) >= MAX_SOCKETS_PER_IP) return callback(false, 429, 'Too many connections');
        callback(true);
      }
    });

    this.wss.on('connection', (ws, req) => {
      ws.remoteIp = getClientIp(req) || '127.0.0.1';
      ws.ipKey = rateLimitIpKey(ws.remoteIp);
      this.socketsPerIp.set(ws.ipKey, (this.socketsPerIp.get(ws.ipKey) || 0) + 1);
      ws.isAlive = true;
      ws.connectedAt = new Date().toISOString();

      // Соединение, которое так и не представилось, закрывается. Иначе
      // открытый анонимный сокет — бесплатное место в памяти сервера на сколько
      // угодно долго.
      ws.authTimer = setTimeout(() => {
        if (!this.socketUser.has(ws)) {
          try { ws.close(4001, 'Authentication timeout'); } catch {}
        }
      }, authTimeoutMs());
      ws.authTimer.unref?.();

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (raw, isBinary) => {
        if (ws.revoked) return;
        const authenticated = this.socketUser.has(ws);
        if (!authenticated && (isBinary || raw.length > PRE_AUTH_MAX_BYTES)) {
          try { ws.close(1008, 'Authentication required'); } catch {}
          return;
        }
        // Двоичные кадры — это звук разговора. Он идёт по тому же соединению,
        // что и переписка, и по тому же 443 порту: прямое соединение между
        // компьютерами (WebRTC) в корпоративных сетях обычно не устанавливается,
        // а TURN-сервер — отдельная служба и отдельные расходы.
        if (isBinary) {
          if (allowRate(ws, 'audio')) this.relayAudioFrame(ws, raw);
          return;
        }
        // 256 КБ проверяются ДО разбора JSON — но решение, разбирать ли кадр
        // вообще, зависит не от того, что написано в кадре (это как раз то,
        // что клиент подделывает), а от того, что сервер сам знает об этом
        // соединении: открытый сеанс удалённого стола или разговор — см.
        // isOversizedFrameAllowedFor ниже.
        const oversized = raw.length > MAX_TEXT_FRAME_BYTES;
        if (oversized) {
          const sender = this.socketUser.get(ws);
          if (!sender || !this.isOversizedFrameAllowedFor(sender.id)) {
            try { ws.close(1009, 'Message too large'); } catch {}
            return;
          }
        }
        let data;
        try {
          data = JSON.parse(raw.toString('utf8'));
        } catch (err) {
          console.error('[WS Error] Bad JSON:', err.message);
          return;
        }
        if (!data || typeof data !== 'object') return;
        // Кадр прошёл проверку размера только потому, что у отправителя есть
        // открытый сеанс/разговор — это не значит, что этому конкретному
        // кадру законно быть большим. Разобранный (не подстрокой из сырых
        // байт — её обходит дублирующийся или экранированный ключ "type")
        // тип обязан входить в перечень тех, что действительно бывают
        // крупными; иначе это подмена — сообщение сверх лимита, которое
        // притворилось rd_*/call_*/ice_candidate, пока его не разобрали.
        if (oversized && !LARGE_FRAME_ALLOWED_TYPE_RE.test(String(data.type))) {
          try { ws.close(1008, 'Policy violation'); } catch {}
          return;
        }
        if (!authenticated && data.type !== 'auth') {
          try { ws.close(1008, 'Authentication required'); } catch {}
          return;
        }
        const rateKey = RATE_LIMITS[data.type] ? data.type : '*';
        const rate = checkRate(ws, rateKey);
        if (!rate.allowed) {
          // Кадр по-прежнему отбрасывается; клиенту, который ждёт ответа,
          // говорится, когда повторить (G2).
          this.replyRateLimited(ws, data, rate.retryAfterMs);
          return;
        }
        if (authenticated && SERIAL_TYPES.has(data.type)) {
          this.enqueueFrame(ws, data);
          return;
        }
        this.runFrame(ws, data);
      });

      ws.on('close', () => {
        clearTimeout(ws.authTimer);
        const left = (this.socketsPerIp.get(ws.ipKey) || 1) - 1;
        if (left > 0) this.socketsPerIp.set(ws.ipKey, left);
        else this.socketsPerIp.delete(ws.ipKey);
        Promise.resolve(this.handleDisconnect(ws)).catch((err) =>
          console.error('[WS Error] Разрыв соединения обработан с ошибкой:', err.message)
        );
      });

      ws.on('error', (err) => {
        console.error('[WS Client Error]:', err.message);
      });
    });

    // Heartbeat to detect dead connections. unref'd so it never becomes the
    // only reason the process stays alive — otherwise Node cannot exit after
    // the server closes, which is what a test run does.
    this.heartbeat = setInterval(() => {
      if (!this.wss) return;
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
    this.heartbeat.unref();

    // Токен, которым соединение вошло, мог быть отозван: смена пароля, роли,
    // отключение. Соединение хранит снимок учётной записи на момент входа —
    // раз в минуту он сверяется с базой и заменяется свежим, а недействительное
    // соединение закрывается.
    this.revalidator = setInterval(() => {
      this.revalidateAll().catch((err) => console.warn('[WS] перепроверка сессий не удалась:', err.message));
    }, revalidateIntervalMs());
    this.revalidator.unref();

    console.log('[WS Server] Realtime WebSocket gateway ready at /ws');
  }

  replyRateLimited(ws, data, retryAfterMs) {
    if (!ACK_TYPES.has(data.type) || !takeReplyBudget(ws)) return;
    safeSend(ws, errorFrame(data.type, data, { message: RATE_LIMITED_MESSAGE, code: 'RATE_LIMITED', retryable: true }, { retry_after_ms: retryAfterMs }));
  }

  // Кадр переписки встаёт в очередь своего сокета (G1). Пользователь
  // запоминается на момент получения: кадр, пришедший до обычного закрытия
  // сокета, обрабатывается (настольный клиент мог отправить сообщение и сразу
  // закрыться); отозванный сокет (revokeSocket) свои кадры теряет.
  enqueueFrame(ws, data) {
    if (!ws.lane) ws.lane = { tail: Promise.resolve(), pending: 0 };
    const lane = ws.lane;
    if (lane.pending >= maxQueuedFrames()) {
      this.replyRateLimited(ws, data, QUEUE_FULL_RETRY_MS);
      return;
    }
    lane.pending += 1;
    const userAtArrival = this.socketUser.get(ws) || null;
    const run = () => this.runFrame(ws, data, userAtArrival).finally(() => { lane.pending -= 1; });
    lane.tail = lane.tail.then(run, run);
  }

  // Обработчик обращается к двум базам и потому асинхронен. Отказ обещания без
  // перехвата завершает процесс Node — одно кривое сообщение роняло бы сервер
  // для всех. Зависший обработчик держит очередь сокета не дольше
  // frameTimeoutMs.
  runFrame(ws, data, userAtArrival = null) {
    if (ws.revoked) return Promise.resolve();
    const work = Promise.resolve()
      .then(() => this.handleMessage(ws, data, userAtArrival))
      .catch((err) => {
        console.error('[WS Error] Обработка сообщения не удалась:', err.message);
        const frame = ACK_TYPES.has(data.type)
          ? errorFrame(data.type, data, { message: 'Ошибка обработки запроса', code: 'INTERNAL_ERROR', retryable: true })
          : { type: 'error', message: 'Ошибка обработки запроса' };
        safeSend(ws, frame);
      });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[WS] кадр ${String(data.type).slice(0, 40)} обрабатывается дольше ${frameTimeoutMs()} мс — очередь сокета идёт дальше`);
        resolve();
      }, frameTimeoutMs());
      timer.unref?.();
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  // Кадр звука: 4 байта — кому, дальше сам звук. Пересылается только между
  // участниками разговора, который обе стороны подтвердили: иначе любой
  // авторизованный пользователь мог бы вещать кому угодно.
  relayAudioFrame(ws, raw) {
    const sender = this.socketUser.get(ws);
    if (!sender || raw.length < 5) return;

    const targetUserId = raw.readUInt32BE(0);
    if (this.activeCalls.get(sender.id) !== targetUserId) return;

    const out = Buffer.allocUnsafe(raw.length);
    out.writeUInt32BE(sender.id, 0);
    raw.copy(out, 4, 4);

    for (const socket of this.userSockets.get(targetUserId) || []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(out, { binary: true });
    }
  }

  setCallPair(a, b) {
    // Новый разговор вытесняет прежние пары обоих участников — иначе у
    // третьего осталась бы «висящая» половина пары.
    this.clearCallPair(a);
    this.clearCallPair(b);
    this.activeCalls.set(a, b);
    this.activeCalls.set(b, a);
  }

  clearCallPair(a) {
    const b = this.activeCalls.get(a);
    this.activeCalls.delete(a);
    if (b !== undefined && this.activeCalls.get(b) === a) this.activeCalls.delete(b);
  }

  hasPendingOffer(callerId, targetId) {
    const offer = this.pendingOffers.get(callerId);
    return Boolean(offer && offer.targetId === targetId && Date.now() - offer.at < CALL_OFFER_TTL_MS);
  }

  // Единственное законное основание разобрать кадр крупнее MAX_TEXT_FRAME_BYTES:
  // у отправителя уже есть открытый сеанс удалённого стола (файл, список
  // экранов, буфер обмена) или разговор/вызов (ICE-кандидаты). Это состояние
  // сервер вёл сам — не то, что написал клиент в этом же кадре.
  isOversizedFrameAllowedFor(userId) {
    if (RemoteDesktopService.findOpenSessionsForUser(userId).length) return true;
    if (this.activeCalls.has(userId)) return true;
    if (this.pendingOffers.has(userId)) return true;
    for (const offer of this.pendingOffers.values()) {
      if (offer.targetId === userId) return true;
    }
    return false;
  }

  async handleMessage(ws, msg, userAtArrival = null) {
    const { type } = msg;

    // 1. Authentication
    if (type === 'auth') {
      // Считаются только неудачные попытки: офис за одним адресом после
      // перезапуска сервера переподключается целиком, и это не подбор.
      // WebSocket проверяет только подписанный токен, не пароль, — подбором
      // пароля этот путь не является, и счётчик у него свой, отдельный от
      // входа по паролю. Ключ — по сети /64, как и у остальных пределов (Р4-02).
      const limitKey = `ws_auth:${ws.ipKey || rateLimitIpKey(ws.remoteIp)}`;
      if (isRateLimited(limitKey, AUTH_LIMIT)) {
        return ws.send(JSON.stringify({
          type: 'auth_error',
          code: 'RATE_LIMITED',
          message: 'Слишком много попыток. Повторите через минуту.'
        }));
      }

      // resolveSession проверяет и подпись, и то, что учётная запись всё ещё
      // действует, и поколение токена: выданный до смены пароля сюда не пройдёт.
      const user = await AuthService.resolveSession(msg.token);
      if (!user) {
        // Протухший или отозванный, но ПОДПИСАННЫЙ нами токен — это обычное
        // утреннее переподключение (токен истёк за ночь), а не подбор: предел
        // ws_auth оно не расходует, иначе офис за одним NAT запирал бы сам себя
        // на 9:00 (проверка раунда 4, M7). Считаем только по-настоящему
        // недействительный токен: неверная подпись или мусор.
        if (!AuthService.signatureValid(msg.token)) {
          registerFailure(limitKey, AUTH_LIMIT);
          require('../services/security-monitor.service').recordWsAuthFailure(ws.remoteIp);
        }
        return ws.send(JSON.stringify({
          type: 'auth_error',
          code: 'INVALID_TOKEN',
          message: 'Недействительный токен авторизации'
        }));
      }
      if (user.must_change_password) {
        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Требуется смена пароля перед продолжением работы', code: 'MUST_CHANGE_PASSWORD' }));
      }

      if ((this.userSockets.get(user.id)?.size || 0) >= MAX_SOCKETS_PER_USER && !this.userSockets.get(user.id)?.has(ws)) {
        return ws.send(JSON.stringify({ type: 'auth_error', code: 'TOO_MANY_SESSIONS', message: 'Слишком много открытых окон. Закройте лишние.' }));
      }

      // Повторная авторизация того же сокета под другим именем не должна
      // оставлять его в списках прежнего владельца.
      if (this.socketUser.has(ws)) this.unbindSocket(ws);
      ws.authToken = msg.token;

      clearTimeout(ws.authTimer);
      this.socketUser.set(ws, user);
      if (!this.userSockets.has(user.id)) {
        this.userSockets.set(user.id, new Set());
      }
      this.userSockets.get(user.id).add(ws);

      // Авторизация по WebSocket лишь ОБНОВЛЯЕТ уже знакомый адрес, но не
      // заводит новый: подпись токена — не предъявление секрета, а украденный
      // живой токен не должен сажать адрес атакующего в «знакомые» (I-2).
      require('../services/trusted-sources.service').recordAsync(user.id, ws.ipKey || rateLimitIpKey(ws.remoteIp), { allowCreate: false });

      // Только что подключился — значит, за компьютером. «Не беспокоить»,
      // включённое раньше, остаётся.
      this.presence.set(user.id, 'online');
      const status = this.effectiveStatus(user.id);
      user.status = status;
      await UserService.updateStatus(user.id, status);

      ws.send(JSON.stringify({ type: 'auth_success', user }));
      ws.send(JSON.stringify(this.wakeStateFor(user.id)));

      // Получатель снова на связи: всё, что пришло ему, пока его не было,
      // теперь доставлено — и авторы, кто в сети, узнают об этом сразу.
      this.announcePendingDeliveries(user.id);

      // Broadcast online status to all connected clients
      this.broadcast({
        type: 'user_status_changed',
        userId: user.id,
        user_id: user.id,
        status,
        customStatus: user.custom_status
      });

      console.log(`[WS] User connected: ${user.full_name} (#${user.id})`);
      return;
    }

    const currentUser = this.socketUser.get(ws)
      || (userAtArrival && !ws.revoked && ws.readyState !== WebSocket.OPEN ? userAtArrival : null);
    if (!currentUser) {
      return safeSend(ws, { type: 'error', message: 'Необходима авторизация' });
    }

    // 2. Chat messaging
    if (type === 'send_message' || type === 'direct_message' || type === 'channel_message') {
      let { conversationType, targetId, text, msgType, replyToId, metadata, recipient_id, channel_id } = msg;
      const clientMsgId = msg.client_msg_id;

      if (!conversationType) {
        if (type === 'channel_message' || channel_id) conversationType = 'channel';
        else conversationType = 'direct';
      }
      if (!targetId) {
        targetId = recipient_id || channel_id;
      }

      let savedMsg;
      let duplicate = false;
      try {
        ({ message: savedMsg, duplicate } = await MessageService.sendMessageIdempotent({
          conversationType,
          targetId: Number(targetId),
          senderId: currentUser.id,
          text,
          type: msgType || 'text',
          replyToId: replyToId ? Number(replyToId) : null,
          metadata,
          clientMsgId,
          senderProfile: currentUser
        }));
      } catch (err) {
        // Текст возвращается клиенту: поле ввода у него уже очищено, и без
        // этого сообщение пропало бы без следа. client_msg_id — чтобы клиент
        // нашёл в своей очереди, какая именно отправка не удалась; недопустимое
        // значение обратно не отражается. code и retryable — повторять ли (G3).
        return safeSend(ws, errorFrame('send_message', { text, client_msg_id: clientMsgId }, MessageService.describeError(err)));
      }

      // Сообщение уже сохранено: что бы ни случилось с рассылкой, автор
      // получает подтверждение, а не ошибку (G3).
      try {
        this.publishNewMessage(savedMsg, { duplicate });
      } catch (err) {
        console.error('[WS Error] рассылка сохранённого сообщения не удалась:', err.message);
        const specific = savedMsg.conversation_type === 'channel' ? 'channel_message' : 'direct_message';
        this.sendToUser(currentUser.id, { type: specific, message: savedMsg });
        this.sendToUser(currentUser.id, { type: 'new_message', message: savedMsg });
      }
      return;
    }

    // 2b. Правка своего сообщения (Rocket.Chat: Allow Message Editing).
    if (type === 'edit_message') {
      try {
        const updated = await MessageService.editMessage({
          messageId: Number(msg.messageId),
          actorId: currentUser.id,
          text: msg.text
        });
        for (const userId of conversationRecipients(updated)) {
          this.sendToUser(userId, { type: 'message_updated', message: updated });
        }
      } catch (err) {
        safeSend(ws, errorFrame('edit_message', msg, MessageService.describeError(err)));
      }
      return;
    }

    // 2c. Удаление своего сообщения; супер-администратор — чужого, в целях
    // модерации, без окна времени, со следом в аудите.
    if (type === 'delete_message') {
      const isSuperAdminUser = Boolean(currentUser.permissions?.is_admin) && !currentUser.permissions?.is_scoped_admin;
      try {
        const deleted = await MessageService.deleteMessage({
          messageId: Number(msg.messageId),
          actorId: currentUser.id,
          isSuperAdmin: isSuperAdminUser
        });
        if (isSuperAdminUser && !deleted.alreadyDeleted && deleted.sender_id !== currentUser.id) {
          AuditService.log({
            userId: currentUser.id,
            action: 'message_deleted_by_admin',
            ip: ws.remoteIp,
            details: {
              messageId: deleted.id,
              authorId: deleted.sender_id,
              conversationType: deleted.conversation_type,
              targetId: deleted.target_id
            }
          });
        }
        this.publishDeleted(ws, deleted);
      } catch (err) {
        safeSend(ws, errorFrame('delete_message', msg, MessageService.describeError(err)));
      }
      return;
    }

    // 2d. Отзыв отправки по ключу (G9): «если этот client_msg_id придёт — не
    // сохраняй; если уже сохранён — удали». Ответ — message_cancelled этому
    // сокету; удаление, если было, рассылается обычным message_deleted.
    if (type === 'cancel_message') {
      try {
        const { messageId, deleted } = await MessageService.cancelClientMessage({
          senderId: currentUser.id,
          clientMsgId: msg.client_msg_id
        });
        if (deleted) this.publishDeleted(ws, deleted);
        safeSend(ws, { type: 'message_cancelled', client_msg_id: msg.client_msg_id, messageId });
      } catch (err) {
        const extra = Number.isInteger(err.messageId) ? { messageId: err.messageId } : {};
        safeSend(ws, errorFrame('cancel_message', msg, MessageService.describeError(err), extra));
      }
      return;
    }

    // 3. Mark messages as read
    if (type === 'mark_read') {
      const conversationType = msg.conversationType === 'channel' ? 'channel' : 'direct';
      const targetId = Number(msg.targetId);
      if (!Number.isFinite(targetId)) return;
      const res = MessageService.markAsRead(conversationType, targetId, currentUser.id);

      // Рассылается только когда действительно что-то прочитано. Пустая
      // отметка в ответ на пустую отметку — это и был бесконечный обмен между
      // двумя открытыми диалогами.
      if (conversationType === 'direct' && res.messageIds?.length) {
        this.sendToUser(targetId, {
          type: 'messages_read',
          byUserId: currentUser.id,
          messageIds: res.messageIds
        });
      }
      return;
    }

    // 4. Typing indicator
    if (type === 'typing') {
      const conversationType = msg.conversationType === 'channel' ? 'channel' : 'direct';
      const targetId = Number(msg.targetId);
      if (!Number.isFinite(targetId)) return;
      const payload = {
        type: 'user_typing',
        userId: currentUser.id,
        userName: currentUser.full_name,
        conversationType,
        targetId,
        isTyping: !!msg.isTyping
      };

      if (conversationType === 'channel') {
        // Только участникам канала: раньше «печатает…» уходило всем
        // подключённым, включая тех, кто канал не видит.
        const members = MessageService.getChannelMemberIds(targetId);
        if (!members.includes(currentUser.id)) return;
        for (const memberId of members) {
          if (memberId !== currentUser.id) this.sendToUser(memberId, payload);
        }
      } else if (targetId !== currentUser.id) {
        this.sendToUser(targetId, payload);
      }
      return;
    }

    // 5. Статус. Сигнал системы о присутствии и переключатель «Не беспокоить».
    //    set_status/status_update — прежний формат клиентов, установленных до
    //    этого изменения: «в сети» и «отошёл» из него принимаются как сигнал
    //    системы, «не беспокоить» — как включение режима, «не в сети» —
    //    никак.
    if (type === 'presence' || type === 'set_dnd' || type === 'set_status' || type === 'status_update') {
      if (msg.customStatus !== undefined) {
        currentUser.custom_status = msg.customStatus === null ? null : String(msg.customStatus).slice(0, CUSTOM_STATUS_MAX);
      }

      const previous = this.effectiveStatus(currentUser.id);
      const customChanged = msg.customStatus !== undefined;
      if (type === 'set_dnd' || ((type === 'set_status' || type === 'status_update') && msg.status === 'dnd')) {
        const enabled = type === 'set_dnd' ? Boolean(msg.enabled) : true;
        if (enabled) this.dndUsers.add(currentUser.id);
        else this.dndUsers.delete(currentUser.id);
      } else {
        const state = String(type === 'presence' ? msg.state : msg.status || '');
        if (!SYSTEM_PRESENCE.has(state)) return;
        this.presence.set(currentUser.id, state);
      }

      await this.publishStatus(currentUser, customChanged ? null : previous);
      return;
    }

    // Побудка собеседника.
    if (type === 'wake_send') return this.sendWake(currentUser, msg);

    // 6. Voice call signalling
    if (['call_offer', 'call_answer', 'ice_candidate', 'call_end', 'call_rejected'].includes(type)) {
      const targetUserId = Number(msg.targetUserId);
      if (!Number.isFinite(targetUserId) || targetUserId === currentUser.id) return;

      // Placing a call is a per-role permission (can_call); hanging up and
      // rejecting stay open so a call already in progress can always be
      // ended, whatever the caller's role became meanwhile.
      if (type === 'call_offer') {
        const fresh = await this.freshUser(ws);
        if (!fresh) return;
        if (!fresh.permissions?.can_call) {
          ws.send(JSON.stringify({
            type: 'call_denied',
            reason: 'Звонки не разрешены для вашей роли. Обратитесь к администратору.'
          }));
          return;
        }
        // «Не беспокоить» — значит не звонить: раньше вызов проходил, и один
        // сотрудник мог звонить коллеге без остановки.
        if (this.dndUsers.has(targetUserId)) {
          ws.send(JSON.stringify({
            type: 'call_unavailable',
            targetUserId,
            reason: 'У сотрудника включено «Не беспокоить»'
          }));
          return;
        }
        // Nobody is at the other end — tell the caller instead of ringing out.
        if (!this.userSockets.get(targetUserId)?.size) {
          ws.send(JSON.stringify({
            type: 'call_unavailable',
            targetUserId,
            reason: 'Сотрудник сейчас не в сети'
          }));
          return;
        }
        this.pendingOffers.set(currentUser.id, { targetId: targetUserId, at: Date.now() });
      }

      // Разговор начинается, только когда вызываемый отвечает на настоящий
      // вызов. Раньше «ответ» принимался от кого угодно и переписывал пару —
      // посторонний мог перехватить звук чужого разговора.
      if (type === 'call_answer') {
        if (!this.hasPendingOffer(targetUserId, currentUser.id)) return;
        this.pendingOffers.delete(targetUserId);
        this.setCallPair(currentUser.id, targetUserId);
      }

      // Отказ и завершение касаются только разговора с тем, кому адресованы.
      // Занятый сотрудник автоматически отказывает третьему — и этот отказ
      // обрывал звук его текущего разговора.
      if (type === 'call_rejected' || type === 'call_end') {
        if (this.hasPendingOffer(targetUserId, currentUser.id)) this.pendingOffers.delete(targetUserId);
        if (this.pendingOffers.get(currentUser.id)?.targetId === targetUserId) this.pendingOffers.delete(currentUser.id);
        if (this.activeCalls.get(currentUser.id) === targetUserId) this.clearCallPair(currentUser.id);
      }

      // Кандидаты соединения — только внутри вызова или разговора.
      if (type === 'ice_candidate') {
        const related =
          this.activeCalls.get(currentUser.id) === targetUserId ||
          this.hasPendingOffer(currentUser.id, targetUserId) ||
          this.hasPendingOffer(targetUserId, currentUser.id);
        if (!related) return;
      }

      this.sendToUser(targetUserId, {
        ...msg,
        targetUserId,
        senderId: currentUser.id,
        senderName: currentUser.full_name
      });
      return;
    }

    // 7. Remote Desktop Plugin Signalling
    if (type === 'rd_request') {
      const targetUserId = Number(msg.targetUserId);
      // Права — по базе, а не по снимку на момент входа: пониженный
      // администратор не должен продолжать открывать чужие экраны.
      const operator = await this.freshUser(ws);
      if (!operator) return;

      // Viewing a colleague's screen is granted per role by an administrator
      // (can_remote_control). The employee's own consent prompt below is a
      // second gate, not the first one — without this check any employee
      // could pop that prompt on any other employee at will.
      // Общий выключатель в консоли: удалённый стол — функция повышенного риска,
      // и компания может отключить её целиком, не трогая права ролей.
      if (!isRemoteDesktopEnabled()) {
        ws.send(JSON.stringify({ type: 'rd_denied', reason: 'Удалённый рабочий стол отключён администратором' }));
        return;
      }
      if (!operator.permissions?.can_remote_control) {
        ws.send(JSON.stringify({
          type: 'rd_denied',
          reason: 'Удалённый доступ к рабочим столам не разрешён для вашей роли. Обратитесь к администратору.'
        }));
        return;
      }
      if (!Number.isFinite(targetUserId) || targetUserId === currentUser.id) {
        ws.send(JSON.stringify({ type: 'rd_denied', reason: 'Нельзя подключиться к собственному рабочему столу' }));
        return;
      }
      // Иначе оператор ждал бы подтверждения, которое некому дать.
      if (!this.isUserOnline(targetUserId)) {
        ws.send(JSON.stringify({ type: 'rd_denied', reason: 'Сотрудник сейчас не в сети' }));
        return;
      }
      // Администратор подразделения подключается только к сотрудникам своей
      // зоны: право на удалённый доступ не должно распространяться на всю
      // компанию, включая руководство других подразделений.
      if (operator.permissions?.is_scoped_admin) {
        const target = await UserService.getUserById(targetUserId);
        const OrgService = require('../services/org.service');
        const allowed = operator.admin_scope_dept_id
          ? new Set(await OrgService.getSubtreeDepartmentIds(operator.admin_scope_dept_id))
          : new Set();
        if (!target || !allowed.has(Number(target.department_id))) {
          ws.send(JSON.stringify({ type: 'rd_denied', reason: 'Сотрудник вне вашей зоны ответственности' }));
          return;
        }
      }
      // Один ожидающий запрос на пару: иначе окно согласия можно было
      // показывать снова и снова, пока его не нажмут.
      const pending = RemoteDesktopService.findOpenSessionsForUser(currentUser.id).find(
        (sess) => sess.operatorId === currentUser.id && sess.targetUserId === targetUserId && sess.status === 'REQUESTED'
      );
      if (pending) {
        ws.send(JSON.stringify({ type: 'rd_denied', reason: 'Запрос этому сотруднику уже отправлен — дождитесь ответа' }));
        return;
      }

      const session = RemoteDesktopService.createSession(currentUser.id, targetUserId);
      this.scheduleRdExpiry(session);
      AuditService.log({
        userId: currentUser.id,
        action: 'remote_desktop_request',
        ip: ws.remoteIp,
        details: { sessionId: session.sessionId, targetUserId }
      });

      // Send prompt modal to the target employee's desktop client
      this.sendToUser(targetUserId, {
        type: 'rd_prompt',
        sessionId: session.sessionId,
        operatorId: currentUser.id,
        operatorName: currentUser.full_name,
        operatorJobTitle: currentUser.job_title
      });

      // Acknowledge operator
      ws.send(JSON.stringify({
        type: 'rd_requested',
        sessionId: session.sessionId,
        targetUserId
      }));
      return;
    }

    if (type === 'rd_response') {
      const { sessionId, accepted } = msg;
      const session = RemoteDesktopService.getSession(sessionId);
      // Решение принимает только тот, чей экран просят, и только пока запрос
      // ждёт ответа. Иначе оператор подтверждал доступ сам себе, а запоздалое
      // «Разрешить» на отменённый запрос снова открывало сеанс.
      if (!session || session.targetUserId !== currentUser.id || session.status !== 'REQUESTED') return;

      const accessLevel = accepted && msg.accessLevel === 'full' ? 'full' : 'view_only';
      session.accessLevel = accepted ? accessLevel : null;
      RemoteDesktopService.updateStatus(sessionId, accepted ? 'ACCEPTED' : 'REJECTED');
      AuditService.log({
        userId: currentUser.id,
        action: accepted ? 'remote_desktop_accepted' : 'remote_desktop_rejected',
        ip: ws.remoteIp,
        details: {
          sessionId,
          operatorId: session.operatorId,
          // Управление или только просмотр — важнейшая часть записи.
          accessLevel: accepted ? accessLevel : null
        }
      });
      // Notify operator of the decision
      // Причина отказа — короткий код из известного списка: «сотрудник уже в
      // сеансе» и «не запустилась трансляция» оператору важно отличать от
      // обычного «нет».
      const reason = !accepted && RD_DECLINE_REASONS.has(msg.reason) ? msg.reason : undefined;
      this.sendToUser(session.operatorId, {
        type: 'rd_response',
        sessionId,
        accepted: Boolean(accepted),
        ...(reason ? { reason } : {}),
        accessLevel,
        targetUserId: currentUser.id,
        targetName: currentUser.full_name
      });
      return;
    }

    if (RD_RELAY_TYPES.has(type)) {
      const { sessionId } = msg;

      // Relay only within a session both parties actually accepted — a
      // client-supplied sessionId alone must not be enough to steer input or
      // media at another user. See
      // docs/designs/auth-access-control-remediation.md item 13.
      const session = sessionId ? RemoteDesktopService.getSession(sessionId) : null;
      const isOperator = session && session.operatorId === currentUser.id;
      const isTarget = session && session.targetUserId === currentUser.id;
      if (!session || (!isOperator && !isTarget)) return;

      if (type === 'rd_end') {
        // Отменить можно и ещё не принятый запрос.
        if (session.status !== 'REQUESTED' && session.status !== 'ACCEPTED') return;
      } else if (session.status !== 'ACCEPTED') {
        return;
      }

      if (isOperator && session.accessLevel !== 'full' && OPERATOR_CONTROL_TYPES.has(type)) return;

      // Буфер обмена — в обе стороны только в сеансе с полным доступом и только
      // после того, как оператор попросил, а сотрудник согласился. Раньше
      // сотрудник мог сам «включить» общий буфер и получать всё, что копирует
      // администратор у себя.
      if (type === 'rd_clipboard_mode' || type === 'rd_clipboard') {
        if (session.accessLevel !== 'full') return;
        if (type === 'rd_clipboard_mode') {
          const enabled = Boolean(msg.enabled);
          if (isOperator) {
            session.clipboardRequested = enabled;
            if (!enabled) session.clipboardEnabled = false;
          } else if (enabled) {
            if (!session.clipboardRequested) return;
            session.clipboardEnabled = true;
          } else {
            session.clipboardEnabled = false;
            session.clipboardRequested = false;
          }
        } else if (!session.clipboardEnabled) {
          return;
        }
      }

      // Передача файла на чужую машину — то, о чём владелец компьютера должен
      // иметь возможность узнать постфактум, поэтому пишется в журнал.
      if (type === 'rd_file') {
        AuditService.log({
          userId: currentUser.id,
          action: 'remote_desktop_file_sent',
          ip: ws.remoteIp,
          // Размер, названный клиентом, проверить нельзя — рядом пишется объём,
          // который сервер действительно переслал.
          details: { sessionId, fileName: String(msg.fileName || '').slice(0, 260), declaredSize: msg.size || null, relayedBytes: Buffer.byteLength(JSON.stringify(msg)) }
        });
      }

      // Получатель определяется сеансом, а не полем, которое прислал клиент:
      // иначе участник сеанса мог направить эти сообщения кому угодно.
      const recipientId = isOperator ? session.targetUserId : session.operatorId;
      this.sendToUser(recipientId, {
        ...msg,
        targetUserId: recipientId,
        fromUserId: currentUser.id
      });
      if (type === 'rd_end') {
        this.finishRdSession(session, currentUser.id);
      }
      return;
    }
  }

  // Учётная запись соединения по свежим данным. Недействительное соединение
  // закрывается, и вызывающий получает null.
  async freshUser(ws) {
    const fresh = ws.authToken ? await AuthService.resolveSession(ws.authToken) : null;
    if (!fresh || !this.socketUser.has(ws)) {
      this.revokeSocket(ws, 'Сессия недействительна — войдите заново');
      return null;
    }
    const current = this.socketUser.get(ws);
    // Статус и собственный статус живут в памяти соединения — их не терять.
    fresh.status = current.status;
    fresh.custom_status = current.custom_status ?? fresh.custom_status;
    this.socketUser.set(ws, fresh);
    return fresh;
  }

  async revalidateAll() {
    for (const ws of [...this.socketUser.keys()]) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      await this.freshUser(ws);
    }
  }

  // Закрыть соединение сразу: сначала оно перестаёт обрабатывать сообщения,
  // потом закрывается, а если клиент не отвечает на закрытие — обрывается.
  revokeSocket(ws, reason) {
    if (ws.revoked) return;
    ws.revoked = true;
    try { ws.send(JSON.stringify({ type: 'server_disconnect', reason })); } catch {}
    try { ws.close(4003, 'Session revoked'); } catch {}
    const killer = setTimeout(() => { try { ws.terminate(); } catch {} }, 1000);
    killer.unref?.();
  }

  scheduleRdExpiry(session) {
    const expire = setTimeout(() => {
      const current = RemoteDesktopService.getSession(session.sessionId);
      if (!current || current.status !== 'REQUESTED') return;
      const payload = { type: 'rd_end', sessionId: session.sessionId, reason: 'Запрос истёк без ответа' };
      this.sendToUser(current.targetUserId, { ...payload, fromUserId: current.operatorId });
      this.sendToUser(current.operatorId, { ...payload, fromUserId: current.targetUserId });
      this.finishRdSession(current, current.operatorId);
    }, rdRequestTtlMs());
    expire.unref?.();
    // Сеанс не длится бесконечно: забытый открытым доступ к чужому экрану —
    // тоже доступ.
    const cap = setTimeout(() => {
      const current = RemoteDesktopService.getSession(session.sessionId);
      if (!current || current.status !== 'ACCEPTED') return;
      const payload = { type: 'rd_end', sessionId: session.sessionId, reason: 'Сеанс завершён по времени' };
      this.sendToUser(current.targetUserId, { ...payload, fromUserId: current.operatorId });
      this.sendToUser(current.operatorId, { ...payload, fromUserId: current.targetUserId });
      this.finishRdSession(current, current.operatorId);
    }, RD_MAX_SESSION_MS);
    cap.unref?.();
  }

  finishRdSession(session, endedByUserId) {
    RemoteDesktopService.endSession(session.sessionId);
    AuditService.log({
      userId: endedByUserId,
      action: 'remote_desktop_ended',
      details: {
        sessionId: session.sessionId,
        durationSeconds: session.createdAt
          ? Math.round((Date.now() - new Date(session.createdAt).getTime()) / 1000)
          : null
      }
    });
  }

  unbindSocket(ws) {
    const user = this.socketUser.get(ws);
    if (!user) return null;
    this.socketUser.delete(ws);
    const sockets = this.userSockets.get(user.id);
    if (!sockets) return { user, lastSocket: true };
    sockets.delete(ws);
    if (sockets.size === 0) {
      this.userSockets.delete(user.id);
      return { user, lastSocket: true };
    }
    return { user, lastSocket: false };
  }

  async handleDisconnect(ws) {
    const unbound = this.unbindSocket(ws);
    if (!unbound || !unbound.lastSocket) return;
    const { user } = unbound;

    // Оборвалась связь — разговор окончен, и собеседник должен об этом
    // узнать: иначе у него идёт таймер разговора, в котором никто не говорит.
    const peer = this.activeCalls.get(user.id);
    if (peer !== undefined) {
      this.clearCallPair(user.id);
      this.sendToUser(peer, { type: 'call_end', senderId: user.id, senderName: user.full_name, reason: 'connection_lost' });
    }
    const outgoing = this.pendingOffers.get(user.id);
    if (outgoing) {
      this.pendingOffers.delete(user.id);
      this.sendToUser(outgoing.targetId, { type: 'call_end', senderId: user.id, senderName: user.full_name, reason: 'connection_lost' });
    }
    for (const [callerId, offer] of this.pendingOffers) {
      if (offer.targetId === user.id) {
        this.pendingOffers.delete(callerId);
        this.sendToUser(callerId, { type: 'call_end', senderId: user.id, senderName: user.full_name, reason: 'connection_lost' });
      }
    }

    // Сеанс удалённого доступа без одного из участников продолжаться не
    // должен: ни трансляция экрана, ни включённый ввод у второго.
    for (const session of RemoteDesktopService.findOpenSessionsForUser(user.id)) {
      const otherId = session.operatorId === user.id ? session.targetUserId : session.operatorId;
      this.sendToUser(otherId, {
        type: 'rd_end',
        sessionId: session.sessionId,
        fromUserId: user.id,
        reason: 'Второй участник потерял связь'
      });
      this.finishRdSession(session, user.id);
    }

    // Mark user as offline
    this.presence.delete(user.id);
    await UserService.updateStatus(user.id, 'offline').catch((err) =>
      console.warn('[WS] не удалось отметить уход:', err.message)
    );
    this.broadcast({
      type: 'user_status_changed',
      userId: user.id,
      user_id: user.id,
      status: 'offline'
    });
    console.log(`[WS] User disconnected: ${user.full_name} (#${user.id})`);
  }

  /**
   * Надгробие участникам переписки; updated_at — время удаления (G8). Повтор
   * удаления уже удалённого (alreadyDeleted) — подтверждение только этому
   * сокету: остальные надгробие уже получили (G4).
   */
  publishDeleted(ws, deleted) {
    const frame = {
      type: 'message_deleted',
      messageId: deleted.id,
      conversationType: deleted.conversation_type,
      targetId: deleted.target_id,
      updated_at: deleted.updated_at
    };
    if (deleted.alreadyDeleted) {
      safeSend(ws, frame);
      return;
    }
    for (const userId of conversationRecipients(deleted)) this.sendToUser(userId, frame);
  }

  isUserOnline(userId) {
    const sockets = this.userSockets.get(Number(userId));
    return Boolean(sockets && sockets.size > 0);
  }

  /**
   * Рассылка только что сохранённого сообщения — одна для WS и REST:
   * direct_message/channel_message и следом new_message каждому участнику;
   * для личного — отметка «доставлено», если получатель на связи.
   *
   * Повтор отправки (тот же client_msg_id) — не новое сообщение: эхо уходит
   * только сокетам самого автора как подтверждение, получатели второй раз
   * его не получают (настольный клиент показал бы уведомление повторно).
   */
  publishNewMessage(message, { duplicate = false } = {}) {
    const specific = message.conversation_type === 'channel' ? 'channel_message' : 'direct_message';
    const senderId = Number(message.sender_id);
    let recipients;
    if (duplicate) recipients = [senderId];
    else if (message.conversation_type === 'channel') recipients = MessageService.getChannelMemberIds(message.target_id);
    else recipients = [Number(message.target_id), senderId];

    for (const userId of recipients) {
      this.sendToUser(userId, { type: specific, message });
      this.sendToUser(userId, { type: 'new_message', message });
    }

    if (!duplicate && message.conversation_type === 'direct') this.markDeliveredIfOnline(message);
  }

  // Получатель личного сообщения на связи — «доставлено» ставится сразу.
  markDeliveredIfOnline(message) {
    const recipientId = Number(message.target_id);
    if (!this.isUserOnline(recipientId)) return;
    const now = MessageService.markDelivered(message.id, recipientId);
    this.sendToUser(Number(message.sender_id), {
      type: 'message_status_updated',
      messageId: message.id,
      status: 'delivered',
      userId: recipientId,
      timestamp: now
    });
  }

  // S3: при входе получателя — его недоставленные личные сообщения
  // становятся доставленными, авторам уходит тот же message_status_updated,
  // что и при отправке получателю в сети (по кадру на сообщение).
  announcePendingDeliveries(recipientId) {
    let result;
    try {
      result = MessageService.markPendingDelivered(recipientId);
    } catch (err) {
      console.warn('[WS] отметка доставки при входе не удалась:', err.message);
      return;
    }
    for (const { messageId, senderId } of result.delivered) {
      this.sendToUser(senderId, {
        type: 'message_status_updated',
        messageId,
        status: 'delivered',
        userId: Number(recipientId),
        timestamp: result.timestamp
      });
    }
  }

  sendToUser(userId, data) {
    const sockets = this.userSockets.get(Number(userId));
    if (!sockets) return false;
    const payload = JSON.stringify(data);
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN) {
        s.send(payload);
      }
    }
    return true;
  }

  // Только тем, кто вошёл. Рассылка по всем открытым сокетам доходила и до
  // соединений, не прошедших авторизацию: подключиться из разрешённой сети
  // и слушать события компании мог кто угодно.
  broadcast(data, excludeWs = null) {
    const payload = JSON.stringify(data);
    for (const client of this.socketUser.keys()) {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // Служебные события — стук устройств, заявки на регистрацию — нужны только
  // администраторам, а для остальных это утечка.
  broadcastToAdmins(data) {
    const payload = JSON.stringify(data);
    for (const [client, user] of this.socketUser) {
      if (user.permissions?.is_admin && !user.permissions?.is_scoped_admin && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  getOnlineConnectionsList() {
    const list = [];
    for (const [ws, user] of this.socketUser.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        list.push({
          userId: user.id,
          username: user.username,
          full_name: user.full_name,
          uin: user.uin,
          job_title: user.job_title || 'Сотрудник',
          department_name: user.department_name || 'Департамент',
          ip: ws.remoteIp || '127.0.0.1',
          connectedAt: ws.connectedAt || new Date().toISOString(),
          clientType: ws.clientType || 'CentyChat Client',
          status: user.status || 'online',
          // Was Math.random(): the admin's "Активные подключения" table
          // reported a healthy 4-12 ms for every session regardless of the
          // real link. Nothing measures round-trip time yet, so it is null
          // rather than invented.
          pingMs: null
        });
      }
    }
    return list;
  }

  disconnectUser(userId, reason = 'Сессия принудительно завершена администратором через панель управления') {
    const sockets = this.userSockets.get(Number(userId));
    if (sockets && sockets.size > 0) {
      for (const ws of [...sockets]) this.revokeSocket(ws, reason);
      return true;
    }
    return false;
  }

  // Продление токена: соединения, вошедшие старым токеном, переходят на новый.
  // Иначе ближайшая перепроверка закрыла бы их — старый токен уже отозван.
  replaceSocketToken(oldToken, newToken) {
    for (const ws of this.socketUser.keys()) {
      if (ws.authToken === oldToken) ws.authToken = newToken;
    }
  }

  // Выход из системы закрывает только соединения этого токена — другие
  // устройства сотрудника остаются на связи.
  disconnectSocketsWithToken(token, reason) {
    for (const ws of [...this.socketUser.keys()]) {
      if (ws.authToken === token) this.revokeSocket(ws, reason);
    }
  }

  // Удалённый стол выключен в консоли — идущие сеансы и запросы завершаются.
  endAllRemoteSessions(reason) {
    let ended = 0;
    for (const session of [...RemoteDesktopService.sessions.values()]) {
      if (session.status !== 'REQUESTED' && session.status !== 'ACCEPTED') continue;
      const payload = { type: 'rd_end', sessionId: session.sessionId, reason };
      this.sendToUser(session.targetUserId, { ...payload, fromUserId: session.operatorId });
      this.sendToUser(session.operatorId, { ...payload, fromUserId: session.targetUserId });
      this.finishRdSession(session, null);
      ended += 1;
    }
    return ended;
  }

  // Права роли изменились — открытые соединения её носителей закрываются.
  // Сокет хранит снимок прав на момент входа, и без этого отозванное право
  // (звонки, удалённый доступ) продолжало бы действовать до переподключения.
  disconnectUsersWithRole(roleId, reason) {
    const affected = new Set();
    for (const user of this.socketUser.values()) {
      if (Number(user.role_id) === Number(roleId)) affected.add(user.id);
    }
    for (const userId of affected) this.disconnectUser(userId, reason);
    return affected.size;
  }
}

module.exports = new WsServer();
