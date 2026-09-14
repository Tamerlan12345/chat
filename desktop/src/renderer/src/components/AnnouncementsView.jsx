import React, { useState, useEffect, useRef } from 'react';
import { canBroadcast, createRequestSequence } from '../lib/admin-access.mjs';
import Icon from './Icon';

export default function AnnouncementsView({
  token,
  currentUser,
  serverUrl = 'https://chat-production-0456.up.railway.app',
  onAcknowledged
}) {
  const [announcements, setAnnouncements] = useState([]);
  const [selectedAnn, setSelectedAnn] = useState(null);
  const [auditData, setAuditData] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newPriority, setNewPriority] = useState('urgent');
  const [actionError, setActionError] = useState('');
  const [createError, setCreateError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ackBusyId, setAckBusyId] = useState(null);
  const [creating, setCreating] = useState(false);
  const selectedIdRef = useRef(null);
  const auditRequests = useRef(createRequestSequence());

  // Права — из флагов роли, как на сервере, а не из номера роли и логина.
  const isAdmin = Boolean(currentUser?.permissions?.is_admin);
  // Публиковать сервер разрешает и сотруднику с правом can_broadcast — кнопка
  // «Создать» у него должна быть.
  const canCreate = canBroadcast(currentUser);
  const canSeeAudit = (ann) => Boolean(ann) && (isAdmin || ann.author_id === currentUser?.id);

  const loadAnnouncements = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${serverUrl}/api/announcements`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAnnouncements(data);
        if (data.length > 0) {
          if (!selectedAnn || !data.some((a) => a.id === selectedAnn.id)) {
            selectAnnouncement(data[0]);
          } else {
            const currentUpdated = data.find((a) => a.id === selectedAnn.id);
            if (currentUpdated) selectAnnouncement(currentUpdated);
          }
        } else {
          setSelectedAnn(null);
        }
      }
    } catch (err) {
      console.error('Failed to load announcements:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectAnnouncement = async (ann) => {
    // Реестр прежнего объявления оставался на экране, пока не придёт новый, —
    // а при отказе сервера не уходил вовсе: под одним приказом показывались
    // отметки о другом. Ответы, пришедшие не по порядку, отбрасываются.
    if (selectedIdRef.current !== ann.id) setAuditData(null);
    selectedIdRef.current = ann.id;
    setSelectedAnn(ann);
    const requestId = auditRequests.current.next();
    if (!canSeeAudit(ann)) {
      setAuditData(null);
      return;
    }
    try {
      const res = await fetch(`${serverUrl}/api/announcements/${ann.id}/audit`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!auditRequests.current.isCurrent(requestId)) return;
      if (!res.ok) {
        setAuditData(null);
        return;
      }
      const audit = await res.json();
      if (auditRequests.current.isCurrent(requestId)) setAuditData(audit);
    } catch (err) {
      console.error('Audit fetch error:', err);
    }
  };

  useEffect(() => {
    loadAnnouncements();
  }, [token, serverUrl]);

  // Acknowledgement is a compliance record: the employee must never be left
  // believing they confirmed something the server rejected.
  const handleAcknowledge = async (annId) => {
    if (ackBusyId) return;
    setActionError('');
    setAckBusyId(annId);
    try {
      const res = await fetch(`${serverUrl}/api/announcements/${annId}/acknowledge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error || 'Не удалось зафиксировать ознакомление. Повторите попытку.');
        return;
      }
      await loadAnnouncements();
      // Гасим отметку на значке «Важное»: без этого она висела до перезапуска.
      onAcknowledged?.();
    } catch {
      setActionError('Нет связи с сервером — ознакомление не зафиксировано.');
    } finally {
      setAckBusyId(null);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    // Двойной щелчок публиковал одно распоряжение дважды — и каждому
    // сотруднику приходилось подтверждать оба.
    if (!newTitle.trim() || !newContent.trim() || creating) return;

    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch(`${serverUrl}/api/announcements`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          title: newTitle.trim(),
          content: newContent.trim(),
          priority: newPriority,
          target_type: 'all'
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Ошибку показываем в самом окне: баннер страницы оно закрывает.
        setCreateError(data.error || 'Не удалось опубликовать объявление');
        return;
      }
      setShowCreateModal(false);
      setNewTitle('');
      setNewContent('');
      await loadAnnouncements();
    } catch {
      setCreateError('Нет связи с сервером — объявление не опубликовано.');
    } finally {
      setCreating(false);
    }
  };

  const closeCreateModal = () => {
    if (creating) return;
    setShowCreateModal(false);
    setCreateError('');
  };

  return (
    <div className="announcements-container">
      {actionError && (
        <div className="announcements-error-banner" role="alert">
          <Icon name="alert" size={16} />
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError('')} aria-label="Закрыть"><Icon name="x" size={14} /></button>
        </div>
      )}

      {/* 1. Left Sidebar: Announcements Master List */}
      <div className="announcements-sidebar">
        <div className="announcements-sidebar-header">
          <div className="announcements-sidebar-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: "light-dark(#d97706, #f4bc7b)" }} strokeWidth="2" strokeLinecap="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
            <span>Оповещения</span>
            <span className="count-badge">{announcements.length}</span>
          </div>

          {canCreate && (
            <button
              className="btn btn-primary"
              style={{ padding: '4px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
              onClick={() => setShowCreateModal(true)}
              title="Создать новое корпоративное оповещение (для руководства)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Создать
            </button>
          )}
        </div>

        <div className="announcements-list">
          {announcements.length === 0 ? (
            <div style={{ padding: '30px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '12px' }}>
              {loading ? 'Загрузка служебных оповещений...' : 'Нет активных оповещений'}
            </div>
          ) : (
            announcements.map((a) => {
              const isSelected = selectedAnn?.id === a.id;
              const isConfirmed = a.is_confirmed === 1;
              return (
                <div
                  key={a.id}
                  className={`announcement-card-item ${isSelected ? 'active' : ''}`}
                  onClick={() => selectAnnouncement(a)}
                >
                  <div className="announcement-card-top">
                    <span className={`announcement-priority-badge ${a.priority === 'urgent' ? 'urgent' : 'normal'}`}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Icon name={a.priority === 'urgent' ? 'flame' : 'megaphone'} size={12} />
                        {a.priority === 'urgent' ? 'Срочно' : 'Оповещение'}
                      </span>
                    </span>
                    <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                      {new Date(a.created_at).toLocaleDateString()}
                    </span>
                  </div>

                  <div className="announcement-card-title">
                    {a.title}
                  </div>

                  <div className="announcement-card-author">
                    От: {a.author_name} {a.author_job_title ? `(${a.author_job_title})` : ''}
                  </div>

                  <div className={`announcement-card-status ${isConfirmed ? 'confirmed' : 'pending'}`}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Icon name={isConfirmed ? 'check' : 'clock'} size={12} />
                      {isConfirmed ? 'Вы ознакомлены' : 'Требует подтверждения'}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 2. Right Detail Pane: Document View & Audit Receipt */}
      <div className="announcements-detail-pane">
        {selectedAnn ? (
          <div className="announcement-detail-doc">
            {/* Header */}
            <div className="announcement-doc-header">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span className={`announcement-priority-badge ${selectedAnn.priority === 'urgent' ? 'urgent' : 'normal'}`}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon name={selectedAnn.priority === 'urgent' ? 'flame' : 'megaphone'} size={12} />
                    {selectedAnn.priority === 'urgent' ? 'Срочный приказ' : 'Служебное оповещение'}
                  </span>
                </span>
                <span style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)' }}>
                  Опубликовано: {new Date(selectedAnn.created_at).toLocaleString()}
                </span>
              </div>

              <div className="announcement-doc-title">
                {selectedAnn.title}
              </div>

              <div className="announcement-doc-meta">
                <span>
                  Инициатор: <strong>{selectedAnn.author_name}</strong> {selectedAnn.author_job_title ? `(${selectedAnn.author_job_title})` : ''}
                </span>
                <span>•</span>
                <span>Адресаты: <strong>Все сотрудники компании</strong></span>
              </div>
            </div>

            {/* Document Text Body */}
            <div className="announcement-doc-body">
              {selectedAnn.content}
            </div>

            {/* Obligatory Confirmation Box */}
            <div className={`announcement-confirm-box ${selectedAnn.is_confirmed === 1 ? 'confirmed' : 'pending'}`}>
              <div>
                <div style={{
                  fontWeight: 700,
                  fontSize: '14px',
                  color: selectedAnn.is_confirmed === 1 ? '#15803d' : '#b45309',
                  marginBottom: '2px'
                }}>
                  {selectedAnn.is_confirmed === 1
                    ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="circleCheck" size={16} />Вы подтвердили ознакомление со служебным распоряжением</span>
                    : 'Обязательное подтверждение ознакомления'}
                </div>
                <div style={{ fontSize: '12px', color: 'light-dark(#64748b, #a9aeb5)' }}>
                  {selectedAnn.is_confirmed === 1
                    ? `Отметка зафиксирована в реестре аудита: ${new Date(selectedAnn.confirmed_at || Date.now()).toLocaleString()}`
                    : 'Нажимая кнопку, вы подтверждаете факт прочтения и принятия условий распоряжения.'}
                </div>
              </div>

              {selectedAnn.is_confirmed !== 1 && (
                <button
                  className="btn btn-primary"
                  style={{ padding: '8px 18px', fontSize: '13px', whiteSpace: 'nowrap', fontWeight: 600 }}
                  onClick={() => handleAcknowledge(selectedAnn.id)}
                  disabled={Boolean(ackBusyId)}
                >
                  {ackBusyId === selectedAnn.id ? 'Фиксируем…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="check" size={14} />Я ознакомлен(а)</span>}
                </button>
              )}
            </div>

            {/* Audit statistics table (for Administrator only) */}
            {canSeeAudit(selectedAnn) && auditData?.stats && (
              <div style={{
                backgroundColor: 'light-dark(#f8fafc, #313338)',
                border: '1px solid light-dark(#cbd5e1, rgba(126, 151, 180, 0.38))',
                borderRadius: '8px',
                padding: '18px 20px',
                marginTop: '10px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'light-dark(#0f172a, #96aad9)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="chart" size={18} />
                    Реестр ознакомления сотрудников (Контроль исполнения)
                  </h4>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'light-dark(#1d4ed8, #819eee)', background: 'light-dark(#eff6ff, rgba(62, 137, 234, 0.16))', padding: '3px 8px', borderRadius: '4px' }}>
                    Подтвердили: {auditData.stats.confirmedCount} из {auditData.stats.total} ({auditData.stats.percentage}%)
                  </div>
                </div>

                <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid light-dark(#e2e8f0, rgba(121, 148, 185, 0.38))', borderRadius: '6px', background: 'light-dark(#ffffff, #2c2e33)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ background: 'light-dark(#f1f5f9, rgba(105, 148, 191, 0.16))', borderBottom: '1px solid light-dark(#cbd5e1, rgba(126, 151, 180, 0.38))', color: 'light-dark(#475569, #d3d6db)', textAlign: 'left' }}>
                        <th style={{ padding: '8px 12px' }}>Сотрудник</th>
                        <th style={{ padding: '8px 12px' }}>Подразделение</th>
                        <th style={{ padding: '8px 12px' }}>Статус</th>
                        <th style={{ padding: '8px 12px' }}>Время фиксации</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Array.isArray(auditData.recipients) ? auditData.recipients : []).map((r) => (
                        <tr key={r.id} style={{ borderBottom: '1px solid light-dark(#f1f5f9, rgba(112, 153, 194, 0.38))' }}>
                          <td style={{ padding: '7px 12px', fontWeight: 600, color: 'light-dark(#1e293b, #a0b2cf)' }}>{r.full_name}</td>
                          <td style={{ padding: '7px 12px', color: 'light-dark(#64748b, #a9aeb5)' }}>{r.department_name || '—'}</td>
                          <td style={{ padding: '7px 12px' }}>
                            {r.is_confirmed === 1 ? (
                              <span style={{ color: 'light-dark(#15803d, #84ebab)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="check" size={13} />Ознакомлен</span>
                            ) : (
                              <span style={{ color: 'light-dark(#b91c1c, #ec8383)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="clock" size={13} />Не прочитано</span>
                            )}
                          </td>
                          <td style={{ padding: '7px 12px', color: 'light-dark(#64748b, #a9aeb5)', fontSize: '11px' }}>
                            {r.confirmed_at ? new Date(r.confirmed_at).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="announcement-empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            <h3>Корпоративные оповещения и приказы</h3>
            <p>Выберите служебное распоряжение из списка слева для прочтения и подтверждения ознакомления.</p>
          </div>
        )}
      </div>

      {/* Create Announcement Modal (Admin Only) */}
      {showCreateModal && canCreate && (
        <div className="modal-backdrop" onClick={closeCreateModal}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-header">
              <span style={{ fontWeight: 700, fontSize: '15px' }}>Создать служебное оповещение</span>
              <button className="btn-close-modal" onClick={closeCreateModal} disabled={creating} aria-label="Закрыть"><Icon name="x" size={16} /></button>
            </div>
            <form onSubmit={handleCreate} style={{ padding: '20px' }}>
              {createError && (
                <div className="app-dialog-error" role="alert" style={{ marginBottom: '14px' }}>
                  {createError}
                </div>
              )}
              <div className="form-group" style={{ marginBottom: '14px' }}>
                <label className="form-label">Тема / Название приказа *:</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="например, Приказ №14/26 О графике работы в праздничные дни"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              <div className="form-group" style={{ marginBottom: '14px' }}>
                <label className="form-label">Уровень приоритета:</label>
                <select
                  className="form-input"
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                >
                  <option value="urgent">Срочный (с обязательным подтверждением)</option>
                  <option value="normal">Информационный</option>
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: '20px' }}>
                <label className="form-label">Текст распоряжения *:</label>
                <textarea
                  className="form-input"
                  rows={6}
                  placeholder="Введите официальный текст для всех сотрудников компании..."
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button type="button" className="btn btn-secondary" onClick={closeCreateModal} disabled={creating}>
                  Отмена
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating || !newTitle.trim() || !newContent.trim()}>
                  {creating ? 'Публикуем…' : 'Опубликовать'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
