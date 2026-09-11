const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// Параметры вывода ключа. Прежний код звал crypto.scryptSync со значениями по
// умолчанию (N=16384) и, что важнее, делал это синхронно: на время вычисления
// сервер переставал обслуживать кого бы то ни было. Вход и смена пароля —
// единственные места, где это происходит, но при десятке одновременных входов
// задержка складывается. Здесь тот же алгоритм, но асинхронный и с вдвое
// большей стоимостью подбора.
const CURRENT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64 });

// scrypt требует явного лимита памяти: 128 * N * r с запасом.
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

module.exports = {
  hashPassword,
  verifyPassword,
  CURRENT_PARAMS: CURRENT
};
