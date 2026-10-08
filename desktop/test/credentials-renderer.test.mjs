import test from 'node:test';
import assert from 'node:assert/strict';
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
let counter = 0;
async function moduleFor(api, initial) {
  globalThis.localStorage = storage(initial);
  globalThis.window = { electronAPI: api ? { credentials: api } : undefined, location: { origin: 'https://chat.example' } };
  return import(`../src/renderer/src/lib/credentials.mjs?test=${counter++}`);
}
test('secure migration removes plaintext only after successful persistence acknowledgment', async () => {
  let acknowledge; let imported;
  const api = { restore: value => { imported = value; return new Promise(resolve => { acknowledge = resolve; }); } };
  const credentials = await moduleFor(api, { mychat_token: 'legacy', mychat_device_secret: 'secret', mychat_device_id: 'id' });
  const restoring = credentials.restoreCredentials();
  assert.equal(localStorage.getItem('mychat_device_secret'), 'secret');
  acknowledge({ token: 'legacy', deviceId: 'id' }); await restoring;
  assert.equal(imported.deviceSecret, 'secret');
  assert.equal(localStorage.getItem('mychat_token'), null); assert.equal(localStorage.getItem('mychat_device_secret'), null);
  assert.equal(credentials.getSessionToken(), 'legacy'); assert.equal(credentials.getDeviceId(), 'id');
});
test('failed migration retains plaintext for recovery and never falls back to legacy network', async () => {
  const credentials = await moduleFor({ restore: async () => { throw Error('locked'); } }, { mychat_token: 'legacy', mychat_device_secret: 'secret' });
  await assert.rejects(credentials.restoreCredentials());
  assert.equal(localStorage.getItem('mychat_device_secret'), 'secret'); assert.equal(credentials.getSessionToken(), '');
});
test('secure token writes stay out of localStorage and logout clears memory', async () => {
  const saved = [];
  const credentials = await moduleFor({ saveToken: async value => saved.push(value), clear: async () => saved.push('clear') });
  await credentials.saveSessionToken('fresh');
  assert.equal(credentials.getSessionToken(), 'fresh'); assert.equal(localStorage.getItem('mychat_token'), null);
  await credentials.clearCredentials(); assert.equal(credentials.getSessionToken(), ''); assert.deepEqual(saved, ['fresh', 'clear']);
});
test('secure secret operations reject another origin before invoking IPC', async () => {
  let calls = 0;
  const credentials = await moduleFor({ knock: async () => { calls++; }, claim: async () => { calls++; } });
  await assert.rejects(credentials.knockDevice('https://evil.example', {}));
  await assert.rejects(credentials.claimDevice('https://evil.example', 'token'));
  assert.equal(calls, 0);
});
test('old installed shells retain restore/save/logout compatibility until upgraded', async () => {
  const credentials = await moduleFor(null, { mychat_token: 'legacy', mychat_device_id: 'id', mychat_device_secret: 'secret' });
  assert.equal(await credentials.restoreCredentials(), 'legacy'); assert.equal(credentials.hasSecureCredentials(), false);
  await credentials.saveSessionToken('renewed'); assert.equal(localStorage.getItem('mychat_token'), 'renewed');
  await credentials.clearCredentials(); assert.equal(localStorage.getItem('mychat_device_secret'), null);
});
