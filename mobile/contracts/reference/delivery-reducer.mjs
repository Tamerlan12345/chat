// Reference client delivery reducer — the executable form of
// mobile/contracts/delivery-state.md. Pure: no clock, no randomness, no I/O.
// iOS and Android implement the same function and must pass every vector in
// mobile/contracts/fixtures/reducers/*.json.
//
//   reduce(state, event) -> { state, effects }
//
// The input state is never mutated. Section numbers (§) refer to delivery-state.md.

export const CLIENT_MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CONVERSATION_RE = /^(direct|channel):[1-9][0-9]*$/;
export const MAX_TEXT_LENGTH = 16000;
export const ACK_TIMEOUT_MS = 10000;
export const HTTP_ACK_TIMEOUT_MS = 30000;
export const MAX_ATTEMPTS = 5;
export const SEND_RATE_MAX = 8;
export const SEND_RATE_WINDOW_MS = 1000;
export const OPS_RATE_MAX = 8;
export const OPS_RATE_WINDOW_MS = 1000;
export const SYNC_PAGE_LIMIT = 200;
export const SYNC_RETRY_MS = 5000;
export const KEY_ERRORS = ['CLIENT_MSG_ID_CONFLICT', 'INVALID_CLIENT_MSG_ID'];
// ECMAScript WhiteSpace + LineTerminator — exactly what the server's trim() removes (§6.1).
export const WHITESPACE = '\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const BLANK_RE = new RegExp(`^[${WHITESPACE}]*$`);
const MSG_TYPES = ['text', 'file', 'image'];
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

export const backoff = (failures) => Math.min(1000 * 2 ** (failures - 1), 30000);

