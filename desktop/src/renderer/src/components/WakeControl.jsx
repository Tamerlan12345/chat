import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { WAKE_MINUTES, formatCountdown, minutesLabel, wakeView } from '../lib/wake.mjs';

const OUTCOME_TEXT = {
  delivered: { title: 'Сигнал доставлен', tone: 'success', icon: 'circleCheck' },
  offline: { title: 'Собеседник не в сети', tone: 'warning', icon: 'alert' },
  dnd: { title: 'Включено «Не беспокоить»', tone: 'warning', icon: 'moon' }
};

// Тикает раз в 250 мс, пока есть что отсчитывать, — иначе молчит.
function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// Кнопка «Разбудить» в шапке личного чата и панель выбора под ней.
export default function WakeControl({ peer, entry, connected, onSchedule, onCancel }) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(5);
  const rootRef = useRef(null);

  const needsClock = entry && entry.phase !== 'idle';
  const now = useNow(open || needsClock);
  const view = wakeView(entry, now);
  const peerDnd = peer?.status === 'dnd';
  const peerOffline = !peer?.status || peer.status === 'offline';
  const firstName = String(peer?.full_name || peer?.username || 'собеседника').split(/\s+/).slice(0, 2).join(' ');

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const outcome = view.phase === 'result' ? OUTCOME_TEXT[view.outcome] || OUTCOME_TEXT.delivered : null;
  const canSchedule = connected && !peerDnd && view.phase === 'idle';

  let trigger;
  if (view.phase === 'scheduled') {
    trigger = (
      <button
        type="button"
        className="wake-trigger is-counting"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Побудка через ${formatCountdown(view.remaining)}`}
        style={{ '--wake-progress': view.progress }}
      >
        <Icon name="alarm" size={15} />
        <span className="wake-trigger-time">{formatCountdown(view.remaining)}</span>
      </button>
    );
  } else if (view.phase === 'result') {
    trigger = (
      <button
        type="button"
        className={`wake-trigger is-result tone-${outcome.tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={outcome.title}
      >
        <Icon name={outcome.icon} size={15} />
        {view.retryIn > 0 && <span className="wake-trigger-time">{formatCountdown(view.retryIn)}</span>}
      </button>
    );
  } else {
    trigger = (
      <button
        type="button"
        className={`classic-action-icon-btn wake-trigger${view.phase === 'cooldown' ? ' is-cooldown' : ''}${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={peerDnd ? 'У собеседника «Не беспокоить» — разбудить нельзя' : 'Разбудить собеседника'}
      >
        <Icon name="alarm" size={15} />
      </button>
    );
  }

  return (
    <div className="wake-control" ref={rootRef}>
      {trigger}

      {open && (
        <div className="wake-panel" role="dialog" aria-label="Разбудить собеседника">
          <div className="wake-panel-head">
            {/* Имя отдельной строкой: склонять ФИО вслепую — значит писать
                «Разбудить Иванов Иван». */}
            <div className="wake-panel-heading">
              <span className="wake-panel-title">Разбудить собеседника</span>
              <span className="wake-panel-peer">{firstName}</span>
            </div>
            <button type="button" className="wake-panel-close" onClick={() => setOpen(false)} aria-label="Закрыть">
              <Icon name="x" size={14} />
            </button>
          </div>

          {view.phase === 'scheduled' && (
            <div className="wake-countdown">
              <div className="wake-countdown-time" aria-live="off">{formatCountdown(view.remaining)}</div>
              <div className="wake-countdown-caption">
                до сигнала · поставлено на {minutesLabel(view.minutes)}
              </div>
              <div className="wake-progress" aria-hidden="true">
                <span style={{ transform: `scaleX(${view.progress})` }} />
              </div>
              <button type="button" className="btn btn-secondary btn-block wake-cancel" onClick={() => onCancel(peer.id)}>
                Отменить побудку
              </button>
            </div>
          )}

          {view.phase === 'result' && (
            <div className={`wake-outcome tone-${outcome.tone}`}>
              <div className="wake-outcome-row">
                <Icon name={outcome.icon} size={18} />
                <div>
                  <div className="wake-outcome-title">{outcome.title}</div>
                  <div className="wake-outcome-text">
                    {view.outcome === 'delivered'
                      ? `В ${new Date(view.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} у собеседника прозвучал сигнал.`
                      : view.outcome === 'dnd'
                      ? 'Сигнал не прозвучал: собеседник включил «Не беспокоить».'
                      : 'Сигнал не прозвучал: к этому времени собеседник вышел из сети.'}
                  </div>
                </div>
              </div>
              {view.retryIn > 0 && (
                <div className="wake-retry">Снова можно через <strong>{formatCountdown(view.retryIn)}</strong></div>
              )}
            </div>
          )}

          {(view.phase === 'idle' || view.phase === 'cooldown') && (
            <>
              <p className="wake-panel-text">
                Через выбранное время у собеседника прозвучит сигнал и замигает окно MyChat.
              </p>

              <div className="wake-minutes" role="radiogroup" aria-label="Через сколько минут">
                {WAKE_MINUTES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={minutes === m}
                    className={`wake-minute${minutes === m ? ' is-selected' : ''}`}
                    onClick={() => setMinutes(m)}
                  >
                    {m}
                  </button>
                ))}
                <span className="wake-minutes-unit">мин</span>
              </div>

              {peerDnd ? (
                <div className="wake-note tone-warning">
                  <Icon name="moon" size={14} />
                  <span>У собеседника включено «Не беспокоить» — побудка не сработает.</span>
                </div>
              ) : peerOffline ? (
                <div className="wake-note">
                  <Icon name="info" size={14} />
                  <span>Сейчас не в сети. Сигнал прозвучит, только если к этому времени появится.</span>
                </div>
              ) : null}
              {view.error && !peerDnd && (
                <div className="wake-note tone-danger" role="alert">
                  <Icon name="alert" size={14} />
                  <span>{view.error}</span>
                </div>
              )}

              <button
                type="button"
                className="btn btn-primary btn-block wake-submit"
                disabled={!canSchedule}
                onClick={() => onSchedule(peer.id, minutes)}
              >
                {view.phase === 'cooldown'
                  ? `Снова можно через ${formatCountdown(view.retryIn)}`
                  : `Разбудить через ${minutesLabel(minutes)}`}
              </button>
              <div className="wake-panel-foot">Не чаще раза в минуту</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
