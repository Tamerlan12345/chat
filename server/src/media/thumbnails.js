// Кэш миниатюр вложений на диске (задача 20).
//
// Путь к миниатюре строится только из числового id файла, ключа содержимого
// (хеш от данных, которые сервер записал сам) и размера и формата из коротких
// белых списков — ничто из запроса (имя файла, расширение, произвольная
// строка) в путь не попадает. Каталог .thumbs лежит рядом с
// вложениями и, как и они, наружу статикой не отдаётся: только через маршрут
// с той же проверкой доступа, что у скачивания.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const Images = require('./images');

const THUMBS_DIR = path.join(config.UPLOADS_DIR, '.thumbs');
// Меняется, если меняется способ отрисовки: старые метки ETag тогда не совпадут.
const RENDER_VERSION = 'v1';
const EXT = { webp: 'webp', jpeg: 'jpg' };

const inFlight = new Map(); // путь кэша → Promise<{ color, source }>

// Ключ содержимого: id файла после восстановления базы из копии может
// достаться другому вложению, а каталог миниатюр остаётся прежним — без ключа
// новый файл получил бы чужую миниатюру. stored_filename сервер придумывает
// сам при загрузке (время + случайная часть), sha256 считает тоже сам.
function contentKey(file) {
  return crypto.createHash('sha256').update(`${file.stored_filename}:${file.sha256 || ''}`).digest('hex').slice(0, 16);
}

function cachePathFor(file, size, format) {
  const id = Number(file.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Неверный id файла');
  if (!Object.hasOwn(Images.THUMB_SIZES, size) || !Object.hasOwn(EXT, format)) throw new Error('Неверный размер или формат');
  return path.join(THUMBS_DIR, `${id}-${contentKey(file)}-${size}.${EXT[format]}`);
}

function etagFor(file, size, format) {
  return `"thumb-${RENDER_VERSION}-${contentKey(file)}-${size}-${format}"`;
}

/**
 * Миниатюра файла: из кэша или отрисованная сейчас. → { path, etag,
 * contentType, rendered } где rendered — сведения о картинке, если она
 * отрисовывалась в этом вызове (для заполнения размеров вложения).
 */
async function getThumbnail(file, { size, format }) {
  const target = cachePathFor(file, size, format);
  const contentType = format === 'webp' ? 'image/webp' : 'image/jpeg';
  const etag = etagFor(file, size, format);
  if (fs.existsSync(target)) return { path: target, etag, contentType, rendered: null };

  let pending = inFlight.get(target);
  if (!pending) {
    pending = (async () => {
      const thumb = await Images.renderThumbnail(file.path, { size, format });
      await fs.promises.mkdir(THUMBS_DIR, { recursive: true });
      // Запись через временный файл: параллельный читатель никогда не увидит
      // недописанную миниатюру.
      const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.promises.writeFile(tmp, thumb.buffer, { flag: 'wx' });
        await fs.promises.rename(tmp, target);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
      return { source: thumb.source, color: thumb.color };
    })();
    inFlight.set(target, pending);
    pending.then(() => inFlight.delete(target), () => inFlight.delete(target));
  }
  const rendered = await pending;
  return { path: target, etag, contentType, rendered };
}

module.exports = { getThumbnail, cachePathFor, THUMBS_DIR };
