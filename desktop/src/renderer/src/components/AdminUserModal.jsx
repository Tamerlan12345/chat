import React, { useState, useEffect } from 'react';

export default function AdminUserModal({ currentUser, serverInfo, serverUrl, onClose, onRefreshData }) {
  // Official MyChat Control Panel Sections
  const [activeTab, setActiveTab] = useState('server'); 
  // 'server' | 'users' | 'conferences' | 'rights' | 'tools' | 'filters' | 'settings' | 'licenses'

  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  // Tab 1: Server Overview & Online
  const [serverOverview, setServerOverview] = useState(null);
  const [onlineList, setOnlineList] = useState([]);

  // Tab 2: Users Management
  const [users, setUsers] = useState([]);
  const [userSubTab, setUserSubTab] = useState('list');
  // Tab 2 Sub-tabs: 'list' | 'banned' | 'departments' | 'devices' | 'parser'
  const [pendingDevices, setPendingDevices] = useState([]);
  const [selectedDeviceForPair, setSelectedDeviceForPair] = useState(null);
  const [pairUserId, setPairUserId] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');

  // Org Parser State
  const [parserText, setParserText] = useState('');
  const [parserFormat, setParserFormat] = useState('auto');
  const [parserPreview, setParserPreview] = useState(null);
  const [parserLoading, setParserLoading] = useState(false); // 'list' | 'banned' | 'departments'
  const [userSearch, setUserSearch] = useState('');
  const [selectedDeptFilter, setSelectedDeptFilter] = useState('');
  const [departments, setDepartments] = useState([]);
  const [formMode, setFormMode] = useState(null); // null | 'create' | 'edit'
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({
    username: '',
    full_name: '',
    job_title: '',
    department_id: 1,
    role_id: 2,
    extension: '',
    uin: '',
    email: '',
    phone: '',
    password: 'admin',
    bound_ip: '',
    admin_scope_dept_id: ''
  });

  // Tab 3: Conferences
  const [channels, setChannels] = useState([]);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelTopic, setNewChannelTopic] = useState('');

  // Tab 4: Rights & Groups
  const [roles, setRoles] = useState([]);
  const [selectedRole, setSelectedRole] = useState(null);

  // Tab 5: Tools (Audit, Port Test, DB, Announcements)
  const [toolSubTab, setToolSubTab] = useState('audit'); // 'audit' | 'ports' | 'vacuum' | 'announcements'
  const [auditQuery, setAuditQuery] = useState('');
  const [auditResults, setAuditResults] = useState([]);
  const [portTestResult, setPortTestResult] = useState(null);
  const [vacuumResult, setVacuumResult] = useState(null);
  const [newAnnTitle, setNewAnnTitle] = useState('');
  const [newAnnText, setNewAnnText] = useState('');
  const [newAnnUrgent, setNewAnnUrgent] = useState(false);

  // Tab 6: Filters
  const [filterSettings, setFilterSettings] = useState({
    antiflood_limit: 10,
    bad_words_enabled: true,
    bad_words_list: 'спам,мат,реклама',
    ip_blacklist: ''
  });

  // Tab 7: Server Settings
  const [sysSettings, setSysSettings] = useState({
    company_name: 'АО "Страховая компания "Сентрас Иншуранс"',
    server_name: 'OpenMyChat Enterprise Server',
    allow_registration: 'false',
    max_upload_size_mb: '100',
    idle_timeout_seconds: '300',
    telegram_enabled: 'false',
    telegram_bot_token: '',
    telegram_channel_id: '',
    telegram_offline_alerts: 'true',
    telegram_mask_pii: 'true'
  });
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState(null);

  // Tab 8: Licenses
  const [licenseData, setLicenseData] = useState(null);

  const token = localStorage.getItem('mychat_token') || '';

  const loadPendingDevices = async () => {
    try {
      const res = await fetch(serverUrl + '/api/admin/devices/pending', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (res.ok) {
        const data = await res.json();
        setPendingDevices(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleBindDevice = async (deviceId, userId, ip) => {
    if (!userId) return showToast('Выберите сотрудника для привязки');
    try {
      const res = await fetch(serverUrl + '/api/admin/devices/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ device_id: deviceId, user_id: Number(userId), ip_address: ip })
      });
      if (res.ok) {
        showToast('Узел успешно привязан к сотруднику!');
        setSelectedDeviceForPair(null);
        loadPendingDevices();
        loadUsers();
      }
    } catch (e) {
      showToast('Ошибка привязки: ' + e.message);
    }
  };

  const handleAutoMatchIp = async () => {
    try {
      const res = await fetch(serverUrl + '/api/admin/devices/auto-match', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      });
      if (res.ok) {
        const d = await res.json();
        showToast('Автоматически сопоставлено узлов по IP: ' + d.matched_count);
        loadPendingDevices();
        loadUsers();
      }
    } catch (e) {
      showToast('Ошибка автосопоставления: ' + e.message);
    }
  };

  const handleUnbindDevice = async (deviceId) => {
    try {
      const res = await fetch(serverUrl + '/api/admin/devices/unbind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ device_id: deviceId })
      });
      if (res.ok) {
        showToast('Узел отвязан');
        loadPendingDevices();
      }
    } catch (e) {
      showToast('Ошибка: ' + e.message);
    }
  };

  const handlePreviewParser = async () => {
    if (!parserText.trim()) return showToast('Вставьте текст со структурой');
    setParserLoading(true);
    try {
      const res = await fetch(serverUrl + '/api/admin/org/preview-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ text: parserText, format: parserFormat })
      });
      if (res.ok) {
        const d = await res.json();
        setParserPreview(d.preview);
        showToast('Предпросмотр: ' + (d.preview && d.preview.stats ? d.preview.stats.departmentsCount : 0) + ' подразделений, ' + (d.preview && d.preview.stats ? d.preview.stats.employeesCount : 0) + ' сотрудников');
      }
    } catch (e) {
      showToast('Ошибка предпросмотра: ' + e.message);
    } finally {
      setParserLoading(false);
    }
  };

  const handleApplyParser = async () => {
    if (!parserText.trim()) return showToast('Вставьте текст со структурой');
    setParserLoading(true);
    try {
      const res = await fetch(serverUrl + '/api/admin/org/batch-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ text: parserText, format: parserFormat, defaultPassword: 'admin' })
      });
      if (res.ok) {
        const d = await res.json();
        showToast('Импорт успешно применен! Создано отделов: ' + d.createdDepts + ', сотрудников: ' + d.createdUsers + ', обновлено: ' + d.updatedUsers);
        setParserPreview(null);
        setParserText('');
        loadUsers();
        loadOrgTree();
        if (onRefreshData) onRefreshData();
      }
    } catch (e) {
      showToast('Ошибка применения импорта: ' + e.message);
    } finally {
      setParserLoading(false);
    }
  };


  // Notification helper
  const showToast = (text) => {
    setStatusMsg(text);
    setTimeout(() => setStatusMsg(null), 4000);
  };

  // Initial load
  useEffect(() => {
    loadServerOverview();
    loadUsers();
    loadOrgTree();
    loadChannels();
    loadRoles();
    loadFilters();
    loadSettings();
    loadLicenses();
  }, []);

  // ── DATA FETCHING ──
  const loadServerOverview = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/server/overview`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setServerOverview(data);
        setOnlineList(data.online_connections || []);
      }
    } catch (err) {
      console.error('Error fetching server overview:', err);
    }
  };

  const loadUsers = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUsers(data);
      }
    } catch (err) {
      console.error('Error fetching users:', err);
    }
  };

  const loadOrgTree = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/org/tree`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const depts = [];
        const extractDepts = (list) => {
          if (!list) return;
          for (const d of list) {
            depts.push({ id: d.id, name: d.name, staff_count: d.staffCount || 0 });
            if (d.subDepartments) extractDepts(d.subDepartments);
          }
        };
        extractDepts(data.tree);
        setDepartments(depts);
      }
    } catch (err) {
      console.error('Error fetching org tree:', err);
    }
  };

  const loadChannels = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/channels`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setChannels(data);
      }
    } catch (err) {
      console.error('Error fetching channels:', err);
    }
  };

  const loadRoles = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/roles`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setRoles(data);
        if (data.length > 0 && !selectedRole) {
          setSelectedRole(data[0]);
        }
      }
    } catch (err) {
      console.error('Error fetching roles:', err);
    }
  };

  const loadFilters = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/filters`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setFilterSettings(data);
      }
    } catch (err) {}
  };

  const loadSettings = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSysSettings((prev) => ({ ...prev, ...data }));
      }
    } catch (err) {}
  };

  const loadLicenses = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/licenses`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setLicenseData(data);
      }
    } catch (err) {}
  };

  // ── ACTIONS ──

  // Disconnect active connection
  const handleDisconnectUser = async (userId, userName) => {
    if (!confirm(`Сбросить активную сессию сотрудника ${userName}?`)) return;
    try {
      const res = await fetch(`${serverUrl}/api/admin/server/disconnect-user`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ userId })
      });
      if (res.ok) {
        showToast(`Сессия ${userName} сброшена`);
        loadServerOverview();
      }
    } catch (err) {
      alert('Ошибка: ' + err.message);
    }
  };

  // User Add / Edit
  const openCreateForm = () => {
    setFormData({
      username: '',
      full_name: '',
      job_title: 'Сотрудник',
      department_id: departments[0]?.id || 1,
      role_id: 2,
      extension: '',
      uin: Math.floor(1000 + Math.random() * 8999),
      email: '',
      phone: '',
      password: 'admin'
    });
    setEditingUser(null);
    setFormMode('create');
  };

  const openEditForm = (user) => {
    setFormData({
      username: user.username,
      full_name: user.full_name || '',
      job_title: user.job_title || '',
      department_id: user.department_id || (departments[0]?.id || 1),
      role_id: user.role_id || 2,
      extension: user.extension || '',
      uin: user.uin || '',
      email: user.email || '',
      phone: user.phone || '',
      password: ''
    });
    setEditingUser(user);
    setFormMode('edit');
  };

  const handleSaveUser = async (e) => {
    e.preventDefault();
    try {
      if (formMode === 'create') {
        const res = await fetch(`${serverUrl}/api/admin/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(formData)
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Ошибка при создании');
        }
        showToast(`Сотрудник ${formData.full_name} успешно добавлен (UIN ${formData.uin})`);
      } else if (formMode === 'edit') {
        const res = await fetch(`${serverUrl}/api/admin/users/${editingUser.id}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(formData)
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Ошибка при обновлении');
        }
        showToast(`Данные сотрудника ${formData.full_name} сохранены`);
      }
      setFormMode(null);
      loadUsers();
      if (onRefreshData) onRefreshData();
    } catch (err) {
      alert(err.message);
    }
  };

  // Toggle user active
  const handleToggleActive = async (user) => {
    const actionName = user.is_active ? 'заблокировать' : 'разблокировать';
    if (!confirm(`Вы действительно хотите ${actionName} учетную запись ${user.full_name}?`)) return;
    try {
      const res = await fetch(`${serverUrl}/api/admin/users/${user.id}/toggle-active`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        showToast(`Статус учетной записи ${user.full_name} изменен`);
        loadUsers();
        if (onRefreshData) onRefreshData();
      }
    } catch (err) {
      alert(err.message);
    }
  };

  // Reset password
  const handleResetPassword = async (user) => {
    const newPass = prompt(`Введите новый пароль для сотрудника ${user.full_name} (логин: ${user.username}):`, '123456');
    if (!newPass) return;
    try {
      const res = await fetch(`${serverUrl}/api/admin/users/${user.id}/reset-password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: newPass })
      });
      if (res.ok) {
        showToast(`Пароль для ${user.full_name} успешно установлен: ${newPass}`);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  // Channel Creation
  const handleCreateChannel = async (e) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    try {
      const res = await fetch(`${serverUrl}/api/admin/channels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: newChannelName.trim(),
          topic: newChannelTopic.trim()
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Ошибка создания конференции');
      }
      showToast(`Конференция ${newChannelName} успешно создана`);
      setNewChannelName('');
      setNewChannelTopic('');
      loadChannels();
      if (onRefreshData) onRefreshData();
    } catch (err) {
      alert(err.message);
    }
  };

  // Channel Deletion
  const handleDeleteChannel = async (channel) => {
    if (!confirm(`Удалить конференцию "${channel.name}" и всю историю сообщений в ней?`)) return;
    try {
      const res = await fetch(`${serverUrl}/api/admin/channels/${channel.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Ошибка удаления');
      }
      showToast(`Конференция ${channel.name} удалена`);
      loadChannels();
      if (onRefreshData) onRefreshData();
    } catch (err) {
      alert(err.message);
    }
  };

  // Audit Search
  const handleSearchAudit = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${serverUrl}/api/admin/audit/messages?q=${encodeURIComponent(auditQuery)}&limit=100`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAuditResults(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Port Test
  const handleRunPortTest = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${serverUrl}/api/admin/tools/port-test`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setPortTestResult(data);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  // DB Vacuum
  const handleRunVacuum = async () => {
    if (!confirm('Выполнить оптимизацию, очистку WAL и переиндексацию базы данных SQLite?')) return;
    try {
      setLoading(true);
      const res = await fetch(`${serverUrl}/api/admin/tools/vacuum`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setVacuumResult(data.stats);
        showToast('База данных успешно оптимизирована!');
        loadServerOverview();
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Create Announcement
  const handleCreateAnnouncement = async (e) => {
    e.preventDefault();
    if (!newAnnTitle.trim() || !newAnnText.trim()) return;
    try {
      const res = await fetch(`${serverUrl}/api/announcements`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: newAnnTitle.trim(),
          body: newAnnText.trim(),
          isUrgent: newAnnUrgent
        })
      });
      if (res.ok) {
        showToast('Оповещение успешно отправлено на экраны всех сотрудников!');
        setNewAnnTitle('');
        setNewAnnText('');
        setNewAnnUrgent(false);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  // Save Filters
  const handleSaveFilters = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${serverUrl}/api/admin/filters`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(filterSettings)
      });
      if (res.ok) {
        showToast('Настройки фильтров и антифлуда сохранены');
      }
    } catch (err) {
      alert(err.message);
    }
  };

  // Save Settings
  const handleSaveSettings = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${serverUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sysSettings)
      });
      if (res.ok) {
        showToast('Параметры сервера MyChat успешно сохранены');
        loadServerOverview();
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const handleTestTelegram = async () => {
    if (!sysSettings.telegram_bot_token.trim()) {
      alert('Укажите токен бота перед проверкой связи.');
      return;
    }
    setTelegramTesting(true);
    setTelegramTestResult(null);
    try {
      const res = await fetch(`${serverUrl}/api/admin/telegram/test`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          bot_token: sysSettings.telegram_bot_token.trim(),
          chat_id: sysSettings.telegram_channel_id.trim()
        })
      });
      const data = await res.json();
      setTelegramTestResult(data);
    } catch (err) {
      setTelegramTestResult({ success: false, error: err.message });
    } finally {
      setTelegramTesting(false);
    }
  };

  // Filtered Users List
  const filteredUsers = users.filter((u) => {
    if (userSubTab === 'banned' && u.is_active !== 0) return false;
    const matchSearch =
      !userSearch ||
      (u.full_name && u.full_name.toLowerCase().includes(userSearch.toLowerCase())) ||
      (u.username && u.username.toLowerCase().includes(userSearch.toLowerCase())) ||
      (u.uin && String(u.uin).includes(userSearch)) ||
      (u.extension && String(u.extension).includes(userSearch));
    const matchDept = !selectedDeptFilter || String(u.department_id) === String(selectedDeptFilter);
    return matchSearch && matchDept;
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="admin-console-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Console Header */}
        <div className="admin-console-header">
          <div className="admin-console-title">
            <span style={{ fontSize: '18px' }}>🛡️</span>
            <span>Консоль управления MyChat Server 2025.3.1</span>
            <span style={{ fontSize: '11px', background: '#2563eb', padding: '2px 8px', borderRadius: '10px' }}>
              АО СК "Сентрас Иншуранс"
            </span>
          </div>
          <button className="btn-close-modal" onClick={onClose}>✕</button>
        </div>

        {/* Global Toast Notification */}
        {statusMsg && (
          <div style={{ background: '#dcfce7', color: '#15803d', padding: '8px 16px', fontSize: '12px', fontWeight: 600, borderBottom: '1px solid #86efac' }}>
            ✓ {statusMsg}
          </div>
        )}

        <div className="admin-console-body">
          {/* Sidebar Nav: Official 8 Categories */}
          <div className="admin-sidebar">
            <div className="admin-sidebar-nav">
              <button
                className={`admin-nav-item ${activeTab === 'server' ? 'active' : ''}`}
                onClick={() => setActiveTab('server')}
              >
                <span>🖥️</span> <span>MyChat Server</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'users' ? 'active' : ''}`}
                onClick={() => setActiveTab('users')}
              >
                <span>👥</span> <span>Пользователи</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'conferences' ? 'active' : ''}`}
                onClick={() => setActiveTab('conferences')}
              >
                <span>💬</span> <span>Конференции</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'rights' ? 'active' : ''}`}
                onClick={() => setActiveTab('rights')}
              >
                <span>🛡️</span> <span>Управление правами</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'tools' ? 'active' : ''}`}
                onClick={() => setActiveTab('tools')}
              >
                <span>🛠️</span> <span>Инструменты</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'filters' ? 'active' : ''}`}
                onClick={() => setActiveTab('filters')}
              >
                <span>🛑</span> <span>Фильтры</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'settings' ? 'active' : ''}`}
                onClick={() => setActiveTab('settings')}
              >
                <span>⚙️</span> <span>Настройки</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'licenses' ? 'active' : ''}`}
                onClick={() => setActiveTab('licenses')}
              >
                <span>📜</span> <span>Лицензии</span>
              </button>
            </div>

            <div className="admin-sidebar-footer">
              <div><strong>Порт чата:</strong> 2004 TCP</div>
              <div><strong>Статус:</strong> <span style={{ color: '#16a34a' }}>● Активен</span></div>
              <div><strong>Версия:</strong> 2025.3.1</div>
            </div>
          </div>

          {/* Main Content Workspace */}
          <div className="admin-content-area">
            {currentUser && currentUser.role_id === 3 && (
              <div className="scoped-admin-banner">
                <span>🛡️</span>
                <span>Вы авторизованы как <strong>Контурный администратор</strong>. Вам доступно управление сотрудниками только вашего подразделения.</span>
              </div>
            )}


            {/* TAB 1: MYCHAT SERVER (info.html) */}
            {activeTab === 'server' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: '#1e293b' }}>
                  Общая информация о сервере MyChat (info.html)
                </h3>

                <div className="admin-server-cards-grid">
                  <div className="admin-stat-card">
                    <span className="admin-stat-label">Сетевой адрес (IP)</span>
                    <span className="admin-stat-value" style={{ fontSize: '15px' }}>
                      {serverOverview?.lan_ip || '127.0.0.1'}:2004
                    </span>
                  </div>
                  <div className="admin-stat-card">
                    <span className="admin-stat-label">Время непрерывной работы</span>
                    <span className="admin-stat-value">
                      {Math.floor((serverOverview?.uptime_seconds || 0) / 60)} мин.
                    </span>
                  </div>
                  <div className="admin-stat-card">
                    <span className="admin-stat-label">Подключений онлайн</span>
                    <span className="admin-stat-value" style={{ color: '#16a34a' }}>
                      {onlineList.length}
                    </span>
                  </div>
                  <div className="admin-stat-card">
                    <span className="admin-stat-label">Всего сотрудников</span>
                    <span className="admin-stat-value">{users.length}</span>
                  </div>
                </div>

                <div style={{ marginTop: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h4 style={{ margin: 0, color: '#1e293b' }}>
                      Активные подключения в сети ({onlineList.length})
                    </h4>
                    <button className="admin-btn-action" onClick={loadServerOverview}>
                      🔄 Обновить
                    </button>
                  </div>

                  <div className="admin-table-container">
                    <table className="admin-data-table">
                      <thead>
                        <tr>
                          <th>UIN</th>
                          <th>Сотрудник</th>
                          <th>Отдел</th>
                          <th>IP-адрес</th>
                          <th>Клиент</th>
                          <th>Пинг</th>
                          <th>Действия</th>
                        </tr>
                      </thead>
                      <tbody>
                        {onlineList.length === 0 ? (
                          <tr>
                            <td colSpan={7} style={{ textAlign: 'center', color: '#94a3b8', padding: '20px' }}>
                              Нет активных соединений
                            </td>
                          </tr>
                        ) : (
                          onlineList.map((conn, idx) => (
                            <tr key={idx}>
                              <td><strong>{conn.uin}</strong></td>
                              <td>{conn.full_name} ({conn.username})</td>
                              <td>{conn.department_name}</td>
                              <td><code>{conn.ip}</code></td>
                              <td>{conn.clientType}</td>
                              <td><span style={{ color: '#16a34a' }}>{conn.pingMs} мс</span></td>
                              <td>
                                <button
                                  className="admin-btn-action"
                                  style={{ color: '#dc2626' }}
                                  onClick={() => handleDisconnectUser(conn.userId, conn.full_name)}
                                  title="Принудительно сбросить сессию"
                                >
                                  Сбросить сокет
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: USERS MANAGEMENT (usersmanage.html) */}
            {activeTab === 'users' && (
              <div className="admin-tab-pane">
                {/* Sub-tabs */}
                <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '10px', marginBottom: '14px' }}>
                  <button
                    className={`admin-btn-action ${userSubTab === 'list' ? 'highlight-admin' : ''}`}
                    onClick={() => setUserSubTab('list')}
                  >
                    📋 Список пользователей ({users.length})
                  </button>
                  <button
                    className={`admin-btn-action ${userSubTab === 'banned' ? 'highlight-admin' : ''}`}
                    onClick={() => setUserSubTab('banned')}
                  >
                    ⛔ Заблокированные (Бан-лист) ({users.filter((u) => u.is_active === 0).length})
                  </button>
                  <button
                    className={`admin-btn-action ${userSubTab === 'departments' ? 'highlight-admin' : ''}`}
                    onClick={() => setUserSubTab('departments')}
                  >
                    🏢 Подразделения и контуры ({departments.length})
                  </button>
                  <button
                    className={'admin-btn-action ' + (userSubTab === 'devices' ? 'highlight-admin' : '')}
                    onClick={() => { setUserSubTab('devices'); loadPendingDevices(); }}
                  >
                    💻 Стучащиеся клиенты (Очередь по IP) ({pendingDevices.length})
                  </button>
                  <button
                    className={'admin-btn-action ' + (userSubTab === 'parser' ? 'highlight-admin' : '')}
                    onClick={() => setUserSubTab('parser')}
                  >
                    ⚡ Импорт и парсер оргструктуры
                  </button>

                </div>

                
                {/* SUBTAB: PENDING DEVICES QUEUE */}
                {userSubTab === 'devices' && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                      <div>
                        <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Очередь подключений по IP (Стучащиеся клиенты)</h4>
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b' }}>
                          Клиенты при первом запуске автоматически отправляют сетевой запрос. Свяжите узел с сотрудником для входа без пароля.
                        </p>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="btn btn-secondary" onClick={loadPendingDevices}>
                          🔄 Обновить
                        </button>
                        <button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={handleAutoMatchIp}>
                          ⚡ Автосвязывание по IP
                        </button>
                      </div>
                    </div>

                    {/* KPI Stat Cards for Devices */}
                    <div className="admin-server-cards-grid" style={{ marginBottom: '14px' }}>
                      <div className="admin-stat-card">
                        <span className="admin-stat-label">Всего узлов в очереди</span>
                        <span className="admin-stat-value">{pendingDevices.length}</span>
                      </div>
                      <div className="admin-stat-card">
                        <span className="admin-stat-label">Успешно авторизовано</span>
                        <span className="admin-stat-value" style={{ color: '#16a34a' }}>
                          {pendingDevices.filter((d) => d.status === 'paired').length}
                        </span>
                      </div>
                      <div className="admin-stat-card">
                        <span className="admin-stat-label">Ожидает связывания</span>
                        <span className="admin-stat-value" style={{ color: '#ea580c' }}>
                          {pendingDevices.filter((d) => d.status !== 'paired').length}
                        </span>
                      </div>
                      <div
                        className="admin-stat-card"
                        style={{ cursor: 'pointer', background: '#f0fdf4', borderColor: '#bbf7d0' }}
                        onClick={handleAutoMatchIp}
                        title="Нажмите для запуска автосвязывания по IP"
                      >
                        <span className="admin-stat-label" style={{ color: '#166534' }}>⚡ Готовы к связке</span>
                        <span className="admin-stat-value" style={{ color: '#15803d', fontSize: '18px' }}>
                          {pendingDevices.filter((d) => d.suggested_user && d.status !== 'paired').length} ПК
                        </span>
                      </div>
                    </div>

                    {/* Devices Filter Toolbar */}
                    <div className="admin-table-toolbar" style={{ marginBottom: '10px' }}>
                      <input
                        type="text"
                        className="admin-filter-input"
                        placeholder="Поиск узла по имени ПК, IP-адресу, платформе..."
                        value={deviceSearch}
                        onChange={(e) => setDeviceSearch(e.target.value)}
                        style={{ maxWidth: '380px' }}
                      />
                    </div>

                    <div className="admin-table-container">
                      <table className="admin-data-table">
                        <thead>
                          <tr>
                            <th>Узел / Имя ПК</th>
                            <th>IP-адрес</th>
                            <th>Платформа</th>
                            <th>Статус</th>
                            <th>Последнее обращение</th>
                            <th>Связанный сотрудник / Рекомендация</th>
                            <th>Действие</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pendingDevices.length === 0 ? (
                            <tr>
                              <td colSpan="7" style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                                Очередь пуста. Новые устройства появятся здесь при первом запуске клиента в сети.
                              </td>
                            </tr>
                          ) : (
                            pendingDevices.filter((d) => {
                              if (!deviceSearch.trim()) return true;
                              const q = deviceSearch.toLowerCase();
                              return (
                                (d.device_name || '').toLowerCase().includes(q) ||
                                (d.ip_address || '').toLowerCase().includes(q) ||
                                (d.platform || '').toLowerCase().includes(q) ||
                                (d.paired_user_name || '').toLowerCase().includes(q) ||
                                (d.suggested_user?.full_name || '').toLowerCase().includes(q)
                              );
                            }).map((d) => (
                              <tr key={d.device_id}>
                                <td><strong>{d.device_name || 'ПК сотрудника'}</strong><br/><small style={{ color: '#94a3b8' }}>{d.device_id}</small></td>
                                <td><code>{d.ip_address}</code></td>
                                <td>{d.platform}</td>
                                <td>
                                  {d.status === 'paired' ? (
                                    <span className="device-badge-paired">Привязан</span>
                                  ) : (
                                    <span className="device-badge-pending">Ожидает связывания</span>
                                  )}
                                </td>
                                <td>{d.last_knock_at ? new Date(d.last_knock_at).toLocaleTimeString() : '—'}</td>
                                <td>
                                  {d.paired_user_name ? (
                                    <span style={{ color: '#166534', fontWeight: 600 }}>👤 {d.paired_user_name}</span>
                                  ) : d.suggested_user ? (
                                    <span style={{ color: '#2563eb' }}>💡 Совпадение IP: {d.suggested_user.full_name}</span>
                                  ) : (
                                    <span style={{ color: '#94a3b8' }}>Не назначен</span>
                                  )}
                                </td>
                                <td>
                                  {d.status === 'paired' ? (
                                    <button
                                      className="admin-btn-action"
                                      onClick={() => handleUnbindDevice(d.device_id)}
                                      title="Отвязать узел"
                                    >
                                      Отвязать
                                    </button>
                                  ) : (
                                    <button
                                      className="btn btn-primary"
                                      style={{ padding: '4px 10px', fontSize: '11px' }}
                                      onClick={() => {
                                        setSelectedDeviceForPair(d);
                                        setPairUserId(d.suggested_user ? d.suggested_user.id : '');
                                      }}
                                    >
                                      Связать...
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* Pairing Modal */}
                    {selectedDeviceForPair && (
                      <div className="modal-backdrop" onClick={() => setSelectedDeviceForPair(null)}>
                        <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
                          <div className="modal-header">
                            <h4>Связать узел с сотрудником</h4>
                            <button className="btn-close-modal" onClick={() => setSelectedDeviceForPair(null)}>✕</button>
                          </div>
                          <div style={{ padding: '16px' }}>
                            <p style={{ fontSize: '12px', marginBottom: '12px' }}>
                              Узел: <strong>{selectedDeviceForPair.device_name}</strong> (IP: <code>{selectedDeviceForPair.ip_address}</code>)
                            </p>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Выберите сотрудника из базы:</label>
                            <select
                              className="form-control"
                              style={{ width: '100%', padding: '8px', marginTop: '6px', marginBottom: '16px' }}
                              value={pairUserId}
                              onChange={(e) => setPairUserId(e.target.value)}
                            >
                              <option value="">-- Выберите сотрудника --</option>
                              {users.filter((u) => u.is_active === 1).map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.full_name} ({u.department_name || 'Без отдела'}) {u.bound_ip ? '[' + u.bound_ip + ']' : ''}
                                </option>
                              ))}
                            </select>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                              <button className="btn btn-secondary" onClick={() => setSelectedDeviceForPair(null)}>Отмена</button>
                              <button
                                className="btn btn-primary"
                                onClick={() => handleBindDevice(selectedDeviceForPair.device_id, pairUserId, selectedDeviceForPair.ip_address)}
                              >
                                Сохранить и авторизовать
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* SUBTAB: ORG PARSER & BATCH IMPORT */}
                {userSubTab === 'parser' && (
                  <div className="parser-container">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Универсальный парсер и пакетный импорт оргструктуры</h4>
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#64748b' }}>
                          Вставьте структуру отделов и сотрудников в произвольном формате: пути со слэшем (/), отступы (дерево) или CSV.
                        </p>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '11px' }}
                          onClick={() => {
                            setParserFormat('path');
                            setParserText('АО СК Сентрас Иншуранс / Департамент Web-разработок / Управление Front / Отдел UI / Сейдалин Мурат | mseidalin | 192.168.10.60 | 2415 | Разработчик React | mseidalin@cic.kz\nАО СК Сентрас Иншуранс / Департамент Web-разработок / Управление Back / Отдел Core / Касымов Арман | akasymov | 192.168.10.61 | 2416 | Архитектор | akasymov@cic.kz\nАО СК Сентрас Иншуранс / HR-Департамент / Отдел Кадров / Жумабаева Асель | azhumabaeva | 192.168.10.65 | 2210 | HR-Специалист');
                          }}
                        >
                          Шаблон: Пути (/)
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '11px' }}
                          onClick={() => {
                            setParserFormat('indent');
                            setParserText('АО СК Сентрас Иншуранс\n  Департамент Web-разработок\n    Управление мобильных систем\n      Отдел iOS и Android\n        Бериков Нурлан (login: nberikov, ip: 192.168.10.80, phone: 2420, job: Mobile Dev)\n        Смагулов Ерлан (login: esmagulov, ip: 192.168.10.81, phone: 2421)');
                          }}
                        >
                          Шаблон: Отступы
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '11px' }}
                          onClick={() => {
                            setParserFormat('csv');
                            setParserText('Компания;Департамент;Управление;Отдел;ФИО;Логин;IP;Телефон;Должность;Email\nАО СК Сентрас Иншуранс;Департамент Андеррайтинга;Управление автострахования;Сектор КАСКО;Калиев Даурен;dkaliev;192.168.10.90;2150;Андеррайтер;dkaliev@cic.kz');
                          }}
                        >
                          Шаблон: CSV
                        </button>
                      </div>
                    </div>

                    <textarea
                      className="parser-textarea"
                      placeholder="Вставьте сюда текст оргструктуры и сотрудников..."
                      value={parserText}
                      onChange={(e) => setParserText(e.target.value)}
                    />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', color: '#64748b' }}>Формат:</span>
                        <select
                          value={parserFormat}
                          onChange={(e) => setParserFormat(e.target.value)}
                          className="admin-filter-select"
                        >
                          <option value="auto">Автоопределение</option>
                          <option value="path">Пути со слэшем (/)</option>
                          <option value="indent">Дерево с отступами</option>
                          <option value="csv">Таблица CSV</option>
                        </select>
                      </div>

                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button className="btn btn-secondary" onClick={handlePreviewParser} disabled={parserLoading}>
                          🔍 Предпросмотр структуры
                        </button>
                        <button
                          className="btn btn-primary"
                          style={{ background: '#2563eb' }}
                          onClick={handleApplyParser}
                          disabled={parserLoading}
                        >
                          ⚡ Применить импорт в базу данных
                        </button>
                      </div>
                    </div>

                    {/* Preview Area */}
                    {parserPreview && (
                      <div className="parser-preview-box">
                        <div style={{ display: 'flex', gap: '20px', marginBottom: '10px', fontWeight: 600, color: '#1e293b' }}>
                          <span>🏢 Подразделений к созданию: {parserPreview.stats.departmentsCount}</span>
                          <span>👤 Сотрудников к созданию/обновлению: {parserPreview.stats.employeesCount}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                          <div>
                            <strong style={{ fontSize: '11px', color: '#64748b' }}>ИЕРАРХИЯ ПОДРАЗДЕЛЕНИЙ:</strong>
                            <div style={{ marginTop: '6px' }}>
                              {parserPreview.departments.map((d, i) => (
                                <div key={i} className="parser-tree-item" style={{ paddingLeft: ((d.level - 1) * 16) + 'px' }}>
                                  {d.level === 1 ? '🏢' : d.level === 2 ? '🏛️' : '👥'} {d.name} <small style={{ color: '#94a3b8' }}>({d.dept_type})</small>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <strong style={{ fontSize: '11px', color: '#64748b' }}>СОТРУДНИКИ:</strong>
                            <div style={{ marginTop: '6px' }}>
                              {parserPreview.employees.map((e, i) => (
                                <div key={i} className="parser-tree-item">
                                  👤 <strong>{e.full_name}</strong> ({e.username})
                                  {e.bound_ip && <code style={{ marginLeft: '6px', fontSize: '10px' }}>IP: {e.bound_ip}</code>}
                                  {e.extension && <span style={{ marginLeft: '6px', color: '#64748b', fontSize: '11px' }}>вн.{e.extension}</span>}
                                  <div style={{ fontSize: '10px', color: '#94a3b8', paddingLeft: '16px' }}>{e.department_path}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {userSubTab === 'departments' ? (
                  <div>
                    <h4 style={{ marginBottom: '10px' }}>Штатная структура подразделений АО СК "Сентрас Иншуранс"</h4>
                    <div className="admin-table-container">
                      <table className="admin-data-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Название департамента / отдела</th>
                            <th>Штатная численность</th>
                          </tr>
                        </thead>
                        <tbody>
                          {departments.map((d) => (
                            <tr key={d.id}>
                              <td>{d.id}</td>
                              <td><strong>{d.name}</strong></td>
                              <td>{users.filter((u) => u.department_id === d.id).length} чел.</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="admin-table-toolbar">
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input
                          type="text"
                          className="admin-filter-input"
                          placeholder="Поиск по ФИО, логину, UIN..."
                          value={userSearch}
                          onChange={(e) => setUserSearch(e.target.value)}
                        />
                        <select
                          className="admin-filter-select"
                          value={selectedDeptFilter}
                          onChange={(e) => setSelectedDeptFilter(e.target.value)}
                        >
                          <option value="">Все отделы компании</option>
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                          ))}
                        </select>
                      </div>

                      <button
                        className="btn btn-primary"
                        style={{ background: '#2563eb', padding: '6px 14px', fontSize: '12px' }}
                        onClick={openCreateForm}
                      >
                        + Добавить сотрудника
                      </button>
                    </div>

                    <div className="admin-table-container">
                      <table className="admin-data-table">
                        <thead>
                          <tr>
                            <th>UIN</th>
                            <th>Логин</th>
                            <th>ФИО сотрудника</th>
                            <th>Должность</th>
                            <th>Отдел</th>
                            <th>Внутр. тел.</th>
                            <th>Связка ПК / IP</th>
                            <th>Роль</th>
                            <th>Статус</th>
                            <th>Действия</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredUsers.map((u) => (
                            <tr key={u.id}>
                              <td><strong>{u.uin || u.id}</strong></td>
                              <td><code>{u.username}</code></td>
                              <td>{u.full_name}</td>
                              <td>{u.job_title || '—'}</td>
                              <td>{u.department_name || '—'}</td>
                              <td>{u.extension || '—'}</td>
                              <td>
                                {u.paired_device_name ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <span className="device-badge-paired" title={`Device ID: ${u.paired_device_id || ''}\nIP: ${u.bound_ip || 'Динамический'}`}>
                                      💻 {u.paired_device_name}
                                    </span>
                                    {u.paired_device_id && (
                                      <button
                                        className="admin-btn-action"
                                        style={{ padding: '1px 5px', fontSize: '10px', color: '#dc2626' }}
                                        onClick={() => handleUnbindDevice(u.paired_device_id)}
                                        title="Отвязать узел"
                                      >
                                        ✕
                                      </button>
                                    )}
                                  </div>
                                ) : u.bound_ip ? (
                                  <span className="device-badge-pending" title="Привязан статический IP сотрудника">
                                    🌐 {u.bound_ip}
                                  </span>
                                ) : (
                                  <button
                                    className="admin-btn-action"
                                    style={{ fontSize: '10px', color: '#2563eb' }}
                                    onClick={() => {
                                      setUserSubTab('devices');
                                      loadPendingDevices();
                                    }}
                                    title="Связать со стучащимся ПК"
                                  >
                                    + Связать ПК
                                  </button>
                                )}
                              </td>
                              <td>{u.role_name}</td>
                              <td>
                                {u.is_active === 1 ? (
                                  <span className="admin-badge-ok">Активен</span>
                                ) : (
                                  <span className="admin-badge-off">Заблокирован</span>
                                )}
                              </td>
                              <td style={{ display: 'flex', gap: '4px' }}>
                                <button
                                  className="admin-btn-action"
                                  onClick={() => openEditForm(u)}
                                  title="Редактировать сотрудника"
                                >
                                  ✏️
                                </button>
                                <button
                                  className="admin-btn-action"
                                  onClick={() => handleToggleActive(u)}
                                  title={u.is_active ? 'Заблокировать' : 'Разблокировать'}
                                >
                                  {u.is_active ? '⛔' : '✅'}
                                </button>
                                <button
                                  className="admin-btn-action"
                                  onClick={() => handleResetPassword(u)}
                                  title="Сбросить пароль"
                                >
                                  🔑
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {/* Form Modal (Create / Edit User) */}
                {formMode && (
                  <div className="modal-backdrop" onClick={() => setFormMode(null)}>
                    <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
                      <div className="modal-header">
                        <h4>{formMode === 'create' ? 'Добавить нового сотрудника' : 'Редактирование профиля'}</h4>
                        <button className="btn-close-modal" onClick={() => setFormMode(null)}>✕</button>
                      </div>
                      <form onSubmit={handleSaveUser} style={{ padding: '16px' }}>
                        <div className="form-group" style={{ marginBottom: '12px' }}>
                          <label style={{ fontSize: '11px', fontWeight: 600 }}>ФИО сотрудника *</label>
                          <input
                            type="text"
                            required
                            className="form-control"
                            style={{ width: '100%', padding: '6px' }}
                            value={formData.full_name}
                            onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                          />
                        </div>

                        <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Логин *</label>
                            <input
                              type="text"
                              required
                              disabled={formMode === 'edit'}
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.username}
                              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                            />
                          </div>
                          <div style={{ width: '120px' }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>UIN *</label>
                            <input
                              type="number"
                              required
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.uin}
                              onChange={(e) => setFormData({ ...formData, uin: e.target.value })}
                            />
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Должность</label>
                            <input
                              type="text"
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.job_title}
                              onChange={(e) => setFormData({ ...formData, job_title: e.target.value })}
                            />
                          </div>
                          <div style={{ width: '120px' }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Внутр. номер</label>
                            <input
                              type="text"
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.extension}
                              onChange={(e) => setFormData({ ...formData, extension: e.target.value })}
                            />
                          </div>
                        </div>

                        
                        <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Закрепленный IP (для автоподключения)</label>
                            <input
                              type="text"
                              placeholder="192.168.10.45"
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.bound_ip || ''}
                              onChange={(e) => setFormData({ ...formData, bound_ip: e.target.value })}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Контур управления (для контурных админов)</label>
                            <select
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.admin_scope_dept_id || ''}
                              onChange={(e) => setFormData({ ...formData, admin_scope_dept_id: e.target.value })}
                            >
                              <option value="">Не назначен (Глобальный)</option>
                              {departments.map((d) => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>
<div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Департамент / Отдел</label>
                            <select
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.department_id}
                              onChange={(e) => setFormData({ ...formData, department_id: Number(e.target.value) })}
                            >
                              {departments.map((d) => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                              ))}
                            </select>
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Группа прав (Роль)</label>
                            <select
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.role_id}
                              onChange={(e) => setFormData({ ...formData, role_id: Number(e.target.value) })}
                            >
                              {roles.map((r) => (
                                <option key={r.id} value={r.id}>{r.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {formMode === 'create' && (
                          <div className="form-group" style={{ marginBottom: '14px' }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Пароль при создании</label>
                            <input
                              type="password"
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.password}
                              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                            />
                          </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
                          <button type="button" className="btn btn-secondary" onClick={() => setFormMode(null)}>
                            Отмена
                          </button>
                          <button type="submit" className="btn btn-primary">
                            {formMode === 'create' ? 'Создать пользователя' : 'Сохранить изменения'}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: CONFERENCES (conference.html) */}
            {activeTab === 'conferences' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: '#1e293b' }}>
                  Управление корпоративными конференциями (conference.html)
                </h3>
                <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '16px' }}>
                  Список текстовых конференций с автоматическим добавлением сотрудников.
                </p>

                {/* Create Channel Form */}
                <form onSubmit={handleCreateChannel} style={{ display: 'flex', gap: '10px', marginBottom: '20px', background: '#f8fafc', padding: '14px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <input
                    type="text"
                    required
                    placeholder="Название (#Продажи, #Маркетинг)..."
                    className="admin-filter-input"
                    style={{ width: '220px' }}
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Тема конференции (Topic)..."
                    className="admin-filter-input"
                    style={{ flex: 1 }}
                    value={newChannelTopic}
                    onChange={(e) => setNewChannelTopic(e.target.value)}
                  />
                  <button type="submit" className="btn btn-primary" style={{ fontSize: '12px' }}>
                    + Создать конференцию
                  </button>
                </form>

                <div className="admin-table-container">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Название конференции</th>
                        <th>Тема (Topic)</th>
                        <th>Участников</th>
                        <th>Сообщений</th>
                        <th>Тип</th>
                        <th>Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channels.map((c) => (
                        <tr key={c.id}>
                          <td>{c.id}</td>
                          <td><strong>{c.name}</strong></td>
                          <td>{c.topic || '—'}</td>
                          <td>{c.members_count || 0} сотрудников</td>
                          <td>{c.total_messages || 0}</td>
                          <td>
                            <span className="admin-badge-ok">
                              {c.name === '#Общий' ? 'Системный канал' : 'Общедоступный'}
                            </span>
                          </td>
                          <td>
                            {c.name !== '#Общий' ? (
                              <button
                                className="admin-btn-action"
                                style={{ color: '#dc2626' }}
                                onClick={() => handleDeleteChannel(c)}
                              >
                                ✕ Удалить
                              </button>
                            ) : (
                              <span style={{ fontSize: '11px', color: '#94a3b8' }}>По умолчанию</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 4: GROUP RIGHTS (grouprightsmanage.html) */}
            {activeTab === 'rights' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: '#1e293b' }}>
                  Управление группами прав и ограничениями (grouprightsmanage.html)
                </h3>
                <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '16px' }}>
                  Разграничение прав доступа для ролей пользователей: приватные диалоги, файлы, звонки и удаленный рабочий стол.
                </p>

                <div className="admin-rights-grid">
                  {roles.map((r) => {
                    const p = r.permissions || {};
                    return (
                      <div key={r.id} className="admin-rights-card">
                        <h4>
                          <span>{r.name}</span>
                          <span style={{ fontSize: '11px', color: '#2563eb' }}>ID: {r.id}</span>
                        </h4>
                        <p style={{ fontSize: '11px', color: '#64748b', marginBottom: '12px' }}>
                          {r.description}
                        </p>
                        <div className="admin-rights-list">
                          <div className="admin-right-item">
                            <span>{p.is_admin ? '✅' : '❌'}</span>
                            <span>Доступ к консоли управления сервером</span>
                          </div>
                          <div className="admin-right-item">
                            <span>{p.can_manage_users ? '✅' : '❌'}</span>
                            <span>Управление пользователями и блокировками</span>
                          </div>
                          <div className="admin-right-item">
                            <span>{p.can_remote_control ? '✅' : '❌'}</span>
                            <span><strong>Удаленный рабочий стол (Screen Assist)</strong></span>
                          </div>
                          <div className="admin-right-item">
                            <span>{p.can_call !== false ? '✅' : '❌'}</span>
                            <span>WebRTC аудио- и видеозвонки</span>
                          </div>
                          <div className="admin-right-item">
                            <span>{p.can_upload_files !== false ? '✅' : '❌'}</span>
                            <span>Передача файлов (до 100 МБ)</span>
                          </div>
                          <div className="admin-right-item">
                            <span>{p.can_broadcast ? '✅' : '❌'}</span>
                            <span>Публикация на общей доске объявлений</span>
                          </div>
                          <div className="admin-right-item">
                            <span>{p.can_create_channels !== false ? '✅' : '❌'}</span>
                            <span>Создание публичных конференций</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TAB 5: TOOLS (tools.html) */}
            {activeTab === 'tools' && (
              <div className="admin-tab-pane">
                <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '10px', marginBottom: '16px' }}>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'audit' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('audit')}
                  >
                    🔍 Просмотр протоколов (logsviewer.html)
                  </button>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'ports' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('ports')}
                  >
                    🌐 Тест портов (toolstestmychatports.html)
                  </button>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'vacuum' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('vacuum')}
                  >
                    🗄️ Обслуживание SQLite БД
                  </button>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'announcements' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('announcements')}
                  >
                    📢 Доска объявлений
                  </button>
                </div>

                {toolSubTab === 'audit' && (
                  <div>
                    <h4 style={{ marginBottom: '8px' }}>Аудит и поиск по истории сообщений</h4>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                      <input
                        type="text"
                        placeholder="Поиск по фразе или автору..."
                        className="admin-filter-input"
                        style={{ flex: 1 }}
                        value={auditQuery}
                        onChange={(e) => setAuditQuery(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchAudit()}
                      />
                      <button className="btn btn-primary" onClick={handleSearchAudit}>
                        Найти в протоколах
                      </button>
                    </div>

                    <div className="admin-table-container" style={{ maxHeight: '350px' }}>
                      <table className="admin-data-table">
                        <thead>
                          <tr>
                            <th>Дата/Время</th>
                            <th>Отправитель</th>
                            <th>Получатель / Канал</th>
                            <th>Текст сообщения</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditResults.length === 0 ? (
                            <tr>
                              <td colSpan={4} style={{ textAlign: 'center', color: '#94a3b8', padding: '20px' }}>
                                Введите ключевое слово для поиска по протоколам переписки
                              </td>
                            </tr>
                          ) : (
                            auditResults.map((m) => (
                              <tr key={m.id}>
                                <td style={{ whiteSpace: 'nowrap', fontSize: '11px', color: '#64748b' }}>
                                  {new Date(m.created_at).toLocaleString()}
                                </td>
                                <td><strong>{m.sender_name}</strong> ({m.sender_username})</td>
                                <td>{m.target_name}</td>
                                <td>{m.text}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {toolSubTab === 'ports' && (
                  <div>
                    <h4 style={{ marginBottom: '8px' }}>Диагностика сетевых портов MyChat Server</h4>
                    <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '14px' }}>
                      Проверка готовности сокетов к подключению клиентов LAN/WAN.
                    </p>
                    <button className="btn btn-primary" onClick={handleRunPortTest} style={{ marginBottom: '14px' }}>
                      ▶ Запустить тестирование портов
                    </button>

                    {portTestResult && (
                      <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', padding: '16px', borderRadius: '6px' }}>
                        <div style={{ color: '#16a34a', fontWeight: 700, marginBottom: '8px' }}>
                          ✓ Статус: {portTestResult.status} (Задержка: {portTestResult.response_time_ms} мс)
                        </div>
                        <div style={{ fontSize: '12px', lineHeight: '1.6' }}>
                          <div><strong>Основной порт чата:</strong> {portTestResult.server_port} TCP (Активен)</div>
                          <div><strong>Протокол сокетов:</strong> {portTestResult.chat_protocol}</div>
                          <div><strong>Панель веб-управления:</strong> {portTestResult.web_admin_protocol}</div>
                          <div><strong>Сетевые интерфейсы:</strong> {portTestResult.network_interfaces?.join(', ')}</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {toolSubTab === 'vacuum' && (
                  <div>
                    <h4 style={{ marginBottom: '8px' }}>Очистка и дефрагментация базы данных SQLite</h4>
                    <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '14px' }}>
                      Выполняет SQL-команду VACUUM, удаляет временные фрагменты журнала WAL и обновляет индексы.
                    </p>
                    <button className="btn btn-primary" onClick={handleRunVacuum} style={{ marginBottom: '14px' }}>
                      🧹 Запустить оптимизацию (VACUUM & ANALYZE)
                    </button>

                    {vacuumResult && (
                      <div style={{ background: '#f0fdf4', border: '1px solid #86efac', padding: '16px', borderRadius: '6px' }}>
                        <h4 style={{ color: '#15803d', margin: '0 0 10px 0' }}>Результат оптимизации:</h4>
                        <div style={{ fontSize: '12px', lineHeight: '1.6' }}>
                          <div><strong>Размер файла базы:</strong> {vacuumResult.dbSizeFormatted}</div>
                          <div><strong>Размер журнала WAL:</strong> {vacuumResult.walSizeFormatted}</div>
                          <div><strong>Целостность (PRAGMA integrity_check):</strong> {vacuumResult.integrity}</div>
                          <div><strong>Всего записей в таблицах:</strong> {vacuumResult.totalRows}</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {toolSubTab === 'announcements' && (
                  <div>
                    <h4 style={{ marginBottom: '8px' }}>Создать общекорпоративное объявление</h4>
                    <form onSubmit={handleCreateAnnouncement} style={{ background: '#f8fafc', padding: '16px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ fontSize: '11px', fontWeight: 600 }}>Заголовок объявления *</label>
                        <input
                          type="text"
                          required
                          className="form-control"
                          style={{ width: '100%', padding: '6px' }}
                          value={newAnnTitle}
                          onChange={(e) => setNewAnnTitle(e.target.value)}
                        />
                      </div>
                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ fontSize: '11px', fontWeight: 600 }}>Текст сообщения *</label>
                        <textarea
                          rows={3}
                          required
                          className="form-control"
                          style={{ width: '100%', padding: '6px' }}
                          value={newAnnText}
                          onChange={(e) => setNewAnnText(e.target.value)}
                        />
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', marginBottom: '14px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={newAnnUrgent}
                          onChange={(e) => setNewAnnUrgent(e.target.checked)}
                        />
                        <span>Срочное оповещение (со звуковым сигналом и обязательным подтверждением прочтения)</span>
                      </label>
                      <button type="submit" className="btn btn-primary">
                        📢 Опубликовать на всех рабочих местах
                      </button>
                    </form>
                  </div>
                )}
              </div>
            )}

            {/* TAB 6: FILTERS (filters.html) */}
            {activeTab === 'filters' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: '#1e293b' }}>
                  Настройка антифлуда и фильтров содержимого (filters.html)
                </h3>

                <form onSubmit={handleSaveFilters} style={{ maxWidth: '600px' }}>
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Антифлуд: максимальное количество сообщений в секунду
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      className="admin-filter-input"
                      value={filterSettings.antiflood_limit}
                      onChange={(e) => setFilterSettings({ ...filterSettings, antiflood_limit: Number(e.target.value) })}
                    />
                    <small style={{ display: 'block', color: '#64748b', marginTop: '4px' }}>
                      При превышении лимита пользователь временно блокируется на 60 секунд.
                    </small>
                  </div>

                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={filterSettings.bad_words_enabled}
                        onChange={(e) => setFilterSettings({ ...filterSettings, bad_words_enabled: e.target.checked })}
                      />
                      <span>Включить фильтрацию нецензурных выражений и стоп-слов</span>
                    </label>
                  </div>

                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Список запрещенных стоп-слов (через запятую)
                    </label>
                    <textarea
                      rows={3}
                      className="form-control"
                      style={{ width: '100%', padding: '6px' }}
                      value={filterSettings.bad_words_list}
                      onChange={(e) => setFilterSettings({ ...filterSettings, bad_words_list: e.target.value })}
                    />
                  </div>

                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Черный список IP-адресов (через запятую)
                    </label>
                    <input
                      type="text"
                      className="admin-filter-input"
                      style={{ width: '100%' }}
                      placeholder="192.168.1.100, 10.0.0.5"
                      value={filterSettings.ip_blacklist}
                      onChange={(e) => setFilterSettings({ ...filterSettings, ip_blacklist: e.target.value })}
                    />
                  </div>

                  <button type="submit" className="btn btn-primary">
                    Сохранить настройки фильтрации
                  </button>
                </form>
              </div>
            )}

            {/* TAB 7: SETTINGS (settings.html) */}
            {activeTab === 'settings' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: '#1e293b' }}>
                  Общие настройки MyChat Server (settings.html)
                </h3>

                <form onSubmit={handleSaveSettings} style={{ maxWidth: '600px' }}>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Наименование организации *
                    </label>
                    <input
                      type="text"
                      required
                      className="form-control"
                      style={{ width: '100%', padding: '6px' }}
                      value={sysSettings.company_name}
                      onChange={(e) => setSysSettings({ ...sysSettings, company_name: e.target.value })}
                    />
                  </div>

                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Имя сервера мессенджера
                    </label>
                    <input
                      type="text"
                      className="form-control"
                      style={{ width: '100%', padding: '6px' }}
                      value={sysSettings.server_name}
                      onChange={(e) => setSysSettings({ ...sysSettings, server_name: e.target.value })}
                    />
                  </div>

                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Таймаут неактивности для перевода в статус «Отошел» (секунды)
                    </label>
                    <input
                      type="number"
                      min={60}
                      max={3600}
                      className="admin-filter-input"
                      value={sysSettings.idle_timeout_seconds}
                      onChange={(e) => setSysSettings({ ...sysSettings, idle_timeout_seconds: e.target.value })}
                    />
                  </div>

                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Максимальный размер вложений для отправки (МБ)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={1024}
                      className="admin-filter-input"
                      value={sysSettings.max_upload_size_mb}
                      onChange={(e) => setSysSettings({ ...sysSettings, max_upload_size_mb: e.target.value })}
                    />
                  </div>

                  {/* Telegram Gateway Section */}
                  <div style={{
                    border: '1px solid #cbd5e1',
                    borderRadius: '8px',
                    padding: '16px',
                    backgroundColor: '#f8fafc',
                    marginBottom: '20px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0284c7" strokeWidth="2" strokeLinecap="round">
                          <line x1="22" y1="2" x2="11" y2="13"/>
                          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                        <strong style={{ fontSize: '14px', color: '#0f172a' }}>Интеграция с Telegram (Шлюз оповещений)</strong>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={sysSettings.telegram_enabled === 'true'}
                          onChange={(e) => setSysSettings({ ...sysSettings, telegram_enabled: e.target.checked ? 'true' : 'false' })}
                        />
                        <span>Включить шлюз</span>
                      </label>
                    </div>

                    {sysSettings.telegram_enabled === 'true' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div>
                          <label style={{ fontSize: '11px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '4px' }}>
                            Токен Telegram Бота (от @BotFather)
                          </label>
                          <input
                            type="password"
                            className="form-control"
                            placeholder="7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                            value={sysSettings.telegram_bot_token}
                            onChange={(e) => setSysSettings({ ...sysSettings, telegram_bot_token: e.target.value })}
                            style={{ width: '100%', padding: '6px 10px', fontSize: '12px', fontFamily: 'monospace' }}
                          />
                        </div>

                        <div>
                          <label style={{ fontSize: '11px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '4px' }}>
                            ID канала или чата оповещений компании (опционально)
                          </label>
                          <input
                            type="text"
                            className="form-control"
                            placeholder="-1001234567890 или @centras_alerts"
                            value={sysSettings.telegram_channel_id}
                            onChange={(e) => setSysSettings({ ...sysSettings, telegram_channel_id: e.target.value })}
                            style={{ width: '100%', padding: '6px 10px', fontSize: '12px' }}
                          />
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={sysSettings.telegram_offline_alerts === 'true'}
                              onChange={(e) => setSysSettings({ ...sysSettings, telegram_offline_alerts: e.target.checked ? 'true' : 'false' })}
                            />
                            <span>Отправлять сотрудникам оффлайн-уведомления при отсутствии в сети</span>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={sysSettings.telegram_mask_pii === 'true'}
                              onChange={(e) => setSysSettings({ ...sysSettings, telegram_mask_pii: e.target.checked ? 'true' : 'false' })}
                            />
                            <span>Маскировать ИИН и персональные данные (комплаенс АРРФР / НБ РК)</span>
                          </label>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                          <button
                            type="button"
                            className="admin-btn-action"
                            style={{ background: '#0284c7', color: '#ffffff', borderColor: '#0369a1', fontWeight: 600 }}
                            onClick={handleTestTelegram}
                            disabled={telegramTesting}
                          >
                            {telegramTesting ? 'Проверка соединения...' : '⚡ Проверить бота Telegram'}
                          </button>
                          {telegramTestResult && (
                            <span style={{
                              fontSize: '11px',
                              fontWeight: 600,
                              color: telegramTestResult.success ? '#15803d' : '#b91c1c'
                            }}>
                              {telegramTestResult.success ? (telegramTestResult.message || 'Бот успешно проверен!') : ('Ошибка: ' + telegramTestResult.error)}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <button type="submit" className="btn btn-primary">
                    Применить параметры сервера
                  </button>
                </form>
              </div>
            )}

            {/* TAB 8: LICENSES (licenses.html) */}
            {activeTab === 'licenses' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: '#1e293b' }}>
                  Лицензии MyChat Server (licenses.html)
                </h3>

                <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '20px', maxWidth: '640px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    <span style={{ fontSize: '32px' }}>🏢</span>
                    <div>
                      <h4 style={{ margin: 0, color: '#0f172a' }}>{licenseData?.product_name || 'MyChat Server Enterprise'}</h4>
                      <span style={{ fontSize: '12px', color: '#16a34a', fontWeight: 600 }}>● Лицензия активна</span>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '10px', fontSize: '12px', borderTop: '1px solid #e2e8f0', paddingTop: '14px' }}>
                    <strong>Владелец лицензии:</strong>
                    <span>{licenseData?.license_owner}</span>

                    <strong>Тип лицензии:</strong>
                    <span>{licenseData?.license_type}</span>

                    <strong>Лимит подключений:</strong>
                    <span><strong style={{ color: '#2563eb' }}>{licenseData?.max_online_users}</strong> (Зарегистрировано: {users.length})</span>

                    <strong>Регистрационный ключ:</strong>
                    <span><code>{licenseData?.license_key}</code></span>

                    <strong>Техническая поддержка:</strong>
                    <span>{licenseData?.support_expiration}</span>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
