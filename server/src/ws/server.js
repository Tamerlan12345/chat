const { WebSocketServer, WebSocket } = require('ws');
const AuthService = require('../services/auth.service');
const UserService = require('../services/user.service');
const MessageService = require('../services/message.service');
const RemoteDesktopService = require('../services/remote-desktop.service');
const AuditService = require('../services/audit.service');
const { checkRateLimit } = require('../services/rate-limiter');
const { getClientIp, isIpAllowed } = require('../services/ip-access.service');
const { getDatabase } = require('../db');

class WsServer {
  constructor() {
    this.wss = null;
    this.userSockets = new Map(); // userId -> Set of WebSockets
    this.socketUser = new Map();  // WebSocket -> user object
  }

  init(httpServer) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      // Mirrors the Express-level gate in index.js: the WS upgrade never
      // passes through Express middleware, so it needs its own check.
      // verifyClient rejects at the handshake itself — the connection never
      // opens for a disallowed IP, rather than opening and immediately
      // being closed.
      verifyClient: (info, callback) => {
        const ip = getClientIp(info.req) || '127.0.0.1';
        if (!isIpAllowed(ip)) return callback(false, 403, 'IP not allowed');
        callback(true);
      }
    });

    this.wss.on('connection', (ws, req) => {
      ws.remoteIp = getClientIp(req) || '127.0.0.1';
      ws.isAlive = true;
      ws.connectedAt = new Date().toISOString();

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString('utf8'));
          this.handleMessage(ws, data);
        } catch (err) {
          console.error('[WS Error] Bad JSON:', err.message);
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (err) => {
        console.error('[WS Client Error]:', err.message);
      });
    });

    // Heartbeat to detect dead connections
    setInterval(() => {
      if (!this.wss) return;
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    console.log('[WS Server] Realtime WebSocket gateway ready at /ws');
  }

  handleMessage(ws, msg) {
    const { type } = msg;

    // 1. Authentication
    if (type === 'auth') {
      if (!checkRateLimit(`ws_auth:${ws.remoteIp || '127.0.0.1'}`, { maxAttempts: 10, windowMs: 60000 })) {
        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Слишком много попыток. Повторите через минуту.' }));
      }
      const payload = AuthService.verifyToken(msg.token);
      if (!payload) {
        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Недействительный токен авторизации' }));
      }

      const user = UserService.getUserById(payload.userId);
      if (!user || !user.is_active) {
        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Пользователь не найден или заблокирован' }));
      }
      if (user.must_change_password) {
        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Требуется смена пароля перед продолжением работы', code: 'MUST_CHANGE_PASSWORD' }));
      }

      // Bind user
      this.socketUser.set(ws, user);
      if (!this.userSockets.has(user.id)) {
        this.userSockets.set(user.id, new Set());
      }
      this.userSockets.get(user.id).add(ws);

      // Update status to online
      UserService.updateStatus(user.id, 'online');

      ws.send(JSON.stringify({ type: 'auth_success', user }));

      // Broadcast online status to all connected clients
      this.broadcast({
        type: 'user_status_changed',
        userId: user.id,
        user_id: user.id,
        status: 'online',
        customStatus: user.custom_status
      });

      console.log(`[WS] User connected: ${user.full_name} (#${user.id})`);
      return;
    }

    const currentUser = this.socketUser.get(ws);
    if (!currentUser) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Необходима авторизация' }));
    }

    // 2. Chat messaging
    if (type === 'send_message' || type === 'direct_message' || type === 'channel_message') {
      let { conversationType, targetId, text, msgType, replyToId, metadata, recipient_id, channel_id } = msg;

      if (!conversationType) {
        if (type === 'channel_message' || channel_id) conversationType = 'channel';
        else conversationType = 'direct';
      }
      if (!targetId) {
        targetId = recipient_id || channel_id;
      }

      let savedMsg;
      try {
        savedMsg = MessageService.sendMessage({
          conversationType,
          targetId: Number(targetId),
          senderId: currentUser.id,
          text,
          type: msgType || 'text',
          replyToId: replyToId ? Number(replyToId) : null,
          metadata
        });
      } catch (err) {
        const message = err.message === 'NOT_CHANNEL_MEMBER' ? 'Вы не участник этого канала' : err.message;
        return ws.send(JSON.stringify({ type: 'error', message }));
      }

      if (conversationType === 'channel') {
        // Broadcast to all channel members
        const db = getDatabase();
        const members = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(targetId);
        for (const m of members) {
          this.sendToUser(m.user_id, {
            type: 'channel_message',
            message: savedMsg
          });
          this.sendToUser(m.user_id, {
            type: 'new_message',
            message: savedMsg
          });
        }
      } else {
        // Direct message
        // Send to recipient
        this.sendToUser(targetId, {
          type: 'direct_message',
          message: savedMsg
        });
        this.sendToUser(targetId, {
          type: 'new_message',
          message: savedMsg
        });

        // Send confirmation back to sender's all devices
        this.sendToUser(currentUser.id, {
          type: 'direct_message',
          message: savedMsg
        });
        this.sendToUser(currentUser.id, {
          type: 'new_message',
          message: savedMsg
        });

        // If recipient is online, immediately emit delivered status
        if (this.isUserOnline(targetId)) {
          const now = new Date().toISOString();
          const db = getDatabase();
          db.prepare("INSERT OR REPLACE INTO message_statuses (message_id, user_id, status, timestamp) VALUES (?, ?, 'delivered', ?)")
            .run(savedMsg.id, targetId, now);

          this.sendToUser(currentUser.id, {
            type: 'message_status_updated',
            messageId: savedMsg.id,
            status: 'delivered',
            userId: targetId,
            timestamp: now
          });
        }
      }
      return;
    }

    // 3. Mark messages as read
    if (type === 'mark_read') {
      const { conversationType, targetId } = msg;
      const res = MessageService.markAsRead(conversationType, Number(targetId), currentUser.id);

      if (conversationType === 'direct') {
        // Notify original sender that their messages were read
        this.sendToUser(targetId, {
          type: 'messages_read',
          byUserId: currentUser.id,
          messageIds: res.messageIds
        });
      }
      return;
    }

    // 4. Typing indicator
    if (type === 'typing') {
      const { conversationType, targetId, isTyping } = msg;
      const payload = {
        type: 'user_typing',
        userId: currentUser.id,
        userName: currentUser.full_name,
        conversationType,
        targetId,
        isTyping: !!isTyping
      };

      if (conversationType === 'channel') {
        this.broadcast(payload, ws);
      } else {
        this.sendToUser(targetId, payload);
      }
      return;
    }

    // 5. Presence Status Change (Online / Away / DND)
    if (type === 'set_status' || type === 'status_update') {
      const { status, customStatus } = msg;
      UserService.updateStatus(currentUser.id, status, customStatus);
      currentUser.status = status;
      currentUser.custom_status = customStatus;

      this.broadcast({
        type: 'user_status_changed',
        userId: currentUser.id,
        user_id: currentUser.id,
        status,
        customStatus
      });
      return;
    }

    // 6. WebRTC Voice / Video Call Signalling
    if (['call_offer', 'call_answer', 'ice_candidate', 'call_end', 'call_rejected'].includes(type)) {
      const { targetUserId } = msg;

      // Placing a call is a per-role permission (can_call); hanging up and
      // rejecting stay open so a call already in progress can always be
      // ended, whatever the caller's role became meanwhile.
      if (type === 'call_offer') {
        if (!currentUser.permissions?.can_call) {
          ws.send(JSON.stringify({
            type: 'call_denied',
            reason: 'Звонки не разрешены для вашей роли. Обратитесь к администратору.'
          }));
          return;
        }
        if (targetUserId === currentUser.id) return;
        // Nobody is at the other end — tell the caller instead of ringing out.
        if (!this.userSockets.get(targetUserId)?.size) {
          ws.send(JSON.stringify({
            type: 'call_unavailable',
            targetUserId,
            reason: 'Сотрудник сейчас не в сети'
          }));
          return;
        }
      }

      this.sendToUser(targetUserId, {
        ...msg,
        senderId: currentUser.id,
        senderName: currentUser.full_name
      });
      return;
    }

    // 7. Remote Desktop Plugin Signalling
    if (type === 'rd_request') {
      const { targetUserId } = msg;

      // Viewing a colleague's screen is granted per role by an administrator
      // (can_remote_control). The employee's own consent prompt below is a
      // second gate, not the first one — without this check any employee
      // could pop that prompt on any other employee at will.
      if (!currentUser.permissions?.can_remote_control) {
        ws.send(JSON.stringify({
          type: 'rd_denied',
          reason: 'Удалённый доступ к рабочим столам не разрешён для вашей роли. Обратитесь к администратору.'
        }));
        return;
      }
      if (targetUserId === currentUser.id) {
        ws.send(JSON.stringify({ type: 'rd_denied', reason: 'Нельзя подключиться к собственному рабочему столу' }));
        return;
      }

      const session = RemoteDesktopService.createSession(currentUser.id, targetUserId);
      AuditService.log({
        userId: currentUser.id,
        action: 'remote_desktop_request',
        ip: ws.remoteIp,
        details: { sessionId: session.sessionId, targetUserId }
      });

      // Send prompt modal to the target employee's desktop client
      this.sendToUser(targetUserId, {
        type: 'rd_prompt',
        sessionId: session.sessionId,
        operatorId: currentUser.id,
        operatorName: currentUser.full_name,
        operatorJobTitle: currentUser.job_title
      });

      // Acknowledge operator
      ws.send(JSON.stringify({
        type: 'rd_requested',
        sessionId: session.sessionId,
        targetUserId
      }));
      return;
    }

    if (type === 'rd_response') {
      const { sessionId, accepted, accessLevel } = msg;
      const session = RemoteDesktopService.getSession(sessionId);
      if (session) {
        RemoteDesktopService.updateStatus(sessionId, accepted ? 'ACCEPTED' : 'REJECTED');
        AuditService.log({
          userId: currentUser.id,
          action: accepted ? 'remote_desktop_accepted' : 'remote_desktop_rejected',
          ip: ws.remoteIp,
          details: {
            sessionId,
            operatorId: session.operatorId,
            // Управление или только просмотр — важнейшая часть записи.
            accessLevel: accepted ? accessLevel || 'full' : null
          }
        });
        // Notify operator of the decision
        this.sendToUser(session.operatorId, {
          type: 'rd_response',
          sessionId,
          accepted,
          accessLevel: accessLevel || 'full',
          targetUserId: currentUser.id,
          targetName: currentUser.full_name
        });
      }
      return;
    }

    if (['rd_webrtc_offer', 'rd_webrtc_answer', 'rd_ice_candidate', 'rd_input_event', 'rd_end'].includes(type)) {
      const { sessionId, targetUserId } = msg;

      // Relay only within a session both parties actually accepted — a
      // client-supplied sessionId alone must not be enough to steer input or
      // media at another user. See
      // docs/designs/auth-access-control-remediation.md item 13.
      const session = sessionId ? RemoteDesktopService.getSession(sessionId) : null;
      const isParticipant = session && (session.operatorId === currentUser.id || session.targetUserId === currentUser.id);
      if (!session || !isParticipant || (session.status !== 'ACCEPTED' && type !== 'rd_end')) {
        return;
      }

      this.sendToUser(targetUserId, {
        ...msg,
        fromUserId: currentUser.id
      });
      if (type === 'rd_end') {
        RemoteDesktopService.endSession(sessionId);
        AuditService.log({
          userId: currentUser.id,
          action: 'remote_desktop_ended',
          ip: ws.remoteIp,
          details: {
            sessionId,
            durationSeconds: session.createdAt
              ? Math.round((Date.now() - new Date(session.createdAt).getTime()) / 1000)
              : null
          }
        });
      }
      return;
    }
  }

  handleDisconnect(ws) {
    const user = this.socketUser.get(ws);
    if (!user) return;

    this.socketUser.delete(ws);
    const sockets = this.userSockets.get(user.id);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.userSockets.delete(user.id);
        // Mark user as offline
        UserService.updateStatus(user.id, 'offline');
        this.broadcast({
          type: 'user_status_changed',
          userId: user.id,
          user_id: user.id,
          status: 'offline'
        });
        console.log(`[WS] User disconnected: ${user.full_name} (#${user.id})`);
      }
    }
  }

  isUserOnline(userId) {
    const sockets = this.userSockets.get(Number(userId));
    return sockets && sockets.size > 0;
  }

  sendToUser(userId, data) {
    const sockets = this.userSockets.get(Number(userId));
    if (!sockets) return false;
    const payload = JSON.stringify(data);
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN) {
        s.send(payload);
      }
    }
    return true;
  }

  broadcast(data, excludeWs = null) {
    if (!this.wss) return;
    const payload = JSON.stringify(data);
    this.wss.clients.forEach((client) => {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  getOnlineConnectionsList() {
    const list = [];
    for (const [ws, user] of this.socketUser.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        list.push({
          userId: user.id,
          username: user.username,
          full_name: user.full_name,
          uin: user.uin,
          job_title: user.job_title || 'Сотрудник',
          department_name: user.department_name || 'Департамент',
          ip: ws.remoteIp || '127.0.0.1',
          connectedAt: ws.connectedAt || new Date().toISOString(),
          clientType: ws.clientType || 'MyChat Client',
          status: user.status || 'online',
          // Was Math.random(): the admin's "Активные подключения" table
          // reported a healthy 4-12 ms for every session regardless of the
          // real link. Nothing measures round-trip time yet, so it is null
          // rather than invented.
          pingMs: null
        });
      }
    }
    return list;
  }

  disconnectUser(userId) {
    const sockets = this.userSockets.get(Number(userId));
    if (sockets && sockets.size > 0) {
      for (const ws of sockets) {
        try {
          ws.send(JSON.stringify({ type: 'server_disconnect', reason: 'Сессия принудительно завершена администратором через панель управления' }));
          ws.close();
        } catch (e) {}
      }
      return true;
    }
    return false;
  }
}

module.exports = new WsServer();
