import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Общие русские тексты трёх клиентов (copy-ru-proposal.md, Task 11 → в
// контракте mobile/contracts/copy-ru.md). Здесь — ключи, чьи состояния есть
// на компьютере; тексты сверены дословно с канонической таблицей.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'src', ...p), 'utf8');

const CANON = {
  'signout.title': 'Выйти из учётной записи?',
  'signout.body': 'Чтобы снова войти на этом устройстве, понадобятся логин и пароль.',
  'signout.confirm': 'Выйти',
  'reg.disabled': 'Регистрация сейчас закрыта. Обратитесь к администратору.',
  'login.pending.title': 'Заявка на рассмотрении',
  'login.pending.body': 'Заявка на регистрацию ещё рассматривается администратором. Вход откроется после одобрения.',
  'login.rejected.title': 'Заявка отклонена',
  'login.rejected.body': 'Заявка на регистрацию отклонена администратором. Обратитесь к администратору вашей компании.',
  'login.busy_retrying': 'Сервер занят. Повторяем вход…',
  'login.invalid': 'Неверный логин или пароль',
  'login.offline': 'Нет связи с сервером. Проверьте подключение к интернету.',
  'conn.offline': 'Нет сети',
  'conn.reconnecting': 'Переподключение…',
  'conn.online': 'Подключено',
  'upload.too_big': 'Файл больше 100 МБ — такой файл загрузить нельзя',
  'upload.empty': 'Файл пустой',
  'upload.no_extension': 'У файла нет расширения',
  'upload.refused': 'Сервер не принял файл',
  'download.forbidden': 'Нет доступа к файлу',
  'download.failed': 'Не удалось скачать файл',
  'delivery.DM_NOT_ALLOWED': 'Сообщение не может быть доставлено'
};

test('COPY совпадает с канонической таблицей дословно', async () => {
  const { COPY } = await import('../src/renderer/src/lib/copy-ru.mjs');
  for (const [key, text] of Object.entries(CANON)) assert.strictEqual(COPY[key], text, key);
});

test('describeAuthFailure: код сервера важнее короткого текста — заявка, отказ, регистрация закрыта', async () => {
  const { describeAuthFailure } = await import('../src/renderer/src/lib/copy-ru.mjs');
  assert.strictEqual(describeAuthFailure(403, { code: 'ACCOUNT_PENDING', error: 'Заявка на рассмотрении' }, 'x'), CANON['login.pending.body']);
  assert.strictEqual(describeAuthFailure(403, { code: 'ACCOUNT_REJECTED', error: 'Заявка отклонена' }, 'x'), CANON['login.rejected.body']);
  assert.strictEqual(describeAuthFailure(403, { code: 'REGISTRATION_DISABLED', error: 'что угодно' }, 'x'), CANON['reg.disabled']);
});

test('describeAuthFailure: прочее — текст сервера, без него — понятная замена', async () => {
  const { describeAuthFailure } = await import('../src/renderer/src/lib/copy-ru.mjs');
  assert.strictEqual(describeAuthFailure(401, { error: 'Неверный логин или пароль' }, 'x'), 'Неверный логин или пароль');
  assert.strictEqual(describeAuthFailure(403, {}, 'x'), 'Доступ с этого адреса запрещён — обратитесь к администратору');
  assert.strictEqual(describeAuthFailure(404, null, 'x'), 'По этому адресу сервер CentyChat не отвечает');
  assert.strictEqual(describeAuthFailure(429, {}, 'x'), 'Слишком много попыток — повторите через минуту');
  assert.strictEqual(describeAuthFailure(503, {}, 'x'), 'Сервер временно недоступен — повторите через минуту');
  assert.strictEqual(describeAuthFailure(400, {}, 'Не удалось войти'), 'Не удалось войти');
});

test('connectionLabel: связь есть — «Подключено»; сети нет — «Нет сети»; сеть есть, сокета нет — «Переподключение…»', async () => {
  const { connectionLabel } = await import('../src/renderer/src/lib/copy-ru.mjs');
  assert.strictEqual(connectionLabel({ connected: true, networkOnline: true }), 'Подключено');
  assert.strictEqual(connectionLabel({ connected: false, networkOnline: false }), 'Нет сети');
  assert.strictEqual(connectionLabel({ connected: false, networkOnline: true }), 'Переподключение…');
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
  assert.strictEqual(uploadProblem({ size: MAX_UPLOAD_BYTES + 1 }), CANON['upload.too_big']);
  assert.strictEqual(uploadProblem({ size: 0 }), CANON['upload.empty']);
  assert.strictEqual(checkFileAgainstPolicy({ name: 'README' }, { enabled: true, allowed: ['pdf'] }), CANON['upload.no_extension']);
  assert.strictEqual(checkFileAgainstPolicy({ name: 'a‮fdp.exe' }, { enabled: true, allowed: ['pdf'] }), 'Имя файла содержит недопустимые символы');
});
