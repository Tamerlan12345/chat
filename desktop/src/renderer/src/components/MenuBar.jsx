import React, { useState, useEffect, useRef } from 'react';

export default function MenuBar({
  currentUser,
  onOpenProfile,
  onSwitchAccount,
  onStatusChange,
  onSelectTab,
  onTogglePersonPanel,
  onOpenDbStudio,
  onOpenAdminConsole,
  onOpenWhatIsNew,
  onOpenServerConnect,
  onTestNotification
}) {
  const [openMenu, setOpenMenu] = useState(null);
  const menuBarRef = useRef(null);

  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const toggleMenu = (name) => {
    setOpenMenu(openMenu === name ? null : name);
  };

  const isAdmin = currentUser && (
    currentUser.role_id === 1 ||
    currentUser.role_name === 'Суперадминистратор' ||
    currentUser.role_name === 'Администратор' ||
    currentUser.role_name === 'Admin' ||
    currentUser.username === 'admin' ||
    currentUser.permissions?.is_admin
  );

  return (
    <div className="native-menu-bar" ref={menuBarRef}>
      {/* 1. MyChat Menu */}
      <div className="menu-item-wrapper">
        <button
          className={`menu-top-btn ${openMenu === 'mychat' ? 'active' : ''}`}
          onClick={() => toggleMenu('mychat')}
        >
          MyChat
        </button>
        {openMenu === 'mychat' && (
          <div className="menu-dropdown-layer">
            <div
              className="menu-drop-item"
              onClick={() => {
                onOpenProfile && onOpenProfile();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span>Мой профиль</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onSwitchAccount && onSwitchAccount();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              <span>Сменить пользователя...</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onOpenServerConnect && onOpenServerConnect();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
              <span style={{ fontWeight: 500, color: '#1d4ed8' }}>Сетевой сервер...</span>
            </div>
            <div className="menu-drop-divider" />
            <div
              className="menu-drop-item"
              onClick={() => {
                onStatusChange && onStatusChange('online');
                setOpenMenu(null);
              }}
            >
              <span className="chat-header-status-dot online" style={{ marginRight: 8 }} />
              <span>В сети</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onStatusChange && onStatusChange('away');
                setOpenMenu(null);
              }}
            >
              <span className="chat-header-status-dot away" style={{ marginRight: 8 }} />
              <span>Отошел</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onStatusChange && onStatusChange('dnd');
                setOpenMenu(null);
              }}
            >
              <span className="chat-header-status-dot dnd" style={{ marginRight: 8 }} />
              <span>Не беспокоить</span>
            </div>
            <div className="menu-drop-divider" />
            <div
              className="menu-drop-item"
              onClick={() => {
                window.close();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              <span>Выход</span>
            </div>
          </div>
        )}
      </div>

      {/* 2. Вид Menu */}
      <div className="menu-item-wrapper">
        <button
          className={`menu-top-btn ${openMenu === 'view' ? 'active' : ''}`}
          onClick={() => toggleMenu('view')}
        >
          Вид
        </button>
        {openMenu === 'view' && (
          <div className="menu-dropdown-layer">
            <div
              className="menu-drop-item"
              onClick={() => {
                onSelectTab('chats');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span>Диалоги</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onSelectTab('channels');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>Конференции (Каналы)</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onSelectTab('contacts');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="22.01"/><line x1="15" y1="22" x2="15.01" y2="22"/><line x1="9" y1="6" x2="9" y2="6.01"/><line x1="15" y1="6" x2="15.01" y2="6"/><line x1="9" y1="10" x2="9" y2="10.01"/><line x1="15" y1="10" x2="15.01" y2="10"/><line x1="9" y1="14" x2="9" y2="14.01"/><line x1="15" y1="14" x2="15.01" y2="14"/><line x1="9" y1="18" x2="9" y2="18.01"/><line x1="15" y1="18" x2="15.01" y2="18"/></svg>
              <span>Общие контакты</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onSelectTab('important');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              <span>Важное (Оповещения)</span>
            </div>
            <div className="menu-drop-divider" />
            <div
              className="menu-drop-item"
              onClick={() => {
                onTogglePersonPanel();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
              <span>Панель информации о сотруднике</span>
            </div>
          </div>
        )}
      </div>

      {/* 3. Инструменты Menu */}
      <div className="menu-item-wrapper">
        <button
          className={`menu-top-btn ${openMenu === 'tools' ? 'active' : ''}`}
          onClick={() => toggleMenu('tools')}
        >
          Инструменты
        </button>
        {openMenu === 'tools' && (
          <div className="menu-dropdown-layer">
            {isAdmin && (
              <>
                <div
                  className="menu-drop-item"
                  style={{ fontWeight: 600, color: '#1d4ed8' }}
                  onClick={() => {
                    onOpenAdminConsole && onOpenAdminConsole();
                    setOpenMenu(null);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span>Консоль управления сервером MyChat</span>
                </div>
                <div
                  className="menu-drop-item"
                  onClick={() => {
                    onOpenDbStudio && onOpenDbStudio();
                    setOpenMenu(null);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                  <span>База данных и аудит (DB Studio)</span>
                </div>
                <div className="menu-drop-divider" />
              </>
            )}
            <div
              className="menu-drop-item"
              onClick={() => {
                onOpenServerConnect && onOpenServerConnect();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
              <span>Проверить связь с сервером...</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                onTestNotification && onTestNotification();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              <span>Тест уведомления (правый угол)</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                localStorage.removeItem('mychat_channels_cache');
                alert('Локальный кэш успешно очищен.');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              <span>Очистить локальный кэш</span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Плагины Menu */}
      <div className="menu-item-wrapper">
        <button
          className={`menu-top-btn ${openMenu === 'plugins' ? 'active' : ''}`}
          onClick={() => toggleMenu('plugins')}
        >
          Плагины
        </button>
        {openMenu === 'plugins' && (
          <div className="menu-dropdown-layer">
            <div
              className="menu-drop-item"
              onClick={() => {
                alert('Плагин удаленного рабочего стола активен. Нажмите иконку монитора в шапке любого личного диалога.');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span>Удаленный рабочий стол (Screen Assist)</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                alert('Плагин голосовых и видеовызовов WebRTC готов к использованию.');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              <span>Аудио / Видеозвонки WebRTC</span>
            </div>
          </div>
        )}
      </div>

      {/* 5. Справка Menu */}
      <div className="menu-item-wrapper">
        <button
          className={`menu-top-btn ${openMenu === 'help' ? 'active' : ''}`}
          onClick={() => toggleMenu('help')}
        >
          Справка
        </button>
        {openMenu === 'help' && (
          <div className="menu-dropdown-layer">
            <div
              className="menu-drop-item"
              onClick={() => {
                onOpenWhatIsNew && onOpenWhatIsNew();
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              <span>Что нового в MyChat Enterprise?</span>
            </div>
            <div
              className="menu-drop-item"
              onClick={() => {
                alert('OpenMyChat Enterprise Client 2026.1.0\nАО «Страховая компания «Сентрас Иншуранс»\nКорпоративная коммуникационная платформа.');
                setOpenMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>О программе</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
