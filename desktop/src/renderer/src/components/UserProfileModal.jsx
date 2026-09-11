import React, { useState } from 'react';

export default function UserProfileModal({ currentUser, serverInfo, onClose, onUpdateProfile, token, serverUrl, onTokenRenewed }) {
  const [activeTab, setActiveTab] = useState('main'); // 'main' | 'home' | 'work' | 'personal' | 'interests' | 'past' | 'extra'

  // Every field starts from the real account. It previously fell back to one
  // specific employee's details, so anyone with a blank field saw — and on
  // save wrote — somebody else's name, email and phone number.
  const initialName = currentUser?.full_name?.split(' ')?.[0] || '';
  const initialSurname = currentUser?.full_name?.split(' ')?.slice(1)?.join(' ') || '';

  const [firstName, setFirstName] = useState(initialName);
  const [patronymic, setPatronymic] = useState('');
  const [lastName, setLastName] = useState(initialSurname);
  const [nick] = useState(currentUser?.username || '');
  const [gender, setGender] = useState('Мужской');
  const [email, setEmail] = useState(currentUser?.email || '');
  const [phone, setPhone] = useState(currentUser?.phone || '');
  const [jobTitle, setJobTitle] = useState(currentUser?.job_title || '');
  const [avatarUrl, setAvatarUrl] = useState(currentUser?.avatar_url || '');

  const [showPwForm, setShowPwForm] = useState(false);
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const tabs = [
    { id: 'main', icon: '👤', label: 'Основное' },
    { id: 'home', icon: '🏠', label: 'Дом' },
    { id: 'work', icon: '💼', label: 'Место работы' },
    { id: 'personal', icon: '❤️', label: 'Личное' },
    { id: 'interests', icon: '★', label: 'Интересы' },
    { id: 'past', icon: '📖', label: 'Прошлое' },
    { id: 'extra', icon: '➕', label: 'Дополнительно' }
  ];

  const handleSave = () => {
    const updatedFullName = `${firstName} ${lastName}`.trim();
    if (onUpdateProfile) {
      onUpdateProfile({
        full_name: updatedFullName,
        email,
        phone,
        job_title: jobTitle,
        avatar_url: avatarUrl
      });
    }
    onClose();
  };

  const handleUploadPhoto = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          setAvatarUrl(evt.target.result);
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwSuccess('');
    if (pwNew.length < 8) {
      setPwError('Новый пароль должен быть не короче 8 символов');
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError('Пароли не совпадают');
      return;
    }
    setPwSubmitting(true);
    try {
      const res = await fetch(`${serverUrl}/api/users/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ oldPassword: pwOld, newPassword: pwNew })
      });
      const data = await res.json();
      if (!res.ok) {
        setPwError(data.error || 'Не удалось сменить пароль');
        return;
      }
      // Прежний токен только что отозван вместе со старым паролем — сервер
      // вернул новый, и без него ближайший запрос получил бы отказ.
      if (data.token && onTokenRenewed) onTokenRenewed(data.token);
      setPwSuccess('Пароль изменен');
      setPwOld('');
      setPwNew('');
      setPwConfirm('');
      setTimeout(() => setShowPwForm(false), 1200);
    } catch (err) {
      setPwError('Нет соединения с сервером');
    } finally {
      setPwSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog profile-modal-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Modal Window Header */}
        <div className="profile-modal-header">
          <span className="profile-modal-title">Мой персональный профиль</span>
          <button className="profile-modal-close-btn" onClick={onClose} title="Закрыть">✕</button>
        </div>

        {/* Modal Content */}
        <div className="profile-modal-body">
          {/* Left Vertical Tabs Rail */}
          <div className="profile-tabs-sidebar">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`profile-tab-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="profile-tab-icon">{tab.icon}</span>
                <span className="profile-tab-label">{tab.label}</span>
              </div>
            ))}
          </div>

          {/* Right Tab Content Panel */}
          <div className="profile-tab-content">
            <div className="profile-tab-header-banner">
              <span>{tabs.find((t) => t.id === activeTab)?.label}</span>
            </div>

            {activeTab === 'main' && (
              <div className="profile-main-grid">
                {/* Form Fields Column */}
                <div className="profile-fields-col">
                  <div className="profile-field-row">
                    <label className="profile-label">Имя:</label>
                    <input
                      type="text"
                      className="profile-input"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                    />
                  </div>

                  <div className="profile-field-row">
                    <label className="profile-label">Отчество:</label>
                    <input
                      type="text"
                      className="profile-input"
                      value={patronymic}
                      onChange={(e) => setPatronymic(e.target.value)}
                    />
                  </div>

                  <div className="profile-field-row">
                    <label className="profile-label">Фамилия:</label>
                    <input
                      type="text"
                      className="profile-input"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                    />
                  </div>

                  <div className="profile-field-row">
                    <label className="profile-label">Ник:</label>
                    <input
                      type="text"
                      className="profile-input"
                      value={nick}
                      readOnly
                    />
                  </div>

                  <div className="profile-field-row">
                    <label className="profile-label">Пол:</label>
                    <select
                      className="profile-select"
                      value={gender}
                      onChange={(e) => setGender(e.target.value)}
                    >
                      <option value="Мужской">Мужской</option>
                      <option value="Женский">Женский</option>
                    </select>
                  </div>

                  <div className="profile-field-row">
                    <label className="profile-label">Электронная почта:</label>
                    <input
                      type="email"
                      className="profile-input"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>

                  <div className="profile-field-row profile-uin-row">
                    <label className="profile-label">UIN:</label>
                    <span className="profile-uin-text">{currentUser?.uin || '—'}</span>
                  </div>
                </div>

                {/* Photo Column */}
                <div className="profile-photo-col">
                  <div className="profile-photo-box">
                    <div className="profile-photo-header">Фотография</div>
                    <div className="profile-photo-preview">
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="Аватар" className="profile-photo-img" />
                      ) : (
                        <div className="profile-photo-placeholder">
                          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                            <circle cx="12" cy="13" r="4" />
                          </svg>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="profile-photo-actions">
                    <button type="button" className="profile-link-btn" onClick={handleUploadPhoto}>
                      Загрузить фото
                    </button>
                    <button type="button" className="profile-link-btn" onClick={() => setAvatarUrl('')}>
                      Очистить фото
                    </button>
                    <button type="button" className="profile-link-btn" onClick={() => { setShowPwForm((v) => !v); setPwError(''); setPwSuccess(''); }}>
                      Изменить пароль
                    </button>
                  </div>

                  {showPwForm && (
                    <form className="login-form" style={{ marginTop: '10px', width: '100%' }} onSubmit={handleChangePassword}>
                      {pwError && <div className="login-error-box">{pwError}</div>}
                      {pwSuccess && <div className="login-error-box" style={{ background: '#f0fdf4', borderColor: '#bbf7d0', color: '#15803d' }}>{pwSuccess}</div>}
                      <div className="form-group">
                        <label className="form-label">Текущий пароль</label>
                        <input type="password" className="form-input" value={pwOld} onChange={(e) => setPwOld(e.target.value)} disabled={pwSubmitting} required />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Новый пароль</label>
                        <input type="password" className="form-input" value={pwNew} onChange={(e) => setPwNew(e.target.value)} disabled={pwSubmitting} required minLength={8} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Повторите новый пароль</label>
                        <input type="password" className="form-input" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} disabled={pwSubmitting} required minLength={8} />
                      </div>
                      <button type="submit" className="btn btn-primary btn-block" disabled={pwSubmitting}>
                        {pwSubmitting ? 'Сохранение...' : 'Сохранить новый пароль'}
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'work' && (
              <div className="profile-tab-simple-body">
                <div className="profile-field-row">
                  <label className="profile-label">Компания:</label>
                  <input type="text" className="profile-input" value={serverInfo?.company_name || currentUser?.company || 'АО "Страховая компания "Сентрас Иншуранс"'} readOnly />
                </div>
                <div className="profile-field-row">
                  <label className="profile-label">Подразделение:</label>
                  <input
                    type="text"
                    className="profile-input"
                    value={currentUser?.department_name || 'не назначено'}
                    readOnly
                    title="Подразделение назначает администратор"
                  />
                </div>
                <div className="profile-field-row">
                  <label className="profile-label">Должность:</label>
                  <input type="text" className="profile-input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
                </div>
                <div className="profile-field-row">
                  <label className="profile-label">Внутренний телефон:</label>
                  <input type="text" className="profile-input" value={currentUser?.extension || '—'} readOnly />
                </div>
                <div className="profile-field-hint">
                  Компанию, подразделение и внутренний номер назначает администратор — обратитесь к нему для изменения.
                </div>
              </div>
            )}

            {activeTab !== 'main' && activeTab !== 'work' && (
              <div className="profile-tab-placeholder">
                <p>Дополнительная информация для раздела «{tabs.find((t) => t.id === activeTab)?.label}»</p>
                <div className="profile-field-row" style={{ marginTop: '15px' }}>
                  <label className="profile-label">Примечание:</label>
                  <textarea className="profile-input" rows={3} placeholder="Заполняется по желанию сотрудника..." />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="profile-modal-footer">
          <button className="profile-ok-btn" onClick={handleSave}>
            <span style={{ marginRight: '6px' }}>✔</span> Ок
          </button>
        </div>
      </div>
    </div>
  );
}
