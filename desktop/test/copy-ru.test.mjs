import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', ...p), 'utf8');
const contractCopy = JSON.parse(fs.readFileSync(
  path.resolve(here, '../../mobile/contracts/copy/ru.json'),
  'utf8'
));
const desktopCopyKeys = [
  'signout.title', 'signout.body', 'signout.confirm', 'reg.disabled',
  'login.pending.title', 'login.pending.body', 'login.rejected.title', 'login.rejected.body',
  'login.busy_retrying', 'login.invalid', 'login.offline',
  'conn.offline', 'conn.reconnecting', 'conn.online',
  'upload.too_big', 'upload.empty', 'upload.no_extension', 'upload.refused',
  'download.forbidden', 'download.failed', 'download.no_network', 'delivery.DM_NOT_ALLOWED'
];

test('COPY совпадает с mobile/contracts/copy/ru.json дословно', async () => {
  const { COPY } = await import('../src/renderer/src/lib/copy-ru.mjs');
  for (const key of desktopCopyKeys) {
    assert.equal(typeof contractCopy[key], 'string', `canonical contract key ${key} must be a string`);
    assert.strictEqual(COPY[key], contractCopy[key], key);
  }
});

test('describeAuthFailure: код сервера важнее короткого текста — заявка, отказ, регистрация закрыта', async () => {
  const { describeAuthFailure } = await import('../src/renderer/src/lib/copy-ru.mjs');
  assert.strictEqual(describeAuthFailure(403, { code: 'ACCOUNT_PENDING', error: 'Заявка на рассмотрении' }, 'x'), contractCopy['login.pending.body']);
  assert.strictEqual(describeAuthFailure(403, { code: 'ACCOUNT_REJECTED', error: 'Заявка отклонена' }, 'x'), contractCopy['login.rejected.body']);
  assert.strictEqual(describeAuthFailure(403, { code: 'REGISTRATION_DISABLED', error: 'что угодно' }, 'x'), contractCopy['reg.disabled']);
});

test('describeAuthFailure: прочее — текст сервера, без него — понятная замена', async () => {
  const { describeAuthFailure } = await import('../src/renderer/src/lib/copy-ru.mjs');
  assert.strictEqual(describeAuthFailure(401, { error: contractCopy['login.invalid'] }, 'x'), contractCopy['login.invalid']);
  assert.strictEqual(describeAuthFailure(403, {}, 'x'), 'Доступ с этого адреса запрещён — обратитесь к администратору');
  assert.strictEqual(describeAuthFailure(404, null, 'x'), 'По этому адресу сервер CentyChat не отвечает');
  assert.strictEqual(describeAuthFailure(429, {}, 'x'), 'Слишком много попыток — повторите через минуту');
  assert.strictEqual(describeAuthFailure(503, {}, 'x'), 'Сервер временно недоступен — повторите через минуту');
  assert.strictEqual(describeAuthFailure(400, {}, 'Не удалось войти'), 'Не удалось войти');
});

test('connectionLabel: связь есть — «Подключено»; сети нет — «Нет сети»; сеть есть, сокета нет — «Переподключение…»', async () => {
  const { connectionLabel } = await import('../src/renderer/src/lib/copy-ru.mjs');
  assert.strictEqual(connectionLabel({ connected: true, networkOnline: true }), contractCopy['conn.online']);
  assert.strictEqual(connectionLabel({ connected: false, networkOnline: false }), contractCopy['conn.offline']);
  assert.strictEqual(connectionLabel({ connected: false, networkOnline: true }), contractCopy['conn.reconnecting']);
});

test('экраны берут тексты из COPY: выход, вход, строка состояния, вложения', () => {
  const app = read('App.jsx');
  assert.match(app, /title: COPY\['signout\.title'\]/);
  assert.match(app, /message: COPY\['signout\.body'\]/);
  assert.match(app, /connectionLabel\(\{ connected: wsConnected, networkOnline \}\)/);
  assert.match(app, /COPY\['upload\.too_big'\]/);
  assert.ok(!/отправить нельзя/.test(app), 'сервер говорит «загрузить нельзя»');
  const login = read('components', 'LoginView.jsx');
  assert.match(login, /describeAuthFailure\(/);
  assert.match(login, /COPY\['login\.busy_retrying'\]/);
  assert.ok(!/проверьте сеть и повторите/.test(login));
  const chat = read('components', 'ChatView.jsx');
  assert.match(chat, /COPY\['download\.forbidden'\]/);
  assert.match(chat, /onNotice\?\.\(COPY\['download\.no_network'\], suggestedName\)/);
});

test('правило L: на экране входа только знак CentyChat — ни строки компании, ни слогана', () => {
  const login = read('components', 'LoginView.jsx');
  assert.ok(!/Корпоративный мессенджер/.test(login), 'слогана нет');
  assert.ok(!/login-brand-lead/.test(login));
  assert.ok(!/company_name/.test(login), 'строки компании нет');
});

test('проверки вложений до загрузки говорят теми же словами, что сервер и телефоны', async () => {
  const { uploadProblem, MAX_UPLOAD_BYTES } = await import('../src/renderer/src/lib/attachments.mjs');
  const { checkFileAgainstPolicy } = await import('../src/renderer/src/lib/file-policy.mjs');
  assert.strictEqual(uploadProblem({ size: MAX_UPLOAD_BYTES + 1 }), contractCopy['upload.too_big']);
  assert.strictEqual(uploadProblem({ size: 0 }), contractCopy['upload.empty']);
  assert.strictEqual(checkFileAgainstPolicy({ name: 'README' }, { enabled: true, allowed: ['pdf'] }), contractCopy['upload.no_extension']);
  assert.strictEqual(checkFileAgainstPolicy({ name: 'a‮fdp.exe' }, { enabled: true, allowed: ['pdf'] }), 'Имя файла содержит недопустимые символы');
});
