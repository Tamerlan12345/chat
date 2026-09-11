const test = require('node:test');
const assert = require('node:assert');
const { RemoteInput, BOOTSTRAP } = require('../src/main/remote-input');

// Команды не отправляются в PowerShell — перехватываются и проверяются как
// строки. События ввода приходят с чужой машины, поэтому важно, что они не
// могут превратиться в произвольную команду.
//
// Главное правило: в командной строке нет ни одного символа, пришедшего от
// оператора. Текст передаётся номерами символов, клавиши — числовыми кодами.
// Кавычки PowerShell (включая типографские ‘ ’ ‚ ‛, которые он тоже считает
// кавычками) экранировать больше не нужно — им негде появиться.

const RECT = { x: 1920, y: 0, width: 1920, height: 1080 };

function capture(rect = RECT) {
  const ri = new RemoteInput(() => {}, { getTargetRect: () => rect });
  const lines = [];
  ri.send = (line) => lines.push(line);
  ri.enabled = true;
  return { ri, lines };
}

// Только имя метода и числа: ни букв из текста, ни кавычек, ни $.
const SAFE_COMMAND = /^\[RI\]::[A-Za-z]+\((\[int\[\]\]@\()?-?[0-9]+(,-?[0-9]+)*\)?\)$/;

test('пока сеанс не разрешён, ввод игнорируется полностью', () => {
  const ri = new RemoteInput(() => {}, { getTargetRect: () => RECT });
  const lines = [];
  ri.send = (line) => lines.push(line);
  // enable() намеренно не вызывается
  ri.handle({ type: 'move', x: 0.5, y: 0.5 });
  ri.handle({ type: 'down', button: 'left' });
  ri.handle({ type: 'text', text: 'привет' });
  assert.strictEqual(lines.length, 0);
});

test('координаты переводятся в пиксели захваченного монитора', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'move', x: 0.5, y: 0.5 });
  assert.strictEqual(lines[0], '[RI]::Move(2880,540)');
});

test('координаты зажимаются в пределах монитора', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'move', x: 5, y: -3 });
  assert.strictEqual(lines[0], '[RI]::Move(3839,0)');
});

test('нечисловые координаты отбрасываются', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'move', x: '0.5); Start-Process calc; #', y: 0.5 });
  ri.handle({ type: 'move', x: NaN, y: 0.5 });
  ri.handle({ type: 'move', x: Infinity, y: 0.5 });
  assert.strictEqual(lines.length, 0, 'ни одна из них не должна дойти до PowerShell');
});

test('неизвестные границы монитора — курсор не двигается', () => {
  const { ri, lines } = capture(null);
  ri.handle({ type: 'move', x: 0.5, y: 0.5 });
  assert.strictEqual(lines.length, 0);
});

test('кнопка мыши выбирается только из известного списка', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'down', button: 'right', x: 0.1, y: 0.1 });
  assert.deepStrictEqual(lines, ['[RI]::Move(2112,108)', '[RI]::Button(8)']);

  lines.length = 0;
  // Подставленное значение не должно попасть в команду — берётся левая кнопка.
  ri.handle({ type: 'up', button: 'LDOWN,0,0,0,[IntPtr]::Zero); Start-Process calc; #' });
  assert.deepStrictEqual(lines, ['[RI]::Button(4)']);
});

test('прокрутка ограничена по величине и приводится к целому', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'wheel', delta: 999 });
  assert.strictEqual(lines[0], '[RI]::Wheel(1200)');

  lines.length = 0;
  ri.handle({ type: 'wheel', delta: '3; Start-Process calc' });
  assert.strictEqual(lines.length, 0, 'строка вместо числа не проходит');
});

test('текст уходит номерами символов, а не строкой', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: 'Жук' });
  assert.strictEqual(lines[0], '[RI]::Text([int[]]@(1046,1091,1082))');
});

test('кавычки любого вида и спецсимволы не попадают в команду', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: "'; Start-Process calc; '‘’‚‛\"`$(calc){+}%" });
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], SAFE_COMMAND);
  assert.ok(!/calc/i.test(lines[0]));
});

