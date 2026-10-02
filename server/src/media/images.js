// Картинки для мобильных клиентов (задача 20): миниатюры вложений, размеры и
// преобладающий цвет картинки, перекодирование аватаров.
//
// Картинку прислал пользователь, поэтому каждая проверка здесь — на случай
// враждебного файла:
//  - тип определяется по сигнатуре (первые байты), а не по имени и не по
//    MIME, который назвал загрузивший; принимаются только JPEG, PNG, GIF, WebP
//    (без SVG — это документ со скриптами, и без форматов, которые libvips
//    понимает «заодно»: TIFF, HEIF, PDF…);
//  - «бомба распаковки» (маленький файл, заявляющий 20000×20000) отсекается по
//    заголовку до декодирования: limitInputPixels у sharp проверяет размеры
//    из заголовка, а наш предел ниже стандартного;
//  - декодирование ограничено по времени и по числу одновременных задач;
//  - наружу уходит только перекодированное изображение без метаданных (EXIF с
//    координатами съёмки, имена устройств), исходные байты не отдаются никогда.

const fs = require('node:fs');
const crypto = require('node:crypto');
const sharp = require('sharp');

// Кэш libvips держит декодированные картинки в памяти между запросами — для
// сервера переписки это лишнее: миниатюры и так кэшируются на диске.
sharp.cache(false);
// Потоков libvips на одну картинку: декодирование не должно занимать все ядра.
sharp.concurrency(1);

const MAX_INPUT_PIXELS = 50 * 1000 * 1000; // 50 Мп: снимки телефонов проходят, «бомбы» — нет
const MAX_SOURCE_BYTES = 40 * 1024 * 1024; // картинка-вложение крупнее — без миниатюры
const RENDER_TIMEOUT_SECONDS = 15;
const MAX_PARALLEL_RENDERS = 2;
const MAX_WAITING_RENDERS = 64;

const THUMB_SIZES = { s: 160, m: 480 };
const THUMB_FORMATS = new Set(['webp', 'jpeg']);

class ImageError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const notAnImage = () => new ImageError('NOT_AN_IMAGE', 'Файл не является изображением JPEG, PNG, GIF или WebP', 415);
const tooLarge = () => new ImageError('IMAGE_TOO_LARGE', 'Изображение слишком большое для обработки', 422);
const unreadable = () => new ImageError('IMAGE_UNREADABLE', 'Изображение повреждено или не читается', 422);
const busy = () => new ImageError('IMAGE_BUSY', 'Сервер занят обработкой изображений, повторите позже', 503);

