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
    buckets.set(key, { count: 1, windowStart: now });
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
  if (!bucket) buckets.set(key, { count: 1, windowStart: Date.now() });
  else bucket.count += 1;
}

// Periodic cleanup so the map doesn't grow unbounded with stale IPs/usernames.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.windowStart > 10 * 60000) buckets.delete(key);
  }
}, 5 * 60000).unref();

module.exports = { checkRateLimit, isRateLimited, registerFailure };