test('символы вне BMP передаются парой суррогатов', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: '😀' });
  assert.strictEqual(lines[0], '[RI]::Text([int[]]@(55357,56832))');
});

test('длина вводимого текста ограничена', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: 'я'.repeat(5000) });
  const count = lines[0].split(',').length;
  assert.ok(count <= 500, `отправлено ${count} символов`);
});

test('сочетание клавиш — по коду физической клавиши, раскладка не важна', () => {
  const { ri, lines } = capture();
  // Ctrl+C на русской раскладке: key = «с», code = KeyC.
  ri.handle({ type: 'key', code: 'KeyC', key: 'с', ctrl: true });
  assert.strictEqual(lines[0], '[RI]::Key(67,1,0,0,0)');
});

test('стрелки отправляются как расширенные клавиши', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'key', code: 'ArrowLeft', key: 'ArrowLeft', shift: true });
  assert.strictEqual(lines[0], '[RI]::Key(37,0,0,1,1)');
});

test('прежний формат без code: именованная клавиша из белого списка', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'key', key: 'Enter' });
  assert.strictEqual(lines[0], '[RI]::Key(13,0,0,0,0)');

  lines.length = 0;
  ri.handle({ type: 'key', key: 'Tab', alt: true });
  assert.strictEqual(lines[0], '[RI]::Key(9,0,1,0,0)');
});

test('прежний формат: одиночный печатный символ без модификаторов печатается текстом', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'key', key: 'ж' });
  assert.strictEqual(lines[0], '[RI]::Text([int[]]@(1078))');
});

test('неизвестная клавиша отбрасывается целиком', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'key', key: "'); Start-Process calc; ('" });
  ri.handle({ type: 'key', code: "KeyC'); Start-Process calc; #", key: 'x', ctrl: true });
  ri.handle({ type: 'key', code: 'ControlLeft', key: 'Control', ctrl: true });
  ri.handle({ type: 'key', key: 'с', ctrl: true });
  assert.strictEqual(lines.length, 0);
});

test('неизвестный тип события ничего не отправляет', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'exec', command: 'Start-Process calc' });
  ri.handle(null);
  ri.handle('строка');
  assert.strictEqual(lines.length, 0);
});

// ── Перевод строки внутри команды ───────────────────────────────────────────
// Команда уходит в PowerShell строкой в stdin, и каждая строка — отдельная
// команда. Управляющие символы из текста вычищаются: для перевода строки есть
// клавиша Enter.

test('перевод строки и управляющие символы не доходят до ввода', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: 'а\nб\u0007в\u001bг\u0000' });
  assert.strictEqual(lines.length, 1, 'должна уйти ровно одна команда');
  assert.strictEqual(lines[0], '[RI]::Text([int[]]@(1072,1073,1074,1075))');
});

test('текст из одних управляющих символов не отправляется вовсе', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'text', text: '\n\r\t\u0000' });
  assert.strictEqual(lines.length, 0);
});

test('перевод строки как одиночная клавиша не проходит', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'key', key: '\n' });
  ri.handle({ type: 'key', key: '\r' });
  assert.strictEqual(lines.length, 0, 'для перевода строки есть Enter из белого списка');
});

test('каждая команда состоит только из имени метода и чисел', () => {
  const { ri, lines } = capture();
  ri.handle({ type: 'move', x: 0.25, y: 0.75 });
  ri.handle({ type: 'down', button: 'middle', x: 0.1, y: 0.2 });
  ri.handle({ type: 'wheel', delta: -2 });
  ri.handle({ type: 'text', text: 'Привет, мир! «ёлка» — 100%' });
  ri.handle({ type: 'key', code: 'F5', key: 'F5' });
  assert.ok(lines.length >= 5);
  for (const line of lines) assert.match(line, SAFE_COMMAND, line);
});

test('начальная загрузка PowerShell — только ASCII', () => {
  // Windows PowerShell 5.1 читает stdin в кодовой странице OEM (CP866):
  // любой не-ASCII символ в исходнике превращается в мусор.
  assert.ok(/^[\x00-\x7f]*$/.test(BOOTSTRAP), 'в BOOTSTRAP есть не-ASCII символы');
});
