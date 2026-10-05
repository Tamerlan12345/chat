import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { useConfirm } from './ConfirmDialog';
import { useAdminApi } from './useAdminApi';
import { createRequestSequence } from '../lib/admin-access.mjs';
import {
  REPORT_FILTERS,
  reportsPath,
  reportStatusLabel,
  describeReportTarget,
  previewText,
  formatAdminDate
} from '../lib/registration-admin.mjs';

const EMPTY_TEXT = {
  open: 'Открытых жалоб нет. Когда сотрудник пожалуется на сообщение или на другого сотрудника, жалоба появится здесь.',
  closed: 'Закрытых жалоб пока нет. Жалоба попадает сюда после нажатия «Закрыть».',
  all: 'Жалоб пока нет. Когда сотрудник пожалуется на сообщение или на другого сотрудника, жалоба появится здесь.'
};

// Вкладка «Жалобы» (только суперадминистратор): жалобы пользователей на
// сообщения и на других сотрудников; закрытие означает «рассмотрено».
export default function ReportsAdmin({ serverUrl, showToast }) {
  const api = useAdminApi(serverUrl);
  const [confirm, confirmDialog] = useConfirm();
  const [filter, setFilter] = useState('open');
  const [reports, setReports] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [closingId, setClosingId] = useState(null);
  // Ответы на быстрое переключение фильтра приходят в произвольном порядке.
  const sequence = useRef(createRequestSequence());

  const load = useCallback(async (which) => {
    const id = sequence.current.next();
    setLoadError('');
    setReports(null);
    try {
      const rows = await api(reportsPath(which), { fallback: 'Не удалось загрузить жалобы' });
      if (sequence.current.isCurrent(id)) setReports(Array.isArray(rows) ? rows : []);
    } catch (err) {
      if (sequence.current.isCurrent(id)) setLoadError(err.message);
    }
  }, [api]);

  useEffect(() => { load(filter); }, [load, filter]);

  const close = async (report) => {
    const target = describeReportTarget(report);
    const confirmed = await confirm({
      title: 'Закрыть жалобу',
      message:
        `Закрыть жалобу №${report.id} от «${report.reporter?.name}» на ${target.kind === 'Сообщение' ? 'сообщение пользователя' : 'пользователя'} «${target.who}»?\n` +
        'Закрытая жалоба считается рассмотренной и уходит из списка открытых.',
      confirmText: 'Закрыть жалобу'
    });
    if (!confirmed) return;
    setClosingId(report.id);
    try {
      await api(`/api/admin/reports/${report.id}/close`, { method: 'POST', fallback: 'Не удалось закрыть жалобу' });
      showToast?.(`Жалоба №${report.id} закрыта`);
      await load(filter);
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setClosingId(null);
    }
  };

  return (
    <div className="sec-center">
      <h3 className="sec-page-title">Жалобы</h3>
      <p className="sec-subtitle" style={{ marginTop: -6 }}>
        Жалобы сотрудников на сообщения и на других сотрудников. Рассмотрев жалобу, закройте её —
        так в списке остаются только те, что ещё ждут решения.
      </p>

      <div className="sec-tabs" role="tablist" aria-label="Фильтр жалоб">
        {REPORT_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={`sec-tab${filter === item.id ? ' is-active' : ''}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loadError ? (
        <div className="sec-state sec-state-error" role="alert">
          <Icon name="circleX" size={16} />
          <span>{loadError}</span>
          <button type="button" className="sec-btn" onClick={() => load(filter)}>Повторить</button>
        </div>
      ) : reports === null ? (
        <div className="sec-state sec-state-loading" role="status">
          <span className="sec-spinner" aria-hidden="true" />
          <span>Загружаем жалобы…</span>
        </div>
      ) : reports.length === 0 ? (
        <div className="sec-state sec-state-empty">
          <Icon name="info" size={16} />
          <span>{EMPTY_TEXT[filter]}</span>
        </div>
      ) : (
        <div className="sec-table-wrap">
          <table className="sec-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>От кого</th>
                <th>На кого или что</th>
                <th>Причина</th>
                <th>Статус</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => {
                const target = describeReportTarget(report);
                const isOpen = report.status === 'open';
                return (
                  <tr key={report.id}>
                    <td className="sec-nowrap sec-num">{formatAdminDate(report.createdAt)}</td>
                    <td>{report.reporter?.name || '—'}</td>
                    <td className="sec-details-cell">
                      <div><strong>{target.kind}</strong>: {target.who}</div>
                      {target.kind === 'Сообщение' && (
                        <div className="sec-muted">
                          {target.text ? `«${previewText(target.text, 140)}»` : 'текст недоступен — сообщение удалено'}
                        </div>
                      )}
                    </td>
                    <td className="sec-details-cell">
                      <div>{report.reason}</div>
                      {report.details && <div className="sec-muted">{previewText(report.details, 200)}</div>}
                    </td>
                    <td>
                      <span className={`rep-status ${isOpen ? 'is-open' : 'is-closed'}`}>
                        <Icon name={isOpen ? 'alert' : 'circleCheck'} size={12} />
                        <span>{reportStatusLabel(report.status)}</span>
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {isOpen && (
                        <button
                          type="button"
                          className="sec-btn"
                          disabled={closingId === report.id}
                          onClick={() => close(report)}
                          aria-label={`Закрыть жалобу №${report.id}`}
                        >
                          <Icon name="check" size={13} /><span>Закрыть</span>
                        </button>
                      )}
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
