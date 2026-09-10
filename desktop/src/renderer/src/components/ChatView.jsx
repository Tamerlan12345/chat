import React, { useState, useEffect, useRef } from 'react';
import EmojiPicker from './EmojiPicker';

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
  serverUrl
}) {
  const [inputText, setInputText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showPhrasesMenu, setShowPhrasesMenu] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

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

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onSendFile(file, activeChat.type, activeChat.id);
      e.target.value = '';
    }
  };

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
      if (!res.ok) {
        alert(res.status === 403 ? 'Нет доступа к этому файлу' : 'Не удалось скачать файл');
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
      alert('Не удалось скачать файл: нет связи с сервером');
    }
  };

  const isDirect = activeChat.type === 'direct';
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

  // Stable per-person colour so the same colleague always reads the same way
  // down the thread, instead of every name sharing one accent.
  const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#db2777', '#4f46e5'];
  const colorForName = (name) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  };
  const initialsOf = (name) =>
    name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

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

      // Draw unread line before unread messages from other peer
      if (!isMine && m.delivery_status !== 'read' && !hasDrawnUnreadSeparator) {
        elements.push(
          <div key={`unread_sep_${idx}`} className="chat-unread-separator">
            <span>непрочитанные сообщения</span>
          </div>
        );
        hasDrawnUnreadSeparator = true;
      }

      const senderDisplayName =
        (isMine ? currentUser.full_name : m.sender_name || activeChat.name) || 'Неизвестный участник';

      let metadata = null;
      if (m.metadata_json) {
        try {
          metadata = typeof m.metadata_json === 'string' ? JSON.parse(m.metadata_json) : m.metadata_json;
        } catch {}
      }

      elements.push(
        <div
          key={m.id || idx}
          className={`classic-chat-message-row${isMine ? ' is-mine' : ''}${startsGroup ? ' starts-group' : ' continues-group'}`}
        >
          <div className="classic-msg-avatar-slot">
            {startsGroup ? (
              <span
                className="classic-msg-avatar"
                style={{ backgroundColor: colorForName(senderDisplayName) }}
                title={senderDisplayName}
              >
                {initialsOf(senderDisplayName)}
              </span>
            ) : (
              <span className="classic-msg-hover-time">{timeStr}</span>
            )}
          </div>

          <div className="classic-msg-main">
            {startsGroup && (
              <div className="classic-msg-header">
                <span
                  className="classic-sender-name"
                  style={{ color: isMine ? '#0f172a' : colorForName(senderDisplayName) }}
                >
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
                <span className="chat-file-icon">📄</span>
                <div className="chat-file-info">
                  <div className="chat-file-name">{m.text}</div>
                  <div className="chat-file-meta">
                    {metadata?.size ? `${Math.round(metadata.size / 1024)} КБ • ` : ''}
                    <button
                      type="button"
                      className="chat-file-download-link"
                      disabled={!metadata?.file_id}
                      onClick={() => downloadAttachment(metadata?.file_id, m.text)}
                    >
                      {metadata?.file_id ? '⬇ Скачать файл' : 'Файл недоступен'}
                    </button>
                  </div>
                </div>
              </div>
            ) : m.type === 'image' || (metadata?.mimeType && metadata.mimeType.startsWith('image/')) ? (
              <div className="chat-image-attachment">
                <ChatImage
                  fileId={metadata?.file_id}
                  alt={m.text || 'Изображение'}
                  token={token}
                  serverUrl={serverUrl}
                  onOpen={() => downloadAttachment(metadata?.file_id, m.text)}
                />
              </div>
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
        <div className="classic-header-info">
          <div className="classic-header-title">{chatTitle}</div>
          <div className="classic-header-status">
            {isDirect && <span className={`chat-header-status-dot ${userStatus}`} />}
            <span>{statusLabel}</span>
          </div>
        </div>

        <div className="classic-header-actions">
          {/* Только личные диалоги: звонить в канал некому. Видеозвонка нет
              намеренно — кнопка без работающей функции хуже её отсутствия. */}
          {isDirect && (
            <button
              className="classic-action-icon-btn"
              title={`Голосовой звонок: ${chatTitle}`}
              onClick={() => onStartCall && onStartCall(activeChat.user)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </button>
          )}
          <button
            className="classic-action-icon-btn"
            title="Удаленный рабочий стол сотрудника"
            onClick={() => onRequestRemoteDesktop && onRequestRemoteDesktop(activeChat.user)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </button>
          <button
            className={`classic-action-icon-btn ${isPersonPanelOpen ? 'active' : ''}`}
            title="Информация о человеке (Свойства)"
            onClick={onTogglePersonPanel}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
          </button>
          <div style={{ position: 'relative' }}>
            <button
              className={`classic-action-icon-btn ${showMoreMenu ? 'active' : ''}`}
              title="Дополнительные действия"
              onClick={() => setShowMoreMenu((prev) => !prev)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="12" cy="19" r="2"/>
              </svg>
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
                  <span>👤 Профиль сотрудника</span>
                </div>
                <div
                  className="classic-popup-menu-item"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onRequestRemoteDesktop && onRequestRemoteDesktop(activeChat.user);
                  }}
                >
                  <span>🖥️ Подключиться к экрану</span>
                </div>
                <div
                  className="classic-popup-menu-item"
                  onClick={() => {
                    setShowMoreMenu(false);
                    navigator.clipboard.writeText(`${chatTitle} (${activeChat.user?.email || ''})`);
                    alert('Контактные данные скопированы в буфер');
                  }}
                >
                  <span>📋 Копировать контакты</span>
                </div>
              </div>
            )}
          </div>
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
            <div className="chat-empty-icon">💬</div>
            <div className="chat-empty-title">Начало переписки</div>
            <div className="chat-empty-desc">
              Отправьте личное сообщение коллеге {chatTitle}.
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
          <span>↓ Новые сообщения</span>
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
          <button className="chat-reply-banner-close" onClick={() => setReplyingTo(null)}>
            ✕
          </button>
        </div>
      )}

      {/* 4. Bottom Input Container Matching Screenshot 2 */}
      <div className="classic-input-container">
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
            onClick={() => {
              setShowEmojiPicker((prev) => !prev);
              setShowAttachMenu(false);
              setShowPhrasesMenu(false);
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
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
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
              </svg>
              <span>Вставить...</span>
              <span className="arrow-down">⌵</span>
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
                  <span>📄 Вставить файл...</span>
                </div>
                <div
                  className="classic-popup-menu-item"
                  onClick={() => {
                    imageInputRef.current?.click();
                    setShowAttachMenu(false);
                  }}
                >
                  <span>🖼️ Вставить изображение...</span>
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
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span>Фраза</span>
              <span className="arrow-down">⌵</span>
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
            placeholder={`Написать личное сообщение для ${chatTitle}...`}
            value={inputText}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
          />

          <button
            className="classic-send-btn"
            title="Отправить (Enter)"
            disabled={!inputText.trim()}
            onClick={handleSend}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// Картинка из переписки. Маршрут скачивания требует токен, а тег <img>
// заголовок авторизации отправить не может — поэтому каждое присланное
// изображение отображалось как «битая картинка». Загружаем запросом и
// показываем уже полученные данные.
function ChatImage({ fileId, alt, token, serverUrl, onOpen }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!fileId) { setFailed(true); return; }
    let objectUrl = null;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${serverUrl}/api/files/download/${fileId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, token, serverUrl]);

  if (failed) return <div className="chat-image-failed">Изображение недоступно</div>;
  if (!src) return <div className="chat-image-loading">Загружаю изображение…</div>;

  return <img src={src} alt={alt} className="chat-embedded-image" onClick={onOpen} />;
}
