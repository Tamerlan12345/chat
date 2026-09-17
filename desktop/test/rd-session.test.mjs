import test from 'node:test';
import assert from 'node:assert';
import {
  RD_DEFAULT_ICE_SERVERS,
  RD_CONNECT_TIMEOUT_MS,
  parseIceServers,
  getRdIceServers
} from '../src/renderer/src/lib/rd-config.mjs';
import {
  normalizeAccessLevel,
  isHostMessageAllowed,
  createEndGuard,
  ClipboardWatcher
} from '../src/renderer/src/lib/rd-session.mjs';
import { keyEventToInput } from '../src/renderer/src/lib/remote-keyboard.mjs';

// ── Уровень доступа ─────────────────────────────────────────────────────────
// «Только просмотр» раньше ограничивал лишь мышь и клавиатуру: файлы и буфер
// обмена оператора исполнялись у сотрудника как при полном доступе.

test('всё, кроме full, — только просмотр (как на сервере)', () => {
  assert.strictEqual(normalizeAccessLevel('full'), 'full');
  assert.strictEqual(normalizeAccessLevel('view_only'), 'view_only');
  assert.strictEqual(normalizeAccessLevel('FULL'), 'view_only');
  assert.strictEqual(normalizeAccessLevel(undefined), 'view_only');
});

test('после окончания сеанса не принимается ничего', () => {
  for (const type of ['rd_input_event', 'rd_file', 'rd_select_screen', 'rd_clipboard', 'rd_webrtc_answer', 'rd_ice_candidate']) {
    assert.strictEqual(isHostMessageAllowed(type, { active: false, accessLevel: 'full', clipboardAllowed: true }), false, type);
  }
});

test('при просмотре оператор не может ни управлять, ни передавать файлы, ни трогать буфер', () => {
  const ctx = { active: true, accessLevel: 'view_only', clipboardAllowed: true };
  for (const type of ['rd_input_event', 'rd_file', 'rd_clipboard', 'rd_clipboard_mode']) {
    assert.strictEqual(isHostMessageAllowed(type, ctx), false, type);
  }
  for (const type of ['rd_webrtc_answer', 'rd_ice_candidate', 'rd_select_screen', 'rd_end']) {
    assert.strictEqual(isHostMessageAllowed(type, ctx), true, type);
  }
});

test('текст в буфер сотрудника — только после его согласия', () => {
  assert.strictEqual(isHostMessageAllowed('rd_clipboard', { active: true, accessLevel: 'full', clipboardAllowed: false }), false);
  assert.strictEqual(isHostMessageAllowed('rd_clipboard', { active: true, accessLevel: 'full', clipboardAllowed: true }), true);
  assert.strictEqual(isHostMessageAllowed('rd_clipboard_mode', { active: true, accessLevel: 'full', clipboardAllowed: false }), true, 'просьба включить — это вопрос сотруднику');
  assert.strictEqual(isHostMessageAllowed('rd_input_event', { active: true, accessLevel: 'full' }), true);
  assert.strictEqual(isHostMessageAllowed('rd_exec', { active: true, accessLevel: 'full' }), false);
});

// ── Завершение сеанса ровно один раз ────────────────────────────────────────

test('rd_end уходит один раз на сеанс', () => {
  const sent = [];
  const guard = createEndGuard((sessionId) => { sent.push(sessionId); return true; });
  assert.strictEqual(guard.end('s1'), true);
  assert.strictEqual(guard.end('s1'), false);
  assert.strictEqual(guard.end('s2'), true);
  assert.deepStrictEqual(sent, ['s1', 's2']);
  assert.strictEqual(guard.isEnded('s1'), true);
});

test('сеанс, завершённый другой стороной, обратно не завершается', () => {
  const sent = [];
  const guard = createEndGuard((sessionId) => { sent.push(sessionId); return true; });
  guard.mark('s3');
  assert.strictEqual(guard.end('s3'), false);
  assert.deepStrictEqual(sent, []);
});

