const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { freshBoot, closeAll } = require('./helpers/boot');

// Задача 5 плана «безопасность раунд 3»: фильтр типов вложений — закрывает
// серверную часть находки аудита №6. Раньше сервер принимал файл любого типа
// под любым именем и сохранял его как есть.

process.env.INITIAL_ADMIN_PASSWORD = 'парольдлятеста';

let baseUrl;
let server;
let identity;
let UserService;
let AuthService;
let config;
const people = {};

test.before(async () => {
  ({ identity } = await freshBoot());
  UserService = require('../src/services/user.service');
  AuthService = require('../src/services/auth.service');
  config = require('../src/config');
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await UserService.getUserByUsername('admin');
  await UserService.setMustChangePassword(admin.id, false);
  people.admin = { id: admin.id, dept: admin.department_id };

  const scopedRoleId = (await identity.get(`SELECT id FROM roles WHERE name = 'Контурный администратор'`)).id;
  people.scoped = await UserService.createUser({
    username: 'scoped_fp', full_name: 'Контурный Админ', password: 'Рабочий-пароль-1',
    role_id: scopedRoleId, department_id: admin.department_id, admin_scope_dept_id: admin.department_id
  });
  await UserService.setMustChangePassword(people.scoped.id, false);

  for (const [username, full_name] of [
    ['fp_alice', 'Алиса Иванова'],
    ['fp_bob', 'Борис Петров']
  ]) {
    const created = await UserService.createUser({ username, full_name, password: 'Рабочий-пароль-1' });
    await UserService.setMustChangePassword(created.id, false);
    people[username] = created;
  }

  for (const name of Object.keys(people)) {
    people[name].token = AuthService.generateToken(await UserService.getUserById(people[name].id));
  }
});

test.after(async () => {
  server?.close();
  await closeAll();
});

async function api(method, urlPath, { body, token, headers = {}, raw } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function uploadForm(filename, contentBytes) {
  const form = new FormData();
  const content = typeof contentBytes === 'string' ? contentBytes : Buffer.from(contentBytes);
  form.append('file', new Blob([content]), filename);
  return form;
}

async function upload(token, filename, contentBytes) {
  return api('POST', '/api/files/upload', { token, raw: uploadForm(filename, contentBytes) });
}

function incomingDirFiles() {
  const dir = path.join(config.UPLOADS_DIR, '.incoming');
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ── 1. По умолчанию: список известных офисных/медиа-расширений ────────────

test('обычный PDF с верной сигнатурой принимается', async () => {
  const res = await upload(people.fp_alice.token, 'report.pdf', '%PDF-1.4\nдоговор');
  assert.strictEqual(res.status, 201, res.text);
  assert.ok(res.json.id);
});

test('исполняемый файл отклонён — расширение не в списке', async () => {
  const res = await upload(people.fp_alice.token, 'tool.exe', Buffer.from([0x4d, 0x5a, 0, 0, 0, 0]));
  assert.strictEqual(res.status, 415, res.text);
  assert.strictEqual(res.json.code, 'ext-not-allowed');
});

test('картинка с исполняемым содержимым внутри отклонена по сигнатуре', async () => {
  const res = await upload(people.fp_alice.token, 'photo.png', Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0]));
  assert.strictEqual(res.status, 415, res.text);
  assert.strictEqual(res.json.code, 'content-mismatch');
});

test('имя файла с подменой направления письма (U+202E) отклонено', async () => {
  const trickyName = 'a' + '\u202E' + 'fdp.exe'; // отображается как «a exe.pdf»
  const res = await upload(people.fp_alice.token, trickyName, '%PDF-1.4');
  assert.strictEqual(res.status, 415, res.text);
  assert.strictEqual(res.json.code, 'name-invalid');
});

test('имя файла с LRO (U+202D) тоже отклонено — вся группа bidi-control, не только RLO', async () => {
  const trickyName = 'a' + '\u202D' + 'fdp.exe';
  const res = await upload(people.fp_alice.token, trickyName, '%PDF-1.4');
  assert.strictEqual(res.status, 415, res.text);
  assert.strictEqual(res.json.code, 'name-invalid');
});

test('после отказа во временной папке загрузок не остаётся файлов', async () => {
  const before = incomingDirFiles();
  const res = await upload(people.fp_alice.token, 'tool.exe', Buffer.from([0x4d, 0x5a]));
  assert.strictEqual(res.status, 415, res.text);
  const after = incomingDirFiles();
  assert.deepStrictEqual(after, before, 'временный файл должен быть удалён при отказе');
});

// ── 2. Исключения для отдельного сотрудника ────────────────────────────────

