import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icon';
import { BrandLockup, BRAND_C_PATH } from './BrandMark';
import { postLoginWithRetry } from '../lib/login-retry.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_SERVER_URL = 'https://centychat-production.up.railway.app';

// Только https. http — лишь для сервера на своей машине в разработке: по
// открытому каналу пароль уходит как есть. Адрес, сохранённый раньше
// (например, офисный по http), больше не подхватывается молча.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const ALLOW_LOCAL_HTTP =
  Boolean(import.meta.env.DEV) ||
  (window.location.protocol === 'http:' && LOCAL_HOSTS.includes(window.location.hostname));

function isAllowedServerUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ALLOW_LOCAL_HTTP && LOCAL_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

const APP_ORIGIN = isAllowedServerUrl(window.location.origin) ? window.location.origin : '';
const INSECURE_SERVER_TEXT = 'Адрес сервера должен начинаться с https:// — подключение без шифрования запрещено';

function initialServerUrlFrom(...candidates) {
  return candidates.find((url) => url && isAllowedServerUrl(url)) || DEFAULT_SERVER_URL;
}

// Ответ сервера бывает не JSON: страница «Not found» при закрытом браузерном
// доступе, ошибка прокси во время выкладки. Раньше человек видел
// «Unexpected token < in JSON» вместо понятной причины.
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function describeFailure(res, data, fallback) {
  if (data && typeof data.error === 'string' && data.error) return data.error;
  if (res.status === 403) return 'Доступ с этого адреса запрещён — обратитесь к администратору';
  if (res.status === 404) return 'По этому адресу сервер CentyChat не отвечает';
  if (res.status === 429) return 'Слишком много попыток — повторите через минуту';
  if (res.status >= 500) return 'Сервер временно недоступен — повторите через минуту';
  return fallback;
}

