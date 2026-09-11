const test = require('node:test');
const assert = require('node:assert');
const { codeToVk, isExtendedKey, keyNameToVk } = require('../src/main/key-codes');

// Сочетания клавиш оператора передаются по ФИЗИЧЕСКОЙ клавише
// (KeyboardEvent.code), а не по символу. Раньше уходил символ, и Ctrl+C на
// русской раскладке приходил сотруднику как «Ctrl+с» — ничего не копировалось.

test('буква берётся по физической клавише, а не по символу раскладки', () => {
  assert.strictEqual(codeToVk('KeyC'), 0x43);
  assert.strictEqual(codeToVk('KeyA'), 0x41);
  assert.strictEqual(codeToVk('KeyZ'), 0x5a);
});

test('цифры, функциональные и служебные клавиши', () => {
  assert.strictEqual(codeToVk('Digit0'), 0x30);
  assert.strictEqual(codeToVk('Digit9'), 0x39);
  assert.strictEqual(codeToVk('F1'), 0x70);
  assert.strictEqual(codeToVk('F12'), 0x7b);
  assert.strictEqual(codeToVk('Enter'), 0x0d);
  assert.strictEqual(codeToVk('Escape'), 0x1b);
  assert.strictEqual(codeToVk('Space'), 0x20);
  assert.strictEqual(codeToVk('Backspace'), 0x08);
  assert.strictEqual(codeToVk('ArrowLeft'), 0x25);
  assert.strictEqual(codeToVk('Delete'), 0x2e);
  assert.strictEqual(codeToVk('Semicolon'), 0xba);
  assert.strictEqual(codeToVk('Numpad5'), 0x65);
});

test('модификаторы сами по себе не отправляются — они идут флагами', () => {
  for (const code of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']) {
    assert.strictEqual(codeToVk(code), null, code);
  }
});

test('неизвестное или подставленное значение не даёт кода', () => {
  assert.strictEqual(codeToVk('KeyЖ'), null);
  assert.strictEqual(codeToVk('__proto__'), null);
  assert.strictEqual(codeToVk('constructor'), null);
  assert.strictEqual(codeToVk('toString'), null);
  assert.strictEqual(codeToVk(''), null);
  assert.strictEqual(codeToVk(null), null);
  assert.strictEqual(codeToVk({ toString: () => 'KeyC' }), null);
  assert.strictEqual(codeToVk("KeyC'); Start-Process calc; #"), null);
});

test('стрелки, Home/End, Insert/Delete — расширенные клавиши', () => {
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'NumpadEnter', 'NumpadDivide']) {
    assert.strictEqual(isExtendedKey(code), true, code);
  }
  assert.strictEqual(isExtendedKey('KeyC'), false);
  assert.strictEqual(isExtendedKey('Enter'), false);
  assert.strictEqual(isExtendedKey('__proto__'), false);
});

test('прежний формат события (только key): именованные клавиши и латиница', () => {
  assert.strictEqual(keyNameToVk('Enter'), 0x0d);
  assert.strictEqual(keyNameToVk('Tab'), 0x09);
  assert.strictEqual(keyNameToVk('ArrowUp'), 0x26);
  assert.strictEqual(keyNameToVk('c'), 0x43);
  assert.strictEqual(keyNameToVk('C'), 0x43);
  assert.strictEqual(keyNameToVk('7'), 0x37);
  assert.strictEqual(keyNameToVk('с'), null, 'кириллица по имени клавиши не угадывается');
  assert.strictEqual(keyNameToVk('__proto__'), null);
  assert.strictEqual(keyNameToVk(42), null);
});
