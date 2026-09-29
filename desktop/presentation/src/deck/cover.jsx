import React, { useEffect, useState } from 'react';

// Титульный лист.
const POINTS = [
  'Личные чаты, каналы, файлы и фото',
  'Голосовые звонки и «Разбудить»',
  'Приказы с подтверждением ознакомления',
  'Оргструктура, консоль, журнал аудита'
];

export function Cover() {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const timers = POINTS.map((_, i) => setTimeout(() => setShown(i + 1), 500 + i * 320));
    return () => timers.forEach(clearTimeout);
  }, []);
  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="cover">
      <div className="cover-main">
        <div className="cover-logo">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        </div>
        <div className="cover-kicker">Инициатива AI HUB · АО СК «Сентрас Иншуранс»</div>
        <h1>CentyChat</h1>
        <p className="cover-lead">
          Корпоративный мессенджер собственной разработки. Работает внутри контура компании,
          заменяет платный MyChat и развивается под наши задачи.
        </p>
        <ul className="cover-points">
          {POINTS.map((p, i) => (
            <li key={p} className={i < shown ? 'on' : ''}>{p}</li>
          ))}
        </ul>
        <div className="cover-foot">
          <span>{today}</span>
          <span className="cover-dot">·</span>
          <span>Показ живой: в презентацию встроено само приложение</span>
        </div>
      </div>
      <div className="cover-side">
        <div className="cover-card">
          <b>Как смотреть</b>
          <span>Листайте стрелками на экране или на клавиатуре. На каждом слайде сценарий проигрывается сам.</span>
        </div>
        <div className="cover-card">
          <b>Можно трогать</b>
          <span>В окнах работает настоящий клиент: пишите сообщения, открывайте разделы, звоните, подтверждайте приказ.</span>
        </div>
        <div className="cover-card">
          <b>Данные учебные</b>
          <span>Сотрудники и переписка вымышленные, сервер подставной и живет внутри этого файла.</span>
        </div>
      </div>
    </div>
  );
}
