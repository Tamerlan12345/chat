// Когда показывать страницу «Нет связи с сервером» и что на ней написать.
//
// Интерфейс загружается с сервера. Раньше при недоступном сервере окно
// оставалось белым навсегда: ни объяснения, ни способа повторить, кроме
// перезапуска приложения из трея.

const { isSameOrigin } = require('./security');

// Сервер после перезапуска поднимается за десятки секунд — проверять чаще
// незачем, реже — человек успевает решить, что приложение сломалось.
const HEALTH_RETRY_MS = 7000;
const HEALTH_TIMEOUT_MS = 5000;

// ERR_ABORTED приходит, когда одна загрузка сменяет другую (перезагрузка,
// переход по адресу), — это не сбой связи.
const ERR_ABORTED = -3;

function shouldShowOfflineForFailure({ errorCode, isMainFrame, url, serverOrigin } = {}) {
  if (!isMainFrame) return false;
  if (typeof errorCode !== 'number' || errorCode >= 0 || errorCode === ERR_ABORTED) return false;
  return isSameOrigin(url, serverOrigin);
}

function shouldShowOfflineForStatus({ url, httpResponseCode, serverOrigin } = {}) {
  return Number.isInteger(httpResponseCode) &&
    httpResponseCode >= 500 && httpResponseCode <= 599 &&
    isSameOrigin(url, serverOrigin);
}

function describeLoadFailure(code, description) {
  const tech = `${description || 'ошибка'} (${code})`;
  if (code === -106) return `Нет подключения к интернету или к сети. ${tech}`;
  if (code === -105 || code === -137) return `Не удаётся найти адрес сервера — проверьте сеть или VPN. ${tech}`;
  if (code === -102) return `Сервер отклонил подключение — возможно, он перезапускается. ${tech}`;
  if (code === -7 || code === -118) return `Сервер не отвечает. ${tech}`;
  if (code === -130 || code === -111 || code === -115) return `Не удаётся подключиться через прокси-сервер. ${tech}`;
  if (code <= -200 && code > -300) return `Ошибка сертификата сервера — обратитесь к администратору. ${tech}`;
  if (code === -21) return `Сеть переключилась во время загрузки. ${tech}`;
  return `Не удалось загрузить приложение: ${tech}`;
}

function describeHttpFailure(code, statusText) {
  return `Сервер ответил ошибкой ${code}${statusText ? ` ${statusText}` : ''} — возможно, он перезапускается.`;
}

module.exports = {
  HEALTH_RETRY_MS,
  HEALTH_TIMEOUT_MS,
  shouldShowOfflineForFailure,
  shouldShowOfflineForStatus,
  describeLoadFailure,
  describeHttpFailure
};