// Сигнатуры поддерживаемых форматов.
function sniffImageType(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

async function readHead(filePath, length = 16) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Не больше MAX_PARALLEL_RENDERS декодирований одновременно; очередь
// ограничена — сверх неё запрос сразу получает 503, а не копится в памяти.
let running = 0;
const waiting = [];
async function withRenderSlot(work) {
  if (running >= MAX_PARALLEL_RENDERS) {
    if (waiting.length >= MAX_WAITING_RENDERS) throw busy();
    await new Promise((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

const inputOptions = () => ({ limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', pages: 1, sequentialRead: true });

// Проверка входа без декодирования: сигнатура, размер файла, размеры из
// заголовка. Возвращает { type, width, height } с учётом поворота по EXIF.
async function inspect(input) {
  const head = Buffer.isBuffer(input) ? input.subarray(0, 16) : await readHead(input);
  const type = sniffImageType(head);
  if (!type) throw notAnImage();
  const bytes = Buffer.isBuffer(input) ? input.length : (await fs.promises.stat(input)).size;
  if (bytes > MAX_SOURCE_BYTES) throw tooLarge();
  let meta;
  try {
    meta = await sharp(input, inputOptions()).metadata();
  } catch (err) {
    throw /pixel limit/i.test(String(err?.message)) ? tooLarge() : unreadable();
  }
  // libvips определил формат сам — он обязан совпасть с сигнатурой.
  if (meta.format !== type) throw notAnImage();
  const width = Number(meta.autoOrient?.width ?? meta.width);
  const height = Number(meta.autoOrient?.height ?? meta.height);
  if (!(width > 0 && height > 0)) throw unreadable();
  if (width * height > MAX_INPUT_PIXELS) throw tooLarge();
  return { type, width, height };
}

async function run(pipeline) {
  try {
    return await pipeline.timeout({ seconds: RENDER_TIMEOUT_SECONDS }).toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw /pixel limit/i.test(String(err?.message)) ? tooLarge() : unreadable();
  }
}

function hex(n) {
  return Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, '0');
}

// Преобладающий цвет по уже уменьшенной картинке — дёшево.
async function dominantColor(buffer) {
  try {
    const { dominant } = await sharp(buffer).stats();
    return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  } catch {
    return null;
  }
}

/**
 * Миниатюра: по длинной стороне не больше THUMB_SIZES[size], без увеличения,
 * повёрнута по EXIF, без метаданных. → { buffer, contentType, width, height,
 * source: { width, height }, color }.
 */
async function renderThumbnail(input, { size = 's', format = 'webp' } = {}) {
  const px = THUMB_SIZES[size];
  if (!px || !THUMB_FORMATS.has(format)) throw new ImageError('BAD_REQUEST', 'Неверный размер или формат миниатюры', 400);
  const source = await inspect(input);
  return withRenderSlot(async () => {
    let pipeline = sharp(input, inputOptions())
      .rotate()
      .resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true });
    pipeline = format === 'webp' ? pipeline.webp({ quality: 72 }) : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 78, mozjpeg: true });
    const { data, info } = await run(pipeline);
    return {
      buffer: data,
      contentType: format === 'webp' ? 'image/webp' : 'image/jpeg',
      width: info.width,
      height: info.height,
      source: { width: source.width, height: source.height },
      color: await dominantColor(data)
    };
  });
}

/** Размеры и цвет картинки для метаданных вложения. null — не картинка. */
async function probe(input) {
  let source;
  try {
    source = await inspect(input);
  } catch (err) {
    if (err instanceof ImageError && err.code === 'IMAGE_TOO_LARGE') return null;
    if (err instanceof ImageError) return null;
    throw err;
  }
  const color = await withRenderSlot(async () => {
    const { data } = await run(sharp(input, inputOptions()).rotate().resize({ width: 32, height: 32, fit: 'inside' }).png());
    return dominantColor(data);
  }).catch(() => null);
  return { width: source.width, height: source.height, dominantColor: color };
}

const AVATAR_MASTER_PX = 256;
const AVATAR_SIZES = { s: 96, m: 256 };

/**
 * Аватар для хранения: не больше 256 px по длинной стороне (вписывается целиком, как
 * обрезал настольный клиент), JPEG без метаданных, прозрачность — на белом.
 */
async function normalizeAvatar(input) {
  await inspect(input);
  return withRenderSlot(async () => {
    const { data } = await run(
      sharp(input, inputOptions())
        .rotate()
        .resize({ width: AVATAR_MASTER_PX, height: AVATAR_MASTER_PX, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85, mozjpeg: true })
    );
    return data;
  });
}

/** Аватар для показа: квадрат size×size (обрезка по центру), JPEG без метаданных. */
async function renderAvatar(input, size = 'm') {
  const px = AVATAR_SIZES[size];
  if (!px) throw new ImageError('BAD_REQUEST', 'Неверный размер аватара', 400);
  await inspect(input);
  return withRenderSlot(async () => {
    const { data } = await run(
      sharp(input, inputOptions())
        .rotate()
        .resize({ width: px, height: px, fit: 'cover', position: 'centre' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82, mozjpeg: true })
    );
    return data;
  });
}

// data:image/…;base64,… → байты. Только base64 и только картинки; что внутри
// на самом деле — решает сигнатура (inspect), а не заявленный тип.
const DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/;
function decodeDataUrl(value) {
  const match = DATA_URL_RE.exec(String(value || ''));
  return match ? Buffer.from(match[2], 'base64') : null;
}

function toDataUrl(jpegBuffer) {
  return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
}

// Версия аватара для адреса и ETag: короткий хеш хранимого значения.
function avatarVersion(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

module.exports = {
  ImageError,
  sniffImageType,
  inspect,
  probe,
  renderThumbnail,
  normalizeAvatar,
  renderAvatar,
  decodeDataUrl,
  toDataUrl,
  avatarVersion,
  THUMB_SIZES,
  AVATAR_SIZES,
  MAX_INPUT_PIXELS,
  MAX_SOURCE_BYTES
};
