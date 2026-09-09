import React, { useState, useEffect, useRef } from 'react';

export default function RemoteDesktopViewer({ sessionId, targetUser, wsClient, onEndSession }) {
  const [scaleMode, setScaleMode] = useState('fit');
  const [latency, setLatency] = useState(null);
  const [fps, setFps] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [statusText, setStatusText] = useState('Ожидание подтверждения сотрудником...');
  const [accessLevel, setAccessLevel] = useState('full');
  const [isRejected, setIsRejected] = useState(false);

  const videoRef = useRef(null);
  const peerConnectionRef = useRef(null);

  useEffect(() => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peerConnectionRef.current = pc;

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
        setStatusText('Подключено');
        if (videoRef.current) {
          videoRef.current.srcObject = event.streams[0];
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({
          type: 'rd_ice_candidate',
          sessionId,
          targetUserId: targetUser.id,
          candidate: event.candidate
        }));
      }
    };

    const handleWsMessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.sessionId !== sessionId) return;

        if (msg.type === 'rd_response') {
          if (!msg.accepted) {
            setIsRejected(true);
            setStatusText('Сотрудник отклонил запрос на удаленный доступ.');
          } else {
            setStatusText('Сотрудник разрешил доступ. Запуск видеопотока 60 FPS...');
            if (msg.accessLevel) setAccessLevel(msg.accessLevel);
          }
        } else if (msg.type === 'rd_webrtc_offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({
              type: 'rd_webrtc_answer',
              sessionId,
              targetUserId: targetUser.id,
              sdp: answer
            }));
          }
        } else if (msg.type === 'rd_ice_candidate' && msg.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else if (msg.type === 'rd_end') {
          alert('Сеанс удаленного рабочего стола завершен пользователем.');
          onEndSession();
        }
      } catch (err) {
        console.error('RD message error:', err);
      }
    };

    if (wsClient) {
      wsClient.addEventListener('message', handleWsMessage);
    }

    // Latency and FPS used to be invented here with Math.random() on a timer
    // and displayed as measurements — they read as a healthy 8-16 ms / 60 fps
    // even when no stream existed at all. Real figures have to come from the
    // WebRTC connection (RTCPeerConnection.getStats), so until the stream is
    // wired up nothing is claimed.

    return () => {
      if (wsClient) {
        wsClient.removeEventListener('message', handleWsMessage);
      }
      pc.close();
    };
  }, [sessionId, targetUser, wsClient, onEndSession]);

  const sendInputEvent = (inputEvent) => {
    if (accessLevel !== 'full') return;
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({
        type: 'rd_input_event',
        sessionId,
        targetUserId: targetUser.id,
        event: inputEvent
      }));
    }
  };

  const handleMouseMove = (e) => {
    const rect = videoRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width).toFixed(4);
    const y = ((e.clientY - rect.top) / rect.height).toFixed(4);
    sendInputEvent({ type: 'mousemove', x, y });
  };

  const handleMouseDown = (e) => {
    sendInputEvent({ type: 'mousedown', button: e.button });
  };

  const handleMouseUp = (e) => {
    sendInputEvent({ type: 'mouseup', button: e.button });
  };

  const handleKeyDown = (e) => {
    sendInputEvent({ type: 'keydown', key: e.key, code: e.code });
  };

  return (
    <div className="rd-viewer-container">
      <div className="rd-viewer-toolbar">
        <div className="rd-toolbar-left">
          <span className="rd-status-indicator online">●</span>
          <span className="rd-user-title">
            {targetUser.full_name || targetUser.username}
          </span>
          <span className="rd-badge">
            {accessLevel === 'full' ? '🎮 Полный доступ' : '👁️ Только просмотр'}
          </span>
        </div>

        <div className="rd-toolbar-center">
          <span className="rd-metric-item">Задержка: <strong>{latency === null ? '—' : `${latency} мс`}</strong></span>
          <span className="rd-metric-item">Частота: <strong>{fps === null ? '—' : `${fps} FPS`}</strong></span>
          <span className="rd-metric-item">Кодек: <strong>H.264 WebRTC</strong></span>
        </div>

        <div className="rd-toolbar-right">
          <button
            className="rd-btn"
            title="Отправить Ctrl+Alt+Del"
            disabled={accessLevel !== 'full'}
            onClick={() => sendInputEvent({ type: 'hotkey', hotkey: 'ctrl_alt_del' })}
          >
            Ctrl+Alt+Del
          </button>
          <button
            className="rd-btn"
            onClick={() => setScaleMode(scaleMode === 'fit' ? 'original' : 'fit')}
          >
            {scaleMode === 'fit' ? 'Масштаб 1:1' : 'По размеру'}
          </button>
          <button className="rd-btn-danger" onClick={onEndSession}>
            ✕ Завершить сеанс
          </button>
        </div>
      </div>

      <div
        className="rd-video-area"
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onKeyDown={handleKeyDown}
      >
        {remoteStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className={'rd-video-stream ' + (scaleMode === 'fit' ? 'fit' : 'original')}
          />
        ) : (
          <div className="rd-connecting-overlay">
            {isRejected ? (
              <div className="rd-rejected-box">
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>⛔</div>
                <h3 style={{ color: '#ef4444', marginBottom: '8px' }}>Запрос отклонен</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
                  Сотрудник {targetUser.full_name} отклонил запрос на удаленный рабочий стол.
                </p>
                <button className="btn btn-secondary" onClick={onEndSession}>
                  Закрыть окно
                </button>
              </div>
            ) : (
              <div className="rd-loading-box">
                <div className="rd-spinner" />
                <h3 style={{ marginTop: '16px', color: '#f8fafc' }}>Удаленный рабочий стол</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px' }}>{statusText}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
