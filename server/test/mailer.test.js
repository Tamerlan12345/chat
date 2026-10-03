const test = require('node:test');
const assert = require('node:assert');
const nodemailer = require('nodemailer');
const {
  createMailer, MailerError, EMAIL_NOT_CONFIGURED, EMAIL_INVALID_ADDRESS,
  maskAddress, isValidAddress, buildVerificationEmail
} = require('../src/services/mailer.service');

const PASSWORD = 'SuperSecretSmtpPass-123';
const FULL = {
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: 587, SMTP_SECURE: false,
  SMTP_USER: 'user', SMTP_PASS: PASSWORD, SMTP_FROM: 'CentyChat <no-reply@example.com>', SMTP_REPLY_TO: ''
};

function capture() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { logger: { log: push, warn: push, error: push }, lines };
}

// Транспорт без сети: nodemailer собирает письмо в JSON и ничего не отправляет.
function jsonTransport() {
  const t = nodemailer.createTransport({ jsonTransport: true });
  const sent = [];
  const orig = t.sendMail.bind(t);
  t.sendMail = async (m) => { const r = await orig(m); sent.push(JSON.parse(r.message)); return r; };
  return { transport: t, sent };
}

test('не настроено: isConfigured=false, sendMail отклоняется EMAIL_NOT_CONFIGURED, одно предупреждение', async () => {
  const { logger, lines } = capture();
  const m = createMailer({ config: { ...FULL, SMTP_HOST: '' }, logger });
  assert.strictEqual(m.isConfigured(), false);
  m.logStartupStatus(); m.logStartupStatus();
  assert.deepStrictEqual(lines, ['[Mailer] SMTP не настроен: отправка писем отключена']);
  await assert.rejects(m.sendMail({ to: 'a@example.com', subject: 's', text: 't' }),
    (e) => e instanceof MailerError && e.code === EMAIL_NOT_CONFIGURED);
  await assert.rejects(m.verify(), (e) => e.code === EMAIL_NOT_CONFIGURED);
  const noFrom = createMailer({ config: { ...FULL, SMTP_FROM: '' }, logger });
  assert.strictEqual(noFrom.isConfigured(), false);
});

test('настроено: отправляет через транспорт, статус без секретов', async () => {
  const { logger, lines } = capture();
  const { transport, sent } = jsonTransport();
  const m = createMailer({ config: { ...FULL, SMTP_REPLY_TO: 'help@example.com' }, transport, logger });
  assert.strictEqual(m.isConfigured(), true);
  await m.sendMail({ to: 'user@example.com', subject: 'Тема', text: 'тело', html: '<b>тело</b>' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to[0].address, 'user@example.com');
  assert.strictEqual(sent[0].replyTo[0].address, 'help@example.com');
  const status = m.getStatus();
  assert.strictEqual(status.configured, true);
  assert.strictEqual(status.host, 'smtp.example.com');
  assert.ok(!JSON.stringify(status).includes(PASSWORD));
  assert.ok(!lines.join('\n').includes(PASSWORD));
});

test('инъекция заголовков: адрес с CR/LF отклоняется, тема очищается', async () => {
  const { transport, sent } = jsonTransport();
  const m = createMailer({ config: FULL, transport, logger: capture().logger });
  for (const bad of ['a@example.com\r\nBcc: x@evil.com', 'a@example.com\nBcc: x@evil.com', 'a@b.com, c@d.com', 'без-собаки', '', null]) {
    await assert.rejects(m.sendMail({ to: bad, subject: 's', text: 't' }),
      (e) => e.code === EMAIL_INVALID_ADDRESS, String(bad));
  }
  assert.strictEqual(sent.length, 0);
  await m.sendMail({ to: 'a@example.com', subject: 'Тема\r\nBcc: x@evil.com', text: 't' });
  assert.ok(!/[\r\n]/.test(sent[0].subject));
  assert.strictEqual(sent[0].bcc, undefined);
});

test('маска получателя и проверка адреса', () => {
  assert.strictEqual(maskAddress('alice@example.com'), 'a***@example.com');
  assert.strictEqual(maskAddress('мусор'), '***');
  assert.ok(isValidAddress('a.b+c@sub.example.com'));
  assert.ok(!isValidAddress('a@b'));
  assert.ok(!isValidAddress('a b@example.com'));
});

test('сбой транспорта: в журнале нет пароля, тела и полного адреса', async () => {
  const { logger, lines } = capture();
  const transport = {
    sendMail: async () => { const e = new Error(`550 alice@example.com rejected, pass ${PASSWORD}`); e.code = 'EENVELOPE'; e.responseCode = 550; throw e; }
  };
  const m = createMailer({ config: FULL, transport, logger });
  await assert.rejects(m.sendMail({ to: 'alice@example.com', subject: 's', text: 'КОД 482913' }),
    (e) => e.code === 'EMAIL_SEND_FAILED' && !e.message.includes(PASSWORD));
  const log = lines.join('\n');
  assert.ok(log.includes('a***@example.com'));
  assert.ok(!log.includes(PASSWORD));
  assert.ok(!log.includes('482913'));
  assert.ok(!log.includes('alice@example.com'));
});

test('настройки транспорта: STARTTLS обязателен, проверка сертификата не отключена', async () => {
  const orig = nodemailer.createTransport;
  let opts;
  nodemailer.createTransport = (o) => { opts = o; return { sendMail: async () => ({}) }; };
  try {
    await createMailer({ config: FULL, logger: capture().logger }).sendMail({ to: 'a@example.com', subject: 's', text: 't' });
    assert.strictEqual(opts.requireTLS, true);
    assert.strictEqual(opts.secure, false);
    assert.strictEqual(opts.pool, false);
    assert.notStrictEqual(opts.tls.rejectUnauthorized, false);
    await createMailer({ config: { ...FULL, SMTP_PORT: 465, SMTP_SECURE: true }, logger: capture().logger })
      .sendMail({ to: 'a@example.com', subject: 's', text: 't' });
    assert.strictEqual(opts.secure, true);
    assert.strictEqual(opts.requireTLS, false);
  } finally {
    nodemailer.createTransport = orig;
  }
});

test('шаблон кода: экранирование HTML и параметры', () => {
  const mail = buildVerificationEmail({ code: '<script>alert(1)</script>', ttlMinutes: 10, appName: 'Centy<Chat>\r\n' });
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('&lt;script&gt;'));
  assert.ok(mail.html.includes('Centy&lt;Chat&gt;'));
  assert.ok(!/[\r\n]/.test(mail.subject));
  assert.ok(mail.text.includes('10 мин'));
  const ok = buildVerificationEmail({ code: '123456', ttlMinutes: 15 });
  assert.ok(ok.text.includes('123456') && ok.html.includes('123456'));
  assert.throws(() => buildVerificationEmail({ code: '', ttlMinutes: 10 }));
  assert.throws(() => buildVerificationEmail({ code: '1', ttlMinutes: 0 }));
});
