import React, { useState, useEffect, useRef } from 'react';
import { useConfirm } from './ConfirmDialog';
import { useInlineToast } from './InlineToast';
import Icon from './Icon';
import { ResetPasswordDialog, OneTimePasswordDialog } from './PasswordDialogs';
import { isSuperAdmin, isScopedAdmin, formatPing, readError, toDepartmentId } from '../lib/admin-access.mjs';

// Права, которыми управляет администратор. defaultOn — как трактуется
// отсутствующее значение: три права считаются разрешёнными, пока их явно не
// отключили, поэтому галочка для них должна стоять и у роли без записи.
const PERMISSION_FIELDS = [
  { key: 'is_admin', label: 'Доступ к консоли управления сервером', emphasis: true },
  { key: 'can_manage_users', label: 'Управление пользователями и блокировками' },
  { key: 'can_manage_structure', label: 'Управление подразделениями' },
  {
    key: 'can_remote_control',
    label: 'Удалённый рабочий стол',
    emphasis: true,
    note: 'просмотр и управление чужим компьютером'
  },
  { key: 'can_call', label: 'Голосовые звонки', defaultOn: true },
  { key: 'can_upload_files', label: 'Передача файлов', defaultOn: true },
  { key: 'can_broadcast', label: 'Публикация объявлений для всех' },
  { key: 'can_create_channels', label: 'Создание каналов', defaultOn: true },
  { key: 'can_manage_db', label: 'Доступ к базе данных', emphasis: true, note: 'выполнение SQL-запросов' }
];

