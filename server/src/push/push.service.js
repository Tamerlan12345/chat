const PushTokens = require('./token-store');
const { messagePayload, callPayload, readPayload, notificationFor, CALL_TTL_SECONDS } = require('./payload');
const { loadPushConfig, describePushConfig } = require('./config');

// Очередь push-уведомлений (задача 18). Путь сообщения её не ждёт: notify*
// только кладут задание и возвращаются, доставка идёт следующим тиком с
// ограниченной параллельностью. Временные ошибки поставщика — повтор с
// растущей паузой (не больше maxAttempts попыток), недействительный токен —
// удаляется. Переполненная очередь отбрасывает новые задания (счётчик и
// предупреждение в журнал), а не растит память.
//
// Кому: сотруднику, у которого сейчас нет ни одного сокета и не включено «Не
// беспокоить», — на токены, выданные ещё действующим сеансом. Строка токена,
// её владелец и сеанс перепроверяются перед КАЖДОЙ попыткой доставки, в том
// числе повтором через минуты: за это время токен мог перейти к другому
// сотруднику, сеанс — закончиться выходом, сменой пароля или отключением.
// Что: только id (payload.js).
//
// Звонок живёт, пока жив вызов (pendingOffers сервера сокетов): вызывающий
// сбросил — недоставленные уведомления и повторы снимаются; окно звонка (30 с
// от вызова) задаёт и срок у поставщика, и предел повторов. Не удалось
// разбудить ни одно устройство — WsServer сообщает вызывающему
// call_unavailable (callUndeliverable).

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const DROP_WARN_INTERVAL_MS = 60 * 1000;
const CALL_RING_MS = CALL_TTL_SECONDS * 1000;

const callCapable = (row) => row.platform === 'android' || row.kind === 'voip';
const messageCapable = (row) => row.platform === 'android' || row.kind === 'alert';

// Устройство строки токена для решения «кому push» (notify-decision.js):
// device_id из регистрации; без него — сам токен (с «#», которого нет в
// допустимом device_id, — такое устройство никогда не совпадёт с сокетом).
const deviceKeyOf = (row) => row.device_id || `#${row.token}`;

const NO_PRESENCE = {
  isOnline: () => false,
  isDnd: () => false,
  // Без сервера сокетов сокетов нет — push на все устройства.
  messagePushTargets: (userId, payload, devices) => devices.map((d) => d.id),
  messageJobCurrent: () => true,
  readPushTargets: (userId, devices) => devices.map((d) => d.id),
  callOffer: () => null,
  callUndeliverable: () => {}
};

class PushService {
  constructor() {
    this.presence = { ...NO_PRESENCE };
    this.reset();
  }

  /** Выключает push и очищает очередь (тесты; повторная настройка). */
  reset() {
    for (const p of Object.values(this.providers || {})) p?.close?.();
    for (const t of this.timers || []) clearTimeout(t);
    this.providers = { android: null, ios: null };
    this.queue = [];
    this.active = 0;
    this.timers = new Set();
    this.drainScheduled = false;
    // callReserve — места сверх queueMax только для звонков: поток сообщений
    // большого канала не вытесняет вызов (иначе вызывающий получил бы
    // call_unavailable из-за чужих уведомлений).
    this.options = { concurrency: 8, queueMax: 10000, callReserve: 100, maxAttempts: 4, baseDelayMs: 1000 };
    this.stats = { sent: 0, invalid: 0, failed: 0, retried: 0, dropped: 0 };
    this.lastDropWarn = 0;
    this.configErrorsLogged = new Set();
  }

  /**
   * Связь с сервером сокетов: кто на сокете, у кого «Не беспокоить», жив ли
   * вызов (callOffer(callerId, calleeId) → { at } или null) и как сказать
   * вызывающему, что разбудить вызываемого нечем (callUndeliverable).
   */
  attachPresence(hooks) {
    this.presence = { ...NO_PRESENCE, ...hooks };
  }

