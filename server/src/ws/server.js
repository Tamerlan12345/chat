const { WebSocketServer, WebSocket } = require('ws');
const AuthService = require('../services/auth.service');
const UserService = require('../services/user.service');
const MessageService = require('../services/message.service');
const RemoteDesktopService = require('../services/remote-desktop.service');
const AuditService = require('../services/audit.service');
const { isRateLimited, registerFailure } = require('../services/rate-limiter');
const { getClientIp, isIpAllowed } = require('../services/ip-access.service');
const config = require('../config');

// Самое крупное законное сообщение — файл до 10 МБ, переданный на удалённый
// рабочий стол в base64 (около 13,5 МБ). Без предела библиотека принимает до
// 100 МБ, и десяток таких сообщений съедает память сервера.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

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
const MAX_SOCKETS_PER_IP = Number(process.env.WS_MAX_SOCKETS_PER_IP) || 500;
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

function allowRate(ws, key) {
  const [limit, windowMs] = RATE_LIMITS[key] || RATE_LIMITS['*'];
  if (!ws.rate) ws.rate = new Map();
  const now = Date.now();
  const bucket = ws.rate.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    ws.rate.set(key, { start: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

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

const RD_DECLINE_REASONS = new Set(['busy', 'superseded', 'capture_failed']);

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
        if ((this.socketsPerIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) return callback(false, 429, 'Too many connections');
        callback(true);
      }
    });

    this.wss.on('connection', (ws, req) => {
      ws.remoteIp = getClientIp(req) || '127.0.0.1';
      this.socketsPerIp.set(ws.remoteIp, (this.socketsPerIp.get(ws.remoteIp) || 0) + 1);
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
        let data;
        try {
          data = JSON.parse(raw.toString('utf8'));
        } catch (err) {
          console.error('[WS Error] Bad JSON:', err.message);
          return;
        }
        if (!data || typeof data !== 'object') return;
        if (!authenticated && data.type !== 'auth') {
          try { ws.close(1008, 'Authentication required'); } catch {}
          return;
        }
        const rateKey = RATE_LIMITS[data.type] ? data.type : '*';
        if (!allowRate(ws, rateKey)) return;
        // Обработчик обращается к двум базам и потому асинхронен. Отказ
        // обещания без перехвата завершает процесс Node — одно кривое
        // сообщение роняло бы сервер для всех.
        Promise.resolve(this.handleMessage(ws, data)).catch((err) => {
          console.error('[WS Error] Обработка сообщения не удалась:', err.message);
          try {
            ws.send(JSON.stringify({ type: 'error', message: 'Ошибка обработки запроса' }));
          } catch {
            /* сокет уже закрыт */
          }
        });
      });

      ws.on('close', () => {
        clearTimeout(ws.authTimer);
        const left = (this.socketsPerIp.get(ws.remoteIp) || 1) - 1;
        if (left > 0) this.socketsPerIp.set(ws.remoteIp, left);
        else this.socketsPerIp.delete(ws.remoteIp);
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

  async handleMessage(ws, msg) {
    const { type } = msg;

    // 1. Authentication
    if (type === 'auth') {
      // Считаются только неудачные попытки: офис за одним адресом после
      // перезапуска сервера переподключается целиком, и это не подбор.
      const limitKey = `ws_auth:${ws.remoteIp || '127.0.0.1'}`;
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
        registerFailure(limitKey, AUTH_LIMIT);
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

      // Только что подключился — значит, за компьютером. «Не беспокоить»,
      // включённое раньше, остаётся.
      this.presence.set(user.id, 'online');
      const status = this.effectiveStatus(user.id);
      user.status = status;
      await UserService.updateStatus(user.id, status);

      ws.send(JSON.stringify({ type: 'auth_success', user }));
      ws.send(JSON.stringify(this.wakeStateFor(user.id)));

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

    const currentUser = this.socketUser.get(ws);
    if (!currentUser) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Необходима авторизация' }));
    }

    // 2. Chat messaging
    if (type === 'send_message' || type === 'direct_message' || type === 'channel_message') {
      let { conversationType, targetId, text, msgType, replyToId, metadata, recipient_id, channel_id } = msg;

      if (!conversationType) {
        if (type === 'channel_message' || channel_id) conversationType = 'channel';
        else conversationType = 'direct';
      }
      if (!targetId) {
        targetId = recipient_id || channel_id;
      }

      let savedMsg;
      try {
        savedMsg = await MessageService.sendMessage({
          conversationType,
          targetId: Number(targetId),
          senderId: currentUser.id,
          text,
          type: msgType || 'text',
          replyToId: replyToId ? Number(replyToId) : null,
          metadata
        });
      } catch (err) {
        const message = err.message === 'NOT_CHANNEL_MEMBER' ? 'Вы не участник этого канала' : err.message;
        // Текст возвращается клиенту: поле ввода у него уже очищено, и без
        // этого сообщение пропало бы без следа.
        return ws.send(JSON.stringify({ type: 'error', context: 'send_message', message, text }));
      }

      if (conversationType === 'channel') {
        for (const memberId of MessageService.getChannelMemberIds(targetId)) {
          this.sendToUser(memberId, { type: 'channel_message', message: savedMsg });
          this.sendToUser(memberId, { type: 'new_message', message: savedMsg });
        }
      } else {
        for (const userId of [targetId, currentUser.id]) {
          this.sendToUser(userId, { type: 'direct_message', message: savedMsg });
          this.sendToUser(userId, { type: 'new_message', message: savedMsg });
        }

        // Получатель на связи — отметка о доставке ставится сразу.
        if (this.isUserOnline(targetId)) {
          const now = MessageService.markDelivered(savedMsg.id, targetId);
          this.sendToUser(currentUser.id, {
            type: 'message_status_updated',
            messageId: savedMsg.id,
            status: 'delivered',
            userId: targetId,
            timestamp: now
          });
        }
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

  isUserOnline(userId) {
    const sockets = this.userSockets.get(Number(userId));
    return Boolean(sockets && sockets.size > 0);
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
          clientType: ws.clientType || 'MyChat Client',
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
