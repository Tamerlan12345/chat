const crypto = require('node:crypto');
const { promisify } = require('node:util');

const rawScrypt = promisify(crypto.scrypt);

// Одновременно считается не больше PASSWORD_HASH_CONCURRENCY хэшей (по
// умолчанию 2), остальные ждут в очереди. Каждый расчёт при N=2^17 — около
// 128 МиБ памяти и заметная доля секунды процессора в потоке libuv; этих
// потоков по умолчанию четыре, и на них же идёт чтение и запись файлов. Поток
// попыток входа без этого предела занимал их все: вложения и обновления
// переставали отдаваться, память росла на 128 МиБ за каждый параллельный
// расчёт (аудит, раунд 4, находка Р4-03). Очередь короткая: переполненная —
// отказ сразу (код PASSWORD_HASH_BUSY → 503), а не ожидание в минуты.
const HASH_QUEUE_MAX = 100;
let hashActive = 0;
const hashWaiters = [];

function hashConcurrency() {
  // Читается при каждом вызове, а не один раз: config загружается раньше
  // этого модуля не всегда (скрипты восстановления, тесты).
  try {
    return require('../../config').PASSWORD_HASH_CONCURRENCY || 2;
  } catch {
    return 2;
  }
}

function busyError() {
  const err = new Error('Сервер занят проверкой паролей — повторите через несколько секунд');
  err.code = 'PASSWORD_HASH_BUSY';
  return err;
}

async function scrypt(...args) {
  if (hashActive >= hashConcurrency()) {
    if (hashWaiters.length >= HASH_QUEUE_MAX) throw busyError();
    await new Promise((resolve) => hashWaiters.push(resolve));
  } else {
    hashActive += 1;
  }
  try {
    return await rawScrypt(...args);
  } finally {
    // Место передаётся следующему в очереди напрямую, без уменьшения счётчика:
    // иначе между освобождением и пробуждением его мог бы занять третий.
    const next = hashWaiters.shift();
    if (next) next();
    else hashActive -= 1;
  }
}

// Параметры вывода ключа. Прежний код звал crypto.scryptSync со значениями по
// умолчанию (N=16384) и, что важнее, делал это синхронно: на время вычисления
// сервер переставал обслуживать кого бы то ни было. Вход и смена пароля —
// единственные места, где это происходит, но при десятке одновременных входов
// задержка складывается. Здесь тот же алгоритм, но асинхронный.
// N=131072 (2^17) — нижняя граница текущей рекомендации OWASP для scrypt
// (аудит, находка №18); прежний N=32768 (2^15) подбирался вчетверо дешевле.
// Формат хранения несёт параметры рядом с ключом (см. ниже), поэтому подъём
// стоимости не требует миграции: уже сохранённые пароли проверяются своими
// прежними параметрами и пересчитываются при следующем успешном входе
// (verifyPassword → needsRehash → AuthService.login).
const CURRENT = Object.freeze({ N: 131072, r: 8, p: 1, keylen: 64 });

// scrypt требует явного лимита памяти не меньше 128 * N * r — здесь вдвое
// больше того, для запаса. При N=131072, r=8 это 256 МиБ.
const maxmemFor = ({ N, r }) => 256 * N * r;

const b64 = (buf) => buf.toString('base64');

/**
 * Формат хранения: scrypt$N=<N>,r=<r>,p=<p>$<соль base64>$<ключ base64>.
 * Параметры записаны рядом с самим ключом, поэтому их можно поднять позже, не
 * ломая уже сохранённые пароли: старая запись проверится своими параметрами и
 * будет пересчитана при следующем успешном входе (см. needsRehash).
 */
async function hashPassword(password) {
  assertPassword(password);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(normalize(password), salt, CURRENT.keylen, {
    N: CURRENT.N,
    r: CURRENT.r,
    p: CURRENT.p,
    maxmem: maxmemFor(CURRENT)
  });
  return `scrypt$N=${CURRENT.N},r=${CURRENT.r},p=${CURRENT.p}$${b64(salt)}$${b64(derived)}`;
}

/**
 * Проверка пароля. Понимает и новый формат, и прежний (отдельные колонки
 * password_hash в hex и salt в hex, параметры scrypt по умолчанию) — иначе при
 * переходе на PostgreSQL никто из уже заведённых сотрудников не смог бы войти.
 *
 * @returns {Promise<{ ok: boolean, needsRehash: boolean }>}
 */
async function verifyPassword(password, storedHash, legacySalt = null) {
  if (typeof password !== 'string' || !password || !storedHash) {
    return { ok: false, needsRehash: false };
  }

  if (String(storedHash).startsWith('scrypt$')) {
    const parsed = parseEncoded(storedHash);
    if (!parsed) return { ok: false, needsRehash: false };
    const derived = await scrypt(normalize(password), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmemFor(parsed)
    });
    return {
      ok: timingSafeEqual(derived, parsed.hash),
      needsRehash: parsed.N < CURRENT.N || parsed.r !== CURRENT.r || parsed.p !== CURRENT.p
    };
  }

  // Прежний формат: hex-ключ и hex-соль в соседних колонках.
  if (!legacySalt) return { ok: false, needsRehash: false };
  let expected;
  try {
    expected = Buffer.from(String(storedHash), 'hex');
  } catch {
    return { ok: false, needsRehash: false };
  }
  if (!expected.length) return { ok: false, needsRehash: false };

  const derived = await scrypt(normalize(password), String(legacySalt), expected.length);
  return { ok: timingSafeEqual(derived, expected), needsRehash: true };
}

// Сравнение за постоянное время. Прежний код сравнивал строки оператором === :
// длительность такого сравнения зависит от того, сколько первых символов
// совпало, и по ней теоретически восстанавливается сам ключ.
function timingSafeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseEncoded(encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;

  const params = {};
  for (const chunk of parts[1].split(',')) {
    const [key, value] = chunk.split('=');
    params[key] = Number(value);
  }
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
    return null;
  }
  // Защита от записи, подсовывающей неподъёмные параметры: пересчёт такой
  // строки занял бы весь процессор. Значения выше нынешних не бывают законными.
  if (params.N > 1 << 20 || params.r > 32 || params.p > 16) return null;

  try {
    return {
      N: params.N,
      r: params.r,
      p: params.p,
      salt: Buffer.from(parts[2], 'base64'),
      hash: Buffer.from(parts[3], 'base64')
    };
  } catch {
    return null;
  }
}

// Пароль с пробелами по краям почти всегда — след буфера обмена, а не
// намерение; при этом обрезать его молча нельзя, иначе заданный и
// проверяемый пароль разойдутся. Нормализация Unicode нужна для кириллицы:
// одна и та же буква бывает записана двумя разными последовательностями.
function normalize(password) {
  return String(password).normalize('NFKC');
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Пароль не может быть пустым');
  }
  // Ограничение сверху — защита сервера, а не требование к сотруднику:
  // scrypt считает тем дольше, чем длиннее вход, и мегабайтный «пароль»
  // занял бы процессор целиком.
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('Пароль слишком длинный');
  }
}

// Для тестов: сколько расчётов идёт и ждёт прямо сейчас.
function hashLoad() {
  return { active: hashActive, waiting: hashWaiters.length };
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashLoad,
  HASH_QUEUE_MAX,
  CURRENT_PARAMS: CURRENT
};
