// Кто и когда может читать буфер обмена через главный процесс.
//
// Раньше rd-clipboard-read отдавал текст буфера странице в любой момент — без
// сеанса и без согласия. Скопированный пароль уходил на сервер, стоило
// странице об этом попросить. Теперь чтение возможно только при отметке
// согласия, которую ставит главный процесс после системного окна.
//
// Две роли:
//  - host: сотрудник, к которому подключились. Нужен идущий сеанс с полным
//    доступом, и согласие живёт ровно столько, сколько сеанс;
//  - operator: тот, кто подключился. Согласие привязано к окну и сеансу и
//    снимается, когда окно уходит со страницы или закрывается.

const OPERATOR_GRANT_TTL_MS = 8 * 60 * 60 * 1000;

function validSessionId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}

class ClipboardGrants {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.host = null; // sessionId
    this.operators = new Map(); // webContentsId -> { sessionId, expiresAt }
  }

  // Нужно ли вообще спрашивать сотрудника (или отказать сразу).
  canAskHost(hostSession, sessionId) {
    return Boolean(hostSession?.active && hostSession.allowsInput && validSessionId(sessionId) && hostSession.sessionId === sessionId);
  }

  grantHost(sessionId) {
    this.host = sessionId;
  }

  hostAllowed(hostSession, sessionId) {
    // Сеанс мог смениться или понизиться — согласие на прежний не переносится.
    return Boolean(this.host) && sessionId === this.host && this.canAskHost(hostSession, sessionId);
  }

  revokeHost() {
    this.host = null;
  }

  grantOperator(webContentsId, sessionId) {
    if (!validSessionId(sessionId)) return false;
    this.operators.set(webContentsId, { sessionId, expiresAt: this.now() + OPERATOR_GRANT_TTL_MS });
    return true;
  }

  operatorAllowed(webContentsId, sessionId) {
    const grant = this.operators.get(webContentsId);
    if (!grant) return false;
    if (grant.expiresAt <= this.now()) {
      this.operators.delete(webContentsId);
      return false;
    }
    return validSessionId(sessionId) && grant.sessionId === sessionId;
  }

  revokeOperator(webContentsId, sessionId) {
    const grant = this.operators.get(webContentsId);
    if (!grant) return false;
    if (sessionId != null && grant.sessionId !== sessionId) return false;
    this.operators.delete(webContentsId);
    return true;
  }

  // Окно перезагрузилось, ушло со страницы или закрылось.
  forgetWebContents(webContentsId) {
    this.operators.delete(webContentsId);
  }
}

module.exports = { ClipboardGrants, OPERATOR_GRANT_TTL_MS };
