import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { readError } from '../lib/admin-access.mjs';
import { isRiskyExtension } from '../lib/file-policy.mjs';

// Вкладка «Файлы» консоли управления (только суперадминистратор): фильтр
// типов вложений — серверная часть находки аудита №6. Разрешённые расширения
// задаются одним общим списком и дополнительными исключениями для отдельных
// сотрудников (например, установщик для ИТ-специалиста).

// Совпадает со значением по умолчанию на сервере
// (server/src/services/file-policy.service.js DEFAULT_ALLOWED) — списки не
// импортируются друг у друга (разные рантаймы), но должны совпадать по
// смыслу: это то, что сервер вернёт, если настройка ещё ни разу не сохранена.
const DEFAULT_ALLOWED = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'odt', 'ods',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'zip', '7z', 'rar',
  'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'mov',
  'eml', 'msg', 'xml', 'json'
];

function normalizeExt(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, ''); // человек может ввести «.exe» — точка не хранится
}

function useApi(serverUrl) {
  return useCallback(async (path, { method = 'GET', body, fallback = 'Сервер отклонил запрос' } = {}) => {
    const token = localStorage.getItem('mychat_token') || '';
    let res;
    try {
      res = await fetch(serverUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new Error('Нет связи с сервером');
    }
    if (!res.ok) throw new Error(await readError(res, fallback));
    return res.json().catch(() => ({}));
  }, [serverUrl]);
}

function ExtChips({ list, onRemove, disabled }) {
  if (!list.length) return <p className="sec-muted" style={{ margin: 0 }}>Список пуст</p>;
  return (
    <div className="fp-chips">
      {list.map((ext) => (
        <span key={ext} className={`fp-chip${isRiskyExtension(ext) ? ' is-risky' : ''}`}>
          .{ext}
          {!disabled && (
            <button
              type="button"
              className="fp-chip-remove"
              onClick={() => onRemove(ext)}
              aria-label={`Убрать .${ext} из списка`}
              title={`Убрать .${ext}`}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function AddExtForm({ onAdd, placeholder = 'например, docm' }) {
  const [value, setValue] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const ext = normalizeExt(value);
    if (!ext) return;
    if (!/^[a-z0-9]{1,10}$/.test(ext)) return;
    onAdd(ext);
    setValue('');
  };
  return (
    <form className="fp-add-row" onSubmit={submit}>
      <input
        type="text"
        className="sec-input"
        placeholder={placeholder}
        value={value}
        maxLength={10}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="sec-btn" disabled={!normalizeExt(value)}>
        Добавить
      </button>
    </form>
  );
}

export default function FilePolicyAdmin({ serverUrl, showToast }) {
  const api = useApi(serverUrl);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [policy, users] = await Promise.all([
        api('/api/admin/file-policy', { fallback: 'Не удалось загрузить фильтр файлов' }),
        api('/api/admin/users', { fallback: 'Не удалось загрузить список сотрудников' })
      ]);
      const normalized = {
        enabled: policy.enabled !== false,
        allowed: Array.isArray(policy.allowed) ? [...policy.allowed] : [...DEFAULT_ALLOWED],
        perUser: policy.perUser && typeof policy.perUser === 'object' ? { ...policy.perUser } : {}
      };
      setSaved(normalized);
      setDraft(normalized);
      setEmployees((Array.isArray(users) ? users : []).filter((u) => u.is_active));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const dirty = saved && draft && JSON.stringify(saved) !== JSON.stringify(draft);

  const riskyInUse = useMemo(() => {
    if (!draft) return [];
    const all = new Set(draft.allowed.filter(isRiskyExtension));
    for (const list of Object.values(draft.perUser || {})) {
      for (const ext of list) if (isRiskyExtension(ext)) all.add(ext);
    }
    return [...all].sort();
  }, [draft]);

  const employeeById = useMemo(() => new Map(employees.map((u) => [String(u.id), u])), [employees]);

  const addAllowed = (ext) => {
    setDraft((d) => (d.allowed.includes(ext) ? d : { ...d, allowed: [...d.allowed, ext].sort() }));
  };
  const removeAllowed = (ext) => {
    setDraft((d) => ({ ...d, allowed: d.allowed.filter((e) => e !== ext) }));
  };
  const resetToDefault = () => {
    setDraft((d) => ({ ...d, allowed: [...DEFAULT_ALLOWED] }));
  };

  const addEmployeeException = () => {
    if (!selectedEmployeeId) return;
    setDraft((d) => {
      if (d.perUser[selectedEmployeeId]) return d;
      return { ...d, perUser: { ...d.perUser, [selectedEmployeeId]: [] } };
    });
    setSelectedEmployeeId('');
  };
  const removeEmployeeException = (userId) => {
    setDraft((d) => {
      const next = { ...d.perUser };
      delete next[userId];
      return { ...d, perUser: next };
    });
  };
  const addPerUserExt = (userId, ext) => {
    setDraft((d) => {
      const current = d.perUser[userId] || [];
      if (current.includes(ext)) return d;
      return { ...d, perUser: { ...d.perUser, [userId]: [...current, ext].sort() } };
    });
  };
  const removePerUserExt = (userId, ext) => {
    setDraft((d) => ({
      ...d,
      perUser: { ...d.perUser, [userId]: (d.perUser[userId] || []).filter((e) => e !== ext) }
    }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = await api('/api/admin/file-policy', {
        method: 'PUT',
        body: { enabled: draft.enabled, allowed: draft.allowed, perUser: draft.perUser },
        fallback: 'Фильтр файлов не сохранён'
      });
      const normalized = {
        enabled: next.enabled !== false,
        allowed: Array.isArray(next.allowed) ? [...next.allowed] : draft.allowed,
        perUser: next.perUser && typeof next.perUser === 'object' ? { ...next.perUser } : {}
      };
      setSaved(normalized);
      setDraft(normalized);
      showToast?.('Фильтр типов файлов сохранён');
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const availableEmployees = employees.filter((u) => !(draft?.perUser && draft.perUser[String(u.id)]));

  if (error) {
    return (
      <section className="sec-section">
        <h3 className="sec-page-title">Файлы</h3>
        <div className="sec-state sec-state-error" role="alert">
          <Icon name="circleX" size={16} />
          <span>{error}</span>
          <button type="button" className="sec-btn" onClick={load}>Повторить</button>
        </div>
      </section>
    );
  }

  if (loading || !draft) {
    return (
      <section className="sec-section">
        <h3 className="sec-page-title">Файлы</h3>
        <div className="sec-state sec-state-loading" role="status">
          <span className="sec-spinner" aria-hidden="true" />
          <span>Загружаем фильтр типов файлов…</span>
        </div>
      </section>
    );
  }

  return (
    <div className="sec-center">
      <h3 className="sec-page-title">Файлы</h3>
      <p className="sec-subtitle" style={{ marginTop: -6 }}>
        Какие типы вложений сотрудники могут отправлять в чатах. Настраивает только администратор — для всех сразу
        и дополнительно для отдельных сотрудников.
      </p>

      <form className="sec-form" onSubmit={handleSave}>
        <label className="sec-switch">
          <input
            type="checkbox"
            role="switch"
            checked={draft.enabled}
            onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
          />
          <span className="sec-switch-track" aria-hidden="true" />
          <span className="sec-switch-text">
            <span className="sec-switch-label">Фильтр включён</span>
            <span className="sec-switch-hint">
              {draft.enabled
                ? 'Загрузка файла с расширением вне списков ниже отклоняется сервером.'
                : 'Расширение не проверяется. Имя файла и содержимое (переименованный исполняемый файл) сервер по-прежнему проверяет.'}
            </span>
          </span>
        </label>

        {riskyInUse.length > 0 && (
          <div className="fp-warning" role="alert">
            <Icon name="alert" size={16} />
            <span>
              В списках разрешён потенциально опасный тип файла: {riskyInUse.map((e) => `.${e}`).join(', ')}.
              Сотрудники смогут отправлять и получать в чате исполняемый код.
            </span>
          </div>
        )}

        <section className="sec-section" aria-labelledby="fp-allowed-title">
          <div className="sec-section-head">
            <div>
              <h4 id="fp-allowed-title" className="sec-title">Разрешено для всех</h4>
              <p className="sec-subtitle">Общий список расширений — действует для каждого сотрудника.</p>
            </div>
            <button type="button" className="sec-btn" onClick={resetToDefault}>
              <Icon name="refresh" size={14} /><span>Вернуть по умолчанию</span>
            </button>
          </div>
          <ExtChips list={draft.allowed} onRemove={removeAllowed} />
          <AddExtForm onAdd={addAllowed} />
        </section>

        <section className="sec-section" aria-labelledby="fp-peruser-title">
          <div className="sec-section-head">
            <div>
              <h4 id="fp-peruser-title" className="sec-title">Исключения для сотрудников</h4>
              <p className="sec-subtitle">
                Дополнительные расширения сверх общего списка — только для выбранного сотрудника.
              </p>
            </div>
          </div>

          <div className="fp-add-row">
            <select
              className="sec-input"
              value={selectedEmployeeId}
              onChange={(e) => setSelectedEmployeeId(e.target.value)}
            >
              <option value="">Выберите сотрудника…</option>
              {availableEmployees.map((u) => (
                <option key={u.id} value={String(u.id)}>{u.full_name || u.username}</option>
              ))}
            </select>
            <button type="button" className="sec-btn" disabled={!selectedEmployeeId} onClick={addEmployeeException}>
              <Icon name="user" size={14} /><span>Добавить исключение</span>
            </button>
          </div>

          {Object.keys(draft.perUser).length === 0 && (
            <p className="sec-muted" style={{ margin: 0 }}>Исключений нет — у всех действует только общий список.</p>
          )}

          <div className="fp-user-list">
            {Object.entries(draft.perUser).map(([userId, list]) => {
              const person = employeeById.get(userId);
              return (
                <div key={userId} className="fp-user-block">
                  <div className="fp-user-block-head">
                    <span className="fp-user-name">
                      {person ? (person.full_name || person.username) : `Сотрудник №${userId}`}
                    </span>
                    <button type="button" className="sec-btn" onClick={() => removeEmployeeException(userId)}>
                      <Icon name="x" size={13} /><span>Убрать исключение</span>
                    </button>
                  </div>
                  <ExtChips list={list} onRemove={(ext) => removePerUserExt(userId, ext)} />
                  <AddExtForm onAdd={(ext) => addPerUserExt(userId, ext)} placeholder="например, exe" />
                </div>
              );
            })}
          </div>
        </section>

        <div className="sec-form-actions">
          <button type="submit" className="sec-btn sec-btn-primary" disabled={!dirty || saving}>
            <Icon name="save" size={14} /><span>{saving ? 'Сохраняем…' : 'Сохранить'}</span>
          </button>
          {dirty && !saving && (
            <button type="button" className="sec-btn" onClick={() => setDraft(saved)}>
              Отменить изменения
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
