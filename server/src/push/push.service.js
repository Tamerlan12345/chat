const PushTokens = require('./token-store');
const { messagePayload, callPayload, notificationFor, CALL_TTL_SECONDS } = require('./payload');
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

const NO_PRESENCE = {
  isOnline: () => false,
  isDnd: () => false,
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
    this.options = { concurrency: 8, queueMax: 10000, maxAttempts: 4, baseDelayMs: 1000 };
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
  configure({ providers = {}, concurrency, queueMax, maxAttempts, baseDelayMs } = {}) {
    this.reset();
    this.providers = { android: providers.fcm || null, ios: providers.apns || null };
    const set = (name, value, min) => { if (Number.isInteger(value) && value >= min) this.options[name] = value; };
    set('concurrency', concurrency, 1);
    set('queueMax', queueMax, 1);
    set('maxAttempts', maxAttempts, 1);
    set('baseDelayMs', baseDelayMs, 0);
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

  /** Новое сообщение: получателям без сокета (фильтрует вызывающий). Не ждёт доставки. */
  notifyMessage(message, recipientIds) {
    if (!this.enabled) return;
    for (const userId of recipientIds) {
      this.enqueue({ type: 'user', kind: 'message', userId: Number(userId), payload: messagePayload(message, userId) });
    }
  }

  /** Входящий звонок сотруднику без сокета; offerAt — время вызова (окно звонка считается от него). */
  // Группа доставки заводится сразу: если очередь переполнена и задание
  // отброшено уже здесь, вызывающему всё равно приходит call_unavailable.
  notifyCall({ calleeId, callerId, offerAt = Date.now(), callId = null }) {
    if (!this.enabled) return;
    this.enqueue({
      type: 'user',
      kind: 'call',
      userId: Number(calleeId),
      payload: callPayload({ callerId, callId }),
      call: { callerId: Number(callerId), calleeId: Number(calleeId), offerAt, expiresAt: offerAt + CALL_RING_MS },
      group: { pending: 0, done: false }
    });
  }

  enqueue(job) {
    if (this.queue.length >= this.options.queueMax) {
      this.stats.dropped += 1;
      const now = Date.now();
      if (now - this.lastDropWarn > DROP_WARN_INTERVAL_MS) {
        this.lastDropWarn = now;
        console.warn(`[Push] очередь переполнена (${this.options.queueMax}) — уведомления отбрасываются; всего отброшено ${this.stats.dropped}`);
      }
      this.settle(job, 'lost');
      return;
    }
    this.queue.push(job);
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
    // offerAt — какой именно вызов не дозвонился: у той же пары мог появиться новый.
    if (outcome === 'lost' && job.type === 'user') {
      group.done = true;
      this.presence.callUndeliverable(job.call.callerId, job.call.calleeId, job.call.offerAt);
      return;
    }
    if (outcome !== 'lost') {
      group.done = true;
      return;
    }
    group.pending -= 1;
    if (group.pending <= 0) {
      group.done = true;
      this.presence.callUndeliverable(job.call.callerId, job.call.calleeId, job.call.offerAt);
    }
  }

  // Получатель мог подключиться (или включить «Не беспокоить»), а вызов —
  // смениться или закончиться, пока задание ждало.
  stillWanted(job) {
    if (this.presence.isOnline(job.userId)) return false;
    if (this.presence.isDnd(job.userId)) return false;
    if (job.call) {
      const offer = this.presence.callOffer(job.call.callerId, job.call.calleeId);
      if (!offer || offer.at !== job.call.offerAt) return false;
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
    const rows = await this.liveRows(job.userId, job.kind === 'call' ? callCapable : messageCapable);
    if (job.kind === 'call' && !rows.length) {
      this.settle(job, 'lost');
      return;
    }
    if (job.group) job.group.pending = rows.length;
    const notification = notificationFor(job.payload);
    for (const row of rows) {
      this.enqueue({
        type: 'token',
        kind: job.kind,
        userId: job.userId,
        token: row.token,
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
