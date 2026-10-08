// Seeds a FRESH CentyChat server (through its own REST API) with dev data:
// users alice/bob, one channel, direct + channel messages, one announcement,
// one attachment. Idempotent: if alice can already log in it does nothing.
//
//   node mobile/dev/seed.mjs <baseUrl>     (or SEED_BASE_URL; required, e.g. http://127.0.0.1:2014)
//
// The base URL has no default on the command line: seeding the wrong server
// creates dev users and changes its admin password. Port 2004 (the owner's own
// local server) is refused.
//
// DEV ONLY credentials, documented in mobile/dev/README.md.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const CREDENTIALS = {
  // First-boot password of the built-in admin (INITIAL_ADMIN_PASSWORD in dev.env).
  adminInitial: 'DevStand-Boot-4817',
  admin: { username: 'admin', password: 'DevStand-Admin-7392' },
  alice: { username: 'alice', password: 'Alice-Dev-Stand-5271', full_name: 'Алиса Тестова' },
  bob: { username: 'bob', password: 'Bob-Dev-Stand-6384', full_name: 'Боб Тестов' }
};

async function call(baseUrl, method, urlPath, { body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(baseUrl + urlPath, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

function must(res, what) {
  if (res.status < 200 || res.status >= 300) throw new Error(`seed: ${what} failed: ${res.status} ${res.text}`);
  return res.json;
}

async function adminLogin(baseUrl) {
  const final = await call(baseUrl, 'POST', '/api/auth/login', { body: CREDENTIALS.admin });
  if (final.status === 200) return final.json.token;
  // Fresh server: log in with the first-boot password and replace it.
  const first = must(await call(baseUrl, 'POST', '/api/auth/login', {
    body: { username: 'admin', password: CREDENTIALS.adminInitial }
  }), 'admin first login');
  must(await call(baseUrl, 'POST', '/api/users/password', {
    token: first.token,
    body: { oldPassword: CREDENTIALS.adminInitial, newPassword: CREDENTIALS.admin.password }
  }), 'admin password change');
  return must(await call(baseUrl, 'POST', '/api/auth/login', { body: CREDENTIALS.admin }), 'admin login').token;
}

// Dev stand: self-registration is on, so the registration screens can be
// reached in development (mail is not configured, so request answers 503
// EMAIL_NOT_CONFIGURED unless SMTP is set up for the stand).
async function enableRegistration(baseUrl, admin) {
  must(await call(baseUrl, 'PUT', '/api/admin/settings', { token: admin, body: { allow_registration: 'true' } }), 'enable registration');
}

export async function seed({ baseUrl } = {}) {
  if (!baseUrl) throw new Error('seed: base URL is required');
  if (new URL(baseUrl).port === '2004') throw new Error('seed: port 2004 is the owner\'s local server; refusing to seed it');
  const result = { alice: CREDENTIALS.alice, bob: CREDENTIALS.bob, alreadySeeded: false };

  const probe = await call(baseUrl, 'POST', '/api/auth/login', { body: CREDENTIALS.alice });
  if (probe.status === 200) {
    await enableRegistration(baseUrl, await adminLogin(baseUrl));
    return { ...result, alreadySeeded: true };
  }

  const admin = await adminLogin(baseUrl);
  await enableRegistration(baseUrl, admin);
  const ids = {};
  for (const u of [CREDENTIALS.alice, CREDENTIALS.bob]) {
    const created = must(await call(baseUrl, 'POST', '/api/admin/users', {
      token: admin,
      body: { username: u.username, full_name: u.full_name, password: u.password, email: `${u.username}@example.test` }
    }), `create ${u.username}`);
    // Dev convenience: mobile login must work straight away, without the
    // "change your password first" step.
    must(await call(baseUrl, 'PUT', `/api/admin/users/${created.id}`, {
      token: admin, body: { must_change_password: false }
    }), `unflag ${u.username}`);
    ids[u.username] = created.id;
  }

  const aliceToken = must(await call(baseUrl, 'POST', '/api/auth/login', { body: CREDENTIALS.alice }), 'alice login').token;
  const bobToken = must(await call(baseUrl, 'POST', '/api/auth/login', { body: CREDENTIALS.bob }), 'bob login').token;

  // Created after the users so that both are members.
  const channel = must(await call(baseUrl, 'POST', '/api/admin/channels', {
    token: admin, body: { name: 'mobile-dev', topic: 'Канал для разработки мобильных клиентов' }
  }), 'create channel');
  const channelId = channel.id ?? channel.channel?.id;

  const send = async (token, kind, id, text, extra = {}) =>
    must(await call(baseUrl, 'POST', `/api/messages/${kind}/${id}`, { token, body: { text, ...extra } }), `message "${text}"`);

  await send(aliceToken, 'direct', ids.bob, 'Привет, Боб! Это тестовое сообщение из dev-стенда.');
  await send(bobToken, 'direct', ids.alice, 'Привет, Алиса! Всё работает.');
  await send(aliceToken, 'direct', ids.bob, 'Отлично, проверяем мобильное приложение.');

  await send(aliceToken, 'channels', channelId, 'Добро пожаловать в #mobile-dev.');
  await send(bobToken, 'channels', channelId, 'Тут будем проверять отправку и получение.');

  const form = new FormData();
  form.append('file', new Blob(['CentyChat dev stand attachment\n'], { type: 'text/plain' }), 'dev-stand-notes.txt');
  const file = must(await call(baseUrl, 'POST', '/api/files/upload', { token: aliceToken, form }), 'upload');
  await send(aliceToken, 'channels', channelId, 'dev-stand-notes.txt', { type: 'file', metadata: { file_id: file.id } });

  must(await call(baseUrl, 'POST', '/api/announcements', {
    token: admin,
    body: { title: 'Тестовое оповещение', content: 'Это объявление создано сидированием dev-стенда.', priority: 'normal' }
  }), 'announcement');

  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseUrl = process.argv[2] || process.env.SEED_BASE_URL;
  if (!baseUrl) {
    console.error('seed: base URL is required: node mobile/dev/seed.mjs http://127.0.0.1:2014 (or SEED_BASE_URL)');
    process.exit(2);
  }
  if (new URL(baseUrl).port === '2004') {
    console.error('seed: port 2004 is the owner\'s local server; refusing to seed it');
    process.exit(2);
  }
  const r = await seed({ baseUrl });
  console.log(r.alreadySeeded
    ? '[seed] already seeded'
    : `[seed] done: alice / ${CREDENTIALS.alice.password}, bob / ${CREDENTIALS.bob.password}`);
}
