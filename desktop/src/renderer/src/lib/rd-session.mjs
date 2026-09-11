// Правила сеанса удалённого рабочего стола, которые можно проверить без
// WebRTC, без второго компьютера и без живого оператора.

export function normalizeAccessLevel(value) {
  // Как и на сервере: всё, что не 'full', — только просмотр.
  return value === 'full' ? 'full' : 'view_only';
}

// Что сотрудник принимает от оператора.
//
// «Только просмотр» раньше ограничивал лишь мышь и клавиатуру: файл оператора
// всё равно сохранялся в «Загрузки», а текст — в буфер обмена. Сервер такие
// сообщения тоже отбрасывает, но машина сотрудника не должна полагаться на то,
// что проверка где-то уже была.
const SIGNALING = new Set(['rd_webrtc_answer', 'rd_ice_candidate', 'rd_end']);
const VIEW = new Set(['rd_select_screen']);
const CONTROL = new Set(['rd_input_event', 'rd_file', 'rd_clipboard_mode']);

export function isHostMessageAllowed(type, { active, accessLevel, clipboardAllowed } = {}) {
  if (!active) return false;
  if (SIGNALING.has(type) || VIEW.has(type)) return true;
  const full = normalizeAccessLevel(accessLevel) === 'full';
  if (CONTROL.has(type)) return full;
  // Текст в буфер — только после явного «Разрешить» самого сотрудника.
  if (type === 'rd_clipboard') return full && Boolean(clipboardAllowed);
  return false;
}

// rd_end ровно один раз на сеанс. Кнопка «Завершить», закрытие окна и
// размонтирование компонента происходят подряд, и каждое пыталось бы
// завершить сеанс заново.
//
// send возвращает false, если отправить не удалось (сокет закрыт), — тогда
// сеанс не помечается, и завершение можно повторить.
export function createEndGuard(send) {
  const ended = new Set();
  return {
    end(sessionId, extra) {
      if (!sessionId || ended.has(sessionId)) return false;
      if (send(sessionId, extra) === false) return false;
      ended.add(sessionId);
      return true;
    },
    // Сеанс завершила другая сторона — отвечать ей тем же незачем.
    mark(sessionId) {
      if (sessionId) ended.add(sessionId);
    },
    isEnded(sessionId) {
      return ended.has(sessionId);
    }
  };
}

// Опрос буфера обмена. Событий об изменении буфера Windows не присылает,
// поэтому он читается по таймеру.
//
// Первое чтение только запоминает содержимое: то, что лежало в буфере до
// согласия (скопированный пароль, номер договора), не должно уйти на другую
// машину. Отправляется лишь скопированное после.
export class ClipboardWatcher {
  constructor({ read, send }) {
    this.read = read;
    this.send = send;
    this.last = null;
  }

  async prime() {
    this.last = await this.safeRead() ?? '';
  }

  async tick() {
    const text = await this.safeRead();
    if (text === null) return;
    if (this.last === null) {
      this.last = text;
      return;
    }
    if (!text || text === this.last) return;
    this.last = text;
    this.send(text);
  }

  // Текст, записанный в буфер по просьбе другой стороны, обратно не уходит.
  remember(text) {
    this.last = String(text ?? '');
  }

  reset() {
    this.last = null;
  }

  async safeRead() {
    try {
      const text = await this.read();
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  }
}
