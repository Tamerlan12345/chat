import React, { useState, useEffect, useRef, useMemo } from 'react';
import Avatar from './Avatar';
import Icon from './Icon';

// Ctrl+K quick-switcher: instant client-side match over people/channels,
// plus a debounced server-side full-text search over message history
// (GET /api/messages/search) once the query looks like more than a name.
export default function CommandPalette({ users, channels, token, serverUrl, currentUserId, onSelectUser, onSelectChannel, onClose }) {
  const [query, setQuery] = useState('');
  const [messageResults, setMessageResults] = useState([]);
  const [searchingMessages, setSearchingMessages] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const searchSeqRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Себя в «Людях» быть не должно: открыть диалог с самим собой нельзя.
  const others = useMemo(() => (users || []).filter((u) => u.id !== currentUserId), [users, currentUserId]);

  const matchedUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return others.slice(0, 6);
    return others
      .filter((u) =>
        u.full_name?.toLowerCase().includes(q) ||
        u.username?.toLowerCase().includes(q) ||
        u.job_title?.toLowerCase().includes(q)
      )
      .slice(0, 6);
  }, [others, query]);

  const matchedChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return (channels || []).slice(0, 4);
    return (channels || [])
      .filter((c) => c.name?.toLowerCase().includes(q) || c.topic?.toLowerCase().includes(q))
      .slice(0, 4);
  }, [channels, query]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setMessageResults([]);
      return;
    }
    setSearchingMessages(true);
    // Ответ на «ива» может прийти позже ответа на «иванов» и затереть его —
    // учитывается только последний отправленный запрос.
    const seq = ++searchSeqRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${serverUrl}/api/messages/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok && seq === searchSeqRef.current) {
          const data = await res.json();
          if (seq === searchSeqRef.current) setMessageResults(Array.isArray(data) ? data.slice(0, 8) : []);
        }
      } catch (err) {
        // Silent: quick-switcher degrades to name-only search on network hiccup.
      } finally {
        if (seq === searchSeqRef.current) setSearchingMessages(false);
      }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, serverUrl, token]);

  const flatResults = useMemo(() => {
    const items = [];
    matchedUsers.forEach((u) => items.push({ kind: 'user', data: u }));
    matchedChannels.forEach((c) => items.push({ kind: 'channel', data: c }));
    messageResults.forEach((m) => items.push({ kind: 'message', data: m }));
    return items;
  }, [matchedUsers, matchedChannels, messageResults]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Результаты сократились (пришёл ответ поиска) — выделение не должно
  // указывать за конец списка, иначе Enter ничего не открывает.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, flatResults.length - 1)));
  }, [flatResults.length]);

  const activate = (item) => {
    if (!item) return;
    if (item.kind === 'user') {
      onSelectUser(item.data);
    } else if (item.kind === 'channel') {
      onSelectChannel(item.data);
    } else if (item.kind === 'message') {
      const m = item.data;
      if (m.conversation_type === 'channel') {
        const ch = (channels || []).find((c) => c.id === m.target_id) || { id: m.target_id, name: m.channel_name };
        onSelectChannel(ch);
      } else {
        // Direct message: whichever side isn't the current user is the
        // conversation partner to open.
        const otherId = m.sender_id === currentUserId ? m.target_id : m.sender_id;
        const other = (users || []).find((u) => u.id === otherId);
        if (other) onSelectUser(other);
      }
    }
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flatResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(flatResults[selectedIndex]);
    }
  };

  let runningIndex = -1;

  return (
    <div className="modal-backdrop command-palette-backdrop" onClick={onClose}>
      <div className="command-palette-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input-row">
          <Icon name="search" size={16} className="command-palette-icon" />
          <input
            ref={inputRef}
            className="command-palette-input"
            placeholder="Найти коллегу, канал или сообщение…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="command-palette-hint">Esc</span>
        </div>

        <div className="command-palette-results">
          {matchedUsers.length === 0 && matchedChannels.length === 0 && messageResults.length === 0 && (
            <div className="command-palette-empty">
              {searchingMessages ? 'Ищу…' : 'Ничего не найдено'}
            </div>
          )}

          {matchedUsers.length > 0 && (
            <div className="command-palette-group">
              <div className="command-palette-group-label">Люди</div>
              {matchedUsers.map((u) => {
                runningIndex += 1;
                const idx = runningIndex;
                return (
                  <div
                    key={`u_${u.id}`}
                    className={`command-palette-item ${idx === selectedIndex ? 'active' : ''}`}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => activate({ kind: 'user', data: u })}
                  >
                    <Avatar name={u.full_name || u.username} src={u.avatar_url} size={24} />
                    <span className="cp-item-title">{u.full_name || u.username}</span>
                    <span className="cp-item-sub">{u.job_title || ''}</span>
                  </div>
                );
              })}
            </div>
          )}

          {matchedChannels.length > 0 && (
            <div className="command-palette-group">
              <div className="command-palette-group-label">Каналы</div>
              {matchedChannels.map((c) => {
                runningIndex += 1;
                const idx = runningIndex;
                return (
                  <div
                    key={`c_${c.id}`}
                    className={`command-palette-item ${idx === selectedIndex ? 'active' : ''}`}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => activate({ kind: 'channel', data: c })}
                  >
                    <span className="cp-item-icon"><Icon name="hash" size={14} /></span>
                    <span className="cp-item-title">{String(c.name || '').replace(/^#+/, '')}</span>
                    <span className="cp-item-sub">{c.topic || ''}</span>
                  </div>
                );
              })}
            </div>
          )}

          {messageResults.length > 0 && (
            <div className="command-palette-group">
              <div className="command-palette-group-label">Сообщения</div>
              {messageResults.map((m) => {
                runningIndex += 1;
                const idx = runningIndex;
                return (
                  <div
                    key={`m_${m.id}`}
                    className={`command-palette-item ${idx === selectedIndex ? 'active' : ''}`}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => activate({ kind: 'message', data: m })}
                  >
                    <span className="cp-item-icon"><Icon name="message" size={14} /></span>
                    <span className="cp-item-title">{m.sender_name}{m.channel_name ? ` в #${m.channel_name}` : ''}</span>
                    <span className="cp-item-sub cp-item-snippet">{m.text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
