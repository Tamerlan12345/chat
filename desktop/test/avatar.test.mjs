import test from 'node:test';
import assert from 'node:assert';
import { initialsOf, avatarColor, greetingName, avatarSrc } from '../src/renderer/src/lib/avatar.mjs';

// Одного и того же человека интерфейс рисовал тремя способами: в списке
// диалогов — значок фотоаппарата, в переписке — кружок с инициалами, во
// всплывающем уведомлении — первые две буквы фамилии («ИВ» у Иванова Ивана).

test('инициалы — первые буквы фамилии и имени', () => {
  assert.strictEqual(initialsOf('Иванов Иван Иванович'), 'ИИ');
  assert.strictEqual(initialsOf('Петрова Анна'), 'ПА');
});

test('одно слово — одна буква, пустое имя — без падения', () => {
  assert.strictEqual(initialsOf('Администратор'), 'А');
  assert.strictEqual(initialsOf('  '), '?');
  assert.strictEqual(initialsOf(null), '?');
});

test('служебная запись «Администратор системы» — одна буква, а не «АС»', () => {
  // Второе слово со строчной буквы — не имя, а продолжение названия.
  assert.strictEqual(initialsOf('Администратор системы'), 'А');
});

test('цвет аватара постоянен для одного человека', () => {
  assert.strictEqual(avatarColor('Иванов Иван'), avatarColor('Иванов Иван'));
  assert.match(avatarColor('Иванов Иван'), /^#[0-9a-f]{6}$/i);
  assert.match(avatarColor(''), /^#[0-9a-f]{6}$/i);
});

test('собеседники в одной переписке различаются цветом', () => {
  // Администратор и Иванов выходили одинаково коричневыми.
  assert.notStrictEqual(avatarColor('Администратор системы'), avatarColor('Иванов Иван'));
  assert.notStrictEqual(avatarColor('Иванов Иван'), avatarColor('Петрова Анна'));
});

test('приветствие обращается по имени', () => {
  assert.strictEqual(greetingName('Иванов Иван Иванович'), 'Иван');
  assert.strictEqual(greetingName('Петрова Анна'), 'Анна');
});

test('служебную запись не называют «системы»', () => {
  // На экране было «Доброе утро, системы!»: вторым словом разбор считал имя.
  assert.strictEqual(greetingName('Администратор системы'), 'Администратор системы');
  assert.strictEqual(greetingName(''), '');
});

test('запись из одного слова остаётся как есть', () => {
  assert.strictEqual(greetingName('Администратор'), 'Администратор');
});

// Задача 20: сервер отдаёт настольному клиенту фото, как и раньше, строкой
// data URL; другим клиентам — адресом /api/users/<id>/avatar?v=…, который без
// заголовка авторизации не открыть. Если такой адрес всё же дошёл до
// настольного интерфейса (страница открыта в браузере), показываются
// инициалы — без запроса, который заведомо получит 401.

test('фото data URL (как сохраняет настольный клиент) показывается как есть', () => {
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  assert.strictEqual(avatarSrc(photo), photo);
  assert.strictEqual(avatarSrc('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
});

test('адрес аватара на сервере без авторизации не грузится — инициалы', () => {
  assert.strictEqual(avatarSrc('/api/users/5/avatar?v=0123456789abcdef'), null);
  assert.strictEqual(avatarSrc('api/users/5/avatar'), null);
});

test('пустое значение и чужие схемы — инициалы; прежние ссылки http(s) — как раньше', () => {
  assert.strictEqual(avatarSrc(null), null);
  assert.strictEqual(avatarSrc(''), null);
  assert.strictEqual(avatarSrc(undefined), null);
  assert.strictEqual(avatarSrc('javascript:alert(1)'), null);
  assert.strictEqual(avatarSrc('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.strictEqual(avatarSrc('https://old.example/photo.png'), 'https://old.example/photo.png');
  assert.strictEqual(avatarSrc('blob:http://localhost/abc'), 'blob:http://localhost/abc');
});
