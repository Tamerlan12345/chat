import test from 'node:test';
import assert from 'node:assert';
import { parseFullName, formatFullName } from '../src/renderer/src/lib/person-name.mjs';

// В карточке сотрудника ФИО хранится одной строкой в порядке «Фамилия Имя
// Отчество» — так его вводят администраторы и так оно показано во всех
// списках. Форма профиля разбирала эту строку как «Имя, дальше всё
// остальное»: фамилия попадала в поле «Имя», отчество — в поле «Фамилия».
// Сохранение возвращало всё на место, поэтому ошибку было видно только
// глазами, открыв свой профиль.

test('полное ФИО разбирается по своим полям', () => {
  assert.deepStrictEqual(parseFullName('Сидоров Сидор Сидорович'), {
    lastName: 'Сидоров',
    firstName: 'Сидор',
    patronymic: 'Сидорович'
  });
});

test('без отчества — две части', () => {
  assert.deepStrictEqual(parseFullName('Петрова Анна'), {
    lastName: 'Петрова',
    firstName: 'Анна',
    patronymic: ''
  });
});

test('одно слово считается фамилией', () => {
  // Так заведены учётные записи вроде «Администратор»: это не имя.
  assert.deepStrictEqual(parseFullName('Администратор'), {
    lastName: 'Администратор',
    firstName: '',
    patronymic: ''
  });
});

test('двойная фамилия не рассыпается', () => {
  // Всё, что дальше третьего слова, остаётся в отчестве — потерять часть
  // имени человека хуже, чем оставить её не в том поле.
  const parsed = parseFullName('Ким Ли Сергей Петрович');
  assert.strictEqual(parsed.lastName, 'Ким');
  assert.strictEqual(parsed.firstName, 'Ли');
  assert.strictEqual(parsed.patronymic, 'Сергей Петрович');
});

test('лишние пробелы не создают пустых частей', () => {
  assert.deepStrictEqual(parseFullName('  Сидоров   Сидор  '), {
    lastName: 'Сидоров',
    firstName: 'Сидор',
    patronymic: ''
  });
});

test('пустое значение не роняет разбор', () => {
  assert.deepStrictEqual(parseFullName(''), { lastName: '', firstName: '', patronymic: '' });
  assert.deepStrictEqual(parseFullName(null), { lastName: '', firstName: '', patronymic: '' });
  assert.deepStrictEqual(parseFullName(undefined), { lastName: '', firstName: '', patronymic: '' });
});

test('собранное обратно ФИО совпадает с исходным', () => {
  for (const name of ['Сидоров Сидор Сидорович', 'Петрова Анна', 'Администратор']) {
    assert.strictEqual(formatFullName(parseFullName(name)), name, name);
  }
});

test('сборка не оставляет двойных пробелов при пустых частях', () => {
  assert.strictEqual(
    formatFullName({ lastName: 'Сидоров', firstName: '', patronymic: 'Сидорович' }),
    'Сидоров Сидорович'
  );
  assert.strictEqual(formatFullName({ lastName: '', firstName: '', patronymic: '' }), '');
});

test('отчество не теряется при сохранении', () => {
  // Ровно то, что не работало: поле было, его заполняли, и оно пропадало.
  const parsed = parseFullName('Сидоров Сидор');
  parsed.patronymic = 'Сидорович';
  assert.strictEqual(formatFullName(parsed), 'Сидоров Сидор Сидорович');
});
