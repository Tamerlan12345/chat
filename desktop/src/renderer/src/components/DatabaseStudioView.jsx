import React, { useState, useEffect } from 'react';

export default function DatabaseStudioView({ token, serverUrl = '' }) {
  const [stats, setStats] = useState(null);
  const [tables, setTables] = useState([]);
  const [selectedTable, setSelectedTable] = useState(null);
  const [tableData, setTableData] = useState(null);
  const [tableSchema, setTableSchema] = useState(null);
  // Пример ссылался на таблицу users, которой в базе переписки больше нет:
  // учётные записи вынесены в отдельное хранилище и отсюда недостижимы.
  const [sqlQuery, setSqlQuery] = useState(
    'SELECT id, conversation_type, target_id, sender_id, substr(text, 1, 60) AS text, created_at FROM messages ORDER BY id DESC LIMIT 20;'
  );
  const [queryResult, setQueryResult] = useState(null);
  const [backups, setBackups] = useState([]);
  const [backupLoading, setBackupLoading] = useState(false);
  const [downloading, setDownloading] = useState(null);
  const [activeTab, setActiveTab] = useState('browser'); // 'browser' | 'sql' | 'backups'

  // Резервная копия отдаётся только с токеном в заголовке, а обычная ссылка
  // заголовков не шлёт — кнопка «Скачать» молча отвечала отказом. Забираем
  // файл запросом и отдаём его браузеру уже готовым.
  const downloadBackup = async (fileName) => {
    setDownloading(fileName);
    try {
      const res = await fetch(`${serverUrl}/api/admin/db/backups/${encodeURIComponent(fileName)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        alert(res.status === 401 ? 'Сессия истекла — войдите заново' : 'Не удалось скачать копию');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Ссылку на объект надо отпустить, иначе файл целиком останется в памяти
      // окна до его закрытия.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      alert('Не удалось скачать копию: ' + err.message);
    } finally {
      setDownloading(null);
    }
  };

  const loadStats = async () => {
    try {
      const res = await fetch(serverUrl + '/api/admin/db/stats', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Stats error:', err);
    }
  };

  const loadTables = async () => {
    try {
      const res = await fetch(serverUrl + '/api/admin/db/tables', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setTables(data);
      if (data.length > 0 && !selectedTable) {
        selectTable(data[0].name);
      }
    } catch (err) {
      console.error('Tables error:', err);
    }
  };

  const loadBackups = async () => {
    try {
      const res = await fetch(serverUrl + '/api/admin/db/backups', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setBackups(data);
    } catch (err) {
      console.error('Backups error:', err);
    }
  };

  const selectTable = async (tableName) => {
    setSelectedTable(tableName);
    try {
      const [schemaRes, dataRes] = await Promise.all([
        fetch(`${serverUrl}/api/admin/db/tables/${tableName}/schema`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${serverUrl}/api/admin/db/tables/${tableName}/data?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
      ]);
      setTableSchema(await schemaRes.json());
      setTableData(await dataRes.json());
    } catch (err) {
      console.error('Table fetch error:', err);
    }
  };

  useEffect(() => {
    loadStats();
    loadTables();
    loadBackups();
  }, [token]);

  const handleExecuteSql = async (e) => {
    e?.preventDefault();
    if (!sqlQuery.trim()) return;

    try {
      const res = await fetch(serverUrl + '/api/admin/db/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ sql: sqlQuery })
      });
      const data = await res.json();
      setQueryResult(data);
      loadStats();
      loadTables();
    } catch (err) {
      setQueryResult({ error: err.message });
    }
  };

  const handleCreateBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await fetch(serverUrl + '/api/admin/db/backup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      alert(`Резервная копия базы успешно создана:\n${data.fileName} (${data.sizeFormatted})`);
      loadBackups();
    } catch (err) {
      alert(`Ошибка создания бэкапа: ${err.message}`);
    } finally {
      setBackupLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top Banner */}
      <div style={{
        height: '60px',
        padding: '0 24px',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'var(--bg-panel)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ fontSize: '18px', fontWeight: 700, color: '#93c5fd' }}>🛠️ Web Database Studio (SQLite)</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className={`btn btn-sm ${activeTab === 'browser' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('browser')}
            >
              📊 Таблицы и данные
            </button>
            <button
              className={`btn btn-sm ${activeTab === 'sql' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('sql')}
            >
              ⌨️ SQL Консоль
            </button>
            <button
              className={`btn btn-sm ${activeTab === 'backups' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('backups')}
            >
              💾 Бэкапы ({backups.length})
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleCreateBackup}
            disabled={backupLoading}
            style={{ backgroundColor: '#10b981' }}
          >
            {backupLoading ? 'Создание...' : '⚡ Создать бэкап сейчас'}
          </button>
        </div>
      </div>

      {/* Database Quick Health Badges */}
      {stats && (
        <div style={{
          padding: '10px 24px',
          backgroundColor: 'var(--bg-sidebar)',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          gap: '20px',
          fontSize: '12px',
          color: 'var(--text-muted)'
        }}>
          <div>Файл БД: <strong style={{ color: '#ffffff' }}>{stats.dbPath}</strong></div>
          <div>Размер: <strong style={{ color: '#10b981' }}>{stats.dbSizeFormatted}</strong></div>
          <div>WAL журнал: <strong style={{ color: '#60a5fa' }}>{stats.walSizeFormatted}</strong></div>
          <div>Режим: <strong style={{ color: '#ffffff' }}>{stats.journalMode.toUpperCase()}</strong></div>
          <div>Целостность: <strong style={{ color: '#10b981' }}>{stats.integrity}</strong></div>
          <div>Всего записей: <strong style={{ color: '#ffffff' }}>{stats.totalRows}</strong></div>
        </div>
      )}

      {/* Tab: Table Browser */}
      {activeTab === 'browser' && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Tables Sidebar */}
          <div className="sub-panel" style={{ width: '260px' }}>
            <div className="sub-panel-header">
              <span className="sub-panel-title">Таблицы ({tables.length})</span>
            </div>
            <div className="sub-panel-content">
              {tables.map(t => (
                <div
                  key={t.name}
                  className={`tree-node ${selectedTable === t.name ? 'active' : ''}`}
                  onClick={() => selectTable(t.name)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 14px',
                    backgroundColor: selectedTable === t.name ? 'var(--bg-active)' : 'transparent',
                    color: selectedTable === t.name ? '#ffffff' : 'var(--text-main)'
                  }}
                >
                  <span style={{ fontWeight: 500, fontSize: '13px' }}>📁 {t.name}</span>
                  <span style={{ fontSize: '11px', opacity: 0.8 }}>{t.rowCount}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Table Data Grid */}
          <div className="content-area" style={{ padding: '20px', overflowY: 'auto' }}>
            {selectedTable && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: '16px', fontWeight: 600 }}>Таблица: <span style={{ color: '#60a5fa' }}>{selectedTable}</span></h3>
                  <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>Всего строк: {tableData?.total || 0}</span>
                </div>

                {/* Columns Schema */}
                {tableSchema && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '8px', backgroundColor: 'var(--bg-sidebar)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
                    {tableSchema.columns.map(c => (
                      <span key={c.name} style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', backgroundColor: 'var(--bg-card)', color: c.pk ? '#f59e0b' : 'var(--text-muted)' }}>
                        {c.pk ? '🔑 ' : ''}<strong>{c.name}</strong>: {c.type}
                      </span>
                    ))}
                  </div>
                )}

                {/* Rows Grid */}
                <div style={{ overflowX: 'auto', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ backgroundColor: 'var(--bg-sidebar)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-dim)' }}>
                        {(tableSchema?.columns || []).map(c => (
                          <th key={c.name} style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{c.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(tableData?.rows || []).map((row, rIdx) => (
                        <tr key={rIdx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          {(tableSchema?.columns || []).map(c => (
                            <td key={c.name} style={{ padding: '8px 12px', whiteSpace: 'nowrap', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {row[c.name] === null ? <span style={{ color: 'var(--text-dim)' }}>NULL</span> : String(row[c.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab: SQL Console */}
      {activeTab === 'sql' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '24px', gap: '16px', overflowY: 'auto' }}>
          <form onSubmit={handleExecuteSql} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: '13px', fontWeight: 600 }}>SQL Запрос:</label>
              <button type="submit" className="btn btn-primary btn-sm">
                ▶ Выполнить SQL
              </button>
            </div>
            <textarea
              className="search-input"
              rows={5}
              style={{ fontFamily: 'monospace', fontSize: '13px', backgroundColor: '#0f172a' }}
              value={sqlQuery}
              onChange={(e) => setSqlQuery(e.target.value)}
              placeholder="Введите SQL запрос, например: SELECT * FROM messages ORDER BY id DESC LIMIT 20;"
            />
          </form>

          {queryResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {queryResult.error ? (
                <div style={{ padding: '12px', backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: 'var(--radius-md)' }}>
                  Ошибка выполнения: {queryResult.error}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                    Время выполнения: <strong>{queryResult.executionTimeMs} мс</strong> | Строк: <strong>{queryResult.rowCount ?? queryResult.changes}</strong>
                  </div>

                  {queryResult.rows && queryResult.rows.length > 0 && (
                    <div style={{ overflowX: 'auto', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead>
                          <tr style={{ backgroundColor: 'var(--bg-sidebar)', borderBottom: '1px solid var(--border-color)' }}>
                            {queryResult.columns.map(col => (
                              <th key={col} style={{ padding: '8px 12px', textAlign: 'left' }}>{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {queryResult.rows.map((r, idx) => (
                            <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                              {queryResult.columns.map(col => (
                                <td key={col} style={{ padding: '6px 12px', whiteSpace: 'nowrap' }}>
                                  {r[col] === null ? 'NULL' : String(r[col])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab: Backups Manager */}
      {activeTab === 'backups' && (
        <div style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>
            💾 Резервные копии базы данных
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {backups.map(b => (
              <div
                key={b.fileName}
                style={{
                  backgroundColor: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px', color: '#ffffff' }}>{b.fileName}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '2px' }}>
                    Создан: {new Date(b.createdAt).toLocaleString()} · Размер: {b.sizeFormatted}
                  </div>
                </div>

                <button
                  className="btn btn-secondary btn-sm"
                  disabled={downloading === b.fileName}
                  onClick={() => downloadBackup(b.fileName)}
                >
                  {downloading === b.fileName ? 'Скачиваем…' : '⬇️ Скачать .db файл'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
