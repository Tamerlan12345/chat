// Исходящая почта (SMTP). Пока не вызывается ни одной функцией сервера, кроме
// стартового предупреждения: на неё опирается будущая регистрация по коду.
//
// Принципы:
//  - Не настроено (пусто SMTP_HOST или SMTP_FROM) — sendMail() отклоняется
//    ошибкой EMAIL_NOT_CONFIGURED. Никакого «успеха понарошку» и никакого
//    вывода кодов в журнал вместо отправки.
//  - Проверка TLS-сертификата включена всегда, флага для её отключения нет.
//    Без неявного TLS (порт 465) STARTTLS обязателен: без него соединение
//    не продолжается, пароль открытым текстом не уходит.
//  - В журнал не попадают пароль SMTP, тело письма и коды; получатель — только
//    в маске (a***@domain).
const nodemailer = require('nodemailer');
const defaultConfig = require('../config');

class MailerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailerError';
    this.code = code;
  }
}

const EMAIL_NOT_CONFIGURED = 'EMAIL_NOT_CONFIGURED';
const EMAIL_INVALID_ADDRESS = 'EMAIL_INVALID_ADDRESS';
const EMAIL_SEND_FAILED = 'EMAIL_SEND_FAILED';
const NOT_CONFIGURED_MESSAGE = 'Отправка почты не настроена';

// Простая строгая проверка адреса: ASCII, без пробелов, кавычек, запятых и
// управляющих символов (а значит, и без CR/LF), ровно одна «@».
const ADDRESS_RE = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function isValidAddress(value) {
  return typeof value === 'string' && value.length <= 254 && ADDRESS_RE.test(value);
}

// Маска для журнала: a***@domain. Невалидное значение не раскрывается вовсе.
function maskAddress(value) {
  if (typeof value !== 'string') return '***';
  const at = value.lastIndexOf('@');
  if (at < 1) return '***';
  const domain = value.slice(at + 1).replace(/[^\w.-]/g, '');
  return `${value[0].replace(/[^\w]/, '*')}***@${domain || '***'}`;
}

