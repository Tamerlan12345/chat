// Решение «кому уведомление о сообщении» (multi-device.md §5): push на
// устройства, баннер в приложении на живые сокеты или ничего. Чистая функция:
// без часов, случайности и ввода-вывода. Эталон для iOS и Android —
// mobile/contracts/reference/notify-decision.mjs; блок между метками BEGIN/END
// обязан совпадать с ним байт в байт (server/test/notify-decision.test.js), а
// векторы mobile/contracts/fixtures/notify/*.json гоняются через оба файла.
// Сервер вызывает его при рассылке (WsServer.publishNewMessage) и перед каждой
// попыткой доставки push (PushService) — одно правило везде.

// ── BEGIN SHARED CORE ──
const ONLINE = 'online';

// Чат с точки зрения получателя: канал — его id, личный — собеседник.
function chatOf(message, recipientId) {
  const conversationType = message.conversationType === 'channel' ? 'channel' : 'direct';
  if (conversationType === 'channel') return { conversationType, targetId: Number(message.targetId) };
  const senderId = Number(message.senderId);
  return { conversationType, targetId: senderId === Number(recipientId) ? Number(message.targetId) : senderId };
}

// «Смотрит этот чат» — только сокет на переднем плане (online).
function isViewing(socket, chat) {
  const v = socket.viewing;
  return socket.presence === ONLINE && Boolean(v)
    && v.conversationType === chat.conversationType && Number(v.targetId) === chat.targetId;
}

function onlineDeviceIds(sockets) {
  const ids = new Set();
  for (const s of sockets) if (s.presence === ONLINE && s.deviceId) ids.add(s.deviceId);
  return ids;
}

function decideMessageNotification({ recipientId, dnd = false, message, sockets = [], pushDevices = [] }) {
  const silent = (reason) => ({ reason, push: [], banner: [], quiet: sockets.map((s) => s.id) });
  if (Number(message.senderId) === Number(recipientId)) return silent('own');
  if (dnd) return silent('dnd');
  const chat = chatOf(message, recipientId);
  if (sockets.some((s) => isViewing(s, chat))) return silent('viewing');

  const withPush = new Set(pushDevices.map((d) => d.id));
  const online = onlineDeviceIds(sockets);
  const banner = [];
  const quiet = [];
  for (const s of sockets) {
    // Сокет в фоне на устройстве с push — уведомит push; без push — баннер
    // (настольный клиент, телефон без токена).
    if (s.presence === ONLINE || !(s.deviceId && withPush.has(s.deviceId))) banner.push(s.id);
    else quiet.push(s.id);
  }
  const push = pushDevices.filter((d) => !online.has(d.id)).map((d) => d.id);
  return { reason: null, push, banner, quiet };
}

// Прочитано на одном устройстве — тихий push «read» тем устройствам с push,
// у которых нет сокета на переднем плане (они сами получат conversation_read).
function decideReadDismissal({ sockets = [], pushDevices = [] }) {
  const online = onlineDeviceIds(sockets);
  return { push: pushDevices.filter((d) => !online.has(d.id)).map((d) => d.id) };
}
// Входящий звонок (multi-device.md §5): звонит всегда — открытый чат его не
// глушит. Кадр call_offer получают все сокеты вызываемого; ring — сокеты,
// которые звонят по нему сами (на переднем плане или в фоне на устройстве без
// push), quiet — сокеты в фоне на устройстве с push: их будит push, кадр —
// данные для ответа. push — устройства без сокета на переднем плане, даже
// если другие устройства на связи. reason 'unreachable' — ни один сокет не
// зазвонит и разбудить нечего (вызывающему call_unavailable).
function decideCallNotification({ recipientId, dnd = false, call, sockets = [], pushDevices = [] }) {
  const silent = (reason) => ({ reason, push: [], ring: [], quiet: sockets.map((s) => s.id) });
  if (Number(call.callerId) === Number(recipientId)) return silent('own');
  if (dnd) return silent('dnd');
  const withPush = new Set(pushDevices.map((d) => d.id));
  const online = onlineDeviceIds(sockets);
  const ring = [];
  const quiet = [];
  for (const s of sockets) {
    if (s.presence === ONLINE || !(s.deviceId && withPush.has(s.deviceId))) ring.push(s.id);
    else quiet.push(s.id);
  }
  const push = pushDevices.filter((d) => !online.has(d.id)).map((d) => d.id);
  if (!ring.length && !push.length) return { reason: 'unreachable', push, ring, quiet };
  return { reason: null, push, ring, quiet };
}
// ── END SHARED CORE ──

module.exports = { chatOf, isViewing, decideMessageNotification, decideReadDismissal, decideCallNotification };
