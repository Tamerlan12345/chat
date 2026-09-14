import React, { useState } from 'react';

export default function ServerConnectModal({ currentUrl, onClose, onApplyServer }) {
  const parseUrl = (rawUrl) => {
    try {
      const u = new URL(rawUrl.startsWith('http') ? rawUrl : 'http://' + rawUrl);
      return {
        protocol: u.protocol.replace(':', ''),
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? '443' : '2004')
      };
    } catch {
      return { protocol: 'http', host: 'localhost', port: '2004' };
    }
  };

  const initial = parseUrl(currentUrl || 'http://localhost:2004');
  const [protocol, setProtocol] = useState(initial.protocol);
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(initial.port);

  const [pingState, setPingState] = useState({
    status: 'idle',
    latencyMs: null,
    info: null,
    error: null
  });

  const presets = [
    {
      id: 'local',
      title: 'Локальный ПК',
      host: 'localhost',
      port: '2004',
      protocol: 'http',
      desc: '127.0.0.1:2004'
    },
    {
      id: 'lan',
      title: 'Centras Офис LAN',
      host: '192.168.10.15',
      port: '2004',
      protocol: 'http',
      desc: 'Интранет СК «Сентрас»'
    },
    {
      id: 'domain',
      title: 'Centras Облако/WAN',
      // Live Railway deployment. Point this at ch.cic.kz instead once that
      // domain is actually configured to resolve to it — see
      // knowledge/Architecture/Architecture - Server Deployment and Connection.md
      host: 'chat-production-0456.up.railway.app',
      port: '',
      protocol: 'https',
      desc: 'Railway — внешний корпоративный шлюз'
    }
  ];

  const fullUrl = `${protocol}://${host}${port ? ':' + port : ''}`;

  const applyPreset = (p) => {
    setProtocol(p.protocol);
    setHost(p.host);
    setPort(p.port);
    setPingState({ status: 'idle', latencyMs: null, info: null, error: null });
  };

  const handleTestConnection = async () => {
    setPingState({ status: 'testing', latencyMs: null, info: null, error: null });
    const targetUrl = `${protocol}://${host}${port ? ':' + port : ''}`;
    const startTime = performance.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(`${targetUrl}/api/settings/info`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const endTime = performance.now();
      const latency = Math.round(endTime - startTime);

      if (res.ok) {
        const data = await res.json();
        setPingState({
          status: 'success',
          latencyMs: latency,
          info: data,
          error: null
        });
      } else {
        setPingState({
          status: 'error',
          latencyMs: latency,
          info: null,
          error: 'HTTP ' + res.status + ': ' + res.statusText
        });
      }
    } catch (err) {
      const endTime = performance.now();
      const latency = Math.round(endTime - startTime);
      setPingState({
        status: 'error',
        latencyMs: latency,
        info: null,
        error: err.name === 'AbortError' ? 'Таймаут (сервер не ответил за 4 сек)' : 'Сетевая ошибка: ' + err.message
      });
    }
  };

  const handleSave = () => {
    if (!host.trim()) return;
    const cleanUrl = `${protocol}://${host.trim()}${port ? ':' + port : ''}`;
    onApplyServer(cleanUrl);
    onClose();
  };

  return (
    <div className="server-connect-overlay" onClick={onClose}>
      <div className="server-connect-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="server-connect-header">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7ca1f3" strokeWidth="2" strokeLinecap="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
            Подключение к серверу MyChat
          </h3>
          <button className="server-connect-close-btn" onClick={onClose} title="Закрыть">✕</button>
        </div>

        <div className="server-connect-body">
          <div className="server-input-group">
            <label>Быстрые профили подключения:</label>
            <div className="server-preset-grid">
              {presets.map((p) => {
                const isActive = host === p.host && port === p.port && protocol === p.protocol;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`server-preset-btn ${isActive ? 'active' : ''}`}
                    onClick={() => applyPreset(p)}
                  >
                    <span className="preset-title">{p.title}</span>
                    <span className="preset-addr">{p.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="server-input-group">
            <label>Сетевой адрес сервера (IP или доменное имя):</label>
            <div className="server-input-row">
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
                style={{
                  padding: '8px',
                  border: '1px solid rgba(126, 151, 180, 0.38)',
                  borderRadius: '5px',
                  fontSize: '13px',
                  background: '#313338',
                  outline: 'none'
                }}
              >
                <option value="http">http://</option>
                <option value="https">https://</option>
              </select>

              <input
                type="text"
                className="server-input-field"
                placeholder="192.168.1.100 или ch.cic.kz"
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  setPingState({ status: 'idle', latencyMs: null, info: null, error: null });
                }}
              />

              <input
                type="text"
                className="server-port-field"
                placeholder="2004"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                  setPingState({ status: 'idle', latencyMs: null, info: null, error: null });
                }}
                title="Порт сервера (по умолчанию 2004)"
              />
            </div>
          </div>

          <div className="server-ping-card">
            <div className="server-ping-info">
              <span className="server-ping-title">
                Целевой узел: <strong>{fullUrl}</strong>
              </span>
              <span className="server-ping-detail">
                {pingState.status === 'idle' && 'Нажмите «Проверить связь» для замера задержки и проверки готовности службы.'}
                {pingState.status === 'testing' && 'Отправка эхо-запроса TCP/HTTP на порт сервера...'}
                {pingState.status === 'success' && (
                  <>
                    Сервер доступен! {pingState.info?.server_name || 'MyChat Server'} — {pingState.info?.company_name || 'АО СК Сентрас'}
                  </>
                )}
                {pingState.status === 'error' && (
                  <span style={{ color: '#ec8383' }}>
                    Не удалось подключиться: {pingState.error}
                  </span>
                )}
              </span>
            </div>

            {pingState.status === 'testing' && (
              <span className="server-ping-badge testing">Замер...</span>
            )}
            {pingState.status === 'success' && (
              <span className={`server-ping-badge ${pingState.latencyMs < 60 ? 'good' : 'warning'}`}>
                {pingState.latencyMs} мс
              </span>
            )}
            {pingState.status === 'error' && (
              <span className="server-ping-badge bad">Ошибка</span>
            )}
          </div>
        </div>

        <div className="server-connect-footer">
          <button
            type="button"
            className="btn-secondary"
            onClick={handleTestConnection}
            disabled={pingState.status === 'testing'}
          >
            {pingState.status === 'testing' ? 'Проверка...' : '⚡ Проверить связь'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
          >
            Отмена
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
          >
            Подключиться
          </button>
        </div>
      </div>
    </div>
  );
}
