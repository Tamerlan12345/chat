import { getSessionToken } from '../lib/credentials.mjs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { useConfirm } from './ConfirmDialog';
import { readError } from '../lib/admin-access.mjs';
import { formatBytes } from '../lib/attachments.mjs';
import { formatServerTime } from '../lib/security-labels.mjs';
import { compareVersions, describeRollout, ROLLOUT_PRESETS, validatePolicyDraft } from '../lib/update-admin.mjs';

// Вкладка «Обновления» консоли администратора (только суперадминистратор):
// загрузка релизов, папка inbox, политика поэтапной раздачи по каналам и
// распределение версий/ошибок по парку компьютеров. По образцу
// SecurityCenter.jsx — самостоятельный доступ к серверу, без общего
// состояния с остальной консолью.
//
// Серверные маршруты (Задача 7): GET /api/admin/updates,
// POST /api/admin/updates/releases (multipart), POST /api/admin/updates/inbox/:name/import,
// PUT /api/admin/updates/policy, DELETE /api/admin/updates/releases/:version.

const CHANNELS = ['stable', 'beta'];

function useApi(serverUrl) {
  return useCallback(async (path, { method = 'GET', body, fallback = 'Сервер отклонил запрос' } = {}) => {
    const token = getSessionToken();
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

function StateLine({ kind, children, onRetry }) {
  return (
    <div className={`sec-state sec-state-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'loading' && <span className="sec-spinner" aria-hidden="true" />}
      {kind === 'error' && <Icon name="circleX" size={16} />}
      {kind === 'empty' && <Icon name="circleCheck" size={16} />}
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="sec-btn" onClick={onRetry}>
          <Icon name="refresh" size={14} /><span>Повторить</span>
        </button>
      )}
    </div>
  );
}

// ── Релизы ─────────────────────────────────────────────────────────────────

function ReleasesSection({ releases, policy, api, confirm, showToast, onChanged }) {
  const [deletingVersion, setDeletingVersion] = useState(null);
  const targets = useMemo(
    () => new Set(CHANNELS.map((name) => policy?.channels?.[name]?.target).filter(Boolean)),
    [policy]
  );

  const handleDelete = async (release) => {
    const ok = await confirm({
      title: 'Удаление релиза',
      message: `Удалить релиз ${release.version}? Установщик будет стёрт с диска сервера — отменить нельзя.`,
      confirmText: 'Удалить',
      danger: true
    });
    if (!ok) return;
    setDeletingVersion(release.version);
    try {
      await api(`/api/admin/updates/releases/${encodeURIComponent(release.version)}`, {
        method: 'DELETE',
        fallback: 'Релиз не удалён'
      });
      showToast?.(`Релиз ${release.version} удалён`);
      await onChanged();
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setDeletingVersion(null);
    }
  };

  return (
    <section className="sec-section" aria-labelledby="upd-releases-title">
      <div className="sec-section-head">
        <div>
          <h4 id="upd-releases-title" className="sec-title">Загруженные релизы</h4>
          <p className="sec-subtitle">Версии, доступные для раздачи. Нельзя удалить версию, назначенную каналу в политике ниже.</p>
        </div>
      </div>

      {releases.length === 0 ? (
        <StateLine kind="empty">Релизов ещё нет — загрузите первый ниже</StateLine>
      ) : (
        <div className="sec-table-wrap">
          <table className="sec-table">
            <thead>
              <tr>
                <th scope="col">Версия</th>
                <th scope="col">Размер</th>
                <th scope="col">Дата сборки</th>
                <th scope="col">Импортировал</th>
                <th scope="col">Заметки</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => {
                const inUse = targets.has(r.version);
                return (
                  <tr key={r.version}>
                    <td>
                      <strong>{r.version}</strong>
                      {inUse && <span className="upd-in-rollout-badge">в раздаче</span>}
                    </td>
                    <td className="sec-nowrap sec-num">{formatBytes(r.size)}</td>
                    <td className="sec-nowrap sec-num">{formatServerTime(r.releaseDate)}</td>
                    <td>{r.importedBy ? String(r.importedBy) : <span className="sec-muted">—</span>}</td>
                    <td className="sec-details-cell" title={r.notes || undefined}>
                      {r.notes ? String(r.notes) : <span className="sec-muted">—</span>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sec-btn"
                        disabled={inUse || deletingVersion === r.version}
                        title={inUse ? 'Сначала снимите версию с раздачи в политике' : undefined}
                        onClick={() => handleDelete(r)}
                      >
                        <Icon name="x" size={14} /><span>{deletingVersion === r.version ? 'Удаляем…' : 'Удалить'}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Загрузка релиза (XHR с прогрессом) ──────────────────────────────────────

const UPLOAD_FIELDS = [
  { key: 'yml', label: 'latest.yml', accept: '.yml', required: true },
  { key: 'setup', label: 'Установщик (Setup .exe)', accept: '.exe', required: true },
  { key: 'blockmap', label: 'Blockmap (необязательно)', accept: '.blockmap', required: false },
  { key: 'portable', label: 'Portable-сборка (необязательно)', accept: '.exe', required: false }
];

function UploadForm({ serverUrl, onChanged, showToast }) {
  const [files, setFiles] = useState({ yml: null, setup: null, blockmap: null, portable: null });
  const [notes, setNotes] = useState('');
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const xhrRef = useRef(null);
  const inputRefs = useRef({});

  const setField = (key) => (e) => {
    setFiles((prev) => ({ ...prev, [key]: e.target.files?.[0] || null }));
  };

  const canSubmit = Boolean(files.yml && files.setup) && !busy;

  const resetForm = () => {
    setFiles({ yml: null, setup: null, blockmap: null, portable: null });
    setNotes('');
    for (const field of UPLOAD_FIELDS) {
      const el = inputRefs.current[field.key];
      if (el) el.value = '';
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    const form = new FormData();
    form.append('yml', files.yml);
    form.append('setup', files.setup);
    if (files.blockmap) form.append('blockmap', files.blockmap);
    if (files.portable) form.append('portable', files.portable);
    form.append('notes', notes);

    const token = getSessionToken();
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', serverUrl + '/api/admin/updates/releases');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = async () => {
      xhrRef.current = null;
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* пустой или не-JSON ответ */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        showToast?.(`Релиз ${body?.version || ''} загружен`);
        resetForm();
        await onChanged();
      } else {
        showToast?.(body?.error || `Загрузка не удалась (HTTP ${xhr.status})`, 'error');
      }
      setBusy(false);
      setProgress(null);
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      showToast?.('Нет связи с сервером', 'error');
      setBusy(false);
      setProgress(null);
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      setBusy(false);
      setProgress(null);
    };
    setBusy(true);
    setProgress(0);
    xhr.send(form);
  };

  const cancelUpload = () => xhrRef.current?.abort();

  return (
    <section className="sec-section" aria-labelledby="upd-upload-title">
      <div className="sec-section-head">
        <div>
          <h4 id="upd-upload-title" className="sec-title">Загрузить релиз</h4>
          <p className="sec-subtitle">Файлы из desktop/release, как их собирает подпись (Задача 8): latest.yml и установщик обязательны.</p>
        </div>
      </div>

      <form className="sec-form" onSubmit={handleSubmit}>
        {UPLOAD_FIELDS.map((field) => (
          <label key={field.key} className="sec-field">
            <span className="sec-field-label">{field.label}</span>
            <input
              ref={(el) => { inputRefs.current[field.key] = el; }}
              type="file"
              accept={field.accept}
              disabled={busy}
              onChange={setField(field.key)}
            />
          </label>
        ))}

        <label className="sec-field sec-field-block">
          <span className="sec-field-label">Заметки к релизу</span>
          <textarea
            className="sec-input sec-textarea"
            rows={3}
            maxLength={2000}
            value={notes}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {progress !== null && (
          <div className="upload-item-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
        )}

        <div className="sec-form-actions">
          <button type="submit" className="sec-btn sec-btn-primary" disabled={!canSubmit}>
            <Icon name="download" size={14} /><span>{busy ? `Загружаем… ${progress ?? 0}%` : 'Загрузить релиз'}</span>
          </button>
          {busy && (
            <button type="button" className="sec-btn" onClick={cancelUpload}>Отменить</button>
          )}
        </div>
      </form>
    </section>
  );
}

// ── Inbox ────────────────────────────────────────────────────────────────

function InboxSection({ inbox, api, onChanged, showToast }) {
  const [importingName, setImportingName] = useState(null);

  if (!inbox || inbox.length === 0) return null;

  const handleImport = async (item) => {
    setImportingName(item.name);
    try {
      const summary = await api(`/api/admin/updates/inbox/${encodeURIComponent(item.name)}/import`, {
        method: 'POST',
        body: {},
        fallback: 'Импорт не выполнен'
      });
      showToast?.(`Релиз ${summary.version} импортирован`);
      await onChanged();
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setImportingName(null);
    }
  };

  return (
    <section className="sec-section" aria-labelledby="upd-inbox-title">
      <div className="sec-section-head">
        <div>
          <h4 id="upd-inbox-title" className="sec-title">Папка inbox</h4>
          <p className="sec-subtitle">Сборки, скопированные на сервер вручную, минуя эту форму.</p>
        </div>
      </div>
      <ul className="sec-alert-list">
        {inbox.map((item) => {
          const hasProblems = Array.isArray(item.problems) && item.problems.length > 0;
          return (
            <li key={item.name} className="sec-alert">
              <div className="sec-alert-row">
                <span className="sec-alert-title">{item.name}{item.version ? ` (${item.version})` : ''}</span>
                {!hasProblems && (
                  <button
                    type="button"
                    className="sec-btn sec-btn-primary"
                    disabled={importingName === item.name}
                    onClick={() => handleImport(item)}
                  >
                    <Icon name="check" size={14} /><span>{importingName === item.name ? 'Импортируем…' : 'Импортировать'}</span>
                  </button>
                )}
              </div>
              {hasProblems && (
                <div className="sec-alert-details">
                  {item.problems.map((p, i) => <div key={i} className="sec-muted">{String(p)}</div>)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Политика раздачи ─────────────────────────────────────────────────────

function draftFromPolicy(policy) {
  const channels = {};
  for (const name of CHANNELS) {
    const cfg = policy?.channels?.[name];
    channels[name] = {
      target: cfg?.target ?? null,
      rolloutPercent: Number.isInteger(cfg?.rolloutPercent) ? cfg.rolloutPercent : 0
    };
  }
  return {
    enabled: Boolean(policy?.enabled),
    channels,
    minVersion: policy?.minVersion ?? null,
    checkIntervalMinutes: Number.isInteger(policy?.checkIntervalMinutes) ? policy.checkIntervalMinutes : 240,
    message: policy?.message ?? ''
  };
}

function PolicyEditor({ policy, releases, api, onChanged, showToast }) {
  const [draft, setDraft] = useState(() => draftFromPolicy(policy));
  const [saving, setSaving] = useState(false);

  // После сохранения сервер отдаёт нормализованную политику — черновик
  // синхронизируется с ней, а не остаётся тем, что было отправлено.
  useEffect(() => { setDraft(draftFromPolicy(policy)); }, [policy]);

  const sortedReleases = useMemo(
    () => [...releases].sort((a, b) => compareVersions(b.version, a.version)),
    [releases]
  );

  const problems = useMemo(() => validatePolicyDraft(draft, releases), [draft, releases]);

  const setChannel = (name, patch) => {
    setDraft((prev) => ({ ...prev, channels: { ...prev.channels, [name]: { ...prev.channels[name], ...patch } } }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (problems.length > 0 || saving) return;
    setSaving(true);
    try {
      const body = { ...draft, minVersion: draft.minVersion || null, message: (draft.message || '').trim() || null };
      const result = await api('/api/admin/updates/policy', { method: 'PUT', body, fallback: 'Политика не сохранена' });
      showToast?.('Политика обновлений сохранена');
      await onChanged(result?.policy);
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sec-section" aria-labelledby="upd-policy-title">
      <div className="sec-section-head">
        <div>
          <h4 id="upd-policy-title" className="sec-title">Политика раздачи</h4>
          <p className="sec-subtitle">Кому какая версия предлагается и с каким шагом. Сервер проверяет то же самое ещё раз при сохранении.</p>
        </div>
      </div>

      <form className="sec-form" onSubmit={handleSave}>
        <label className="sec-switch">
          <input
            type="checkbox"
            role="switch"
            checked={draft.enabled}
            onChange={(e) => setDraft((p) => ({ ...p, enabled: e.target.checked }))}
          />
          <span className="sec-switch-track" aria-hidden="true" />
          <span className="sec-switch-text">
            <span className="sec-switch-label">Автообновление включено</span>
            <span className="sec-switch-hint">
              {draft.enabled
                ? 'Клиенты проверяют /updates/policy.json по расписанию.'
                : 'Клиентам ничего не предлагается, даже если версия назначена каналу.'}
            </span>
          </span>
        </label>

        {CHANNELS.map((name) => (
          <div key={name} className="sec-field sec-field-block">
            <span className="sec-field-label">Канал {name}</span>
            <div className="upd-channel-row">
              <select
                className="sec-input"
                value={draft.channels[name].target ?? ''}
                onChange={(e) => setChannel(name, { target: e.target.value || null })}
              >
                <option value="">Не назначено</option>
                {sortedReleases.map((r) => (
                  <option key={r.version} value={r.version}>{r.version}</option>
                ))}
              </select>
              <input
                type="number"
                className="sec-input upd-rollout-input"
                min={0}
                max={100}
                value={draft.channels[name].rolloutPercent}
                onChange={(e) => setChannel(name, { rolloutPercent: Number(e.target.value) })}
              />
              {ROLLOUT_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="sec-btn"
                  onClick={() => setChannel(name, { rolloutPercent: p })}
                >
                  {p}%
                </button>
              ))}
              <span className="sec-muted">{describeRollout(draft.channels[name].rolloutPercent)}</span>
            </div>
          </div>
        ))}

        <label className="sec-field">
          <span className="sec-field-label">Минимальная версия (ниже неё — обязательное обновление)</span>
          <select
            className="sec-input"
            value={draft.minVersion ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, minVersion: e.target.value || null }))}
          >
            <option value="">Не задано</option>
            {sortedReleases.map((r) => (
              <option key={r.version} value={r.version}>{r.version}</option>
            ))}
          </select>
        </label>

        <label className="sec-field">
          <span className="sec-field-label">Проверка не чаще, чем раз в (минут)</span>
          <input
            type="number"
            className="sec-input"
            min={30}
            max={1440}
            value={draft.checkIntervalMinutes}
            onChange={(e) => setDraft((p) => ({ ...p, checkIntervalMinutes: Number(e.target.value) }))}
          />
        </label>

        <label className="sec-field sec-field-block">
          <span className="sec-field-label">Сообщение сотруднику (необязательно)</span>
          <textarea
            className="sec-input sec-textarea"
            rows={3}
            maxLength={500}
            value={draft.message ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, message: e.target.value }))}
          />
        </label>

        {problems.length > 0 && (
          <ul className="sec-field-error upd-policy-problems">
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}

        <div className="sec-form-actions">
          <button type="submit" className="sec-btn sec-btn-primary" disabled={problems.length > 0 || saving}>
            <Icon name="save" size={14} /><span>{saving ? 'Сохраняем…' : 'Сохранить политику'}</span>
          </button>
        </div>
      </form>
    </section>
  );
}

// ── Парк компьютеров ─────────────────────────────────────────────────────

function FleetGroup({ title, entries }) {
  return (
    <div>
      <h5 className="upd-fleet-group-title">{title}</h5>
      {entries.length === 0 ? (
        <p className="sec-muted">Нет данных</p>
      ) : (
        <ul className="upd-fleet-list">
          {entries.map(([key, count]) => (
            <li key={key}><span>{key}</span><span>{count}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FleetSection({ fleet }) {
  const versions = useMemo(
    () => Object.entries(fleet?.byVersion || {}).sort((a, b) => b[1] - a[1]),
    [fleet]
  );
  const kinds = useMemo(() => Object.entries(fleet?.byKind || {}).sort((a, b) => b[1] - a[1]), [fleet]);
  const errors = useMemo(() => Object.entries(fleet?.errors || {}).sort((a, b) => b[1] - a[1]), [fleet]);

  return (
    <section className="sec-section" aria-labelledby="upd-fleet-title">
      <div className="sec-section-head">
        <div>
          <h4 id="upd-fleet-title" className="sec-title">Парк компьютеров</h4>
          <p className="sec-subtitle">Отметились за последние 10 минут на устройство: {fleet?.total ?? 0}.</p>
        </div>
      </div>
      <div className="upd-fleet-grid">
        <FleetGroup title="По версии клиента" entries={versions} />
        <FleetGroup title="По виду установки" entries={kinds} />
        <FleetGroup title="Ошибки обновления" entries={errors} />
      </div>
    </section>
  );
}

// ── Раздел целиком ─────────────────────────────────────────────────────────

export default function UpdatesAdmin({ serverUrl, showToast }) {
  const api = useApi(serverUrl);
  const [confirm, confirmDialog] = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api('/api/admin/updates', { fallback: 'Не удалось загрузить данные об обновлениях' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="sec-center">
      <h3 className="sec-page-title">Обновления</h3>

      {data?.disabledByEnv && (
        <div className="sec-verify is-fail" role="alert">
          <Icon name="alert" size={18} />
          <span>Обновления выключены на сервере (UPDATES_DISABLED)</span>
        </div>
      )}

      {error && <StateLine kind="error" onRetry={load}>{error}</StateLine>}
      {!error && loading && !data && <StateLine kind="loading">Загружаем данные об обновлениях…</StateLine>}

      {!error && data && (
        <>
          <ReleasesSection
            releases={data.releases || []}
            policy={data.policy}
            api={api}
            confirm={confirm}
            showToast={showToast}
            onChanged={load}
          />
          <UploadForm serverUrl={serverUrl} onChanged={load} showToast={showToast} />
          <InboxSection inbox={data.inbox} api={api} onChanged={load} showToast={showToast} />
          <PolicyEditor
            policy={data.policy}
            releases={data.releases || []}
            api={api}
            showToast={showToast}
            onChanged={load}
          />
          <FleetSection fleet={data.fleet} />
        </>
      )}

      {confirmDialog}
    </div>
  );
}