test('неотправленное завершение (сокет закрыт) можно повторить', () => {
  let open = false;
  const sent = [];
  const guard = createEndGuard((sessionId) => { if (!open) return false; sent.push(sessionId); return true; });
  assert.strictEqual(guard.end('s1'), false);
  open = true;
  assert.strictEqual(guard.end('s1'), true);
  assert.deepStrictEqual(sent, ['s1']);
  assert.strictEqual(guard.end(null), false);
});

// ── Буфер обмена ────────────────────────────────────────────────────────────
// Раньше при включении общего буфера сотрудник сразу отдавал оператору то,
// что лежало у него в буфере до этого, — например, скопированный пароль.

function watcher(initial) {
  const box = { text: initial, sent: [] };
  const w = new ClipboardWatcher({
    read: async () => { if (box.text instanceof Error) throw box.text; return box.text; },
    send: (text) => box.sent.push(text)
  });
  return { w, box };
}

test('содержимое буфера до согласия не уходит', async () => {
  const { w, box } = watcher('пароль123');
  await w.prime();
  await w.tick();
  assert.deepStrictEqual(box.sent, []);
  box.text = 'новый текст';
  await w.tick();
  assert.deepStrictEqual(box.sent, ['новый текст']);
});

test('без prime первый опрос только запоминает', async () => {
  const { w, box } = watcher('секрет');
  await w.tick();
  await w.tick();
  assert.deepStrictEqual(box.sent, []);
  box.text = 'после';
  await w.tick();
  assert.deepStrictEqual(box.sent, ['после']);
});

test('полученный с той стороны текст обратно не отправляется', async () => {
  const { w, box } = watcher('');
  await w.prime();
  w.remember('от оператора');
  box.text = 'от оператора';
  await w.tick();
  assert.deepStrictEqual(box.sent, []);
});

test('пустой буфер и ошибка чтения ничего не отправляют и не бросают', async () => {
  const { w, box } = watcher('');
  await w.prime();
  await w.tick();
  box.text = new Error('буфер занят');
  await w.tick();
  assert.deepStrictEqual(box.sent, []);
});

test('после reset снова нужно согласие', async () => {
  const { w, box } = watcher('a');
  await w.prime();
  w.reset();
  box.text = 'b';
  await w.tick();
  assert.deepStrictEqual(box.sent, [], 'первый опрос после сброса только запоминает');
});

// ── Настройки соединения ────────────────────────────────────────────────────

test('по умолчанию — STUN и таймаут около 20 секунд', () => {
  assert.ok(RD_DEFAULT_ICE_SERVERS.length >= 1);
  assert.ok(RD_DEFAULT_ICE_SERVERS.every((s) => String(s.urls).startsWith('stun:')));
  assert.strictEqual(RD_CONNECT_TIMEOUT_MS, 20000);
});

test('свой TURN задаётся списком JSON', () => {
  const raw = JSON.stringify([{ urls: 'turn:turn.corp.kz:3478', username: 'u', credential: 'p' }]);
  assert.deepStrictEqual(parseIceServers(raw), [{ urls: 'turn:turn.corp.kz:3478', username: 'u', credential: 'p' }]);
});

test('мусор в настройке не ломает соединение', () => {
  assert.strictEqual(parseIceServers('{not json'), null);
  assert.strictEqual(parseIceServers('{"urls":"stun:a"}'), null);
  assert.strictEqual(parseIceServers('[]'), null);
  assert.strictEqual(parseIceServers(JSON.stringify([{ urls: 'http://evil' }])), null);
  assert.deepStrictEqual(
    parseIceServers(JSON.stringify([{ urls: ['stun:a.kz', 'javascript:x'] }])),
    [{ urls: ['stun:a.kz'] }]
  );
});

