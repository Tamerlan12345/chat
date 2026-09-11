import React, { useState } from 'react';
import { DialogShell } from './ConfirmDialog';
import { validateAdminPassword, MIN_PASSWORD_LENGTH } from '../lib/admin-access.mjs';

// Сброс пароля делался через window.prompt(), которого в Electron нет: кнопка
// в настоящем приложении не делала ничего.
//
// onSubmit(password) возвращает текст ошибки или null. При ошибке окно остаётся
// открытым с введённым значением; при успехе его закрывает родитель.
export function ResetPasswordDialog({ user, onCancel, onSubmit }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Отправка формы всплывает по дереву React и сквозь портал — до формы
    // карточки сотрудника, если та открыта.
    e.stopPropagation();
    if (submitting) return;
    const problem = validateAdminPassword(password);
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const failure = await onSubmit(password);
      if (failure) {
        setError(failure);
        setSubmitting(false);
      }
    } catch (err) {
      setError(err?.message || 'Не удалось сбросить пароль');
      setSubmitting(false);
    }
  };

  return (
    <DialogShell title="Сброс пароля" onDismiss={onCancel} dismissible={!submitting}>
      <form onSubmit={handleSubmit}>
        <div className="app-dialog-body">
          <div>
            Сотрудник: <strong>{user.full_name}</strong> (логин <code>{user.username}</code>)
          </div>
          <label className="app-dialog-label" htmlFor="reset-password-input">Новый пароль</label>
          <input
            id="reset-password-input"
            type="text"
            className="app-dialog-input"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            disabled={submitting}
            placeholder="Пусто — сервер выдаст случайный"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
          />
          <div className="app-dialog-hint">
            Оставьте поле пустым, чтобы сервер выдал случайный пароль — так надёжнее.
            Свой пароль — не короче {MIN_PASSWORD_LENGTH} символов. Активные сессии
            сотрудника будут закрыты.
          </div>
          {error && <div className="app-dialog-error" role="alert">{error}</div>}
        </div>
        <div className="app-dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Сбрасываем…' : 'Сбросить пароль'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Буфер обмена может быть недоступен без фокуса окна — пробуем старый способ.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

// Одноразовый пароль раньше уходил в уведомление, которое гасло через четыре
// секунды: не успел переписать — пароль потерян, сбрасывай заново. Это окно
// закрывается только кнопкой — ни щелчок мимо, ни Escape его не уберут.
export function OneTimePasswordDialog({ title, fullName, username, password, onClose }) {
  const [copyState, setCopyState] = useState(null);

  const handleCopy = async () => {
    setCopyState((await copyText(password)) ? 'ok' : 'fail');
  };

  return (
    <DialogShell title={title} dismissible={false} maxWidth={460}>
      <div className="app-dialog-body">
        <div>
          Сотрудник: <strong>{fullName}</strong>{username ? <> (логин <code>{username}</code>)</> : null}
        </div>
        <label className="app-dialog-label" htmlFor="one-time-password">Временный пароль</label>
        <div className="otp-password-row">
          <input
            id="one-time-password"
            className="otp-password"
            readOnly
            value={password}
            onFocus={(e) => e.target.select()}
          />
          <button type="button" className="btn btn-primary" onClick={handleCopy}>
            Скопировать
          </button>
        </div>
        {copyState === 'ok' && <div className="otp-copy-note ok">Скопировано в буфер обмена</div>}
        {copyState === 'fail' && (
          <div className="otp-copy-note fail">Скопировать не удалось — выделите пароль и скопируйте вручную</div>
        )}
        <div className="otp-warning">
          Пароль показывается один раз: после закрытия окна посмотреть его будет негде.
          Передайте его сотруднику — при первом входе он сменит пароль на свой.
        </div>
      </div>
      <div className="app-dialog-actions">
        <button type="button" className="btn btn-secondary" autoFocus onClick={onClose}>
          Закрыть
        </button>
      </div>
    </DialogShell>
  );
}
