// Согласие сотрудника на удалённый доступ — решает главный процесс.
//
// Раньше уровень доступа приходил от страницы: что она сообщила в
// rd-session-start, то главный процесс и считал разрешённым. Страница
// приходит с сервера, поэтому окно согласия в ней ничего не гарантирует.
// Теперь главный процесс сам показывает системное окно, и сеанс получает
// ровно тот уровень, который сотрудник выбрал в нём.

const path = require('node:path');

const VIEW_ONLY = 'view_only';
const FULL = 'full';

// Кнопки системного окна. «Отклонить» — и по Enter, и по Esc/крестику:
// окно всплывает поверх работы, и случайное нажатие не должно открыть экран.
// Среди разрешающих первым идёт «Только просмотр».
function buildConsentDialog({ operatorName, requestedLevel, fullAccessDisabled } = {}) {
  const offerFull = requestedLevel === FULL && !fullAccessDisabled;
  const choices = offerFull ? [VIEW_ONLY, FULL, null] : [VIEW_ONLY, null];
  const labels = choices.map((c) => (c === FULL ? 'Полный доступ' : c === VIEW_ONLY ? 'Только просмотр' : 'Отклонить'));
  const declineId = choices.indexOf(null);
  const who = operatorName || 'оператор техподдержки';

  const lines = [
    `${who} запрашивает доступ к экрану этого компьютера.`,
    '',
    '«Только просмотр» — оператор видит экран, но не управляет им.'
  ];
  if (offerFull) {
    lines.push('«Полный доступ» — оператор управляет мышью и клавиатурой и может передавать файлы.');
  } else if (requestedLevel === FULL && fullAccessDisabled) {
    lines.push('Полный доступ на этом компьютере запрещён политикой.');
  }
  lines.push('', 'Завершить сеанс можно в любой момент кнопкой на красной плашке вверху экрана или клавишами Ctrl+Alt+Shift+S.');

  return {
    choices,
    options: {
      type: 'warning',
      title: 'Запрос удалённого доступа',
      message: `Разрешить ${who} подключиться к вашему компьютеру?`,
      detail: lines.join('\n'),
      buttons: labels,
      defaultId: declineId,
      cancelId: declineId,
      noLink: true,
      normalizeAccessKeys: false
    }
  };
}

// Ответ окна -> уровень доступа или null (отказ). Всё непонятное — отказ.
function resolveConsent(choices, response, { fullAccessDisabled } = {}) {
  if (!Array.isArray(choices) || !Number.isInteger(response)) return null;
  const choice = choices[response];
  if (choice === FULL) return fullAccessDisabled ? VIEW_ONLY : FULL;
  if (choice === VIEW_ONLY) return VIEW_ONLY;
  return null;
}

// Политика удалённого доступа на конкретном ПК: переменные окружения или файл
// policy.json. Файл в ProgramData раскладывает администратор (у сотрудника
// нет прав его менять); файл в папке данных приложения — для ручной настройки.
//   MYCHAT_RD_DISABLE_FULL=1 / {"disableRemoteFullAccess": true} — только просмотр;
//   MYCHAT_RD_DISABLE=1      / {"disableRemoteDesktop": true}    — к этому ПК
//   нельзя подключиться вовсе: ни окна согласия, ни снятия экрана, ни ввода.
const POLICY_FILE = 'policy.json';

function isTruthyFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function policyPaths({ programData, userData } = {}) {
  const out = [];
  if (programData) out.push(path.join(programData, 'OpenMyChat Enterprise', POLICY_FILE));
  if (userData) out.push(path.join(userData, POLICY_FILE));
  return out;
}

function readRdPolicy({ env = {}, paths = [], readFile } = {}) {
  const policy = {
    remoteDesktopDisabled: isTruthyFlag(env.MYCHAT_RD_DISABLE),
    fullAccessDisabled: isTruthyFlag(env.MYCHAT_RD_DISABLE_FULL)
  };
  for (const file of paths) {
    let raw;
    try {
      raw = readFile(file);
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(String(raw).replace(/^﻿/, ''));
      if (parsed && parsed.disableRemoteDesktop === true) policy.remoteDesktopDisabled = true;
      if (parsed && parsed.disableRemoteFullAccess === true) policy.fullAccessDisabled = true;
    } catch {
      // Испорченный файл политики — считаем, что запрет задуман: безопаснее
      // остаться без удалённого доступа, чем молча его разрешить. Что именно
      // хотели запретить, из файла уже не понять — запрещается всё.
      policy.remoteDesktopDisabled = true;
      policy.fullAccessDisabled = true;
    }
  }
  // Без удалённого доступа нет и полного.
  if (policy.remoteDesktopDisabled) policy.fullAccessDisabled = true;
  return policy;
}

function isFullAccessDisabled(options) {
  return readRdPolicy(options).fullAccessDisabled;
}

function isRemoteDesktopDisabled(options) {
  return readRdPolicy(options).remoteDesktopDisabled;
}

// Ответ на rd-session-start до всякого окна: при запрете сотрудника даже не
// спрашивают — случайное «Разрешить» не должно ничего открыть.
function policyDecline(policy) {
  return policy && policy.remoteDesktopDisabled
    ? { accepted: false, accessLevel: null, reason: 'policy' }
    : null;
}

// Системное окно согласия на общий буфер обмена.
function buildClipboardDialog({ role, peerName } = {}) {
  const who = peerName || (role === 'operator' ? 'сотрудник' : 'оператор техподдержки');
  const message = role === 'operator'
    ? `Передавать скопированный вами текст на компьютер, к которому вы подключены (${who})?`
    : `Разрешить общий буфер обмена с ${who}?`;
  const detail = role === 'operator'
    ? 'Уходит только то, что вы скопируете после согласия. Выключить можно кнопкой «Буфер» в окне сеанса.'
    : 'Текст, который вы скопируете после согласия, будет передаваться оператору, а его текст — попадать в ваш буфер. То, что уже лежит в буфере, не отправляется.';
  return {
    type: 'question',
    title: 'Общий буфер обмена',
    message,
    detail,
    buttons: ['Разрешить', 'Не разрешать'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    normalizeAccessKeys: false
  };
}

// Системное окно для файла от оператора.
function buildFileDialog({ operatorName, fileName, sizeText, renamed, original } = {}) {
  const who = operatorName || 'оператор техподдержки';
  const lines = [`Имя: ${original || fileName}`, `Размер: ${sizeText}`];
  if (renamed) {
    lines.push('', `Это исполняемый файл. Он будет сохранён как «${fileName}», чтобы его нельзя было случайно запустить.`);
  }
  lines.push('', 'Файл будет помечен как полученный из интернета. Не открывайте его, если не ждали.');
  return {
    type: renamed ? 'warning' : 'question',
    title: 'Файл от оператора',
    message: `${who} передаёт файл. Сохранить его в папку «Загрузки»?`,
    detail: lines.join('\n'),
    buttons: ['Сохранить', 'Отклонить'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    normalizeAccessKeys: false
  };
}

module.exports = {
  VIEW_ONLY,
  FULL,
  buildConsentDialog,
  resolveConsent,
  policyPaths,
  readRdPolicy,
  isFullAccessDisabled,
  isRemoteDesktopDisabled,
  policyDecline,
  buildClipboardDialog,
  buildFileDialog
};
