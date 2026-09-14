import React, { useEffect, useRef } from 'react';
import Avatar from './Avatar';
import Icon from './Icon';
import { playNotificationSound } from './ToastNotificationStack';

const RING_EVERY_MS = 2200;
const RING_FOR_MS = 30000;

// Входящая побудка. Звенит, пока человек не отзовётся, но не дольше 30 секунд:
// сигнал должен разбудить, а не звенеть в пустом кабинете весь день.
export default function WakeAlert({ wake, onOpenChat, onDismiss }) {
  const primaryRef = useRef(null);

  useEffect(() => {
    primaryRef.current?.focus();
    playNotificationSound(true);
    const ring = setInterval(() => playNotificationSound(true), RING_EVERY_MS);
    const stop = setTimeout(() => clearInterval(ring), RING_FOR_MS);
    window.electronAPI?.focusWindow?.();
    window.electronAPI?.flashFrame?.(true);
    return () => {
      clearInterval(ring);
      clearTimeout(stop);
    };
  }, [wake.at]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const time = new Date(wake.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="modal-backdrop wake-alert-backdrop">
      <div className="wake-alert" role="alertdialog" aria-labelledby="wake-alert-title" aria-describedby="wake-alert-text">
        <div className="wake-alert-signal" aria-hidden="true">
          <Avatar name={wake.fromName} size={56} />
          <span className="wake-alert-badge">
            <Icon name="alarm" size={14} strokeWidth={2} />
          </span>
        </div>
        <div id="wake-alert-title" className="wake-alert-title">Вас будит {wake.fromName}</div>
        <div id="wake-alert-text" className="wake-alert-text">Сигнал в {time}. Коллега ждёт ответа.</div>
        <div className="wake-alert-actions">
          <button type="button" className="btn btn-secondary" onClick={onDismiss}>
            Я на месте
          </button>
          <button type="button" ref={primaryRef} className="btn btn-primary" onClick={onOpenChat}>
            Открыть переписку
          </button>
        </div>
      </div>
    </div>
  );
}
