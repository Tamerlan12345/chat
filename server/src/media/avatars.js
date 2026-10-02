// Аватары ссылкой (задача 20).
//
// Фотография сотрудника хранится, как и раньше, в users.avatar_url строкой
// data:image/…;base64 — так её по-прежнему получает настольный клиент
// (рисует <img src=…> в нескольких местах и отправляет обратно при
// сохранении профиля). Остальным клиентам data URL больше не отдаётся:
// справочник из сотен сотрудников с фотографиями по 30–700 КБ каждая весил
// десятки мегабайт. Вместо неё в том же поле avatar_url (и sender_avatar
// сообщения) — адрес /api/users/<id>/avatar?v=<версия>; картинку по нему
// сервер всегда перекодирует сам (sharp), исходные байты не отдаёт.
//
// Кто «настольный клиент», сервер узнаёт по User-Agent: Electron его не
// меняет, а приложение лишь дописывает «OpenMyChatDesktop/<версия>»
// (desktop/src/main/main.js). Это не мера безопасности — подделавший
// User-Agent получит те же фотографии, что и так видны ему в справочнике, —
// а только выбор формы ответа.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const Images = require('./images');

const AVATARS_DIR = path.join(config.UPLOADS_DIR, '.avatars');
const LEGACY_UA_RE = /\bElectron\/|\bOpenMyChatDesktop\//;
const RENDER_VERSION = 'v1';

function wantsLegacyAvatars(headers = {}) {
  return LEGACY_UA_RE.test(String(headers['user-agent'] || ''));
}

function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:');
}

/** Адрес аватара для хранимого значения или null (нет фото, старая ссылка). */
function avatarUrlFor(userId, stored) {
  const id = Number(userId);
  if (!isDataUrl(stored) || !Number.isSafeInteger(id) || id <= 0) return null;
  return `/api/users/${id}/avatar?v=${Images.avatarVersion(stored)}`;
}

// Адрес аватара этого сотрудника в любой версии — его отправляет обратно
// клиент, получивший профиль в новой форме.
function isOwnAvatarUrl(userId, value) {
  return typeof value === 'string' && new RegExp(`^/api/users/${Number(userId)}/avatar(\\?v=[0-9a-f]{1,64})?$`).test(value);
}

// Чей аватар в этом объекте: у пользователя — id, у строки переписки —
// user_id, у сообщения — sender_id (для sender_avatar).
function ownerOf(obj, key) {
  if (key === 'sender_avatar') return obj.sender_id;
  return obj.user_id !== undefined && obj.user_id !== null ? obj.user_id : obj.id;
}

const AVATAR_KEYS = ['avatar_url', 'sender_avatar'];
const MAX_DEPTH = 16;

/**
 * Копия ответа, где data URL аватаров заменены адресами. Исходный объект не
 * меняется (это могут быть общие записи — req.user, сокетный снимок
 * пользователя); неизменённые ветви возвращаются как есть.
 * Значение аватара, которое не data URL (ссылка из старых версий), заменяется
 * на null: клиент не должен ходить с токеном по произвольному адресу.
 */
function shapeAvatars(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = shapeAvatars(value[i], depth + 1);
      if (next !== value[i]) {
        out = out || value.slice();
        out[i] = next;
      }
    }
    return out || value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  let out = null;
  for (const key of Object.keys(value)) {
    const current = value[key];
    let next;
    if (AVATAR_KEYS.includes(key) && typeof current === 'string') {
      next = isOwnAvatarUrl(ownerOf(value, key), current) ? current : avatarUrlFor(ownerOf(value, key), current);
    } else {
      next = shapeAvatars(current, depth + 1);
    }
    if (next !== current) {
      out = out || { ...value };
      out[key] = next;
    }
  }
  return out || value;
}

// Готовый текст кадра WebSocket: разбирается, только если в нём вообще есть
// data URL — остальные кадры (и звук, он двоичный) идут как есть.
function shapeFrame(text) {
  if (typeof text !== 'string' || !text.includes('"data:')) return text;
  try {
    return JSON.stringify(shapeAvatars(JSON.parse(text)));
  } catch {
    return text;
  }
}

const inFlight = new Map();

/**
 * Перекодированный аватар сотрудника: файл в кэше, имя которого — из id,
 * версии (хеш хранимого значения, считает сервер) и размера из белого списка.
 * → { path, etag } или null (фото нет, оно не data URL или не читается).
 */
async function getAvatarFile(userId, stored, size) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0 || !Object.hasOwn(Images.AVATAR_SIZES, size)) return null;
  const bytes = Images.decodeDataUrl(stored);
  if (!bytes) return null;
  const version = Images.avatarVersion(stored);
  const target = path.join(AVATARS_DIR, `${id}-${version}-${size}.jpg`);
  const etag = `"avatar-${RENDER_VERSION}-${version}-${size}"`;
  if (fs.existsSync(target)) return { path: target, etag };

  let pending = inFlight.get(target);
  if (!pending) {
    pending = (async () => {
      const jpeg = await Images.renderAvatar(bytes, size);
      await fs.promises.mkdir(AVATARS_DIR, { recursive: true });
      const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.promises.writeFile(tmp, jpeg, { flag: 'wx' });
        await fs.promises.rename(tmp, target);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
      await removeStale(id, version);
    })();
    inFlight.set(target, pending);
    pending.then(() => inFlight.delete(target), () => inFlight.delete(target));
  }
  try {
    await pending;
  } catch (err) {
    if (err instanceof Images.ImageError && err.status !== 503) return null;
    throw err;
  }
  return { path: target, etag };
}

// Прежние версии аватара этого сотрудника. Удаляются только файлы с именем
// «<id>-<16 hex>-<размер>.jpg» прямо в каталоге .avatars — имя целиком
// собрано сервером, ничего из запроса.
async function removeStale(id, currentVersion) {
  let names;
  try {
    names = await fs.promises.readdir(AVATARS_DIR);
  } catch {
    return;
  }
  const own = new RegExp(`^${id}-([0-9a-f]{16})-(${Object.keys(Images.AVATAR_SIZES).join('|')})\\.jpg$`);
  for (const name of names) {
    const match = own.exec(name);
    if (match && match[1] !== currentVersion) await fs.promises.rm(path.join(AVATARS_DIR, name), { force: true });
  }
}

module.exports = {
  wantsLegacyAvatars,
  avatarUrlFor,
  isOwnAvatarUrl,
  shapeAvatars,
  shapeFrame,
  getAvatarFile,
  AVATARS_DIR
};
