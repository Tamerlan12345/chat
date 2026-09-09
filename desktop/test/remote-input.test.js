const test = require('node:test');
const assert = require('node:assert');
const { RemoteInput } = require('../src/main/remote-input');

// Команды не отправляются в PowerShell — перехватываются и проверяются как
// строки. События ввода приходят с чужой машины, поэтому важно, что они не
// могут превратиться в произвольную команду.
function capture() {
  const ri = new RemoteInput(() => {});
  const lines = [];
  ri.send = (line) => lines.push(line);
  ri.enabled = true;
  return { ri, lines };
}

test('пока сеанс не разрешён, ввод игнорируется полностью', () => {
  const ri = new RemoteInput(() => {});
  const lines = [];
  ri.send = (line) => lines.push(line);
  // enable() намеренно не вызывается
  ri.handle({ type: 'move', x: 0.5, y: 0.5 });
  ri.handle({ type: 'down', button: 'left' });
  ri.handle({ type: 'text', text: 'привет' });
  assert.strictEqual(lines.length, 0);
});

test('координаты зажимаются в диапазон 0..1', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'move', x: 5, y: -3 });
  assert.strictEqual(lines[0], 'RIMove 1 0');
});

test('нечисловые координаты отбрасываются', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'move', x: '0.5); Start-Process calc; #', y: 0.5 });
  ri.handle({ type: 'move', x: NaN, y: 0.5 });
  ri.handle({ type: 'move', x: Infinity, y: 0.5 });
  assert.strictEqual(lines.length, 0, 'ни одна из них не должна дойти до PowerShell');
});

test('кнопка мыши выбирается только из известного списка', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'down', button: 'right', x: 0.1, y: 0.1 });
  assert.ok(lines.some((l) => l.includes('[RI]::RDOWN')));

  lines.length = 0;
  // Подставленное значение не должно попасть в команду — берётся левая кнопка.
  ri.handle({ type: 'down', button: 'LDOWN,0,0,0,[IntPtr]::Zero); Start-Process calc; #' });
  assert.ok(lines.every((l) => !l.includes('Start-Process')));
  assert.ok(lines.some((l) => l.includes('[RI]::LDOWN')));
});

test('прокрутка ограничена по величине и приводится к целому', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'wheel', delta: 999 });
  assert.strictEqual(lines[0], '[RI]::mouse_event([RI]::WHEEL,0,0,1200,[IntPtr]::Zero)');

  lines.length = 0;
  ri.handle({ type: 'wheel', delta: '3; Start-Process calc' });
  assert.strictEqual(lines.length, 0, 'строка вместо числа не проходит');
});

test('одинарные кавычки в тексте экранируются', () => {
  // Незакрытая кавычка оборвала бы строку PowerShell и позволила дописать
  // свою команду следом.
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: "'; Start-Process calc; '" });
  assert.ok(lines[0].includes("''"), 'кавычка должна быть удвоена');
  const body = lines[0].slice(lines[0].indexOf("('") + 2, lines[0].lastIndexOf("')"));
  assert.ok(!/[^']'[^']/.test(body), 'одиночных кавычек внутри строки остаться не должно');
});

test('служебные символы SendKeys экранируются', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: '100% + (2)' });
  assert.ok(lines[0].includes('{%}'));
  assert.ok(lines[0].includes('{+}'));
  assert.ok(lines[0].includes('{(}') && lines[0].includes('{)}'));
});

test('длина вводимого текста ограничена', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: 'я'.repeat(5000) });
  assert.ok(lines[0].length < 1200, 'длинный текст должен обрезаться');
});

test('именованные клавиши берутся из белого списка', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'key', key: 'Enter' });
  assert.strictEqual(lines[0], "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')");

  lines.length = 0;
  // Неизвестное многосимвольное имя отбрасывается целиком.
  ri.handle({ type: 'key', key: "'); Start-Process calc; ('" });
  assert.strictEqual(lines.length, 0);
});

test('сочетания с модификаторами собираются корректно', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'key', key: 'c', ctrl: true });
  assert.strictEqual(lines[0], "[System.Windows.Forms.SendKeys]::SendWait('^c')");

  lines.length = 0;
  ri.handle({ type: 'key', key: 'Tab', alt: true });
  assert.strictEqual(lines[0], "[System.Windows.Forms.SendKeys]::SendWait('%{TAB}')");
});

test('неизвестный тип события ничего не отправляет', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'exec', command: 'Start-Process calc' });
  ri.handle(null);
  ri.handle('строка');
  assert.strictEqual(lines.length, 0);
});
