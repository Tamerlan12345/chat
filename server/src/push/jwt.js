const crypto = require('node:crypto');

// Подпись JWT для поставщиков push-уведомлений без сторонних библиотек:
//   RS256 — Google OAuth2 (сервисный аккаунт Firebase, обмен на токен доступа);
//   ES256 — токен поставщика APNs (ключ .p8 Apple).
// ECDSA в JWS — «сырые» r||s по 32 байта (RFC 7518 §3.4), а не DER, который
// node:crypto выдаёт по умолчанию: отсюда dsaEncoding 'ieee-p1363'.

const SIGNERS = {
  RS256: (input, key) => crypto.sign('sha256', input, key),
  ES256: (input, key) => crypto.sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' })
};

const segment = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** Подпись готового «header.payload» (base64url) — для проверки по векторам RFC 7515. */
function signCompact(signingInput, key, alg) {
  const signer = SIGNERS[alg];
  if (!signer) throw new Error(`Неподдерживаемый алгоритм подписи: ${alg}`);
  const signature = signer(Buffer.from(signingInput, 'ascii'), key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** JWT компактной сериализации: заголовок {alg, ...header}, полезная нагрузка payload. */
function signJwt({ alg, header = {}, payload, key }) {
  return signCompact(`${segment({ alg, ...header })}.${segment(payload)}`, key, alg);
}

module.exports = { signJwt, signCompact };
