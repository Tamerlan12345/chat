import React, { useEffect, useRef, useState } from 'react';

// Установка: этого экрана нет в коде приложения, поэтому он собран здесь
// отдельными компонентами по тому, что реально делают установщик и скрипты.

const FILES = [
  ['CentyChat-Setup-1.1.0.exe', '96,4 МБ', 'Обычный установщик для Windows'],
  ['CentyChat-Portable-1.1.0.exe', '98,1 МБ', 'Версия без установки, запускается из папки']
];

export function Installer() {
  const [stage, setStage] = useState(0); // 0 папка, 2 мастер, 3 установка, 4 готово
  const [progress, setProgress] = useState(0);
  const timers = useRef([]);

  useEffect(() => {
    const push = (fn, ms) => timers.current.push(setTimeout(fn, ms));
    let t = 1800;
    push(() => setStage(2), t);
    t += 2800; push(() => setStage(3), t);
    const start = t;
    for (let p = 0; p <= 100; p += 2) push(() => setProgress(p), start + p * 38);
    t = start + 100 * 38 + 700;
    push(() => setStage(4), t);
    return () => timers.current.forEach(clearTimeout);
  }, []);

  return (
    <div className="install">
      <section className={'ins-card folder' + (stage >= 1 ? ' done' : ' now')}>
        <header>Общая папка ИТ · \\fileserver\it\CentyChat</header>
        <table className="files">
          <tbody>
            {FILES.map(([name, size, note]) => (
              <tr key={name} className={name.includes('Setup') ? 'pick' : ''}>
                <td className="fn">{name}</td>
                <td className="fs">{size}</td>
                <td className="fd">{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer>Сотруднику дают ссылку на папку, либо ИТ ставит приложение централизованно</footer>
      </section>

      <section className={'ins-card wizard' + (stage >= 4 ? ' done' : stage >= 2 ? ' now' : '')}>
        <header>Установка CentyChat</header>
        {stage < 3 ? (
          <div className="wiz-body">
            <div className="wiz-title">Папка установки</div>
            <div className="wiz-path">C:\Users\a.saparova\AppData\Local\Programs\CentyChat</div>
            <label className="wiz-check"><input type="checkbox" defaultChecked readOnly /> Создать ярлык на рабочем столе</label>
            <label className="wiz-check"><input type="checkbox" defaultChecked readOnly /> Запускать вместе с Windows</label>
            <div className="wiz-actions"><span className="btn-ghost">Отмена</span><span className={'btn-main' + (stage === 2 ? ' press' : '')}>Установить</span></div>
            <div className="wiz-note">Права администратора не нужны: приложение ставится в профиль сотрудника</div>
          </div>
        ) : (
          <div className="wiz-body">
            <div className="wiz-title">{stage >= 4 ? 'Установка завершена' : 'Копирование файлов'}</div>
            <div className="wiz-bar"><i style={{ width: progress + '%' }} /></div>
            <div className="wiz-progress">{stage >= 4 ? 'Готово' : progress + '%'} · CentyChat.exe</div>
            {stage >= 4 ? (
              <ul className="wiz-done">
                <li>Ярлык на рабочем столе и в меню «Пуск»</li>
                <li>Запуск вместе с Windows: окно не открывается, приложение ждет в трее</li>
                <li>Адрес сервера задается один раз: меню «CentyChat» → «Сетевой сервер...»</li>
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <section className={'ins-card tray' + (stage >= 4 ? ' now' : '')}>
        <div className="taskbar">
          <span className="tb-start">⊞</span>
          <span className="tb-app">CentyChat</span>
          <span className="tb-space" />
          <span className={'tb-tray' + (stage >= 4 ? ' live' : '')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          </span>
          <span className="tb-clock">08:57</span>
        </div>
        {stage >= 4 ? (
          <div className="tray-pop">
            <b>CentyChat</b>
            <span>Приложение запущено и ждет в трее. Значок открывает окно, там же «Запускать при входе в Windows» и «Не беспокоить».</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
