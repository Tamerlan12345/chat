const PushTokens = require('./token-store');
const { messagePayload, callPayload, notificationFor } = require('./payload');
const { loadPushConfig, describePushConfig } = require('./config');

// Очередь push-уведомлений (задача 18). Путь сообщения её не ждёт: notify*
// только кладут задание и возвращаются, доставка идёт следующим тиком с
// ограниченной параллельностью. Временные ошибки поставщика — повтор с
// растущей паузой (не больше maxAttempts попыток), недействительный токен —
// удаляется. Переполненная очередь отбрасывает новые задания (счётчик и
// предупреждение в журнал), а не растит память.
//
// Кому: сотруднику, у которого сейчас нет ни одного сокета и не включено «Не
// беспокоить», — на токены, выданные ещё действующим сеансом (поколение
// токенов, срок сеанса, отзыв jti проверяются перед каждой доставкой; токен
// мёртвого сеанса удаляется). Что: только id (payload.js).

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const DROP_WARN_INTERVAL_MS = 60 * 1000;

const callCapable = (row) => row.platform === 'android' || row.kind === 'voip';
const messageCapable = (row) => row.platform === 'android' || row.kind === 'alert';

class PushService {
  constructor() {
    this.presence = { isOnline: () => false, isDnd: () => false };
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
  }

  /** Кто сейчас на сокете и у кого «Не беспокоить» — сообщает WsServer. */
  attachPresence({ isOnline, isDnd }) {
    this.presence = { isOnline, isDnd };
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

  /** Есть ли у сотрудника устройство, которое можно разбудить звонком. Синхронно. */
  canRing(userId) {
    if (!this.enabled) return false;
    return PushTokens.forUser(userId).some((row) => callCapable(row) && this.providerFor(row));
  }

  /** Новое сообщение: получателям без сокета (фильтрует вызывающий). Не ждёт доставки. */
  notifyMessage(message, recipientIds) {
    if (!this.enabled) return;
    for (const userId of recipientIds) {
      this.enqueue({ type: 'user', kind: 'message', userId: Number(userId), payload: messagePayload(message, userId) });
    }
  }

  /** Входящий звонок сотруднику без сокета. */
  notifyCall({ calleeId, callerId, callId = null }) {
    if (!this.enabled) return;
    this.enqueue({ type: 'user', kind: 'call', userId: Number(calleeId), payload: callPayload({ callerId, callId }) });
  }

  enqueue(job) {
    if (this.queue.length >= this.options.queueMax) {
      this.stats.dropped += 1;
      const now = Date.now();
      if (now - this.lastDropWarn > DROP_WARN_INTERVAL_MS) {
        this.lastDropWarn = now;
        console.warn(`[Push] очередь переполнена (${this.options.queueMax}) — уведомления отбрасываются; всего отброшено ${this.stats.dropped}`);
      }
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
        .catch((err) => console.warn('[Push] задание не выполнено:', err.message))
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  // Получатель мог появиться на сокете (или включить «Не беспокоить»), пока
  // задание ждало: тогда уведомление уже не нужно.
  stillWanted(job) {
    if (this.presence.isOnline(job.userId)) return false;
    if (this.presence.isDnd(job.userId)) return false;
    return true;
  }

  async run(job) {
    if (!this.stillWanted(job)) return;
    if (job.type === 'user') return this.fanOut(job);
    return this.deliver(job);
  }

  async fanOut(job) {
    const UserService = require('../services/user.service');
    const user = await UserService.getUserById(job.userId);
    if (!user || !user.is_active || user.approval_status !== 'approved') {
      PushTokens.deleteForUser(job.userId);
      return;
    }
    const capable = job.kind === 'call' ? callCapable : messageCapable;
    const notification = notificationFor(job.payload);
    for (const row of PushTokens.forUser(job.userId)) {
      if (!capable(row) || !this.providerFor(row)) continue;
      if (!(await this.sessionAlive(row, user))) {
        PushTokens.deleteToken(row.token);
        continue;
      }
      this.enqueue({ type: 'token', kind: job.kind, userId: job.userId, row, notification, attempt: 1 });
    }
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

  async deliver(job) {
    const provider = this.providerFor(job.row);
    if (!provider) return;
    let result;
    try {
      result = await provider.send({ token: job.row.token, environment: job.row.environment, notification: job.notification });
    } catch {
      result = { status: 'retry', reason: 'PROVIDER_ERROR' };
    }
    const where = `${provider.name || job.row.platform}, сотрудник #${job.userId}`;
    switch (result && result.status) {
      case 'ok':
        this.stats.sent += 1;
        return;
      case 'invalid':
        this.stats.invalid += 1;
        // Только если токен всё ещё того же сотрудника: его могли перерегистрировать.
        if (PushTokens.forUser(job.userId).some((r) => r.token === job.row.token)) PushTokens.deleteToken(job.row.token);
        console.log(`[Push] недействительный токен удалён (${where}): ${result.reason || 'invalid'}`);
        return;
      case 'retry':
        if (job.attempt >= this.options.maxAttempts) {
          this.stats.failed += 1;
          console.warn(`[Push] доставка не удалась после ${job.attempt} попыток (${where}): ${result.reason || 'retry'}`);
          return;
        }
        this.stats.retried += 1;
        this.retryLater(job, result.retryAfterMs);
        return;
      default:
        this.stats.failed += 1;
        console.warn(`[Push] доставка отклонена поставщиком (${where}): ${(result && result.reason) || 'failed'}`);
    }
  }

  retryLater(job, retryAfterMs) {
    const backoff = this.options.baseDelayMs * 4 ** (job.attempt - 1);
    const delay = Math.min(Math.max(backoff * (1 + Math.random() * 0.2), Number(retryAfterMs) || 0), MAX_RETRY_DELAY_MS);
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
