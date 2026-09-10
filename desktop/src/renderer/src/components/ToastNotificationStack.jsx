import React, { useEffect } from 'react';

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
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss();
    }, 6000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const isUrgent = toast.isUrgent || toast.type === 'rd';
  const isAnnouncement = toast.type === 'announcement';
  const kind = isUrgent ? 'urgent' : isAnnouncement ? 'announcement' : 'chat';

  return (
    <div className={`toast-card ${kind}`} onClick={onAction}>
      <span className="toast-accent" />

      <span className="toast-avatar">
        {toast.icon || toast.avatarText || (isUrgent ? '🖥️' : isAnnouncement ? '📢' : '💬')}
      </span>

      <div className="toast-body">
        <div className="toast-head">
          <span className="toast-title">{toast.title || 'Новое уведомление'}</span>
          <span className="toast-tag">
            {isUrgent ? 'Срочно' : isAnnouncement ? 'Оповещение' : 'MyChat'}
          </span>
        </div>
        <p className="toast-text">{toast.body || ''}</p>
        <div className="toast-foot">
          <span className="toast-action">Нажмите, чтобы открыть →</span>
        </div>
      </div>

      <button
        type="button"
        className="toast-close"
        title="Закрыть"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
      >
        ✕
      </button>

      <span className="toast-progress" />
    </div>
  );
}
