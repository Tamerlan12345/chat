// Сеанс удалённого доступа к ЭТОЙ машине глазами главного процесса.
//
// Главный процесс сам не видит, что сотрудник нажал «Разрешить доступ», —
// об этом сообщает страница. Пока сообщения не было, экран не отдаётся
// (getDisplayMedia отклоняется) и ввод не включается, даже если страница
// попросит. Раньше экран отдавался молча любому запросу из окна.

const NAME_LIMIT = 80;

function cleanName(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0);
    // Управляющие символы в заголовке окна-индикатора ни к чему.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) continue;
    out += ch;
  }
  out = out.trim().slice(0, NAME_LIMIT).trim();
  return out || 'оператор техподдержки';
}

class HostSession {
  constructor() {
    this.current = null;
  }

  start({ sessionId, operatorName, accessLevel } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) return false;
    this.current = {
      sessionId,
      operatorName: cleanName(operatorName),
      // Как и на сервере: всё, что не 'full', — только просмотр.
      accessLevel: accessLevel === 'full' ? 'full' : 'view_only'
    };
    return true;
  }

  // Без идентификатора завершается любой текущий сеанс: так поступают
  // аварийные пути (перезагрузка окна, падение страницы), которым сверять
  // уже не с чем.
  end(sessionId) {
    if (!this.current) return false;
    if (sessionId !== undefined && sessionId !== null && sessionId !== this.current.sessionId) return false;
    this.current = null;
    return true;
  }

  get active() { return Boolean(this.current); }
  get sessionId() { return this.current?.sessionId ?? null; }
  get operatorName() { return this.current?.operatorName ?? ''; }
  get accessLevel() { return this.current?.accessLevel ?? null; }
  get allowsCapture() { return this.active; }
  get allowsInput() { return this.current?.accessLevel === 'full'; }

  indicatorText() {
    return this.current ? `Ваш рабочий стол просматривает ${this.current.operatorName}` : '';
  }
}

module.exports = { HostSession };
