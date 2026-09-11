// Коды виртуальных клавиш Windows по физической клавише (KeyboardEvent.code).
//
// Сочетания клавиш оператора передаются по месту клавиши, а не по символу:
// Ctrl+C на русской раскладке браузер сообщает как key = «с», и прежняя
// передача по символу нажимала у сотрудника Ctrl+«с» — ничего не копировалось.
// Код клавиши от раскладки не зависит: VK_C у сотрудника — это Ctrl+C в любом
// приложении и при любой его раскладке.
//
// Печатный текст сюда не относится: он уходит символами (KEYEVENTF_UNICODE),
// иначе русская буква оператора превращалась бы в ту, что стоит на этой
// клавише в раскладке сотрудника.

const CODE_TO_VK = new Map([
  ['Backspace', 0x08], ['Tab', 0x09], ['Enter', 0x0d], ['NumpadEnter', 0x0d],
  ['Pause', 0x13], ['CapsLock', 0x14], ['Escape', 0x1b], ['Space', 0x20],
  ['PageUp', 0x21], ['PageDown', 0x22], ['End', 0x23], ['Home', 0x24],
  ['ArrowLeft', 0x25], ['ArrowUp', 0x26], ['ArrowRight', 0x27], ['ArrowDown', 0x28],
  ['PrintScreen', 0x2c], ['Insert', 0x2d], ['Delete', 0x2e],
  ['ContextMenu', 0x5d],
  ['NumpadMultiply', 0x6a], ['NumpadAdd', 0x6b], ['NumpadSubtract', 0x6d],
  ['NumpadDecimal', 0x6e], ['NumpadDivide', 0x6f],
  ['NumLock', 0x90], ['ScrollLock', 0x91],
  ['Semicolon', 0xba], ['Equal', 0xbb], ['Comma', 0xbc], ['Minus', 0xbd],
  ['Period', 0xbe], ['Slash', 0xbf], ['Backquote', 0xc0],
  ['BracketLeft', 0xdb], ['Backslash', 0xdc], ['BracketRight', 0xdd], ['Quote', 0xde],
  ['IntlBackslash', 0xe2]
]);

for (let i = 0; i < 26; i++) CODE_TO_VK.set(`Key${String.fromCharCode(65 + i)}`, 0x41 + i);
for (let i = 0; i <= 9; i++) {
  CODE_TO_VK.set(`Digit${i}`, 0x30 + i);
  CODE_TO_VK.set(`Numpad${i}`, 0x60 + i);
}
for (let i = 1; i <= 24; i++) CODE_TO_VK.set(`F${i}`, 0x70 + i - 1);

// Модификаторы (Control, Alt, Shift, Win) в таблице отсутствуют намеренно:
// они приходят флагами при каждой клавише, а Win у оператора всё равно
// перехватывает его собственная система.

// Клавиши из «серого» блока. Без флага KEYEVENTF_EXTENDEDKEY Windows путает
// их с цифровым блоком: стрелка при выключенном NumLock становится цифрой.
const EXTENDED = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp',
  'PageDown', 'Insert', 'Delete', 'NumpadEnter', 'NumpadDivide', 'ContextMenu', 'PrintScreen'
]);

function codeToVk(code) {
  if (typeof code !== 'string') return null;
  return CODE_TO_VK.has(code) ? CODE_TO_VK.get(code) : null;
}

function isExtendedKey(code) {
  return typeof code === 'string' && EXTENDED.has(code);
}

// Прежний формат события — только имя клавиши (KeyboardEvent.key). Понимаются
// именованные клавиши и латиница с цифрами; кириллица по имени не угадывается:
// какой физической клавише она соответствует, знает только раскладка оператора.
const NAMED_KEYS = new Map([
  ['Enter', 'Enter'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['Delete', 'Delete'],
  ['Escape', 'Escape'], ['ArrowUp', 'ArrowUp'], ['ArrowDown', 'ArrowDown'],
  ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'], ['Home', 'Home'], ['End', 'End'],
  ['PageUp', 'PageUp'], ['PageDown', 'PageDown'], ['Insert', 'Insert'], [' ', 'Space']
]);
for (let i = 1; i <= 12; i++) NAMED_KEYS.set(`F${i}`, `F${i}`);

function keyNameToCode(key) {
  if (typeof key !== 'string') return null;
  if (NAMED_KEYS.has(key)) return NAMED_KEYS.get(key);
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return null;
}

function keyNameToVk(key) {
  return codeToVk(keyNameToCode(key));
}

module.exports = { codeToVk, isExtendedKey, keyNameToCode, keyNameToVk };
