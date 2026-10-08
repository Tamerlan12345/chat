const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// One vault per configured origin. No caller-controlled URL or filename.
function createCredentialVault({ directory, origin, safeStorage, fetchImpl = fetch }) {
  if (!origin || new URL(origin).origin !== origin) throw new Error('Invalid credential origin');
  const file = path.join(directory, `credentials-${crypto.createHash('sha256').update(origin).digest('hex')}.bin`);
  let state;
  let queue = Promise.resolve();
  function secure() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Защищённое хранилище недоступно. Проверьте хранилище ключей ОС.');
    }
  }
  function read() {
    secure();
    if (state) return state;
    try {
      const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      if (parsed.origin !== origin || parsed.version !== 1) throw new Error('Invalid credential vault');
      return (state = parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Не удалось открыть защищённое хранилище.');
      return null;
    }
  }
  function write(next) {
    secure();
    fs.mkdirSync(directory, { recursive: true });
    const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, safeStorage.encryptString(JSON.stringify(next)));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      state = next;
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  const text = (value, max) => typeof value === 'string' && value.length <= max ? value : '';
  function ensure() {
    let current = read();
    if (!current) {
      current = { version: 1, origin, token: '', deviceId: `dev-${crypto.randomBytes(12).toString('base64url')}`, deviceSecret: crypto.randomBytes(32).toString('base64url'), loggedOut: false };
      write(current);
    }
    return current;
  }
  async function request(endpoint, body, token) {
    const response = await fetchImpl(`${origin}/api/auth/${endpoint}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    // Do not forward arbitrary server properties (including an echoed secret).
    return { ok: response.ok, status: response.status, data: { status: data.status, token: text(data.token, 16384), user: data.user } };
  }
  async function perform(action, input = {}) {
    if (action === 'restore') {
      let current = read();
      if (!current) {
        const legacy = input || {};
        if (legacy.origin && legacy.origin !== origin) throw new Error('Сохранённые данные относятся к другому серверу.');
        current = { version: 1, origin, token: text(legacy.token, 16384),
          deviceId: text(legacy.deviceId, 256) || `dev-${crypto.randomBytes(12).toString('base64url')}`,
          deviceSecret: text(legacy.deviceSecret, 256) || crypto.randomBytes(32).toString('base64url'), loggedOut: legacy.loggedOut === true };
        if (current.loggedOut) { current.token = ''; current.deviceSecret = ''; }
        write(current);
      }
      return { token: current.token, deviceId: current.deviceId, loggedOut: current.loggedOut, origin };
    }
    if (action === 'clear') {
      // Deleting credentials must remain possible if the OS key store becomes
      // unavailable or ciphertext is damaged. Never decrypt just to forget.
      let current;
      try { current = read(); } catch {}
      if (current) {
        try { write({ ...current, token: '', deviceSecret: '', loggedOut: true }); return true; } catch {}
      }
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      state = undefined;
      return true;
    }
    const current = ensure();
    if (action === 'save-token') {
      const token = text(input.token, 16384);
      if (!token) throw new Error('Invalid session token');
      write({ ...current, token, loggedOut: false });
      return true;
    }
    if (action === 'claim') {
      if (!current.token) throw new Error('No session');
      const deviceSecret = current.deviceSecret || crypto.randomBytes(32).toString('base64url');
      write({ ...current, deviceSecret });
      const result = await request('device/claim', { device_id: current.deviceId, device_secret: deviceSecret }, current.token);
      return { ok: result.ok, status: result.status };
    }
    if (action === 'knock') {
      if (current.loggedOut || !current.deviceSecret) return { ok: false, data: {} };
      const result = await request('knock', { device_id: current.deviceId, device_secret: current.deviceSecret,
        device_name: text(input.device_name, 256), platform: text(input.platform, 256), client_version: text(input.client_version, 64) });
      if (result.ok && result.data.status === 'paired' && result.data.token) write({ ...current, token: result.data.token });
      return result;
    }
    throw new Error('Unknown credential operation');
  }
  return { invoke(action, input) {
    const pending = queue.then(() => perform(action, input));
    queue = pending.catch(() => {});
    return pending;
  } };
}

function registerCredentialHandlers({ ipcMain, isAllowed, vault }) {
  for (const action of ['restore', 'save-token', 'clear', 'claim', 'knock']) {
    ipcMain.handle(`credentials-${action}`, (event, input) => {
      if (!isAllowed(event)) throw new Error('Credential IPC denied');
      return vault.invoke(action, input);
    });
  }
}
module.exports = { createCredentialVault, registerCredentialHandlers };