  /**
   * providers: { fcm, apns } — объекты с send(); отсутствующий — платформа
   * выключена. Остальное — пределы очереди.
   */
  configure({ providers = {}, concurrency, queueMax, callReserve, maxAttempts, baseDelayMs } = {}) {
    this.reset();
    this.providers = { android: providers.fcm || null, ios: providers.apns || null };
    const set = (name, value, min) => { if (Number.isInteger(value) && value >= min) this.options[name] = value; };
    set('concurrency', concurrency, 1);
    set('queueMax', queueMax, 1);
    set('maxAttempts', maxAttempts, 1);
    set('baseDelayMs', baseDelayMs, 0);
    set('callReserve', callReserve, 0);
  }

  /** Настройка из окружения при запуске сервера; одна строка в журнал о состоянии. */
  configureFromEnv(env = process.env) {
    const cfg = loadPushConfig(env);
    for (const w of cfg.warnings) console.warn(w);
    const providers = {};
    if (cfg.fcm) {
      const { FcmProvider } = require('./fcm');
      providers.fcm = new FcmProvider({ serviceAccount: cfg.fcm.serviceAccount });
    }
    if (cfg.apns) {
      const { ApnsProvider } = require('./apns');
      providers.apns = new ApnsProvider(cfg.apns);
    }
    this.configure({ providers, ...cfg.limits });
    console.log(describePushConfig(cfg));
    return cfg;
  }

  get enabled() {
    return Boolean(this.providers.android || this.providers.ios);
  }

  providerFor(row) {
    return this.providers[row.platform] || null;
  }

  // ── Проверка токена: владелец, сеанс, сотрудник ────────────────────────────

  async activeUser(userId) {
    const UserService = require('../services/user.service');
    const user = await UserService.getUserById(userId);
    if (!user || !user.is_active || user.approval_status !== 'approved') {
      PushTokens.deleteForUser(userId);
      return null;
    }
    return user;
  }

  // Токен живёт не дольше сеанса, который его зарегистрировал: смена пароля
  // (поколение), истёкший SESSION_MAX_DAYS, отозванный jti — и уведомлений на
  // это устройство больше нет (fail closed).
  async sessionAlive(row, user) {
    const AuthService = require('../services/auth.service');
    if (row.token_version !== null && Number(row.token_version) !== Number(user.token_version || 1)) return false;
    if (row.auth_time !== null && (Number(row.auth_time) + AuthService.sessionMaxSeconds()) * 1000 < Date.now()) return false;
    if (row.session_jti && (await AuthService.isRevoked(row.session_jti))) return false;
    return true;
  }

  /** Живые строки токенов сотрудника нужного вида; мёртвые удаляются. */
  async liveRows(userId, capable) {
    const user = await this.activeUser(userId);
    if (!user) return [];
    const rows = [];
    for (const row of PushTokens.forUser(userId)) {
      if (!capable(row) || !this.providerFor(row)) continue;
      if (await this.sessionAlive(row, user)) rows.push(row);
      else PushTokens.deleteToken(row.token);
    }
    return rows;
  }

  /** Есть ли у сотрудника живое устройство, которое можно разбудить звонком. */
  async canRing(userId) {
    if (!this.enabled) return false;
    return (await this.liveRows(Number(userId), callCapable)).length > 0;
  }

  // ── Постановка ─────────────────────────────────────────────────────────────

  /**
   * Устройства сотрудников, которым можно показать уведомление о сообщении
   * (по таблице токенов, без проверки сеанса): userId -> [{ id }] для
   * notify-decision.js. Один запрос на всех — путь рассылки синхронный и
   * горячий; без push — пустой ответ без запроса.
   */
  messageDevicesFor(userIds) {
    const result = new Map();
    if (!this.enabled || !userIds.length) return result;
    for (const row of PushTokens.forUsers(userIds)) {
      if (!messageCapable(row) || !this.providerFor(row)) continue;
      const userId = Number(row.user_id);
      if (!result.has(userId)) result.set(userId, []);
      const list = result.get(userId);
      const id = deviceKeyOf(row);
      if (!list.some((d) => d.id === id)) list.push({ id });
    }
    return result;
  }

