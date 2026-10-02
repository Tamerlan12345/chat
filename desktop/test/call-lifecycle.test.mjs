import test from 'node:test';
import assert from 'node:assert';
import { callSignalAction, ringTimeoutAction, RING_TIMEOUT_MS } from '../src/renderer/src/lib/call-signal.mjs';
import * as signal from '../src/renderer/src/lib/call-signal.mjs';
import { AudioRelay } from '../src/renderer/src/lib/audioRelay.js';

// ── Сигналы звонка ──────────────────────────────────────────────────────────

const ctx = (phase, direction = 'outgoing') => ({ phase, direction, peerId: 7 });

test('ответ собеседника включает микрофон только пока идёт вызов', () => {
  assert.strictEqual(callSignalAction(ctx('calling'), { type: 'call_answer', senderId: 7 }).action, 'start-audio');
  assert.strictEqual(callSignalAction(ctx('active'), { type: 'call_answer', senderId: 7 }).action, 'ignore', 'второй ответ не открывает микрофон заново');
  assert.strictEqual(callSignalAction(ctx('ringing', 'incoming'), { type: 'call_answer', senderId: 7 }).action, 'ignore');
});

test('сигналы от кого-то другого, кроме собеседника, не действуют', () => {
  assert.strictEqual(callSignalAction(ctx('calling'), { type: 'call_answer', senderId: 8 }).action, 'ignore');
  assert.strictEqual(callSignalAction(ctx('active'), { type: 'call_end' }).action, 'ignore', 'без отправителя');
  assert.strictEqual(callSignalAction(ctx('ringing', 'incoming'), { type: 'call_end', senderId: 9 }).action, 'ignore');
});

test('звонящий передумал, пока у нас звонит, — панель закрывается сама', () => {
  assert.strictEqual(callSignalAction(ctx('ringing', 'incoming'), { type: 'call_end', senderId: 7 }).action, 'dismiss');
  assert.strictEqual(callSignalAction(ctx('ringing', 'incoming'), { type: 'call_rejected', senderId: 7 }).action, 'dismiss');
});

test('отказ на исходящий вызов показывается', () => {
  const r = callSignalAction(ctx('calling'), { type: 'call_rejected', senderId: 7 });
  assert.strictEqual(r.action, 'fail');
  assert.match(r.error, /отклонил/);
});

test('собеседник завершил разговор', () => {
  assert.strictEqual(callSignalAction(ctx('active'), { type: 'call_end', senderId: 7 }).action, 'close');
  const dropped = callSignalAction(ctx('active'), { type: 'call_end', senderId: 7, reason: 'Собеседник отключился' });
  assert.strictEqual(dropped.action, 'fail');
  assert.strictEqual(dropped.error, 'Собеседник отключился');
  assert.strictEqual(callSignalAction(ctx('connecting', 'incoming'), { type: 'call_end', senderId: 7 }).action, 'fail');
  const micBroken = callSignalAction(ctx('calling'), { type: 'call_end', senderId: 7, reason: 'У собеседника не включился микрофон' });
  assert.strictEqual(micBroken.action, 'fail');
  assert.match(micBroken.error, /микрофон/);
});

test('«недоступен» относится только к нашему исходящему вызову', () => {
  const r = callSignalAction(ctx('calling'), { type: 'call_unavailable', targetUserId: 7, reason: 'Сотрудник сейчас не в сети' });
  assert.strictEqual(r.action, 'fail');
  assert.strictEqual(r.error, 'Сотрудник сейчас не в сети');
  assert.strictEqual(callSignalAction(ctx('calling'), { type: 'call_unavailable', targetUserId: 8 }).action, 'ignore');
  assert.strictEqual(callSignalAction(ctx('active'), { type: 'call_unavailable', targetUserId: 7 }).action, 'ignore');
  assert.strictEqual(callSignalAction(ctx('calling'), { type: 'call_denied', reason: 'Нет прав' }).action, 'fail');
});

