import React from 'react';
import Icon from './Icon';

const SYSTEM_LABELS = {
  online: 'В сети',
  away: 'Отошёл',
  offline: 'Не в сети'
};

// Свой статус в строке состояния. Системная часть только показывается —
// её определяют активность за компьютером и соединение; переключается лишь
// «Не беспокоить». Режим виден по самому переключателю, поэтому рядом
// остаётся системный статус, а не второе «Не беспокоить».
export default function PresenceControl({ status, connected, onToggleDnd }) {
  const dnd = status === 'dnd';
  const system = !connected ? 'offline' : status === 'away' ? 'away' : 'online';
  const systemHint = !connected
    ? 'Нет связи с сервером — коллеги видят вас «не в сети»'
    : dnd
    ? 'Коллеги видят «Не беспокоить». Статус под ним определяется автоматически'
    : system === 'away'
    ? 'Компьютер простаивает или заблокирован — статус сменится сам, когда вы вернётесь'
    : 'Статус определяется автоматически по активности за компьютером';

  return (
    <div className="presence-control">
      <span className={`presence-system is-${system}`} title={systemHint}>
        <span className="presence-dot" aria-hidden="true" />
        <span className="presence-label">{SYSTEM_LABELS[system]}</span>
        <span className="presence-auto">авто</span>
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={dnd}
        className={`dnd-switch${dnd ? ' is-on' : ''}`}
        disabled={!connected}
        onClick={() => onToggleDnd(!dnd)}
        title={
          dnd
            ? 'Выключить «Не беспокоить»: уведомления и побудки снова будут приходить'
            : 'Включить «Не беспокоить»: без звука уведомлений, побудки не срабатывают'
        }
      >
        <Icon name="moon" size={13} />
        <span className="dnd-switch-label">Не беспокоить</span>
        <span className="dnd-switch-track" aria-hidden="true">
          <span className="dnd-switch-thumb" />
        </span>
      </button>
    </div>
  );
}
