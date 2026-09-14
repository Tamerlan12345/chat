import React from 'react';
import { greetingName } from '../lib/avatar.mjs';

export default function GreetingView({
  currentUser,
  serverInfo,
  onOpenWhatIsNew,
  onOpenProfile,
  onSwitchAccount
}) {
  // No invented fallbacks: these used to name a specific employee, so a user
  // whose profile was incomplete was greeted as somebody else.
  //
  // ФИО хранится как «Фамилия Имя Отчество»: первое слово — фамилия, и
  // сотрудника приветствовали «Добрый день, Иванов!». Запись из одного слова
  // (например, «Администратор») остаётся как есть, а служебная запись
  // «Администратор системы» — целиком, а не «Доброе утро, системы!».
  const firstName = greetingName(currentUser?.full_name);
  const username = currentUser?.username || '';
  const uin = currentUser?.uin || '';

  // Determine greeting based on time of day
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  return (
    <div className="greeting-screen">
      <div className="greeting-wrapper">
        <h1 className="greeting-heading">
          {firstName ? `${timeGreeting}, ${firstName}!` : `${timeGreeting}!`}
        </h1>

        {/* Vector Illustration matching Screenshot 1 */}
        <div className="greeting-illustration-box">
          <svg width="240" height="150" viewBox="0 0 260 160" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* Background circular gradient / halo */}
            <circle cx="130" cy="80" r="65" fill="#e0e7ff" opacity="0.6" />
            
            {/* Desktop Monitor Screen */}
            <rect x="50" y="42" width="105" height="70" rx="6" fill="#2563eb" />
            <rect x="55" y="47" width="95" height="52" rx="3" fill="#ffffff" />
            <circle cx="85" cy="72" r="14" fill="#fee2e2" />
            <path d="M80 72 L83 75 L91 67" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="120" cy="72" r="14" fill="#fef3c7" />
            <path d="M115 72 L118 75 L126 67" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            
            {/* Monitor Stand */}
            <rect x="95" y="112" width="15" height="14" fill="#cbd5e1" />
            <rect x="80" y="126" width="45" height="4" rx="2" fill="#94a3b8" />

            {/* Smartphone */}
            <rect x="160" y="65" width="34" height="60" rx="5" fill="#1e40af" />
            <rect x="163" y="70" width="28" height="46" rx="2" fill="#ffffff" />
            <circle cx="177" cy="90" r="10" fill="#fee2e2" />
            <path d="M174 90 L176 92 L181 87" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="177" cy="120" r="2" fill="#cbd5e1" />

            {/* Pie Chart floating on top */}
            <circle cx="140" cy="42" r="26" fill="#f87171" />
            <path d="M140 42 L140 16 A26 26 0 0 1 166 42 Z" fill="#38bdf8" />
            <path d="M140 42 L166 42 A26 26 0 0 1 140 68 Z" fill="#fbbf24" />
            <circle cx="140" cy="42" r="12" fill="#ffffff" />

            {/* Sitting working person outline */}
            <path d="M136 126 C136 110 148 98 160 102 C168 104 172 115 174 126 Z" fill="#3b82f6" opacity="0.85" />
            <circle cx="152" cy="92" r="7" fill="#fca5a5" />
          </svg>
        </div>

        {/* Action Links & Guidelines matching Screenshot 1 */}
        <div className="greeting-links-section">
          <div className="greeting-link-row">
            <button className="greeting-text-link" onClick={onOpenWhatIsNew}>
              Что нового в MyChat?
            </button>
          </div>

          <div className="greeting-instruction">
            Откройте «Контакты», «Чаты» либо «Каналы»,<br />
            чтобы отправить сообщение, документ или позвонить.
          </div>

          <div className="greeting-link-row" style={{ marginTop: '16px' }}>
            <button className="greeting-text-link profile-link" onClick={onOpenProfile}>
              Мой профиль
            </button>
          </div>

          <div className="greeting-user-info">
            Вы вошли как <strong>{username}</strong> (uin {uin})
          </div>

          <div className="greeting-link-row" style={{ marginTop: '14px' }}>
            <button className="greeting-text-link switch-link" onClick={onSwitchAccount}>
              Переключите учётную запись
            </button>
            <span className="greeting-switch-desc">, если не видите свои контакты или журнал бесед.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