/** Initial state for a fresh install (§3). */
export function initialState(me = null) {
  return {
    me,
    connection: 'offline',
    visible: null,
    sync: { cursor: null, running: false, bootstrap: false, chain: 0 },
    seq: 0,
    outbox: [],
    ops: [],
    messages: {},
    unread: {},
    sendLog: [],
    opsLog: [],
    wake_at: null
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function parseConversation(conv) {
  const [conversationType, id] = conv.split(':');
  return { conversationType, targetId: Number(id) };
}

function conversationOf(rec, me) {
  if (rec.conversation_type === 'channel') return `channel:${rec.target_id}`;
  const partner = Number(rec.sender_id) === me ? rec.target_id : rec.sender_id;
  return `direct:${partner}`;
}

// Validates text the same way for enqueue and edit; returns a user_error code or null.
function textError(text, msgType) {
  if (typeof text !== 'string') return 'EMPTY_TEXT';
  if (msgType === 'text' && BLANK_RE.test(text)) return 'EMPTY_TEXT';
  if (text.length > MAX_TEXT_LENGTH) return 'TEXT_TOO_LONG'; // UTF-16 code units
  return null;
}

const instant = (iso) => (iso == null ? -Infinity : Date.parse(iso));

function statusFromRecord(rec, conv) {
  if (conv.startsWith('channel:')) return 'sent';
  if (rec.delivery_status === 'read') return 'read';
  if (rec.delivery_status === 'delivered') return 'delivered';
  return 'sent';
}

const maxStatus = (a, b) => ((STATUS_RANK[b] || 0) > (STATUS_RANK[a] || 0) ? b : a);

function project(rec, status) {
  return {
    id: rec.id,
    client_msg_id: rec.client_msg_id ?? null,
    sender_id: rec.sender_id,
    text: rec.text ?? '',
    type: rec.type ?? 'text',
    reply_to_id: rec.reply_to_id ?? null,
    metadata_json: rec.metadata_json ?? null,
    created_at: rec.created_at,
    updated_at: rec.updated_at ?? null,
    is_deleted: rec.is_deleted ? 1 : 0,
    status
  };
}

const CONTENT = ['text', 'type', 'reply_to_id', 'metadata_json', 'created_at', 'updated_at', 'is_deleted'];

function sendMessageFrame(e) {
  return {
    type: 'send_message',
    ...parseConversation(e.conversation),
    text: e.text,
    msgType: e.msgType,
    replyToId: e.reply_to_id,
    metadata: e.metadata,
    client_msg_id: e.client_msg_id
  };
}

const opFrame = (op) => (op.op === 'edit'
  ? { type: 'edit_message', messageId: op.message_id, text: op.text }
  : { type: 'delete_message', messageId: op.message_id });

const markReadFrame = (conv) => ({ type: 'mark_read', ...parseConversation(conv) });

function findMessage(state, id) {
  for (const [conv, list] of Object.entries(state.messages)) {
    const m = list.find((x) => x.id === id);
    if (m) return { conv, m };
  }
  return null;
}

function cmidInUse(state, cmid) {
  if (state.outbox.some((e) => e.client_msg_id === cmid)) return true;
  return Object.values(state.messages).some((list) => list.some((m) => m.sender_id === state.me && m.client_msg_id === cmid));
}

const sortOutbox = (state) => state.outbox.sort((a, b) => a.seq - b.seq);
const entryOf = (state, cmid) => state.outbox.find((e) => e.client_msg_id === cmid) || null;
const removeEntry = (state, cmid) => { state.outbox = state.outbox.filter((e) => e.client_msg_id !== cmid); };
const deleteOpOf = (state, id) => state.ops.find((o) => o.op === 'delete' && o.message_id === id) || null;

function newOp(op, messageId, text) {
  return { op, message_id: messageId, text, state: 'queued', attempts: 0, failures: 0, ack_deadline: null, next_attempt_at: null };
}

function addDeleteOp(state, id) {
  if (!deleteOpOf(state, id)) state.ops.push(newOp('delete', id, null));
}

// A tombstone confirms the delete (and makes any pending edit pointless) — §6.3.
function confirmDeleted(state, id) {
  state.ops = state.ops.filter((o) => o.message_id !== id);
}

// ── sync chains (§6.3, §7.11) ───────────────────────────────────────────────

function startSync(state, effects) {
  state.sync.chain += 1;
  state.sync.running = true;
  state.sync.bootstrap = state.sync.cursor === null;
  effects.push({ type: 'sync_request', cursor: state.sync.cursor, limit: SYNC_PAGE_LIMIT, chain: state.sync.chain });
}

function maybeStartSync(state, effects) {
  if (state.connection === 'online' && !state.sync.running) startSync(state, effects);
}

const currentChain = (state, ev) => state.sync.running && ev.chain === state.sync.chain;

// ── outcomes of an attempt (§6.3) ───────────────────────────────────────────

function reject(state, e, code, message) {
  if (e.pending_delete) { removeEntry(state, e.client_msg_id); return; }
  e.state = 'failed';
  e.failure = { reason: 'rejected', code: code ?? null, message: message ?? null };
  e.maybe_stored = false;
  e.transport = null;
  e.ack_deadline = null;
  e.next_attempt_at = null;
  if (e.pending_edit !== null) { e.text = e.pending_edit; e.pending_edit = null; }
}

function attemptFailed(state, e, now, effects) {
  e.transport = null;
  e.ack_deadline = null;
  if (e.pending_delete) {
    // Never sent again (§7.10); find out via sync.
    e.state = 'queued';
    e.next_attempt_at = null;
    maybeStartSync(state, effects);
    return;
  }
  e.failures += 1;
  if (e.failures >= MAX_ATTEMPTS) {
    e.state = 'failed';
    e.failure = { reason: 'max_attempts', code: null, message: null };
    e.next_attempt_at = null;
  } else {
    e.state = 'queued';
    e.next_attempt_at = now + backoff(e.failures);
  }
}

// Attempt cut off by disconnect/restart/401: back to queued, budget untouched (§7.3).
function attemptInterrupted(e) {
  e.state = 'queued';
  e.transport = null;
  e.ack_deadline = null;
  e.next_attempt_at = null;
}

// ── ingest of a server record (§6.3, §7.6–7.9) ──────────────────────────────

function ingest(state, rec, source, effects) {
  const conv = conversationOf(rec, state.me);
  const own = Number(rec.sender_id) === state.me;
  let reconciled = false;

  if (own && rec.client_msg_id != null) {
    const e = entryOf(state, rec.client_msg_id);
    if (e) {
      removeEntry(state, e.client_msg_id);
      reconciled = true;
      if (!rec.is_deleted) {
        if (e.pending_delete) addDeleteOp(state, rec.id);
        else if (e.pending_edit !== null && e.pending_edit !== rec.text) state.ops.push(newOp('edit', rec.id, e.pending_edit));
      }
    }
  }

  const list = state.messages[conv] || [];
  const existing = list.find((m) => m.id === rec.id);
  let inserted = false;
  if (existing) {
    if (rec.is_deleted) {
      for (const k of CONTENT) existing[k] = project(rec, null)[k];
    } else if (!existing.is_deleted && instant(rec.updated_at) >= instant(existing.updated_at)) {
      for (const k of CONTENT) existing[k] = project(rec, null)[k];
    }
    existing.client_msg_id = existing.client_msg_id ?? rec.client_msg_id ?? null;
    if (own) existing.status = maxStatus(existing.status, statusFromRecord(rec, conv));
  } else if (source !== 'update' || reconciled) {
    list.push(project(rec, own ? statusFromRecord(rec, conv) : null));
    list.sort((a, b) => a.id - b.id);
    state.messages[conv] = list;
    inserted = true;
  }

  if (rec.is_deleted) confirmDeleted(state, rec.id);

  if (source === 'live' && inserted && !rec.is_deleted) {
    if (own) {
      if (conv.startsWith('channel:')) delete state.unread[conv];
    } else if (conv === state.visible) {
      if (state.connection === 'online') effects.push({ type: 'send_ws', frame: markReadFrame(conv) });
    } else {
      state.unread[conv] = (state.unread[conv] || 0) + 1;
    }
  }
}

// ── pump and background flush (§6.2) ───────────────────────────────────────

// Heads of each conversation that may be sent now, in seq order.
function eligibleHeads(state, now, onWait) {
  const busy = new Set(state.outbox.filter((e) => e.state === 'sending' && !e.pending_delete).map((e) => e.conversation));
  const occupied = new Set();
  const heads = [];
  for (const e of state.outbox) {
    if (e.pending_delete || e.state === 'failed' || occupied.has(e.conversation)) continue;
    occupied.add(e.conversation);
    if (e.state !== 'queued' || busy.has(e.conversation)) continue;
    if (e.next_attempt_at !== null && e.next_attempt_at > now) { onWait(e.next_attempt_at); continue; }
    heads.push(e);
  }
  return heads;
}

function pump(state, now, effects) {
  if (state.connection !== 'online' || state.sync.running) return;
  if (state.wake_at !== null && state.wake_at <= now) state.wake_at = null;
  state.sendLog = state.sendLog.filter((t) => now - t < SEND_RATE_WINDOW_MS);
  state.opsLog = state.opsLog.filter((t) => now - t < OPS_RATE_WINDOW_MS);

  let wakeAt = null;
  const wake = (t) => { wakeAt = wakeAt === null ? t : Math.min(wakeAt, t); };

  const sentEdits = new Set();
  for (const op of state.ops) {
    if (op.state !== 'queued') continue;
    if (op.next_attempt_at !== null && op.next_attempt_at > now) { wake(op.next_attempt_at); continue; }
    if (state.opsLog.length >= OPS_RATE_MAX) { wake(state.opsLog[0] + OPS_RATE_WINDOW_MS); continue; }
    state.opsLog.push(now);
    op.attempts += 1;
    effects.push({ type: 'send_ws', frame: opFrame(op) });
    if (op.op === 'edit') {
      sentEdits.add(op);
    } else {
      op.state = 'sending';
      op.ack_deadline = now + ACK_TIMEOUT_MS;
      op.next_attempt_at = null;
      effects.push({ type: 'schedule', at: op.ack_deadline, event: { type: 'op_timeout', message_id: op.message_id, attempt: op.attempts } });
    }
  }
  state.ops = state.ops.filter((op) => !sentEdits.has(op));

  for (const e of eligibleHeads(state, now, wake)) {
    if (state.sendLog.length >= SEND_RATE_MAX) { wake(state.sendLog[0] + SEND_RATE_WINDOW_MS); continue; }
    e.state = 'sending';
    e.transport = 'ws';
    e.attempts += 1;
    e.maybe_stored = true;
    e.ack_deadline = now + ACK_TIMEOUT_MS;
    e.next_attempt_at = null;
    state.sendLog.push(now);
    effects.push({ type: 'send_ws', frame: sendMessageFrame(e) });
    effects.push({ type: 'schedule', at: e.ack_deadline, event: { type: 'ack_timeout', client_msg_id: e.client_msg_id, attempt: e.attempts } });
  }
  if (wakeAt !== null && wakeAt !== state.wake_at) effects.push({ type: 'schedule', at: wakeAt, event: { type: 'tick' } });
  state.wake_at = wakeAt;
}

function backgroundFlush(state, now, effects) {
  if (state.connection !== 'offline') return;
  for (const e of eligibleHeads(state, now, () => {})) {
    e.state = 'sending';
    e.transport = 'http';
    e.attempts += 1;
    e.maybe_stored = true;
    e.ack_deadline = now + HTTP_ACK_TIMEOUT_MS;
    e.next_attempt_at = null;
    const { conversationType, targetId } = parseConversation(e.conversation);
    effects.push({
      type: 'send_http',
      client_msg_id: e.client_msg_id,
      attempt: e.attempts,
      method: 'POST',
      path: `/api/messages/${conversationType === 'channel' ? 'channels' : 'direct'}/${targetId}`,
      body: { text: e.text, type: e.msgType, reply_to_id: e.reply_to_id, metadata: e.metadata, client_msg_id: e.client_msg_id }
    });
    effects.push({ type: 'schedule', at: e.ack_deadline, event: { type: 'ack_timeout', client_msg_id: e.client_msg_id, attempt: e.attempts } });
  }
}

// ── sync results ────────────────────────────────────────────────────────────

function completeChain(state, effects) {
  state.sync.running = false;
  effects.push({ type: 'refresh_conversation_lists' });
  if (state.sync.bootstrap && state.visible !== null) effects.push({ type: 'load_history', conversation: state.visible });

  // Cancelled entries that are not in flight (§7.10): this chain started after their last attempt.
  const unresolved = state.outbox.filter((e) => e.pending_delete && e.state !== 'sending');
  if (!state.sync.bootstrap) {
    for (const e of unresolved) removeEntry(state, e.client_msg_id);
  } else {
    const seen = new Set(state.visible !== null ? [state.visible] : []);
    for (const e of unresolved) {
      if (seen.has(e.conversation)) continue;
      seen.add(e.conversation);
      effects.push({ type: 'load_history', conversation: e.conversation });
    }
  }
  state.sync.bootstrap = false;
  if (state.visible !== null && state.connection === 'online') effects.push({ type: 'send_ws', frame: markReadFrame(state.visible) });
}

function onSyncPage(state, ev, effects) {
  if (!currentChain(state, ev)) return;
  const body = ev.body;
  for (const rec of body.messages) ingest(state, rec, 'sync', effects);
  state.sync.cursor = body.next_cursor;
  if (body.has_more) {
    effects.push({ type: 'sync_request', cursor: body.next_cursor, limit: SYNC_PAGE_LIMIT, chain: state.sync.chain });
    return;
  }
  completeChain(state, effects);
}

// ── user actions (§6.3, §7.10) ──────────────────────────────────────────────

function onEnqueue(state, ev, effects) {
  const cmid = ev.client_msg_id;
  if (typeof cmid !== 'string' || !CLIENT_MSG_ID_RE.test(cmid)) return effects.push({ type: 'user_error', code: 'INVALID_CLIENT_MSG_ID' });
  if (cmidInUse(state, cmid)) return undefined;
  if (typeof ev.conversation !== 'string' || !CONVERSATION_RE.test(ev.conversation)) return effects.push({ type: 'user_error', code: 'INVALID_CONVERSATION' });
  const msgType = ev.msgType ?? 'text';
  if (!MSG_TYPES.includes(msgType)) return effects.push({ type: 'user_error', code: 'INVALID_MESSAGE_TYPE' });
  const err = textError(ev.text, msgType);
  if (err) return effects.push({ type: 'user_error', code: err });

  state.seq += 1;
  state.outbox.push({
    client_msg_id: cmid,
    conversation: ev.conversation,
    seq: state.seq,
    text: ev.text,
    msgType,
    reply_to_id: ev.reply_to_id ?? null,
    metadata: ev.metadata ?? null,
    state: 'queued',
    attempts: 0,
    failures: 0,
    maybe_stored: false,
    transport: null,
    ack_deadline: null,
    next_attempt_at: null,
    failure: null,
    pending_edit: null,
    pending_delete: false
  });
  effects.push({ type: 'clear_composer', conversation: ev.conversation });
  return undefined;
}

function onEdit(state, ev, effects) {
  const hasCmid = ev.client_msg_id !== undefined && ev.client_msg_id !== null;
  const hasId = ev.message_id !== undefined && ev.message_id !== null;
  if (hasCmid === hasId) return effects.push({ type: 'user_error', code: 'NOT_EDITABLE' });

  if (hasCmid) {
    const e = entryOf(state, ev.client_msg_id);
    if (!e || e.pending_delete || e.msgType !== 'text') return effects.push({ type: 'user_error', code: 'NOT_EDITABLE' });
    const err = textError(ev.text, 'text');
    if (err) return effects.push({ type: 'user_error', code: err });
    if (e.maybe_stored) e.pending_edit = ev.text;
    else e.text = ev.text;
    return undefined;
  }

  const found = findMessage(state, ev.message_id);
  const m = found && found.m;
  if (!m || m.sender_id !== state.me || m.is_deleted || m.type !== 'text' || deleteOpOf(state, m.id)) {
    return effects.push({ type: 'user_error', code: 'NOT_EDITABLE' });
  }
  const err = textError(ev.text, 'text');
  if (err) return effects.push({ type: 'user_error', code: err });
  state.ops.push(newOp('edit', m.id, ev.text));
  return undefined;
}

function onDelete(state, ev, effects) {
  const found = findMessage(state, ev.message_id);
  const m = found && found.m;
  if (!m || m.sender_id !== state.me || m.is_deleted) return effects.push({ type: 'user_error', code: 'NOT_DELETABLE' });
  addDeleteOp(state, m.id);
  return undefined;
}

function onCancel(state, ev, effects) {
  const e = entryOf(state, ev.client_msg_id);
  if (!e) return;
  if (!e.maybe_stored) { removeEntry(state, e.client_msg_id); return; }
  e.pending_delete = true;
  e.pending_edit = null;
  if (e.state === 'failed') {
    e.state = 'queued';
    e.failure = null;
    e.failures = 0;
    e.next_attempt_at = null;
  }
  if (e.state !== 'sending') maybeStartSync(state, effects);
}

function onRetry(state, ev, effects) {
  const e = entryOf(state, ev.client_msg_id);
  if (!e || e.state !== 'failed') return undefined;
  if (e.failure && KEY_ERRORS.includes(e.failure.code)) {
    const fresh = ev.new_client_msg_id;
    if (typeof fresh !== 'string' || !CLIENT_MSG_ID_RE.test(fresh) || cmidInUse(state, fresh)) {
      return effects.push({ type: 'user_error', code: 'INVALID_CLIENT_MSG_ID' });
    }
    e.client_msg_id = fresh;
    e.maybe_stored = false;
  }
  e.state = 'queued';
  e.failures = 0;
  e.failure = null;
  e.next_attempt_at = null;
  state.seq += 1;
  e.seq = state.seq;
  sortOutbox(state);
  return undefined;
}

// ── server frames ───────────────────────────────────────────────────────────

function onFrame(state, frame, effects) {
  switch (frame.type) {
    case 'auth_success':
      state.me = Number(frame.user.id);
      state.connection = 'online';
      state.sendLog = [];
      state.opsLog = [];
      if (!state.sync.running) startSync(state, effects);
      return;
    case 'new_message':
    case 'direct_message':
    case 'channel_message':
      ingest(state, frame.message, 'live', effects);
      return;
    case 'message_updated':
      ingest(state, frame.message, 'update', effects);
      return;
    case 'message_deleted': {
      const found = findMessage(state, frame.messageId);
      if (found) {
        found.m.is_deleted = 1;
        found.m.text = '';
        found.m.metadata_json = null;
      }
      confirmDeleted(state, frame.messageId);
      return;
    }
    case 'message_status_updated': {
      const found = findMessage(state, frame.messageId);
      if (found && found.conv.startsWith('direct:') && found.m.sender_id === state.me && STATUS_RANK[frame.status] >= 2) {
        found.m.status = maxStatus(found.m.status, frame.status);
      }
      return;
    }
    case 'messages_read': {
      const list = state.messages[`direct:${frame.byUserId}`] || [];
      for (const id of frame.messageIds || []) {
        const m = list.find((x) => x.id === id);
        if (m && m.sender_id === state.me) m.status = 'read';
      }
      return;
    }
    case 'error': {
      if (frame.context !== 'send_message' || frame.client_msg_id == null) return;
      const e = entryOf(state, frame.client_msg_id);
      if (e && e.state !== 'failed') reject(state, e, frame.code, frame.message);
      return;
    }
    default:
  }
}

function onHttpSendResult(state, ev, effects) {
  if (ev.status === 200 || ev.status === 201) {
    ingest(state, ev.body, 'http', effects);
    return;
  }
  const e = entryOf(state, ev.client_msg_id);
  if (!e || e.state !== 'sending' || e.transport !== 'http' || e.attempts !== ev.attempt) return;
  const s = ev.status;
  if (s === 401) attemptInterrupted(e);
  else if (s >= 400 && s < 500 && s !== 408 && s !== 429) reject(state, e, ev.body && ev.body.code, ev.body && ev.body.error);
  else attemptFailed(state, e, ev.now, effects);
}

function onOpTimeout(state, ev, effects) {
  const op = deleteOpOf(state, ev.message_id);
  if (!op || op.state !== 'sending' || op.attempts !== ev.attempt || ev.now < op.ack_deadline) return;
  op.failures += 1;
  op.ack_deadline = null;
  if (op.failures >= MAX_ATTEMPTS) {
    state.ops = state.ops.filter((o) => o !== op);
    effects.push({ type: 'user_error', code: 'DELETE_NOT_CONFIRMED' });
  } else {
    op.state = 'queued';
    op.next_attempt_at = ev.now + backoff(op.failures);
  }
}

function resetInFlight(state, { http }) {
  for (const e of state.outbox) {
    if (e.state === 'sending' && (http || e.transport === 'ws')) attemptInterrupted(e);
  }
  for (const op of state.ops) {
    if (op.state === 'sending') {
      op.state = 'queued';
      op.ack_deadline = null;
      op.next_attempt_at = null;
    }
  }
}

// ── reducer ─────────────────────────────────────────────────────────────────

function handle(state, ev, effects) {
  const now = ev.now;
  switch (ev.type) {
    case 'ws': return onFrame(state, ev.frame, effects);
    case 'ws_disconnected':
      state.connection = 'offline';
      state.sync.running = false;
      state.sendLog = [];
      state.opsLog = [];
      resetInFlight(state, { http: false });
      return undefined;
    case 'enqueue': return onEnqueue(state, ev, effects);
    case 'edit': return onEdit(state, ev, effects);
    case 'delete': return onDelete(state, ev, effects);
    case 'cancel': return onCancel(state, ev, effects);
    case 'retry': return onRetry(state, ev, effects);
    case 'ack_timeout': {
      const e = entryOf(state, ev.client_msg_id);
      if (e && e.state === 'sending' && e.attempts === ev.attempt && now >= e.ack_deadline) attemptFailed(state, e, now, effects);
      return undefined;
    }
    case 'op_timeout': return onOpTimeout(state, ev, effects);
    case 'tick': return undefined;
    case 'sync_start':
      maybeStartSync(state, effects);
      return undefined;
    case 'sync_page': return onSyncPage(state, ev, effects);
    case 'sync_reset_410':
      if (!currentChain(state, ev)) return undefined;
      state.sync.cursor = null;
      state.sync.bootstrap = true;
      state.messages = {};
      effects.push({ type: 'sync_request', cursor: null, limit: SYNC_PAGE_LIMIT, chain: state.sync.chain });
      return undefined;
    case 'sync_failed':
      if (!currentChain(state, ev)) return undefined;
      state.sync.running = false;
      if (ev.status !== 401) {
        effects.push({ type: 'schedule', at: now + (ev.retry_after_ms ?? SYNC_RETRY_MS), event: { type: 'sync_start' } });
      }
      return undefined;
    case 'history_page':
      for (const rec of ev.body) ingest(state, rec, 'history', effects);
      return undefined;
    case 'http_send_result': return onHttpSendResult(state, ev, effects);
    case 'unread_snapshot': {
      state.unread = {};
      for (const [k, n] of Object.entries(ev.counts)) if (n > 0 && k !== state.visible) state.unread[k] = n;
      if (state.visible !== null && ev.counts[state.visible] > 0 && state.connection === 'online') {
        effects.push({ type: 'send_ws', frame: markReadFrame(state.visible) });
      }
      return undefined;
    }
    case 'conversation_opened':
      state.visible = ev.conversation;
      delete state.unread[ev.conversation];
      if (state.connection === 'online') effects.push({ type: 'send_ws', frame: markReadFrame(ev.conversation) });
      return undefined;
    case 'conversation_closed':
      state.visible = null;
      return undefined;
    case 'background_flush': return backgroundFlush(state, now, effects);
    case 'app_restart':
      state.connection = 'offline';
      state.visible = null;
      state.sync.running = false;
      state.sync.bootstrap = false;
      state.messages = {};
      state.unread = {};
      state.sendLog = [];
      state.opsLog = [];
      state.wake_at = null;
      resetInFlight(state, { http: true });
      return undefined;
    default: return undefined;
  }
}

/**
 * Applies one event (§6). Returns a new state and the ordered effect list;
 * `persist` (when outbox/seq, ops or the sync cursor changed) is always first.
 */
export function reduce(input, event) {
  const state = clone(input);
  const effects = [];
  handle(state, event, effects);
  pump(state, event.now, effects);

  const slices = [];
  if (state.sync.cursor !== input.sync.cursor) slices.push('cursor');
  if (!deepEqual(state.ops, input.ops)) slices.push('ops');
  if (state.seq !== input.seq || !deepEqual(state.outbox, input.outbox)) slices.push('outbox');
  if (slices.length) effects.unshift({ type: 'persist', slices });
  return { state, effects };
}
