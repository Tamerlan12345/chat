import React, { useState, useEffect } from 'react';

export default function LoginView({ onLoginSuccess, initialServerUrl = '' }) {
  const [isRegister, setIsRegister] = useState(false);
  const [serverUrl, setServerUrl] = useState(
    localStorage.getItem('mychat_server_url') || initialServerUrl || (window.location.origin.startsWith('http') ? window.location.origin : 'https://chat-production-0456.up.railway.app')
  );
  const [serverInfo, setServerInfo] = useState(null);
  const [checkingServer, setCheckingServer] = useState(false);

  // Login form
  const [username, setUsername] = useState(localStorage.getItem('mychat_saved_username') || '');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

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

  // Probe server info
  useEffect(() => {
    checkServer(serverUrl);
  }, []);

  const checkServer = async (url) => {
    setCheckingServer(true);
    setError('');
    try {
      const cleanUrl = url.replace(/\/+$/, '');
      const res = await fetch(`${cleanUrl}/api/settings/info`);
      if (res.ok) {
        const data = await res.json();
        setServerInfo(data);
        localStorage.setItem('mychat_server_url', cleanUrl);

        // /api/org/tree needs a token nobody has yet on this screen, and it
        // returns { tree }, not { departments } — so the select never had
        // anything to show. This endpoint is public and returns names only.
        try {
          const deptRes = await fetch(`${cleanUrl}/api/settings/departments`);
          if (deptRes.ok) {
            const data = await deptRes.json();
            setDepartments(data.departments || []);
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

  const handleServerUrlBlur = () => {
    checkServer(serverUrl);
  };

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Пожалуйста, введите логин и пароль');
      return;
    }

    setLoading(true);
    setError('');

    const cleanUrl = serverUrl.replace(/\/+$/, '');

    try {
      const res = await fetch(`${cleanUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Ошибка авторизации');
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
      setError(err.message || 'Не удалось подключиться к серверу');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password || !regFullName.trim()) {
      setError('Заполните обязательные поля (Логин, Пароль, ФИО)');
      return;
    }

    setLoading(true);
    setError('');

    const cleanUrl = serverUrl.replace(/\/+$/, '');

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

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Ошибка регистрации');
      }

      localStorage.setItem('mychat_token', data.token);
      localStorage.setItem('mychat_server_url', cleanUrl);

      onLoginSuccess(data.user, data.token, cleanUrl);
    } catch (err) {
      setError(err.message || 'Ошибка регистрации пользователя');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        {/* Logo / Header */}
        <div className="login-header">
          <div className="login-logo-circle">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
          <h2 className="login-title">
            {serverInfo?.company_name || 'OpenMyChat'}
          </h2>
          <p className="login-subtitle">
            Корпоративный мессенджер для сотрудников
          </p>
        </div>

        {/* Server status indicator */}
        <div className="login-server-badge">
          <span className={`server-status-dot ${serverInfo ? 'online' : 'offline'}`} />
          <span className="server-status-text">
            {checkingServer ? 'Проверка связи с сервером...' : serverInfo ? `Сервер в сети: ${serverInfo.server_name || 'MyChat Server'}` : 'Сервер не отвечает'}
          </span>
        </div>

        {/* Mode Tabs */}
        <div className="login-tabs">
          <button
            type="button"
            className={`login-tab-btn ${!isRegister ? 'active' : ''}`}
            onClick={() => { setIsRegister(false); setError(''); }}
          >
            Вход в систему
          </button>
          {serverInfo?.allow_registration && (
            <button
              type="button"
              className={`login-tab-btn ${isRegister ? 'active' : ''}`}
              onClick={() => { setIsRegister(true); setError(''); }}
            >
              Регистрация сотрудника
            </button>
          )}
        </div>

        {error && (
          <div className="login-error-box">
            ⚠️ {error}
          </div>
        )}

        {/* Login Form */}
        {!isRegister ? (
          <form onSubmit={handleLoginSubmit} className="login-form">
            <div className="form-group">
              <label className="form-label">Адрес сервера:</label>
              <input
                type="text"
                className="form-input"
                value={serverUrl}
                onChange={e => setServerUrl(e.target.value)}
                onBlur={handleServerUrlBlur}
                placeholder="http://localhost:2004 или IP сервера"
                disabled={loading}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Логин или UIN:</label>
              <input
                type="text"
                className="form-input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Введите ваш логин"
                disabled={loading}
                autoFocus
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Пароль:</label>
              <input
                type="password"
                className="form-input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Введите ваш пароль"
                disabled={loading}
                required
              />
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

            <button
              type="submit"
              className="btn btn-primary btn-block login-submit-btn"
              disabled={loading || checkingServer}
            >
              {loading ? 'Вход в систему...' : 'Войти в MyChat'}
            </button>
          </form>
        ) : (
          /* Registration Form */
          <form onSubmit={handleRegisterSubmit} className="login-form">
            <div className="form-group">
              <label className="form-label">ФИО сотрудника *:</label>
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
                <label className="form-label">Логин *:</label>
                <input
                  type="text"
                  className="form-input"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="ivanov"
                  disabled={loading}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Пароль *:</label>
                <input
                  type="password"
                  className="form-input"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Пароль"
                  disabled={loading}
                  required
                />
              </div>
            </div>

            <div className="form-row-2">
              <div className="form-group">
                <label className="form-label">Должность:</label>
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
                <label className="form-label">Внутр. телефон:</label>
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
              <label className="form-label">Email:</label>
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
                <label className="form-label">Отдел компании:</label>
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

            <button
              type="submit"
              className="btn btn-primary btn-block login-submit-btn"
              disabled={loading}
            >
              {loading ? 'Создание учетной записи...' : 'Зарегистрироваться и войти'}
            </button>
          </form>
        )}

        <div className="login-footer-text">
          MyChat Client Enterprise • Автономная защищенная сеть
        </div>
      </div>
    </div>
  );
}
