import React, { useState, useEffect, useRef } from 'react';
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

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('mychat_token') || '');
  const [currentUser, setCurrentUser] = useState(null);
  const [authState, setAuthState] = useState('checking'); // 'checking' | 'authenticated' | 'unauthenticated'
  const [serverInfo, setServerInfo] = useState(null);
  const [serverUrl, setServerUrl] = useState(
    localStorage.getItem('mychat_server_url') || (window.location.origin.startsWith('http') ? window.location.origin : 'https://chat-production-0456.up.railway.app')
  );
  const [wsConnected, setWsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'channels' | 'contacts' | 'important' | 'db'
  
  // Base Data
  const [treeData, setTreeData] = useState(null);
  const [users, setUsers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [directConvos, setDirectConvos] = useState([]);
  const [dialogSearch, setDialogSearch] = useState('');
  
  // Active Chat & UI state
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [typingMap, setTypingMap] = useState({});
  const [unreadAnnCount, setUnreadAnnCount] = useState(0);
  const [unreadMap, setUnreadMap] = useState({});
  const [windowFocused, setWindowFocused] = useState(true);
  const windowFocusedRef = useRef(true);
  const activeChatRef = useRef(activeChat);

  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);
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
  const [showServerConnectModal, setShowServerConnectModal] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  // Floating Corner Toasts & Remote Desktop
  const [toasts, setToasts] = useState([]);
  const [rdPrompt, setRdPrompt] = useState(null);
  const [inlineRdViewer, setInlineRdViewer] = useState(null);
  const [rdPendingTarget, setRdPendingTarget] = useState(null);
  const [rdSessionId, setRdSessionId] = useState(null);
  const [rdPendingOffer, setRdPendingOffer] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const activeCallRef = useRef(null);
  useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);

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

  const tryRestoreSession = async (authToken) => {
    try {
      const res = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) return false;
      const data = await res.json();
      setToken(authToken);
      setCurrentUser(data.user);
      setAuthState('authenticated');
      openSessionChannels(data.user, authToken);
      return true;
    } catch {
      return false;
    }
  };

  const attemptSilentDeviceLogin = async () => {
    try {
      let deviceId = localStorage.getItem('mychat_device_id');
      if (!deviceId) {
        deviceId = 'dev-' + Math.random().toString(36).substring(2, 12) + '-' + Date.now().toString(36);
        localStorage.setItem('mychat_device_id', deviceId);
      }

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
          device_name: (devInfo && devInfo.hostname) || 'ПК пользователя',
          platform: (devInfo && devInfo.platform) || 'Windows 11',
          client_version: '1.0.0'
        })
      });

      if (knockRes.ok) {
        const knockData = await knockRes.json();
        if (knockData.status === 'paired' && knockData.token) {
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
    if (storedToken && (await tryRestoreSession(storedToken))) return;
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
    setToken(authToken);
    setCurrentUser(user);
    setAuthState('authenticated');
    openSessionChannels(user, authToken);
  };

  // The operator asks the SERVER for a session and waits: it checks the
  // can_remote_control permission an administrator granted, then prompts the
  // colleague for consent. Opening the viewer straight away with a locally
  // invented session id is what left it waiting forever — nothing had been
  // requested of anyone. The viewer opens on rd_accepted.
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

  const handleLogout = () => {
    localStorage.removeItem('mychat_token');
    localStorage.setItem('mychat_logged_out', '1');
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
    }
    setToken('');
    setCurrentUser(null);
    setAuthState('unauthenticated');
  };

  // Forced password change gate (currentUser.must_change_password) — see
  // docs/designs/auth-access-control-remediation.md item 10.
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const handleForcedPasswordChange = async (e) => {
    e.preventDefault();
    setPwError('');
    if (pwNew.length < 6) {
      setPwError('Новый пароль должен быть не короче 6 символов');
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
      initWebSocket(token);
      loadBaseData(token);
    } catch (err) {
      setPwError(err.message || 'Не удалось сменить пароль');
    } finally {
      setPwSubmitting(false);
    }
  };

  const handleApplyServer = (newUrl) => {
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

        const title = '🔔 Напоминание о непрочитанных сообщениях';
        const body = 'У вас ' + totalUnread + ' непрочитанных сообщений от: ' + (senderNames || 'коллег') + '. Нажмите, чтобы открыть.';

        if (window.electronAPI && window.electronAPI.showNotification) {
          window.electronAPI.showNotification({ title, body, type: 'chat', isUrgent: true });
          window.electronAPI.flashFrame(true);
        } else {
          addToast({ title, body, type: 'chat', isUrgent: true });
        }
        playChimeSound();
      }
    }, randomDelay);

    return () => clearTimeout(timer);
  }, [unreadMap, windowFocused]);
  // Set Window Title dynamically matching Screenshot 1 & 2
  useEffect(() => {
    const company = serverInfo?.company_name || 'АО "Страховая компания "Сентрас Иншуранс"';
    if (currentUser) {
      const statusText = currentUser.status === 'online' ? 'В сети' : currentUser.status === 'away' ? 'Отошел' : 'Не в сети';
      const extText = currentUser.extension ? ` (в.н.${currentUser.extension})` : '';
      const name = currentUser.full_name || currentUser.username;
      document.title = `MyChat Client 2025.3.1 — ${name}${extText} [${company}] (${statusText})`;
    } else {
      document.title = `MyChat Client 2025.3.1 — [${company}]`;
    }
  }, [currentUser, serverInfo]);

  const addToast = ({ title, body, type = 'chat', isUrgent = false, avatarText = '', data = null }) => {
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 5);
    const newToast = { id, title, body, type, isUrgent, avatarText, data };
    setToasts((prev) => [newToast, ...prev].slice(0, 5));
    playNotificationSound(isUrgent);

    if (window.electronAPI?.showNotification) {
      window.electronAPI.showNotification({
        title,
        body,
        type,
        isUrgent,
        avatarText
      });
    }
  };

  const dismissToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const loadBaseData = async (authToken = token) => {
    try {
      const headers = { Authorization: `Bearer ${authToken}` };
      const [treeRes, usersRes, channelsRes, convosRes, annRes] = await Promise.all([
        fetch(`${serverUrl}/api/org/tree`, { headers }),
        fetch(`${serverUrl}/api/users`, { headers }),
        fetch(`${serverUrl}/api/channels`, { headers }),
        fetch(`${serverUrl}/api/conversations/direct`, { headers }),
        fetch(`${serverUrl}/api/announcements`, { headers })
      ]);

      if (treeRes.ok) setTreeData(await treeRes.json());
      if (usersRes.ok) {
        const uList = await usersRes.json();
        setUsers(uList);
      }
      if (channelsRes.ok) setChannels(await channelsRes.json());
      if (convosRes.ok) setDirectConvos(await convosRes.json());

      if (annRes.ok) {
        const anns = await annRes.json();
        const unconfirmed = anns.filter((a) => a.is_confirmed !== 1).length;
        setUnreadAnnCount(unconfirmed);
      }
    } catch (err) {
      console.error('Base data load error:', err);
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

    const cleanHost = serverUrl.replace(/^https?:\/\//, '');
    const protocol = serverUrl.startsWith('https') ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${cleanHost}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    };

    ws.onclose = () => {
      // Only the current socket may schedule a reconnect; a superseded one
      // must stay dead.
      if (wsRef.current !== ws) return;
      setWsConnected(false);
      setTimeout(() => {
        if (localStorage.getItem('mychat_token') && wsRef.current === ws) initWebSocket(authToken);
      }, 3000);
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
          addToast({
            title: 'Запрос отклонён',
            body: `${event.targetName || 'Сотрудник'} отказал в доступе к рабочему столу`,
            type: 'system'
          });
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

        loadBaseData();

        if (msg.sender_id !== cUser?.id) {
          const isCurrentActive = activeChatRef.current && activeChatRef.current.type === 'direct' && activeChatRef.current.id === msg.sender_id && windowFocusedRef.current;

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
            playChimeSound();
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
          const isCurrentActive = activeChatRef.current && activeChatRef.current.type === 'channel' && activeChatRef.current.id === msg.target_id && windowFocusedRef.current;
          if (!isCurrentActive) {
            const ch = channelsRef.current.find((c) => c.id === msg.target_id);
            addToast({
              title: ch ? `#${ch.name}` : 'Канал',
              body: `${msg.sender_name || 'Коллега'}: ${msg.text}`,
              type: 'channel',
              avatarText: ch ? ch.name.substring(0, 2).toUpperCase() : 'КН',
              data: { channel: ch }
            });

            if (window.electronAPI && window.electronAPI.flashFrame) {
              window.electronAPI.flashFrame(true);
            }
            playChimeSound();
          }
        }
        break;
      }

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
          return {
            ...prev,
            tree: prev.tree?.map(updateDept)
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
        }
        break;
      }

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
    setActiveChat({
      type: 'direct',
      id: user.id,
      name: user.full_name || user.username,
      user
    });
    // Clear first: otherwise the previous person's thread stays on screen
    // under the new name until the fetch resolves — and forever if it fails.
    setMessages([]);
    setMessagesLoading(true);

    try {
      const res = await fetch(`${serverUrl}/api/messages/direct/${user.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const history = await res.json();
        setMessages(history);
      }
    } catch (err) {
      console.error('Failed to load direct messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  };

  // Open Channel Chat
  const openChannelChat = async (channel) => {
    setActiveChat({
      type: 'channel',
      id: channel.id,
      name: channel.name,
      channel
    });
    setMessages([]);
    setMessagesLoading(true);

    try {
      const res = await fetch(`${serverUrl}/api/messages/channels/${channel.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const history = await res.json();
        setMessages(history);
      }
    } catch (err) {
      console.error('Failed to load channel messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  };

  // Handle action when user clicks floating corner toast or native notification
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.onToastAction) {
      window.electronAPI.onToastAction((toastData) => {
        if (toastData?.data?.user) {
          openDirectChat(toastData.data.user);
        } else if (toastData?.data?.channel) {
          openChannelChat(toastData.data.channel);
        }
      });
    }
  }, [token]);

  // Test corner pop-up notification
  const handleTestNotification = () => {
    const otherUser = users.find((u) => u.id !== currentUser?.id) || users[0] || null;
    const senderName = otherUser ? (otherUser.full_name || otherUser.username) : 'Коллега';
    addToast({
      title: senderName,
      body: 'Привет! Проверка всплывающего уведомления в правом углу 🚀',
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

      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ text, type: msgType, reply_to_id: replyToId })
      });
    }
  };

  // Send File
  const handleSendFile = async (file, conversationType, targetId) => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const upRes = await fetch(`${serverUrl}/api/files/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (upRes.ok) {
        const fData = await upRes.json();
        const isImage = file.type.startsWith('image/');

        handleSendMessage({
          conversationType,
          targetId,
          text: file.name,
          msgType: isImage ? 'image' : 'file',
          metadata: {
            file_id: fData.file.id,
            size: file.size,
            mimeType: file.type,
            url: `/api/files/download/${fData.file.id}`
          }
        });
      }
    } catch (err) {
      console.error('Upload error:', err);
    }
  };

  // Profile Update
  const handleUpdateProfile = async (updatedFields) => {
    try {
      const res = await fetch(`${serverUrl}/api/users/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(updatedFields)
      });
      if (res.ok) {
        const updated = await res.json();
        setCurrentUser(updated);
        loadBaseData();
      }
    } catch (err) {
      console.error('Profile update error:', err);
    }
  };

  // ── Presence State Engine ──
  const updateMyPresence = (newStatus, customStatus = null) => {
    if (!currentUserRef.current) return;
    const userId = currentUserRef.current.id;

    setCurrentUser((prev) => (prev ? { ...prev, status: newStatus, custom_status: customStatus ?? prev.custom_status } : prev));

    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, status: newStatus, custom_status: customStatus ?? u.custom_status } : u))
    );

    setTreeData((prev) => {
      if (!prev) return prev;
      const updateDept = (d) => {
        const updatedEmps = d.employees?.map((e) => (e.id === userId ? { ...e, status: newStatus } : e));
        const updatedSubs = d.subDepartments?.map(updateDept);
        return { ...d, employees: updatedEmps, subDepartments: updatedSubs };
      };
      return { ...prev, tree: prev.tree?.map(updateDept) };
    });

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'set_status',
          status: newStatus,
          customStatus: customStatus ?? currentUserRef.current.custom_status
        })
      );
    }

    if (window.electronAPI?.syncTrayStatus) {
      window.electronAPI.syncTrayStatus(newStatus);
    }
  };

  const handleStatusChange = (newStatus) => {
    updateMyPresence(newStatus);
  };

  // ── Automated Presence Triggers (Electron OS + Web Engine) ──
  useEffect(() => {
    // 1. Electron Native OS Hooks (powerMonitor)
    if (window.electronAPI?.onPowerMonitorEvent) {
      window.electronAPI.onPowerMonitorEvent(({ state, status, idleSeconds }) => {
        console.log(`[Presence Trigger] OS Power Event: ${state} (status: ${status}, idle: ${idleSeconds}s)`);
        if (status) {
          updateMyPresence(status);
        }
      });
    }

    if (window.electronAPI?.onTrayStatusChange) {
      window.electronAPI.onTrayStatusChange((status) => {
        console.log(`[Presence Trigger] Tray Status Selected: ${status}`);
        updateMyPresence(status);
      });
    }

    // 2. Web Inactivity / Idle Trigger Engine (Fallback and Browser clients)
    let idleTimer = null;
    let isAwayDueToIdle = false;
    let isAwayDueToHidden = false;

    const resetIdleTimer = () => {
      if (isAwayDueToIdle && currentUserRef.current?.status === 'away') {
        isAwayDueToIdle = false;
        console.log('[Presence Trigger] Activity resumed -> restoring "online"');
        updateMyPresence('online');
      }

      if (idleTimer) clearTimeout(idleTimer);
      // 5 minutes (300,000 ms) of zero mouse/keyboard action -> "away"
      idleTimer = setTimeout(() => {
        if (currentUserRef.current?.status === 'online') {
          console.log('[Presence Trigger] 5 min of inactivity -> setting "away"');
          isAwayDueToIdle = true;
          updateMyPresence('away');
        }
      }, 300000);
    };

    const activityEvents = ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'scroll'];
    activityEvents.forEach((evt) => window.addEventListener(evt, resetIdleTimer, { passive: true }));
    resetIdleTimer();

    // 3. Tab Visibility Change (Tab background / minimize)
    let visibilityTimeout = null;
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab hidden for > 3 minutes -> "away"
        visibilityTimeout = setTimeout(() => {
          if (currentUserRef.current?.status === 'online') {
            console.log('[Presence Trigger] Tab hidden for 3 minutes -> setting "away"');
            isAwayDueToHidden = true;
            updateMyPresence('away');
          }
        }, 180000);
      } else {
        if (visibilityTimeout) clearTimeout(visibilityTimeout);
        if (isAwayDueToHidden && currentUserRef.current?.status === 'away') {
          isAwayDueToHidden = false;
          console.log('[Presence Trigger] Tab focused -> restoring "online"');
          updateMyPresence('online');
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 4. Network Connectivity Triggers (Online / Offline)
    const handleOnline = () => {
      console.log('[Presence Trigger] Network connection restored -> "online"');
      updateMyPresence('online');
      if (token) initWebSocket(token);
    };

    const handleOffline = () => {
      console.log('[Presence Trigger] Network disconnected -> "offline"');
      updateMyPresence('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (visibilityTimeout) clearTimeout(visibilityTimeout);
      activityEvents.forEach((evt) => window.removeEventListener(evt, resetIdleTimer));
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [token]);

  // Create Channel
  const handleCreateChannel = async (e) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;

    try {
      const res = await fetch(`${serverUrl}/api/channels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name: newChannelName.trim(), topic: newChannelTopic.trim() })
      });

      if (res.ok) {
        const created = await res.json();
        setChannels((prev) => [...prev, created]);
        setShowCreateChannelModal(false);
        setNewChannelName('');
        setNewChannelTopic('');
        openChannelChat(created);
      }
    } catch (err) {
      console.error('Create channel error:', err);
    }
  };

  const filteredUsers = users.filter((u) => {
    if (u.id === currentUser?.id) return false;
    if (!dialogSearch.trim()) return true;
    const q = dialogSearch.toLowerCase();
    return (
      u.full_name?.toLowerCase().includes(q) ||
      u.username?.toLowerCase().includes(q) ||
      String(u.extension || '').includes(q) ||
      String(u.uin || '').includes(q)
    );
  });

  const isAdmin = Boolean(
    currentUser && (
      currentUser.role_id === 1 ||
      currentUser.role_name === 'Суперадминистратор' ||
      currentUser.role_name === 'Admin' ||
      currentUser.role_name === 'Администратор' ||
      currentUser.username === 'admin' ||
      currentUser.permissions?.is_admin
    )
  );

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
          {pwError && <div className="login-error-box">⚠️ {pwError}</div>}
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
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <MenuBar
        currentUser={currentUser}
        onOpenProfile={() => setShowProfileModal(true)}
        onSwitchAccount={handleLogout}
        onStatusChange={handleStatusChange}
        onSelectTab={setActiveTab}
        onTogglePersonPanel={() => setIsPersonPanelOpen((prev) => !prev)}
        onOpenDbStudio={() => isAdmin && setActiveTab('db')}
        onOpenAdminConsole={() => isAdmin && setShowAdminModal(true)}
        onOpenWhatIsNew={() => setShowAboutModal(true)}
        onOpenServerConnect={() => setShowServerConnectModal(true)}
        onTestNotification={handleTestNotification}
      />

      <div className="workspace-layout">
        {/* Column 1: Leftmost Navigation Rail */}
        <div className="vertical-nav-rail">
          <div className="rail-hamburger-item" title="Главное меню">
            <span className="rail-hamburger-icon">☰</span>
          </div>

          <div className="rail-nav-tabs">
            <div
              className={`rail-tab-btn ${activeTab === 'chats' ? 'active' : ''}`}
              onClick={() => setActiveTab('chats')}
              title="Чаты"
            >
              <div className="rail-tab-icon-box">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <span className="rail-tab-label">Чаты</span>
            </div>

            <div
              className={`rail-tab-btn ${activeTab === 'channels' ? 'active' : ''}`}
              onClick={() => setActiveTab('channels')}
              title="Каналы и конференции"
            >
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
              onClick={() => setActiveTab('contacts')}
              title="Контакты и оргструктура"
            >
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
              onClick={() => setActiveTab('important')}
              title="Официальные оповещения"
            >
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
                <span className="arrow-down">⌵</span>
              </div>
              <div className="sub-panel-search-box">
                <input
                  type="text"
                  className="sub-panel-search-input"
                  placeholder="Поиск..."
                  value={dialogSearch}
                  onChange={(e) => setDialogSearch(e.target.value)}
                />
                <span className="search-icon">🔍</span>
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
              {filteredUsers.map((u) => {
                const isActive = activeChat?.type === 'direct' && activeChat.id === u.id;
                const isOnline = u.status === 'online';
                const displayName = u.full_name || u.username;

                const lastConvo = directConvos.find((c) => c.other_user_id === u.id);
                const snippet = lastConvo?.last_message_text || 'Нажмите для беседы';
                const timeStr = lastConvo?.last_message_time ? formatDialogTime(lastConvo.last_message_time) : '';
                const unreadBadge = unreadMap[u.id] !== undefined ? unreadMap[u.id] : (lastConvo?.unread_count || 0);

                return (
                  <div
                    key={u.id}
                    className={`dialog-list-item ${isActive ? 'active' : ''} ${unreadBadge > 0 ? 'has-unread-item' : ''} ${isOnline ? 'online-bar' : 'offline-bar'}`}
                    onClick={() => openDirectChat(u)}
                  >
                    <div className="dialog-avatar-container">
                      {u.avatar_url ? (
                        <img src={u.avatar_url} alt="" className="dialog-avatar-img" />
                      ) : (
                        <div className="dialog-avatar-placeholder">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.6">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                            <circle cx="12" cy="13" r="4" />
                          </svg>
                        </div>
                      )}
                    </div>

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
                          <span className="dialog-unread-badge">{unreadBadge}</span>
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
                <span className="arrow-down">⌵</span>
              </div>
              <div className="sub-panel-search-box">
                <input
                  type="text"
                  className="sub-panel-search-input"
                  placeholder="Поиск..."
                />
                <span className="search-icon">🔍</span>
              </div>
            </div>

            <div className="conferences-container">
              <div className="conference-items-list">
                {channels.map((ch) => (
                  <div
                    key={ch.id}
                    className={`dialog-list-item ${activeChat?.type === 'channel' && activeChat.id === ch.id ? 'active' : ''}`}
                    onClick={() => openChannelChat(ch)}
                  >
                    <div className="dialog-avatar-container">
                      <div className="dialog-avatar-placeholder channel">#</div>
                    </div>
                    <div className="dialog-info-column">
                      <div className="dialog-row-top">
                        <span className="dialog-peer-name">#{ch.name}</span>
                      </div>
                      <div className="dialog-row-bottom">
                        <span className="dialog-snippet">{ch.topic || 'Корпоративный канал'}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="no-conferences-box">
                <p className="no-conf-title">У вас нет конференций.</p>
                <p className="no-conf-desc">
                  <button className="conf-link-btn" onClick={() => setShowCreateChannelModal(true)}>
                    Создайте новую
                  </button>{' '}
                  и пригласите туда людей, либо{' '}
                  <button className="conf-link-btn" onClick={() => {}}>
                    войдите
                  </button>{' '}
                  в существующую.
                </p>
              </div>
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
            <AnnouncementsView token={token} currentUser={currentUser} serverUrl={serverUrl} />
          </div>
        )}

        {activeTab === 'db' && isAdmin && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <DatabaseStudioView token={token} />
          </div>
        )}

        {/* Column 3: Main Central Pane */}
        {(activeTab === 'chats' || activeTab === 'channels' || activeTab === 'contacts') && (
          <div className="main-center-workspace">
            {activeChat ? (
              <ChatView
                activeChat={activeChat}
                messages={messages}
                messagesLoading={messagesLoading}
                currentUser={currentUser}
                typingUsers={typingMap[activeChat.id] || []}
                isPersonPanelOpen={isPersonPanelOpen}
                onTogglePersonPanel={() => setIsPersonPanelOpen((prev) => !prev)}
                onSendMessage={handleSendMessage}
                onSendFile={handleSendFile}
                onStartCall={handleStartCall}
                onRequestRemoteDesktop={handleRequestRemoteDesktop}
                onMarkRead={() => {}}
                token={token}
                serverUrl={serverUrl}
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
            onOpenAdminUser={() => setShowAdminModal(true)}
          />
        )}
      </div>

      {/* Native Windows Enterprise Status Bar */}
      <div className="native-status-bar">
        <div
          className="status-bar-left interactive"
          onClick={() => setShowServerConnectModal(true)}
          title="Нажмите для проверки связи или смены адреса сервера MyChat"
        >
          <span className={`status-net-dot ${wsConnected ? 'online' : 'offline'}`} />
          <span className="status-bar-text">
            {wsConnected
              ? `Подключено: ${serverUrl.replace(/^https?:\/\//, '')} [v${serverInfo?.version || '2026.1.0'}]`
              : 'Отключено от сети — нажмите для настройки...'}
          </span>
        </div>

        <div className="status-bar-center">
          <span className="status-bar-stat">
            👥 В сети: <strong>{users.filter((u) => u.status === 'online').length}</strong>
          </span>
          <span className="status-bar-divider">|</span>
          <span className="status-bar-stat">
            🕒 Отошли: <strong>{users.filter((u) => u.status === 'away').length}</strong>
          </span>
          <span className="status-bar-divider">|</span>
          <span className="status-bar-stat">
            Всего: <strong>{users.length}</strong>
          </span>
        </div>

        <div className="status-bar-right">
          {/* User Presence Switcher Button */}
          <div className="status-dropdown-wrapper">
            <button
              className="status-bar-presence-btn"
              onClick={() => setShowStatusDropdown((prev) => !prev)}
              title="Изменить мой статус присутствия"
            >
              <span className={`status-pill-dot ${currentUser?.status || 'offline'}`} />
              <span className="status-pill-text">
                {currentUser?.status === 'online'
                  ? 'В сети'
                  : currentUser?.status === 'away'
                  ? 'Отошел'
                  : currentUser?.status === 'dnd'
                  ? 'Не беспокоить'
                  : 'Не в сети'}
              </span>
              <span className="arrow-down">⌵</span>
            </button>

            {showStatusDropdown && (
              <div className="status-bar-menu">
                <div
                  className="status-bar-menu-item"
                  onClick={() => {
                    handleStatusChange('online');
                    setShowStatusDropdown(false);
                  }}
                >
                  <span className="status-pill-dot online" />
                  <span>В сети (активен)</span>
                </div>
                <div
                  className="status-bar-menu-item"
                  onClick={() => {
                    handleStatusChange('away');
                    setShowStatusDropdown(false);
                  }}
                >
                  <span className="status-pill-dot away" />
                  <span>Отошел (перерыв / экран заблокирован)</span>
                </div>
                <div
                  className="status-bar-menu-item"
                  onClick={() => {
                    handleStatusChange('dnd');
                    setShowStatusDropdown(false);
                  }}
                >
                  <span className="status-pill-dot dnd" />
                  <span>Не беспокоить (совещание)</span>
                </div>
                <div
                  className="status-bar-menu-item"
                  onClick={() => {
                    handleStatusChange('offline');
                    setShowStatusDropdown(false);
                  }}
                >
                  <span className="status-pill-dot offline" />
                  <span>Не в сети (отключен)</span>
                </div>
              </div>
            )}
          </div>

          <span className="status-bar-divider">|</span>

          {/* Log out */}
          <button
            className="status-bar-persona-btn"
            onClick={handleLogout}
            title="Выйти из учётной записи"
          >
            <span>👤 {currentUser ? (currentUser.full_name || currentUser.username) : 'Вход'}</span>
            <span className="persona-switch-badge">⇄</span>
          </button>
        </div>
      </div>

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
              <button className="btn-close-modal" onClick={() => setShowCreateChannelModal(false)}>✕</button>
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
          onClose={() => setShowAdminModal(false)}
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
          <div style={{ width: '92vw', height: '90vh', background: '#0f172a', borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 16px', background: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#fff' }}>
              <span>Удаленный рабочий стол: {inlineRdViewer.targetUser?.full_name}</span>
              <button className="btn btn-sm btn-secondary" onClick={() => setInlineRdViewer(null)}>Закрыть</button>
            </div>
            <div style={{ flex: 1 }}>
              <RemoteDesktopViewer
                sessionId={inlineRdViewer.sessionId}
                targetUser={inlineRdViewer.targetUser}
                wsClient={wsRef.current}
                pendingOffer={rdPendingOffer}
                onEndSession={() => {
                  setInlineRdViewer(null);
                  setRdPendingOffer(null);
                  setRdSessionId(null);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
