import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { readError } from '../lib/admin-access.mjs';
import {
  actionLabel,
  auditActionOptions,
  severityLabel,
  normalizeSeverity,
  formatServerTime,
  mergeAlerts,
  countUnacknowledged,
  formatDetails,
  summarizeDetails,
  checkStatusMeta,
  sortChecks,
  validateIceServersText,
  formatIceServersText
} from '../lib/security-labels.mjs';

// Раздел «Безопасность» консоли управления (только суперадминистратор):
// состояние сервера, оповещения, журнал аудита и настройки удалённого
// рабочего стола. Все данные — с сервера; подробности показываются только
// текстом, никакого HTML.

const SECTIONS = [
  { id: 'status', label: 'Состояние', icon: 'shieldCheck' },
  { id: 'alerts', label: 'Оповещения', icon: 'alert' },
  { id: 'audit', label: 'Журнал аудита', icon: 'scroll' },
  { id: 'rd', label: 'Удалённый рабочий стол', icon: 'monitor' }
];

const AUDIT_LIMIT = 200;
const ALERTS_LIMIT = 100;

// Токен читается на каждый запрос: приложение обновляет его каждые полчаса,
// а консоль может быть открыта дольше.
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

// ── Состояние ──────────────────────────────────────────────────────────────

function StatusSection({ api }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api('/api/admin/security/status', { fallback: 'Не удалось получить состояние сервера' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const checks = useMemo(() => sortChecks(data?.checks), [data]);
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  return (
    <section className="sec-section" aria-labelledby="sec-status-title">
      <div className="sec-section-head">
        <div>
          <h4 id="sec-status-title" className="sec-title">Состояние защиты сервера</h4>
          <p className="sec-subtitle">
            {data?.generatedAt ? `Проверено ${formatServerTime(data.generatedAt)}` : 'Проверка настроек, влияющих на безопасность'}
          </p>
        </div>
        <button type="button" className="sec-btn" onClick={load} disabled={loading}>
          <Icon name="refresh" size={14} /><span>{loading ? 'Проверяем…' : 'Обновить'}</span>
        </button>
      </div>

      {error && <StateLine kind="error" onRetry={load}>{error}</StateLine>}
      {!error && loading && !data && <StateLine kind="loading">Проверяем состояние сервера…</StateLine>}
      {!error && data && checks.length === 0 && <StateLine kind="empty">Сервер не вернул ни одной проверки</StateLine>}

      {!error && checks.length > 0 && (
        <>
          <p className={`sec-summary ${failCount ? 'is-fail' : warnCount ? 'is-warn' : 'is-ok'}`}>
            {failCount === 0 && warnCount === 0
              ? `Все проверки пройдены (${checks.length})`
              : `Проблем: ${failCount}, предупреждений: ${warnCount}, всего проверок: ${checks.length}`}
          </p>
          <ul className="sec-check-list">
            {checks.map((check, index) => {
              const meta = checkStatusMeta(check.status);
              const status = ['ok', 'warn', 'fail'].includes(check.status) ? check.status : 'warn';
              return (
                <li key={check.id ?? index} className={`sec-check is-${status}`}>
                  <span className="sec-check-status">
                    <Icon name={meta.icon} size={16} />
                    <span>{meta.label}</span>
                  </span>
                  <div className="sec-check-body">
                    <div className="sec-check-title">{String(check.title ?? check.id ?? '')}</div>
                    {check.detail && <div className="sec-check-detail">{String(check.detail)}</div>}
                    {status !== 'ok' && check.recommendation && (
                      <div className="sec-check-reco">
                        <Icon name="lightbulb" size={14} />
                        <span>{String(check.recommendation)}</span>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// ── Оповещения ─────────────────────────────────────────────────────────────

function AlertItem({ alert, onAck, acking }) {
  const [open, setOpen] = useState(false);
  const severity = normalizeSeverity(alert.severity);
  const rows = open ? formatDetails(alert.details) : [];
  const detailsId = `sec-alert-details-${alert.id}`;
  const acknowledged = Boolean(alert.acknowledged_at);

  return (
    <li className={`sec-alert ${acknowledged ? 'is-acked' : ''}`}>
      <div className="sec-alert-row">
        <span className={`sec-severity is-${severity}`}>{severityLabel(severity)}</span>
        <button
          type="button"
          className="sec-alert-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          <span className="sec-alert-title">{String(alert.title ?? alert.rule ?? 'Оповещение')}</span>
        </button>
        <time className="sec-alert-time">{formatServerTime(alert.created_at)}</time>
        {acknowledged ? (
          <span className="sec-alert-acked">
            <Icon name="check" size={14} />
            <span>Просмотрено{alert.acknowledged_by_name ? `: ${alert.acknowledged_by_name}` : ''}</span>
          </span>
        ) : (
          <button type="button" className="sec-btn" onClick={() => onAck(alert)} disabled={acking}>
            {acking ? 'Сохраняем…' : 'Отметить просмотренным'}
          </button>
        )}
      </div>
      {open && (
        <div id={detailsId} className="sec-alert-details">
          {alert.rule && <div className="sec-kv"><span className="sec-kv-key">правило</span><span className="sec-kv-value">{String(alert.rule)}</span></div>}
          {rows.length === 0 && <div className="sec-muted">Подробностей нет</div>}
          {rows.map((row) => (
            <div key={row.key} className="sec-kv">
              <span className="sec-kv-key">{row.key}</span>
              <span className="sec-kv-value">{row.value}</span>
            </div>
          ))}
          {acknowledged && (
            <div className="sec-muted">Отмечено {formatServerTime(alert.acknowledged_at)}</div>
          )}
        </div>
      )}
    </li>
  );
}

function AlertsSection({ api, liveAlerts, currentUser, showToast, onAlertAcknowledged }) {
  const [fetched, setFetched] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [localAcks, setLocalAcks] = useState({});
  const [ackingId, setAckingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await api(`/api/admin/security/alerts?limit=${ALERTS_LIMIT}`, { fallback: 'Не удалось загрузить оповещения' });
      setFetched(Array.isArray(list) ? list : []);
      setLoaded(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const alerts = useMemo(() => {
    const merged = mergeAlerts(fetched, liveAlerts);
    return merged.map((a) => (localAcks[a.id] && !a.acknowledged_at ? { ...a, ...localAcks[a.id] } : a));
  }, [fetched, liveAlerts, localAcks]);

  const unacked = countUnacknowledged(alerts);
  const visible = onlyNew ? alerts.filter((a) => !a.acknowledged_at) : alerts;

  const handleAck = async (alert) => {
    setAckingId(alert.id);
    try {
      await api(`/api/admin/security/alerts/${encodeURIComponent(alert.id)}/ack`, { method: 'POST', fallback: 'Отметка не сохранена' });
      const ack = {
        acknowledged_at: new Date().toISOString(),
        acknowledged_by_name: currentUser?.full_name || currentUser?.username || ''
      };
      setLocalAcks((prev) => ({ ...prev, [alert.id]: ack }));
      // Счётчик новых на вкладке считается по живым оповещениям в App.
      onAlertAcknowledged?.(alert.id, ack);
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setAckingId(null);
    }
  };

  return (
    <section className="sec-section" aria-labelledby="sec-alerts-title">
      <div className="sec-section-head">
        <div>
          <h4 id="sec-alerts-title" className="sec-title">Оповещения безопасности</h4>
          <p className="sec-subtitle">
            {loaded ? `Не просмотрено: ${unacked}. Новые появляются сразу, без обновления.` : 'Подозрительные события на сервере'}
          </p>
        </div>
        <div className="sec-head-actions">
          <label className="sec-check-label">
            <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
            <span>Только непросмотренные</span>
          </label>
          <button type="button" className="sec-btn" onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} /><span>Обновить</span>
          </button>
        </div>
      </div>

      {error && <StateLine kind="error" onRetry={load}>{error}</StateLine>}
      {!error && loading && !loaded && <StateLine kind="loading">Загружаем оповещения…</StateLine>}
      {!error && loaded && visible.length === 0 && (
        <StateLine kind="empty">{onlyNew && alerts.length > 0 ? 'Непросмотренных оповещений нет' : 'Оповещений нет'}</StateLine>
      )}

      {!error && visible.length > 0 && (
        <ul className="sec-alert-list">
          {visible.map((alert) => (
            <AlertItem key={alert.id} alert={alert} onAck={handleAck} acking={ackingId === alert.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Журнал аудита ──────────────────────────────────────────────────────────

function AuditSection({ api }) {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const [verify, setVerify] = useState({ state: 'idle' });
  const requestRef = useRef(0);
  const actionOptions = useMemo(() => auditActionOptions(), []);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(AUDIT_LIMIT) });
      if (action) params.set('action', action);
      const list = await api(`/api/admin/audit?${params}`, { fallback: 'Не удалось загрузить журнал аудита' });
      // Быстро сменили фильтр — ответ на прежний запрос уже не нужен.
      if (requestId !== requestRef.current) return;
      setEntries(Array.isArray(list) ? list : []);
      setLoaded(true);
    } catch (err) {
      if (requestId === requestRef.current) setError(err.message);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [api, action]);

  useEffect(() => { load(); }, [load]);

  const runVerify = async () => {
    setVerify({ state: 'loading' });
    try {
      const result = await api('/api/admin/audit/verify', { fallback: 'Проверка не выполнена' });
      setVerify({
        state: result?.ok ? 'ok' : 'fail',
        checked: Number(result?.checked) || 0,
        brokenAt: result?.brokenAt ?? null
      });
    } catch (err) {
      setVerify({ state: 'error', error: err.message });
    }
  };

  const query = userQuery.trim().toLowerCase();
  const visible = query
    ? entries.filter((e) => String(e.user_name ?? '').toLowerCase().includes(query))
    : entries;

  return (
    <section className="sec-section" aria-labelledby="sec-audit-title">
      <div className="sec-section-head">
        <div>
          <h4 id="sec-audit-title" className="sec-title">Журнал аудита</h4>
          <p className="sec-subtitle">Последние {AUDIT_LIMIT} записей. Каждая запись связана с предыдущей — изменение любой из них обнаруживается проверкой.</p>
        </div>
        <button type="button" className="sec-btn sec-btn-primary" onClick={runVerify} disabled={verify.state === 'loading'}>
          <Icon name="shieldCheck" size={14} />
          <span>{verify.state === 'loading' ? 'Проверяем…' : 'Проверить целостность журнала'}</span>
        </button>
      </div>

      {verify.state === 'ok' && (
        <div className="sec-verify is-ok" role="status">
          <Icon name="circleCheck" size={18} />
          <span>Журнал не изменён, проверено {verify.checked} записей</span>
        </div>
      )}
      {verify.state === 'fail' && (
        <div className="sec-verify is-fail" role="alert">
          <Icon name="circleX" size={18} />
          <span>
            {verify.brokenAt !== null
              ? `Нарушена целостность начиная с записи #${verify.brokenAt}`
              : 'Нарушена целостность журнала'}
            {verify.checked ? ` (проверено записей: ${verify.checked})` : ''}
          </span>
        </div>
      )}
      {verify.state === 'error' && (
        <div className="sec-verify is-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{verify.error}</span>
          <button type="button" className="sec-btn" onClick={runVerify}>Повторить</button>
        </div>
      )}

      <div className="sec-toolbar">
        <label className="sec-field">
          <span className="sec-field-label">Действие</span>
          <select className="sec-input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Все действия</option>
            {actionOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="sec-field">
          <span className="sec-field-label">Сотрудник</span>
          <input
            type="search"
            className="sec-input"
            placeholder="Часть имени"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
          />
        </label>
        <button type="button" className="sec-btn" onClick={load} disabled={loading}>
          <Icon name="refresh" size={14} /><span>Обновить</span>
        </button>
        {loaded && !error && (
          <span className="sec-muted sec-toolbar-count">
            {query ? `Найдено ${visible.length} из ${entries.length}` : `Записей: ${entries.length}`}
          </span>
        )}
      </div>

      {error && <StateLine kind="error" onRetry={load}>{error}</StateLine>}
      {!error && loading && !loaded && <StateLine kind="loading">Загружаем журнал…</StateLine>}
      {!error && loaded && visible.length === 0 && (
        <StateLine kind="empty">{query || action ? 'Нет записей по этому фильтру' : 'Записей нет'}</StateLine>
      )}

      {!error && visible.length > 0 && (
        <div className="sec-table-wrap" aria-busy={loading}>
          <table className="sec-table">
            <thead>
              <tr>
                <th scope="col">Время</th>
                <th scope="col">Сотрудник</th>
                <th scope="col">Действие</th>
                <th scope="col">IP-адрес</th>
                <th scope="col">Подробности</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const summary = summarizeDetails(entry.details);
                const full = summarizeDetails(entry.details, 2000);
                return (
                  <tr key={entry.id}>
                    <td className="sec-nowrap sec-num">{formatServerTime(entry.created_at)}</td>
                    <td>{entry.user_name ? String(entry.user_name) : <span className="sec-muted">{entry.user_id ? `#${entry.user_id}` : '—'}</span>}</td>
                    <td>
                      <span className="sec-action" title={String(entry.action ?? '')}>{actionLabel(entry.action)}</span>
                    </td>
                    <td className="sec-nowrap sec-num">{entry.ip_address ? String(entry.ip_address) : '—'}</td>
                    <td className="sec-details-cell" title={full || undefined}>{summary || <span className="sec-muted">—</span>}</td>
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

// ── Удалённый рабочий стол ─────────────────────────────────────────────────

function RemoteDesktopSection({ api, showToast }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null); // значения с сервера
  const [enabled, setEnabled] = useState(true);
  const [iceText, setIceText] = useState('');
  const [telegram, setTelegram] = useState(false);
  const [telegramGateway, setTelegramGateway] = useState(true);
  // Настройка ещё ни разу не сохранялась — сервер отдаёт свой список по
  // умолчанию. Пустое поле в этом случае не должно молча превратиться в
  // «только локальная сеть».
  const [iceUnset, setIceUnset] = useState(false);
  const [saving, setSaving] = useState(false);

  const apply = (settings) => {
    const next = {
      enabled: settings?.remote_desktop_enabled !== 'false',
      iceText: formatIceServersText(settings?.rd_ice_servers),
      telegram: settings?.security_alerts_telegram === 'true'
    };
    setSaved(next);
    setEnabled(next.enabled);
    setIceText(next.iceText);
    setTelegram(next.telegram);
    setTelegramGateway(settings?.telegram_enabled === 'true');
    setIceUnset(settings?.rd_ice_servers === undefined || settings?.rd_ice_servers === null || settings?.rd_ice_servers === '');
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      apply(await api('/api/admin/settings', { fallback: 'Не удалось загрузить настройки' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const validation = validateIceServersText(iceText);
  const keepIceDefault = iceUnset && iceText.trim() === '';
  const dirty = saved && (enabled !== saved.enabled || iceText.trim() !== saved.iceText.trim() || telegram !== saved.telegram);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!validation.ok || saving) return;
    setSaving(true);
    try {
      // Только свои ключи: остальные настройки сервера этот раздел не трогает.
      const body = {
        remote_desktop_enabled: enabled ? 'true' : 'false',
        security_alerts_telegram: telegram ? 'true' : 'false'
      };
      if (!keepIceDefault) body.rd_ice_servers = validation.value;
      await api('/api/admin/settings', { method: 'PUT', body, fallback: 'Настройки не сохранены' });
      const next = { enabled, iceText: formatIceServersText(validation.value), telegram };
      setSaved(next);
      setIceText(next.iceText);
      if (!keepIceDefault) setIceUnset(false);
      showToast?.('Настройки удалённого рабочего стола сохранены');
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <section className="sec-section" aria-labelledby="sec-rd-title">
        <h4 id="sec-rd-title" className="sec-title">Удалённый рабочий стол</h4>
        <StateLine kind="error" onRetry={load}>{error}</StateLine>
      </section>
    );
  }
  if (loading && !saved) {
    return (
      <section className="sec-section" aria-labelledby="sec-rd-title">
        <h4 id="sec-rd-title" className="sec-title">Удалённый рабочий стол</h4>
        <StateLine kind="loading">Загружаем настройки…</StateLine>
      </section>
    );
  }

  return (
    <section className="sec-section" aria-labelledby="sec-rd-title">
      <div className="sec-section-head">
        <div>
          <h4 id="sec-rd-title" className="sec-title">Удалённый рабочий стол</h4>
          <p className="sec-subtitle">Действует для всех сотрудников. Запрет на отдельном компьютере задаётся файлом политики на нём.</p>
        </div>
      </div>

      <form className="sec-form" onSubmit={handleSave}>
        <label className="sec-switch">
          <input type="checkbox" role="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="sec-switch-track" aria-hidden="true" />
          <span className="sec-switch-text">
            <span className="sec-switch-label">Разрешить удалённый рабочий стол</span>
            <span className="sec-switch-hint">
              {enabled
                ? 'Операторы с правом «Удалённый рабочий стол» могут запрашивать доступ к экрану сотрудника.'
                : 'Кнопки подключения скрыты, запросы отклоняются сервером и приложением сотрудника.'}
            </span>
          </span>
        </label>

        <div className="sec-field sec-field-block">
          <label className="sec-field-label" htmlFor="sec-ice-servers">Серверы соединения (ICE), JSON</label>
          <textarea
            id="sec-ice-servers"
            className="sec-input sec-textarea"
            rows={6}
            spellCheck={false}
            value={iceText}
            placeholder={'[\n  { "urls": "turn:turn.company.kz:3478", "username": "…", "credential": "…" }\n]'}
            aria-invalid={!validation.ok}
            aria-describedby="sec-ice-hint"
            onChange={(e) => setIceText(e.target.value)}
          />
          <div id="sec-ice-hint" className={validation.ok ? 'sec-field-hint' : 'sec-field-error'}>
            {!validation.ok
              ? validation.error
              : keepIceDefault
              ? 'Не задано — сервер использует свой список по умолчанию. Чтобы оставить только локальную сеть, введите [].'
              : validation.servers.length
              ? `Серверов: ${validation.servers.length}. Пусто — только локальная сеть, без внешних серверов.`
              : 'Пусто — только локальная сеть, без внешних серверов.'}
          </div>
        </div>

        <label className="sec-switch">
          <input type="checkbox" role="switch" checked={telegram} onChange={(e) => setTelegram(e.target.checked)} />
          <span className="sec-switch-track" aria-hidden="true" />
          <span className="sec-switch-text">
            <span className="sec-switch-label">Отправлять оповещения безопасности в Telegram</span>
            <span className="sec-switch-hint">
              {telegramGateway
                ? 'В чат оповещений, указанный в разделе «Настройки».'
                : 'Шлюз Telegram выключен в разделе «Настройки» — пока он выключен, оповещения туда не уходят.'}
            </span>
          </span>
        </label>

        <div className="sec-form-actions">
          <button type="submit" className="sec-btn sec-btn-primary" disabled={!validation.ok || !dirty || saving}>
            <Icon name="save" size={14} /><span>{saving ? 'Сохраняем…' : 'Сохранить'}</span>
          </button>
          {dirty && !saving && (
            <button type="button" className="sec-btn" onClick={() => {
              setEnabled(saved.enabled);
              setIceText(saved.iceText);
              setTelegram(saved.telegram);
            }}>
              Отменить изменения
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

// ── Раздел целиком ─────────────────────────────────────────────────────────

export default function SecurityCenter({ serverUrl, currentUser, liveAlerts = [], showToast, onAlertAcknowledged }) {
  const api = useApi(serverUrl);
  const [section, setSection] = useState('status');
  const tabRefs = useRef({});
  const liveUnacked = countUnacknowledged(liveAlerts);

  // Стрелки переключают разделы, как в обычных вкладках.
  const onTabKeyDown = (e) => {
    const index = SECTIONS.findIndex((s) => s.id === section);
    let next = null;
    if (e.key === 'ArrowRight') next = (index + 1) % SECTIONS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SECTIONS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const id = SECTIONS[next].id;
    setSection(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <div className="sec-center">
      <h3 className="sec-page-title">Безопасность</h3>
      <div className="sec-tabs" role="tablist" aria-label="Разделы безопасности">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            ref={(el) => { tabRefs.current[s.id] = el; }}
            type="button"
            role="tab"
            id={`sec-tab-${s.id}`}
            aria-selected={section === s.id}
            aria-controls={`sec-panel-${s.id}`}
            tabIndex={section === s.id ? 0 : -1}
            className={`sec-tab ${section === s.id ? 'is-active' : ''}`}
            onClick={() => setSection(s.id)}
            onKeyDown={onTabKeyDown}
          >
            <Icon name={s.icon} size={15} />
            <span>{s.label}</span>
            {s.id === 'alerts' && liveUnacked > 0 && (
              <span className="sec-tab-badge" aria-label={`новых: ${liveUnacked}`}>{liveUnacked}</span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`sec-panel-${section}`} aria-labelledby={`sec-tab-${section}`} className="sec-panel">
        {section === 'status' && <StatusSection api={api} />}
        {section === 'alerts' && <AlertsSection api={api} liveAlerts={liveAlerts} currentUser={currentUser} showToast={showToast} onAlertAcknowledged={onAlertAcknowledged} />}
        {section === 'audit' && <AuditSection api={api} />}
        {section === 'rd' && <RemoteDesktopSection api={api} showToast={showToast} />}
      </div>
    </div>
  );
}
