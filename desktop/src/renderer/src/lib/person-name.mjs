// Разбор и сборка ФИО.
//
// В базе имя хранится одной строкой в порядке «Фамилия Имя Отчество» — так его
// вводят администраторы, так оно приходит из импорта оргструктуры и так
// показано во всех списках. Форма профиля обязана разбирать его в том же
// порядке: иначе человек открывает свою карточку и видит фамилию в поле «Имя».

/**
 * @param {string} fullName
 * @returns {{ lastName: string, firstName: string, patronymic: string }}
 */
export function parseFullName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    // Всё, что дальше третьего слова, остаётся здесь: потерять часть имени
    // человека хуже, чем оставить её не в том поле. Двойные имена и фамилии
    // встречаются чаще, чем кажется.
    patronymic: parts.slice(2).join(' ')
  };
}

/**
 * Собирает строку обратно. Пустые части не оставляют двойных пробелов —
 * иначе у сотрудника без отчества имя каждый раз обрастало бы лишним
 * пробелом при сохранении.
 */
export function formatFullName({ lastName = '', firstName = '', patronymic = '' } = {}) {
  return [lastName, firstName, patronymic]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}
