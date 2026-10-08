const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCredentialVault, registerCredentialHandlers } = require('../src/main/credentials');
const { isTrustedFrame } = require('../src/main/security');
const origin = 'https://chat.example';
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'centy-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptString(value) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); }
  };
  const calls = [];
  const options = { directory, origin, safeStorage, fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ status: 'paired', token: 'issued-token', user: { id: 1 }, device_secret: 'never-return-this' }) }; }, ...overrides };
  return { options, calls, directory, vault: createCredentialVault(options) };
}
test('migration persists encrypted data atomically, restores token, never exports secret', async (t) => {
  const { vault, options, directory } = fixture(t);
  const restored = await vault.invoke('restore', { token: 'legacy-token', deviceId: 'legacy-id', deviceSecret: 'legacy-secret' });
  assert.deepEqual(restored, { token: 'legacy-token', deviceId: 'legacy-id', loggedOut: false, origin });
  const files = fs.readdirSync(directory); assert.equal(files.length, 1); assert.ok(files[0].endsWith('.bin'));
  const bytes = fs.readFileSync(path.join(directory, files[0]));
  for (const secret of ['legacy-token', 'legacy-secret', 'legacy-id']) assert.equal(bytes.includes(Buffer.from(secret)), false);
  const reopened = createCredentialVault(options);
  assert.deepEqual(await reopened.invoke('restore', { token: 'stale', deviceId: 'stale' }), restored);
});
test('claim and knock use stored identity, fixed origin and reject redirects', async (t) => {
  const { vault, calls } = fixture(t);
  await vault.invoke('restore', { token: 'session', deviceId: 'id', deviceSecret: 'secret' });
  await vault.invoke('claim', { url: 'https://evil.example', device_secret: 'attacker' });
  assert.equal(calls[0].url, `${origin}/api/auth/device/claim`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer session');
  assert.deepEqual(JSON.parse(calls[0].init.body), { device_id: 'id', device_secret: 'secret' });
  assert.equal(calls[0].init.redirect, 'error');
  const result = await vault.invoke('knock', { url: 'https://evil.example', device_name: 'PC' });
  assert.equal(calls[1].url, `${origin}/api/auth/knock`);
  assert.equal(result.data.device_secret, undefined);
  assert.equal((await vault.invoke('restore')).token, 'issued-token');
});
test('logout survives restart and suppresses silent login, fresh login can claim again', async (t) => {
  const { vault, calls, options } = fixture(t);
  await vault.invoke('restore', { token: 'session', deviceSecret: 'old-secret' });
  await vault.invoke('clear');
  const restarted = createCredentialVault(options);
  assert.equal((await restarted.invoke('restore', { token: 'stale' })).token, '');
  assert.equal((await restarted.invoke('knock')).ok, false); assert.equal(calls.length, 0);
  await restarted.invoke('save-token', { token: 'new-session' });
  await restarted.invoke('claim');
  assert.notEqual(JSON.parse(calls[0].init.body).device_secret, 'old-secret');
});
test('OS storage unavailable or plaintext backend fails closed without file or request', async (t) => {
  for (const safeStorage of [{ isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }]) {
    const { vault, directory, calls } = fixture(t, { safeStorage });
    await assert.rejects(vault.invoke('restore', { token: 'legacy' }));
    await assert.rejects(vault.invoke('knock'));
    assert.deepEqual(fs.readdirSync(directory), []); assert.equal(calls.length, 0);
  }
});
test('corrupt vault does not regenerate identity or overwrite retained ciphertext', async (t) => {
  const { vault, directory, options } = fixture(t);
  await vault.invoke('restore');
  const file = path.join(directory, fs.readdirSync(directory)[0]); fs.writeFileSync(file, 'damaged');
  await assert.rejects(createCredentialVault(options).invoke('restore', { token: 'legacy' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
});
test('different configured origins never restore each other credentials', async (t) => {
  const { vault, options } = fixture(t);
  await vault.invoke('restore', { token: 'origin-a' });
  assert.equal((await createCredentialVault({ ...options, origin: 'https://other.example' }).invoke('restore')).token, '');
});
test('every IPC action checks sender origin, top frame and main window before vault access', async () => {
  const handlers = {}; let accessed = 0; const main = {};
  registerCredentialHandlers({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    isAllowed: (event) => event.sender === main && isTrustedFrame(event.senderFrame, origin),
    vault: { invoke: () => { accessed++; return true; } } });
  for (const handler of Object.values(handlers)) {
    for (const event of [{ sender: main, senderFrame: { url: 'https://evil.example', parent: null } }, { sender: main, senderFrame: { url: origin, parent: {} } }, { sender: {}, senderFrame: { url: origin, parent: null } }, {}]) {
      assert.throws(() => handler(event));
    }
    assert.equal(handler({ sender: main, senderFrame: { url: origin, parent: null } }), true);
  }
  assert.equal(accessed, 5);
});
test('queued claim completes before logout and cannot restore a cleared session', async (t) => {
  let finish;
  const { vault } = fixture(t, { fetchImpl: () => new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, json: async () => ({}) }); }) });
  await vault.invoke('restore', { token: 'token' });
  const claiming = vault.invoke('claim'); await new Promise(resolve => setImmediate(resolve));
  const clearing = vault.invoke('clear'); finish(); await Promise.all([claiming, clearing]);
  const restored = await vault.invoke('restore'); assert.equal(restored.token, ''); assert.equal(restored.loggedOut, true);
});
test('failed persistence keeps prior committed credentials and removes temporary files', async (t) => {
  const { vault, options, directory } = fixture(t);
  await vault.invoke('restore', { token: 'original' });
  const encrypt = options.safeStorage.encryptString;
  options.safeStorage.encryptString = () => { throw Error('encryption failed'); };
  await assert.rejects(vault.invoke('save-token', { token: 'replacement' }));
  options.safeStorage.encryptString = encrypt;
  assert.equal((await createCredentialVault(options).invoke('restore')).token, 'original');
  assert.equal(fs.readdirSync(directory).length, 1);
});
test('logout can forget ciphertext even when OS key storage becomes unavailable', async (t) => {
  const { vault, options, directory } = fixture(t);
  await vault.invoke('restore', { token: 'session' });
  options.safeStorage.isEncryptionAvailable = () => false;
  await vault.invoke('clear');
  assert.deepEqual(fs.readdirSync(directory), []);
  await assert.rejects(vault.invoke('restore'));
});
test('legacy credentials labelled for another origin cannot be imported', async (t) => {
  const { vault, directory } = fixture(t);
  await assert.rejects(vault.invoke('restore', { origin: 'https://other.example', token: 'legacy' }));
  assert.deepEqual(fs.readdirSync(directory), []);
});