export default function AdminUserModal({ currentUser, serverInfo, serverUrl, onClose, onRefreshData, focusUserId = null }) {
  // Консоль открывают и суперадминистратор, и администратор подразделения.
  // Второму сервер отдаёт только сотрудников, заявки, узлы и импорт — остальные
  // разделы отвечали ему отказом на каждое нажатие. Флаги те же, что на сервере.
  const superAdmin = isSuperAdmin(currentUser);
  const scopedAdmin = !superAdmin && isScopedAdmin(currentUser);

  // Official MyChat Control Panel Sections
  const [activeTab, setActiveTab] = useState(superAdmin ? 'server' : 'users');
  // 'server' | 'users' | 'conferences' | 'rights' | 'tools' | 'filters' | 'settings' | 'licenses'

  const [loading, setLoading] = useState(false);
  const [showToast, toastElement] = useInlineToast();
  const [confirm, confirmDialog] = useConfirm();

  // Сброс пароля и выданный одноразовый пароль — в своих окнах: prompt() в
  // Electron не работает, а уведомление гасло раньше, чем пароль успевали
  // переписать.
  const [resetTarget, setResetTarget] = useState(null);
  const [oneTimePassword, setOneTimePassword] = useState(null);
  const [savingUser, setSavingUser] = useState(false);
  const [formError, setFormError] = useState('');
  const [annSubmitting, setAnnSubmitting] = useState(false);
  const focusHandledRef = useRef(null);

  // Tab 1: Server Overview & Online
  const [serverOverview, setServerOverview] = useState(null);
  const [onlineList, setOnlineList] = useState([]);

  // Заявки на самостоятельную регистрацию, ожидающие решения администратора.
  const [registrations, setRegistrations] = useState([]);
  const [registrationBusy, setRegistrationBusy] = useState(null);

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
    department_id: '',
    role_id: '',
    extension: '',
    uin: '',
    email: '',
    phone: '',
    password: '',
    bound_ip: '',
    admin_scope_dept_id: ''
  });

  // Tab 3: Conferences
  const [channels, setChannels] = useState([]);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelTopic, setNewChannelTopic] = useState('');

  // Tab 4: Rights & Groups
  const [roles, setRoles] = useState([]);
  const [rightsDraft, setRightsDraft] = useState({});
  const [savingRoleId, setSavingRoleId] = useState(null);
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptParent, setNewDeptParent] = useState('');
  const [renamingDeptId, setRenamingDeptId] = useState(null);
  const [deptDraftName, setDeptDraftName] = useState('');
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

  // Отказ сервера здесь проглатывался: `if (res.ok)` без ветки «иначе» —
  // администратор нажимал, ничего не происходило, и причину он не узнавал.
  const handleBindDevice = async (deviceId, userId, ip) => {
    if (!userId) return showToast('Выберите сотрудника для привязки', 'error');
    try {
      const res = await fetch(serverUrl + '/api/admin/devices/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ device_id: deviceId, user_id: Number(userId), ip_address: ip })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось привязать узел'), 'error');
        return;
      }
      showToast('Узел успешно привязан к сотруднику!');
      setSelectedDeviceForPair(null);
      loadPendingDevices();
      loadUsers();
    } catch (e) {
      showToast('Ошибка привязки: ' + e.message, 'error');
    }
  };

  const handleAutoMatchIp = async () => {
    try {
      const res = await fetch(serverUrl + '/api/admin/devices/auto-match', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!res.ok) {
        showToast(await readError(res, 'Автосопоставление не выполнено'), 'error');
        return;
      }
      const d = await res.json();
      showToast('Автоматически сопоставлено узлов по IP: ' + d.matched_count);
      loadPendingDevices();
      loadUsers();
    } catch (e) {
      showToast('Ошибка автосопоставления: ' + e.message, 'error');
    }
  };

  const handleUnbindDevice = async (deviceId) => {
    try {
      const res = await fetch(serverUrl + '/api/admin/devices/unbind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ device_id: deviceId })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось отвязать узел'), 'error');
        return;
      }
      showToast('Узел отвязан');
      loadPendingDevices();
      loadUsers();
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  };

  const handlePreviewParser = async () => {
    if (!parserText.trim()) return showToast('Вставьте текст со структурой', 'error');
    setParserLoading(true);
    try {
      const res = await fetch(serverUrl + '/api/admin/org/preview-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ text: parserText, format: parserFormat })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось разобрать структуру'), 'error');
        return;
      }
      const d = await res.json();
      setParserPreview(d.preview);
      showToast('Предпросмотр: ' + (d.preview && d.preview.stats ? d.preview.stats.departmentsCount : 0) + ' подразделений, ' + (d.preview && d.preview.stats ? d.preview.stats.employeesCount : 0) + ' сотрудников');
    } catch (e) {
      showToast('Ошибка предпросмотра: ' + e.message, 'error');
    } finally {
      setParserLoading(false);
    }
  };

  const handleApplyParser = async () => {
    if (!parserText.trim()) return showToast('Вставьте текст со структурой', 'error');
    setParserLoading(true);
    try {
      const res = await fetch(serverUrl + '/api/admin/org/batch-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        // Пароль не передаётся: сервер сам выдаст случайный на весь импорт.
        // Общий пароль вида «123456» на сотне заведённых разом учётных
        // записей — это сотня открытых дверей до первого входа каждого.
        body: JSON.stringify({ text: parserText, format: parserFormat })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Импорт не применён'), 'error');
        return;
      }
      const d = await res.json();
      showToast('Импорт успешно применен! Создано отделов: ' + d.createdDepts + ', сотрудников: ' + d.createdUsers + ', обновлено: ' + d.updatedUsers);
      setParserPreview(null);
      setParserText('');
      loadUsers();
      loadOrgTree();
      if (onRefreshData) onRefreshData();
    } catch (e) {
      showToast('Ошибка применения импорта: ' + e.message, 'error');
    } finally {
      setParserLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadUsers();
    loadRegistrations();
    loadOrgTree();
    // Остальные разделы сервер отдаёт только суперадминистратору: администратор
    // подразделения получал бы отказ на каждый из этих запросов.
    if (superAdmin) {
      loadServerOverview();
      loadChannels();
      loadRoles();
      loadFilters();
      loadSettings();
      loadLicenses();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Заявки на регистрацию ──────────────────────────────────────────────
  // Сотрудник регистрируется сам, но пользоваться системой начинает только
  // после подтверждения. Сервер это умел с самого начала, а кнопок не было —
  // заявки копились там, где их никто не видел.
  const loadRegistrations = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/admin/registrations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) setRegistrations(await res.json());
    } catch (err) {
      console.error('Error fetching registrations:', err);
    }
  };

  const decideRegistration = async (user, approve) => {
    if (!approve && !(await confirm({
      title: 'Отклонить заявку',
      message:
        `Отклонить заявку «${user.full_name}» (логин ${user.username})?\n` +
        'Войти этот человек не сможет. Решение отменяется только заведением учётной записи заново.',
      confirmText: 'Отклонить',
      danger: true
    }))) return;

    setRegistrationBusy(user.id);
    try {
      const res = await fetch(
        `${serverUrl}/api/admin/registrations/${user.id}/${approve ? 'approve' : 'reject'}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось обработать заявку'), 'error');
        return;
      }
      showToast(approve
        ? `${user.full_name} подтверждён — теперь может входить`
        : `Заявка «${user.full_name}» отклонена`);
      await loadRegistrations();
      await loadUsers();
      onRefreshData && onRefreshData();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    } finally {
      setRegistrationBusy(null);
    }
  };

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
    if (!(await confirm({
      title: 'Сброс сессии',
      message: `Сбросить активную сессию сотрудника ${userName}?`,
      confirmText: 'Сбросить',
      danger: true
    }))) return;
    try {
      const res = await fetch(`${serverUrl}/api/admin/server/disconnect-user`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ userId })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось сбросить сессию'), 'error');
        return;
      }
      showToast(`Сессия ${userName} сброшена`);
      loadServerOverview();
    } catch (err) {
      showToast('Ошибка: ' + err.message, 'error');
    }
  };

  // "Сотрудник" is not role id 2: a migration inserts a role with an explicit
  // id before the rest are seeded, which shifts every later autoincrement id.
  // Sending 2 blindly failed the foreign key and made it impossible to create
  // anyone at all, so the id is read from the roles the server actually has.
  const defaultRoleId = roles.find((r) => r.name === 'Сотрудник')?.id ?? roles[0]?.id ?? '';

  // User Add / Edit
  const openCreateForm = () => {
    setFormData({
      username: '',
      full_name: '',
      job_title: 'Сотрудник',
      // Администратор подразделения может заводить людей только в своём
      // контуре — предлагать ему первое подразделение компании бессмысленно.
      department_id: scopedAdmin && currentUser?.admin_scope_dept_id
        ? Number(currentUser.admin_scope_dept_id)
        : (departments[0]?.id ?? null),
      role_id: defaultRoleId,
      extension: '',
      uin: Math.floor(1000 + Math.random() * 8999),
      email: '',
      phone: '',
      password: '',
      bound_ip: '',
      admin_scope_dept_id: ''
    });
    setEditingUser(null);
    setFormError('');
    setFormMode('create');
  };

  const openEditForm = (user) => {
    setFormData({
      username: user.username,
      full_name: user.full_name || '',
      job_title: user.job_title || '',
      // Сотрудник без подразделения раньше получал в форме первое попавшееся,
      // и простое «Сохранить» молча переводил его туда.
      department_id: user.department_id ?? null,
      role_id: user.role_id || defaultRoleId,
      extension: user.extension || '',
      uin: user.uin || '',
      email: user.email || '',
      phone: user.phone || '',
      password: '',
      // Без этих двух полей форма показывала «Не назначен» даже тому, у кого
      // контур назначен — администратор читал неверные сведения о правах.
      bound_ip: user.bound_ip || '',
      admin_scope_dept_id: user.admin_scope_dept_id || ''
    });
    setEditingUser(user);
    setFormError('');
    setFormMode('edit');
  };

  // Консоль открыли из карточки конкретного сотрудника — значит и показать
  // надо его, а не начальную вкладку. Ждём загрузки списка: до неё открывать
  // нечего. Открываем один раз на каждого сотрудника: список перезагружается
  // после любого сохранения, блокировки или подтверждения заявки, и форма
  // всплывала снова поверх того, что администратор делал.
  useEffect(() => {
    if (!focusUserId || !users.length) return;
    if (focusHandledRef.current === focusUserId) return;
    const target = users.find((u) => Number(u.id) === Number(focusUserId));
    if (!target) return;
    focusHandledRef.current = focusUserId;
    setActiveTab('users');
    setUserSubTab('list');
    openEditForm(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusUserId, users]);

  const handleSaveUser = async (e) => {
    e.preventDefault();
    // Двойное нажатие заводило двух одинаковых сотрудников (или падало на
    // занятом логине со вторым запросом).
    if (savingUser) return;
    setSavingUser(true);
    setFormError('');
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
        const created = await res.json().catch(() => ({}));
        showToast(`Сотрудник ${formData.full_name} успешно добавлен (UIN ${created.uin || formData.uin})`);
        // Если пароль сгенерировал сервер, показать его надо сразу: второго
        // раза не будет, а передать сотруднику что-то нужно. Окно висит, пока
        // администратор сам его не закроет.
        if (created.initial_password) {
          setOneTimePassword({
            title: 'Сотрудник добавлен',
            fullName: formData.full_name,
            username: formData.username,
            password: created.initial_password
          });
        }
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
      // Ошибку показываем в самой форме: уведомление консоли она закрывает,
      // а исправить введённое администратор может только здесь.
      setFormError(err.message === 'Failed to fetch' ? 'Нет связи с сервером' : err.message);
    } finally {
      setSavingUser(false);
    }
  };

  // Toggle user active
  const handleToggleActive = async (user) => {
    const deactivating = Boolean(user.is_active);
    // Переключатель блокировки сервер оставляет суперадминистратору.
    // Администратор подразделения может только отключить сотрудника — включить
    // обратно его может лишь суперадминистратор.
    if (!superAdmin && !deactivating) {
      showToast('Разблокировать учётную запись может только суперадминистратор', 'error');
      return;
    }
    const actionName = deactivating ? 'заблокировать' : 'разблокировать';
    if (!(await confirm({
      title: deactivating ? 'Блокировка учётной записи' : 'Разблокировка учётной записи',
      message:
        `Вы действительно хотите ${actionName} учетную запись ${user.full_name}?` +
        (deactivating ? '\nАктивные сессии сотрудника будут закрыты.' : ''),
      confirmText: deactivating ? 'Заблокировать' : 'Разблокировать',
      danger: deactivating
    }))) return;
    try {
      const res = superAdmin
        ? await fetch(`${serverUrl}/api/admin/users/${user.id}/toggle-active`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        })
        : await fetch(`${serverUrl}/api/admin/users/${user.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось изменить статус учётной записи'), 'error');
        return;
      }
      showToast(`Статус учетной записи ${user.full_name} изменен`);
      loadUsers();
      if (onRefreshData) onRefreshData();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    }
  };

  // Reset password
  // ── Права ролей ──
  // Раньше эта вкладка только показывала галочки: изменить права можно было
  // исключительно SQL-запросом через консоль базы.
  const toggleRight = (role, key, value) => {
    setRightsDraft((prev) => {
      const base = prev[role.id] || role.permissions || {};
      return { ...prev, [role.id]: { ...base, [key]: value } };
    });
  };

  const saveRoleRights = async (role) => {
    const permissions = rightsDraft[role.id];
    if (!permissions) return;
    setSavingRoleId(role.id);
    try {
      const res = await fetch(`${serverUrl}/api/admin/roles/${role.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions })
      });
      if (!res.ok) {
        // Сюда попадает и отказ сервера снять последнего администратора.
        showToast(await readError(res, 'Не удалось сохранить права'), 'error');
        return;
      }
      showToast(`Права роли «${role.name}» сохранены`);
      setRightsDraft((prev) => {
        const next = { ...prev };
        delete next[role.id];
        return next;
      });
      await loadRoles();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    } finally {
      setSavingRoleId(null);
    }
  };

  // ── Управление подразделениями ──
  // Маршруты существовали с самого начала, но из приложения к ним никто не
  // обращался: создать или переименовать отдел было нельзя вообще никак,
  // кроме массового импорта.
  const handleCreateDepartment = async () => {
    const name = newDeptName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${serverUrl}/api/org/departments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          parent_id: newDeptParent ? Number(newDeptParent) : null,
          dept_type: 'department'
        })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось создать подразделение'), 'error');
        return;
      }
      setNewDeptName('');
      setNewDeptParent('');
      showToast(`Подразделение «${name}» создано`);
      await loadOrgTree();
      onRefreshData && onRefreshData();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    }
  };

  const handleRenameDepartment = async (deptId) => {
    const name = deptDraftName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${serverUrl}/api/org/departments/${deptId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось переименовать подразделение'), 'error');
        return;
      }
      setRenamingDeptId(null);
      showToast('Название изменено');
      await loadOrgTree();
      onRefreshData && onRefreshData();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    }
  };

  const handleDeleteDepartment = async (dept, headcount) => {
    // Удаление обнуляет подразделение у всех, кто в нём числится, поэтому
    // предупреждаем заранее и называем количество.
    const warning = headcount > 0
      ? `В подразделении «${dept.name}» числится ${headcount} чел. После удаления они останутся без подразделения. Продолжить?`
      : `Удалить подразделение «${dept.name}»?`;
    if (!(await confirm({ title: 'Удаление подразделения', message: warning, confirmText: 'Удалить', danger: true }))) return;

    try {
      const res = await fetch(`${serverUrl}/api/org/departments/${dept.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось удалить подразделение'), 'error');
        return;
      }
      showToast(`Подразделение «${dept.name}» удалено`);
      await loadOrgTree();
      onRefreshData && onRefreshData();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    }
  };

  // Раньше здесь был window.prompt(), а его в Electron нет: кнопка ничего не
  // делала. Теперь спрашиваем своим окном; пустое поле — просьба к серверу
  // выдать случайный пароль (прежде подставлялось «123456»).
  const handleResetPassword = (user) => setResetTarget(user);

  // Возвращает текст ошибки — его покажет само окно сброса, не закрываясь.
  const submitResetPassword = async (password) => {
    const user = resetTarget;
    if (!user) return null;
    try {
      const res = await fetch(`${serverUrl}/api/admin/users/${user.id}/reset-password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(password ? { password } : {})
      });
      if (!res.ok) return await readError(res, 'Не удалось сбросить пароль');
      const data = await res.json().catch(() => ({}));
      setResetTarget(null);
      // Сгенерированный пароль сервер возвращает ровно один раз — показать его
      // администратору больше будет неоткуда. Заданный вручную не возвращается:
      // его администратор и так знает.
      if (data.password) {
        setOneTimePassword({
          title: 'Пароль сброшен',
          fullName: user.full_name,
          username: user.username,
          password: data.password
        });
      } else {
        showToast(`${user.full_name}: ${data.message || 'пароль изменён'}`);
      }
      return null;
    } catch (err) {
      return 'Нет связи с сервером: ' + err.message;
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
        showToast(await readError(res, 'Ошибка создания конференции'), 'error');
        return;
      }
      showToast(`Конференция ${newChannelName} успешно создана`);
      setNewChannelName('');
      setNewChannelTopic('');
      loadChannels();
      if (onRefreshData) onRefreshData();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    }
  };

  // Channel Deletion
  const handleDeleteChannel = async (channel) => {
    if (!(await confirm({
      title: 'Удаление конференции',
      message: `Удалить конференцию "${channel.name}" и всю историю сообщений в ней?`,
      confirmText: 'Удалить',
      danger: true
    }))) return;
    try {
      const res = await fetch(`${serverUrl}/api/admin/channels/${channel.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        showToast(await readError(res, 'Ошибка удаления'), 'error');
        return;
      }
      showToast(`Конференция ${channel.name} удалена`);
      loadChannels();
      if (onRefreshData) onRefreshData();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    }
  };

  // Audit Search
  const handleSearchAudit = async () => {
    if (loading) return;
    try {
      setLoading(true);
      const res = await fetch(`${serverUrl}/api/admin/audit/messages?q=${encodeURIComponent(auditQuery)}&limit=100`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        showToast(await readError(res, 'Поиск по протоколам не выполнен'), 'error');
        return;
      }
      const data = await res.json();
      setAuditResults(Array.isArray(data) ? data : []);
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Port Test
  const handleRunPortTest = async () => {
    if (loading) return;
    try {
      setLoading(true);
      const res = await fetch(`${serverUrl}/api/admin/tools/port-test`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        showToast(await readError(res, 'Тест портов не выполнен'), 'error');
        return;
      }
      const data = await res.json();
      setPortTestResult(data);
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // DB Vacuum
  const handleRunVacuum = async () => {
    if (loading) return;
    if (!(await confirm({
      title: 'Оптимизация базы данных',
      message: 'Выполнить оптимизацию, очистку WAL и переиндексацию базы данных SQLite?',
      confirmText: 'Выполнить'
    }))) return;
    try {
      setLoading(true);
      const res = await fetch(`${serverUrl}/api/admin/tools/vacuum`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        showToast(await readError(res, 'Оптимизация не выполнена'), 'error');
        return;
      }
      const data = await res.json();
      setVacuumResult(data.stats);
      showToast('База данных успешно оптимизирована!');
      loadServerOverview();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Create Announcement
  const handleCreateAnnouncement = async (e) => {
    e.preventDefault();
    // Повторное нажатие до ответа публиковало оповещение дважды.
    if (!newAnnTitle.trim() || !newAnnText.trim() || annSubmitting) return;
    setAnnSubmitting(true);
    try {
      const res = await fetch(`${serverUrl}/api/announcements`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        // Field names must match AnnouncementService.createAnnouncement:
        // it reads content/priority, and content is NOT NULL — sending
        // body/isUrgent produced a silent 400 and the button did nothing.
        body: JSON.stringify({
          title: newAnnTitle.trim(),
          content: newAnnText.trim(),
          priority: newAnnUrgent ? 'urgent' : 'normal'
        })
      });
      if (!res.ok) {
        showToast(await readError(res, 'Не удалось опубликовать оповещение'), 'error');
        return;
      }
      showToast('Оповещение успешно отправлено на экраны всех сотрудников!');
      setNewAnnTitle('');
      setNewAnnText('');
      setNewAnnUrgent(false);
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    } finally {
      setAnnSubmitting(false);
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
      if (!res.ok) {
        showToast(await readError(res, 'Настройки фильтров не сохранены'), 'error');
        return;
      }
      showToast('Настройки фильтров и антифлуда сохранены');
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
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
      if (!res.ok) {
        showToast(await readError(res, 'Параметры сервера не сохранены'), 'error');
        return;
      }
      showToast('Параметры сервера MyChat успешно сохранены');
      loadServerOverview();
    } catch (err) {
      showToast('Нет связи с сервером: ' + err.message, 'error');
    }
  };

  const handleTestTelegram = async () => {
    if (!sysSettings.telegram_bot_token.trim()) {
      showToast('Укажите токен бота перед проверкой связи.', 'error');
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
            <Icon name="shield" size={18} />
            <span>Консоль управления MyChat Server 2025.3.1</span>
            <span style={{ fontSize: '11px', background: '#2563eb', padding: '2px 8px', borderRadius: '10px' }}>
              АО СК "Сентрас Иншуранс"
            </span>
          </div>
          <button className="btn-close-modal" onClick={onClose} aria-label="Закрыть"><Icon name="x" size={16} /></button>
        </div>

        {/* Global Toast Notification */}
        {toastElement}

        <div className="admin-console-body">
          {/* Sidebar Nav: Official 8 Categories */}
          <div className="admin-sidebar">
            <div className="admin-sidebar-nav">
              {/* Разделы, которые сервер отдаёт только суперадминистратору,
                  администратору подразделения не показываются: каждый из них
                  отвечал бы ему отказом. */}
              {superAdmin && (
                <button
                  className={`admin-nav-item ${activeTab === 'server' ? 'active' : ''}`}
                  onClick={() => setActiveTab('server')}
                >
                  <Icon name="monitor" size={16} /> <span>MyChat Server</span>
                </button>
              )}

              <button
                className={`admin-nav-item ${activeTab === 'users' ? 'active' : ''}`}
                onClick={() => setActiveTab('users')}
              >
                <Icon name="users" size={16} /> <span>Пользователи</span>
              </button>

              <button
                className={`admin-nav-item ${activeTab === 'registrations' ? 'active' : ''}`}
                onClick={() => setActiveTab('registrations')}
              >
                <Icon name="edit" size={16} /> <span>Заявки</span>
                {registrations.length > 0 && (
                  <span className="admin-nav-badge">{registrations.length}</span>
                )}
              </button>

              {superAdmin && (
                <>
                  <button
                    className={`admin-nav-item ${activeTab === 'conferences' ? 'active' : ''}`}
                    onClick={() => setActiveTab('conferences')}
                  >
                    <Icon name="message" size={16} /> <span>Конференции</span>
                  </button>

                  <button
                    className={`admin-nav-item ${activeTab === 'rights' ? 'active' : ''}`}
                    onClick={() => setActiveTab('rights')}
                  >
                    <Icon name="shield" size={16} /> <span>Управление правами</span>
                  </button>

                  <button
                    className={`admin-nav-item ${activeTab === 'tools' ? 'active' : ''}`}
                    onClick={() => setActiveTab('tools')}
                  >
                    <Icon name="wrench" size={16} /> <span>Инструменты</span>
                  </button>

                  <button
                    className={`admin-nav-item ${activeTab === 'filters' ? 'active' : ''}`}
                    onClick={() => setActiveTab('filters')}
                  >
                    <Icon name="ban" size={16} /> <span>Фильтры</span>
                  </button>

                  <button
                    className={`admin-nav-item ${activeTab === 'settings' ? 'active' : ''}`}
                    onClick={() => setActiveTab('settings')}
                  >
                    <Icon name="settings" size={16} /> <span>Настройки</span>
                  </button>

                  <button
                    className={`admin-nav-item ${activeTab === 'licenses' ? 'active' : ''}`}
                    onClick={() => setActiveTab('licenses')}
                  >
                    <Icon name="scroll" size={16} /> <span>Лицензии</span>
                  </button>
                </>
              )}
            </div>

            <div className="admin-sidebar-footer">
              <div><strong>Порт чата:</strong> 2004 TCP</div>
              <div><strong>Статус:</strong> <span style={{ color: 'light-dark(#16a34a, #81eea9)' }}>● Активен</span></div>
              <div><strong>Версия:</strong> 2025.3.1</div>
            </div>
          </div>

          {/* Main Content Workspace */}
          <div className="admin-content-area">
            {/* Номер роли не устойчив — миграции сдвигают нумерацию; баннер
                показывался не тем или не показывался вовсе. */}
            {scopedAdmin && (
              <div className="scoped-admin-banner">
                <Icon name="shield" size={16} />
                <span>
                  Вы авторизованы как <strong>Контурный администратор</strong>
                  {currentUser?.admin_scope_dept_name ? <> («{currentUser.admin_scope_dept_name}»)</> : null}.
                  Вам доступно управление сотрудниками только вашего подразделения.
                </span>
              </div>
            )}


            {/* TAB 1: MYCHAT SERVER (info.html) */}
            {activeTab === 'server' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: 'light-dark(#1e293b, #a0b2cf)' }}>
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
                    <span className="admin-stat-value" style={{ color: 'light-dark(#16a34a, #81eea9)' }}>
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
                    <h4 style={{ margin: 0, color: 'light-dark(#1e293b, #a0b2cf)' }}>
                      Активные подключения в сети ({onlineList.length})
                    </h4>
                    <button className="admin-btn-action" onClick={loadServerOverview}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="refresh" size={14} />Обновить</span>
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
                              <td><span style={{ color: 'light-dark(#16a34a, #81eea9)' }}>{formatPing(conn.pingMs)}</span></td>
                              <td>
                                <button
                                  className="admin-btn-action"
                                  style={{ color: 'light-dark(#dc2626, #eb8484)' }}
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
                <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid light-dark(#e2e8f0, rgba(121, 148, 185, 0.38))', paddingBottom: '10px', marginBottom: '14px' }}>
                  <button
                    className={`admin-btn-action ${userSubTab === 'list' ? 'highlight-admin' : ''}`}
                    onClick={() => setUserSubTab('list')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="clipboard" size={14} />Список пользователей ({users.length})</span>
                  </button>
                  <button
                    className={`admin-btn-action ${userSubTab === 'banned' ? 'highlight-admin' : ''}`}
                    onClick={() => setUserSubTab('banned')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="ban" size={14} />Заблокированные (Бан-лист) ({users.filter((u) => u.is_active === 0).length})</span>
                  </button>
                  <button
                    className={`admin-btn-action ${userSubTab === 'departments' ? 'highlight-admin' : ''}`}
                    onClick={() => setUserSubTab('departments')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="building" size={14} />Подразделения и контуры ({departments.length})</span>
                  </button>
                  <button
                    className={'admin-btn-action ' + (userSubTab === 'devices' ? 'highlight-admin' : '')}
                    onClick={() => { setUserSubTab('devices'); loadPendingDevices(); }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="monitor" size={14} />Стучащиеся клиенты (Очередь по IP) ({pendingDevices.length})</span>
                  </button>
                  <button
                    className={'admin-btn-action ' + (userSubTab === 'parser' ? 'highlight-admin' : '')}
                    onClick={() => setUserSubTab('parser')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="zap" size={14} />Импорт и парсер оргструктуры</span>
                  </button>

                </div>

                
                {/* SUBTAB: PENDING DEVICES QUEUE */}
                {userSubTab === 'devices' && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                      <div>
                        <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Очередь подключений по IP (Стучащиеся клиенты)</h4>
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)' }}>
                          Клиенты при первом запуске автоматически отправляют сетевой запрос. Свяжите узел с сотрудником для входа без пароля.
                        </p>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="btn btn-secondary" onClick={loadPendingDevices}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="refresh" size={14} />Обновить</span>
                        </button>
                        <button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={handleAutoMatchIp}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="zap" size={14} />Автосвязывание по IP</span>
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
                        <span className="admin-stat-value" style={{ color: 'light-dark(#16a34a, #81eea9)' }}>
                          {pendingDevices.filter((d) => d.status === 'paired').length}
                        </span>
                      </div>
                      <div className="admin-stat-card">
                        <span className="admin-stat-label">Ожидает связывания</span>
                        <span className="admin-stat-value" style={{ color: 'light-dark(#ea580c, #f4a47b)' }}>
                          {pendingDevices.filter((d) => d.status !== 'paired').length}
                        </span>
                      </div>
                      <div
                        className="admin-stat-card"
                        style={{ cursor: 'pointer', background: 'light-dark(#f0fdf4, rgba(66, 230, 116, 0.16))', borderColor: 'light-dark(#bbf7d0, rgba(72, 234, 129, 0.38))' }}
                        onClick={handleAutoMatchIp}
                        title="Нажмите для запуска автосвязывания по IP"
                      >
                        <span className="admin-stat-label" style={{ color: 'light-dark(#166534, #8ae5ad)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="zap" size={13} />Готовы к связке</span>
                        <span className="admin-stat-value" style={{ color: 'light-dark(#15803d, #84ebab)', fontSize: '18px' }}>
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
                              <td colSpan="7" style={{ textAlign: 'center', padding: '24px', color: 'light-dark(#64748b, #a9aeb5)' }}>
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
                                    <span style={{ color: 'light-dark(#166534, #8ae5ad)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="user" size={14} />{d.paired_user_name}</span>
                                  ) : d.suggested_user ? (
                                    <span style={{ color: 'light-dark(#2563eb, #7ca1f3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="lightbulb" size={14} />Совпадение IP: {d.suggested_user.full_name}</span>
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
                            <button className="btn-close-modal" onClick={() => setSelectedDeviceForPair(null)} aria-label="Закрыть"><Icon name="x" size={16} /></button>
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
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)' }}>
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
                        <span style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)' }}>Формат:</span>
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
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="search" size={14} />Предпросмотр структуры</span>
                        </button>
                        <button
                          className="btn btn-primary"
                          style={{ background: '#2563eb' }}
                          onClick={handleApplyParser}
                          disabled={parserLoading}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="zap" size={14} />Применить импорт в базу данных</span>
                        </button>
                      </div>
                    </div>

                    {/* Preview Area */}
                    {parserPreview && (
                      <div className="parser-preview-box">
                        <div style={{ display: 'flex', gap: '20px', marginBottom: '10px', fontWeight: 600, color: 'light-dark(#1e293b, #a0b2cf)' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="building" size={14} />Подразделений к созданию: {parserPreview.stats.departmentsCount}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="user" size={14} />Сотрудников к созданию/обновлению: {parserPreview.stats.employeesCount}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                          <div>
                            <strong style={{ fontSize: '11px', color: 'light-dark(#64748b, #a9aeb5)' }}>ИЕРАРХИЯ ПОДРАЗДЕЛЕНИЙ:</strong>
                            <div style={{ marginTop: '6px' }}>
                              {parserPreview.departments.map((d, i) => (
                                <div key={i} className="parser-tree-item" style={{ paddingLeft: ((d.level - 1) * 16) + 'px' }}>
                                  <Icon name={d.level === 1 ? 'building' : d.level === 2 ? 'landmark' : 'users'} size={13} /> {d.name} <small style={{ color: '#94a3b8' }}>({d.dept_type})</small>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <strong style={{ fontSize: '11px', color: 'light-dark(#64748b, #a9aeb5)' }}>СОТРУДНИКИ:</strong>
                            <div style={{ marginTop: '6px' }}>
                              {parserPreview.employees.map((e, i) => (
                                <div key={i} className="parser-tree-item">
                                  <Icon name="user" size={13} /> <strong>{e.full_name}</strong> ({e.username})
                                  {e.bound_ip && <code style={{ marginLeft: '6px', fontSize: '10px' }}>IP: {e.bound_ip}</code>}
                                  {e.extension && <span style={{ marginLeft: '6px', color: 'light-dark(#64748b, #a9aeb5)', fontSize: '11px' }}>вн.{e.extension}</span>}
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
                    <h4 style={{ marginBottom: '10px' }}>Штатная структура подразделений</h4>

                    {/* Создание, переименование и удаление подразделений сервер
                        оставляет суперадминистратору. */}
                    {superAdmin ? (
                      <div className="dept-create-row">
                        <input
                          className="admin-input"
                          placeholder="Название нового подразделения"
                          value={newDeptName}
                          onChange={(e) => setNewDeptName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDepartment(); }}
                        />
                        <select
                          className="admin-input"
                          value={newDeptParent}
                          onChange={(e) => setNewDeptParent(e.target.value)}
                          title="Вышестоящее подразделение"
                        >
                          <option value="">Верхний уровень</option>
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>Внутри: {d.name}</option>
                          ))}
                        </select>
                        <button
                          className="btn btn-primary"
                          disabled={!newDeptName.trim()}
                          onClick={handleCreateDepartment}
                        >
                          + Создать подразделение
                        </button>
                      </div>
                    ) : (
                      <div className="dept-hint">
                        Создавать, переименовывать и удалять подразделения может только суперадминистратор.
                      </div>
                    )}

                    <div className="dept-hint">
                      Чтобы перевести сотрудника в другое подразделение, откройте его карточку
                      на вкладке «Список пользователей» и смените поле «Подразделение».
                    </div>
                    <div className="admin-table-container">
                      <table className="admin-data-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Название департамента / отдела</th>
                            <th>Штатная численность</th>
                            <th>Действия</th>
                          </tr>
                        </thead>
                        <tbody>
                          {departments.map((d) => {
                            const headcount = users.filter((u) => u.department_id === d.id).length;
                            return (
                              <tr key={d.id}>
                                <td>{d.id}</td>
                                <td>
                                  {renamingDeptId === d.id ? (
                                    <input
                                      className="admin-input"
                                      autoFocus
                                      value={deptDraftName}
                                      onChange={(e) => setDeptDraftName(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleRenameDepartment(d.id);
                                        if (e.key === 'Escape') setRenamingDeptId(null);
                                      }}
                                    />
                                  ) : (
                                    <strong>{d.name}</strong>
                                  )}
                                </td>
                                <td>{headcount} чел.</td>
                                <td style={{ whiteSpace: 'nowrap' }}>
                                  {!superAdmin ? (
                                    <span style={{ color: '#94a3b8' }}>—</span>
                                  ) : renamingDeptId === d.id ? (
                                    <>
                                      <button className="btn-mini" onClick={() => handleRenameDepartment(d.id)}>Сохранить</button>
                                      <button className="btn-mini" onClick={() => setRenamingDeptId(null)}>Отмена</button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        className="btn-mini"
                                        onClick={() => { setRenamingDeptId(d.id); setDeptDraftName(d.name); }}
                                      >
                                        Переименовать
                                      </button>
                                      <button
                                        className="btn-mini danger"
                                        title={headcount > 0 ? 'Сначала переведите сотрудников в другое подразделение' : 'Удалить подразделение'}
                                        onClick={() => handleDeleteDepartment(d, headcount)}
                                      >
                                        Удалить
                                      </button>
                                    </>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
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
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="monitor" size={12} />{u.paired_device_name}</span>
                                    </span>
                                    {u.paired_device_id && (
                                      <button
                                        className="admin-btn-action"
                                        style={{ padding: '1px 5px', fontSize: '10px', color: 'light-dark(#dc2626, #eb8484)' }}
                                        onClick={() => handleUnbindDevice(u.paired_device_id)}
                                        title="Отвязать узел"
                                        aria-label="Отвязать узел"
                                      >
                                        <Icon name="x" size={12} />
                                      </button>
                                    )}
                                  </div>
                                ) : u.bound_ip ? (
                                  <span className="device-badge-pending" title="Привязан статический IP сотрудника">
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="globe" size={12} />{u.bound_ip}</span>
                                  </span>
                                ) : (
                                  <button
                                    className="admin-btn-action"
                                    style={{ fontSize: '10px', color: 'light-dark(#2563eb, #7ca1f3)' }}
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
                                  aria-label="Редактировать сотрудника"
                                >
                                  <Icon name="edit" size={14} />
                                </button>
                                {/* Разблокировать может только суперадминистратор;
                                    администратор подразделения — только отключить. */}
                                {(superAdmin || u.is_active) ? (
                                  <button
                                    className="admin-btn-action"
                                    onClick={() => handleToggleActive(u)}
                                    title={u.is_active ? 'Заблокировать' : 'Разблокировать'}
                                    aria-label={u.is_active ? 'Заблокировать' : 'Разблокировать'}
                                  >
                                    <Icon name={u.is_active ? 'ban' : 'circleCheck'} size={14} />
                                  </button>
                                ) : null}
                                <button
                                  className="admin-btn-action"
                                  onClick={() => handleResetPassword(u)}
                                  title="Сбросить пароль"
                                  aria-label="Сбросить пароль"
                                >
                                  <Icon name="key" size={14} />
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
                  <div className="modal-backdrop" onClick={() => { if (!savingUser) setFormMode(null); }}>
                    <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
                      <div className="modal-header">
                        <h4>{formMode === 'create' ? 'Добавить нового сотрудника' : 'Редактирование профиля'}</h4>
                        <button className="btn-close-modal" onClick={() => setFormMode(null)} disabled={savingUser} aria-label="Закрыть"><Icon name="x" size={16} /></button>
                      </div>
                      <form onSubmit={handleSaveUser} style={{ padding: '16px' }}>
                        {formError && (
                          <div className="app-dialog-error" role="alert" style={{ marginBottom: '12px' }}>
                            {formError}
                          </div>
                        )}
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
                          {/* Назначать администраторов подразделений сервер
                              позволяет только суперадминистратору. */}
                          {superAdmin && (
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
                          )}
                        </div>
<div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Департамент / Отдел</label>
                            <select
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              value={formData.department_id ?? ''}
                              onChange={(e) => setFormData({ ...formData, department_id: toDepartmentId(e.target.value) })}
                            >
                              {/* Без этого пункта у сотрудника без подразделения
                                  форма показывала первое попавшееся, и сохранение
                                  молча переводило его туда. Администратору
                                  подразделения вывести сотрудника из контура
                                  нельзя — ему пункт виден, только пока значение пустое. */}
                              {(superAdmin || formData.department_id == null) && (
                                <option value="">Без подразделения</option>
                              )}
                              {departments.map((d) => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                              ))}
                            </select>
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Группа прав (Роль)</label>
                            {superAdmin ? (
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
                            ) : (
                              // Список ролей сервер отдаёт только суперадминистратору;
                              // новому сотруднику роль по умолчанию назначит сервер.
                              <select
                                className="form-control"
                                style={{ width: '100%', padding: '6px' }}
                                disabled
                                value=""
                                title="Назначать роли может только суперадминистратор"
                              >
                                <option value="">
                                  {formMode === 'edit' ? (editingUser?.role_name || 'Текущая роль') : 'Сотрудник (по умолчанию)'}
                                </option>
                              </select>
                            )}
                          </div>
                        </div>

                        {formMode === 'create' && (
                          <div className="form-group" style={{ marginBottom: '14px' }}>
                            <label style={{ fontSize: '11px', fontWeight: 600 }}>Первый пароль</label>
                            <input
                              type="text"
                              className="form-control"
                              style={{ width: '100%', padding: '6px' }}
                              placeholder="Оставьте пустым — сервер сгенерирует"
                              value={formData.password}
                              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                            />
                            <div style={{ fontSize: '10.5px', color: 'light-dark(#64748b, #a9aeb5)', marginTop: '4px', lineHeight: 1.5 }}>
                              Сотрудник обязан сменить его при первом входе. Пустое поле надёжнее
                              общего пароля: между заведением учётной записи и первым входом
                              известный всем пароль — открытая дверь.
                            </div>
                          </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
                          <button type="button" className="btn btn-secondary" onClick={() => setFormMode(null)} disabled={savingUser}>
                            Отмена
                          </button>
                          <button type="submit" className="btn btn-primary" disabled={savingUser}>
                            {savingUser
                              ? 'Сохранение…'
                              : formMode === 'create' ? 'Создать пользователя' : 'Сохранить изменения'}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ЗАЯВКИ НА РЕГИСТРАЦИЮ */}
            {activeTab === 'registrations' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '6px', color: 'light-dark(#1e293b, #a0b2cf)' }}>Заявки на регистрацию</h3>
                <p style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)', marginBottom: '16px', lineHeight: 1.6 }}>
                  Сотрудник заполняет форму сам, но войти сможет только после вашего
                  подтверждения. Пока заявка ждёт решения, учётной записи фактически нет:
                  ни в справочнике, ни в общих каналах человек не появляется.
                  {/* Настройки сервера доступны только суперадминистратору: у
                      остальных здесь стояло бы значение по умолчанию, а не настоящее. */}
                  {superAdmin && sysSettings.allow_registration !== 'true' && (
                    <>
                      <br />
                      <strong style={{ color: 'light-dark(#b45309, #f4af7b)' }}>
                        Самостоятельная регистрация сейчас отключена — новых заявок не появится.
                      </strong>{' '}
                      Включить её можно в разделе «Настройки».
                    </>
                  )}
                </p>

                {registrations.length === 0 ? (
                  <div style={{
                    padding: '32px', textAlign: 'center', background: 'light-dark(#f8fafc, #313338)',
                    border: '1px dashed light-dark(#cbd5e1, rgba(126, 151, 180, 0.38))', borderRadius: '8px', color: 'light-dark(#64748b, #a9aeb5)', fontSize: '13px'
                  }}>
                    Заявок, ожидающих решения, нет.
                  </div>
                ) : (
                  <div className="admin-table-container">
                    <table className="admin-data-table">
                      <thead>
                        <tr>
                          <th>ФИО</th>
                          <th>Логин</th>
                          <th>Должность</th>
                          <th>Подразделение</th>
                          <th>Контакты</th>
                          <th>Подана</th>
                          <th style={{ width: '210px' }}>Решение</th>
                        </tr>
                      </thead>
                      <tbody>
                        {registrations.map((r) => (
                          <tr key={r.id}>
                            <td style={{ fontWeight: 600 }}>{r.full_name}</td>
                            <td><code>{r.username}</code></td>
                            <td>{r.job_title || '—'}</td>
                            <td>{r.department_name || <span style={{ color: 'light-dark(#b45309, #f4af7b)' }}>не указано</span>}</td>
                            <td style={{ fontSize: '12px' }}>
                              {r.email || '—'}
                              {r.phone ? <><br />{r.phone}</> : null}
                            </td>
                            <td style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)' }}>
                              {r.registered_at ? new Date(r.registered_at).toLocaleString('ru-RU') : '—'}
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: '6px' }}>
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={registrationBusy === r.id}
                                  onClick={() => decideRegistration(r, true)}
                                >
                                  Подтвердить
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  disabled={registrationBusy === r.id}
                                  onClick={() => decideRegistration(r, false)}
                                >
                                  Отклонить
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: CONFERENCES (conference.html) */}
            {activeTab === 'conferences' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: 'light-dark(#1e293b, #a0b2cf)' }}>
                  Управление корпоративными конференциями (conference.html)
                </h3>
                <p style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)', marginBottom: '16px' }}>
                  Список текстовых конференций с автоматическим добавлением сотрудников.
                </p>

                {/* Create Channel Form */}
                <form onSubmit={handleCreateChannel} style={{ display: 'flex', gap: '10px', marginBottom: '20px', background: 'light-dark(#f8fafc, #313338)', padding: '14px', borderRadius: '6px', border: '1px solid light-dark(#e2e8f0, rgba(121, 148, 185, 0.38))' }}>
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
                                style={{ color: 'light-dark(#dc2626, #eb8484)' }}
                                onClick={() => handleDeleteChannel(c)}
                              >
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="x" size={14} />Удалить</span>
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
                <h3 style={{ marginBottom: '14px', color: 'light-dark(#1e293b, #a0b2cf)' }}>
                  Управление группами прав и ограничениями (grouprightsmanage.html)
                </h3>
                <p style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)', marginBottom: '16px' }}>
                  Права действуют на всех сотрудников с этой ролью. Изменения вступают в силу
                  при следующем действии пользователя — перезаходить ему не нужно.
                </p>

                <div className="admin-rights-grid">
                  {roles.map((r) => {
                    const saved = r.permissions || {};
                    const draft = rightsDraft[r.id] || saved;
                    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
                    return (
                      <div key={r.id} className="admin-rights-card">
                        <h4>
                          <span>{r.name}</span>
                          {changed && <span className="rights-changed">не сохранено</span>}
                        </h4>
                        <p style={{ fontSize: '11px', color: 'light-dark(#64748b, #a9aeb5)', marginBottom: '12px' }}>
                          {r.description}
                        </p>
                        <div className="admin-rights-list">
                          {PERMISSION_FIELDS.map((field) => (
                            <label key={field.key} className="admin-right-item editable">
                              <input
                                type="checkbox"
                                checked={
                                  draft[field.key] === undefined
                                    ? Boolean(field.defaultOn)
                                    : Boolean(draft[field.key])
                                }
                                onChange={(e) => toggleRight(r, field.key, e.target.checked)}
                              />
                              <span>
                                {field.emphasis ? <strong>{field.label}</strong> : field.label}
                                {field.note && <span className="right-note">{field.note}</span>}
                              </span>
                            </label>
                          ))}
                        </div>

                        <div className="rights-card-actions">
                          <button
                            className="btn btn-primary"
                            disabled={!changed || savingRoleId === r.id}
                            onClick={() => saveRoleRights(r)}
                          >
                            {savingRoleId === r.id ? 'Сохраняю…' : 'Сохранить'}
                          </button>
                          <button
                            className="btn btn-secondary"
                            disabled={!changed}
                            onClick={() => setRightsDraft((prev) => ({ ...prev, [r.id]: saved }))}
                          >
                            Отменить
                          </button>
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
                <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid light-dark(#e2e8f0, rgba(121, 148, 185, 0.38))', paddingBottom: '10px', marginBottom: '16px' }}>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'audit' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('audit')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="search" size={14} />Просмотр протоколов (logsviewer.html)</span>
                  </button>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'ports' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('ports')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="globe" size={14} />Тест портов (toolstestmychatports.html)</span>
                  </button>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'vacuum' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('vacuum')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="database" size={14} />Обслуживание SQLite БД</span>
                  </button>
                  <button
                    className={`admin-btn-action ${toolSubTab === 'announcements' ? 'highlight-admin' : ''}`}
                    onClick={() => setToolSubTab('announcements')}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="megaphone" size={14} />Доска объявлений</span>
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
                      <button className="btn btn-primary" onClick={handleSearchAudit} disabled={loading}>
                        {loading ? 'Поиск…' : 'Найти в протоколах'}
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
                                <td style={{ whiteSpace: 'nowrap', fontSize: '11px', color: 'light-dark(#64748b, #a9aeb5)' }}>
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
                    <p style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)', marginBottom: '14px' }}>
                      Проверка готовности сокетов к подключению клиентов LAN/WAN.
                    </p>
                    <button className="btn btn-primary" onClick={handleRunPortTest} disabled={loading} style={{ marginBottom: '14px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="play" size={14} />Запустить тестирование портов</span>
                    </button>

                    {portTestResult && (
                      <div style={{ background: 'light-dark(#f8fafc, #313338)', border: '1px solid light-dark(#cbd5e1, rgba(126, 151, 180, 0.38))', padding: '16px', borderRadius: '6px' }}>
                        <div style={{ color: 'light-dark(#16a34a, #81eea9)', fontWeight: 700, marginBottom: '8px' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="circleCheck" size={16} />Статус: {portTestResult.status} (Задержка: {portTestResult.response_time_ms} мс)</span>
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
                    <p style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)', marginBottom: '14px' }}>
                      Выполняет SQL-команду VACUUM, удаляет временные фрагменты журнала WAL и обновляет индексы.
                    </p>
                    <button className="btn btn-primary" onClick={handleRunVacuum} disabled={loading} style={{ marginBottom: '14px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="sparkles" size={14} />Запустить оптимизацию (VACUUM & ANALYZE)</span>
                    </button>

                    {vacuumResult && (
                      <div style={{ background: 'light-dark(#f0fdf4, rgba(66, 230, 116, 0.16))', border: '1px solid #86efac', padding: '16px', borderRadius: '6px' }}>
                        <h4 style={{ color: 'light-dark(#15803d, #84ebab)', margin: '0 0 10px 0' }}>Результат оптимизации:</h4>
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
                    <form onSubmit={handleCreateAnnouncement} style={{ background: 'light-dark(#f8fafc, #313338)', padding: '16px', borderRadius: '6px', border: '1px solid light-dark(#e2e8f0, rgba(121, 148, 185, 0.38))' }}>
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
                      <button type="submit" className="btn btn-primary" disabled={annSubmitting}>
                        {annSubmitting ? 'Публикуем…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="megaphone" size={14} />Опубликовать на всех рабочих местах</span>}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            )}

            {/* TAB 6: FILTERS (filters.html) */}
            {activeTab === 'filters' && (
              <div className="admin-tab-pane">
                <h3 style={{ marginBottom: '14px', color: 'light-dark(#1e293b, #a0b2cf)' }}>
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
                    <small style={{ display: 'block', color: 'light-dark(#64748b, #a9aeb5)', marginTop: '4px' }}>
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
                <h3 style={{ marginBottom: '14px', color: 'light-dark(#1e293b, #a0b2cf)' }}>
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
                    border: '1px solid light-dark(#cbd5e1, rgba(126, 151, 180, 0.38))',
                    borderRadius: '8px',
                    padding: '16px',
                    backgroundColor: 'light-dark(#f8fafc, #313338)',
                    marginBottom: '20px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ stroke: "light-dark(#0284c7, #7bcbf4)" }} strokeWidth="2" strokeLinecap="round">
                          <line x1="22" y1="2" x2="11" y2="13"/>
                          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                        <strong style={{ fontSize: '14px', color: 'light-dark(#0f172a, #96aad9)' }}>Интеграция с Telegram (Шлюз оповещений)</strong>
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
                          <label style={{ fontSize: '11px', fontWeight: 600, color: 'light-dark(#475569, #d3d6db)', display: 'block', marginBottom: '4px' }}>
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
                          <label style={{ fontSize: '11px', fontWeight: 600, color: 'light-dark(#475569, #d3d6db)', display: 'block', marginBottom: '4px' }}>
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
                            {telegramTesting ? 'Проверка соединения...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="zap" size={14} />Проверить бота Telegram</span>}
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
                <h3 style={{ marginBottom: '14px', color: 'light-dark(#1e293b, #a0b2cf)' }}>
                  Лицензии MyChat Server (licenses.html)
                </h3>

                <div style={{ background: 'light-dark(#f8fafc, #313338)', border: '1px solid light-dark(#cbd5e1, rgba(126, 151, 180, 0.38))', borderRadius: '8px', padding: '20px', maxWidth: '640px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    <span style={{ display: 'inline-flex', color: 'light-dark(#2563eb, #7ca1f3)' }}><Icon name="building" size={32} /></span>
                    <div>
                      <h4 style={{ margin: 0, color: 'light-dark(#0f172a, #96aad9)' }}>{licenseData?.product_name || 'MyChat Server Enterprise'}</h4>
                      <span style={{ fontSize: '12px', color: 'light-dark(#16a34a, #81eea9)', fontWeight: 600 }}>● Лицензия активна</span>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '10px', fontSize: '12px', borderTop: '1px solid light-dark(#e2e8f0, rgba(121, 148, 185, 0.38))', paddingTop: '14px' }}>
                    <strong>Владелец лицензии:</strong>
                    <span>{licenseData?.license_owner}</span>

                    <strong>Тип лицензии:</strong>
                    <span>{licenseData?.license_type}</span>

                    <strong>Лимит подключений:</strong>
                    <span><strong style={{ color: 'light-dark(#2563eb, #7ca1f3)' }}>{licenseData?.max_online_users}</strong> (Зарегистрировано: {users.length})</span>

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

        {/* Диалоги рендерятся порталом поверх всего, но остаются внутри окна
            консоли по дереву React: щелчок по ним не должен закрывать консоль. */}
        {resetTarget && (
          <ResetPasswordDialog
            user={resetTarget}
            onCancel={() => setResetTarget(null)}
            onSubmit={submitResetPassword}
          />
        )}
        {oneTimePassword && (
          <OneTimePasswordDialog
            title={oneTimePassword.title}
            fullName={oneTimePassword.fullName}
            username={oneTimePassword.username}
            password={oneTimePassword.password}
            onClose={() => setOneTimePassword(null)}
          />
        )}
        {confirmDialog}
      </div>
    </div>
  );
}
