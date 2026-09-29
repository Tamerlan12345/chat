import React, { useState } from 'react';
import Icon from './Icon';

// Сервер — только по https. По http пароль, токен и вся переписка идут в
// открытую, а подменить такой сервер может любой в той же сети. http остаётся
// лишь для сервера на своей машине в разработке; собранное приложение такие
// запросы и само не выпускает.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const ALLOW_LOCAL_HTTP =
  Boolean(import.meta.env.DEV) ||
  (window.location.protocol === 'http:' && LOCAL_HOSTS.includes(window.location.hostname));
const DEFAULT_HOST = 'chat-production-0456.up.railway.app';

function isAllowedServerUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ALLOW_LOCAL_HTTP && LOCAL_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

export default function ServerConnectModal({ currentUrl, onClose, onApplyServer }) {
  const parseUrl = (rawUrl) => {
    try {
      const u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
      if (!isAllowedServerUrl(u.toString())) throw new Error('insecure');
      return {
        protocol: u.protocol.replace(':', ''),
        host: u.hostname,
        port: u.port
      };
    } catch {
      return { protocol: 'https', host: DEFAULT_HOST, port: '' };
    }
  };

  const initial = parseUrl(currentUrl || 'https://' + DEFAULT_HOST);
  const [protocol, setProtocol] = useState(initial.protocol);
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(initial.port);

  const [pingState, setPingState] = useState({
    status: 'idle',
    latencyMs: null,
    info: null,
    error: null
  });

  // Профиль офисной сети по http убран: в рабочей сборке он не открылся бы.
  const presets = [
    ...(ALLOW_LOCAL_HTTP
      ? [{
          id: 'local',
          title: 'Локальный ПК',
          host: 'localhost',
          port: '2004',
          protocol: 'http',
          desc: '127.0.0.1:2004 · только разработка'
        }]
      : []),
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
  const urlAllowed = Boolean(host.trim()) && isAllowedServerUrl(`${protocol}://${host.trim()}${port ? ':' + port : ''}`);

  const applyPreset = (p) => {
    setProtocol(p.protocol);
    setHost(p.host);
    setPort(p.port);
    setPingState({ status: 'idle', latencyMs: null, info: null, error: null });
  };

  const handleTestConnection = async () => {
    if (!urlAllowed) {
      setPingState({ status: 'error', latencyMs: null, info: null, error: 'разрешено только защищённое подключение (https)' });
      return;
    }
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
    if (!isAllowedServerUrl(cleanUrl)) {
      setPingState({ status: 'error', latencyMs: null, info: null, error: 'разрешено только защищённое подключение (https)' });
      return;
    }
    onApplyServer(cleanUrl);
    onClose();
  };

  return (
    <div className="server-connect-overlay" onClick={onClose}>
      <div className="server-connect-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="server-connect-header">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: "light-dark(#2563eb, #7ca1f3)" }} strokeWidth="2" strokeLinecap="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
            Подключение к серверу CentyChat
          </h3>
          <button className="server-connect-close-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть"><Icon name="x" size={16} /></button>
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
                  border: '1px solid light-dark(#cbd5e1, rgba(126, 151, 180, 0.38))',
                  borderRadius: '5px',
                  fontSize: '13px',
                  background: 'light-dark(#f8fafc, #313338)',
                  outline: 'none'
                }}
              >
                <option value="https">https://</option>
                {ALLOW_LOCAL_HTTP && <option value="http">http:// (только localhost)</option>}
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
                placeholder="443"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                  setPingState({ status: 'idle', latencyMs: null, info: null, error: null });
                }}
                title="Порт сервера (пусто — 443)"
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
                    Сервер доступен! {pingState.info?.server_name || 'CentyChat Server'} — {pingState.info?.company_name || 'АО СК Сентрас'}
                  </>
                )}
                {pingState.status === 'error' && (
                  <span style={{ color: 'light-dark(#b91c1c, #ec8383)' }}>
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
            {pingState.status === 'testing' ? 'Проверка...' : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Icon name="zap" size={14} /> Проверить связь
              </span>
            )}
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
            disabled={!urlAllowed}
          >
            Подключиться
          </button>
        </div>
      </div>
    </div>
  );
}
