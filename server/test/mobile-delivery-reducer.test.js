const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Общие табличные векторы клиентской модели доставки (mobile/contracts/fixtures/reducers).
//
// Каждый вектор прогоняется через эталонный редьюсер mobile/contracts/reference/
// delivery-reducer.mjs: эффекты каждого события и итоговое состояние должны
// совпасть. Так векторы проверены на самосогласованность; iOS и Android гоняют
// те же файлы через свои редьюсеры. Контракт — mobile/contracts/delivery-state.md.

const REPO = path.resolve(__dirname, '../..');
const CONTRACTS = path.join(REPO, 'mobile/contracts');
const VECTORS_DIR = path.join(CONTRACTS, 'fixtures/reducers');
const FIXTURES = path.join(CONTRACTS, 'fixtures');
const SPEC = path.join(CONTRACTS, 'delivery-state.md');
const REDUCER = pathToFileURL(path.join(CONTRACTS, 'reference/delivery-reducer.mjs')).href;

const STATE_KEYS = ['me', 'connection', 'visible', 'sync', 'seq', 'outbox', 'ops', 'messages', 'unread', 'sendLog', 'wake_at'];
const VECTOR_KEYS = ['name', 'description', 'covers', 'initialState', 'events', 'expectedEffects', 'expectedState'];

function loadVectors() {
  if (!fs.existsSync(VECTORS_DIR)) return [];
  return fs.readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, vector: JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, file), 'utf8')) }));
}

const vectors = loadVectors();

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const keySet = (o) => Object.keys(o).sort();

function specTransitionIds() {
  const md = fs.readFileSync(SPEC, 'utf8');
  return [...md.matchAll(/^\| (T\d{2}) \|/gm)].map((m) => m[1]);
}

test('there are at least 30 well-formed vectors', () => {
  assert.ok(vectors.length >= 30, `only ${vectors.length} vectors in fixtures/reducers`);
  const names = new Set();
  for (const { file, vector } of vectors) {
    assert.deepStrictEqual(keySet(vector), [...VECTOR_KEYS].sort(), `${file}: top-level keys`);
    assert.strictEqual(`${vector.name}.json`, file, `${file}: name must equal the file name`);
    assert.ok(!names.has(vector.name), `${file}: duplicate name`);
    names.add(vector.name);
    assert.ok(typeof vector.description === 'string' && vector.description.length > 0, `${file}: description`);
    assert.ok(Array.isArray(vector.covers) && vector.covers.length > 0, `${file}: covers`);
    assert.deepStrictEqual(keySet(vector.initialState), [...STATE_KEYS].sort(), `${file}: initialState must be a complete state`);
    assert.ok(Array.isArray(vector.events) && vector.events.length > 0, `${file}: events`);
    assert.strictEqual(vector.expectedEffects.length, vector.events.length, `${file}: one effects list per event`);
    let last = -Infinity;
    vector.events.forEach((e, i) => {
      assert.ok(typeof e.type === 'string', `${file}: event ${i} type`);
      assert.ok(Number.isInteger(e.now), `${file}: event ${i} now`);
      assert.ok(e.now >= last, `${file}: event ${i} time goes backwards`);
      last = e.now;
    });
    const expectedKeys = Object.keys(vector.expectedState);
    assert.ok(expectedKeys.length > 0, `${file}: expectedState is empty`);
    for (const k of expectedKeys) assert.ok(STATE_KEYS.includes(k), `${file}: unknown state key ${k}`);
  }
});

test('every transition of delivery-state.md is covered by a vector', () => {
  const ids = specTransitionIds();
  assert.ok(ids.length >= 30, 'transition table not found in delivery-state.md');
  const covered = new Set(vectors.flatMap(({ vector }) => vector.covers));
  for (const id of ids) assert.ok(covered.has(id), `transition ${id} is not covered by any vector`);
  for (const id of covered) assert.ok(ids.includes(id), `vectors cover unknown transition ${id}`);
});