export default function LoginView({ onLoginSuccess, initialServerUrl = '' }) {
  const [isRegister, setIsRegister] = useState(false);
  const [serverUrl, setServerUrl] = useState(() =>
    initialServerUrlFrom(localStorage.getItem('mychat_server_url'), initialServerUrl, APP_ORIGIN)
  );
  const [serverInfo, setServerInfo] = useState(null);
  const [checkingServer, setCheckingServer] = useState(false);

  // Login form
  const [username, setUsername] = useState(localStorage.getItem('mychat_saved_username') || '');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [capsLock, setCapsLock] = useState(false);

  // Register form
  const [regFullName, setRegFullName] = useState('');
  const [regJobTitle, setRegJobTitle] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [departments, setDepartments] = useState([]);
  const [selectedDept, setSelectedDept] = useState('');

  // UI status
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingMessage, setPendingMessage] = useState('');
  // Автоповтор входа при перегрузке сервера (503): пока идёт пауза, поля входа
  // остаются доступными — правка любого из них отменяет повтор (задача 4).
  const [retryNote, setRetryNote] = useState('');
  const cancelRetryRef = useRef(false);
  // Почему человек снова на экране входа: сеанс отозван, пароль сброшен
  // администратором. Без объяснения выброс на вход выглядел как сбой.
  const [notice] = useState(() => {
    try {
      const reason = sessionStorage.getItem('mychat_logout_reason');
      if (reason) sessionStorage.removeItem('mychat_logout_reason');
      return reason || '';
    } catch {
      return '';
    }
  });

  // Probe server info
  useEffect(() => {
    checkServer(serverUrl);
  }, []);

  const checkServer = async (url) => {
    const cleanUrl = String(url || '').replace(/\/+$/, '');
    if (!isAllowedServerUrl(cleanUrl)) {
      setServerInfo(null);
      setError(INSECURE_SERVER_TEXT);
      return;
    }
    setCheckingServer(true);
    setError('');
    try {
      const res = await fetch(`${cleanUrl}/api/settings/info`);
      if (res.ok) {
        const data = await res.json();
        setServerInfo(data);
        setServerUrl(cleanUrl);
        localStorage.setItem('mychat_server_url', cleanUrl);

        // /api/org/tree needs a token nobody has yet on this screen, and it
        // returns { tree }, not { departments } — so the select never had
        // anything to show. This endpoint is public and returns names only.
        try {
          const deptRes = await fetch(`${cleanUrl}/api/settings/departments`);
          if (deptRes.ok) {
            const deptData = await deptRes.json();
            setDepartments(deptData.departments || []);
          }
        } catch {}
      } else {
        setServerInfo(null);
      }
    } catch {
      setServerInfo(null);
    } finally {
      setCheckingServer(false);
    }
  };

  // Адрес, выбранный когда-то в «Сетевой сервер…», хранится отдельно от
  // адреса, с которого загружено само приложение. Если он недоступен, раньше
  // выбраться было нельзя: на экране входа поля адреса нет, а меню появляется
  // только после входа.
  const canUseAppOrigin = Boolean(APP_ORIGIN) && APP_ORIGIN !== serverUrl.replace(/\/+$/, '');

  const handleUseAppOrigin = () => {
    localStorage.setItem('mychat_server_url', APP_ORIGIN);
    setServerUrl(APP_ORIGIN);
    checkServer(APP_ORIGIN);
  };

  const trackCapsLock = (e) => {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'));
  };

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    if (!username.trim() || !password) {
      setError('Пожалуйста, введите логин и пароль');
      return;
    }

    setLoading(true);
    setError('');
    setRetryNote('');
    cancelRetryRef.current = false;

    const cleanUrl = serverUrl.replace(/\/+$/, '');
    // Пароль по открытому каналу не отправляется.
    if (!isAllowedServerUrl(cleanUrl)) {
      setError(INSECURE_SERVER_TEXT);
      setLoading(false);
      return;
    }

    try {
      // Сервер под наплывом входов отвечает 503 (LOGIN_BUSY/PASSWORD_HASH_BUSY)
      // с Retry-After — это не отказ, а просьба повторить. Повторяем до двух
      // раз, соблюдая Retry-After (пауза не дольше ~5 с), с видимым статусом.
      const { res, data, cancelled } = await postLoginWithRetry({
        fetchImpl: fetch,
        sleep,
        url: `${cleanUrl}/api/auth/login`,
        body: { username: username.trim(), password },
        budgetMs: 45000,
        onRetry: (attempt) => setRetryNote(`Сервер занят, повторяю вход… (попытка ${attempt})`),
        shouldCancel: () => cancelRetryRef.current
      });
      setRetryNote('');
      if (cancelled) {
        setError('Повтор входа отменён — нажмите «Войти», когда будете готовы');
        return;
      }

      if (!res.ok || !data.token) {
        throw new Error(describeFailure(res, data, 'Не удалось войти'));
      }

      if (rememberMe) {
        localStorage.setItem('mychat_saved_username', username.trim());
      } else {
        localStorage.removeItem('mychat_saved_username');
      }

      localStorage.setItem('mychat_token', data.token);
      localStorage.setItem('mychat_server_url', cleanUrl);

      onLoginSuccess(data.user, data.token, cleanUrl);
    } catch (err) {
      setRetryNote('');
      setError(
        err instanceof TypeError
          ? 'Нет связи с сервером — проверьте сеть и повторите'
          : err.message || 'Не удалось подключиться к серверу'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    if (!username.trim() || !password || !regFullName.trim()) {
      setError('Заполните обязательные поля (Логин, Пароль, ФИО)');
      return;
    }
    // Требование сервера. Проверка здесь — чтобы не заполнять форму заново
    // после отказа.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
      return;
    }

    setLoading(true);
    setError('');

    const cleanUrl = serverUrl.replace(/\/+$/, '');
    // Пароль по открытому каналу не отправляется.
    if (!isAllowedServerUrl(cleanUrl)) {
      setError(INSECURE_SERVER_TEXT);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`${cleanUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
          full_name: regFullName.trim(),
          job_title: regJobTitle.trim() || 'Сотрудник',
          email: regEmail.trim(),
          phone: regPhone.trim(),
          department_id: selectedDept ? Number(selectedDept) : null
        })
      });

      const data = await readJson(res);

      if (!res.ok) {
        throw new Error(describeFailure(res, data, 'Ошибка регистрации'));
      }

      // Регистрация больше не пускает внутрь сразу: заявку должен
      // подтвердить администратор.
      setPendingMessage(
        data.message || 'Заявка отправлена. Вход станет возможен после подтверждения администратором.'
      );
      setIsRegister(false);
      setPassword('');
    } catch (err) {
      setError(
        err instanceof TypeError
          ? 'Нет связи с сервером — проверьте сеть и повторите'
          : err.message || 'Ошибка регистрации пользователя'
      );
    } finally {
      setLoading(false);
    }
  };

  const companyName = serverInfo?.company_name || '';
  const allowRegistration = Boolean(serverInfo?.allow_registration);

  return (
    <div className="login-container">
      <div className="login-card login-card--split">
        {/* Фирменная сторона: знак, название и компания. В узком окне она
            скрывается, и знак с названием переезжают в шапку формы. */}
        <aside className="login-brand">
          <svg className="login-brand-glyph" viewBox="0 0 880 880" aria-hidden="true" focusable="false">
            <path d={BRAND_C_PATH} />
          </svg>
          <BrandLockup size={40} className="login-brand-lockup" />
          <p className="login-brand-lead">Корпоративный мессенджер для сотрудников</p>
          {companyName && <p className="login-brand-company">{companyName}</p>}
        </aside>

        <div className="login-main">
          <div className="login-header">
            <div className="login-compact-brand">
              <BrandLockup size={36} />
              {companyName && <p className="login-compact-company">{companyName}</p>}
            </div>
            <h1 className="login-title">
              {isRegister ? 'Регистрация сотрудника' : 'Вход в CentyChat'}
            </h1>
            <p className="login-subtitle">
              {isRegister ? 'Заявку подтвердит администратор' : 'Войдите с рабочим логином и паролем'}
            </p>
          </div>

          {/* Server status indicator */}
          {/* Название сервера не показывается — сотруднику важно лишь то, есть
              связь или нет. */}
          <div className="login-server-badge">
            <span className={`server-status-dot ${serverInfo ? 'online' : 'offline'}`} />
            <span className="server-status-text">
              {checkingServer ? 'Подключаемся…' : serverInfo ? 'Связь установлена' : 'Нет связи с сервером'}
            </span>
            {!checkingServer && !serverInfo && (
              <>
                <button type="button" className="conf-link-btn" style={{ marginLeft: '8px' }} onClick={() => checkServer(serverUrl)}>
                  Повторить
                </button>
                {canUseAppOrigin && (
                  <button type="button" className="conf-link-btn" style={{ marginLeft: '8px' }} onClick={handleUseAppOrigin}>
                    Подключиться к серверу приложения
                  </button>
                )}
              </>
            )}
          </div>

          {/* Переключатель нужен, только когда есть из чего выбирать: одна
              вкладка «Вход в систему» выглядела как лишняя кнопка. */}
          {(allowRegistration || isRegister) && (
            <div className="login-tabs">
              <button
                type="button"
                className={`login-tab-btn ${!isRegister ? 'active' : ''}`}
                onClick={() => { setIsRegister(false); setError(''); }}
              >
                Вход в систему
              </button>
              {allowRegistration && (
                <button
                  type="button"
                  className={`login-tab-btn ${isRegister ? 'active' : ''}`}
                  onClick={() => { setIsRegister(true); setError(''); setPendingMessage(''); }}
                >
                  Регистрация сотрудника
                </button>
              )}
            </div>
          )}

          {notice && !error && !pendingMessage && (
            // Это объяснение, а не ошибка: красная рамка пугала сотрудника так,
            // будто он сам что-то сломал.
            <div role="status" className="login-notice-box">
              <Icon name="info" size={14} />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div className="login-error-box" role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          )}

          {pendingMessage && (
            <div className="login-pending-box" role="status">
              <Icon name="check" size={14} />
              <span>{pendingMessage}</span>
            </div>
          )}

          {/* Login Form */}
          {!isRegister ? (
            <form onSubmit={handleLoginSubmit} className="login-form">
              {/* Поля адреса сервера здесь нет намеренно: он зашит в приложение,
                  сотруднику вводить нечего, а показывать внутренний адрес всем
                  подряд незачем. Сменить его при необходимости можно через
                  «Сетевой сервер…» в меню. */}
              <div className="form-group">
                <label className="form-label" htmlFor="login-username">Логин</label>
                <input
                  id="login-username"
                  type="text"
                  className="form-input"
                  value={username}
                  onChange={e => { setUsername(e.target.value); if (retryNote) cancelRetryRef.current = true; }}
                  placeholder="Введите ваш логин"
                  autoComplete="username"
                  disabled={loading && !retryNote}
                  autoFocus
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="login-password">Пароль</label>
                <input
                  id="login-password"
                  type="password"
                  className="form-input"
                  value={password}
                  onChange={e => { setPassword(e.target.value); if (retryNote) cancelRetryRef.current = true; }}
                  onKeyUp={trackCapsLock}
                  onKeyDown={trackCapsLock}
                  placeholder="Введите ваш пароль"
                  autoComplete="current-password"
                  disabled={loading && !retryNote}
                  required
                />
                {capsLock && (
                  <div className="form-hint is-warning">
                    Включён Caps Lock — пароль вводится заглавными буквами
                  </div>
                )}
              </div>

              <div className="form-checkbox-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={e => setRememberMe(e.target.checked)}
                    disabled={loading}
                  />
                  Запомнить логин
                </label>
              </div>

              {retryNote && (
                <div className="form-hint is-warning" role="status">{retryNote}</div>
              )}
              <button
                type="submit"
                className="btn btn-primary btn-block login-submit-btn"
                disabled={loading || checkingServer}
              >
                {retryNote ? 'Сервер занят, повторяю…' : loading ? 'Входим…' : 'Войти'}
              </button>
            </form>
          ) : (
            /* Registration Form */
            <form onSubmit={handleRegisterSubmit} className="login-form">
              <div className="form-group">
                <label className="form-label">ФИО сотрудника *</label>
                <input
                  type="text"
                  className="form-input"
                  value={regFullName}
                  onChange={e => setRegFullName(e.target.value)}
                  placeholder="Иванов Иван Иванович"
                  disabled={loading}
                  required
                />
              </div>

              <div className="form-row-2">
                <div className="form-group">
                  <label className="form-label">Логин *</label>
                  <input
                    type="text"
                    className="form-input"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="ivanov"
                    autoComplete="username"
                    disabled={loading}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Пароль *</label>
                  <input
                    type="password"
                    className="form-input"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={`Не короче ${MIN_PASSWORD_LENGTH} символов`}
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    disabled={loading}
                    required
                  />
                </div>
              </div>

              <div className="form-row-2">
                <div className="form-group">
                  <label className="form-label">Должность</label>
                  <input
                    type="text"
                    className="form-input"
                    value={regJobTitle}
                    onChange={e => setRegJobTitle(e.target.value)}
                    placeholder="Менеджер / Инженер"
                    disabled={loading}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Внутр. телефон</label>
                  <input
                    type="text"
                    className="form-input"
                    value={regPhone}
                    onChange={e => setRegPhone(e.target.value)}
                    placeholder="например, 2101"
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  type="email"
                  className="form-input"
                  value={regEmail}
                  onChange={e => setRegEmail(e.target.value)}
                  placeholder="i.ivanov@company.local"
                  disabled={loading}
                />
              </div>

              {departments.length > 0 && (
                <div className="form-group">
                  <label className="form-label">Отдел компании</label>
                  <select
                    className="form-input"
                    value={selectedDept}
                    onChange={e => setSelectedDept(e.target.value)}
                    disabled={loading}
                  >
                    <option value="">Выберите отдел...</option>
                    {departments.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Кнопка обещала «и войти», хотя после регистрации вход закрыт до
                  одобрения администратором. */}
              <button
                type="submit"
                className="btn btn-primary btn-block login-submit-btn"
                disabled={loading}
              >
                {loading ? 'Отправляем заявку...' : 'Отправить заявку на регистрацию'}
              </button>
            </form>
          )}

          <div className="login-footer-text">
            CentyChat · автономная защищённая сеть
          </div>
        </div>
      </div>
    </div>
  );
}