test('недоступное хранилище — значения по умолчанию', () => {
  assert.deepStrictEqual(getRdIceServers(null, { getItem: () => { throw new Error('denied'); } }), RD_DEFAULT_ICE_SERVERS);
  assert.deepStrictEqual(getRdIceServers(null, null), RD_DEFAULT_ICE_SERVERS);
  const custom = getRdIceServers(undefined, { getItem: () => JSON.stringify([{ urls: 'turns:t.kz:443' }]) });
  assert.deepStrictEqual(custom, [{ urls: 'turns:t.kz:443' }]);
  getRdIceServers(null, null).push({ urls: 'stun:x' });
  assert.ok(RD_DEFAULT_ICE_SERVERS.every((s) => s.urls !== 'stun:x'), 'значения по умолчанию не портятся');
});

test('список с сервера главнее локальной настройки', () => {
  const local = { getItem: () => JSON.stringify([{ urls: 'stun:local.kz' }]) };
  const fromServer = [{ urls: 'turn:turn.corp.kz:3478', username: 'u', credential: 'p' }];
  assert.deepStrictEqual(getRdIceServers(fromServer, local), fromServer);
});

test('пустой список с сервера — только локальная сеть, без Google', () => {
  const local = { getItem: () => JSON.stringify([{ urls: 'stun:local.kz' }]) };
  assert.deepStrictEqual(getRdIceServers([], local), []);
  assert.deepStrictEqual(getRdIceServers([], null), []);
});

test('мусор с сервера отбрасывается, запасные серверы не подставляются', () => {
  assert.deepStrictEqual(getRdIceServers([{ urls: 'http://evil' }, null, 'x'], null), []);
  assert.deepStrictEqual(
    getRdIceServers([{ urls: 'stun:a.kz', credential: 5 }, { urls: 'javascript:x' }], null),
    [{ urls: 'stun:a.kz' }]
  );
  assert.deepStrictEqual(parseIceServers([{ urls: 'turns:t.kz:443' }]), [{ urls: 'turns:t.kz:443' }]);
});

// ── Клавиатура оператора ────────────────────────────────────────────────────

const ev = (o) => ({
  key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
  isComposing: false, getModifierState: () => false, ...o
});

test('печатный символ уходит текстом — раскладка сотрудника не важна', () => {
  assert.deepStrictEqual(keyEventToInput(ev({ key: 'ж', code: 'Semicolon' })), { type: 'text', text: 'ж' });
  assert.deepStrictEqual(keyEventToInput(ev({ key: 'Ж', code: 'Semicolon', shiftKey: true })), { type: 'text', text: 'Ж' });
  assert.deepStrictEqual(keyEventToInput(ev({ key: ' ', code: 'Space' })), { type: 'text', text: ' ' });
});

test('Ctrl+C на русской раскладке уходит физической клавишей KeyC', () => {
  assert.deepStrictEqual(
    keyEventToInput(ev({ key: 'с', code: 'KeyC', ctrlKey: true })),
    { type: 'key', code: 'KeyC', key: 'с', ctrl: true, alt: false, shift: false }
  );
});

test('служебные клавиши уходят кодом', () => {
  assert.deepStrictEqual(
    keyEventToInput(ev({ key: 'Enter', code: 'Enter' })),
    { type: 'key', code: 'Enter', key: 'Enter', ctrl: false, alt: false, shift: false }
  );
  assert.strictEqual(keyEventToInput(ev({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true })).shift, true);
});

test('AltGr печатает символ, а не сочетание Ctrl+Alt', () => {
  assert.deepStrictEqual(
    keyEventToInput(ev({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' })),
    { type: 'text', text: '@' }
  );
});

test('одиночные модификаторы, мёртвые клавиши и набор IME не отправляются', () => {
  assert.strictEqual(keyEventToInput(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true })), null);
  assert.strictEqual(keyEventToInput(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })), null);
  assert.strictEqual(keyEventToInput(ev({ key: 'Dead', code: 'Quote' })), null);
  assert.strictEqual(keyEventToInput(ev({ key: 'Unidentified', code: '' })), null);
  assert.strictEqual(keyEventToInput(ev({ key: 'a', code: 'KeyA', isComposing: true })), null);
  assert.strictEqual(keyEventToInput(ev({ key: 'r', code: 'KeyR', metaKey: true })), null);
  assert.strictEqual(keyEventToInput(null), null);
});
