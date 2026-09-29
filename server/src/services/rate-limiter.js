// Minimal in-memory fixed-window rate limiter — no new dependency, adequate at
// this app's scale. Not shared across multiple server processes/instances by
// design (this app runs as a single Windows Service process).
// See docs/designs/auth-access-control-remediation.md item 11.

const buckets = new Map(); // key -> { count, windowStart }

function currentBucket(key, windowMs) {
  const bucket = buckets.get(key);
  if (!bucket || Date.now() - bucket.windowStart >= windowMs) return null;
  return bucket;
}

function checkRateLimit(key, { maxAttempts = 5, windowMs = 60000 } = {}) {
  const now = Date.now();
  const bucket = currentBucket(key, windowMs);

  if (!bucket) {
    // windowMs хранится вместе с бакетом — иначе периодическая очистка ниже не
    // знает, сколько именно этому ключу положено жить, и либо снимает долгие
    // блокировки (вход, LOGIN_LOCKOUT_MINUTES) раньше срока, либо не чистит
    // короткие вовсе (находка ревью: cleanup всегда считала 10 минут).
    buckets.set(key, { count: 1, windowStart: now, windowMs });
    return true;
  }

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
  return Boolean(bucket && bucket.count >= maxAttempts);
}

function registerFailure(key, { windowMs = 60000 } = {}) {
  const bucket = currentBucket(key, windowMs);
  if (!bucket) buckets.set(key, { count: 1, windowStart: Date.now(), windowMs });
  else bucket.count += 1;
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

// Periodic cleanup so the map doesn't grow unbounded with stale IPs/usernames.
setInterval(() => pruneStaleBuckets(), 5 * 60000).unref();

module.exports = { checkRateLimit, isRateLimited, registerFailure, resetLimit, pruneStaleBuckets };
