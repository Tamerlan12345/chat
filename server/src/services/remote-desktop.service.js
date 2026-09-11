const crypto = require('node:crypto');

class RemoteDesktopService {
  constructor() {
    // Active sessions: sessionId -> { sessionId, operatorId, targetUserId, status, createdAt }
    this.sessions = new Map();
  }

  createSession(operatorId, targetUserId) {
    const sessionId = `rd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const session = {
      sessionId,
      operatorId: Number(operatorId),
      targetUserId: Number(targetUserId),
      status: 'REQUESTED',
      createdAt: new Date().toISOString()
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  updateStatus(sessionId, status) {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.status = status;
      if (status === 'CLOSED' || status === 'REJECTED') {
        setTimeout(() => this.sessions.delete(sessionId), 10000);
      }
      return s;
    }
    return null;
  }

  findActiveSessionForUser(userId) {
    const num = Number(userId);
    for (const s of this.sessions.values()) {
      if ((s.operatorId === num || s.targetUserId === num) && s.status === 'ACTIVE') {
        return s;
      }
    }
    return null;
  }

  // Запросы, ждущие ответа, и идущие сеансы, где пользователь — одна из сторон.
  findOpenSessionsForUser(userId) {
    const num = Number(userId);
    return [...this.sessions.values()].filter(
      (s) => (s.operatorId === num || s.targetUserId === num) && (s.status === 'REQUESTED' || s.status === 'ACCEPTED')
    );
  }

  endSession(sessionId) {
    return this.updateStatus(sessionId, 'CLOSED');
  }
}

module.exports = new RemoteDesktopService();
