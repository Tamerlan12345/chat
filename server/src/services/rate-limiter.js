// Minimal in-memory fixed-window rate limiter — no new dependency, adequate at
// this app's scale. Not shared across multiple server processes/instances by
// design (this app runs as a single Windows Service process).
// See docs/designs/auth-access-control-remediation.md item 11.
//
// Окно фиксированное: на стыке двух окон за короткое время проходит до
// 2×maxAttempts попыток. Для здешних пределов (единицы–десятки попыток в
// минуту) это приемлемо и дешевле скользящего окна; там, где важна точность
// на длинной дистанции (подбор к одной учётной записи с многих адресов), —
// отдельный механизм с затуханием, services/login-throttle.service.js.

const buckets = new Map(); // key -> { count, windowStart, windowMs, maxAttempts }

// Жёсткий потолок числа ключей. Ключи строятся из адреса и логина — то есть
// из того, что присылает анонимный клиент. Без потолка поток запросов с
// разными логинами (или с разных адресов IPv6) наращивал карту без предела
// и выедал память процесса (аудит, раунд 4, находка Р4-04).
const DEFAULT_MAX_BUCKETS = 100000;
let maxBuckets = DEFAULT_MAX_BUCKETS;
// Сколько самых старых ключей просматривать в поисках вытесняемого. Предел
// нужен, чтобы вытеснение не превращалось в полный проход по карте на каждом
// запросе, когда она забита.
const EVICTION_SCAN_LIMIT = 1000;
let lastFullPruneAt = 0;

function isBlocking(bucket, now) {
  if (now - bucket.windowStart >= bucket.windowMs) return false; // окно уже истекло
  // Предел неизвестен (старый вызов без maxAttempts) — считаем ключ
  // действующим: вытеснить его значило бы, возможно, снять чью-то блокировку.
  if (!Number.isFinite(bucket.maxAttempts)) return true;
  return bucket.count >= bucket.maxAttempts;
}

// Освобождает место под новый ключ. Вытесняется только то, что никого не
// сдерживает: истёкшие окна и счётчики ниже порога. Действующую блокировку
// вытеснить нельзя — иначе атакующий забивал бы карту мусором ровно для того,
// чтобы снять блокировку со своего адреса или с чужого логина. Если места
// нет, отвечает false, и вызывающий отказывает (fail closed).
// evict=false — только узнать, найдётся ли место (для isRateLimited, который
// сам ничего не заводит и не должен ради этого выбрасывать чужой счётчик).
function ensureRoom(now, { evict = true } = {}) {
  if (buckets.size < maxBuckets) return true;
  if (now - lastFullPruneAt >= 1000) {
    lastFullPruneAt = now;
    pruneStaleBuckets(now);
    if (buckets.size < maxBuckets) return true;
  }
  let scanned = 0;
  for (const [key, bucket] of buckets) {
    if (++scanned > EVICTION_SCAN_LIMIT) break;
    if (!isBlocking(bucket, now)) {
      if (evict) buckets.delete(key);
      return true;
    }
  }
  return false;
}

function currentBucket(key, windowMs) {
  const bucket = buckets.get(key);
  if (!bucket || Date.now() - bucket.windowStart >= windowMs) return null;
  return bucket;
}

function checkRateLimit(key, { maxAttempts = 5, windowMs = 60000 } = {}) {
  const now = Date.now();
  const bucket = currentBucket(key, windowMs);

  if (!bucket) {
    // Новый ключ (или истёкшее окно старого). Истёкший удаляется, чтобы
    // занять место заново в конце очереди вытеснения, а не в начале.
    buckets.delete(key);
    if (!ensureRoom(now)) return false; // карта забита действующими блокировками
    // windowMs хранится вместе с бакетом — иначе периодическая очистка ниже не
    // знает, сколько именно этому ключу положено жить, и либо снимает долгие
    // блокировки (вход, LOGIN_LOCKOUT_MINUTES) раньше срока, либо не чистит
    // короткие вовсе (находка ревью: cleanup всегда считала 10 минут).
    buckets.set(key, { count: 1, windowStart: now, windowMs, maxAttempts });
    return true;
  }

  bucket.maxAttempts = maxAttempts;
  if (bucket.count >= maxAttempts) {
    return false;
  }

  bucket.count += 1;
  return true;
}

// Для мест, где считать нужно только неудачи. Офис выходит в интернет с одного
// адреса: после перезапуска сервера все переподключаются разом, и если каждое
// удачное подключение расходует попытку, десятый сотрудник и дальше остаются
// без связи — хотя подбора никто не ведёт.
function isRateLimited(key, { maxAttempts = 5, windowMs = 60000 } = {}) {
  const bucket = currentBucket(key, windowMs);
  if (bucket) {
    bucket.maxAttempts = maxAttempts;
    return bucket.count >= maxAttempts;
  }
  // Ключа нет. Если его и завести негде (карта забита действующими
  // блокировками), следующая неудача не будет посчитана — значит, пускать
  // нельзя: иначе переполнение карты стало бы способом обойти предел.
  return !ensureRoom(Date.now(), { evict: false });
}

function registerFailure(key, { windowMs = 60000, maxAttempts } = {}) {
  const now = Date.now();
  const bucket = currentBucket(key, windowMs);
  if (bucket) {
    bucket.count += 1;
    if (Number.isFinite(maxAttempts)) bucket.maxAttempts = maxAttempts;
    return;
  }
  buckets.delete(key);
  if (!ensureRoom(now)) return; // isRateLimited уже отвечает «нельзя» для таких ключей
  buckets.set(key, { count: 1, windowStart: now, windowMs, maxAttempts });
}

// Возврат заранее засчитанной неудачи. Ограничитель входа засчитывает
// попытку ДО проверки пароля — иначе сотня одновременных запросов проходила
// проверку предела раньше, чем первый из них успевал закончиться неудачей
// (аудит, раунд 4, находка Р4-03). Удачный вход свою попытку возвращает.
function refundFailure(key) {
  const bucket = buckets.get(key);
  if (bucket && bucket.count > 0) bucket.count -= 1;
}

// Успешное действие (например, вход) должно снимать уже накопленные неудачи
// по этому же ключу — иначе они продолжают копиться к следующей блокировке,
// хотя подбора не было ни секунды.
function resetLimit(key) {
  buckets.delete(key);
}

// Бакет старше собственного окна уже не действует (currentBucket и так вернёт
// null для него на следующей проверке) — очистка лишь освобождает память и не
// имеет права закончиться раньше этого срока. Раньше здесь был фиксированный
// предел в 10 минут для всех ключей разом, и он снимал более долгие блокировки
// (например, 15-минутную по LOGIN_LOCKOUT_MINUTES) на пять минут раньше срока.
function pruneStaleBuckets(now = Date.now()) {
  for (const [key, bucket] of buckets.entries()) {
    const ttl = bucket.windowMs || 10 * 60000;
    if (now - bucket.windowStart >= ttl) buckets.delete(key);
  }
}

// Для тестов: уменьшить потолок, чтобы проверить вытеснение без сотни тысяч
// ключей, и узнать текущий размер.
function configureLimiter({ maxBuckets: max } = {}) {
  maxBuckets = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_BUCKETS;
}

function limiterSize() {
  return buckets.size;
}

// Periodic cleanup so the map doesn't grow unbounded with stale IPs/usernames.
setInterval(() => pruneStaleBuckets(), 5 * 60000).unref();

module.exports = {
  checkRateLimit,
  isRateLimited,
  registerFailure,
  refundFailure,
  resetLimit,
  pruneStaleBuckets,
  configureLimiter,
  limiterSize
};
