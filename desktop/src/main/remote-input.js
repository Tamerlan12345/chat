// Ввод (мышь и клавиатура) для сеанса удалённого управления.
//
// Почему PowerShell, а не нативный модуль:
//   nut.js и robotjs требуют компиляции под конкретную версию Electron —
//   это утяжеляет установщик, тянет зависимость от Visual C++ Redistributable
//   и добавляет в приложение ещё один НЕПОДПИСАННЫЙ бинарный файл. Последнее
//   принципиально: Windows Smart App Control блокирует именно неподписанный
//   код, и на этом уже спотыкалась установка (см. историю с UAC.dll).
//   powershell.exe подписан Microsoft и есть на каждой машине, а SendInput
//   вызывается через штатный P/Invoke к user32.dll. Ноль новых файлов.
//
// Один долгоживущий процесс на весь сеанс: запускать PowerShell на каждое
// движение мыши немыслимо (сотни миллисекунд), а в уже поднятый процесс
// команда уходит строкой в stdin и выполняется за единицы миллисекунд.
//
// В командах нет ни одного символа, пришедшего от оператора. Раньше текст
// подставлялся в строку PowerShell, и это ломалось дважды:
//   • Windows PowerShell 5.1 читает stdin в кодовой странице OEM (CP866), а
//     не в UTF-8 — кириллица оператора печаталась у сотрудника мусором;
//   • экранировалась только ASCII-кавычка ', хотя PowerShell считает кавычками
//     и типографские ‘ ’ ‚ ‛ — через них можно было закрыть строку и дописать
//     свою команду.
// Теперь текст уходит номерами символов UTF-16 и печатается через SendInput
// с KEYEVENTF_UNICODE, клавиши — числовыми кодами. Команда состоит из имени
// метода и чисел, и кодировка stdin перестаёт иметь значение.
//
// Ограничение Windows (UIPI): процесс без прав администратора не может
// управлять окнами, запущенными от администратора. Если у сотрудника открыто
// окно с повышенными правами, курсор до него не дойдёт — это защита самой
// системы, обойти её из приложения нельзя.

const { spawn } = require('node:child_process');
const { mapToRect } = require('./display-map');
const { codeToVk, isExtendedKey, keyNameToCode, keyNameToVk } = require('./key-codes');

const TEXT_LIMIT = 500;

// Управляющие символы (C0, DEL, C1) и разделители строк Unicode. Печатать их
// текстом незачем: для перевода строки и табуляции есть клавиши Enter и Tab.
function isControlChar(code) {
  return (
    code < 0x20 ||                    // C0: перевод строки, табуляция, возврат каретки
    (code >= 0x7f && code <= 0x9f) || // DEL и C1
    code === 0x2028 ||                // разделитель строк Unicode
    code === 0x2029                   // разделитель абзацев Unicode
  );
}

// Текст → номера символов UTF-16. Символ вне BMP (эмодзи) — пара суррогатов:
// так его принимает SendInput. Пара не разрывается на границе лимита.
function textToUnits(value) {
  const units = [];
  for (const ch of String(value ?? '')) {
    if (isControlChar(ch.codePointAt(0))) continue;
    if (units.length + ch.length > TEXT_LIMIT) break;
    for (let i = 0; i < ch.length; i++) units.push(ch.charCodeAt(i));
  }
  return units;
}

function buildTextCommand(value) {
  const units = textToUnits(value);
  return units.length ? `[RI]::Text([int[]]@(${units.join(',')}))` : null;
}

const BUTTON_FLAGS = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 }
};

