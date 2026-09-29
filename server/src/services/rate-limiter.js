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
//
// Главный принцип доступности (проверка раунда 4): переполнение карты НИКОГДА
// не превращается в отказ живому сотруднику. Карта переполнена — вытесняется
// самый старый ключ (порядок вставки Map даёт это за O(1)), а не отклоняется
// новый. Для счётчиков «только неудачи» отсутствие ключа означает «не
// ограничено» (fail open). Ключи, в составе которых есть логин из тела
// запроса, живут в ОТДЕЛЬНОЙ карте с собственным потолком: поток запросов с
// выдуманными логинами вытесняет только такие же ключи и не может вытолкнуть
// или заморозить счётчики, ключом которых служит адрес.

// Карта ключей, ключом которых служит адрес или идентификатор сессии, — то,
// что нельзя подделать в теле запроса. Её и защищаем в первую очередь.
const buckets = new Map(); // key -> { count, windowStart, windowMs, maxAttempts }
// Карта ключей с логином из запроса (login:ip:username, login-lock:ip:username).
// Свой потолок: спрей выдуманными логинами вытесняет только соседние такие же
// ключи (аудит, проверка раунда 4, находка ПР-01).
const nameBuckets = new Map();

const DEFAULT_MAX_BUCKETS = 100000;
const DEFAULT_NAME_MAX_BUCKETS = 20000;
let maxBuckets = DEFAULT_MAX_BUCKETS;
let nameMaxBuckets = DEFAULT_NAME_MAX_BUCKETS;

function mapFor(scope) {
  return scope === 'name' ? nameBuckets : buckets;
}
function capFor(scope) {
  return scope === 'name' ? nameMaxBuckets : maxBuckets;
}

// Кладёт ключ, вытесняя самый старый, если карта уже заполнена. Вытеснение —
// O(1): первый ключ в порядке вставки и есть самый старый. Отказать вместо
// вытеснения нельзя: это остановило бы вход и переподключение сотрудникам,
// которых никто не атакует (находка ПР-01, критическая).
function setBounded(map, cap, key, value) {
  if (map.size >= cap && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function currentBucket(map, key, windowMs) {
  const bucket = map.get(key);
  if (!bucket || Date.now() - bucket.windowStart >= windowMs) return null;
  return bucket;
}

function checkRateLimit(key, { maxAttempts = 5, windowMs = 60000, scope = 'default' } = {}) {
  const now = Date.now();
  const map = mapFor(scope);
  const bucket = currentBucket(map, key, windowMs);

  if (!bucket) {
    // windowMs хранится вместе с бакетом — иначе периодическая очистка ниже не
    // знает, сколько именно этому ключу положено жить, и либо снимает долгие
    // блокировки (вход, LOGIN_LOCKOUT_MINUTES) раньше срока, либо не чистит
    // короткие вовсе (находка ревью: cleanup всегда считала 10 минут).
    setBounded(map, capFor(scope), key, { count: 1, windowStart: now, windowMs, maxAttempts });
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
// без связи — хотя подбора никто не ведёт. Отсутствие ключа — «не
// ограничено» (fail open): переполнение карты никогда не выдаёт ложную
// блокировку живому сотруднику (находка ПР-01).
function isRateLimited(key, { maxAttempts = 5, windowMs = 60000, scope = 'default' } = {}) {
  const bucket = currentBucket(mapFor(scope), key, windowMs);
  if (!bucket) return false;
  bucket.maxAttempts = maxAttempts;
  return bucket.count >= maxAttempts;
}

// Текущее число в окне (0, если ключа нет). Нужно, чтобы учитывать «в полёте»
// попытки в проверке предела и не давать одному адресу проскочить его пачкой
// одновременных запросов (проверка раунда 4, M6).
function peekCount(key, { windowMs = 60000, scope = 'default' } = {}) {
  const bucket = currentBucket(mapFor(scope), key, windowMs);
  return bucket ? bucket.count : 0;
}

function registerFailure(key, { windowMs = 60000, maxAttempts, scope = 'default' } = {}) {
  const now = Date.now();
  const map = mapFor(scope);
  const bucket = currentBucket(map, key, windowMs);
  if (bucket) {
    bucket.count += 1;
    if (Number.isFinite(maxAttempts)) bucket.maxAttempts = maxAttempts;
    return;
  }
  setBounded(map, capFor(scope), key, { count: 1, windowStart: now, windowMs, maxAttempts });
}

// Успешное действие (например, вход) должно снимать уже накопленные неудачи
// по этому же ключу — иначе они продолжают копиться к следующей блокировке,
// хотя подбора не было ни секунды.
function resetLimit(key, { scope = 'default' } = {}) {
  mapFor(scope).delete(key);
}

// Бакет старше собственного окна уже не действует (currentBucket и так вернёт
// null для него на следующей проверке) — очистка лишь освобождает память и не
// имеет права закончиться раньше этого срока. Раньше здесь был фиксированный
// предел в 10 минут для всех ключей разом, и он снимал более долгие блокировки
// (например, 15-минутную по LOGIN_LOCKOUT_MINUTES) на пять минут раньше срока.
function pruneStaleBuckets(now = Date.now()) {
  for (const map of [buckets, nameBuckets]) {
    for (const [key, bucket] of map.entries()) {
      const ttl = bucket.windowMs || 10 * 60000;
      if (now - bucket.windowStart >= ttl) map.delete(key);
    }
  }
}

// Для тестов: уменьшить потолки, чтобы проверить вытеснение без сотни тысяч
// ключей, и узнать текущий размер.
function configureLimiter({ maxBuckets: max, nameMaxBuckets: nameMax } = {}) {
  maxBuckets = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_BUCKETS;
  nameMaxBuckets = Number.isInteger(nameMax) && nameMax > 0 ? nameMax : DEFAULT_NAME_MAX_BUCKETS;
}

function limiterSize(scope) {
  if (scope === 'name') return nameBuckets.size;
  if (scope === 'all') return buckets.size + nameBuckets.size;
  return buckets.size;
}

// Periodic cleanup so the map doesn't grow unbounded with stale IPs/usernames.
setInterval(() => pruneStaleBuckets(), 5 * 60000).unref();

module.exports = {
  checkRateLimit,
  isRateLimited,
  peekCount,
  registerFailure,
  resetLimit,
  pruneStaleBuckets,
  configureLimiter,
  limiterSize
};