test('администратор разрешает .exe только одному сотруднику', async () => {
  const put = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { [String(people.fp_alice.id)]: ['exe'] } }
  });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual(put.json.perUser[String(people.fp_alice.id)], ['exe']);

  const okForAlice = await upload(people.fp_alice.token, 'tool.exe', Buffer.from([0x4d, 0x5a, 0, 0]));
  assert.strictEqual(okForAlice.status, 201, okForAlice.text);

  const rejectedForBob = await upload(people.fp_bob.token, 'tool.exe', Buffer.from([0x4d, 0x5a, 0, 0]));
  assert.strictEqual(rejectedForBob.status, 415, rejectedForBob.text);
  assert.strictEqual(rejectedForBob.json.code, 'ext-not-allowed');
});

test('точка или пробел в конце имени не превращают чужое разрешение в обход фильтра', async () => {
  // У Алисы уже разрешён .exe (предыдущий тест) — но эти имена не должны пройти.
  const trailingDot = await upload(people.fp_alice.token, 'tool.exe.', Buffer.from([0x4d, 0x5a, 0, 0]));
  assert.strictEqual(trailingDot.status, 415, trailingDot.text);
  assert.strictEqual(trailingDot.json.code, 'ext-missing');

  const trailingSpace = await upload(people.fp_alice.token, 'tool.exe ', Buffer.from([0x4d, 0x5a, 0, 0]));
  assert.strictEqual(trailingSpace.status, 415, trailingSpace.text);
  assert.strictEqual(trailingSpace.json.code, 'ext-not-allowed');
});

test('GET /api/files/policy отдаёт личный список только тому, кому он назначен', async () => {
  const forAlice = await api('GET', '/api/files/policy', { token: people.fp_alice.token });
  assert.strictEqual(forAlice.status, 200, forAlice.text);
  assert.ok(forAlice.json.allowed.includes('exe'));

  const forBob = await api('GET', '/api/files/policy', { token: people.fp_bob.token });
  assert.strictEqual(forBob.status, 200, forBob.text);
  assert.ok(!forBob.json.allowed.includes('exe'));
});

// ── 3. Фильтр выключен — сигнатура и имя всё равно проверяются ────────────

test('фильтр расширений выключен: обычный файл проходит, переименованный exe — нет', async () => {
  const off = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { enabled: false, allowed: [...require('../src/services/file-policy.service').DEFAULT_ALLOWED] }
  });
  assert.strictEqual(off.status, 200, off.text);
  assert.strictEqual(off.json.enabled, false);

  const anyExt = await upload(people.fp_bob.token, 'data.bin', 'произвольные данные');
  assert.strictEqual(anyExt.status, 201, anyExt.text);

  const renamedExe = await upload(people.fp_bob.token, 'x.png', Buffer.from([0x4d, 0x5a, 0, 0]));
  assert.strictEqual(renamedExe.status, 415, renamedExe.text);
  assert.strictEqual(renamedExe.json.code, 'content-mismatch');

  // Возвращаем фильтр в исходное состояние для остальных тестов файла.
  const restore = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { enabled: true, perUser: { [String(people.fp_alice.id)]: ['exe'] } }
  });
  assert.strictEqual(restore.status, 200, restore.text);
});

// ── 4. Границы полномочий и проверка черновика ─────────────────────────────

test('общий PUT /api/admin/settings не принимает file_policy', async () => {
  const res = await api('PUT', '/api/admin/settings', {
    token: people.admin.token,
    body: { file_policy: JSON.stringify({ enabled: false, allowed: [] }) }
  });
  assert.strictEqual(res.status, 400, res.text);
});

test('контурный администратор не может менять фильтр файлов', async () => {
  const res = await api('PUT', '/api/admin/file-policy', {
    token: people.scoped.token,
    body: { enabled: false }
  });
  assert.strictEqual(res.status, 403, res.text);

  const getRes = await api('GET', '/api/admin/file-policy', { token: people.scoped.token });
  assert.strictEqual(getRes.status, 403, getRes.text);
});

test('попытка протащить путь через список расширений отклонена', async () => {
  const res = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { allowed: ['../x'] }
  });
  assert.strictEqual(res.status, 400, res.text);
});

// Ревью (задача 5, находка №22): интерфейс всегда шлёт полную карту
// исключений обратно — уволенный/отключённый сотрудник в ней не должен
// ронять КАЖДОЕ следующее сохранение политики, включая правки, не имевшие к
// нему отношения. Устаревший ключ тихо отбрасывается, а не отклоняет запрос;
// формат (нечисловой ключ, недопустимое расширение) по-прежнему отклоняет.

test('исключение для несуществующего сотрудника тихо отбрасывается, а не отклоняет весь запрос', async () => {
  const res = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { '999999': ['exe'] } }
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!('999999' in res.json.perUser), 'ключ несуществующего сотрудника не должен попасть в сохранённую политику');
});

