// Докачка вложений (задача 20): заголовки Range, If-Range, If-None-Match.
//
// Разбор намеренно строгий: принимается ровно один диапазон в байтах —
// «bytes=начало-конец», «bytes=начало-» или «bytes=-хвост». Всё остальное
// (несколько диапазонов, пробелы, другие единицы, пустой или перевёрнутый
// диапазон, начало за концом файла) — 416. Несколько диапазонов означали бы
// multipart/byteranges и многократное чтение одного файла одним запросом;
// мобильным клиентам для докачки нужен один.

const MAX_DIGITS = 15; // 999 ТБ — больше любого вложения; длиннее — мусор

const SPAN_RE = new RegExp(`^bytes=(\\d{1,${MAX_DIGITS}})-(\\d{0,${MAX_DIGITS}})$`);
const SUFFIX_RE = new RegExp(`^bytes=-(\\d{1,${MAX_DIGITS}})$`);

/**
 * parseRange(header, size) → null (заголовка нет), { start, end } (включительно)
 * или { invalid: true } — ответить 416.
 */
function parseRange(header, size) {
  if (header === undefined) return null;
  const value = String(header);
  const total = Number(size);
  let start;
  let end;
  const span = SPAN_RE.exec(value);
  if (span) {
    start = Number(span[1]);
    end = span[2] === '' ? total - 1 : Math.min(Number(span[2]), total - 1);
    if (Number(span[2] === '' ? start : span[2]) < start) return { invalid: true };
  } else {
    const suffix = SUFFIX_RE.exec(value);
    if (!suffix) return { invalid: true };
    const length = Number(suffix[1]);
    if (length === 0) return { invalid: true };
    start = Math.max(0, total - length);
    end = total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || end < start) {
    return { invalid: true };
  }
  return { start, end };
}

// Список меток из If-None-Match / If-Range: слабые метки сравниваются по
// значению (RFC 9110, слабое сравнение для If-None-Match).
function etagListMatches(header, etag) {
  if (header === undefined || !etag) return false;
  const value = String(header).trim();
  if (value === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return value.split(',').some((part) => part.trim().replace(/^W\//, '') === bare);
}

// If-Range: диапазон отдаётся, только если метка совпала строго; дата в
// If-Range не поддерживается — тогда весь файл (безопасный вариант по RFC).
function ifRangeAllows(header, etag) {
  if (header === undefined) return true;
  const value = String(header).trim();
  return Boolean(etag) && !value.startsWith('W/') && value === etag;
}

module.exports = { parseRange, etagListMatches, ifRangeAllows };
