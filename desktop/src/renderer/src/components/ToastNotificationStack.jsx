import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import Icon from './Icon';
import { toastTarget } from '../lib/live-events.mjs';

// Crystal-clear corporate notification chime using Web Audio API synthesis
export function playNotificationSound(isUrgent = false) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (isUrgent) {
      // 2-tone urgent high alert
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'triangle';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(659.25, ctx.currentTime); // E5
      osc1.frequency.setValueAtTime(880, ctx.currentTime + 0.12); // A5
      osc2.frequency.setValueAtTime(329.63, ctx.currentTime);
      osc2.frequency.setValueAtTime(440, ctx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(ctx.currentTime);
      osc2.start(ctx.currentTime);
      osc1.stop(ctx.currentTime + 0.5);
      osc2.stop(ctx.currentTime + 0.5);
    } else {
      // Gentle melodic corporate double chime (C5 -> G5)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.12); // G5

      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    }
    // Каждый звук создавал AudioContext и не закрывал его. Браузер держит их
    // ограниченное число, и после нескольких десятков сообщений звук пропадал.
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch (err) {
    // Audio context may be restricted before user gesture
  }
}

export default function ToastNotificationStack({ toasts, onDismiss, onAction }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={() => onDismiss(toast.id)}
          onAction={() => {
            onAction(toast);
            onDismiss(toast.id);
          }}
        />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss, onAction }) {
  // Функция закрытия приходит новой при каждой перерисовке. Когда она стояла в
  // зависимостях таймера, любое событие — «печатает», смена статуса — заново
  // запускало отсчёт, и уведомления в оживлённое время не исчезали вовсе.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const timerRef = useRef(null);
  const [paused, setPaused] = useState(false);
  // Предупреждения об ошибках держатся дольше: их нужно успеть прочитать.
  const lifetimeMs = toast.type === 'system' || toast.isUrgent ? 9000 : 6000;

  const startTimer = () => {
    clearTimeout(timerRef.current);
    setPaused(false);
    timerRef.current = setTimeout(() => dismissRef.current(), lifetimeMs);
  };

  useEffect(() => {
    startTimer();
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  const isUrgent = toast.isUrgent || toast.type === 'rd';
  const isAnnouncement = toast.type === 'announcement';
  const kind = isUrgent ? 'urgent' : isAnnouncement ? 'announcement' : 'chat';
  // «Нажмите, чтобы открыть» — только когда открывать есть что.
  const hasTarget = Boolean(toastTarget(toast.data) || isAnnouncement);

  return (
    <div
      className={`toast-card ${kind}${hasTarget ? ' has-target' : ''}`}
      role={isUrgent ? 'alert' : 'status'}
      onClick={hasTarget ? onAction : onDismiss}
      title={hasTarget ? 'Открыть' : undefined}
      // Пока человек читает — не убирать из-под курсора.
      onMouseEnter={() => { clearTimeout(timerRef.current); setPaused(true); }}
      onMouseLeave={startTimer}
    >
      {kind === 'chat' && toast.type === 'chat' && toast.title ? (
        <Avatar name={toast.title} size={32} />
      ) : (
        <span className="toast-avatar">
          <Icon
            name={toast.type === 'wake' ? 'alarm' : isUrgent ? 'monitor' : isAnnouncement ? 'megaphone' : toast.type === 'channel' ? 'hash' : toast.type === 'system' ? 'info' : 'message'}
            size={16}
          />
        </span>
      )}

      <div className="toast-body">
        <div className="toast-head">
          <span className="toast-title">{toast.title || 'Новое уведомление'}</span>
          {/* Метка нужна только там, где она что-то сообщает: «CentyChat» на
              каждом сообщении внутри CentyChat — шум. */}
          {(isUrgent || isAnnouncement) && (
            <span className="toast-tag">{isUrgent ? 'Срочно' : 'Оповещение'}</span>
          )}
        </div>
        <p className="toast-text">{toast.body || ''}</p>
      </div>

      <button
        type="button"
        className="toast-close"
        title="Закрыть"
        aria-label="Закрыть уведомление"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
      >
        <Icon name="x" size={14} />
      </button>

      {/* Полоса показывает, сколько осталось, — поэтому идёт ровно столько же,
          сколько живёт уведомление, и стоит, пока на него навели курсор. Раньше
          она кончалась за 6 с даже у девятисекундных. */}
      <span
        key={paused ? 'paused' : 'running'}
        className="toast-progress"
        style={{ animationDuration: `${lifetimeMs}ms`, animationPlayState: paused ? 'paused' : 'running' }}
      />
    </div>
  );
}
