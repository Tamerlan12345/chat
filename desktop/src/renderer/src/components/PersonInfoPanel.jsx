import React from 'react';

export default function PersonInfoPanel({
  user,
  currentUser,
  onClose,
  onOpenProfile,
  onOpenAdminUser
}) {
  if (!user) return null;

  const isSelf = currentUser && (user.id === currentUser.id || user.user_id === currentUser.id);
  const isAdmin = currentUser && (
    currentUser.role_id === 1 ||
    currentUser.role_name === 'Суперадминистратор' ||
    currentUser.role_name === 'Admin' ||
    currentUser.role_name === 'Администратор' ||
    currentUser.permissions?.is_admin ||
    currentUser.username === 'admin'
  );

  const displayName = user.full_name || user.name || user.username;
  const email = user.email || `${user.username || 'user'}@cic.kz`;
  const department = user.department_name || user.department || 'Подразделение не указано';

  return (
    <div className="person-info-sidebar">
      {/* Header */}
      <div className="person-info-head">
        <span className="person-info-head-title">Информация о сотруднике</span>
        <button className="person-info-close" onClick={onClose} title="Закрыть панель">
          ✕
        </button>
      </div>

      <div className="person-info-content">
        {/* Photo Box */}
        <div className="person-info-photo-container">
          {user.avatar_url ? (
            <img src={user.avatar_url} alt={displayName} className="person-info-large-photo" />
          ) : (
            <div className="person-info-photo-placeholder">
              <svg width="80" height="90" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
            </div>
          )}
        </div>

        {/* User Details */}
        <div className="person-info-details">
          {/* Full Name */}
          <div className="person-info-item name-item">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
            </svg>
            <span className="person-info-value-bold">{displayName}</span>
          </div>

          {/* Job Title */}
          {user.job_title && (
            <div className="person-info-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round">
                <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
              </svg>
              <span className="person-info-dept-text" style={{ fontWeight: 500, color: '#334155' }}>
                {user.job_title}
              </span>
            </div>
          )}

          {/* Department */}
          <div className="person-info-item">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round">
              <rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="22.01"/><line x1="15" y1="22" x2="15.01" y2="22"/>
            </svg>
            <span className="person-info-dept-text" title={department}>
              {department}
            </span>
          </div>

          {/* Email */}
          <div className="person-info-item">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
            </svg>
            <a href={`mailto:${email}`} className="person-info-email-link">
              {email}
            </a>
          </div>

          {/* Extension / Phone if available */}
          {user.extension && (
            <div className="person-info-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
              <span className="person-info-subtext">внутр. номер: <strong>{user.extension}</strong></span>
            </div>
          )}

          {/* Presence Status */}
          <div className="person-info-item status-item">
            <span className={`person-status-badge ${user.status || 'offline'}`}>
              <span className={`person-status-dot ${user.status || 'offline'}`} />
              <span className="person-status-text">
                {user.status === 'online'
                  ? 'В сети'
                  : user.status === 'away'
                  ? 'Отошел'
                  : user.status === 'dnd'
                  ? 'Не беспокоить'
                  : 'Не в сети'}
              </span>
            </span>
          </div>

          {/* Role Badge */}
          <div className="person-info-item" style={{ marginTop: '4px' }}>
            <span style={{
              fontSize: '11px',
              padding: '3px 8px',
              borderRadius: '4px',
              background: user.role_name === 'Суперадминистратор' || user.role_id === 1 ? '#eff6ff' : '#f1f5f9',
              color: user.role_name === 'Суперадминистратор' || user.role_id === 1 ? '#1d4ed8' : '#475569',
              fontWeight: 600,
              border: '1px solid',
              borderColor: user.role_name === 'Суперадминистратор' || user.role_id === 1 ? '#bfdbfe' : '#e2e8f0'
            }}>
              Роль: {user.role_name || (user.role_id === 1 ? 'Администратор' : 'Сотрудник')}
            </span>
          </div>
        </div>

        {/* Role-Aware Self Contour vs Admin Controls (No duplicate Call/Video/Screen buttons) */}
        <div style={{ marginTop: '16px', padding: '0 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {isSelf ? (
            <button
              className="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              onClick={() => onOpenProfile && onOpenProfile()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
              Редактировать мой профиль
            </button>
          ) : isAdmin ? (
            <button
              className="btn btn-secondary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '11px' }}
              onClick={() => onOpenAdminUser && onOpenAdminUser(user)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              Управление пользователем (Консоль)
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
