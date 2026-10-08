// Аватар без фотографии и обращение по имени.
//
// ФИО хранится как «Фамилия Имя Отчество». Служебные записи вроде
// «Администратор системы» выглядят так же — два слова, — но второе слово
// у них пишется со строчной буквы и именем не является.

import { parseFullName } from './person-name.mjs';

// Белый текст на каждом из этих цветов читается с контрастом не ниже 4.5:1.
const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0e7490', '#047857', '#b45309', '#be185d', '#4338ca', '#475569'];

const words = (name) => String(name || '').trim().split(/\s+/).filter(Boolean);
const startsUppercase = (word) => Boolean(word) && word[0] !== word[0].toLowerCase();

export function initialsOf(name) {
  const parts = words(name);
  if (parts.length === 0) return '?';
  const second = startsUppercase(parts[1]) ? parts[1][0] : '';
  return (parts[0][0] + second).toUpperCase();
}

export function avatarColor(name) {
  const key = String(name || '');
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  // Перемешивание старших битов: без него остаток от деления зависел почти
  // только от последних букв, и администратор с Ивановым получали один цвет.
  hash = (hash ^ (hash >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x45d9f3b) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Как обратиться к человеку в приветствии. Имя — второе слово, если оно
// похоже на имя; иначе запись показывается целиком, а не обрывком.
export function greetingName(fullName) {
  const parts = words(fullName);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const { firstName } = parseFullName(fullName);
  return startsUppercase(firstName) ? firstName : parts.join(' ');
}

// Что можно подставить в <img src> аватара (задача 20). Сервер отдаёт
// настольному клиенту фото, как и раньше, строкой data URL. Другим клиентам
// он присылает адрес /api/users/<id>/avatar?v=… — <img> не умеет отправить с
// ним токен, и запрос заведомо получил бы 401: тогда сразу инициалы.
// Прочие схемы (javascript:, data: не с картинкой) — тоже инициалы.
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,/i;
const LOADABLE_RE = /^(https?:|blob:)/i;

export function avatarSrc(src) {
  if (typeof src !== 'string' || !src) return null;
  if (DATA_IMAGE_RE.test(src) || LOADABLE_RE.test(src)) return src;
  return null;
}
