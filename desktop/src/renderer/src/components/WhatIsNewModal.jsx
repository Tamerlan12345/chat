import React from 'react';

export default function WhatIsNewModal({ onClose, serverInfo }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog whatisnew-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '24px' }}>💬</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: '16px', color: '#a0b2cf' }}>
                OpenMyChat Enterprise Client
              </div>
              <div style={{ fontSize: '11px', color: '#a9aeb5' }}>
                {serverInfo?.company_name || 'Корпоративная сеть'} • Версия 2026.3.1 (LTS)
              </div>
            </div>
          </div>
          <button className="btn-close-modal" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ maxHeight: '460px', overflowY: 'auto', padding: '20px' }}>
          <div className="feature-card">
            <div className="feature-icon">💬</div>
            <div>
              <div className="feature-title">Строго корпоративный чат коллег</div>
              <div className="feature-desc">
                Мгновенный обмен сообщениями один-на-один и в тематических каналах отделов. Поддержка передачи любых документов, изображений и цитирования.
              </div>
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon">👥</div>
            <div>
              <div className="feature-title">Иерархическая оргструктура компании</div>
              <div className="feature-desc">
                Наглядное дерево отделов компании, быстрый поиск по ФИО, должности и внутреннему телефонному номеру. Индикаторы присутствия сотрудников в реальном времени.
              </div>
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon">📢</div>
            <div>
              <div className="feature-title">Важные оповещения с подтверждением</div>
              <div className="feature-desc">
                Приказы и директивы руководства, требующие нажатия кнопки «Ознакомлен». Полный протокол с фиксацией времени и IP-адреса для аудита.
              </div>
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon">📞</div>
            <div>
              <div className="feature-title">Прямая аудио/видеосвязь (WebRTC P2P)</div>
              <div className="feature-desc">
                Звонки между компьютерами сотрудников внутри локальной сети предприятия без выхода во внешние облачные сервисы.
              </div>
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon">🖥️</div>
            <div>
              <div className="feature-title">Удаленная помощь и демонстрация экрана</div>
              <div className="feature-desc">
                Возможность подключения специалистов ИТ к экрану сотрудника в отдельном плавающем окне для решения технических вопросов.
              </div>
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon">🔒</div>
            <div>
              <div className="feature-title">100% Автономность (On-Premise)</div>
              <div className="feature-desc">
                База данных SQLite в режиме WAL хранится локально на вашем сервере. Нулевая зависимость от внешнего интернета и сторонних облаков.
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid rgba(121, 148, 185, 0.38)' }}>
          <button className="btn btn-primary" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
