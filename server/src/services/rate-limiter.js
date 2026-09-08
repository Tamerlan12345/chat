// Minimal in-memory fixed-window rate limiter — no new dependency, adequate at
// this app's scale. Not shared across multiple server processes/instances by
// design (this app runs as a single Windows Service process).
// See docs/designs/auth-access-control-remediation.md item 11.

const buckets = new Map(); // key -> { count, windowStart }

function checkRateLimit(key, { maxAttempts = 5, windowMs = 60000 } = {}) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count >= maxAttempts) {
    return false;
  }

  bucket.count += 1;
  return true;
}

// Periodic cleanup so the map doesn't grow unbounded with stale IPs/usernames.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.windowStart > 10 * 60000) buckets.delete(key);
  }
}, 5 * 60000).unref();

module.exports = { checkRateLimit };
