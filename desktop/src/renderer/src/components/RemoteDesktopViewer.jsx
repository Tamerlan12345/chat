import React, { useState, useEffect, useRef } from 'react';

export default function RemoteDesktopViewer({ sessionId, targetUser, wsClient, pendingOffer, onEndSession }) {
  const [scaleMode, setScaleMode] = useState('fit');
  const [latency, setLatency] = useState(null);
  const [fps, setFps] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [statusText, setStatusText] = useState('Устанавливаем соединение с экраном сотрудника…');
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

    // Answers an offer exactly once — the same offer can arrive both buffered
    // from App (sent before this component existed) and through the live
    // listener below, and answering twice throws on the peer connection.
    let offerAnswered = false;
    const answerOffer = async (sdp) => {
      if (offerAnswered) return;
      offerAnswered = true;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
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
    };

    if (pendingOffer && pendingOffer.sessionId === sessionId) {
      answerOffer(pendingOffer.sdp).catch((err) => console.error('RD offer error:', err));
    }

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
          await answerOffer(msg.sdp);
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

  const canControl = accessLevel === 'full';

  // Переводит точку окна в долю кадра (0..1). Видео вписано с сохранением
  // пропорций, поэтому по краям остаются поля — считать от размеров элемента
  // напрямую нельзя, курсор уезжал бы тем сильнее, чем сильнее отличаются
  // пропорции экранов. Точки на полях отбрасываются: там экрана нет.
  const pointToFrame = (clientX, clientY) => {
    const video = videoRef.current;
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !rect.width || !rect.height) return null;

    const scale = Math.min(rect.width / vw, rect.height / vh);
    const shownW = vw * scale;
    const shownH = vh * scale;
    const offsetX = (rect.width - shownW) / 2;
    const offsetY = (rect.height - shownH) / 2;

    const x = (clientX - rect.left - offsetX) / shownW;
    const y = (clientY - rect.top - offsetY) / shownH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  const MOUSE_BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };

  const handleMouseMove = (e) => {
    if (!canControl) return;
    const point = pointToFrame(e.clientX, e.clientY);
    if (point) sendInputEvent({ type: 'move', x: point.x, y: point.y });
  };

  const handleMouseDown = (e) => {
    if (!canControl) return;
    e.preventDefault();
    const point = pointToFrame(e.clientX, e.clientY);
    sendInputEvent({ type: 'down', button: MOUSE_BUTTONS[e.button] || 'left', ...(point || {}) });
  };

  const handleMouseUp = (e) => {
    if (!canControl) return;
    e.preventDefault();
    const point = pointToFrame(e.clientX, e.clientY);
    sendInputEvent({ type: 'up', button: MOUSE_BUTTONS[e.button] || 'left', ...(point || {}) });
  };

  const handleWheel = (e) => {
    if (!canControl) return;
    // deltaY вниз положительный, у колеса Windows — наоборот.
    sendInputEvent({ type: 'wheel', delta: e.deltaY > 0 ? -1 : 1 });
  };

  const handleContextMenu = (e) => {
    // Иначе поверх удалённого экрана открылось бы меню самого приложения.
    if (canControl) e.preventDefault();
  };

  const handleKeyDown = (e) => {
    if (!canControl) return;
    e.preventDefault();
    sendInputEvent({
      type: 'key',
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey
    });
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
        className={`rd-video-area${canControl ? ' controllable' : ''}`}
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        title={canControl ? 'Кликните по экрану, чтобы управлять клавиатурой' : undefined}
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