test('деактивированный сотрудник в perUser не мешает следующему сохранению политики', async () => {
  const departing = await UserService.createUser({
    username: 'fp_departing', full_name: 'Уходящий Сотрудник', password: 'Рабочий-пароль-1'
  });
  await UserService.setMustChangePassword(departing.id, false);

  const withException = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { [String(departing.id)]: ['exe'] } }
  });
  assert.strictEqual(withException.status, 200, withException.text);
  assert.deepStrictEqual(withException.json.perUser[String(departing.id)], ['exe']);

  await UserService.toggleUserActive(departing.id, false);

  // Администратор сохраняет политику заново — так, как реально делает
  // интерфейс: полной картой, включая теперь уже устаревший ключ.
  const resave = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { [String(departing.id)]: ['exe'], [String(people.fp_bob.id)]: ['csv'] } }
  });
  assert.strictEqual(resave.status, 200, resave.text, 'сохранение не должно падать из-за устаревшего ключа');
  assert.ok(
    !(String(departing.id) in resave.json.perUser),
    'ключ отключённого сотрудника должен быть тихо отброшен'
  );
  assert.deepStrictEqual(resave.json.perUser[String(people.fp_bob.id)], ['csv']);
});

test('нечисловой ключ или недопустимое расширение в perUser по-прежнему отклоняют весь запрос', async () => {
  const badKey = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { abc: ['exe'] } }
  });
  assert.strictEqual(badKey.status, 400, badKey.text);

  const badExt = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { [String(people.fp_bob.id)]: ['../x'] } }
  });
  assert.strictEqual(badExt.status, 400, badExt.text);
});

// ── 5. Черновик мержится, а не заменяет политику целиком (ревью раунд 1) ──
// Администратор, который отправляет только один из трёх ключей (например,
// «добавить исключение сотруднику»), не должен молча откатывать остальные
// два к их прежним значениям — иначе умышленно суженный общий список или
// действующие исключения терялись бы при любой точечной правке.

test('PUT только с perUser не сбрасывает намеренно суженный allowed', async () => {
  const narrow = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { allowed: ['pdf', 'txt'] }
  });
  assert.strictEqual(narrow.status, 200, narrow.text);
  assert.deepStrictEqual(narrow.json.allowed, ['pdf', 'txt']);

  const onlyPerUser = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { [String(people.fp_bob.id)]: ['csv'] } }
  });
  assert.strictEqual(onlyPerUser.status, 200, onlyPerUser.text);
  assert.deepStrictEqual(
    onlyPerUser.json.allowed,
    ['pdf', 'txt'],
    'allowed не должен откатиться к значению по умолчанию только из-за того, что PUT его не упомянул'
  );
  assert.deepStrictEqual(onlyPerUser.json.perUser[String(people.fp_bob.id)], ['csv']);
});

test('PUT только с allowed не стирает существующие исключения сотрудников', async () => {
  const withException = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { perUser: { [String(people.fp_bob.id)]: ['csv', 'zip'] } }
  });
  assert.strictEqual(withException.status, 200, withException.text);
  assert.deepStrictEqual(withException.json.perUser[String(people.fp_bob.id)], ['csv', 'zip']);

  const onlyAllowed = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { allowed: ['pdf'] }
  });
  assert.strictEqual(onlyAllowed.status, 200, onlyAllowed.text);
  assert.deepStrictEqual(onlyAllowed.json.allowed, ['pdf']);
  assert.deepStrictEqual(
    onlyAllowed.json.perUser[String(people.fp_bob.id)],
    ['csv', 'zip'],
    'исключения сотрудника не должны исчезнуть из-за PUT, который их не упоминал'
  );
});

test('PUT только с enabled сохраняет оба списка нетронутыми', async () => {
  const before = await api('GET', '/api/admin/file-policy', { token: people.admin.token });
  assert.strictEqual(before.status, 200, before.text);

  const toggled = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: { enabled: false }
  });
  assert.strictEqual(toggled.status, 200, toggled.text);
  assert.strictEqual(toggled.json.enabled, false);
  assert.deepStrictEqual(toggled.json.allowed, before.json.allowed);
  assert.deepStrictEqual(toggled.json.perUser, before.json.perUser);

  // Возвращаем как было — на случай, если порядок тестов в файле изменится.
  const restored = await api('PUT', '/api/admin/file-policy', {
    token: people.admin.token,
    body: {
      enabled: true,
      allowed: [...require('../src/services/file-policy.service').DEFAULT_ALLOWED],
      perUser: {}
    }
  });
  assert.strictEqual(restored.status, 200, restored.text);
});