  /**
   * Новое сообщение: получателям, которых не исключило решение (WsServer).
   * Какие их устройства получат push, решается здесь же тем же правилом
   * (presence.messagePushTargets) — при раздаче и перед каждой попыткой.
   * stamps: userId -> отметка переписки (WsServer.pushedChats): переписку
   * прочитали — задание и его повторы снимаются. Не ждёт доставки.
   */
  notifyMessage(message, recipientIds, stamps = new Map()) {
    if (!this.enabled) return;
    for (const userId of recipientIds) {
      this.enqueue({ type: 'user', kind: 'message', userId: Number(userId), payload: messagePayload(message, userId), stamp: stamps.get(Number(userId)) });
    }
  }

  /**
   * Прочитано на другом устройстве: тихий push «read» (только id переписки),
   * чтобы приложение сняло показанное уведомление. Устройствам без сокета на
   * переднем плане (presence.readPushTargets). Как получится: не повторяется
   * после ошибки поставщика сверх обычных попыток, не ждёт доставки.
   */
  notifyRead(userId, { conversationType, targetId }) {
    if (!this.enabled) return;
    this.enqueue({ type: 'user', kind: 'read', userId: Number(userId), payload: readPayload({ conversationType, targetId }) });
  }

  /**
   * Входящий звонок сотруднику без сокета; offerAt — время вызова (окно звонка
   * считается от него), offerSeq — номер вызова: по нему, а не по времени,
   * доставка узнаёт «свой» вызов (задача 20).
   */
  // Группа доставки заводится сразу: если очередь переполнена и задание
  // отброшено уже здесь, вызывающему всё равно приходит call_unavailable.
  notifyCall({ calleeId, callerId, offerAt = Date.now(), offerSeq, callId = null }) {
    if (!this.enabled) return;
    this.enqueue({
      type: 'user',
      kind: 'call',
      userId: Number(calleeId),
      payload: callPayload({ callerId, callId }),
      call: { callerId: Number(callerId), calleeId: Number(calleeId), offerAt, offerSeq, expiresAt: offerAt + CALL_RING_MS },
      group: { pending: 0, done: false }
    });
  }

  enqueue(job) {
    const isCall = job.kind === 'call';
    const limit = this.options.queueMax + (isCall ? this.options.callReserve : 0);
    if (this.queue.length >= limit) {
      this.stats.dropped += 1;
      const now = Date.now();
      if (now - this.lastDropWarn > DROP_WARN_INTERVAL_MS) {
        this.lastDropWarn = now;
        console.warn(`[Push] очередь переполнена (${this.options.queueMax}) — уведомления отбрасываются; всего отброшено ${this.stats.dropped}`);
      }
      this.settle(job, 'lost');
      return;
    }
    // Звонок встаёт впереди уведомлений о сообщениях: у него 30 секунд.
    if (isCall) {
      const at = this.queue.findIndex((j) => j.kind !== 'call');
      if (at < 0) this.queue.push(job);
      else this.queue.splice(at, 0, job);
    } else {
      this.queue.push(job);
    }
    this.scheduleDrain();
  }

  scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  drain() {
    while (this.active < this.options.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(() => this.run(job))
        .catch((err) => {
          console.warn('[Push] задание не выполнено:', err.message);
          this.settle(job, 'lost');
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  // ── Жизнь звонка ───────────────────────────────────────────────────────────

  // 'moot' — уведомление больше не нужно (вызов снят, вызываемый на сокете);
  // 'delivered' — поставщик принял; 'lost' — это устройство не разбудить.
  // Когда потеряны все устройства звонка и ни одно не принято — вызывающему
  // сообщается, что вызываемый недоступен.
  settle(job, outcome) {
    const group = job.group;
    if (!group || group.done) return;
    // offerSeq — какой именно вызов не дозвонился: у той же пары мог появиться новый.
    if (outcome === 'lost' && job.type === 'user') {
      group.done = true;
      this.presence.callUndeliverable(job.call.callerId, job.call.calleeId, job.call.offerSeq);
      return;
    }
    if (outcome !== 'lost') {
      group.done = true;
      return;
    }
    group.pending -= 1;
    if (group.pending <= 0) {
      group.done = true;
      this.presence.callUndeliverable(job.call.callerId, job.call.calleeId, job.call.offerSeq);
    }
  }

  // Получатель мог подключиться, открыть чат или включить «Не беспокоить», а
  // вызов — смениться или закончиться, пока задание ждало. Сообщение и «read»
  // — тем же решением, что при рассылке (notify-decision.js): задание на
  // устройство (type 'token') ещё нужно, только если устройство всё ещё в
  // списке push; раздача (type 'user') отбирает устройства в fanOut.
  stillWanted(job) {
    if (job.kind === 'message') {
      if (this.presence.isDnd(job.userId)) return false;
      // Переписку прочитали после постановки — уведомление устарело.
      if (!this.presence.messageJobCurrent(job.userId, job.payload, job.stamp)) return false;
      if (job.type !== 'token') return true;
      try {
        return this.presence.messagePushTargets(job.userId, job.payload, [{ id: job.deviceKey }]).length > 0;
      } catch (err) {
        console.warn('[Push] решение об уведомлении не принято — доставляем:', err.message);
        return true;
      }
    }
    if (job.kind === 'read') {
      if (job.type !== 'token') return true;
      return this.presence.readPushTargets(job.userId, [{ id: job.deviceKey }]).length > 0;
    }
    if (this.presence.isOnline(job.userId)) return false;
    if (this.presence.isDnd(job.userId)) return false;
    if (job.call) {
      const offer = this.presence.callOffer(job.call.callerId, job.call.calleeId);
      if (!offer) return false;
      const sameOffer = job.call.offerSeq !== undefined ? offer.seq === job.call.offerSeq : offer.at === job.call.offerAt;
      if (!sameOffer) return false;
      if (Date.now() >= job.call.expiresAt) return false;
    }
    return true;
  }

  async run(job) {
    if (job.kind === 'call' && !job.group) job.group = { pending: 0, done: false };
    if (!this.stillWanted(job)) {
      this.settle(job, 'moot');
      return;
    }
    if (job.type === 'user') return this.fanOut(job);
    return this.deliver(job);
  }

  async fanOut(job) {
    let rows = await this.liveRows(job.userId, job.kind === 'call' ? callCapable : messageCapable);
    if (job.kind === 'call' && !rows.length) {
      this.settle(job, 'lost');
      return;
    }
    if (job.kind === 'message' || job.kind === 'read') {
      // Устройство с сокетом на переднем плане увидит всё по сокету (баннер
      // в приложении) — push только остальным; решение — notify-decision.js.
      // Сбой решения — уведомить все устройства (как до этого правила).
      const devices = [...new Set(rows.map(deviceKeyOf))].map((id) => ({ id }));
      let targets;
      try {
        targets = new Set(job.kind === 'message'
          ? this.presence.messagePushTargets(job.userId, job.payload, devices)
          : this.presence.readPushTargets(job.userId, devices));
      } catch (err) {
        console.warn('[Push] решение об уведомлении не принято — шлём всем устройствам:', err.message);
        targets = new Set(devices.map((d) => d.id));
      }
      rows = rows.filter((row) => targets.has(deviceKeyOf(row)));
    }
    if (job.group) job.group.pending = rows.length;
    const notification = notificationFor(job.payload);
    for (const row of rows) {
      this.enqueue({
        type: 'token',
        kind: job.kind,
        userId: job.userId,
        token: row.token,
        deviceKey: deviceKeyOf(row),
        payload: job.payload,
        stamp: job.stamp,
        sessionJti: row.session_jti || null,
        notification,
        call: job.call,
        group: job.group,
        attempt: 1
      });
    }
  }

  async deliver(job) {
    // Перед каждой попыткой: тот же владелец, тот же сеанс, сеанс жив. Сеанс,
    // продлённый между попытками (/auth/refresh, rebindSession), — тот же
    // сеанс под новым jti: повтор идёт дальше и помнит уже новый jti. Пауза
    // повтора (≤ 5 мин) короче памяти продлений (10 мин).
    const row = PushTokens.get(job.token);
    const sessionJti = job.sessionJti ? PushTokens.currentJti(job.userId, job.sessionJti) : null;
    if (!row || Number(row.user_id) !== job.userId || (row.session_jti || null) !== sessionJti) {
      this.settle(job, 'lost');
      return;
    }
    job.sessionJti = sessionJti;
    const user = await this.activeUser(job.userId);
    if (!user) {
      this.settle(job, 'lost');
      return;
    }
    if (!(await this.sessionAlive(row, user))) {
      PushTokens.deleteToken(row.token);
      this.settle(job, 'lost');
      return;
    }
    // Ожидание базы — ещё один шанс, что вызов сняли или получатель подключился.
    if (!this.stillWanted(job)) {
      this.settle(job, 'moot');
      return;
    }
    const provider = this.providerFor(row);
    if (!provider) {
      this.settle(job, 'lost');
      return;
    }
    let notification = job.notification;
    if (job.call) {
      // Срок у поставщика — от времени вызова, а не от попытки.
      const remainingMs = job.call.expiresAt - Date.now();
      notification = { ...notification, ttlSeconds: Math.max(1, Math.ceil(remainingMs / 1000)), expiresAtMs: job.call.expiresAt };
    }
    let result;
    try {
      result = await provider.send({ token: row.token, environment: row.environment, notification });
    } catch {
      result = { status: 'retry', reason: 'PROVIDER_ERROR' };
    }
    const where = `${provider.name || row.platform}, сотрудник #${job.userId}`;
    switch (result && result.status) {
      case 'ok':
        this.stats.sent += 1;
        this.settle(job, 'delivered');
        return;
      case 'invalid':
        this.stats.invalid += 1;
        // Только если токен всё ещё того же сотрудника: его могли перерегистрировать.
        PushTokens.deleteOwned(row.token, job.userId);
        console.log(`[Push] недействительный токен удалён (${where}): ${result.reason || 'invalid'}`);
        this.settle(job, 'lost');
        return;
      case 'config':
        // Ошибка настройки (чужой проект Firebase, не тот bundle id): токены не
        // удаляются — иначе одна ошибка в настройках стёрла бы их все.
        this.stats.failed += 1;
        if (!this.configErrorsLogged.has(`${provider.name}:${result.reason}`)) {
          this.configErrorsLogged.add(`${provider.name}:${result.reason}`);
          console.error(`[Push] ОШИБКА НАСТРОЙКИ ${provider.name || row.platform}: ${result.reason} — проверьте учётные данные/идентификатор приложения; токены не удаляются`);
        }
        this.settle(job, 'lost');
        return;
      case 'retry': {
        const delay = this.retryDelay(job, result.retryAfterMs);
        const tooLate = job.call && Date.now() + delay >= job.call.expiresAt;
        if (job.attempt >= this.options.maxAttempts || tooLate) {
          this.stats.failed += 1;
          console.warn(`[Push] доставка не удалась после ${job.attempt} попыток (${where}): ${result.reason || 'retry'}`);
          this.settle(job, 'lost');
          return;
        }
        this.stats.retried += 1;
        this.retryLater(job, delay);
        return;
      }
      default:
        this.stats.failed += 1;
        console.warn(`[Push] доставка отклонена поставщиком (${where}): ${(result && result.reason) || 'failed'}`);
        this.settle(job, 'lost');
    }
  }

  retryDelay(job, retryAfterMs) {
    const backoff = this.options.baseDelayMs * 4 ** (job.attempt - 1);
    return Math.min(Math.max(backoff * (1 + Math.random() * 0.2), Number(retryAfterMs) || 0), MAX_RETRY_DELAY_MS);
  }

  retryLater(job, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.enqueue({ ...job, attempt: job.attempt + 1 });
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** Ждёт, пока очередь опустеет (тесты). */
  async idle(timeoutMs = 10000) {
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setImmediate(r));
      if (!this.queue.length && !this.active && !this.timers.size && !this.drainScheduled) return;
      if (Date.now() - started > timeoutMs) throw new Error('очередь push не опустела');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

module.exports = new PushService();