function stripLineBreaks(value) {
  return String(value ?? '').replace(/[\r\n\u2028\u2029\0]+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Письмо с кодом подтверждения. Только строит содержимое — ничего не отправляет.
function buildVerificationEmail({ code, ttlMinutes, appName = 'CentyChat' } = {}) {
  const codeText = String(code ?? '').trim();
  if (!codeText) throw new TypeError('buildVerificationEmail: code обязателен');
  const ttl = Number(ttlMinutes);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new TypeError('buildVerificationEmail: ttlMinutes должен быть целым > 0');
  const app = stripLineBreaks(appName) || 'CentyChat';

  const subject = `${app}: код подтверждения`;
  const text = [
    `Ваш код подтверждения ${app}: ${codeText}`,
    '',
    `Код действует ${ttl} мин. Никому не сообщайте его.`,
    'Если вы не запрашивали код, просто проигнорируйте это письмо.'
  ].join('\n');
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">` +
    `<p>Ваш код подтверждения <b>${escapeHtml(app)}</b>:</p>` +
    `<p style="font-size:28px;letter-spacing:4px;font-weight:bold">${escapeHtml(codeText)}</p>` +
    `<p>Код действует ${ttl} мин. Никому не сообщайте его.</p>` +
    `<p style="color:#666">Если вы не запрашивали код, просто проигнорируйте это письмо.</p>` +
    `</div>`;
  return { subject, text, html };
}

// Фабрика нужна тестам и подмене транспорта; рабочий код пользуется
// экземпляром по умолчанию (экспорт ниже).
function createMailer({ config = defaultConfig, transport = null, logger = console } = {}) {
  let cachedTransport = transport;
  let warned = false;

  const from = () => stripLineBreaks(config.SMTP_FROM);
  const host = () => String(config.SMTP_HOST || '').trim();

  function isConfigured() {
    return Boolean(host() && from());
  }

  // Состояние для будущей админ-проверки; секретов не содержит.
  function getStatus() {
    return {
      configured: isConfigured(),
      host: host() || null,
      port: Number(config.SMTP_PORT) || 587,
      secure: Boolean(config.SMTP_SECURE),
      authConfigured: Boolean(config.SMTP_USER && config.SMTP_PASS)
    };
  }

  // Одно предупреждение при запуске, если почта не настроена.
  function logStartupStatus() {
    if (isConfigured()) {
      logger.log(`[Mailer] SMTP настроен: ${host()}:${Number(config.SMTP_PORT) || 587}`);
    } else if (!warned) {
      warned = true;
      logger.warn('[Mailer] SMTP не настроен: отправка писем отключена');
    }
  }

  function getTransport() {
    if (cachedTransport) return cachedTransport;
    const secure = Boolean(config.SMTP_SECURE);
    const options = {
      host: host(),
      port: Number(config.SMTP_PORT) || 587,
      secure,
      // Без неявного TLS — только STARTTLS; откат к открытому тексту запрещён.
      requireTLS: !secure,
      // Сертификат проверяется (rejectUnauthorized по умолчанию true), отключить нельзя.
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      pool: false
    };
    if (config.SMTP_USER) options.auth = { user: config.SMTP_USER, pass: config.SMTP_PASS || '' };
    cachedTransport = nodemailer.createTransport(options);
    return cachedTransport;
  }

  function requireConfigured() {
    if (!isConfigured()) throw new MailerError(EMAIL_NOT_CONFIGURED, NOT_CONFIGURED_MESSAGE);
  }

  async function sendMail({ to, subject, text, html } = {}) {
    requireConfigured();
    if (typeof to !== 'string' || /[\r\n]/.test(to) || !isValidAddress(to.trim())) {
      throw new MailerError(EMAIL_INVALID_ADDRESS, 'Некорректный адрес получателя');
    }
    const recipient = to.trim();
    if (typeof text !== 'string' && typeof html !== 'string') {
      throw new TypeError('sendMail: нужен text или html');
    }
    const message = {
      from: from(),
      to: recipient,
      subject: stripLineBreaks(subject)
    };
    const replyTo = stripLineBreaks(config.SMTP_REPLY_TO);
    if (replyTo) message.replyTo = replyTo;
    if (typeof text === 'string') message.text = text;
    if (typeof html === 'string') message.html = html;

    try {
      const info = await getTransport().sendMail(message);
      return { messageId: info && info.messageId ? String(info.messageId) : null };
    } catch (err) {
      // Текст ошибки SMTP может содержать адрес или фрагменты диалога — в журнал
      // уходят только коды и маска получателя.
      logger.warn(
        `[Mailer] отправка не удалась (получатель ${maskAddress(recipient)}): ` +
          `${err && err.code ? err.code : 'ERROR'}${err && err.responseCode ? ` ${err.responseCode}` : ''}`
      );
      throw new MailerError(EMAIL_SEND_FAILED, 'Не удалось отправить письмо');
    }
  }

  // Проверка связи с сервером. Сама ничего не запускает; вызывать вручную.
  async function verify() {
    requireConfigured();
    try {
      await getTransport().verify();
      return { ok: true };
    } catch (err) {
      logger.warn(`[Mailer] проверка SMTP не удалась: ${err && err.code ? err.code : 'ERROR'}`);
      return { ok: false, code: err && err.code ? String(err.code) : 'ERROR' };
    }
  }

  return { isConfigured, getStatus, logStartupStatus, sendMail, verify };
}

const defaultMailer = createMailer();

module.exports = {
  ...defaultMailer,
  createMailer,
  MailerError,
  EMAIL_NOT_CONFIGURED,
  EMAIL_INVALID_ADDRESS,
  EMAIL_SEND_FAILED,
  NOT_CONFIGURED_MESSAGE,
  isValidAddress,
  maskAddress,
  buildVerificationEmail,
  escapeHtml
};
