const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// Exercise the actual App closures, with only browser/React side effects
// supplied by this harness. This keeps the regression tied to the call order
// in App rather than reproducing that order in a separate helper.
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
function appHandler(name, context) {
  const marker = `  const ${name} = `;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  };', start);
  return vm.runInNewContext(`(${source.slice(start + marker.length, end + 4)})`, context);
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const events = [];
  const context = {
    loggingOutRef: { current: false }, tokenRef: { current: 'previous-session' }, wsRef: { current: { close: () => events.push('close') } },
    authState: 'authenticated', logoutError: '', currentUser: { id: 1 }, token: 'previous-session', serverUrl: 'https://chat.example',
    pwOld: 'old-password', pwNew: 'new-password', pwConfirm: 'new-password',
    setLogoutError: value => { context.logoutError = value; }, setAuthState: value => { context.authState = value; },
    setToken: value => { context.token = value; }, setCurrentUser: value => { context.currentUser = value; },
    setPwOld() {}, setPwNew() {}, setPwConfirm() {}, setPwError() {}, setPwSubmitting() {},
    saveSessionToken: async value => { events.push(`save:${value}`); },
    clearCredentials: async () => { events.push('clear'); },
    initWebSocket: () => events.push('open-socket'), loadBaseData: () => events.push('load-data'),
    sessionStorage: { setItem() {} }, window: { location: { reload: () => events.push('reload') } },
    assertCredentialOrigin() {},
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    BrandMark: 'BrandMark', LoginView: 'LoginView', handleLoginSuccess() {}
  };
  context.forceLogout = appHandler('forceLogout', context);
  const gateStart = source.indexOf('  if (loggingOutRef.current) {\n    return (');
  assert.ok(gateStart >= 0, 'logout render barrier');
  const gateEnd = source.indexOf('  if (currentUser?.must_change_password)', gateStart);
  const gate = source.slice(gateStart, gateEnd);
  const renderCode = transformSync(`globalThis.render = () => { ${gate} return null; };`, { loader: 'jsx' }).code;
  vm.runInNewContext(renderCode, context);
  return { context, events };
}
function containsType(node, type) {
  return Boolean(node && typeof node === 'object' && (node.type === type || node.children?.some(child => containsType(child, type))));
}

test('failed vault replacement/deletion blocks login and stale account rendering until a full reload', async () => {
  const { context, events } = harness();
  context.clearCredentials = async () => { throw Error('write and delete denied'); };
  // The previous account's data deliberately remains in this document.
  context.activeChat = { id: 10 }; context.messages = ['previous account message']; context.activeCall = { peer: 1 };
  await context.forceLogout(null);
  assert.equal(context.loggingOutRef.current, true);
  assert.equal(context.authState, 'logging-out');
  assert.ok(context.logoutError);
  assert.equal(containsType(context.render(), 'LoginView'), false);
  // Even a late bootstrap callback changing authState cannot bypass the barrier.
  context.authState = 'authenticated';
  assert.ok(containsType(context.render(), 'button'), 'retry exit is the only action');
  assert.equal(JSON.stringify(context.render()).includes('previous account message'), false);
  await appHandler('handleLoginSuccess', context)({ id: 2 }, 'next-account', context.serverUrl);
  assert.deepEqual(events, ['close'], 'no new-account persistence or reload on failed cleanup');
  context.clearCredentials = async () => events.push('clear');
  await context.forceLogout(null, true);
  assert.equal(context.loggingOutRef.current, true, 'barrier remains until document teardown');
  assert.deepEqual(events, ['close', 'close', 'clear', 'reload']);
});

test('ordinary password callback arriving after queued clear never enqueues save-token', async () => {
  const { context, events } = harness();
  const clearing = deferred();
  context.clearCredentials = () => { events.push('clear'); return clearing.promise; };
  const loggingOut = context.forceLogout(null);
  await appHandler('handleTokenRenewed', context)('late-password-token');
  assert.deepEqual(events, ['close', 'clear']);
  clearing.resolve(); await loggingOut;
  assert.deepEqual(events, ['close', 'clear', 'reload']);
});

test('forced password response arriving after queued clear never persists or reopens session', async () => {
  const { context, events } = harness();
  const response = deferred(); const clearing = deferred();
  context.fetch = () => response.promise;
  context.clearCredentials = () => { events.push('clear'); return clearing.promise; };
  const passwordChange = appHandler('handleForcedPasswordChange', context)({ preventDefault() {} });
  const loggingOut = context.forceLogout(null);
  response.resolve({ ok: true, json: async () => ({ token: 'late-forced-token' }) });
  await passwordChange;
  assert.deepEqual(events, ['close', 'clear']);
  clearing.resolve(); await loggingOut;
  assert.deepEqual(events, ['close', 'clear', 'reload']);
});

test('password save already enqueued before logout cannot reopen account UI on completion', async () => {
  const { context, events } = harness(); const saving = deferred();
  context.saveSessionToken = () => { events.push('save'); return saving.promise; };
  const renewing = appHandler('handleTokenRenewed', context)('renewed');
  const loggingOut = context.forceLogout(null);
  saving.resolve(); await Promise.all([renewing, loggingOut]);
  assert.deepEqual(events, ['save', 'close', 'clear', 'reload']);
  assert.equal(context.loggingOutRef.current, true);
});