test('после ошибки сигналы уже ничего не меняют', () => {
  for (const type of ['call_answer', 'call_end', 'call_rejected', 'call_unavailable']) {
    assert.strictEqual(callSignalAction(ctx('failed'), { type, senderId: 7, targetUserId: 7 }).action, 'ignore', type);
  }
});

// Сервер сообщает причину конца звонка кодом (no_call, unavailable,
// cancelled, timeout, connection_lost) — показывать нужно русский текст, а не
// код. Причину, которую написал собеседник (уже по-русски), — как есть.
test('коды причин сервера показываются по-русски, а не как есть', () => {
  const codes = ['no_call', 'unavailable', 'cancelled', 'timeout', 'connection_lost'];
  const seen = new Set();
  for (const code of codes) {
    const text = signal.callReasonText?.(code);
    assert.ok(typeof text === 'string' && /[а-яё]/i.test(text), `${code}: русский текст, а не ${text}`);
    assert.ok(!text.includes(code), `${code}: код не показывается`);
    seen.add(text);
    for (const [phase, direction] of [['active', 'outgoing'], ['connecting', 'incoming'], ['calling', 'outgoing']]) {
      const r = callSignalAction(ctx(phase, direction), { type: 'call_end', senderId: 7, reason: code });
      assert.strictEqual(r.action, 'fail', `${code} в фазе ${phase}`);
      assert.strictEqual(r.error, text, `${code} в фазе ${phase}`);
    }
    const rejected = callSignalAction(ctx('calling'), { type: 'call_rejected', senderId: 7, reason: code });
    assert.strictEqual(rejected.error, text);
    const unavailable = callSignalAction(ctx('calling'), { type: 'call_unavailable', targetUserId: 7, reason: code });
    assert.strictEqual(unavailable.error, text);
  }
  assert.strictEqual(seen.size, codes.length, 'у каждого кода свой текст');
  assert.match(signal.callReasonText('connection_lost'), /связь/i);
  assert.match(signal.callReasonText('cancelled'), /отмен/i);

  // Причина от собеседника — уже русский текст — показывается как есть.
  assert.strictEqual(signal.callReasonText('У собеседника не включился микрофон'), 'У собеседника не включился микрофон');
  assert.strictEqual(signal.callReasonText('Сотрудник сейчас не в сети'), 'Сотрудник сейчас не в сети');
  // Неизвестный код не показывается: вместо него — запасной текст.
  const unknown = callSignalAction(ctx('active'), { type: 'call_end', senderId: 7, reason: 'some_new_code' });
  assert.strictEqual(unknown.action, 'fail');
  assert.ok(!unknown.error.includes('some_new_code') && /[а-яё]/i.test(unknown.error), unknown.error);
  // Без причины — как раньше.
  assert.strictEqual(callSignalAction(ctx('active'), { type: 'call_end', senderId: 7 }).action, 'close');
  assert.strictEqual(signal.callReasonText('', 'Запасной'), 'Запасной');
});

// Задача 20: на звонок ответило другое устройство того же сотрудника
// (телефон) — сервер шлёт остальным call_end с кодом answered_elsewhere.
test('звонок принят на другом устройстве: звонящая панель тихо закрывается, опоздавший ответ — по-русски', () => {
  const text = signal.callReasonText('answered_elsewhere');
  assert.strictEqual(text, 'Звонок принят на другом устройстве');
  const msg = { type: 'call_end', senderId: 7, reason: 'answered_elsewhere' };
  assert.strictEqual(callSignalAction(ctx('ringing', 'incoming'), msg).action, 'dismiss');
  assert.deepStrictEqual(callSignalAction(ctx('connecting', 'incoming'), msg), { action: 'fail', error: text });
});

test('никто не берёт трубку: исходящий завершается с «Нет ответа», входящий исчезает', () => {
  assert.ok(RING_TIMEOUT_MS >= 30000 && RING_TIMEOUT_MS <= 60000);
  assert.deepStrictEqual(ringTimeoutAction('outgoing'), { action: 'fail', notify: 'call_end', error: 'Нет ответа' });
  assert.deepStrictEqual(ringTimeoutAction('incoming'), { action: 'dismiss' });
});

