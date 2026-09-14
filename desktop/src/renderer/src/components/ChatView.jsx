import React, { useState, useEffect, useRef } from 'react';
import EmojiPicker from './EmojiPicker';
import Avatar from './Avatar';
import Icon from './Icon';
import WakeControl from './WakeControl';
import ImageViewer from './ImageViewer';
import { formatBytes, uploadProblem, imageFrame } from '../lib/attachments.mjs';
import { loadImage } from '../lib/image-cache';

export default function ChatView({
  activeChat,
  messages,
  messagesLoading,
  currentUser,
  typingUsers,
  isPersonPanelOpen,
  onTogglePersonPanel,
  onSendMessage,
  onSendFile,
  onStartCall,
  onRequestRemoteDesktop,
  onMarkRead,
  onTyping,
  token,
  serverUrl,
  onNotice,
  connected = true,
  wake = null,
  onWake
}) {
  const [inputText, setInputText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showPhrasesMenu, setShowPhrasesMenu] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // Отправляемые файлы этого окна: { id, chatKey, name, size, progress, error, controller }.
  const [uploads, setUploads] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(null);

  const messagesEndRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const textareaRef = useRef(null);
  const wasNearBottomRef = useRef(true);
  const prevChatKeyRef = useRef(null);
  const prevMessageCountRef = useRef(0);

  const NEAR_BOTTOM_THRESHOLD = 80;

  const isStreamNearBottom = () => {
    const el = streamRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
  };

  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    wasNearBottomRef.current = true;
    setShowJumpToLatest(false);
    setNewMessageCount(0);
  };

  const handleStreamScroll = () => {
    const nearBottom = isStreamNearBottom();
    wasNearBottomRef.current = nearBottom;
    if (nearBottom) {
      setShowJumpToLatest(false);
      setNewMessageCount(0);
    }
  };

  useEffect(() => {
    const chatKey = activeChat ? `${activeChat.type}:${activeChat.id}` : null;
    const isChatSwitch = chatKey !== prevChatKeyRef.current;
    prevChatKeyRef.current = chatKey;

    if (isChatSwitch) {
      // Switching conversations: always land on the latest message.
      scrollToBottom(false);
    } else if (messages.length > prevMessageCountRef.current) {
      // New message(s) arrived in the open conversation: only auto-scroll
      // if the user was already reading near the bottom, otherwise let them
      // keep reading history and surface a "jump to latest" pill instead.
      if (wasNearBottomRef.current) {
        scrollToBottom(true);
      } else {
        setNewMessageCount((n) => n + (messages.length - prevMessageCountRef.current));
        setShowJumpToLatest(true);
      }
    }
    prevMessageCountRef.current = messages.length;

    if (activeChat && (isChatSwitch || wasNearBottomRef.current)) {
      onMarkRead(activeChat.type, activeChat.id);
    }
  }, [messages, activeChat]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key !== 'Escape') return;
      if (showEmojiPicker) setShowEmojiPicker(false);
      if (showAttachMenu) setShowAttachMenu(false);
      if (showPhrasesMenu) setShowPhrasesMenu(false);
      if (showMoreMenu) setShowMoreMenu(false);
      if (replyingTo) setReplyingTo(null);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showEmojiPicker, showAttachMenu, showPhrasesMenu, showMoreMenu, replyingTo]);

  const handleSend = (e) => {
    e?.preventDefault();
    if (!inputText.trim()) return;

    onSendMessage({
      conversationType: activeChat.type,
      targetId: activeChat.id,
      text: inputText.trim(),
      msgType: 'text',
      replyToId: replyingTo?.id || null
    });

    setInputText('');
    setReplyingTo(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e) => {
    // Enter, которым подтверждают выбор в раскладке с набором (китайский,
    // японский, корейский ввод), не должен отправлять недописанное сообщение.
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Сообщаем собеседнику, что печатаем. Индикатор и его обработка на сервере
  // существовали, но клиент никогда ничего не отправлял — надпись «печатает»
  // не появлялась ни разу.
  //
  // Событие уходит не на каждую букву: одно на начало набора, потом не чаще
  // раза в три секунды, и «перестал печатать» через секунду после последнего
  // нажатия.
  const typingSentAtRef = useRef(0);
  const typingStopRef = useRef(null);

  const notifyTyping = () => {
    if (!onTyping || !activeChat) return;
    const now = Date.now();
    if (now - typingSentAtRef.current > 3000) {
      typingSentAtRef.current = now;
      onTyping(activeChat.type, activeChat.id, true);
    }
    clearTimeout(typingStopRef.current);
    typingStopRef.current = setTimeout(() => {
      typingSentAtRef.current = 0;
      onTyping(activeChat.type, activeChat.id, false);
    }, 1000);
  };

  useEffect(() => () => clearTimeout(typingStopRef.current), []);

  const handleTextareaInput = (e) => {
    setInputText(e.target.value);
    notifyTyping();
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  const chatKey = `${activeChat.type}:${activeChat.id}`;
  const patchUpload = (id, patch) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  const dropUpload = (id) => setUploads((list) => list.filter((u) => u.id !== id));

  // Проверка размера — в момент выбора файла. Раньше файл уходил на сервер
  // целиком, и отказ «больше 100 МБ» приходил через минуты загрузки.
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const base = { id, chatKey, name: file.name, size: file.size, progress: 0, error: null, controller: null };
    const problem = uploadProblem(file);
    if (problem) {
      setUploads((list) => [...list, { ...base, error: problem }]);
      return;
    }
    const controller = new AbortController();
    setUploads((list) => [...list, { ...base, controller }]);
    const result = await onSendFile(file, activeChat.type, activeChat.id, {
      signal: controller.signal,
      onProgress: (p) => patchUpload(id, { progress: p })
    });
    if (result?.ok || result?.cancelled) dropUpload(id);
    else patchUpload(id, { error: result?.error || 'Файл не отправлен', controller: null });
  };

  // Ошибка гаснет сама через несколько секунд — её успевают прочитать.
  useEffect(() => {
    const failed = uploads.filter((u) => u.error);
    if (!failed.length) return undefined;
    const t = setTimeout(() => setUploads((list) => list.filter((u) => !failed.includes(u))), 8000);
    return () => clearTimeout(t);
  }, [uploads]);

  // Готовые фразы для деловой переписки. «Сегодня че идем?)» отсюда убрана:
  // в корпоративном мессенджере страховой компании ей не место.
  const corporatePhrases = [
    'Добрый день!',
    'Принято в работу.',
    'Готово.',
    'Спасибо!',
    'Ок, договорились.',
    'Уточняю у коллег, вернусь с ответом.',
    'Буду на месте через 10 минут.',
    'Прошу согласовать.'
  ];

  const handleInsertEmoji = (emoji) => {
    setInputText((prev) => prev + emoji);
    setShowEmojiPicker(false);
    textareaRef.current?.focus();
  };

  const handleInsertPhrase = (phrase) => {
    setInputText(phrase);
    setShowPhrasesMenu(false);
    textareaRef.current?.focus();
  };

  // The download route is behind requireAuth, and a plain <a href> cannot send
  // an Authorization header — every attachment link returned 401. Fetch it with
  // the token and hand the browser a blob instead.
  const downloadAttachment = async (fileId, suggestedName) => {
    if (!fileId) return;
    try {
      const res = await fetch(`${serverUrl}/api/files/download/${fileId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      // Сообщение в углу вместо alert(): модальное окно останавливало всё
      // приложение, включая приём сообщений, пока его не закроют.
      if (!res.ok) {
        onNotice?.(res.status === 403 ? 'Нет доступа к этому файлу' : 'Не удалось скачать файл', suggestedName);
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = suggestedName || 'файл';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      onNotice?.('Не удалось скачать файл', 'Нет связи с сервером');
    }
  };

  const parseMeta = (m) => {
    if (!m.metadata_json) return null;
    try {
      return typeof m.metadata_json === 'string' ? JSON.parse(m.metadata_json) : m.metadata_json;
    } catch {
      return null;
    }
  };
  const isImageMessage = (m, meta) => m.type === 'image' || Boolean(meta?.mimeType?.startsWith('image/'));
  // Картинки чата по порядку — чтобы в просмотре листать стрелками.
  const chatImages = messages
    .map((m) => ({ m, meta: parseMeta(m) }))
    .filter(({ m, meta }) => m.type !== 'file' && isImageMessage(m, meta) && meta?.file_id)
    .map(({ m, meta }) => ({
      messageId: m.id,
      fileId: meta.file_id,
      name: m.text || 'Изображение',
      sender: m.sender_id === currentUser.id ? 'Вы' : m.sender_name || activeChat.name,
      time: new Date(m.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    }));
  const openViewer = (messageId) => {
    const i = chatImages.findIndex((img) => img.messageId === messageId);
    if (i >= 0) setViewerIndex(i);
  };

  const isDirect = activeChat.type === 'direct';
  // Сервер пускает к чужому экрану только с правом can_remote_control —
  // кнопка без него лишь выдавала отказ.
  const canRemoteControl = Boolean(currentUser?.permissions?.can_remote_control);
  const chatTitle = activeChat.name || (isDirect ? activeChat.user?.full_name : `#${activeChat.channel?.name}`);
  const isOnline = isDirect ? (activeChat.user?.status === 'online') : true;

  // Consecutive messages from the same person are grouped: only the first of
  // a group carries the avatar, name and timestamp. A new group starts on a
  // different sender, a day boundary, or a pause longer than this.
  const GROUP_BREAK_MS = 5 * 60 * 1000;

  const dayLabel = (date) => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Сегодня';
    if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
    return date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {})
    });
  };

  const renderMessages = () => {
    const elements = [];
    let hasDrawnUnreadSeparator = false;

    messages.forEach((m, idx) => {
      const msgDate = new Date(m.created_at);
      const isMine = m.sender_id === currentUser.id;

      const timeStr = msgDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

      const prev = idx > 0 ? messages[idx - 1] : null;
      const prevDate = prev ? new Date(prev.created_at) : null;
      const isNewDay = !prevDate || prevDate.toDateString() !== msgDate.toDateString();
      const startsGroup =
        isNewDay ||
        prev.sender_id !== m.sender_id ||
        msgDate - prevDate > GROUP_BREAK_MS;

      if (isNewDay) {
        elements.push(
          <div key={`day_${msgDate.toDateString()}`} className="chat-day-separator">
            <span>{dayLabel(msgDate)}</span>
          </div>
        );
      }

      // Draw unread line before unread messages from other peer.
      // Только в личной переписке и только для истории: у сообщений каналов и
      // у пришедших только что статуса нет вовсе, и черта «непрочитанные»
      // появлялась над каждым из них.
      if (isDirect && !isMine && m.delivery_status !== undefined && m.delivery_status !== 'read' && !hasDrawnUnreadSeparator) {
        elements.push(
          <div key={`unread_sep_${idx}`} className="chat-unread-separator">
            <span>непрочитанные сообщения</span>
          </div>
        );
        hasDrawnUnreadSeparator = true;
      }

      const senderDisplayName =
        (isMine ? currentUser.full_name : m.sender_name || activeChat.name) || 'Неизвестный участник';

      const metadata = parseMeta(m);

      elements.push(
        <div
          key={m.id || idx}
          // Только что пришедшее сообщение появляется с коротким движением —
          // своё поднимается от поля ввода. История при открытии чата не
          // анимируется: строка уже существует, и анимация не повторяется.
          className={`classic-chat-message-row${isMine ? ' is-mine' : ''}${startsGroup ? ' starts-group' : ' continues-group'}${
            Date.now() - msgDate.getTime() < 8000 ? ' is-fresh' : ''
          }`}
        >
          <div className="classic-msg-avatar-slot">
            {startsGroup ? (
              // Цвет несёт аватар; имя остаётся обычным текстом — радуга из
              // имён в ленте спорила с самими сообщениями.
              <Avatar name={senderDisplayName} size={32} />
            ) : (
              <span className="classic-msg-hover-time">{timeStr}</span>
            )}
          </div>

          <div className="classic-msg-main">
            {startsGroup && (
              <div className="classic-msg-header">
                <span className="classic-sender-name">
                  {senderDisplayName}
                  {isMine && <span className="classic-sender-you">вы</span>}
                </span>
                <div className="classic-msg-meta">
                  <span className="classic-msg-time">{timeStr}</span>
                  {isMine && (() => {
                    // Сервер отдаёт статус в delivery_status ('delivered' |
                    // 'read'); поля is_read, которое читалось раньше, в ответе
                    // нет вовсе — поэтому галочка всегда оставалась одной.
                    const isRead = m.delivery_status === 'read';
                    return (
                      <span
                        className={`classic-msg-ticks${isRead ? ' read' : ''}`}
                        title={isRead ? 'Прочитано' : 'Доставлено'}
                      >
                        {isRead ? '✓✓' : '✓'}
                      </span>
                    );
                  })()}
                </div>
              </div>
            )}

            <div className="classic-msg-body">
            {/* Reply Quote Banner */}
            {m.reply_to_id && (
              <div className="chat-reply-quote">
                <span className="chat-reply-quote-sender">В ответ на сообщение:</span>
                <div className="chat-reply-quote-text">
                  {messages.find((x) => x.id === m.reply_to_id)?.text || 'Сообщение...'}
                </div>
              </div>
            )}

            {/* Attachments */}
            {m.type === 'file' ? (
              <div className="chat-file-attachment">
                <span className="chat-file-icon" aria-hidden="true">
                  <Icon name="file" size={20} />
                  {fileExtension(m.text) && <span className="chat-file-ext">{fileExtension(m.text)}</span>}
                </span>
                <div className="chat-file-info">
                  <div className="chat-file-name" title={m.text}>{m.text}</div>
                  <div className="chat-file-meta">{metadata?.size ? formatBytes(metadata.size) : 'Файл'}</div>
                </div>
                <button
                  type="button"
                  className="chat-file-download"
                  disabled={!metadata?.file_id}
                  onClick={() => downloadAttachment(metadata?.file_id, m.text)}
                  title={metadata?.file_id ? 'Скачать' : 'Файл недоступен'}
                  aria-label={metadata?.file_id ? `Скачать «${m.text}»` : 'Файл недоступен'}
                >
                  <Icon name="download" size={16} />
                </button>
              </div>
            ) : isImageMessage(m, metadata) ? (
              <ChatImage
                fileId={metadata?.file_id}
                width={metadata?.width}
                height={metadata?.height}
                alt={m.text || 'Изображение'}
                token={token}
                serverUrl={serverUrl}
                onOpen={() => openViewer(m.id)}
              />
            ) : (
              <div className="classic-msg-text">{m.text}</div>
            )}
            </div>
          </div>
        </div>
      );
    });

    return elements;
  };

  const userStatus = isDirect ? (activeChat.user?.status || 'offline') : null;
  const statusLabel = isDirect
    ? (userStatus === 'online' ? 'в сети' : userStatus === 'away' ? 'отошел' : userStatus === 'dnd' ? 'не беспокоить' : 'не в сети')
    : 'корпоративный канал';

  return (
    <div className="classic-chat-container">
      {/* 1. Header Matching Screenshot 2 */}
      <div className="classic-chat-header">
        {/* Лицо собеседника в шапке: тот же аватар, что в списке и в ленте, —
            видно, кому пишешь, ещё до того, как прочитано имя. */}
        {isDirect ? (
          <Avatar name={chatTitle} src={activeChat.user?.avatar_url} size={36} className="classic-header-avatar" />
        ) : (
          <span className="ui-avatar is-square channel-avatar classic-header-avatar" style={{ width: 36, height: 36 }}>
            <Icon name="hash" size={16} strokeWidth={2} />
          </span>
        )}
        <div className="classic-header-info">
          <div className="classic-header-title">{chatTitle}</div>
          <div className="classic-header-status">
            {isDirect && <span className={`chat-header-status-dot ${userStatus}`} />}
            <span>{statusLabel}</span>
          </div>
        </div>

        <div className="classic-header-actions">
          {isDirect && onWake && (
            <WakeControl peer={activeChat.user} wake={wake} connected={connected} onWake={onWake} />
          )}
          {/* Только личные диалоги: звонить в канал некому. Видеозвонка нет
              намеренно — кнопка без работающей функции хуже её отсутствия. */}
          {isDirect && (
            <button
              className="classic-action-icon-btn"
              title={`Голосовой звонок: ${chatTitle}`}
              aria-label="Голосовой звонок"
              onClick={() => onStartCall && onStartCall(activeChat.user)}
            >
              <Icon name="phone" />
            </button>
          )}
          {/* В канале у кнопок «экран», «профиль», «ещё» нет адресата — они
              молча ничего не делали. */}
          {isDirect && canRemoteControl && (
          <button
            className="classic-action-icon-btn"
            title="Удаленный рабочий стол сотрудника"
            aria-label="Удалённый рабочий стол"
            onClick={() => onRequestRemoteDesktop && onRequestRemoteDesktop(activeChat.user)}
          >
            <Icon name="monitor" />
          </button>
          )}
          {isDirect && (
          <button
            className={`classic-action-icon-btn ${isPersonPanelOpen ? 'active' : ''}`}
            title="Информация о человеке (Свойства)"
            aria-label="Информация о сотруднике"
            aria-pressed={Boolean(isPersonPanelOpen)}
            onClick={onTogglePersonPanel}
          >
            <Icon name="panelRight" />
          </button>
          )}
          {isDirect && (
          <div style={{ position: 'relative' }}>
            <button
              className={`classic-action-icon-btn ${showMoreMenu ? 'active' : ''}`}
              title="Дополнительные действия"
              aria-label="Дополнительные действия"
              aria-expanded={showMoreMenu}
              onClick={() => setShowMoreMenu((prev) => !prev)}
            >
              <Icon name="more" strokeWidth={3} />
            </button>
            {showMoreMenu && (
              <div className="classic-popup-menu" style={{ right: 0, left: 'auto', top: '100%', bottom: 'auto' }}>
                <div
                  className="classic-popup-menu-item"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onTogglePersonPanel && onTogglePersonPanel();
                  }}
                >
                  <Icon name="user" size={14} /><span>Профиль сотрудника</span>
                </div>
                {canRemoteControl && (
                  <div
                    className="classic-popup-menu-item"
                    onClick={() => {
                      setShowMoreMenu(false);
                      onRequestRemoteDesktop && onRequestRemoteDesktop(activeChat.user);
                    }}
                  >
                    <Icon name="monitor" size={14} /><span>Подключиться к экрану</span>
                  </div>
                )}
                <div
                  className="classic-popup-menu-item"
                  onClick={async () => {
                    setShowMoreMenu(false);
                    const contact = [chatTitle, activeChat.user?.job_title, activeChat.user?.email, activeChat.user?.extension && `вн. ${activeChat.user.extension}`]
                      .filter(Boolean)
                      .join(', ');
                    try {
                      await navigator.clipboard.writeText(contact);
                      onNotice?.('Контакты скопированы', contact);
                    } catch {
                      onNotice?.('Не удалось скопировать контакты', 'Буфер обмена недоступен');
                    }
                  }}
                >
                  <Icon name="copy" size={14} /><span>Копировать контакты</span>
                </div>
              </div>
            )}
          </div>
          )}
        </div>
      </div>

      {/* 2. Messages Stream */}
      <div className="classic-chat-stream" ref={streamRef} onScroll={handleStreamScroll}>
        {messagesLoading ? (
          <div className="chat-empty-state">
            <div className="chat-loading-spinner" />
            <div className="chat-empty-desc">Загружаю переписку…</div>
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><Icon name={isDirect ? "message" : "hash"} size={22} /></div>
            <div className="chat-empty-title">Начало переписки</div>
            <div className="chat-empty-desc">
              {isDirect
                ? `Отправьте личное сообщение коллеге ${chatTitle}.`
                : `Напишите первое сообщение в ${chatTitle}.`}
            </div>
          </div>
        ) : (
          renderMessages()
        )}

        {/* Typing indicator */}
        {typingUsers && typingUsers.length > 0 && (
          <div className="chat-typing-indicator">
            <span className="typing-dots">
              <span>.</span><span>.</span><span>.</span>
            </span>
            <span>{typingUsers.join(', ')} печатает...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Jump to latest — shown instead of yanking the user back down while
          they're reading scrollback and a new message arrives */}
      {showJumpToLatest && (
        <button className="chat-jump-to-latest" onClick={() => scrollToBottom(true)}>
          <Icon name="arrowDown" size={14} />
          <span>Новые сообщения</span>
          {newMessageCount > 0 && <span className="jump-badge">{newMessageCount}</span>}
        </button>
      )}

      {/* 3. Reply Quote Bar */}
      {replyingTo && (
        <div className="chat-reply-banner">
          <div className="chat-reply-banner-content">
            <span className="chat-reply-banner-title">
              Ответ для {replyingTo.sender_name || 'собеседника'}:
            </span>
            <div className="chat-reply-banner-text">{replyingTo.text}</div>
          </div>
          <button className="chat-reply-banner-close" onClick={() => setReplyingTo(null)} aria-label="Отменить ответ">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* 4. Bottom Input Container Matching Screenshot 2 */}
      <div className="classic-input-container">
        {uploads.some((u) => u.chatKey === chatKey) && (
          <div className="upload-tray" aria-live="polite">
            {uploads.filter((u) => u.chatKey === chatKey).map((u) => (
              <div key={u.id} className={`upload-item${u.error ? ' is-error' : ''}`} role={u.error ? 'alert' : 'status'}>
                <span className="upload-item-icon">
                  <Icon name={u.error ? 'alert' : 'paperclip'} size={15} />
                </span>
                <div className="upload-item-body">
                  <div className="upload-item-line">
                    <span className="upload-item-name" title={u.name}>{u.name}</span>
                    <span className="upload-item-size">
                      {u.error ? formatBytes(u.size) : `${Math.round(u.progress * 100)}% · ${formatBytes(u.size)}`}
                    </span>
                  </div>
                  {u.error ? (
                    <div className="upload-item-error">{u.error}</div>
                  ) : (
                    <div className="upload-item-progress" aria-hidden="true">
                      <span style={{ transform: `scaleX(${u.progress})` }} />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="upload-item-close"
                  onClick={() => (u.controller ? u.controller.abort() : dropUpload(u.id))}
                  title={u.controller ? 'Отменить отправку' : 'Скрыть'}
                  aria-label={u.controller ? `Отменить отправку «${u.name}»` : 'Скрыть'}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hidden Inputs */}
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleFileUpload}
        />
        <input
          type="file"
          accept="image/*"
          ref={imageInputRef}
          style={{ display: 'none' }}
          onChange={handleFileUpload}
        />

        {/* Toolbar Above Input */}
        <div className="classic-input-toolbar">
          {/* Smiley Button */}
          <button
            type="button"
            className={`classic-tool-item ${showEmojiPicker ? 'active' : ''}`}
            title="Смайлики и эмодзи"
            aria-label="Смайлики и эмодзи"
            aria-expanded={showEmojiPicker}
            onClick={() => {
              setShowEmojiPicker((prev) => !prev);
              setShowAttachMenu(false);
              setShowPhrasesMenu(false);
            }}
          >
            <Icon name="smile" size={16} />
          </button>

          {/* Attach Dropdown */}
          <div className="classic-dropdown-wrapper">
            <button
              type="button"
              className="classic-tool-item-with-arrow"
              onClick={() => {
                setShowAttachMenu((prev) => !prev);
                setShowEmojiPicker(false);
                setShowPhrasesMenu(false);
              }}
            >
              <Icon name="paperclip" size={14} />
              <span>Вставить</span>
              <Icon name="chevronDown" size={12} className="arrow-down" />
            </button>

            {showAttachMenu && (
              <div className="classic-popup-menu">
                <div
                  className="classic-popup-menu-item"
                  onClick={() => {
                    fileInputRef.current?.click();
                    setShowAttachMenu(false);
                  }}
                >
                  <Icon name="file" size={14} /><span>Файл…</span><span className="classic-popup-menu-hint">до 100 МБ</span>
                </div>
                <div
                  className="classic-popup-menu-item"
                  onClick={() => {
                    imageInputRef.current?.click();
                    setShowAttachMenu(false);
                  }}
                >
                  <Icon name="image" size={14} /><span>Изображение…</span>
                </div>
              </div>
            )}
          </div>

          {/* Quick Phrases Dropdown */}
          <div className="classic-dropdown-wrapper">
            <button
              type="button"
              className="classic-tool-item-with-arrow"
              onClick={() => {
                setShowPhrasesMenu((prev) => !prev);
                setShowEmojiPicker(false);
                setShowAttachMenu(false);
              }}
            >
              <Icon name="message" size={14} />
              <span>Фраза</span>
              <Icon name="chevronDown" size={12} className="arrow-down" />
            </button>

            {showPhrasesMenu && (
              <div className="classic-popup-menu phrases-menu">
                {corporatePhrases.map((phrase, idx) => (
                  <div
                    key={idx}
                    className="classic-popup-menu-item"
                    onClick={() => handleInsertPhrase(phrase)}
                  >
                    {phrase}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Emoji Palette Popup */}
        {showEmojiPicker && (
          <EmojiPicker
            onSelectEmoji={handleInsertEmoji}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}

        {/* Text Area Row */}
        <div className="classic-textarea-row">
          <textarea
            ref={textareaRef}
            rows={2}
            className="classic-chat-textarea"
            placeholder={isDirect ? `Написать личное сообщение для ${chatTitle}...` : `Сообщение в ${chatTitle}...`}
            value={inputText}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
          />

          <button
            className="classic-send-btn"
            title="Отправить (Enter)"
            aria-label="Отправить"
            disabled={!inputText.trim()}
            onClick={handleSend}
          >
            <Icon name="send" size={18} strokeWidth={2} />
          </button>
        </div>
      </div>

      {viewerIndex !== null && chatImages[viewerIndex] && (
        <ImageViewer
          images={chatImages}
          index={viewerIndex}
          serverUrl={serverUrl}
          token={token}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onDownload={(img) => downloadAttachment(img.fileId, img.name)}
        />
      )}
    </div>
  );
}

// «PDF», «XLSX» — на значке файла: тип виден раньше, чем прочитано имя.
function fileExtension(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return match ? match[1].toUpperCase() : '';
}

// Картинка из переписки — в рамке. Место под неё занято сразу: размеры
// приходят в сообщении, и лента не прыгает, когда картинка догрузилась.
// Слишком вытянутые картинки рамка обрезает — целиком их видно в просмотре.
function ChatImage({ fileId, width, height, alt, token, serverUrl, onOpen }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState(null);

  useEffect(() => {
    if (!fileId) { setFailed(true); return undefined; }
    let alive = true;
    setFailed(false);
    loadImage(fileId, { serverUrl, token })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [fileId, token, serverUrl]);

  const frame = imageFrame(width || natural?.width, height || natural?.height);
  const style = { width: frame.width, height: frame.height };

  if (failed) {
    return (
      <div className="chat-image-frame is-failed" style={style} role="img" aria-label={`${alt}: изображение недоступно`}>
        <Icon name="image" size={20} />
        <span>Изображение недоступно</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`chat-image-frame${src ? ' is-ready' : ' is-loading'}`}
      style={style}
      onClick={onOpen}
      disabled={!src}
      title="Открыть"
      aria-label={`Открыть изображение «${alt}»`}
    >
      {src && (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => !width && setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        />
      )}
    </button>
  );
}
