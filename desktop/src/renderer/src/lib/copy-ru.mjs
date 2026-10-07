// Общие русские тексты трёх клиентов (Android, iOS, компьютер). Ключи и
// тексты — из канонической таблицы copy-ru (Task 11; в контракте —
// mobile/contracts/copy-ru.md). Здесь — только состояния, которые есть на
// компьютере; менять текст — в таблице и здесь одновременно (тест
// test/copy-ru.test.mjs сверяет дословно).

export const COPY = Object.freeze({
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
});

// Отказ входа или регистрации. Код сервера важнее его короткого текста:
// «Заявка на рассмотрении» само по себе не говорит, что делать дальше.
const CODE_TEXT = {
  ACCOUNT_PENDING: COPY['login.pending.body'],
  ACCOUNT_REJECTED: COPY['login.rejected.body'],
  REGISTRATION_DISABLED: COPY['reg.disabled']
};

export function describeAuthFailure(status, data, fallback) {
  const code = data && typeof data.code === 'string' ? data.code : '';
  if (Object.prototype.hasOwnProperty.call(CODE_TEXT, code)) return CODE_TEXT[code];
  if (data && typeof data.error === 'string' && data.error) return data.error;
  if (status === 403) return 'Доступ с этого адреса запрещён — обратитесь к администратору';
  if (status === 404) return 'По этому адресу сервер CentyChat не отвечает';
  if (status === 429) return 'Слишком много попыток — повторите через минуту';
  if (status >= 500) return 'Сервер временно недоступен — повторите через минуту';
  return fallback;
}

// Строка состояния связи. Компьютер переподключается сам и без конца, поэтому
// «Нет связи с сервером» как окончательного состояния здесь нет: либо нет сети
// у самого компьютера, либо идёт переподключение.
export function connectionLabel({ connected, networkOnline }) {
  if (connected) return COPY['conn.online'];
  if (networkOnline === false) return COPY['conn.offline'];
  return COPY['conn.reconnecting'];
}