// ── Микрофон не остаётся включённым ─────────────────────────────────────────
// Звонок закрыли, пока система спрашивала разрешение на микрофон, — раньше
// поток и звуковой контекст создавались уже после закрытия и жили до
// перезапуска приложения: индикатор микрофона в Windows так и горел.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function installAudio({ getUserMedia, addModule, contextThrows } = {}) {
  const state = { tracks: [], contexts: [] };
  const makeStream = () => {
    const track = { stopped: false, enabled: true, stop() { this.stopped = true; } };
    state.tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };

  class FakeAudioContext {
    constructor() {
      if (contextThrows) throw new Error('звуковая карта недоступна');
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = { addModule: (url) => (addModule ? addModule(url) : Promise.resolve()) };
      state.contexts.push(this);
    }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  class FakeWorkletNode {
    constructor() { this.port = { onmessage: null }; }
    disconnect() {}
  }

  const saved = {
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  };
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeWorkletNode;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => (getUserMedia ? getUserMedia(makeStream) : Promise.resolve(makeStream()))
      }
    }
  });

  return {
    state,
    restore() {
      globalThis.AudioContext = saved.AudioContext;
      globalThis.AudioWorkletNode = saved.AudioWorkletNode;
      if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
    }
  };
}

function fakeSocket() {
  const listeners = new Set();
  return {
    readyState: 1,
    sent: [],
    listeners,
    send(data) { this.sent.push(data); },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); }
  };
}

test('stop() во время запроса микрофона: поток останавливается сразу по получении', async () => {
  const pending = deferred();
  const audio = installAudio({ getUserMedia: (make) => pending.promise.then(make) });
  try {
    const ws = fakeSocket();
    const relay = new AudioRelay({ ws, peerId: 7 });
    const started = relay.start();
    relay.stop();
    pending.resolve();

    await assert.rejects(started, (err) => err.name === 'AbortError');
    assert.strictEqual(audio.state.tracks.length, 1);
    assert.ok(audio.state.tracks.every((t) => t.stopped), 'микрофон выключен');
    assert.ok(audio.state.contexts.every((c) => c.state === 'closed'), 'звуковой контекст не живёт');
    assert.strictEqual(ws.listeners.size, 0, 'приём звука не подключён');
  } finally {
    audio.restore();
  }
});

test('stop() во время загрузки обработчика звука: контекст закрывается', async () => {
  const pending = deferred();
  const audio = installAudio({ addModule: () => pending.promise });
  try {
    const ws = fakeSocket();
    const relay = new AudioRelay({ ws, peerId: 7 });
    const started = relay.start();
    await new Promise((r) => setTimeout(r, 0));
    relay.stop();
    pending.resolve();

    await assert.rejects(started, (err) => err.name === 'AbortError');
    assert.ok(audio.state.tracks.every((t) => t.stopped));
    assert.strictEqual(audio.state.contexts.length, 1);
    assert.strictEqual(audio.state.contexts[0].state, 'closed');
    assert.strictEqual(ws.listeners.size, 0);
  } finally {
    audio.restore();
  }
});

test('сбой после получения микрофона сам его выключает', async () => {
  const audio = installAudio({ contextThrows: true });
  try {
    const relay = new AudioRelay({ ws: fakeSocket(), peerId: 7 });
    await assert.rejects(relay.start(), /звуковая карта/);
    assert.strictEqual(audio.state.tracks.length, 1);
    assert.ok(audio.state.tracks[0].stopped, 'поток не должен остаться открытым после ошибки');
  } finally {
    audio.restore();
  }
});

test('обычный запуск и остановка: приём отключается, stop() можно звать повторно', async () => {
  const audio = installAudio();
  try {
    const ws = fakeSocket();
    const relay = new AudioRelay({ ws, peerId: 7 });
    await relay.start();
    assert.strictEqual(ws.listeners.size, 1);
    relay.stop();
    relay.stop();
    assert.strictEqual(ws.listeners.size, 0);
    assert.ok(audio.state.tracks.every((t) => t.stopped));
    assert.ok(audio.state.contexts.every((c) => c.state === 'closed'));
  } finally {
    audio.restore();
  }
});
