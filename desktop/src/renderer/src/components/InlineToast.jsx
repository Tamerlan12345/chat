import React, { useCallback, useEffect, useRef, useState } from 'react';

// Уведомление внутри окна. Раньше любое сообщение было зелёным с галочкой —
// отказ сервера выглядел так же, как успех, и его не замечали. Ошибка висит
// дольше: её нужно успеть прочитать.
export function useInlineToast() {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  const show = useCallback((text, kind = 'success') => {
    // Прежний таймер гасил уже следующее сообщение раньше срока.
    clearTimeout(timerRef.current);
    setToast({ text, kind });
    timerRef.current = setTimeout(() => setToast(null), kind === 'error' ? 9000 : 4000);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const isError = toast?.kind === 'error';
  const element = toast ? (
    <div className={`admin-toast ${isError ? 'error' : 'success'}`} role={isError ? 'alert' : 'status'}>
      <span>{isError ? '⚠' : '✓'}</span>
      <span className="admin-toast-text">{toast.text}</span>
      <button type="button" className="admin-toast-close" onClick={hide} title="Скрыть">✕</button>
    </div>
  ) : null;

  return [show, element];
}
