import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { useConfirm } from './ConfirmDialog';
import { useAdminApi } from './useAdminApi';
import {
  validateAllowlistPattern,
  describeAllowlistEntry,
  allowlistErrorMessage,
  formatAdminDate
} from '../lib/registration-admin.mjs';

// Вкладка «Разрешённые адреса» (только суперадминистратор): кто из
// зарегистрировавшихся сам получает доступ сразу после кода из письма, а чья
// заявка ждёт решения во вкладке «Заявки».
export default function RegistrationAllowlistAdmin({ serverUrl, showToast }) {
  const api = useAdminApi(serverUrl);
  const [confirm, confirmDialog] = useConfirm();
  const [entries, setEntries] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const rows = await api('/api/admin/registration-allowlist', {
        fallback: 'Не удалось загрузить список разрешённых адресов',
        explain: allowlistErrorMessage
      });
      setEntries(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (adding) return;
    const checked = validateAllowlistPattern(value);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }
    setFieldError('');
    setAdding(true);
    try {
      await api('/api/admin/registration-allowlist', {
        method: 'POST',
        body: { pattern: checked.pattern },
        explain: allowlistErrorMessage
      });
      setValue('');
      showToast?.(`«${checked.pattern}» добавлен в список`);
      await load();
    } catch (err) {
      setFieldError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (entry) => {
    const info = describeAllowlistEntry(entry.pattern);
    const confirmed = await confirm({
      title: 'Убрать из списка',
      message: info.kind === 'domain'
        ? `Убрать домен «${entry.pattern}» из списка?\nСотрудники с таким адресом больше не получат доступ сразу после кода: их заявки будут ждать вашего решения. Уже зарегистрированных это не затрагивает.`
        : `Убрать адрес «${entry.pattern}» из списка?\nЗаявка с этого адреса будет ждать вашего решения. Уже зарегистрированного сотрудника это не затрагивает.`,
      confirmText: 'Убрать',
      danger: true
    });
    if (!confirmed) return;
    setRemovingId(entry.id);
    try {
      await api(`/api/admin/registration-allowlist/${entry.id}`, {
        method: 'DELETE',
        fallback: 'Не удалось убрать запись',
        explain: allowlistErrorMessage
      });
      showToast?.(`«${entry.pattern}» убран из списка`);
      await load();
    } catch (err) {
      showToast?.(err.message, 'error');
      // Запись уже убрал другой администратор — список устарел.
      if (err.status === 404) await load();
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="sec-center">
      <h3 className="sec-page-title">Разрешённые адреса</h3>
      <p className="sec-subtitle" style={{ marginTop: -6 }}>
        Сотрудник регистрируется сам и подтверждает почту кодом из письма. Если его адрес есть в этом списке
        (отдельный адрес или весь домен компании), учётная запись активируется сразу. Остальные заявки
        ждут вашего решения во вкладке «Заявки».
      </p>

      <form className="sec-form" onSubmit={submit} noValidate>
        <div className="sec-field sec-field-block">
          <label className="sec-field-label" htmlFor="allowlist-pattern">Адрес или домен</label>
          <div className="fp-add-row">
            <input
              id="allowlist-pattern"
              type="text"
              className="sec-input"
              style={{ maxWidth: 'none', flex: '1 1 260px' }}
              placeholder="ivan@company.kz или @company.kz"
              value={value}
              maxLength={254}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={fieldError ? 'true' : undefined}
              aria-describedby={fieldError ? 'allowlist-error' : 'allowlist-hint'}
              onChange={(e) => { setValue(e.target.value); if (fieldError) setFieldError(''); }}
            />
            <button type="submit" className="sec-btn sec-btn-primary" disabled={!value.trim() || adding}>
              <Icon name="check" size={14} /><span>{adding ? 'Добавляем…' : 'Добавить'}</span>
            </button>
          </div>
          {fieldError ? (
            <span id="allowlist-error" className="sec-field-error" role="alert">{fieldError}</span>
          ) : (
            <span id="allowlist-hint" className="sec-field-hint">
              Домен пишется с «@» в начале: @company.kz разрешает всех, чей адрес оканчивается на него.
            </span>
          )}
        </div>
      </form>

      {loadError ? (
        <div className="sec-state sec-state-error" role="alert">
          <Icon name="circleX" size={16} />
          <span>{loadError}</span>
          <button type="button" className="sec-btn" onClick={load}>Повторить</button>
        </div>
      ) : entries === null ? (
        <div className="sec-state sec-state-loading" role="status">
          <span className="sec-spinner" aria-hidden="true" />
          <span>Загружаем список…</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="sec-state sec-state-empty">
          <Icon name="info" size={16} />
          <span>
            Список пуст: все самостоятельные регистрации сейчас ждут вашего решения. Добавьте адрес
            сотрудника или домен компании выше, чтобы их учётные записи активировались сразу.
          </span>
        </div>
      ) : (
        <div className="sec-table-wrap">
          <table className="sec-table">
            <thead>
              <tr>
                <th>Запись</th>
                <th>Что разрешено</th>
                <th>Добавлена</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const info = describeAllowlistEntry(entry.pattern);
                return (
                  <tr key={entry.id}>
                    <td><code>{entry.pattern}</code></td>
                    <td>{info.label}</td>
                    <td className="sec-nowrap sec-num">{formatAdminDate(entry.created_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="sec-btn"
                        disabled={removingId === entry.id}
                        onClick={() => remove(entry)}
                        aria-label={`Убрать ${entry.pattern} из списка`}
                      >
                        <Icon name="trash" size={13} /><span>Убрать</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
