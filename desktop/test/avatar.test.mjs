import test from 'node:test';
import assert from 'node:assert';
import { initialsOf, avatarColor, greetingName } from '../src/renderer/src/lib/avatar.mjs';

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
