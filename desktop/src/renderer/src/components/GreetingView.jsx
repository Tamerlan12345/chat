import React from 'react';
import { greetingName } from '../lib/avatar.mjs';
import { BrandMark } from './BrandMark';

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
        {/* Знак приложения вместо картинки с компьютером и диаграммой: она
            была в чужих цветах и ничего не сообщала. */}
        <div className="greeting-illustration-box">
          <BrandMark size={64} />
        </div>

        <h1 className="greeting-heading">
          {firstName ? `${timeGreeting}, ${firstName}!` : `${timeGreeting}!`}
        </h1>

        {/* Action Links & Guidelines matching Screenshot 1 */}
        <div className="greeting-links-section">
          <div className="greeting-link-row">
            <button className="greeting-text-link" onClick={onOpenWhatIsNew}>
              Что нового в CentyChat?
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
