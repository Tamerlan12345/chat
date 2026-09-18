// Подставной сервер презентации.
//
// Живет в главном окне (деке), а окна приложения обращаются к нему через
// postMessage. Отвечает ровно теми данными, которые сняты с настоящего сервера
// (fixtures.json), и ведет живое состояние: сообщения, прочтения, статусы,
// побудки, звонки. Поэтому в презентации работает не запись экрана, а само
// приложение.

const nowIso = () => new Date().toISOString();

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

export function createMockServer(fx) {
  const api = fx.api;
  const state = {
    users: clone(api['users'].data),
    tree: clone(api['org/tree'].data),
    channels: clone(api['channels'].data),
    announcements: {},
    messages: [],
    files: clone(fx.files),
    nextMessageId: 1,
    nextFileId: 100,
    lastRead: {}, // `${userId}:${type}:${targetId}` -> id последнего прочитанного
    wakeRetryAt: {}, // userId -> время, раньше которого будить нельзя
    dnd: new Set(),
    presence: {} // userId -> 'online' | 'away'
  };

  // Сообщения: собираем из всех снятых историй в один список.
  const seen = new Set();
  const addFromFixture = (key) => {
    const list = api[key]?.data;
    if (!Array.isArray(list)) return;
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      state.messages.push(clone(m));
    }
  };
  for (const key of Object.keys(api)) if (/messages\/(direct|channels)\//.test(key)) addFromFixture(key);
  state.messages.sort((a, b) => a.id - b.id);
  state.nextMessageId = (state.messages[state.messages.length - 1]?.id || 0) + 1;
  state.nextFileId = Math.max(0, ...Object.keys(state.files).map(Number)) + 1;

  // Оповещения — свои у каждого сотрудника (отметка об ознакомлении).
  const annBase = clone(api['announcements'].data) || [];
  const annAdmin = clone(api['announcements:admin'].data) || [];
  const annAkhmetov = clone(api['akhmetov:announcements'].data) || [];
  const annByUser = { 2: annBase, 1: annAdmin, 3: annAkhmetov };
  const audits = {};
  for (const key of Object.keys(api)) {
    const m = key.match(/^announcements\/(\d+)\/audit$/);
    if (m) audits[m[1]] = clone(api[key].data);
  }
  state.announcements = (userId) => {
    if (!annByUser[userId]) annByUser[userId] = clone(annBase).map((a) => ({ ...a, is_confirmed: 0 }));
    return annByUser[userId];
  };

  // Рабочий день компании: в презентации открыто одно-два окна, но коллеги
  // должны выглядеть так же, как в обычный день.
  const DAY = {
    admin: 'online', 'a.saparova': 'online', 'd.akhmetov': 'online', 'r.kim': 'online',
    't.omarov': 'online', 'n.petrenko': 'online', 'm.iskakov': 'online',
    'o.belova': 'away', 's.li': 'away', 'zh.nurlanova': 'dnd', 'b.zhunusov': 'offline'
  };
  const baseStatus = {};
  for (const u of state.users) {
    const st = DAY[u.username] || 'online';
    baseStatus[u.id] = st;
    u.status = st;
    state.presence[u.id] = st === 'away' ? 'away' : 'online';
    if (st === 'dnd') state.dnd.add(u.id);
  }

  // Переписка снята вчера: сдвигаем время так, чтобы разговор шел сегодня.
  const stamps = state.messages.map((m) => new Date(m.created_at).getTime()).filter(Number.isFinite);
  if (stamps.length) {
    const shift = Date.now() - 45 * 60 * 1000 - Math.max(...stamps);
    const move = (iso) => (iso ? new Date(new Date(iso).getTime() + shift).toISOString() : iso);
    for (const m of state.messages) m.created_at = move(m.created_at);
    for (const list of [annBase, annAdmin, annAkhmetov]) {
      for (const a of list || []) {
        a.created_at = move(a.created_at);
        if (a.confirmed_at) a.confirmed_at = move(a.confirmed_at);
      }
    }
    for (const data of Object.values(audits)) {
      if (data.announcement?.created_at) data.announcement.created_at = move(data.announcement.created_at);
      for (const r of data.recipients || []) {
        if (r.confirmed_at) r.confirmed_at = move(r.confirmed_at);
        if (r.read_at) r.read_at = move(r.read_at);
      }
    }
  }

  const tokens = new Map();
  const users = {};
  for (const [name, login] of Object.entries(fx.logins)) {
    tokens.set(login.token, login.user.id);
    users[login.user.id] = clone(login.user);
    users[login.user.id].__name = name;
  }
  const userById = (id) => users[id] || state.users.find((u) => u.id === Number(id)) || null;
  const publicUser = (id) => state.users.find((u) => u.id === Number(id)) || null;
  const fullName = (id) => userById(id)?.full_name || 'Сотрудник';
  const passwords = { 'a.saparova': 'Рабочий-пароль-1', 'd.akhmetov': 'Рабочий-пароль-1', admin: 'Демо-Админ-2026' };
  const tokenFor = (username) => {
    const entry = Object.values(fx.logins).find((l) => l.user.username === username);
    return entry ? entry.token : null;
  };

  // ── WebSocket: подключенные окна ──────────────────────────────────────────
  const clients = new Map(); // clientId -> { userId, send }

  function push(userId, payload) {
    for (const [, c] of clients) if (c.userId === userId) c.send(payload);
  }
  function broadcast(payload) {
    for (const [, c] of clients) c.send(payload);
  }
  function effectiveStatus(userId) {
    if (state.dnd.has(userId)) return 'dnd';
    const connected = [...clients.values()].some((c) => c.userId === userId);
    if (connected) return state.presence[userId] || 'online';
    // Окна коллег в презентации открыты не всегда, а компания работает.
    return baseStatus[userId] || 'online';
  }
  function publishStatus(userId) {
    const status = effectiveStatus(userId);
    const u = publicUser(userId);
    if (u) u.status = status;
    broadcast({ type: 'user_status_changed', userId, user_id: userId, status, customStatus: null });
  }

  // ── Вспомогательное ───────────────────────────────────────────────────────
  const dialogKey = (a, b) => `direct:${Math.min(a, b)}:${Math.max(a, b)}`;
  const directMessages = (meId, otherId) =>
    state.messages.filter(
      (m) =>
        m.conversation_type === 'direct' &&
        ((m.sender_id === meId && m.target_id === otherId) || (m.sender_id === otherId && m.target_id === meId))
    );
  const channelMessages = (id) => state.messages.filter((m) => m.conversation_type === 'channel' && m.target_id === Number(id));

  function unreadDirect(meId, otherId) {
    const read = state.lastRead[`${meId}:direct:${otherId}`] ?? Number.MAX_SAFE_INTEGER;
    if (read === Number.MAX_SAFE_INTEGER) {
      // до первого открытия берем то, что показывал настоящий сервер
      const fromFixture = (api[meId === 3 ? 'akhmetov:conversations/direct' : 'conversations/direct'] || api['conversations/direct'])?.data;
      const row = Array.isArray(fromFixture) ? fromFixture.find((c) => c.user_id === otherId) : null;
      return Number(row?.unread_count || 0);
    }
    return directMessages(meId, otherId).filter((m) => m.sender_id === otherId && m.id > read).length;
  }

  function conversations(meId) {
    const partners = new Set();
    for (const m of state.messages) {
      if (m.conversation_type !== 'direct') continue;
      if (m.sender_id === meId) partners.add(m.target_id);
      else if (m.target_id === meId) partners.add(m.sender_id);
    }
    const rows = [];
    for (const id of partners) {
      const u = publicUser(id);
      if (!u) continue;
      const list = directMessages(meId, id);
      const last = list[list.length - 1];
      rows.push({
        ...u,
        user_id: id,
        status: effectiveStatus(id),
        department_name: u.department_name || departmentOf(id),
        last_message_id: last?.id || 0,
        last_message_text: last?.text || '',
        last_message_time: last?.created_at || null,
        last_message_sender_id: last?.sender_id || null,
        last_message_type: last?.type || 'text',
        unread_count: unreadDirect(meId, id)
      });
    }
    rows.sort((a, b) => new Date(b.last_message_time || 0) - new Date(a.last_message_time || 0));
    return rows;
  }

  function departmentOf(userId) {
    let found = '';
    const walk = (d) => {
      for (const e of d.employees || []) if (e.id === userId) found = d.name;
      for (const s of d.subDepartments || []) walk(s);
    };
    for (const root of state.tree?.tree || []) walk(root);
    return found;
  }

  function channelsFor(meId) {
    return state.channels.map((c) => {
      const list = channelMessages(c.id);
      const last = list[list.length - 1];
      const read = state.lastRead[`${meId}:channel:${c.id}`] ?? (c.last_read_message_id || 0);
      return {
        ...c,
        last_message_text: last?.text || c.last_message_text || null,
        last_message_time: last?.created_at || c.last_message_time || null,
        unread_count: list.filter((m) => m.id > read && m.sender_id !== meId).length
      };
    });
  }

  function treeFor() {
    const walk = (d) => ({
      ...d,
      employees: (d.employees || []).map((e) => ({ ...e, status: effectiveStatus(e.id) })),
      subDepartments: (d.subDepartments || []).map(walk),
      onlineStaffCount: countOnline(d)
    });
    const countOnline = (d) => {
      let n = (d.employees || []).filter((e) => ['online', 'away', 'dnd'].includes(effectiveStatus(e.id))).length;
      for (const s of d.subDepartments || []) n += countOnline(s);
      return n;
    };
    const online = state.users.filter((u) => ['online', 'away', 'dnd'].includes(effectiveStatus(u.id))).length;
    return {
      ...state.tree,
      totalUsers: state.users.length,
      onlineUsers: online,
      tree: (state.tree?.tree || []).map(walk),
      unassigned: (state.tree?.unassigned || []).map((e) => ({ ...e, status: effectiveStatus(e.id) }))
    };
  }

  function makeMessage({ senderId, conversationType, targetId, text, type = 'text', metadata = null }) {
    const sender = userById(senderId) || publicUser(senderId) || {};
    const msg = {
      id: state.nextMessageId++,
      conversation_type: conversationType,
      target_id: Number(targetId),
      sender_id: senderId,
      text,
      type,
      reply_to_id: null,
      metadata_json: metadata ? JSON.stringify(metadata) : null,
      created_at: nowIso(),
      updated_at: null,
      is_deleted: 0,
      delivery_status: 'sent',
      sender_username: sender.username,
      sender_name: sender.full_name,
      sender_avatar: null,
      sender_department: departmentOf(senderId)
    };
    state.messages.push(msg);
    return msg;
  }

  function deliver(msg) {
    if (msg.conversation_type === 'direct') {
      const online = [...clients.values()].some((c) => c.userId === msg.target_id);
      if (online) msg.delivery_status = 'delivered';
      for (const uid of [msg.target_id, msg.sender_id]) {
        push(uid, { type: 'direct_message', message: msg });
        push(uid, { type: 'new_message', message: msg });
      }
      if (online) push(msg.sender_id, { type: 'message_status_updated', messageId: msg.id, status: 'delivered', userId: msg.target_id, timestamp: nowIso() });
    } else {
      broadcast({ type: 'channel_message', message: msg });
      broadcast({ type: 'new_message', message: msg });
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const ok = (data) => ({ status: 200, data });
  const created = (data) => ({ status: 201, data });
  const fail = (status, error) => ({ status, data: { error } });

  function http({ method, path, body, token }) {
    const meId = tokens.get(token) || null;
    const q = path.split('?');
    const p = q[0].replace(/^.*\/api/, '/api');
    const query = new URLSearchParams(q[1] || '');
    const seg = p.split('/').filter(Boolean); // ['api', ...]
    const me = meId ? userById(meId) : null;

    if (p === '/api/settings/info') return ok(clone(api['settings/info'].data));
    if (p === '/api/settings/departments') return ok(clone(api['settings/departments'].data));

    if (p === '/api/auth/login' && method === 'POST') {
      const { username, password } = body || {};
      const t = tokenFor(username);
      const known = passwords[username];
      if (!t || !known || (password || '').trim() !== known) return fail(401, 'Неверный логин или пароль');
      const uid = tokens.get(t);
      return ok({ token: t, user: clone(userById(uid)) });
    }
    if (p === '/api/auth/knock') return fail(404, 'Устройство не привязано');
    if (p === '/api/auth/device/claim') return ok({ success: true });
    if (p === '/api/auth/refresh') return meId ? ok({ token }) : fail(401, 'Войдите заново');
    if (p === '/api/auth/logout') return ok({ success: true });
    if (!meId) return fail(401, 'Требуется вход');

    if (p === '/api/auth/me') return ok({ user: clone(userById(meId)) });
    if (p === '/api/users') return ok(state.users.map((u) => ({ ...u, status: effectiveStatus(u.id) })));
    if (/^\/api\/users\/\d+$/.test(p)) return ok(clone(api['users/' + seg[2]]?.data) || publicUser(seg[2]));
    if (p === '/api/users/profile' && method === 'PUT') {
      Object.assign(users[meId], body || {});
      return ok(clone(users[meId]));
    }
    if (p === '/api/users/password') return ok({ success: true, token, user: clone(userById(meId)) });
    if (p === '/api/org/tree') return ok(treeFor());
    if (p === '/api/channels') return ok(channelsFor(meId));
    if (p === '/api/conversations/direct') return ok(conversations(meId));
    if (p === '/api/settings/rd') return ok(clone(api['settings/rd'].data));

    if (p === '/api/announcements' && method === 'GET') return ok(clone(state.announcements(meId)));
    if (/^\/api\/announcements\/\d+\/acknowledge$/.test(p)) {
      const id = Number(seg[2]);
      const list = state.announcements(meId);
      const row = list.find((a) => a.id === id);
      if (row) {
        row.is_confirmed = 1;
        row.confirmed_at = nowIso();
      }
      const audit = audits[String(id)];
      for (const r of audit?.recipients || []) {
        if (r.id !== meId) continue;
        r.is_confirmed = 1;
        r.confirmed_at = nowIso();
        r.read_at = r.read_at || nowIso();
        r.ip_address = r.ip_address || '10.20.4.31';
      }
      if (audit?.stats) {
        const total = audit.recipients.length;
        const confirmedCount = audit.recipients.filter((r) => r.is_confirmed).length;
        audit.stats = { ...audit.stats, total, confirmedCount, percentage: Math.round((confirmedCount / Math.max(1, total)) * 100) };
      }
      broadcast({ type: 'announcement_acknowledged', announcementId: id, userId: meId, userName: fullName(meId) });
      return ok({ success: true });
    }
    if (/^\/api\/announcements\/\d+\/audit$/.test(p)) return ok(clone(audits[seg[2]]) || { recipients: [] });
    if (p === '/api/announcements' && method === 'POST') {
      const list = clone(state.announcements(meId));
      const ann = {
        id: 900 + list.length,
        title: body?.title || 'Оповещение',
        content: body?.content || '',
        priority: body?.priority || 'normal',
        author_id: meId,
        author_name: fullName(meId),
        author_job_title: userById(meId)?.job_title || '',
        target_type: 'all',
        created_at: nowIso(),
        is_confirmed: 0
      };
      for (const uid of Object.keys(annByUser)) annByUser[uid].unshift({ ...ann, is_confirmed: Number(uid) === meId ? 1 : 0 });
      broadcast({ type: 'new_announcement', announcement: ann });
      return created(ann);
    }

    if (/^\/api\/messages\/direct\/\d+$/.test(p)) {
      const other = Number(seg[3]);
      if (method === 'GET') return ok(directMessages(meId, other).slice(-50));
      const msg = makeMessage({ senderId: meId, conversationType: 'direct', targetId: other, text: body?.text, type: body?.type || 'text', metadata: body?.metadata });
      deliver(msg);
      return created(msg);
    }
    if (/^\/api\/messages\/channels\/\d+$/.test(p)) {
      const id = Number(seg[3]);
      if (method === 'GET') return ok(channelMessages(id).slice(-50));
      const msg = makeMessage({ senderId: meId, conversationType: 'channel', targetId: id, text: body?.text, type: body?.type || 'text', metadata: body?.metadata });
      deliver(msg);
      return created(msg);
    }
    if (p === '/api/messages/search') {
      const needle = (query.get('q') || '').toLowerCase();
      const rows = state.messages
        .filter((m) => String(m.text || '').toLowerCase().includes(needle))
        .filter((m) => (m.conversation_type === 'channel' ? true : m.sender_id === meId || m.target_id === meId))
        .slice(-8)
        .reverse()
        .map((m) => ({
          id: m.id,
          text: m.text,
          created_at: m.created_at,
          conversation_type: m.conversation_type,
          target_id: m.target_id,
          sender_id: m.sender_id,
          sender_name: m.sender_name,
          channel_name: m.conversation_type === 'channel' ? state.channels.find((c) => c.id === m.target_id)?.name : null
        }));
      return ok(rows);
    }
    if (/^\/api\/files\/download\/\d+$/.test(p)) {
      const f = state.files[seg[3]];
      return f ? { status: 200, file: f } : fail(404, 'Файл не найден');
    }
    if (p === '/api/channels' && method === 'POST') {
      const ch = { id: 900 + state.channels.length, name: '#' + (body?.name || 'канал'), topic: body?.topic || '', type: 'public', owner_id: meId, created_at: nowIso(), member_role: 'admin', members_count: 1, unread_count: 0, last_read_message_id: 0 };
      state.channels.push(ch);
      broadcast({ type: 'channel_created', channel: ch });
      return created(ch);
    }

    // Консоль администратора — данные с настоящего сервера.
    const adminKeys = {
      '/api/admin/users': 'admin/users',
      '/api/admin/roles': 'admin/roles',
      '/api/admin/server/overview': 'admin/server/overview',
      '/api/admin/registrations': 'admin/registrations',
      '/api/admin/channels': 'admin/channels',
      '/api/admin/settings': 'admin/settings',
      '/api/admin/filters': 'admin/filters',
      '/api/admin/security/status': 'admin/security/status',
      '/api/admin/security/alerts': 'admin/security/alerts',
      '/api/admin/audit': 'admin/audit',
      '/api/admin/audit/verify': 'admin/audit/verify',
      '/api/admin/audit/messages': 'admin/audit/messages',
      '/api/admin/devices/pending': 'admin/devices/pending',
      '/api/admin/licenses': 'admin/licenses',
      '/api/admin/db/stats': 'admin/db/stats',
      '/api/admin/db/tables': 'admin/db/tables',
      '/api/admin/db/backups': 'admin/db/backups'
    };
    if (adminKeys[p] && method === 'GET') {
      if (userById(meId)?.role_id !== 1) return fail(403, 'Недостаточно прав');
      return ok(clone(api[adminKeys[p]].data));
    }
    if (p === '/api/admin/settings' && method === 'PUT') return ok(clone(api['admin/settings'].data));

    return fail(404, 'Не найдено: ' + p);
  }

  // Загрузка файла: возвращает идентификатор, содержимое остается в памяти.
  function upload({ token, name, mime, size, dataUrl }) {
    if (!tokens.get(token)) return fail(401, 'Требуется вход');
    if (size > 100 * 1024 * 1024) return fail(413, 'Файл больше 100 МБ — такой файл загрузить нельзя');
    const id = state.nextFileId++;
    state.files[id] = { type: mime, size, base64: dataUrl ? String(dataUrl).split(',')[1] : null, disposition: '' };
    return created({ id, original_name: name, size, mime_type: mime });
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function connect(clientId, send) {
    clients.set(clientId, { userId: null, send });
    return {
      message(raw) {
        let msg;
        try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
        const c = clients.get(clientId);
        if (!c) return;
        if (msg.type === 'auth') {
          const uid = tokens.get(msg.token);
          if (!uid) return send({ type: 'auth_error', code: 'INVALID' });
          c.userId = uid;
          send({ type: 'auth_success', user: clone(userById(uid)) });
          send({ type: 'wake_state', retryAt: state.wakeRetryAt[uid] || 0 });
          publishStatus(uid);
          return;
        }
        if (!c.userId) return;
        const meId = c.userId;

        switch (msg.type) {
          case 'direct_message':
          case 'channel_message': {
            const conversationType = msg.conversationType || (msg.type === 'channel_message' ? 'channel' : 'direct');
            const targetId = Number(msg.targetId ?? msg.recipient_id ?? msg.channel_id);
            if (!msg.text || !targetId) return;
            const out = makeMessage({ senderId: meId, conversationType, targetId, text: msg.text, type: msg.msgType || 'text', metadata: msg.metadata });
            deliver(out);
            return;
          }
          case 'typing': {
            const targetId = Number(msg.targetId);
            const payload = { type: 'user_typing', userId: meId, userName: fullName(meId), conversationType: msg.conversationType, targetId: msg.conversationType === 'channel' ? targetId : meId, isTyping: Boolean(msg.isTyping) };
            if (msg.conversationType === 'channel') broadcast(payload);
            else push(targetId, { ...payload, targetId });
            return;
          }
          case 'mark_read': {
            const targetId = Number(msg.targetId);
            const type = msg.conversationType === 'channel' ? 'channel' : 'direct';
            const list = type === 'channel' ? channelMessages(targetId) : directMessages(meId, targetId);
            const ids = [];
            for (const m of list) {
              if (m.sender_id === meId) continue;
              if (m.delivery_status !== 'read') {
                m.delivery_status = 'read';
                ids.push(m.id);
              }
            }
            state.lastRead[`${meId}:${type}:${targetId}`] = list[list.length - 1]?.id || 0;
            if (type === 'direct' && ids.length) push(targetId, { type: 'messages_read', byUserId: meId, messageIds: ids });
            return;
          }
          case 'presence': {
            if (msg.state === 'online' || msg.state === 'away') {
              state.presence[meId] = msg.state;
              publishStatus(meId);
            }
            return;
          }
          case 'set_dnd': {
            if (msg.enabled) state.dnd.add(meId);
            else state.dnd.delete(meId);
            publishStatus(meId);
            return;
          }
          case 'wake_send': {
            const targetId = Number(msg.targetUserId);
            const at = Date.now();
            if ((state.wakeRetryAt[meId] || 0) > at) return send({ type: 'wake_error', code: 'cooldown', targetUserId: targetId, retryAt: state.wakeRetryAt[meId] });
            if (state.dnd.has(targetId)) return send({ type: 'wake_error', code: 'dnd', targetUserId: targetId });
            const online = [...clients.values()].some((x) => x.userId === targetId);
            if (!online) return send({ type: 'wake_error', code: 'offline', targetUserId: targetId });
            state.wakeRetryAt[meId] = at + 60000;
            send({ type: 'wake_sent', targetUserId: targetId, at, retryAt: state.wakeRetryAt[meId] });
            push(targetId, { type: 'wake_ring', fromUserId: meId, fromName: fullName(meId), at });
            return;
          }
          case 'call_offer': {
            const targetId = Number(msg.targetUserId);
            if (state.dnd.has(targetId)) return send({ type: 'call_unavailable', targetUserId: targetId, reason: 'У сотрудника включено «Не беспокоить»' });
            push(targetId, { type: 'call_offer', targetUserId: targetId, sdp: msg.sdp, senderId: meId, senderName: fullName(meId) });
            return;
          }
          case 'call_answer':
          case 'call_end':
          case 'call_rejected':
          case 'ice_candidate': {
            const targetId = Number(msg.targetUserId);
            push(targetId, { ...msg, senderId: meId, senderName: fullName(meId) });
            return;
          }
          case 'rd_request': {
            send({ type: 'rd_denied', reason: 'В презентации удаленный рабочий стол выключен' });
            return;
          }
          default:
        }
      },
      close() {
        const c = clients.get(clientId);
        clients.delete(clientId);
        if (c?.userId) publishStatus(c.userId);
      }
    };
  }

  // Действия «от лица коллеги» — ими режиссер сцены оживляет переписку.
  const actions = {
    say(userId, targetId, text, opts = {}) {
      const msg = makeMessage({ senderId: userId, conversationType: opts.channel ? 'channel' : 'direct', targetId, text, type: opts.type || 'text', metadata: opts.metadata });
      deliver(msg);
      return msg;
    },
    typing(userId, targetId, isTyping, channel = false) {
      const payload = { type: 'user_typing', userId, userName: fullName(userId), conversationType: channel ? 'channel' : 'direct', targetId, isTyping };
      if (channel) broadcast(payload);
      else push(targetId, payload);
    },
    read(userId, otherId) {
      const ids = directMessages(userId, otherId).filter((m) => m.sender_id !== userId && m.delivery_status !== 'read').map((m) => {
        m.delivery_status = 'read';
        return m.id;
      });
      state.lastRead[`${userId}:direct:${otherId}`] = directMessages(userId, otherId).slice(-1)[0]?.id || 0;
      if (ids.length) push(otherId, { type: 'messages_read', byUserId: userId, messageIds: ids });
    },
    securityAlert(alert) {
      broadcast({ type: 'security_alert', alert });
    },
    status(userId, status) {
      if (status === 'dnd') state.dnd.add(userId);
      else {
        state.dnd.delete(userId);
        state.presence[userId] = status === 'away' ? 'away' : 'online';
      }
      publishStatus(userId);
    },
    reset() {
      state.wakeRetryAt = {};
    }
  };

  return { http, upload, connect, actions, state, tokenFor, fileFor: (id) => state.files[id], debugClients: () => [...clients.entries()].map(([id, c]) => id + ':' + c.userId) };
}
