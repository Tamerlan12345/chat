// Tokens are shared in memory by React and admin consumers. Only an upgraded
// desktop shell can persist credentials securely. Legacy shells retain their
// existing device pairing until upgraded (see docs/desktop-credentials.md).
let token = '';
let deviceId = '';
const bridge = () => globalThis.window?.electronAPI?.credentials;
export const hasSecureCredentials = () => Boolean(bridge());
export const getSessionToken = () => token;
export const getDeviceId = () => deviceId;
export function assertCredentialOrigin(url) {
  if (bridge() && new URL(url).origin !== window.location.origin) {
    throw new Error('Адрес сервера задаётся в настройках приложения.');
  }
}
export async function restoreCredentials() {
  const legacy = { token: localStorage.getItem('mychat_token') || '', deviceId: localStorage.getItem('mychat_device_id') || '',
    deviceSecret: localStorage.getItem('mychat_device_secret') || '', loggedOut: localStorage.getItem('mychat_logged_out') === '1' };
  if (bridge()) {
    legacy.origin = new URL(localStorage.getItem('mychat_server_url') || window.location.origin).origin;
    // Delete plaintext only AFTER atomic encrypted persistence acknowledges it.
    const restored = await bridge().restore(legacy);
    token = restored.token || '';
    deviceId = restored.deviceId;
    for (const key of ['mychat_token', 'mychat_device_secret', 'mychat_device_id']) localStorage.removeItem(key);
    if (restored.loggedOut) localStorage.setItem('mychat_logged_out', '1');
    else localStorage.removeItem('mychat_logged_out');
  } else {
    token = legacy.token;
    deviceId = legacy.deviceId;
  }
  return token;
}
export async function saveSessionToken(next) {
  if (bridge()) await bridge().saveToken(next);
  else localStorage.setItem('mychat_token', next);
  token = next;
}
export async function clearCredentials() {
  token = '';
  if (bridge()) await bridge().clear();
  localStorage.removeItem('mychat_token');
  localStorage.removeItem('mychat_device_secret');
  localStorage.setItem('mychat_logged_out', '1');
}
function legacyIdentity() {
  const random = (bytes) => {
    const buf = new Uint8Array(bytes); crypto.getRandomValues(buf);
    return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  deviceId = localStorage.getItem('mychat_device_id') || `dev-${random(12)}`;
  const deviceSecret = localStorage.getItem('mychat_device_secret') || random(32);
  localStorage.setItem('mychat_device_id', deviceId);
  localStorage.setItem('mychat_device_secret', deviceSecret);
  return { device_id: deviceId, device_secret: deviceSecret };
}
export async function knockDevice(serverUrl, info) {
  assertCredentialOrigin(serverUrl);
  if (bridge()) {
    const result = await bridge().knock(info);
    return { ok: result.ok, json: async () => result.data };
  }
  return fetch(`${serverUrl}/api/auth/knock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...legacyIdentity(), ...info }) });
}
export async function claimDevice(serverUrl, authToken) {
  assertCredentialOrigin(serverUrl);
  if (bridge()) return bridge().claim();
  return fetch(`${serverUrl}/api/auth/device/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, body: JSON.stringify(legacyIdentity()) });
}