test('server events in vectors use the WS/HTTP fixture shapes', () => {
  const wsDir = path.join(FIXTURES, 'ws');
  const wsVariants = (type) => fs.readdirSync(wsDir)
    .filter((f) => f === `${type}.json` || f.startsWith(`${type}.`))
    .map((f) => JSON.parse(fs.readFileSync(path.join(wsDir, f), 'utf8')));
  const liveMessageKeys = keySet(readJson('ws/new_message.direct.json').message);
  const syncMessageKeys = keySet(readJson('http/sync.page.json').messages[0]);
  const historyMessageKeys = keySet(readJson('http/messages.direct-page.json')[0]);
  const restMessageKeys = keySet(readJson('http/messages.send-direct-idempotent.json'));
  const syncBodyKeys = keySet(readJson('http/sync.page.json'));
  const invalidCursorKeys = keySet(readJson('http/sync.cursor-invalid.json'));

  for (const { file, vector } of vectors) {
    vector.events.forEach((e, i) => {
      const where = `${file}: event ${i} (${e.type})`;
      if (e.type === 'ws') {
        const variants = wsVariants(e.frame.type);
        assert.ok(variants.length > 0, `${where}: no fixture for ws/${e.frame.type}`);
        const union = new Set(variants.flatMap((v) => Object.keys(v)));
        for (const k of Object.keys(e.frame)) assert.ok(union.has(k), `${where}: key ${k} is not in any ws/${e.frame.type} fixture`);
        if (e.frame.message && typeof e.frame.message === 'object') assert.deepStrictEqual(keySet(e.frame.message), liveMessageKeys, `${where}: message shape`);
      } else if (e.type === 'sync_page') {
        assert.deepStrictEqual(keySet(e.body), syncBodyKeys, `${where}: body shape`);
        for (const m of e.body.messages) assert.deepStrictEqual(keySet(m), syncMessageKeys, `${where}: message shape`);
      } else if (e.type === 'sync_reset_410') {
        assert.deepStrictEqual(keySet(e.body), invalidCursorKeys, `${where}: body shape`);
      } else if (e.type === 'history_page') {
        assert.ok(Array.isArray(e.body), `${where}: body must be an array`);
        for (const m of e.body) assert.deepStrictEqual(keySet(m), historyMessageKeys, `${where}: message shape`);
      } else if (e.type === 'http_send_result') {
        if (e.status === 200 || e.status === 201) {
          assert.deepStrictEqual(keySet(e.body), restMessageKeys, `${where}: body shape`);
        } else if (e.body !== null) {
          assert.ok(typeof e.body.error === 'string', `${where}: error body needs error`);
          for (const k of Object.keys(e.body)) assert.ok(k === 'error' || k === 'code', `${where}: unexpected key ${k}`);
        }
      }
    });
  }
});

for (const { file, vector } of vectors) {
  test(`vector ${vector.name}`, async () => {
    const { reduce } = await import(REDUCER);
    const run = () => {
      let state = deepFreeze(clone(vector.initialState));
      const effects = [];
      for (const event of vector.events) {
        const out = reduce(state, deepFreeze(clone(event)));
        effects.push(out.effects);
        state = deepFreeze(out.state);
      }
      return { state, effects };
    };
    const first = run();
    vector.events.forEach((event, i) => {
      assert.deepStrictEqual(first.effects[i], vector.expectedEffects[i],
        `${file}: effects of event ${i} (${event.type}${event.frame ? `/${event.frame.type}` : ''})`);
    });
    for (const [key, expected] of Object.entries(vector.expectedState)) {
      assert.deepStrictEqual(first.state[key], expected, `${file}: final state.${key}`);
    }
    assert.deepStrictEqual(keySet(first.state), [...STATE_KEYS].sort(), `${file}: final state keys`);
    assert.deepStrictEqual(run(), first, `${file}: reducer is not deterministic`);
  });
}
