import React, { useState, useRef, useEffect } from 'react';

export default function RemoteDesktopHostModal(props) {
  const data = props.promptData || props.request || {};
  const { wsClient, onClose } = props;

  const [sharing, setSharing] = useState(false);
  const [accessLevel, setAccessLevel] = useState('full');
  const streamRef = useRef(null);
  const pcRef = useRef(null);

  const handleAccept = async () => {
    try {
      let stream;
      if (window.electronAPI && window.electronAPI.getDesktopSources) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 60, cursor: 'always' },
          audio: false
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 60, cursor: 'always' },
          audio: false
        });
      }

      streamRef.current = stream;
      setSharing(true);

      // Ввод разрешается ровно на время сеанса и только при полном доступе.
      if (accessLevel === 'full' && window.electronAPI?.rdInputEnable) {
        await window.electronAPI.rdInputEnable();
      }

      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({
          type: 'rd_response',
          sessionId: data.sessionId,
          accepted: true,
          accessLevel
        }));
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.onicecandidate = (e) => {
        if (e.candidate && wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({
            type: 'rd_ice_candidate',
            sessionId: data.sessionId,
            targetUserId: data.operatorId,
            candidate: e.candidate
          }));
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({
          type: 'rd_webrtc_offer',
          sessionId: data.sessionId,
          targetUserId: data.operatorId,
          sdp: offer
        }));
      }

      const handleWsMessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.sessionId !== data.sessionId) return;

          if (msg.type === 'rd_webrtc_answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          } else if (msg.type === 'rd_ice_candidate' && msg.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else if (msg.type === 'rd_input_event') {
            // Ввод исполняется только при полном доступе, который сотрудник
            // выбрал сам перед подтверждением. Раньше событие просто
            // печаталось в консоль — управление не работало.
            if (accessLevel === 'full' && window.electronAPI?.rdInputEvent) {
              window.electronAPI.rdInputEvent(msg.event);
            }
          } else if (msg.type === 'rd_end') {
            handleStopSharing();
          }
        } catch (err) {
          console.error('Signaling error:', err);
        }
      };

      wsClient.addEventListener('message', handleWsMessage);

      stream.getVideoTracks()[0].onended = () => {
        handleStopSharing();
      };
    } catch (err) {
      alert('Не удалось запустить трансляцию экрана: ' + err.message);
      handleReject();
    }
  };

  const handleStopSharing = () => {
    // Ввод отключается ПЕРВЫМ делом: даже если дальше что-то не выполнится,
    // управлять машиной уже нельзя.
    window.electronAPI?.rdInputDisable?.();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({
        type: 'rd_end',
        sessionId: data.sessionId,
        targetUserId: data.operatorId
      }));
    }
    setSharing(false);
    onClose && onClose();
  };

  // Аварийная клавиша обрывает управление в главном процессе; здесь остаётся
  // закрыть сам сеанс, чтобы оператор не смотрел в замерший экран.
  useEffect(() => {
    if (!window.electronAPI?.onRdInputRevoked) return;
    window.electronAPI.onRdInputRevoked(() => {
      if (streamRef.current) handleStopSharing();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReject = () => {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({
        type: 'rd_response',
        sessionId: data.sessionId,
        accepted: false
      }));
    }
    onClose && onClose();
  };

  if (sharing) {
    return (
      <div className="rd-host-floating-bar">
        <div className="rd-host-bar-content">
          <span className="rd-pulse-dot">●</span>
          <span className="rd-bar-title">Идет сеанс удаленного доступа:</span>
          <strong>{data.operatorName || 'Оператор техподдержки'}</strong>
          <span className="rd-bar-mode-badge">
            {accessLevel === 'full' ? '🎮 Полный доступ (управление)' : '👁️ Только просмотр'}
          </span>
          <button className="rd-stop-btn" onClick={handleStopSharing}>
            ⏹ Завершить доступ
          </button>
          {accessLevel === 'full' && (
            <span className="rd-bar-hint">Экстренно прервать: Ctrl+Alt+Shift+S</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={handleReject}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <div className="modal-header" style={{ background: '#f8fafc', borderBottom: '1px solid #cbd5e1' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>🖥️</span>
            <span style={{ fontWeight: 700, fontSize: '15px', color: '#1e293b' }}>
              Запрос на удаленный рабочий стол
            </span>
          </div>
          <button className="btn-close-modal" onClick={handleReject}>✕</button>
        </div>

        <div style={{ padding: '24px 20px' }}>
          <div className="rd-operator-card">
            <div className="rd-operator-avatar">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.8">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
            </div>
            <div className="rd-operator-info">
              <div className="rd-operator-name">{data.operatorName || 'Сотрудник техподдержки'}</div>
              <div className="rd-operator-role">{data.operatorJobTitle || 'Системный администратор'}</div>
              <div className="rd-operator-dept">АО СК "Сентрас Иншуранс"</div>
            </div>
          </div>

          <p style={{ fontSize: '13px', color: '#334155', lineHeight: '1.5', margin: '16px 0 14px' }}>
            Коллега запрашивает подключение к вашему компьютеру для оказания помощи или демонстрации экрана.
          </p>

          <div className="rd-permission-box">
            <label className={'rd-perm-option ' + (accessLevel === 'full' ? 'selected' : '')}>
              <input
                type="radio"
                name="accessLevel"
                value="full"
                checked={accessLevel === 'full'}
                onChange={() => setAccessLevel('full')}
              />
              <div className="rd-perm-text">
                <strong>Полный доступ (управление)</strong>
                <span>Разрешить просмотр экрана, управление курсором мыши и клавиатурой.</span>
              </div>
            </label>

            <label className={'rd-perm-option ' + (accessLevel === 'view_only' ? 'selected' : '')}>
              <input
                type="radio"
                name="accessLevel"
                value="view_only"
                checked={accessLevel === 'view_only'}
                onChange={() => setAccessLevel('view_only')}
              />
              <div className="rd-perm-text">
                <strong>Только просмотр</strong>
                <span>Коллега сможет только видеть экран без возможности управления.</span>
              </div>
            </label>
          </div>

          <div className="rd-security-notice">
            🔒 Вы можете в любой момент прервать сеанс нажатием кнопки «Завершить доступ».
          </div>
        </div>

        <div className="modal-footer" style={{ background: '#f8fafc', padding: '12px 20px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button type="button" className="btn btn-secondary" onClick={handleReject}>
            ✕ Отклонить
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ background: '#16a34a', borderColor: '#15803d', fontWeight: 600 }}
            onClick={handleAccept}
          >
            ✓ Разрешить доступ
          </button>
        </div>
      </div>
    </div>
  );
}
