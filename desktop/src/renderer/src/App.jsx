import React, { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import OrgTree from './components/OrgTree';
import ChatView from './components/ChatView';
import GreetingView from './components/GreetingView';
import PersonInfoPanel from './components/PersonInfoPanel';
import MenuBar from './components/MenuBar';
import WhatIsNewModal from './components/WhatIsNewModal';
import UserProfileModal from './components/UserProfileModal';
import LoginView from './components/LoginView';
import AnnouncementsView from './components/AnnouncementsView';
import DatabaseStudioView from './components/DatabaseStudioView';
import RemoteDesktopViewer from './components/RemoteDesktopViewer';
import RemoteDesktopHostModal from './components/RemoteDesktopHostModal';
import AdminUserModal from './components/AdminUserModal';
import ServerConnectModal from './components/ServerConnectModal';
import CommandPalette from './components/CommandPalette';
import ToastNotificationStack, { playNotificationSound } from './components/ToastNotificationStack';
import VoiceCallPanel from './components/VoiceCallPanel';
import { useConfirm } from './components/ConfirmDialog';
import Avatar from './components/Avatar';
import Icon from './components/Icon';
import PresenceControl from './components/PresenceControl';
import WakeAlert from './components/WakeAlert';
import { initialWake, reduceWake } from './lib/wake.mjs';
import { uploadProblem } from './lib/attachments.mjs';

function formatDialogTime(timeStr) {
  if (!timeStr) return '';
  const d = new Date(timeStr);
  const now = new Date();
  
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  return `${day}.${month}.${year}`;
}

// Web Audio Chime Synthesizer for notifications
function playChimeSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {}
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function isAllowedServerUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    const localPage = location.protocol === 'http:' && LOCAL_HOSTS.includes(location.hostname);
    return u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname) && (import.meta.env.DEV || localPage);
  } catch {
    return false;
  }
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('mychat_token') || '');
  const [currentUser, setCurrentUser] = useState(null);
  const [authState, setAuthState] = useState('checking'); // 'checking' | 'authenticated' | 'unauthenticated'
  const [serverInfo, setServerInfo] = useState(null);
  // Пароль и токен уходят только по HTTPS. Сохранённый когда-то адрес с http://
  // (или подсказанный «настройте сервер так-то») молча отправлял бы их открытым
  // текстом; http допустим лишь для localhost при разработке.
  const [serverUrl, setServerUrl] = useState(() => {
    const stored = localStorage.getItem('mychat_server_url');
    if (stored && isAllowedServerUrl(stored)) return stored;
    return isAllowedServerUrl(window.location.origin) ? window.location.origin : 'https://chat-production-0456.up.railway.app';
  });
  const [wsConnected, setWsConnected] = useState(false);

  // Обработчики WebSocket, таймеры и подписки создаются один раз и видят
  // значения на момент создания. Токен же меняется — после входа по паролю,
  // после смены пароля, — и старые обработчики продолжали ходить на сервер с
  // прежним: список диалогов молча получал 401 и переставал обновляться.
  const tokenRef = useRef(token);
  const serverUrlRef = useRef(serverUrl);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { serverUrlRef.current = serverUrl; }, [serverUrl]);
  const loggingOutRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const hadSocketSessionRef = useRef(false);
  const typingTimersRef = useRef({});
  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'channels' | 'contacts' | 'important' | 'db'
  
  // Base Data
  const [treeData, setTreeData] = useState(null);
  const [users, setUsers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [directConvos, setDirectConvos] = useState([]);
  const [dialogSearch, setDialogSearch] = useState('');
  const [channelSearch, setChannelSearch] = useState('');
  
  // Active Chat & UI state
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [typingMap, setTypingMap] = useState({});
  const [unreadAnnCount, setUnreadAnnCount] = useState(0);
  const [unreadMap, setUnreadMap] = useState({});
  // Непрочитанное в каналах — отдельно: номер канала и номер сотрудника
  // совпадают, и общий словарь путал счётчик канала №5 с диалогом сотрудника №5.
  const [channelUnread, setChannelUnread] = useState({});
  const [windowFocused, setWindowFocused] = useState(true);
  const windowFocusedRef = useRef(true);
  const activeChatRef = useRef(activeChat);

  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);

  // Открытый чат ещё не значит «виден»: на вкладках «Важное» или «База данных»
  // он не отрисовывается вовсе. Без этой проверки пришедшее сообщение
  // считалось прочитанным на месте — ни счётчика, ни уведомления, ни звука,
  // при том что показать его было негде.
  const isChatVisibleRef = useRef(false);
  useEffect(() => {
    isChatVisibleRef.current = ['chats', 'channels', 'contacts'].includes(activeTab);
  }, [activeTab]);
  useEffect(() => { windowFocusedRef.current = windowFocused; }, [windowFocused]);
  const [isPersonPanelOpen, setIsPersonPanelOpen] = useState(true);

  // Resizable Sidebar State
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('mychat_sidebar_width');
    return saved ? Math.max(260, Math.min(650, parseInt(saved, 10))) : 360;
  });
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);

  const startResizingSidebar = (e) => {
    e.preventDefault();
    setIsDraggingSidebar(true);
    const startX = e.clientX;
    const startW = sidebarWidth;

    const onMouseMove = (moveEvent) => {
      const newW = Math.max(260, Math.min(650, startW + (moveEvent.clientX - startX)));
      setSidebarWidth(newW);
    };

    const onMouseUp = () => {
      setIsDraggingSidebar(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    localStorage.setItem('mychat_sidebar_width', String(sidebarWidth));
  }, [sidebarWidth]);
  
  // Modals
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showCreateChannelModal, setShowCreateChannelModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelTopic, setNewChannelTopic] = useState('');
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  // Сотрудник, чью карточку надо открыть сразу при входе в консоль.
  const [adminFocusUserId, setAdminFocusUserId] = useState(null);
  // Отказ при загрузке базовых данных. Без него боковая панель показывала
  // «Загрузка…» вечно и ничего не объясняла.
  const [baseDataError, setBaseDataError] = useState(null);
  const [showServerConnectModal, setShowServerConnectModal] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  // Системный confirm() останавливает всё окно: пока он открыт, не приходят ни
  // сообщения, ни звонки. Вопросы задаются окном приложения.
  const [confirm, confirmDialog] = useConfirm();

  // Floating Corner Toasts & Remote Desktop
  const [toasts, setToasts] = useState([]);
  // Побудки, которые поставил я: { [id собеседника]: последнее событие }.
  const [wake, setWake] = useState(initialWake);
  // Побудка, которая пришла мне и ещё не отозвана.
  const [incomingWake, setIncomingWake] = useState(null);
  const [rdPrompt, setRdPrompt] = useState(null);
  const [inlineRdViewer, setInlineRdViewer] = useState(null);
  const [rdPendingTarget, setRdPendingTarget] = useState(null);
  const [rdSessionId, setRdSessionId] = useState(null);
  const [rdPendingOffer, setRdPendingOffer] = useState(null);
  // Кандидаты соединения, пришедшие до появления окна просмотра. Сотрудник
  // начинает их слать сразу после согласия; потерянные кандидаты — это сеанс,
  // который «висит на подключении» до таймаута.
  const [rdPendingCandidates, setRdPendingCandidates] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const activeCallRef = useRef(null);
  useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);
  const inlineRdViewerRef = useRef(null);
  const rdSessionIdRef = useRef(null);
  const rdPromptRef = useRef(null);
  useEffect(() => { inlineRdViewerRef.current = inlineRdViewer; }, [inlineRdViewer]);
  useEffect(() => { rdSessionIdRef.current = rdSessionId; }, [rdSessionId]);
  useEffect(() => { rdPromptRef.current = rdPrompt; }, [rdPrompt]);

  // Escape closes whichever modal/dropdown is open, so the user never has
  // to hunt for a tiny ✕ button.
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key !== 'Escape') return;
      if (showProfileModal) setShowProfileModal(false);
      if (showAboutModal) setShowAboutModal(false);
      if (showCreateChannelModal) setShowCreateChannelModal(false);
      if (showAdminModal) setShowAdminModal(false);
      if (showServerConnectModal) setShowServerConnectModal(false);
      if (showStatusDropdown) setShowStatusDropdown(false);
      if (showCommandPalette) setShowCommandPalette(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showProfileModal, showAboutModal, showCreateChannelModal, showAdminModal, showServerConnectModal, showStatusDropdown, showCommandPalette]);

  // Ctrl+K / Cmd+K — quick switcher to jump to a person, channel, or message.
  useEffect(() => {
    const handleShortcut = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
    };
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, []);

  const wsRef = useRef(null);
  const usersRef = useRef(users);
  const channelsRef = useRef(channels);
  const currentUserRef = useRef(currentUser);

  useEffect(() => { usersRef.current = users; }, [users]);
  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  useEffect(() => {
    fetchServerInfo();
  }, [serverUrl]);
  // Window Focus & Blur Listener for Taskbar Flashing & Read state
  useEffect(() => {
    const handleFocus = () => {
      setWindowFocused(true);
      windowFocusedRef.current = true;
      if (activeChatRef.current && activeChatRef.current.type === 'direct') {
        const uid = activeChatRef.current.id;
        setUnreadMap((prev) => ({ ...prev, [uid]: 0 }));
      }
      if (window.electronAPI && window.electronAPI.flashFrame) {
        window.electronAPI.flashFrame(false);
      }
    };

    const handleBlur = () => {
      setWindowFocused(false);
      windowFocusedRef.current = false;
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    if (window.electronAPI && window.electronAPI.onWindowFocus) {
      window.electronAPI.onWindowFocus(handleFocus);
    }
    if (window.electronAPI && window.electronAPI.onWindowBlur) {
      window.electronAPI.onWindowBlur(handleBlur);
    }

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const fetchServerInfo = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/settings/info`);
      if (res.ok) {
        const data = await res.json();
        setServerInfo(data);
      }
    } catch (err) {
      console.warn('Failed to fetch server info:', err);
    }
  };

  // Session bootstrap on launch: restore a stored token, else try a silent
  // reissue for an already admin-paired device, else fall through to LoginView.
  // Never falls through to a passwordless "pick any colleague" flow anymore —
  // see docs/designs/auth-access-control-remediation.md item 2.
  useEffect(() => {
    initializeSession();
  }, [serverUrl]);

  // While must_change_password is set the server rejects the WebSocket
  // upgrade and 403s every route but /auth/me and /users/password, so
  // connecting now would just fail — and ws.onclose would retry it every 3s
  // for as long as the user sits on the password screen.
  // handleForcedPasswordChange starts both once the password is changed.
  const openSessionChannels = (user, authToken) => {
    if (user?.must_change_password) return;
    initWebSocket(authToken);
    loadBaseData(authToken);
  };

  // Возвращает 'ok' | 'invalid' | 'offline'. Разделение важно: раньше любая
  // неудача считалась недействительным токеном, поэтому кратковременный обрыв
  // связи или ещё не проснувшийся сервер выбрасывали человека на экран входа
  // и заставляли вводить пароль заново.
  const tryRestoreSession = async (authToken) => {
    let res;
    try {
      res = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
    } catch {
      return 'offline';
    }

    if (res.status === 401 || res.status === 403) return 'invalid';
    if (!res.ok) return 'offline';

    const data = await res.json();
    tokenRef.current = authToken;
    setToken(authToken);
    setCurrentUser(data.user);
    setAuthState('authenticated');
    openSessionChannels(data.user, authToken);
    return 'ok';
  };

  // Номер устройства — открытый: его видят администраторы при привязке.
  // Секрет — 256 случайных бит, которые знает только этот компьютер: без него
  // сервер не пускает без пароля, как бы ни стал известен номер.
  const deviceIdentity = () => {
    const random = (bytes) => {
      const buf = new Uint8Array(bytes);
      crypto.getRandomValues(buf);
      return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    let deviceId = localStorage.getItem('mychat_device_id');
    if (!deviceId) {
      deviceId = 'dev-' + random(12);
      localStorage.setItem('mychat_device_id', deviceId);
    }
    let deviceSecret = localStorage.getItem('mychat_device_secret');
    if (!deviceSecret) {
      deviceSecret = random(32);
      localStorage.setItem('mychat_device_secret', deviceSecret);
    }
    return { deviceId, deviceSecret };
  };

  const attemptSilentDeviceLogin = async () => {
    try {
      const { deviceId, deviceSecret } = deviceIdentity();

      let devInfo = null;
      if (window.electronAPI && window.electronAPI.getDeviceInfo) {
        try {
          devInfo = await window.electronAPI.getDeviceInfo();
        } catch (e) {}
      }

      const knockRes = await fetch(serverUrl + '/api/auth/knock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceId,
          device_secret: deviceSecret,
          device_name: (devInfo && devInfo.hostname) || 'ПК пользователя',
          platform: (devInfo && devInfo.platform) || 'Windows 11',
          client_version: '1.0.0'
        })
      });

      if (knockRes.ok) {
        const knockData = await knockRes.json();
        if (knockData.status === 'paired' && knockData.token) {
          tokenRef.current = knockData.token;
          setToken(knockData.token);
          localStorage.setItem('mychat_token', knockData.token);
          setCurrentUser(knockData.user);
          setAuthState('authenticated');
          openSessionChannels(knockData.user, knockData.token);
          return true;
        }
      }
    } catch (err) {
      console.error('Silent device login error:', err);
    }
    return false;
  };

  const initializeSession = async () => {
    setAuthState('checking');
    const storedToken = localStorage.getItem('mychat_token');

    if (storedToken) {
      // Повторяем несколько раз: сервер может быть ещё не поднят (в облаке
      // контейнер просыпается не мгновенно), а сеть на ноутбуке — не готова
      // сразу после запуска Windows. Просить пароль в этот момент неправильно:
      // сессия-то действующая.
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await tryRestoreSession(storedToken);
        if (result === 'ok') return;
        if (result === 'invalid') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // A device paired by an admin logs in silently, which would otherwise
    // undo an explicit logout on the very next launch.
    if (localStorage.getItem('mychat_logged_out') !== '1' && (await attemptSilentDeviceLogin())) return;
    localStorage.removeItem('mychat_token');
    setToken('');
    setCurrentUser(null);
    setAuthState('unauthenticated');
  };

  const handleLoginSuccess = (user, authToken, cleanServerUrl) => {
    if (cleanServerUrl && cleanServerUrl !== serverUrl) {
      setServerUrl(cleanServerUrl);
      localStorage.setItem('mychat_server_url', cleanServerUrl);
    }
    localStorage.removeItem('mychat_logged_out');
    tokenRef.current = authToken;
    setToken(authToken);
    setCurrentUser(user);
    setAuthState('authenticated');
    openSessionChannels(user, authToken);

    // Вход по паролю подтверждает, что устройство принадлежит этому сотруднику:
    // если администратор его привязал, следующие запуски пройдут без пароля.
    // Отказ не мешает работе — просто в следующий раз снова спросят пароль.
    const { deviceId, deviceSecret } = deviceIdentity();
    fetch((cleanServerUrl || serverUrl) + '/api/auth/device/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ device_id: deviceId, device_secret: deviceSecret })
    }).catch(() => {});
  };

  // The operator asks the SERVER for a session and waits: it checks the
  // can_remote_control permission an administrator granted, then prompts the
  // colleague for consent. Opening the viewer straight away with a locally
  // invented session id is what left it waiting forever — nothing had been
  // requested of anyone. The viewer opens on rd_accepted.
  // Отметка о прочтении. Сервер, таблица статусов и рассылка отправителю
  // существовали и работали — не хватало ровно этого вызова, поэтому у
  // отправителя навсегда оставалась одна галочка.
  //
  // Прочитанным считается только то, что человек реально мог увидеть: окно в
  // фокусе и открыт именно этот диалог. Иначе «прочитано» означало бы лишь
  // «приложение запущено».
  const markConversationRead = (chat = activeChatRef.current) => {
    if (!chat || !windowFocusedRef.current || !isChatVisibleRef.current) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'mark_read',
      conversationType: chat.type,
      targetId: chat.id
    }));
    if (chat.type === 'channel') {
      setChannelUnread((prev) => (prev[chat.id] ? { ...prev, [chat.id]: 0 } : prev));
    } else {
      setUnreadMap((prev) => (prev[chat.id] ? { ...prev, [chat.id]: 0 } : prev));
    }
  };

  // ChatView вызывает markConversationRead сам при переключении диалога и
  // когда прокрутка внизу. Здесь остаётся один случай, который он не ловит:
  // окно свернули с открытым чатом, сообщения пришли, окно вернули — увидеть
  // их человек мог только сейчас.
  useEffect(() => {
    if (authState !== 'authenticated' || !windowFocused) return;
    markConversationRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowFocused, authState]);

  const handleStartCall = (targetUser) => {
    const peer = targetUser || activeChat?.user;
    if (!peer) return;
    if (activeCall) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addToast({ title: 'Нет связи с сервером', body: 'Подключение потеряно, повторите попытку', type: 'system' });
      return;
    }
    setActiveCall({ direction: 'outgoing', peer });
  };

  const handleRequestRemoteDesktop = (targetUser) => {
    const target = targetUser || activeChat?.user;
    if (!target) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addToast({ title: 'Нет связи с сервером', body: 'Подключение потеряно, повторите попытку', type: 'system' });
      return;
    }
    setRdPendingTarget(target);
    wsRef.current.send(JSON.stringify({ type: 'rd_request', targetUserId: target.id }));
  };

  const handleLogout = async () => {
    // Кнопка выхода стоит рядом с именем в строке состояния и выглядит как
    // переход в профиль. Выйти по неосторожности — значит заново вводить
    // пароль, поэтому спрашиваем.
    const confirmed = await confirm({
      title: 'Выход из учётной записи',
      message: 'Выйти из учётной записи? Для продолжения работы потребуется снова ввести пароль.',
      confirmText: 'Выйти',
      cancelText: 'Остаться'
    });
    if (!confirmed) {
      return;
    }
    localStorage.setItem('mychat_logged_out', '1');
    // Раньше очищались только токен и пользователь: открытый чат, сообщения,
    // счётчики и уведомления прежнего сотрудника оставались в памяти, и тот,
    // кто входил следующим за этим компьютером, видел чужую переписку.
    forceLogout(null);
  };

  // Сервер больше не принимает этот сеанс: пароль сброшен, права роли
  // изменены, учётная запись отключена. Интерфейс при этом оставался на месте
  // со старыми данными и молча получал отказы. Перезагрузка окна — надёжный
  // способ сбросить всё состояние прежнего сеанса разом: чат, счётчики,
  // звонок, открытые окна.
  const forceLogout = (reason) => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    const ws = wsRef.current;
    if (ws) {
      ws.noReconnect = true;
      try { ws.close(); } catch {}
    }
    localStorage.removeItem('mychat_token');
    if (reason) {
      try { sessionStorage.setItem('mychat_logout_reason', reason); } catch {}
    }
    window.location.reload();
  };

  // Запрос от имени текущего сеанса. Отказ 401 означает, что сеанс отозван, —
  // продолжать показывать данные, которые больше не обновятся, нельзя.
  const authFetch = async (url, options = {}) => {
    const res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${tokenRef.current}` }
    });
    if (res.status === 401) forceLogout('Сеанс истёк или был отозван — войдите заново');
    return res;
  };

  // Forced password change gate (currentUser.must_change_password) — see
  // docs/designs/auth-access-control-remediation.md item 10.
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);

  // Смена пароля обрывает все ранее выданные токены, поэтому сервер сразу
  // возвращает новый. Его нужно принять и сохранить, иначе следующий запрос
  // получит 401 и выбросит человека на экран входа — сразу после того, как он
  // успешно сменил пароль.
  const handleTokenRenewed = (nextToken) => {
    if (!nextToken) return;
    tokenRef.current = nextToken;
    setToken(nextToken);
    localStorage.setItem('mychat_token', nextToken);
    initWebSocket(nextToken);
  };

  const handleForcedPasswordChange = async (e) => {
    e.preventDefault();
    setPwError('');
    // Требование сервера — не короче восьми символов. Проверка здесь нужна
    // только чтобы не гонять заведомо негодный пароль по сети; отказ сервера
    // всё равно показывается ниже.
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось сменить пароль');

      setPwOld(''); setPwNew(''); setPwConfirm('');
      setCurrentUser((prev) => (prev ? { ...prev, must_change_password: 0 } : prev));

      // Смена пароля обрывает все ранее выданные токены — включая тот, которым
      // мы только что пользовались. Сервер возвращает новый; без него
      // следующий же запрос получил бы 401 и выбросил человека на вход прямо
      // после успешной смены пароля.
      const nextToken = data.token || token;
      if (data.token) {
        tokenRef.current = data.token;
        setToken(data.token);
        localStorage.setItem('mychat_token', data.token);
      }
      initWebSocket(nextToken);
      loadBaseData(nextToken);
    } catch (err) {
      setPwError(err.message || 'Не удалось сменить пароль');
    } finally {
      setPwSubmitting(false);
    }
  };

  const handleApplyServer = (newUrl) => {
    if (!isAllowedServerUrl(newUrl)) return;
    setServerUrl(newUrl);
    localStorage.setItem('mychat_server_url', newUrl);
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
    }
    addToast({
      title: 'Сетевой сервер MyChat',
      body: `Адрес изменен на: ${newUrl}. Выполняется подключение...`,
      type: 'chat'
    });
  };

    // Periodic Random Reminder Nudge for Unread Messages (randomly within the hour)
  useEffect(() => {
    const totalUnread = Object.values(unreadMap).reduce((a, b) => a + b, 0);
    if (totalUnread <= 0) return;

    // Pick a random interval between 20 and 50 minutes (in ms)
    const randomDelay = Math.floor((20 + Math.random() * 30) * 60 * 1000);
    const timer = setTimeout(() => {
      if (totalUnread > 0 && !windowFocusedRef.current) {
        const senderNames = Object.keys(unreadMap)
          .filter((id) => unreadMap[id] > 0)
          .map((id) => {
            const u = usersRef.current.find((usr) => usr.id === Number(id));
            return u ? (u.full_name || u.username) : 'Коллега';
          })
          .slice(0, 3)
          .join(', ');

        const title = 'Напоминание о непрочитанных сообщениях';
        const body = 'У вас ' + totalUnread + ' непрочитанных сообщений от: ' + (senderNames || 'коллег') + '. Нажмите, чтобы открыть.';

        if (currentUserRef.current?.status === 'dnd') return;
        if (window.electronAPI && window.electronAPI.showNotification) {
          window.electronAPI.showNotification({ title, body, type: 'chat', isUrgent: true });
          window.electronAPI.flashFrame(true);
        } else {
          addToast({ title, body, type: 'chat', isUrgent: true });
        }
        if (currentUserRef.current?.status !== 'dnd') playChimeSound();
      }
    }, randomDelay);

    return () => clearTimeout(timer);
  }, [unreadMap, windowFocused]);
  // Set Window Title dynamically matching Screenshot 1 & 2
  useEffect(() => {
    const company = serverInfo?.company_name || 'АО "Страховая компания "Сентрас Иншуранс"';
    if (currentUser) {
      const statusText = currentUser.status === 'online' ? 'В сети' : currentUser.status === 'away' ? 'Отошёл' : currentUser.status === 'dnd' ? 'Не беспокоить' : 'Не в сети';
      const extText = currentUser.extension ? ` (в.н.${currentUser.extension})` : '';
      const name = currentUser.full_name || currentUser.username;
      document.title = `MyChat Client 2025.3.1 — ${name}${extText} [${company}] (${statusText})`;
    } else {
      document.title = `MyChat Client 2025.3.1 — [${company}]`;
    }
  }, [currentUser, serverInfo]);

  // Ровно одно уведомление на событие. Раньше показывались оба сразу —
  // карточка в приложении и системное окно Windows поверх неё.
  // Окно в фокусе — человек и так смотрит в приложение, карточки достаточно.
  // Окно свёрнуто или перекрыто — карточку никто не увидит, нужно системное.
  const addToast = ({ title, body, type = 'chat', isUrgent = false, avatarText = '', data = null }) => {
    // «Не беспокоить»: сообщения из переписок и каналов не всплывают и не
    // звучат — счётчики непрочитанного остаются. Запросы удалённого доступа,
    // оповещения и ошибки показываются, но без звука.
    const quiet = currentUserRef.current?.status === 'dnd';
    if (quiet && (type === 'chat' || type === 'channel')) return;
    const useNative = !windowFocusedRef.current && window.electronAPI?.showNotification;

    if (useNative) {
      // data обязательно передаётся дальше: главный процесс возвращает этот
      // же объект при клике по уведомлению, и по нему открывается нужный чат.
      // Без него клик просто разворачивал окно и ничего не открывал.
      window.electronAPI.showNotification({ title, body, type, isUrgent, avatarText, data });
      return;
    }

    const id = Date.now().toString() + Math.random().toString(36).substring(2, 5);
    setToasts((prev) => [{ id, title, body, type, isUrgent, avatarText, data }, ...prev].slice(0, 5));
    if (!quiet) playNotificationSound(isUrgent);
  };

  const dismissToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Пришло сообщение — обновить нужно только список переписок: порядок,
  // последнюю строку и счётчик непрочитанных. Раньше здесь вызывался
  // loadBaseData, то есть на КАЖДОЕ сообщение заново тянулись оргструктура,
  // весь список сотрудников, каналы и объявления — пять запросов вместо
  // одного, и в оживлённой переписке это заметно и на сервере, и на связи.
  // Счётчики непрочитанного берутся с сервера: живые события лишь добавляют к
  // ним новое. Раньше первое же пришедшее сообщение превращало «5» в «1».
  const syncUnreadFromConvos = (convos) => {
    setUnreadMap((prev) => {
      const active = activeChatRef.current;
      const next = { ...prev };
      for (const c of convos || []) {
        const isOpen =
          active?.type === 'direct' && active.id === c.user_id &&
          isChatVisibleRef.current && windowFocusedRef.current;
        next[c.user_id] = isOpen ? 0 : Number(c.unread_count || 0);
      }
      return next;
    });
  };

  const syncChannelUnread = (list) => {
    setChannelUnread(() => {
      const active = activeChatRef.current;
      const next = {};
      for (const ch of list || []) {
        const isOpen = active?.type === 'channel' && active.id === ch.id && isChatVisibleRef.current;
        next[ch.id] = isOpen ? 0 : Number(ch.unread_count || 0);
      }
      return next;
    });
  };

  const refreshConversations = async () => {
    try {
      const res = await authFetch(`${serverUrlRef.current}/api/conversations/direct`);
      if (res.ok) {
        const convos = await res.json();
        setDirectConvos(convos);
        syncUnreadFromConvos(convos);
      }
    } catch {}
  };

  const refreshAnnouncementCount = async () => {
    try {
      const res = await authFetch(`${serverUrlRef.current}/api/announcements`);
      if (!res.ok) return;
      const list = await res.json();
      setUnreadAnnCount(list.filter((a) => a.is_confirmed !== 1).length);
    } catch {}
  };

  const loadBaseData = async (authToken = tokenRef.current) => {
    try {
      const headers = { Authorization: `Bearer ${authToken}` };
      const base = serverUrlRef.current;
      const [treeRes, usersRes, channelsRes, convosRes, annRes] = await Promise.all([
        fetch(`${base}/api/org/tree`, { headers }),
        fetch(`${base}/api/users`, { headers }),
        fetch(`${base}/api/channels`, { headers }),
        fetch(`${base}/api/conversations/direct`, { headers }),
        fetch(`${base}/api/announcements`, { headers })
      ]);

      if ([treeRes, usersRes, channelsRes, convosRes, annRes].some((r) => r.status === 401)) {
        forceLogout('Сеанс истёк или был отозван — войдите заново');
        return;
      }

      if (treeRes.ok) setTreeData(await treeRes.json());
      if (usersRes.ok) {
        const uList = await usersRes.json();
        setUsers(uList);
      }
      if (channelsRes.ok) {
        const list = await channelsRes.json();
        setChannels(list);
        syncChannelUnread(list);
      }
      if (convosRes.ok) {
        const convos = await convosRes.json();
        setDirectConvos(convos);
        syncUnreadFromConvos(convos);
      }

      if (annRes.ok) {
        const anns = await annRes.json();
        const unconfirmed = anns.filter((a) => a.is_confirmed !== 1).length;
        setUnreadAnnCount(unconfirmed);
      }

      // Оргструктура — единственное, без чего боковая панель остаётся пустой.
      // Раньше при отказе она просто показывала «Загрузка…» бесконечно: ни
      // объяснения, ни возможности повторить.
      setBaseDataError(treeRes.ok ? null : 'Не удалось получить структуру компании');
    } catch (err) {
      console.error('Base data load error:', err);
      setBaseDataError('Нет связи с сервером');
    }
  };

  // WebSocket Gateway
  const initWebSocket = (authToken) => {
    // Detach the old socket's handlers before closing it. Without this its
    // own onclose still fires and reconnects 3s later, leaving an orphaned
    // second socket alive — every server event then arrived twice. React's
    // StrictMode double-mounts the effect that calls this in development,
    // which is exactly how that second socket appeared.
    const previous = wsRef.current;
    if (previous) {
      previous.onopen = null;
      previous.onclose = null;
      previous.onmessage = null;
      previous.close();
    }

    const base = serverUrlRef.current;
    const cleanHost = base.replace(/^https?:\/\//, '');
    const protocol = base.startsWith('https') ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${cleanHost}/ws`;

    const ws = new WebSocket(wsUrl);
    // По умолчанию двоичные сообщения приходят объектами Blob, а прочитать Blob
    // можно только асинхронно. Для звука это означало, что кадры разбирались
    // вперемешку — с задержкой и не по порядку. ArrayBuffer разбирается сразу.
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    // «Подключено» — только после того, как сервер принял токен (auth_success).
    // Раньше зелёная точка загоралась на открытии сокета, и отвергнутый сеанс
    // выглядел рабочим, а отправленные сообщения пропадали.
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    };

    ws.onclose = () => {
      // Only the current socket may schedule a reconnect; a superseded one
      // must stay dead.
      if (wsRef.current !== ws) return;
      setWsConnected(false);
      setWake((prev) => reduceWake(prev, { type: 'wake_disconnected' }));
      if (ws.noReconnect) return;
      // Пауза растёт — 2, 4, 8… до 30 секунд — со случайной добавкой: после
      // перезапуска сервера весь офис не должен ломиться в одну и ту же секунду.
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(30000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
      setTimeout(() => {
        if (wsRef.current === ws && tokenRef.current) initWebSocket(tokenRef.current);
      }, delay);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleWsEvent(data);
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };
  };

  // The server announces one saved message as BOTH direct_message/channel_message
  // and new_message, so appending on every event showed each message twice.
  // new_message is ignored here; the typed events carry the same row.
  const appendMessage = (prev, msg) =>
    prev.some((m) => m.id && m.id === msg.id) ? prev : [...prev, msg];

  const handleWsEvent = (event) => {
    switch (event.type) {
      case 'new_message':
        break;

      // ── Состояние сеанса ────────────────────────────────────────────────
      case 'auth_success':
        // Сервер считает только что подключившегося человека «в сети».
        presenceRef.current = 'online';
        setWsConnected(true);
        reconnectAttemptRef.current = 0;
        // Пока связи не было, могли прийти сообщения и смениться статусы —
        // без досинхронизации они не появлялись до перезапуска приложения.
        // И при первом подключении тоже: список сотрудников приходит запросом
        // раньше, чем открывается соединение, и смены статуса в этот промежуток
        // терялись — коллега, который уже в сети, до следующего события
        // показывался «не в сети».
        loadBaseData(tokenRef.current);
        if (hadSocketSessionRef.current) {
          reloadActiveChatHistory();
        }
        hadSocketSessionRef.current = true;
        break;

      case 'auth_error':
        if (event.code === 'MUST_CHANGE_PASSWORD') {
          if (wsRef.current) wsRef.current.noReconnect = true;
          try { wsRef.current?.close(); } catch {}
          setCurrentUser((prev) => (prev ? { ...prev, must_change_password: 1 } : prev));
        } else if (event.code === 'RATE_LIMITED') {
          // Сокет закрывается, переподключение пойдёт с нарастающей паузой.
          try { wsRef.current?.close(); } catch {}
        } else {
          forceLogout('Сеанс завершён: пароль или права доступа изменились — войдите заново');
        }
        break;

      case 'server_disconnect':
        forceLogout(event.reason || 'Сеанс завершён администратором');
        break;

      case 'error':
        if (event.context === 'send_message') {
          addToast({
            title: 'Сообщение не отправлено',
            body: `${event.message}${event.text ? ` — «${String(event.text).slice(0, 80)}»` : ''}`,
            type: 'system',
            isUrgent: true
          });
        }
        break;

      case 'rd_end': {
        // Сеанс закончила другая сторона или она потеряла связь.
        if (inlineRdViewerRef.current?.sessionId === event.sessionId) {
          setInlineRdViewer(null);
          setRdPendingOffer(null);
          setRdSessionId(null);
          addToast({ title: 'Сеанс удалённого доступа завершён', body: event.reason || 'Сотрудник завершил сеанс', type: 'system' });
        }
        if (rdSessionIdRef.current === event.sessionId) {
          setRdPendingTarget(null);
          setRdSessionId(null);
          setRdPendingCandidates(null);
        }
        if (rdPromptRef.current?.sessionId === event.sessionId) {
          setRdPrompt(null);
        }
        break;
      }

      // ── Удалённый рабочий стол ──────────────────────────────────────────
      case 'rd_prompt':
        // Прилетает сотруднику, у которого просят доступ к экрану.
        setRdPrompt(event);
        break;

      case 'rd_denied':
        setRdPendingTarget(null);
        addToast({ title: 'Удалённый доступ отклонён', body: event.reason || 'Недостаточно прав', type: 'system' });
        break;

      case 'rd_requested':
        setRdSessionId(event.sessionId);
        break;

      // ── Кто печатает ────────────────────────────────────────────────────
      case 'user_typing': {
        if (event.userId === currentUserRef.current?.id) break;
        // В личной переписке сервер шлёт targetId получателя — то есть мой
        // собственный. Диалог же в интерфейсе привязан к собеседнику, поэтому
        // ключом служит тот, кто печатает. В канале targetId — это сам канал.
        // Ключ включает тип переписки: канал №5 и сотрудник №5 иначе делили
        // одну надпись «печатает…».
        const key = event.conversationType === 'channel' ? `channel:${event.targetId}` : `direct:${event.userId}`;
        const timerKey = `${key}|${event.userId}`;
        const removeTyping = () =>
          setTypingMap((prev) => ({
            ...prev,
            [key]: (prev[key] || []).filter((name) => name !== event.userName)
          }));
        clearTimeout(typingTimersRef.current[timerKey]);
        if (event.isTyping) {
          setTypingMap((prev) => {
            const without = (prev[key] || []).filter((name) => name !== event.userName);
            return { ...prev, [key]: [...without, event.userName] };
          });
          // «Перестал печатать» может потеряться вместе со связью — надпись не
          // должна висеть вечно.
          typingTimersRef.current[timerKey] = setTimeout(removeTyping, 6000);
        } else {
          removeTyping();
        }
        break;
      }

      // ── Статусы доставки и прочтения ────────────────────────────────────
      case 'messages_read': {
        // Собеседник открыл диалог — наши сообщения у него прочитаны.
        // Новый массив — только если что-то действительно изменилось. Иначе
        // каждый повтор события перерисовывал переписку, а ChatView на каждую
        // перерисовку отправлял отметку о прочтении: два открытых диалога
        // обменивались ими тысячи раз в секунду.
        const ids = new Set(event.messageIds || []);
        if (!ids.size) break;
        setMessages((prev) => {
          let changed = false;
          const next = prev.map((m) => {
            if (!ids.has(m.id) || m.delivery_status === 'read') return m;
            changed = true;
            return { ...m, delivery_status: 'read' };
          });
          return changed ? next : prev;
        });
        break;
      }

      case 'message_status_updated':
        setMessages((prev) => {
          let changed = false;
          const next = prev.map((m) => {
            if (m.id !== event.messageId) return m;
            // 'delivered' не должен затирать уже проставленное 'read':
            // события могут прийти не в том порядке, в каком случились.
            const status = m.delivery_status === 'read' ? 'read' : event.status;
            if (status === m.delivery_status) return m;
            changed = true;
            return { ...m, delivery_status: status };
          });
          return changed ? next : prev;
        });
        break;

      // ── Голосовые звонки ────────────────────────────────────────────────
      case 'call_offer': {
        // Уже говорим с кем-то — сообщаем звонящему, что занято.
        if (activeCallRef.current) {
          wsRef.current?.send(JSON.stringify({ type: 'call_rejected', targetUserId: event.senderId }));
          break;
        }
        const caller = usersRef.current.find((u) => u.id === event.senderId);
        setActiveCall({
          direction: 'incoming',
          offer: event.sdp,
          peer: caller || { id: event.senderId, full_name: event.senderName }
        });
        playNotificationSound();
        break;
      }

      case 'call_denied':
      case 'call_unavailable':
        if (!activeCallRef.current) {
          addToast({ title: 'Звонок не состоялся', body: event.reason || 'Сотрудник недоступен', type: 'system' });
        }
        break;

      case 'rd_ice_candidate':
        // Только для своего запроса и только пока окно просмотра не открыто:
        // открытое окно принимает кандидатов само.
        if (
          event.candidate &&
          rdSessionIdRef.current === event.sessionId &&
          inlineRdViewerRef.current?.sessionId !== event.sessionId
        ) {
          setRdPendingCandidates((prev) =>
            prev && prev.sessionId === event.sessionId
              ? { sessionId: event.sessionId, list: [...prev.list, event.candidate].slice(-50) }
              : { sessionId: event.sessionId, list: [event.candidate] }
          );
        }
        break;

      case 'rd_webrtc_offer':
        // The host starts offering the moment it accepts, which is before the
        // viewer component has mounted and attached its own listener. Keep the
        // offer here and hand it over, otherwise the very first one is lost
        // and the screen never appears.
        setRdPendingOffer({ sessionId: event.sessionId, sdp: event.sdp });
        break;

      case 'rd_response': {
        setRdPendingTarget(null);
        if (!event.accepted) {
          const who = event.targetName || 'Сотрудник';
          const body =
            event.reason === 'busy'
              ? `${who} уже в другом сеансе удалённого доступа — повторите позже`
              : event.reason === 'capture_failed'
              ? `У сотрудника ${who} не запустилась трансляция экрана`
              : event.reason === 'superseded'
              ? 'Запрос заменён более новым'
              : `${who} отказал в доступе к рабочему столу`;
          addToast({ title: 'Запрос отклонён', body, type: 'system' });
          setRdSessionId(null);
          setRdPendingCandidates(null);
          break;
        }
        setInlineRdViewer({
          sessionId: event.sessionId,
          accessLevel: event.accessLevel,
          targetUser: { id: event.targetUserId, full_name: event.targetName }
        });
        break;
      }

      case 'direct_message': {
        const msg = event.message;
        const cUser = currentUserRef.current;
        const otherUserId = msg.sender_id === cUser?.id ? msg.target_id : msg.sender_id;

        setMessages((prev) => {
          if (activeChatRef.current && activeChatRef.current.type === 'direct' && activeChatRef.current.id === otherUserId) {
            return appendMessage(prev, msg);
          }
          return prev;
        });

        refreshConversations();

        if (msg.sender_id !== cUser?.id) {
          const isCurrentActive =
            isChatVisibleRef.current &&
            activeChatRef.current?.type === 'direct' &&
            activeChatRef.current.id === msg.sender_id &&
            windowFocusedRef.current;

          if (!isCurrentActive) {
            setUnreadMap((prev) => ({
              ...prev,
              [msg.sender_id]: (prev[msg.sender_id] || 0) + 1
            }));

            const sender = usersRef.current.find((u) => u.id === msg.sender_id);
            const senderName = sender ? (sender.full_name || sender.username) : 'Коллега';

            addToast({
              title: senderName,
              body: msg.text,
              type: 'chat',
              avatarText: senderName ? senderName.substring(0, 2).toUpperCase() : 'ЧТ',
              data: { user: sender }
            });

            if (window.electronAPI && window.electronAPI.flashFrame) {
              window.electronAPI.flashFrame(true);
            }
            if (currentUserRef.current?.status !== 'dnd') playChimeSound();
          }
        }
        break;
      }

      case 'channel_message': {
        const msg = event.message;
        const cUser = currentUserRef.current;

        setMessages((prev) => {
          if (activeChatRef.current && activeChatRef.current.type === 'channel' && activeChatRef.current.id === msg.target_id) {
            return appendMessage(prev, msg);
          }
          return prev;
        });

        if (msg.sender_id !== cUser?.id) {
          const isCurrentActive =
            isChatVisibleRef.current &&
            activeChatRef.current?.type === 'channel' &&
            activeChatRef.current.id === msg.target_id &&
            windowFocusedRef.current;
          if (!isCurrentActive) {
            setChannelUnread((prev) => ({ ...prev, [msg.target_id]: (prev[msg.target_id] || 0) + 1 }));
            const ch = channelsRef.current.find((c) => c.id === msg.target_id);
            addToast({
              title: ch ? channelLabel(ch.name) : 'Канал',
              body: `${msg.sender_name || 'Коллега'}: ${msg.text}`,
              type: 'channel',
              avatarText: ch ? ch.name.substring(0, 2).toUpperCase() : 'КН',
              data: { channel: ch }
            });

            if (window.electronAPI && window.electronAPI.flashFrame) {
              window.electronAPI.flashFrame(true);
            }
            if (currentUserRef.current?.status !== 'dnd') playChimeSound();
          }
        }
        break;
      }

      // Сервер шлёт new_announcement; клиент слушал announcement_created —
      // название не совпадало, поэтому объявления приходили молча: ни
      // уведомления, ни отметки в разделе «Важное». Для приказов с
      // обязательным ознакомлением это недопустимо.
      case 'new_announcement':
      case 'announcement_created': {
        setUnreadAnnCount((prev) => prev + 1);
        addToast({
          title: 'Официальное распоряжение',
          body: event.announcement.title,
          type: 'announcement',
          isUrgent: event.announcement.priority === 'urgent'
        });
        break;
      }

      case 'user_status_changed':
      case 'user_status': {
        const targetId = Number(event.userId || event.user_id);
        const newStatus = event.status;
        const newCustomStatus = event.customStatus || null;

        setUsers((prev) =>
          prev.map((u) => (u.id === targetId ? { ...u, status: newStatus, custom_status: newCustomStatus ?? u.custom_status } : u))
        );

        setTreeData((prev) => {
          if (!prev) return prev;
          const updateDept = (d) => {
            const updatedEmps = d.employees?.map((e) => (e.id === targetId ? { ...e, status: newStatus } : e));
            const updatedSubs = d.subDepartments?.map(updateDept);
            return { ...d, employees: updatedEmps, subDepartments: updatedSubs };
          };
          // «Без подразделения» — отдельный список, и статус его сотрудников
          // не менялся никогда: они оставались такими, какими были при загрузке.
          return {
            ...prev,
            tree: prev.tree?.map(updateDept),
            unassigned: prev.unassigned?.map((e) => (e.id === targetId ? { ...e, status: newStatus } : e))
          };
        });

        setActiveChat((prev) => {
          if (prev?.type === 'direct' && Number(prev.id) === targetId) {
            return {
              ...prev,
              user: { ...prev.user, status: newStatus }
            };
          }
          return prev;
        });

        if (currentUserRef.current?.id === targetId) {
          setCurrentUser((prev) => (prev ? { ...prev, status: newStatus, custom_status: newCustomStatus ?? prev.custom_status } : prev));
          window.electronAPI?.syncTrayStatus?.(newStatus);
        }
        break;
      }

      // ── Побудка ──
      case 'wake_state':
      case 'wake_sent':
      case 'wake_error':
        setWake((prev) => reduceWake(prev, event));
        break;

      case 'wake_ring':
        setIncomingWake({ fromUserId: event.fromUserId, fromName: event.fromName, at: event.at || Date.now() });
        addToast({
          title: `Вас будит ${event.fromName}`,
          body: 'Коллега ждёт ответа',
          type: 'wake',
          isUrgent: true,
          data: { user: usersRef.current.find((u) => u.id === event.fromUserId) }
        });
        break;

      default:
        break;
    }
  };

  // Open Direct Chat with Colleague
  const openDirectChat = async (user) => {
    setUnreadMap((prev) => ({ ...prev, [user.id]: 0 }));
    if (window.electronAPI && window.electronAPI.flashFrame) {
      window.electronAPI.flashFrame(false);
    }
    // Без переключения вкладки чат открывался «в никуда»: если человек в этот
    // момент читал объявления или базу, экран не менялся вовсе, и клик
    // выглядел потерянным.
    setActiveTab('chats');
    await openChat({
      type: 'direct',
      id: user.id,
      name: user.full_name || user.username,
      user
    });
  };

  // Open Channel Chat
  const openChannelChat = async (channel) => {
    setActiveTab('channels');
    setChannelUnread((prev) => (prev[channel.id] ? { ...prev, [channel.id]: 0 } : prev));
    await openChat({
      type: 'channel',
      id: channel.id,
      name: channelLabel(channel.name),
      channel
    });
  };

  const isSameChat = (a, b) => Boolean(a && b && a.type === b.type && a.id === b.id);

  const loadHistory = async (chat) => {
    const path = chat.type === 'channel' ? `channels/${chat.id}` : `direct/${chat.id}`;
    const res = await authFetch(`${serverUrlRef.current}/api/messages/${path}`);
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  };

  // История с сервера плюс то, что успело прийти живьём, пока она грузилась.
  const mergeHistory = (history, live) => {
    const byId = new Map();
    for (const m of history) byId.set(m.id, m);
    for (const m of live) if (m.id && !byId.has(m.id)) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  };

  const openChat = async (chat) => {
    // Ссылка обновляется сразу, а не после отрисовки: ответ на запрос истории
    // должен узнать, что чат уже сменился.
    activeChatRef.current = chat;
    setActiveChat(chat);
    // Clear first: otherwise the previous person's thread stays on screen
    // under the new name until the fetch resolves — and forever if it fails.
    setMessages([]);
    setMessagesLoading(true);

    try {
      const history = await loadHistory(chat);
      // Быстрый переход A → B: ответ для A, пришедший позже, раньше
      // показывался под именем B.
      if (!isSameChat(activeChatRef.current, chat)) return;
      setMessages((prev) => mergeHistory(history, prev));
    } catch (err) {
      if (!isSameChat(activeChatRef.current, chat)) return;
      console.error('Failed to load messages:', err);
      addToast({ title: 'Переписка не загрузилась', body: 'Нет связи с сервером — откройте чат ещё раз', type: 'system' });
    } finally {
      if (isSameChat(activeChatRef.current, chat)) setMessagesLoading(false);
    }
  };

  const reloadActiveChatHistory = async () => {
    const chat = activeChatRef.current;
    if (!chat) return;
    try {
      const history = await loadHistory(chat);
      if (isSameChat(activeChatRef.current, chat)) setMessages((prev) => mergeHistory(history, prev));
    } catch {}
  };

  // Handle action when user clicks floating corner toast or native notification.
  // Подписка одна на всё время работы окна: раньше на каждую смену токена
  // добавлялась ещё одна, и после смены учётной записи клик по уведомлению
  // отрабатывал и за прежнего сотрудника.
  const openDirectChatRef = useRef(openDirectChat);
  const openChannelChatRef = useRef(openChannelChat);
  openDirectChatRef.current = openDirectChat;
  openChannelChatRef.current = openChannelChat;
  useEffect(() => {
    if (!window.electronAPI?.onToastAction) return undefined;
    const off = window.electronAPI.onToastAction((toastData) => {
      if (toastData?.data?.user) {
        openDirectChatRef.current(toastData.data.user);
      } else if (toastData?.data?.channel) {
        openChannelChatRef.current(toastData.data.channel);
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // Test corner pop-up notification
  const handleTestNotification = () => {
    const otherUser = users.find((u) => u.id !== currentUser?.id) || users[0] || null;
    const senderName = otherUser ? (otherUser.full_name || otherUser.username) : 'Коллега';
    addToast({
      title: senderName,
      body: 'Привет! Проверка всплывающего уведомления в правом углу',
      type: 'chat',
      avatarText: senderName ? senderName.substring(0, 2).toUpperCase() : 'АС',
      data: { user: otherUser }
    });
  };

  // Send Message
  // metadata carries the uploaded file's id — dropping it here (it used to be
  // missing from this signature) meant an attachment was stored as a bare
  // filename with nothing to download.
  const handleSendMessage = async ({ conversationType, targetId, text, msgType, replyToId, metadata }) => {
    if (!text.trim()) return;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: conversationType === 'channel' ? 'channel_message' : 'direct_message',
          conversationType,
          targetId,
          recipient_id: targetId,
          channel_id: targetId,
          text,
          msgType,
          replyToId,
          metadata
        })
      );
    } else {
      const endpoint =
        conversationType === 'channel'
          ? `${serverUrl}/api/messages/channels/${targetId}`
          : `${serverUrl}/api/messages/direct/${targetId}`;

      // Поле ввода очищается сразу при отправке, поэтому молча потерянное
      // сообщение человек уже не восстановит: он уверен, что написал.
      try {
        const res = await authFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, type: msgType, reply_to_id: replyToId, metadata })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          addToast({
            title: 'Сообщение не отправлено',
            body: `${data.error || 'Сервер отклонил сообщение'} — «${text.slice(0, 80)}»`,
            type: 'system',
            isUrgent: true
          });
          return;
        }
        refreshConversations();
      } catch {
        addToast({
          title: 'Сообщение не отправлено',
          body: `Нет связи с сервером. Текст: «${text.slice(0, 80)}»`,
          type: 'system',
          isUrgent: true
        });
      }
    }
  };

  // Send File
  // Загрузка идёт через XMLHttpRequest: у fetch нет прогресса отправки, а на
  // файле в десятки мегабайт человек должен видеть, что дело движется, и иметь
  // возможность передумать. Итог возвращается вызывающему — ошибку показывает
  // полоса загрузок у поля ввода, рядом с тем, что человек только что сделал.
  const handleSendFile = async (file, conversationType, targetId, { onProgress, signal } = {}) => {
    const problem = uploadProblem(file);
    if (problem) return { ok: false, error: problem };

    // Размер картинки нужен ленте заранее: место под неё резервируется до
    // загрузки, и переписка не прыгает, когда картинка появляется.
    const isImage = file.type.startsWith('image/');
    let dimensions = null;
    if (isImage && typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
      } catch {}
    }

    const formData = new FormData();
    formData.append('file', file);

    const result = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${serverUrlRef.current}/api/files/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${tokenRef.current}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status === 401) forceLogout('Сеанс истёк или был отозван — войдите заново');
        if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, data });
        else resolve({ ok: false, error: data.error || (xhr.status === 413 ? 'Файл больше 100 МБ — такой файл отправить нельзя' : 'Сервер не принял файл') });
      };
      xhr.onerror = () => resolve({ ok: false, error: 'Нет связи с сервером' });
      xhr.onabort = () => resolve({ ok: false, cancelled: true });
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(formData);
    });
    if (!result.ok) return result;

    handleSendMessage({
      conversationType,
      targetId,
      text: file.name,
      msgType: isImage ? 'image' : 'file',
      // Сервер отдаёт данные файла верхним уровнем, без обёртки: чтение
      // fData.file.id давало undefined, ссылка получалась
      // /api/files/download/undefined, и вложение нельзя было скачать.
      metadata: {
        file_id: result.data.id,
        size: file.size,
        mimeType: file.type,
        url: `/api/files/download/${result.data.id}`,
        ...(dimensions || {})
      }
    });
    return { ok: true };
  };

  // Profile Update
  const handleUpdateProfile = async (updatedFields) => {
    try {
      const res = await authFetch(`${serverUrlRef.current}/api/users/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedFields)
      });
      // Ошибка здесь проглатывалась: сохранение профиля падало на сервере, а
      // человек видел закрывшееся окно и считал, что всё записалось.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addToast({
          title: 'Профиль не сохранён',
          body: data.error || 'Сервер отклонил изменения',
          type: 'system'
        });
        return false;
      }
      const updated = await res.json();
      setCurrentUser(updated);
      loadBaseData();
      return true;
    } catch {
      addToast({ title: 'Профиль не сохранён', body: 'Нет связи с сервером', type: 'system' });
      return false;
    }
  };

  // ── Статус ──
  // Статус выставляет система: «в сети» и «отошёл» определяются по активности
  // за компьютером, «не в сети» — по разрыву соединения. Человек управляет
  // только режимом «Не беспокоить». Итоговый статус присылает сервер
  // (user_status_changed) — он учитывает и режим, и последний сигнал системы.
  const presenceRef = useRef('online');

  const applyUserStatus = (userId, newStatus) => {
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, status: newStatus } : u)));
    setTreeData((prev) => {
      if (!prev) return prev;
      const updateDept = (d) => {
        const updatedEmps = d.employees?.map((e) => (e.id === userId ? { ...e, status: newStatus } : e));
        const updatedSubs = d.subDepartments?.map(updateDept);
        return { ...d, employees: updatedEmps, subDepartments: updatedSubs };
      };
      return {
        ...prev,
        tree: prev.tree?.map(updateDept),
        unassigned: prev.unassigned?.map((e) => (e.id === userId ? { ...e, status: newStatus } : e))
      };
    });
    if (currentUserRef.current?.id === userId) {
      setCurrentUser((prev) => (prev ? { ...prev, status: newStatus } : prev));
      window.electronAPI?.syncTrayStatus?.(newStatus);
    }
  };

  // Сигнал системы. Уходит на сервер только «в сети» или «отошёл».
  const updateMyPresence = (state) => {
    if (state !== 'online' && state !== 'away') return;
    if (presenceRef.current === state) return;
    presenceRef.current = state;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'presence', state }));
    }
  };

  const isDnd = currentUser?.status === 'dnd';

  const sendWake = (targetUserId) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    setWake((prev) => reduceWake(prev, { type: 'wake_request', targetUserId }));
    wsRef.current.send(JSON.stringify({ type: 'wake_send', targetUserId }));
  };

  const setDnd = (enabled) => {
    const me = currentUserRef.current;
    if (!me || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'set_dnd', enabled: Boolean(enabled) }));
    // Сразу показываем выбранное; подтверждение сервера придёт следом.
    applyUserStatus(me.id, enabled ? 'dnd' : presenceRef.current);
  };

  // ── Automated Presence Triggers (Electron OS + Web Engine) ──
  useEffect(() => {
    // 1. Сигналы Windows: блокировка, сон, простой.
    // Подписки создаются один раз: раньше эффект перезапускался при каждой
    // смене токена и добавлял ещё по обработчику — статус уходил на сервер
    // по нескольку раз.
    const offPower = window.electronAPI?.onPowerMonitorEvent?.(({ status }) => {
      updateMyPresence(status);
    });

    // Меню значка в трее. Новое меню присылает «dnd-on» / «dnd-off»; старые
    // установленные версии — прежние пункты статуса, из которых осмысленны
    // только «Не беспокоить» и «В сети» (выключить режим).
    const offTray = window.electronAPI?.onTrayStatusChange?.((value) => {
      if (value === 'dnd' || value === 'dnd-on') setDnd(true);
      else if (value === 'dnd-off' || value === 'online') setDnd(false);
    });

    // 2. Простой без мыши и клавиатуры — запасной путь, если сигналов Windows нет.
    let idleTimer = null;
    let isAwayDueToIdle = false;
    let isAwayDueToHidden = false;

    const resetIdleTimer = () => {
      if (isAwayDueToIdle && presenceRef.current === 'away') {
        isAwayDueToIdle = false;
        updateMyPresence('online');
      }

      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (presenceRef.current === 'online') {
          isAwayDueToIdle = true;
          updateMyPresence('away');
        }
      }, 300000);
    };

    const activityEvents = ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'scroll'];
    activityEvents.forEach((evt) => window.addEventListener(evt, resetIdleTimer, { passive: true }));
    resetIdleTimer();

    // 3. Окно скрыто дольше трёх минут.
    let visibilityTimeout = null;
    const handleVisibilityChange = () => {
      if (document.hidden) {
        visibilityTimeout = setTimeout(() => {
          if (presenceRef.current === 'online') {
            isAwayDueToHidden = true;
            updateMyPresence('away');
          }
        }, 180000);
      } else {
        if (visibilityTimeout) clearTimeout(visibilityTimeout);
        if (isAwayDueToHidden && presenceRef.current === 'away') {
          isAwayDueToHidden = false;
          updateMyPresence('online');
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 4. Сеть. «Не в сети» выставляет сервер, когда соединение рвётся, — здесь
    //    только быстрое переподключение.
    const handleOnline = () => {
      if (tokenRef.current && wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnectAttemptRef.current = 0;
        initWebSocket(tokenRef.current);
      }
    };

    window.addEventListener('online', handleOnline);

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (visibilityTimeout) clearTimeout(visibilityTimeout);
      activityEvents.forEach((evt) => window.removeEventListener(evt, resetIdleTimer));
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      if (typeof offPower === 'function') offPower();
      if (typeof offTray === 'function') offTray();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Create Channel
  const handleCreateChannel = async (e) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;

    try {
      const res = await authFetch(`${serverUrlRef.current}/api/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newChannelName.trim(), topic: newChannelTopic.trim() })
      });

      if (res.ok) {
        const created = await res.json();
        setChannels((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created]));
        setShowCreateChannelModal(false);
        setNewChannelName('');
        setNewChannelTopic('');
        openChannelChat(created);
      } else {
        const data = await res.json().catch(() => ({}));
        addToast({ title: 'Конференция не создана', body: data.error || 'Сервер отклонил запрос', type: 'system' });
      }
    } catch (err) {
      console.error('Create channel error:', err);
      addToast({ title: 'Конференция не создана', body: 'Нет связи с сервером', type: 'system' });
    }
  };

  // Название канала хранится то с «#», то без — в списке выходило «##Общий».
  const channelLabel = (name) => `#${String(name || '').replace(/^#+/, '')}`;

  // Оператор ждал ответа на запрос удалённого доступа вечно, если сотрудник
  // отошёл от компьютера: окно ожидания не закрывалось ничем, кроме кнопки.
  useEffect(() => {
    if (!rdPendingTarget) return undefined;
    const timer = setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN && rdSessionIdRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'rd_end', sessionId: rdSessionIdRef.current, targetUserId: rdPendingTarget.id }));
      }
      setRdPendingTarget(null);
      setRdSessionId(null);
      addToast({
        title: 'Сотрудник не ответил',
        body: 'Запрос на удалённый доступ отменён после минуты ожидания',
        type: 'system'
      });
    }, 60000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rdPendingTarget]);

  // Закрытие окна просмотра обязано завершать сеанс и у сотрудника: иначе у
  // него продолжалась трансляция экрана и оставался включённым ввод.
  const endRdViewerSession = () => {
    const viewer = inlineRdViewerRef.current;
    if (viewer && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'rd_end', sessionId: viewer.sessionId, targetUserId: viewer.targetUser?.id }));
    }
    setInlineRdViewer(null);
    setRdPendingOffer(null);
    setRdPendingCandidates(null);
    setRdSessionId(null);
  };

  const RECENT_DIALOG_LIMIT = 10;

  // Список диалогов — это переписки, а не адресная книга. Раньше сюда
  // попадали все сотрудники компании: у крупной организации это сотни строк,
  // среди которых не найти тех, с кем реально общаешься. Показываются
  // последние переписки; чтобы написать новому человеку, он ищется здесь же
  // по имени или открывается из «Контактов» и Ctrl+K.
  // Поиск идёт и по названию, и по теме: в списке видно и то, и другое,
  // значит искать логично по обоим.
  const filteredChannels = (() => {
    const query = channelSearch.trim().toLowerCase();
    if (!query) return channels;
    return channels.filter(
      (ch) =>
        String(ch.name || '').toLowerCase().includes(query) ||
        String(ch.topic || '').toLowerCase().includes(query)
    );
  })();

  const filteredUsers = (() => {
    const others = users.filter((u) => u.id !== currentUser?.id);
    const query = dialogSearch.trim().toLowerCase();

    if (query) {
      return others.filter(
        (u) =>
          u.full_name?.toLowerCase().includes(query) ||
          u.username?.toLowerCase().includes(query) ||
          String(u.extension || '').includes(query) ||
          String(u.uin || '').includes(query)
      );
    }

    // Собеседник приходит в поле user_id; чтения несуществующего
    // other_user_id хватало, чтобы список оставался пустым всегда.
    // Маршрут отдаёт всех сотрудников, а не только тех, с кем есть переписка,
    // поэтому признаком служит наличие последнего сообщения.
    const lastMessageAt = new Map(
      directConvos
        .filter((c) => c.last_message_time)
        .map((c) => [c.user_id, c.last_message_time])
    );

    return others
      .filter((u) => {
        // Открытый прямо сейчас диалог остаётся видимым, даже если в нём ещё
        // нет ни одного сообщения — иначе собеседник пропадал бы из списка,
        // пока ему не напишешь.
        if (activeChat?.type === 'direct' && activeChat.id === u.id) return true;
        // Непрочитанное показывается всегда: сообщение, о котором сотрудник не
        // узнает, — худшее, что может сделать мессенджер.
        if (unreadMap[u.id] > 0) return true;
        return lastMessageAt.has(u.id);
      })
      .sort((a, b) => String(lastMessageAt.get(b.id) || '').localeCompare(String(lastMessageAt.get(a.id) || '')))
      .slice(0, RECENT_DIALOG_LIMIT);
  })();

  // Права — из роли, а не из номера роли или имени учётной записи: номера не
  // устойчивы, а «admin» может оказаться кем угодно.
  const isAdmin = Boolean(currentUser?.permissions?.is_admin);
  // Студия базы данных — только суперадминистратору: у администратора
  // подразделения все её запросы отвечают 403.
  const isSuperAdmin = isAdmin && !currentUser?.permissions?.is_scoped_admin;

  if (authState === 'checking') {
    return (
      <div className="login-container">
        <div className="login-card" style={{ textAlign: 'center', padding: '40px' }}>
          <p>Подключение к MyChat...</p>
        </div>
      </div>
    );
  }

  if (authState !== 'authenticated') {
    return <LoginView onLoginSuccess={handleLoginSuccess} initialServerUrl={serverUrl} />;
  }

  if (currentUser?.must_change_password) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-header">
            <h2 className="login-title">Смена пароля обязательна</h2>
            <p className="login-subtitle">
              Продолжить работу можно только после смены временного пароля.
            </p>
          </div>
          {pwError && <div className="login-error-box" role="alert"><Icon name="alert" size={14} />{pwError}</div>}
          <form onSubmit={handleForcedPasswordChange} className="login-form">
            <div className="form-group">
              <label className="form-label">Текущий пароль:</label>
              <input type="password" className="form-input" value={pwOld} onChange={(e) => setPwOld(e.target.value)} disabled={pwSubmitting} required autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">Новый пароль:</label>
              <input type="password" className="form-input" value={pwNew} onChange={(e) => setPwNew(e.target.value)} disabled={pwSubmitting} required />
            </div>
            <div className="form-group">
              <label className="form-label">Повторите новый пароль:</label>
              <input type="password" className="form-input" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} disabled={pwSubmitting} required />
            </div>
            <button type="submit" className="btn btn-primary btn-block login-submit-btn" disabled={pwSubmitting}>
              {pwSubmitting ? 'Сохранение...' : 'Сменить пароль и продолжить'}
            </button>
          </form>
          <button className="conf-link-btn" style={{ marginTop: '12px' }} onClick={handleLogout}>Выйти</button>
          {confirmDialog}
        </div>
      </div>
    );
  }

  // Переключение разделов слева. Метка выбранного раздела переезжает к новому
  // пункту, а не исчезает в одном месте и появляется в другом: так видно,
  // откуда и куда перешёл. Там, где View Transitions нет или человек просил
  // меньше движения, раздел просто сменяется.
  const switchTab = (tab) => {
    if (tab === activeTab) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduceMotion) {
      setActiveTab(tab);
      return;
    }
    document.startViewTransition(() => flushSync(() => setActiveTab(tab)));
  };

  // Пункты полосы были простыми блоками: до них нельзя было добраться
  // клавиатурой.
  const railTabProps = (tab) => ({
    role: 'tab',
    tabIndex: 0,
    'aria-selected': activeTab === tab,
    onClick: () => switchTab(tab),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchTab(tab);
      }
    }
  });

  return (
    <div className="app-container">
      <MenuBar
        currentUser={currentUser}
        onOpenProfile={() => setShowProfileModal(true)}
        onSwitchAccount={handleLogout}
        isDnd={isDnd}
        canToggleDnd={wsConnected}
        onToggleDnd={setDnd}
        onSelectTab={setActiveTab}
        onTogglePersonPanel={() => setIsPersonPanelOpen((prev) => !prev)}
        onOpenDbStudio={() => isSuperAdmin && setActiveTab('db')}
        onOpenAdminConsole={() => isAdmin && setShowAdminModal(true)}
        onOpenWhatIsNew={() => setShowAboutModal(true)}
        onOpenServerConnect={() => setShowServerConnectModal(true)}
        onTestNotification={handleTestNotification}
        onOpenAbout={() => setShowAboutModal(true)}
        onNotice={(text) => addToast({ title: text, type: 'system' })}
      />

      <div className="workspace-layout">
        {/* Column 1: Leftmost Navigation Rail */}
        <div className="vertical-nav-rail">
          <div
            className="rail-hamburger-item"
            title="Мой профиль"
            role="button"
            tabIndex={0}
            onClick={() => setShowProfileModal(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowProfileModal(true);
              }
            }}
          >
            {/* Пункт открывает профиль, а выглядел как «гамбургер» меню. Теперь
                на его месте сам человек, под которым выполнен вход. */}
            <Avatar
              name={currentUser?.full_name || currentUser?.username}
              src={currentUser?.avatar_url}
              size={32}
              className="rail-self-avatar"
            />
          </div>

          <div className="rail-nav-tabs" role="tablist" aria-orientation="vertical">
            <div
              className={`rail-tab-btn ${activeTab === 'chats' ? 'active' : ''}`}
              {...railTabProps('chats')}
              title="Чаты"
            >
              {activeTab === 'chats' && <span className="rail-active-indicator" aria-hidden="true" />}
              <div className="rail-tab-icon-box">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <span className="rail-tab-label">Чаты</span>
            </div>

            <div
              className={`rail-tab-btn ${activeTab === 'channels' ? 'active' : ''}`}
              {...railTabProps('channels')}
              title="Каналы и конференции"
            >
              {activeTab === 'channels' && <span className="rail-active-indicator" aria-hidden="true" />}
              <div className="rail-tab-icon-box">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              </div>
              <span className="rail-tab-label">Каналы</span>
            </div>

            <div
              className={`rail-tab-btn ${activeTab === 'contacts' ? 'active' : ''}`}
              {...railTabProps('contacts')}
              title="Контакты и оргструктура"
            >
              {activeTab === 'contacts' && <span className="rail-active-indicator" aria-hidden="true" />}
              <div className="rail-tab-icon-box">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <line x1="19" y1="8" x2="19" y2="14"></line>
                  <line x1="22" y1="11" x2="16" y2="11"></line>
                </svg>
              </div>
              <span className="rail-tab-label">Контакты</span>
            </div>

            <div
              className={`rail-tab-btn ${activeTab === 'important' ? 'active' : ''}`}
              {...railTabProps('important')}
              title="Официальные оповещения"
            >
              {activeTab === 'important' && <span className="rail-active-indicator" aria-hidden="true" />}
              <div className="rail-tab-icon-box relative">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                </svg>
                {unreadAnnCount > 0 && (
                  <span className="rail-badge">{unreadAnnCount}</span>
                )}
              </div>
              <span className="rail-tab-label">Важное</span>
            </div>
          </div>
        </div>

        {/* Column 2: Sub-panel */}
        {activeTab === 'chats' && (
          <div className="sub-panel-dialogs" style={{ width: `${sidebarWidth}px` }}>
            <div className="sub-panel-top-bar">
              <div className="sub-panel-dropdown-trigger">
                <span>Диалоги</span>
              </div>
              <div className="sub-panel-search-box">
                <input
                  type="text"
                  className="sub-panel-search-input"
                  placeholder="Поиск..."
                  value={dialogSearch}
                  onChange={(e) => setDialogSearch(e.target.value)}
                />
                <Icon name="search" size={13} className="search-icon" />
              </div>
              <button
                type="button"
                className="command-palette-trigger-btn"
                title="Быстрый переход к человеку, каналу или сообщению"
                onClick={() => setShowCommandPalette(true)}
              >
                Ctrl+K
              </button>
            </div>

            <div className="dialogs-scrollable-list">
              {/* Себя в списке собеседников нет намеренно. Но когда в компании
                  заведён только администратор, список пуст — и без пояснения
                  это выглядит как поломка, а не как «коллег ещё не завели». */}
              {filteredUsers.length === 0 && (
                <div className="dialogs-empty">
                  {dialogSearch.trim() ? (
                    <>
                      <div className="dialogs-empty-title">Никого не найдено</div>
                      <div className="dialogs-empty-text">
                        По запросу «{dialogSearch.trim()}» совпадений нет.
                      </div>
                    </>
                  ) : users.length <= 1 && isAdmin ? (
                    <>
                      <div className="dialogs-empty-title">Сотрудников пока нет</div>
                      <div className="dialogs-empty-text">
                        В системе заведена только ваша учётная запись — писать пока некому.
                      </div>
                      <button className="btn btn-primary" onClick={() => setShowAdminModal(true)}>
                        Добавить сотрудников
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="dialogs-empty-title">Переписок пока нет</div>
                      <div className="dialogs-empty-text">
                        Здесь появятся диалоги с коллегами, которым вы писали. Чтобы начать
                        разговор, найдите человека в поиске выше, в разделе «Контакты» или
                        нажмите Ctrl+K.
                      </div>
                    </>
                  )}
                </div>
              )}

              {filteredUsers.map((u) => {
                const isActive = activeChat?.type === 'direct' && activeChat.id === u.id;
                const isOnline = u.status === 'online';
                const displayName = u.full_name || u.username;

                const lastConvo = directConvos.find((c) => c.user_id === u.id);
                const snippet = lastConvo?.last_message_text || 'Нажмите для беседы';
                const timeStr = lastConvo?.last_message_time ? formatDialogTime(lastConvo.last_message_time) : '';
                const unreadBadge = unreadMap[u.id] !== undefined ? unreadMap[u.id] : (lastConvo?.unread_count || 0);

                return (
                  <div
                    key={u.id}
                    className={`dialog-list-item ${isActive ? 'active' : ''} ${unreadBadge > 0 ? 'has-unread-item' : ''} ${isOnline ? 'online-bar' : 'offline-bar'}`}
                    onClick={() => openDirectChat(u)}
                  >
                    <Avatar name={displayName} src={u.avatar_url} size={36} />

                    <div className="dialog-info-column">
                      <div className="dialog-row-top">
                        <span className="dialog-peer-name" title={displayName}>
                          {displayName}
                        </span>
                        {timeStr && <span className="dialog-timestamp">{timeStr}</span>}
                      </div>

                      <div className="dialog-row-bottom">
                        <span className="dialog-snippet" title={snippet}>
                          {snippet}
                        </span>
                        {unreadBadge > 0 ? (
                          <span key={unreadBadge} className="dialog-unread-badge">{unreadBadge}</span>
                        ) : (
                          lastConvo?.is_read === 1 && <span className="dialog-read-ticks">✓✓</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              className={`sidebar-resizer ${isDraggingSidebar ? 'is-dragging' : ''}`}
              onMouseDown={startResizingSidebar}
              onDoubleClick={() => setSidebarWidth(360)}
              title="Перетащите для изменения ширины (двойной клик: 360px)"
            />
          </div>
        )}

        {activeTab === 'channels' && (
          <div className="sub-panel-dialogs" style={{ width: `${sidebarWidth}px` }}>
            <div className="sub-panel-top-bar">
              <div className="sub-panel-dropdown-trigger">
                <span>Конференции</span>
              </div>
              <div className="sub-panel-search-box">
                {/* Поле было ни к чему не подключено: набранное в нём не
                    влияло ни на что, и список оставался прежним. */}
                <input
                  type="text"
                  className="sub-panel-search-input"
                  placeholder="Поиск конференции..."
                  value={channelSearch}
                  onChange={(e) => setChannelSearch(e.target.value)}
                />
                <Icon name="search" size={13} className="search-icon" />
              </div>
            </div>

            <div className="conferences-container">
              <div className="conference-items-list">
                {filteredChannels.map((ch) => (
                  <div
                    key={ch.id}
                    className={`dialog-list-item ${activeChat?.type === 'channel' && activeChat.id === ch.id ? 'active' : ''}`}
                    onClick={() => openChannelChat(ch)}
                  >
                    <span className="ui-avatar is-square channel-avatar" style={{ width: 36, height: 36 }}>
                      <Icon name="hash" size={16} strokeWidth={2} />
                    </span>
                    <div className="dialog-info-column">
                      <div className="dialog-row-top">
                        <span className="dialog-peer-name">{channelLabel(ch.name)}</span>
                      </div>
                      <div className="dialog-row-bottom">
                        <span className="dialog-snippet">{ch.topic || 'Корпоративный канал'}</span>
                        {channelUnread[ch.id] > 0 && (
                          <span key={channelUnread[ch.id]} className="dialog-unread-badge">{channelUnread[ch.id]}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Подсказка показывалась всегда — даже когда прямо над ней шёл
                  список конференций. «У вас нет конференций» поверх списка
                  конференций читается как поломка. */}
              {filteredChannels.length === 0 && (
                <div className="no-conferences-box">
                  {channelSearch.trim() ? (
                    <>
                      <p className="no-conf-title">Ничего не найдено.</p>
                      <p className="no-conf-desc">
                        По запросу «{channelSearch.trim()}» конференций нет.{' '}
                        <button className="conf-link-btn" onClick={() => setChannelSearch('')}>
                          Показать все
                        </button>
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="no-conf-title">У вас нет конференций.</p>
                      <p className="no-conf-desc">
                        <button className="conf-link-btn" onClick={() => setShowCreateChannelModal(true)}>
                          Создайте новую
                        </button>{' '}
                        и пригласите туда коллег.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
            <div
              className={`sidebar-resizer ${isDraggingSidebar ? 'is-dragging' : ''}`}
              onMouseDown={startResizingSidebar}
              onDoubleClick={() => setSidebarWidth(360)}
              title="Перетащите для изменения ширины (двойной клик: 360px)"
            />
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="sub-panel-dialogs" style={{ width: `${sidebarWidth}px` }}>
            <OrgTree
              treeData={treeData}
              error={baseDataError}
              onRetry={() => {
                setBaseDataError(null);
                loadBaseData();
              }}
              onSelectUser={openDirectChat}
              activeUserId={activeChat?.type === 'direct' ? activeChat.id : null}
              unreadMap={unreadMap}
            />
            <div
              className={`sidebar-resizer ${isDraggingSidebar ? 'is-dragging' : ''}`}
              onMouseDown={startResizingSidebar}
              onDoubleClick={() => setSidebarWidth(380)}
              title="Перетащите для изменения ширины дерева контактов (двойной клик: 380px)"
            />
          </div>
        )}

        {activeTab === 'important' && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <AnnouncementsView
              token={token}
              currentUser={currentUser}
              serverUrl={serverUrl}
              onAcknowledged={refreshAnnouncementCount}
            />
          </div>
        )}

        {activeTab === 'db' && isSuperAdmin && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <DatabaseStudioView token={token} serverUrl={serverUrl} />
          </div>
        )}

        {/* Column 3: Main Central Pane */}
        {(activeTab === 'chats' || activeTab === 'channels' || activeTab === 'contacts') && (
          <div className="main-center-workspace">
            {activeChat ? (
              <ChatView
                // Ключ по переписке: без него набранный, но не отправленный
                // текст и выбранный ответ переезжали в следующий чат — и
                // сообщение уходило не тому, кому его писали.
                key={`${activeChat.type}:${activeChat.id}`}
                activeChat={activeChat}
                messages={messages}
                messagesLoading={messagesLoading}
                currentUser={currentUser}
                typingUsers={typingMap[`${activeChat.type}:${activeChat.id}`] || []}
                isPersonPanelOpen={isPersonPanelOpen}
                onTogglePersonPanel={() => setIsPersonPanelOpen((prev) => !prev)}
                onSendMessage={handleSendMessage}
                onSendFile={handleSendFile}
                onStartCall={handleStartCall}
                onRequestRemoteDesktop={handleRequestRemoteDesktop}
                onMarkRead={(conversationType, targetId) =>
                  markConversationRead({ type: conversationType, id: targetId })
                }
                onTyping={(conversationType, targetId, isTyping) => {
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'typing', conversationType, targetId, isTyping }));
                  }
                }}
                token={token}
                serverUrl={serverUrl}
                onNotice={(title, body) => addToast({ title, body: body || '', type: 'system' })}
                connected={wsConnected}
                wake={wake}
                onWake={sendWake}
              />
            ) : (
              <GreetingView
                currentUser={currentUser}
                serverInfo={serverInfo}
                onOpenWhatIsNew={() => setShowAboutModal(true)}
                onOpenProfile={() => setShowProfileModal(true)}
                onSwitchAccount={handleLogout}
              />
            )}
          </div>
        )}

        {/* Column 4: Rightmost Panel */}
        {isPersonPanelOpen && activeChat?.type === 'direct' && activeChat.user && (
          <PersonInfoPanel
            user={activeChat.user}
            currentUser={currentUser}
            onClose={() => setIsPersonPanelOpen(false)}
            onOpenProfile={() => setShowProfileModal(true)}
            onOpenAdminUser={(person) => {
              // Кнопка называется «открыть карточку сотрудника», но человек
              // до сих пор терялся по дороге: консоль открывалась на своей
              // начальной вкладке, и администратор искал его заново руками.
              setAdminFocusUserId(person?.id || null);
              setShowAdminModal(true);
            }}
          />
        )}
      </div>

      {/* Native Windows Enterprise Status Bar */}
      <div className="native-status-bar">
        {/* Адрес сервера и версия здесь больше не показываются: рядовому
            сотруднику они ни о чём не говорят, а внутренний адрес незачем
            держать на виду. Строка перестала быть кликабельной — смена
            сервера осталась в меню «Сетевой сервер…», куда обычный
            пользователь не заходит. Администратору адрес виден в консоли. */}
        <div className="status-bar-left">
          <span className={`status-net-dot ${wsConnected ? 'online' : 'offline'}`} />
          <span className="status-bar-text">
            {wsConnected ? 'Подключено' : 'Нет связи с сервером'}
          </span>
        </div>

        <div className="status-bar-center">
          <span className="status-bar-stat">
            <Icon name="users" size={12} /> В сети: <strong>{users.filter((u) => u.status === 'online').length}</strong>
          </span>
          <span className="status-bar-divider" aria-hidden="true" />
          <span className="status-bar-stat">
            <Icon name="clock" size={12} /> Отошли: <strong>{users.filter((u) => u.status === 'away').length}</strong>
          </span>
          <span className="status-bar-divider" aria-hidden="true" />
          <span className="status-bar-stat">
            Всего: <strong>{users.length}</strong>
          </span>
        </div>

        <div className="status-bar-right">
          {/* User Presence Switcher Button */}
          <PresenceControl status={currentUser?.status} connected={wsConnected} onToggleDnd={setDnd} />

          <span className="status-bar-divider" aria-hidden="true" />

          {/* Log out */}
          <button
            className="status-bar-persona-btn"
            onClick={handleLogout}
            title="Выйти из учётной записи"
          >
            <Icon name="user" size={12} /><span>{currentUser ? (currentUser.full_name || currentUser.username) : 'Вход'}</span>
            <span className="persona-switch-badge">⇄</span>
          </button>
        </div>
      </div>

      {confirmDialog}

      {incomingWake && (
        <WakeAlert
          wake={incomingWake}
          onDismiss={() => setIncomingWake(null)}
          onOpenChat={() => {
            const from = users.find((u) => u.id === incomingWake.fromUserId);
            setIncomingWake(null);
            if (from) openDirectChat(from);
          }}
        />
      )}

      <ToastNotificationStack
        toasts={toasts}
        onDismiss={dismissToast}
        onAction={(t) => {
          if (t.data?.user) openDirectChat(t.data.user);
          else if (t.data?.channel) openChannelChat(t.data.channel);
        }}
      />

      {showCommandPalette && (
        <CommandPalette
          users={users}
          channels={channels}
          token={token}
          serverUrl={serverUrl}
          currentUserId={currentUser?.id}
          onSelectUser={openDirectChat}
          onSelectChannel={openChannelChat}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {showProfileModal && (
        <UserProfileModal
          currentUser={currentUser}
          serverInfo={serverInfo}
          onClose={() => setShowProfileModal(false)}
          onUpdateProfile={handleUpdateProfile}
          token={token}
          serverUrl={serverUrl}
          onTokenRenewed={handleTokenRenewed}
        />
      )}

      {showAboutModal && (
        <WhatIsNewModal
          serverInfo={serverInfo}
          onClose={() => setShowAboutModal(false)}
        />
      )}

      {showServerConnectModal && (
        <ServerConnectModal
          currentUrl={serverUrl}
          onClose={() => setShowServerConnectModal(false)}
          onApplyServer={handleApplyServer}
        />
      )}

      {showCreateChannelModal && (
        <div className="modal-backdrop" onClick={() => setShowCreateChannelModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <span style={{ fontWeight: 700, fontSize: '15px' }}>Создать конференцию</span>
              <button className="btn-close-modal" onClick={() => setShowCreateChannelModal(false)} aria-label="Закрыть">
                <Icon name="x" size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateChannel} style={{ padding: '20px' }}>
              <div className="form-group" style={{ marginBottom: '14px' }}>
                <label className="form-label">Название конференции *:</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="например, Проект-Альфа"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="form-label">Тема / Описание:</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Обсуждение рабочих вопросов..."
                  value={newChannelTopic}
                  onChange={(e) => setNewChannelTopic(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateChannelModal(false)}>
                  Отмена
                </button>
                <button type="submit" className="btn btn-primary" disabled={!newChannelName.trim()}>
                  Создать
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAdminModal && isAdmin && (
        <AdminUserModal
          currentUser={currentUser}
          serverInfo={serverInfo}
          serverUrl={serverUrl}
          focusUserId={adminFocusUserId}
          onClose={() => {
            setShowAdminModal(false);
            setAdminFocusUserId(null);
          }}
          onRefreshData={() => {
            loadBaseData();
          }}
        />
      )}

      {activeCall && (
        <VoiceCallPanel
          call={activeCall}
          currentUser={currentUser}
          wsClient={wsRef.current}
          onEnd={() => setActiveCall(null)}
        />
      )}

      {rdPrompt && (
        <RemoteDesktopHostModal
          request={rdPrompt}
          wsClient={wsRef.current}
          onClose={() => setRdPrompt(null)}
        />
      )}

      {rdPendingTarget && (
        <div className="modal-backdrop">
          <div className="rd-waiting-card">
            <div className="chat-loading-spinner" />
            <div className="rd-waiting-title">Ожидаем подтверждения</div>
            <div className="rd-waiting-text">
              Запрос отправлен сотруднику <strong>{rdPendingTarget.full_name || rdPendingTarget.username}</strong>.
              Подключение начнётся только после того, как он разрешит доступ к своему экрану.
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => {
                if (wsRef.current?.readyState === WebSocket.OPEN && rdSessionId) {
                  wsRef.current.send(JSON.stringify({ type: 'rd_end', sessionId: rdSessionId, targetUserId: rdPendingTarget.id }));
                }
                setRdPendingTarget(null);
                setRdSessionId(null);
              }}
            >
              Отменить запрос
            </button>
          </div>
        </div>
      )}

      {inlineRdViewer && (
        <div className="modal-backdrop">
          <div style={{ width: '100vw', height: '100vh', background: '#0f172a', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 16px', background: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#fff' }}>
              <span>Удаленный рабочий стол: {inlineRdViewer.targetUser?.full_name}</span>
              <button className="btn btn-sm btn-secondary" onClick={endRdViewerSession}>Закрыть</button>
            </div>
            <div style={{ flex: 1 }}>
              <RemoteDesktopViewer
                sessionId={inlineRdViewer.sessionId}
                targetUser={inlineRdViewer.targetUser}
                accessLevel={inlineRdViewer.accessLevel}
                wsClient={wsRef.current}
                pendingOffer={rdPendingOffer}
                pendingCandidates={rdPendingCandidates}
                onEndSession={endRdViewerSession}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
