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
// Ограничение Windows (UIPI): процесс без прав администратора не может
// управлять окнами, запущенными от администратора. Если у сотрудника открыто
// окно с повышенными правами, курсор до него не дойдёт — это защита самой
// системы, обойти её из приложения нельзя.

const { spawn } = require('node:child_process');

// Определения P/Invoke загружаются один раз при старте процесса.
const BOOTSTRAP = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RI {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern short VkKeyScanW(char ch);
  public const uint MOVE=0x0001, LDOWN=0x0002, LUP=0x0004, RDOWN=0x0008, RUP=0x0010;
  public const uint MDOWN=0x0020, MUP=0x0040, WHEEL=0x0800;
  public const uint KEYUP=0x0002;
}
"@
Add-Type -AssemblyName System.Windows.Forms

function VW { [System.Windows.Forms.SystemInformation]::VirtualScreen.Width }
function VH { [System.Windows.Forms.SystemInformation]::VirtualScreen.Height }
function VX { [System.Windows.Forms.SystemInformation]::VirtualScreen.X }
function VY { [System.Windows.Forms.SystemInformation]::VirtualScreen.Y }

# Координаты приходят долями (0..1), поэтому не зависят от разрешения экрана
# оператора и корректно работают при разных мониторах у сторон.
function RIMove($nx, $ny) {
  [RI]::SetCursorPos([int]((VX) + $nx * (VW)), [int]((VY) + $ny * (VH))) | Out-Null
}
`;

class RemoteInput {
  constructor(log) {
    this.log = log || (() => {});
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

    this.child.on('error', (err) => {
      this.log(`remote-input: не удалось запустить PowerShell: ${err.message}`);
      this.child = null;
    });
    this.child.stderr?.on('data', (chunk) => {
      this.log(`remote-input stderr: ${String(chunk).trim().slice(0, 300)}`);
    });
    this.child.on('exit', () => { this.child = null; });

    this.child.stdin.write(BOOTSTRAP + '\n');
    return this.child;
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

  // Всё, что приходит с той стороны, — недоверенный ввод. Числа зажимаются в
  // допустимый диапазон, а текст и клавиши пропускаются через белые списки,
  // чтобы в командную строку PowerShell нельзя было подставить своё.
  handle(event) {
    if (!this.enabled || !event || typeof event !== 'object') return;

    const clamp01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

    switch (event.type) {
      case 'move': {
        const x = clamp01(event.x);
        const y = clamp01(event.y);
        if (x === null || y === null) return;
        this.send(`RIMove ${x} ${y}`);
        return;
      }

      case 'down':
      case 'up': {
        const x = clamp01(event.x);
        const y = clamp01(event.y);
        if (x !== null && y !== null) this.send(`RIMove ${x} ${y}`);
        const flags = {
          left: event.type === 'down' ? 'LDOWN' : 'LUP',
          right: event.type === 'down' ? 'RDOWN' : 'RUP',
          middle: event.type === 'down' ? 'MDOWN' : 'MUP'
        };
        const flag = flags[event.button] || flags.left;
        this.send(`[RI]::mouse_event([RI]::${flag},0,0,0,[IntPtr]::Zero)`);
        return;
      }

      case 'wheel': {
        const delta = Math.max(-10, Math.min(10, Math.trunc(event.delta || 0))) * 120;
        if (!delta) return;
        this.send(`[RI]::mouse_event([RI]::WHEEL,0,0,${delta},[IntPtr]::Zero)`);
        return;
      }

      case 'text': {
        // SendKeys понимает служебные символы, поэтому они экранируются.
        const text = String(event.text || '').slice(0, 500);
        if (!text) return;
        const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}').replace(/'/g, "''");
        this.send(`[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
        return;
      }

      case 'key': {
        const KEYS = {
          Enter: '{ENTER}', Tab: '{TAB}', Backspace: '{BACKSPACE}', Delete: '{DELETE}',
          Escape: '{ESC}', ArrowUp: '{UP}', ArrowDown: '{DOWN}', ArrowLeft: '{LEFT}',
          ArrowRight: '{RIGHT}', Home: '{HOME}', End: '{END}', PageUp: '{PGUP}',
          PageDown: '{PGDN}', Insert: '{INSERT}',
          F1: '{F1}', F2: '{F2}', F3: '{F3}', F4: '{F4}', F5: '{F5}', F6: '{F6}',
          F7: '{F7}', F8: '{F8}', F9: '{F9}', F10: '{F10}', F11: '{F11}', F12: '{F12}'
        };
        let token = KEYS[event.key];
        if (!token) {
          // Обычный символ — только если это ровно один печатный знак.
          if (typeof event.key !== 'string' || event.key.length !== 1) return;
          token = event.key.replace(/[+^%~(){}[\]]/g, '{$&}').replace(/'/g, "''");
        }
        let prefix = '';
        if (event.ctrl) prefix += '^';
        if (event.alt) prefix += '%';
        if (event.shift) prefix += '+';
        this.send(`[System.Windows.Forms.SendKeys]::SendWait('${prefix}${token}')`);
        return;
      }

      default:
        return;
    }
  }
}

module.exports = { RemoteInput };
