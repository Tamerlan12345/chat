const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword, CURRENT_PARAMS } = require('../src/db/identity/password');

// Пароли — единственное, что хранится в базе и не должно поддаваться чтению
// даже при полном доступе к ней. Проверяется формат хранения, совместимость с
// прежним и поведение на подпорченных записях.

test('пароль хранится вместе со своими параметрами', async () => {
  const encoded = await hashPassword('какой-то пароль');
  assert.match(encoded, /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(encoded.includes(`N=${CURRENT_PARAMS.N}`), 'параметры записаны рядом с ключом — их можно будет поднять');
});

test('одинаковые пароли дают разные записи', async () => {
  // Общая соль позволила бы одним предрасчётом вскрыть сразу всех, у кого
  // пароль совпал.
  const a = await hashPassword('одинаковый');
  const b = await hashPassword('одинаковый');
  assert.notStrictEqual(a, b);
});

test('верный пароль принимается, неверный — нет', async () => {
  const encoded = await hashPassword('правильный пароль');
  assert.strictEqual((await verifyPassword('правильный пароль', encoded)).ok, true);
  assert.strictEqual((await verifyPassword('неправильный', encoded)).ok, false);
  assert.strictEqual((await verifyPassword('', encoded)).ok, false);
  assert.strictEqual((await verifyPassword(null, encoded)).ok, false);
});

test('запись нового формата не требует пересчёта', async () => {
  const encoded = await hashPassword('свежий пароль');
  const { ok, needsRehash } = await verifyPassword('свежий пароль', encoded);
  assert.strictEqual(ok, true);
  assert.strictEqual(needsRehash, false);
});

test('пароль прежнего формата проверяется и помечается к пересчёту', async () => {
  // Так пароли хранились до разделения баз: hex-ключ и соль отдельной колонкой,
  // параметры scrypt по умолчанию. Без этой ветки после переезда не вошёл бы
  // никто из уже заведённых сотрудников.
  const salt = crypto.randomBytes(16).toString('hex');
  const legacy = crypto.scryptSync('прежний пароль', salt, 64).toString('hex');

  const good = await verifyPassword('прежний пароль', legacy, salt);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.needsRehash, true, 'при следующем входе запись должна обновиться');

  assert.strictEqual((await verifyPassword('другой пароль', legacy, salt)).ok, false);
  assert.strictEqual((await verifyPassword('прежний пароль', legacy, null)).ok, false, 'без соли проверить нечем');
});

test('испорченная запись не пропускает и не роняет', async () => {
  for (const broken of ['', 'scrypt$', 'scrypt$N=x,r=8,p=1$aa$bb', 'scrypt$N=32768$aa$bb', 'не-хэш-вовсе']) {
    const result = await verifyPassword('любой', broken);
    assert.strictEqual(result.ok, false, `запись "${broken}" не должна проходить проверку`);
  }
});

test('неподъёмные параметры в записи отвергаются, а не выполняются', async () => {
  // Иначе строка в базе — готовый способ занять процессор целиком: scrypt
  // честно попытается выделить запрошенную память.
  const absurd = 'scrypt$N=1073741824,r=64,p=64$YWFhYQ==$YmJiYg==';
  const result = await verifyPassword('любой', absurd);
  assert.strictEqual(result.ok, false);
});

test('пустой и чрезмерно длинный пароль не хэшируются', async () => {
  await assert.rejects(() => hashPassword(''), /не может быть пустым/);
  await assert.rejects(() => hashPassword('я'.repeat(2000)), /слишком длинный/);
});

test('кириллица, записанная разными способами, считается одним паролем', async () => {
  // «й» бывает одним символом (U+0439) и парой «и» + знак краткости
  // (U+0438 U+0306). Пароль, вставленный из другого редактора или набранный на
  // другой раскладке, обязан подойти — иначе сотрудник останется снаружи, не
  // понимая почему.
  const composed = `\u043c\u0439\u043f\u0430\u0440\u043e\u043b\u044c`;
  const decomposed = `\u043c\u0438\u0306\u043f\u0430\u0440\u043e\u043b\u044c`;
  assert.notStrictEqual(composed, decomposed, 'строки действительно разные');

  const encoded = await hashPassword(composed);
  assert.strictEqual((await verifyPassword(decomposed, encoded)).ok, true);
});

