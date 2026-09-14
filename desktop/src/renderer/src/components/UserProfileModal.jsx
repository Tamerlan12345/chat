import React, { useState } from 'react';
import { parseFullName, formatFullName } from '../lib/person-name.mjs';

export default function UserProfileModal({ currentUser, serverInfo, onClose, onUpdateProfile, token, serverUrl, onTokenRenewed }) {
  const [activeTab, setActiveTab] = useState('main'); // 'main' | 'home' | 'work' | 'personal' | 'interests' | 'past' | 'extra'

  // Every field starts from the real account. It previously fell back to one
  // specific employee's details, so anyone with a blank field saw — and on
  // save wrote — somebody else's name, email and phone number.
  //
  // ФИО хранится строкой в порядке «Фамилия Имя Отчество». Разбиралось оно
  // как «первое слово — имя, остальное — фамилия»: сотрудник открывал свою
  // карточку и видел фамилию в поле «Имя», а отчество — в поле «Фамилия».
  const initialName = parseFullName(currentUser?.full_name);

  const [firstName, setFirstName] = useState(initialName.firstName);
  const [patronymic, setPatronymic] = useState(initialName.patronymic);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [nick] = useState(currentUser?.username || '');
  const [email, setEmail] = useState(currentUser?.email || '');
  const [phone, setPhone] = useState(currentUser?.phone || '');
  const [jobTitle, setJobTitle] = useState(currentUser?.job_title || '');
  const [avatarUrl, setAvatarUrl] = useState(currentUser?.avatar_url || '');
  const [photoError, setPhotoError] = useState('');

  const [showPwForm, setShowPwForm] = useState(false);
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);

  // Вкладок было семь, но пять из них — «Дом», «Личное», «Интересы»,
  // «Прошлое», «Дополнительно» — не отрисовывали ничего: сотрудник нажимал и
  // получал пустое окно с заголовком. Оставлены те, за которыми есть поля.
  const tabs = [
    { id: 'main', icon: '👤', label: 'Основное' },
    { id: 'work', icon: '💼', label: 'Место работы' }
  ];

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    // Отчество собиралось в одну строку с именем и фамилией — точнее, не
    // собиралось вовсе: поле было, его заполняли, и при сохранении оно
    // пропадало.
    const updatedFullName = formatFullName({ lastName, firstName, patronymic });
    if (!onUpdateProfile) {
      onClose();
      return;
    }
    // Окно закрывалось до ответа сервера: при отказе введённое пропадало вместе
    // с окном. Ждём результат; явный false означает отказ (сообщение о нём
    // показывает вызывающая сторона) — окно остаётся открытым.
    setSaving(true);
    let result;
    try {
      result = await onUpdateProfile({
        full_name: updatedFullName,
        email,
        phone,
        job_title: jobTitle,
        avatar_url: avatarUrl
      });
    } catch {
      result = false;
    }
    if (result === false) {
      setSaving(false);
      return;
    }
    onClose();
  };

  const handleUploadPhoto = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    // Снимок с телефона весит мегабайты, а фотография уходит каждому
    // сотруднику в каждом ответе справочника. Уменьшаем до размера аватара
    // здесь: сервер больше крупные изображения не принимает.
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAX_SIDE = 256;
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(objectUrl);
        setPhotoError('');
        setAvatarUrl(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setPhotoError('Файл не удалось открыть как изображение — выберите JPEG, PNG или WebP');
      };
      img.src = objectUrl;
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

                  {/* Поле «Пол» убрано: колонки под него нет, выбранное
                      значение никуда не сохранялось и нигде не читалось.
                      Форма не должна обещать того, чего не делает. */}

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
                    <button type="button" className="profile-link-btn" onClick={() => { setAvatarUrl(''); setPhotoError(''); }}>
                      Очистить фото
                    </button>
                    {photoError && (
                      <div role="alert" style={{ color: '#ec8383', fontSize: '12px', lineHeight: 1.4 }}>
                        {photoError}
                      </div>
                    )}
                    <button type="button" className="profile-link-btn" onClick={() => { setShowPwForm((v) => !v); setPwError(''); setPwSuccess(''); }}>
                      Изменить пароль
                    </button>
                  </div>

                  {showPwForm && (
                    <form className="login-form" style={{ marginTop: '10px', width: '100%' }} onSubmit={handleChangePassword}>
                      {pwError && <div className="login-error-box">{pwError}</div>}
                      {pwSuccess && <div className="login-error-box" style={{ background: 'rgba(66, 230, 116, 0.16)', borderColor: 'rgba(72, 234, 129, 0.38)', color: '#84ebab' }}>{pwSuccess}</div>}
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
          <button className="profile-ok-btn" onClick={handleSave} disabled={saving}>
            <span style={{ marginRight: '6px' }}>✔</span> {saving ? 'Сохранение…' : 'Ок'}
          </button>
        </div>
      </div>
    </div>
  );
}
