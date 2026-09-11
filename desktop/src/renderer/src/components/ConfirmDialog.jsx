import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Electron не реализует window.prompt(), а confirm()/alert() блокируют всё окно
// системным диалогом без оформления. Поэтому вопросы задаются своими окнами.

// Открытые окна складываются в стопку: Escape закрывает только верхнее, а не
// заодно и консоль под ним.
const openDialogs = [];

export function DialogShell({ title, children, onDismiss, dismissible = true, maxWidth = 440 }) {
  const idRef = useRef(Symbol('dialog'));
  const onDismissRef = useRef(onDismiss);
  const dismissibleRef = useRef(dismissible);
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    onDismissRef.current = onDismiss;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    const id = idRef.current;
    openDialogs.push(id);
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || openDialogs[openDialogs.length - 1] !== id) return;
      e.stopPropagation();
      if (dismissibleRef.current && onDismissRef.current) onDismissRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      const index = openDialogs.indexOf(id);
      if (index >= 0) openDialogs.splice(index, 1);
    };
  }, []);

  // Портал вынесен в body, но события React всплывают по дереву компонентов:
  // без stopPropagation щелчок по окну доходил до подложки консоли и закрывал её.
  return createPortal(
    <div
      className="app-dialog-backdrop"
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        e.stopPropagation();
        // Выделение текста, начатое в поле и отпущенное за окном, — не отмена.
        if (e.target === e.currentTarget && pressedOnBackdrop.current && dismissible && onDismiss) onDismiss();
      }}
    >
      <div
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="app-dialog-header">{title}</div>}
        {children}
      </div>
    </div>,
    document.body
  );
}

// const [confirm, confirmDialog] = useConfirm();
// if (!(await confirm({ title, message, confirmText, danger: true }))) return;
// ...и {confirmDialog} где-нибудь в разметке компонента.
export function useConfirm() {
  const [request, setRequest] = useState(null);
  const resolveRef = useRef(null);

  const settle = useCallback((answer) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    if (resolve) resolve(answer);
  }, []);

  const confirm = useCallback((options) => {
    // Новый вопрос поверх неотвеченного считается отказом от прежнего.
    if (resolveRef.current) resolveRef.current(false);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setRequest(typeof options === 'string' ? { message: options } : options);
    });
  }, []);

  useEffect(() => () => {
    if (resolveRef.current) resolveRef.current(false);
  }, []);

  const element = request ? (
    <DialogShell title={request.title || 'Подтверждение'} onDismiss={() => settle(false)}>
      <div className="app-dialog-body">
        <p className="app-dialog-message">{request.message}</p>
      </div>
      <div className="app-dialog-actions">
        {/* У необратимого действия фокус на «Отмене»: случайный Enter не должен
            ничего удалять. */}
        <button type="button" className="btn btn-secondary" autoFocus={Boolean(request.danger)} onClick={() => settle(false)}>
          {request.cancelText || 'Отмена'}
        </button>
        <button
          type="button"
          className={`btn ${request.danger ? 'btn-danger' : 'btn-primary'}`}
          autoFocus={!request.danger}
          onClick={() => settle(true)}
        >
          {request.confirmText || 'Продолжить'}
        </button>
      </div>
    </DialogShell>
  ) : null;

  return [confirm, element];
}
