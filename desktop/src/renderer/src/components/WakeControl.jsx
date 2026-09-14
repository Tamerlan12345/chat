import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { formatCountdown, wakeView } from '../lib/wake.mjs';

// Тикает, пока идёт пауза или видна ошибка, — иначе молчит.
function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const RING = 2 * Math.PI * 9;

// Кольцо вокруг значка: заполняется, пока идёт минута паузы. Цифры рядом
// говорят «сколько», кольцо — «сколько из минуты», не читая.
function CooldownRing({ progress }) {
  return (
    <svg className="wake-ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle className="wake-ring-track" cx="11" cy="11" r="9" />
      <circle
        className="wake-ring-fill"
        cx="11"
        cy="11"
        r="9"
        strokeDasharray={RING}
        strokeDashoffset={RING * (1 - progress)}
      />
    </svg>
  );
}

// «Разбудить» в шапке личного чата. Одно нажатие — сигнал уходит сразу;
// следующий можно не раньше чем через минуту, кого бы ни будили.
export default function WakeControl({ peer, wake, connected, onWake }) {
  const ticking = (wake?.retryAt || 0) > Date.now() || (wake?.error && Date.now() - wake.error.at < 6500);
  const view = wakeView(wake, peer?.id, useNow(Boolean(ticking)));

  const peerDnd = peer?.status === 'dnd';
  const peerOffline = !peer?.status || peer.status === 'offline';

  let state = 'ready';
  let label = 'Разбудить';
  let hint = 'Разбудить собеседника: у него прозвучит сигнал и замигает окно MyChat. Не чаще раза в минуту.';
  let icon = 'alarm';

  if (view.phase === 'sending') {
    state = 'sending';
    label = 'Будим…';
    hint = 'Отправляем сигнал';
  } else if (view.phase === 'sent') {
    state = 'sent';
    icon = 'check';
    label = formatCountdown(view.retryIn);
    const time = new Date(view.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    hint = `Сигнал отправлен в ${time}. Снова можно через ${formatCountdown(view.retryIn)}.`;
  } else if (view.phase === 'cooldown') {
    state = 'cooldown';
    label = formatCountdown(view.retryIn);
    hint = `Вы уже будили коллегу. Снова можно через ${formatCountdown(view.retryIn)}.`;
  } else if (!connected) {
    state = 'blocked';
    hint = 'Нет связи с сервером';
  } else if (peerDnd) {
    state = 'blocked';
    icon = 'moon';
    hint = 'У собеседника «Не беспокоить» — будить нельзя';
  } else if (peerOffline) {
    state = 'blocked';
    hint = 'Собеседник не в сети — сигнал некому услышать';
  }

  const counting = state === 'sent' || state === 'cooldown';
  const disabled = state !== 'ready';

  return (
    <div className="wake-control">
      <button
        type="button"
        className={`wake-btn is-${state}`}
        onClick={() => onWake(peer.id)}
        disabled={disabled}
        aria-disabled={disabled}
        aria-busy={state === 'sending'}
        aria-label={counting ? `Разбудить: снова можно через ${formatCountdown(view.retryIn)}` : 'Разбудить собеседника'}
        title={hint}
      >
        <span className="wake-btn-icon">
          {counting && <CooldownRing progress={view.progress} />}
          <Icon name={icon} size={counting ? 12 : 15} strokeWidth={counting ? 2.2 : 1.9} />
        </span>
        <span className={`wake-btn-label${counting ? ' is-time' : ''}`}>{label}</span>
      </button>

      {/* Отказ сервера (собеседник только что вышел или включил «Не беспокоить»)
          — коротко и рядом с кнопкой, а не во всплывающем углу. */}
      {view.error && (
        <div className="wake-bubble" role="status">
          <Icon name={view.error.code === 'dnd' ? 'moon' : 'info'} size={13} />
          <span>{view.error.message}</span>
        </div>
      )}
    </div>
  );
}