// Определения P/Invoke загружаются один раз при старте процесса. Только
// ASCII: см. про кодовую страницу выше.
//
// Осведомлённость о DPI выставляется для потока перед каждым движением.
// Без неё Windows «виртуализирует» координаты под масштаб основного монитора,
// и на мониторе со 125–150 % курсор промахивается. Координаты при этом —
// физические пиксели (их считает главный процесс, см. display-map.js).
const BOOTSTRAP = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RI {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const int VK_SHIFT = 0x10;
  const int VK_CONTROL = 0x11;
  const int VK_MENU = 0x12;

  static void Dpi() {
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return; } catch (EntryPointNotFoundException) { }
    try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
  }

  static void Send(INPUT[] inputs) {
    if (inputs.Length > 0) SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  static INPUT Mouse(uint flags, int data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dwFlags = flags;
    i.u.mi.mouseData = unchecked((uint)data);
    return i;
  }

  static INPUT Keyboard(int vk, int scan, uint flags) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = (ushort)vk;
    i.u.ki.wScan = (ushort)scan;
    i.u.ki.dwFlags = flags;
    return i;
  }

  static INPUT VirtualKey(int vk, uint flags) {
    return Keyboard(vk, (int)MapVirtualKey((uint)vk, 0), flags);
  }

  public static void Move(int x, int y) { Dpi(); SetCursorPos(x, y); }

  public static void Button(int flags) { Send(new INPUT[] { Mouse((uint)flags, 0) }); }

  public static void Wheel(int delta) { Send(new INPUT[] { Mouse(MOUSEEVENTF_WHEEL, delta) }); }

  public static void Text(int[] units) {
    List<INPUT> list = new List<INPUT>();
    foreach (int unit in units) {
      if (unit < 0 || unit > 0xFFFF) continue;
      list.Add(Keyboard(0, unit, KEYEVENTF_UNICODE));
      list.Add(Keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    Send(list.ToArray());
  }

  public static void Key(int vk, int ctrl, int alt, int shift, int extended) {
    if (vk <= 0 || vk > 0xFE) return;
    uint flags = extended != 0 ? KEYEVENTF_EXTENDEDKEY : 0;
    List<INPUT> list = new List<INPUT>();
    if (ctrl != 0) list.Add(VirtualKey(VK_CONTROL, 0));
    if (alt != 0) list.Add(VirtualKey(VK_MENU, 0));
    if (shift != 0) list.Add(VirtualKey(VK_SHIFT, 0));
    list.Add(VirtualKey(vk, flags));
    list.Add(VirtualKey(vk, flags | KEYEVENTF_KEYUP));
    if (shift != 0) list.Add(VirtualKey(VK_SHIFT, KEYEVENTF_KEYUP));
    if (alt != 0) list.Add(VirtualKey(VK_MENU, KEYEVENTF_KEYUP));
    if (ctrl != 0) list.Add(VirtualKey(VK_CONTROL, KEYEVENTF_KEYUP));
    Send(list.ToArray());
  }
}
"@

`;

class RemoteInput {
  // getTargetRect() — физические пиксели монитора, который сейчас видит
  // оператор. Считает главный процесс: только он знает, какой экран захвачен.
  constructor(log, { getTargetRect } = {}) {
    this.log = log || (() => {});
    this.getTargetRect = typeof getTargetRect === 'function' ? getTargetRect : () => null;
    this.child = null;
    this.enabled = false;
  }

  // Управление включается только на время подтверждённого сеанса. Пока
  // enabled = false, любое событие отбрасывается, даже если дойдёт по IPC.
  enable() {
    this.enabled = true;
    this.ensureProcess();
  }

  disable() {
    this.enabled = false;
    this.stop();
  }

  ensureProcess() {
    if (this.child && !this.child.killed) return this.child;

    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
    );

    const child = this.child;
    child.on('error', (err) => {
      this.log(`remote-input: не удалось запустить PowerShell: ${err.message}`);
      if (this.child === child) this.child = null;
    });
    child.stderr?.on('data', (chunk) => {
      this.log(`remote-input stderr: ${String(chunk).trim().slice(0, 300)}`);
    });
    // Запись в уже завершившийся процесс даёт EPIPE — без обработчика это
    // необработанное исключение в главном процессе.
    child.stdin?.on('error', (err) => {
      this.log(`remote-input: stdin: ${err.message}`);
    });
    child.on('exit', () => { if (this.child === child) this.child = null; });

    child.stdin.write(BOOTSTRAP + '\n');
    return child;
  }

  stop() {
    if (this.child && !this.child.killed) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill(); } catch {}
    }
    this.child = null;
  }

  send(line) {
    const proc = this.ensureProcess();
    if (!proc) return;
    try { proc.stdin.write(line + '\n'); } catch (err) {
      this.log(`remote-input: запись прервана: ${err.message}`);
    }
  }

  point(event) {
    let rect = null;
    try { rect = this.getTargetRect(); } catch { rect = null; }
    return mapToRect(event.x, event.y, rect);
  }

  // Всё, что приходит с той стороны, — недоверенный ввод. Числа зажимаются в
  // допустимый диапазон, кнопки и клавиши берутся из белых списков, текст
  // превращается в числа.
  handle(event) {
    if (!this.enabled || !event || typeof event !== 'object') return;

    switch (event.type) {
      case 'move': {
        const p = this.point(event);
        if (p) this.send(`[RI]::Move(${p.x},${p.y})`);
        return;
      }

      case 'down':
      case 'up': {
        const p = this.point(event);
        if (p) this.send(`[RI]::Move(${p.x},${p.y})`);
        const button = typeof event.button === 'string' && Object.hasOwn(BUTTON_FLAGS, event.button) ? event.button : 'left';
        this.send(`[RI]::Button(${BUTTON_FLAGS[button][event.type]})`);
        return;
      }

      case 'wheel': {
        if (typeof event.delta !== 'number' || !Number.isFinite(event.delta)) return;
        const delta = Math.max(-10, Math.min(10, Math.trunc(event.delta))) * 120;
        if (!delta) return;
        this.send(`[RI]::Wheel(${delta})`);
        return;
      }

      case 'text': {
        const command = buildTextCommand(event.text);
        if (command) this.send(command);
        return;
      }

      case 'key': {
        const ctrl = event.ctrl ? 1 : 0;
        const alt = event.alt ? 1 : 0;
        const shift = event.shift ? 1 : 0;

        let vk;
        let extended;
        if (typeof event.code === 'string' && event.code) {
          // Физическая клавиша: сочетания работают при любой раскладке.
          vk = codeToVk(event.code);
          extended = isExtendedKey(event.code) ? 1 : 0;
        } else {
          // Прежний формат — только имя клавиши. Одиночный печатный символ
          // без Ctrl/Alt печатается как текст: так он не зависит от раскладки.
          if (!ctrl && !alt && typeof event.key === 'string' && [...event.key].length === 1) {
            const command = buildTextCommand(event.key);
            if (command) this.send(command);
            return;
          }
          vk = keyNameToVk(event.key);
          extended = isExtendedKey(keyNameToCode(event.key)) ? 1 : 0;
        }
        if (vk === null) return;
        this.send(`[RI]::Key(${vk},${ctrl},${alt},${shift},${extended})`);
        return;
      }

      default:
        return;
    }
  }
}

module.exports = { RemoteInput, BOOTSTRAP, buildTextCommand, textToUnits };
