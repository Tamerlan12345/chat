// Исполнитель команд внутри окна приложения: нажимает, печатает, прикрепляет
// файлы — как это делал бы человек. Сценарии лежат в деке, сюда приходят
// простые команды.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function pick(sel, { text = null, index = 0, last = false } = {}) {
  let list = [...document.querySelectorAll(sel)].filter(visible);
  if (text) {
    const needle = text.toLowerCase();
    list = list.filter((el) => (el.textContent || '').toLowerCase().includes(needle));
  }
  return (last ? list[list.length - 1] : list[index]) || null;
}

async function waitFor(sel, opts = {}, timeout = 6000) {
  const started = Date.now();
  for (;;) {
    const el = pick(sel, opts);
    if (el) return el;
    if (Date.now() - started > timeout) throw new Error('не найдено: ' + sel + (opts.text ? ' «' + opts.text + '»' : ''));
    await wait(80);
  }
}

function fire(el, type, init = {}) {
  el.dispatchEvent(new (type.startsWith('key') ? KeyboardEvent : type.startsWith('mouse') || type === 'click' ? MouseEvent : Event)(type, { bubbles: true, cancelable: true, ...init }));
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  fire(el, 'input');
}

async function typeInto(el, text, speed = 45) {
  el.focus();
  let acc = el.value || '';
  for (const ch of text) {
    acc += ch;
    setNativeValue(el, acc);
    await wait(speed + Math.random() * 25);
  }
}

function fakeFile(kind) {
  if (kind === 'big') {
    const f = new File([new Uint8Array(1024)], 'Запись_вебинара.mp4', { type: 'video/mp4' });
    Object.defineProperty(f, 'size', { value: 340 * 1024 * 1024 });
    return f;
  }
  if (kind === 'doc') {
    return new File([new Uint8Array(180 * 1024)], 'Полис_КАСКО_2026-0918.pdf', { type: 'application/pdf' });
  }
  // Небольшое изображение: рисуем прямо здесь, чтобы файл был настоящим.
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 800;
  const g = canvas.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 520);
  sky.addColorStop(0, '#8fb3d9'); sky.addColorStop(1, '#dbe6f1');
  g.fillStyle = sky; g.fillRect(0, 0, 1200, 520);
  g.fillStyle = '#5d6873'; g.fillRect(0, 470, 1200, 330);
  g.fillStyle = '#e8ecf1';
  g.beginPath(); g.moveTo(180, 620); g.quadraticCurveTo(220, 470, 470, 450); g.lineTo(760, 450);
  g.quadraticCurveTo(900, 470, 980, 620); g.closePath(); g.fill();
  g.fillStyle = '#27323d';
  g.beginPath(); g.moveTo(430, 455); g.quadraticCurveTo(500, 370, 640, 368); g.lineTo(720, 368);
  g.quadraticCurveTo(800, 380, 840, 455); g.closePath(); g.fill();
  for (const x of [330, 830]) {
    g.fillStyle = '#1b2026'; g.beginPath(); g.arc(x, 620, 66, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#a3adb7'; g.beginPath(); g.arc(x, 620, 28, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = '#f2c230'; g.lineWidth = 6; g.setLineDash([16, 12]);
  g.beginPath(); g.arc(905, 545, 64, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]); g.strokeStyle = '#7b2a22'; g.lineWidth = 8;
  g.beginPath(); g.moveTo(880, 520); g.lineTo(915, 535); g.lineTo(885, 560); g.lineTo(925, 575); g.stroke();
  g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(28, 28, 300, 52);
  g.fillStyle = '#fff'; g.font = '26px Consolas, monospace';
  g.fillText(new Date().toLocaleString('ru-RU').slice(0, 16), 44, 62);
  const data = canvas.toDataURL('image/jpeg', 0.85);
  const bin = atob(data.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], 'Фото_осмотра_Сейфуллина.jpg', { type: 'image/jpeg' });
}

export async function runCommand(cmd) {
  switch (cmd.do) {
    case 'wait':
      await wait(cmd.ms || 500);
      return;

    case 'click': {
      const el = await waitFor(cmd.sel, { text: cmd.text, index: cmd.index, last: cmd.last });
      el.scrollIntoView?.({ block: 'nearest' });
      el.click();
      return;
    }

    case 'type': {
      const el = await waitFor(cmd.sel, { index: cmd.index });
      if (!cmd.append) setNativeValue(el, '');
      await typeInto(el, cmd.text, cmd.speed);
      if (cmd.enter) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }
      return;
    }

    case 'set': {
      const el = await waitFor(cmd.sel, { index: cmd.index });
      setNativeValue(el, cmd.text);
      return;
    }

    case 'key': {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: cmd.key, bubbles: true, cancelable: true,
        ctrlKey: Boolean(cmd.ctrl), metaKey: Boolean(cmd.meta), shiftKey: Boolean(cmd.shift)
      }));
      return;
    }

    case 'rail': {
      const el = await waitFor('.rail-tab-btn', { text: cmd.tab });
      el.click();
      return;
    }

    case 'openContact': {
      const tab = await waitFor('.rail-tab-btn', { text: 'Контакты' });
      tab.click();
      const search = await waitFor('input[placeholder^="Поиск по ФИО"]');
      setNativeValue(search, cmd.name);
      const node = await waitFor('.tree-employee-node', { text: cmd.name });
      await wait(250);
      node.click();
      setNativeValue(search, '');
      return;
    }

    case 'openDialog': {
      const tab = await waitFor('.rail-tab-btn', { text: 'Чаты' });
      tab.click();
      const row = await waitFor('.dialog-item, .classic-dialog-item, [class*="dialog"]', { text: cmd.name });
      row.click();
      return;
    }

    case 'openChannel': {
      const tab = await waitFor('.rail-tab-btn', { text: 'Каналы' });
      tab.click();
      await wait(200);
      const row = await waitFor('[class*="channel"]', { text: cmd.name });
      row.click();
      return;
    }

    case 'attach': {
      const input = document.querySelector('input[type=file]');
      if (!input) throw new Error('нет поля выбора файла');
      const file = fakeFile(cmd.kind);
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      fire(input, 'change');
      return;
    }

    case 'cancelUpload': {
      const btn = await waitFor('[aria-label^="Отменить отправку"]');
      btn.click();
      return;
    }

    case 'wake': {
      const btn = await waitFor('.wake-control button');
      btn.click();
      return;
    }

    case 'call': {
      const btn = await waitFor('[aria-label="Голосовой звонок"]');
      btn.click();
      return;
    }

    case 'menu': {
      const top = await waitFor('.menu-top-btn', { text: cmd.top });
      top.click();
      await wait(180);
      const item = await waitFor('.menu-drop-item', { text: cmd.item });
      item.click();
      return;
    }

    case 'theme': {
      document.documentElement.dataset.theme = cmd.theme;
      return;
    }

    case 'scroll': {
      const el = document.querySelector(cmd.sel || '.chat-messages, [class*="messages"]');
      if (el) el.scrollTop = cmd.top === 'top' ? 0 : el.scrollHeight;
      return;
    }

    case 'scrollTo': {
      const el = await waitFor(cmd.sel, { text: cmd.text });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Прокручивается внутренняя панель, а не все окно приложения.
      await wait(400);
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      return;
    }

    case 'blur': {
      document.activeElement?.blur?.();
      return;
    }

    default:
      throw new Error('неизвестная команда: ' + cmd.do);
  }
}

export { wait };
