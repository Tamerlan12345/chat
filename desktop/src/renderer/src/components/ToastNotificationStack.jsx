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
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col-reverse gap-3 pointer-events-none max-w-sm w-full">
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

  return (
    <div
      onClick={onAction}
      className={`pointer-events-auto cursor-pointer relative overflow-hidden flex items-start gap-3.5 p-4 rounded-xl shadow-2xl backdrop-blur-md transition-all duration-300 transform translate-x-0 hover:scale-[1.02] border ${
        isUrgent
          ? 'bg-rose-950/90 border-rose-500/60 shadow-rose-950/50 text-white'
          : isAnnouncement
          ? 'bg-amber-950/90 border-amber-500/60 shadow-amber-950/50 text-white'
          : 'bg-slate-900/95 border-sky-500/40 shadow-slate-950/80 text-white'
      }`}
      style={{
        animation: 'slideInRight 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards'
      }}
    >
      {/* Accent edge indicator */}
      <div
        className={`absolute left-0 top-0 bottom-0 w-1.5 ${
          isUrgent ? 'bg-rose-500' : isAnnouncement ? 'bg-amber-500' : 'bg-sky-400'
        }`}
      />

      {/* Avatar / Icon */}
      <div
        className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 shadow-md ${
          isUrgent
            ? 'bg-rose-600 text-white'
            : isAnnouncement
            ? 'bg-amber-600 text-white'
            : 'bg-gradient-to-tr from-sky-600 to-indigo-600 text-white'
        }`}
      >
        {toast.icon ? (
          toast.icon
        ) : toast.avatarText ? (
          toast.avatarText
        ) : isUrgent ? (
          '🖥️'
        ) : isAnnouncement ? (
          '📢'
        ) : (
          '💬'
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pr-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="font-semibold text-sm truncate text-slate-100">
            {toast.title || 'Новое уведомление'}
          </span>
          <span
            className={`text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded ${
              isUrgent
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                : isAnnouncement
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
            }`}
          >
            {isUrgent ? 'Срочно' : isAnnouncement ? 'Оповещение' : 'MyChat'}
          </span>
        </div>
        <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
          {toast.body || ''}
        </p>

        {/* Action Button Hint */}
        <div className="mt-2.5 flex items-center justify-between text-[11px]">
          <span className="text-sky-400 font-medium hover:underline flex items-center gap-1">
            Нажмите, чтобы открыть &rarr;
          </span>
          <span className="text-slate-400 text-[10px]">только что</span>
        </div>
      </div>

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="text-slate-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors"
        title="Закрыть"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Auto-dismiss progress bar */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/10">
        <div
          className={`h-full ${
            isUrgent ? 'bg-rose-500' : isAnnouncement ? 'bg-amber-500' : 'bg-sky-400'
          }`}
          style={{
            animation: 'shrinkWidth 6s linear forwards'
          }}
        />
      </div>
    </div>
  );
}
